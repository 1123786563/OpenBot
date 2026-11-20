import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { installEnterpriseControls } from "../src/admin/controls";
import { createApprovalStore } from "../src/approvals/store";
import { approvalAction } from "../src/approvals/types";
import {
  type AuditStore,
  addAuditTap,
  createAuditReader,
  createAuditStore,
} from "../src/audit";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { createOtelEventExporter } from "../src/telemetry/otel";
import {
  createProductTelemetry,
  productRunForwardedProps,
} from "../src/telemetry/product";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const auditStore = createAuditStore(database);
const reader = createAuditReader(database);

afterAll(() => database.$client.end());

const deployment = { DEPLOYMENT_ID: "audit-integration" };

function eventFor(targetId: string): Parameters<AuditStore["insert"]>[0] {
  return {
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId,
    payload: {
      action: "computer_run_command",
      command: "private-command-text",
      unreviewed: [{ note: "private-nested-text" }],
      arbitrary: "private-user-message",
    },
  };
}

function serveCollector(fetch: (request: Request) => Promise<Response>) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
}

test("the installed audit tap exports only a successful PostgreSQL row as a bounded OTLP record", async () => {
  const requests: { path: string; header: string | null; wire: string }[] = [];
  const collector = serveCollector(async (request) => {
    requests.push({
      path: new URL(request.url).pathname,
      header: request.headers.get("x-collector-fixture"),
      wire: await request.text(),
    });
    return new Response("{}");
  });
  const targetId = crypto.randomUUID();
  const rejectedId = crypto.randomUUID();
  let controls:
    | Awaited<ReturnType<typeof installEnterpriseControls>>
    | undefined;
  const tappedTargets: (string | undefined)[] = [];
  const removeTap = addAuditTap((event) => {
    if (event.targetId === targetId || event.targetId === rejectedId) {
      tappedTargets.push(event.targetId);
    }
  });
  try {
    controls = await installEnterpriseControls({
      database,
      databaseUrl,
      auditStore,
      env: {
        ...deployment,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${collector.url}custom/v1/logs`,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-collector-fixture=scope%20check",
        OTEL_SERVICE_NAME: "openbot-audit-fixture",
      },
    });
    // PostgreSQL rejects NUL in text with SQLSTATE 22021.
    await expect(
      auditStore.insert({ ...eventFor(rejectedId), targetType: "computer\0" }),
    ).rejects.toHaveProperty("cause.errno", "22021");
    expect(
      (await reader.list({ targetId: rejectedId, limit: 10 })).events,
    ).toEqual([]);

    await auditStore.insert(eventFor(targetId));
    const { events } = await reader.list({ targetId, limit: 10 });
    expect(events).toHaveLength(1);
    const [row] = events;
    if (!row)
      throw new Error("The audit reader did not return the inserted row");
    expect(row.payload).toEqual(eventFor(targetId).payload);

    await controls.stop();
    controls = undefined;
    expect(tappedTargets).toEqual([targetId]);
    expect(requests).toEqual([
      {
        path: "/custom/v1/logs",
        header: "scope check",
        wire: expect.any(String),
      },
    ]);
    const wire = requests.map((request) => request.wire).join("");
    const stringAttribute = (key: string, stringValue: string) => ({
      key,
      value: { stringValue },
    });
    expect(JSON.parse(wire)).toEqual({
      resourceLogs: [
        expect.objectContaining({
          resource: expect.objectContaining({
            attributes: expect.arrayContaining([
              stringAttribute("service.name", "openbot-audit-fixture"),
            ]),
          }),
          scopeLogs: [
            expect.objectContaining({
              logRecords: [
                expect.objectContaining({
                  body: { stringValue: "computer.action_allowed" },
                  severityText: "INFO",
                  attributes: expect.arrayContaining([
                    stringAttribute("openbot.stream", "openbot_audit"),
                    stringAttribute(
                      "openbot.canonical_source",
                      "postgresql.audit_events",
                    ),
                    stringAttribute("openbot.data_class", "audit"),
                    stringAttribute(
                      "openbot.deployment_id",
                      "audit-integration",
                    ),
                    stringAttribute("openbot.surface", "bot"),
                    stringAttribute("openbot.audit_event_id", row.id),
                    stringAttribute("openbot.target_id", targetId),
                    stringAttribute(
                      "openbot.facet.action",
                      "computer_run_command",
                    ),
                    stringAttribute(
                      "openbot.occurred_at",
                      new Date(row.createdAt).toISOString(),
                    ),
                  ]),
                }),
              ],
            }),
          ],
        }),
      ],
    });
    expect(wire).not.toMatch(
      /payload\.|"(?:arrayValue|kvlistValue)"|private-|unreviewed|arbitrary/,
    );
    expect(wire).not.toContain(rejectedId);
  } finally {
    removeTap();
    await controls?.stop();
    collector.stop(true);
  }
});

test.each([
  "complete",
  "partially invalid",
  "different run",
  "no continuation",
])(
  "a saved approval continuation with %s telemetry exports only its valid lineage",
  async (variant) => {
    const requests: string[] = [];
    const collector = serveCollector(async (request) => {
      requests.push(await request.text());
      return new Response("{}");
    });
    const owner = crypto.randomUUID();
    const runId = "resumed-run";
    const threadId = "conversation-thread";
    const rootTaskId = "a".repeat(64);
    const parentRunId = "interrupted-run";
    const productEvents: unknown[] = [];
    const telemetry = await createProductTelemetry({
      privacyKey: "approval-fixture",
      send: async (event) => {
        productEvents.push(event);
      },
      deploymentId: deployment.DEPLOYMENT_ID,
      env: { OPENBOT_PRODUCT_TELEMETRY: "1", NODE_ENV: "test" },
    });
    const context = await telemetry.prepare({
      actorUserId: owner,
      runId,
      threadId,
      trigger: "followup",
      surface: "web",
      inheritedRootTaskId: rootTaskId,
      parentRunId,
    });
    if (!context)
      throw new Error("Product telemetry did not prepare the fixture");
    const forwardedProps = productRunForwardedProps({}, context);
    if (variant === "partially invalid") {
      forwardedProps.openbotTelemetry = {
        run_id: runId,
        parent_run_id: "path with spaces",
        root_task_id: "x".repeat(257),
        attempt_id: undefined,
      };
    }
    if (variant === "different run")
      forwardedProps.openbotTelemetry = { ...context, run_id: "another-run" };

    const controls = await installEnterpriseControls({
      database,
      databaseUrl,
      auditStore,
      env: { ...deployment, OTEL_EXPORTER_OTLP_ENDPOINT: collector.url.href },
    });
    const removeProductTap = addAuditTap(telemetry.recordAudit);
    let approvalId: string | undefined;
    try {
      await database
        .insert(users)
        .values({ id: owner, email: `${owner}@example.test` });
      const store = createApprovalStore(database);
      const action = approvalAction({
        actorId: owner,
        botId: "approval-bot",
        toolRef: "computer_write_file",
        effect: "write",
        scope: "project",
        args: {},
        target: {},
        continuation: {
          runId,
          threadId,
          toolCallId: "tool-call",
          toolName: "computer_write_file",
          args: {},
          messages: [],
          state: {},
          context: [],
          forwardedProps,
        },
      });
      if (variant === "no continuation") delete action.continuation;
      const request = await store.open(action);
      approvalId = request.id;
      await store.decide(owner, approvalId, "deny");
      const { events } = await reader.list({ targetId: approvalId, limit: 10 });
      expect(events.map((event) => event.eventType)).toEqual([
        "approval.person_decided",
      ]);
      await controls.stop();
      expect(requests).toHaveLength(1);
      const [wire] = requests;
      expect(JSON.parse(wire)).toMatchObject({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    body: { stringValue: "approval.person_decided" },
                    attributes: expect.arrayContaining(
                      Object.entries({
                        audit_event_id: events[0]?.id,
                        target_id: approvalId,
                        work_item_key: approvalId,
                        run_id: runId,
                        ...(variant === "complete"
                          ? {
                              parent_run_id: parentRunId,
                              root_task_id: rootTaskId,
                              attempt_id: runId,
                            }
                          : {}),
                        thread_id: threadId,
                      }).map(([key, stringValue]) => ({
                        key: `openbot.${key}`,
                        value: { stringValue },
                      })),
                    ),
                  },
                ],
              },
            ],
          },
        ],
      });
      expect(wire).not.toMatch(/trace_?id|span_?id/i);
      expect(wire).not.toContain(context.user_id);
      if (variant !== "complete")
        expect(wire).not.toMatch(
          /parent_run_id|root_task_id|attempt_id|another-run/,
        );
      await telemetry.flush();
      expect(productEvents).toEqual([
        expect.objectContaining({
          properties: expect.objectContaining({
            source_event: "approval.person_decided",
            user_id: context.user_id,
          }),
        }),
      ]);
      expect(JSON.stringify(productEvents)).not.toMatch(
        /run_id|thread_id|root_task_id|attempt_id|work_item_key/,
      );
    } finally {
      removeProductTap();
      await controls.stop();
      collector.stop(true);
      if (approvalId)
        await database.delete(workItems).where(eq(workItems.key, approvalId));
      await database.delete(users).where(eq(users.id, owner));
    }
  },
  10_000,
);

test("audit writes remain readable while the Collector holds and rejects a batch", async () => {
  const firstRequest = Promise.withResolvers<void>();
  const releaseResponse = Promise.withResolvers<void>();
  const collector = serveCollector(async (request) => {
    await request.text();
    firstRequest.resolve();
    await releaseResponse.promise;
    return new Response("{}", { status: 400 });
  });
  const targetId = crypto.randomUUID();
  const controls = await installEnterpriseControls({
    database,
    databaseUrl,
    auditStore,
    env: {
      ...deployment,
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url.href,
    },
  });
  try {
    await auditStore.insert(eventFor(targetId));
    await firstRequest.promise;
    await auditStore.insert(eventFor(targetId));
    expect((await reader.list({ targetId, limit: 10 })).events).toHaveLength(2);
  } finally {
    releaseResponse.resolve();
    await controls.stop();
    collector.stop(true);
  }
  expect((await reader.list({ targetId, limit: 10 })).events).toHaveLength(2);
}, 8_000);

test("a throwing exporter tap leaves the audit row and the other audit subscribers intact", async () => {
  const targetId = crypto.randomUUID();
  const seen: (string | undefined)[] = [];
  const removeThrowingTap = addAuditTap((event) => {
    if (event.targetId === targetId)
      throw new Error("fixture exporter failure");
  });
  const removeObserver = addAuditTap((event) => {
    if (event.targetId === targetId) seen.push(event.id);
  });
  try {
    await auditStore.insert(eventFor(targetId));
    const { events } = await reader.list({ targetId, limit: 10 });
    expect(events).toHaveLength(1);
    expect(seen).toEqual(events.map(({ id }) => id));
  } finally {
    removeObserver();
    removeThrowingTap();
  }
});

test.each([
  ["an endpoint", { DEPLOYMENT_ID: deployment.DEPLOYMENT_ID }],
  [
    "an explicit deployment ID",
    { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" },
  ],
  [
    "a valid deployment ID",
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      DEPLOYMENT_ID: "not a deployment",
    },
  ],
  [
    "an enabled exporter",
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      ...deployment,
      OPENBOT_OTEL_EXPORT: "off",
    },
  ],
] satisfies [string, Record<string, string>][])(
  "does not create an audit exporter without %s",
  async (_criterion, env) => {
    const exporter = createOtelEventExporter(env);
    try {
      expect(exporter).toBeUndefined();
    } finally {
      await exporter?.shutdown();
    }
  },
);
