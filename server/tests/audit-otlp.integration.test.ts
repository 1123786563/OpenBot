import { afterAll, expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createActivityStore } from "../src/activity/activity";
import { installEnterpriseControls } from "../src/admin/controls";
import { createApprovalStore } from "../src/approvals/store";
import { approvalAction, withApprovalContext } from "../src/approvals/types";
import {
  type AuditStore,
  addAuditTap,
  createAuditReader,
  createAuditStore,
} from "../src/audit";
import { buildAgents } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { approvalRequests } from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { AUDIT_RUN_PROOF_KEY } from "../src/telemetry/audit-run-proof";
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

const privatePayload = {
  token: "private-token",
  nested: { password: "private-password", authorization: "private-bearer" },
  inputs: [{ prompt: "private-prompt", content: "private-content" }],
  tool_arguments: { path: "private-tool-argument" },
  tool_result: ["private-tool-result"],
  note: "private-ordinary-user-message",
};

function stringAttribute(key: string, stringValue: string) {
  return { key, value: { stringValue } };
}

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
  "explicit precedence",
  "partially invalid",
  "different run",
  "different thread",
  "tampered proof",
  "no continuation",
  "historical browser",
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
    const fullLineage =
      variant === "complete" || variant === "explicit precedence";
    const privacyKey = "approval-fixture";
    const productEvents: unknown[] = [];
    const telemetry = await createProductTelemetry({
      privacyKey,
      send: async (event) => {
        productEvents.push(event);
      },
      deploymentId: deployment.DEPLOYMENT_ID,
      env: { OPENBOT_PRODUCT_TELEMETRY: "1", NODE_ENV: "test" },
    });
    const context = await telemetry.prepare({
      actorUserId: owner,
      runId: variant === "different run" ? "another-run" : runId,
      threadId: variant === "different thread" ? "another-thread" : threadId,
      trigger: "followup",
      surface: "web",
      inheritedRootTaskId:
        variant === "partially invalid" ? "x".repeat(257) : rootTaskId,
      parentRunId:
        variant === "partially invalid" ? "path with spaces" : parentRunId,
    });
    if (!context)
      throw new Error("Product telemetry did not prepare the fixture");
    const forwardedProps = productRunForwardedProps({}, context);
    if (variant === "tampered proof")
      forwardedProps[AUDIT_RUN_PROOF_KEY] =
        `${forwardedProps[AUDIT_RUN_PROOF_KEY]}.tampered`;

    if (variant === "historical browser") {
      delete forwardedProps[AUDIT_RUN_PROOF_KEY];
      forwardedProps.openbotTelemetry = {
        ...context,
        parent_run_id: "historical-parent",
        root_task_id: "b".repeat(64),
        attempt_id: "historical-attempt",
      };
    }

    const controls = await installEnterpriseControls({
      database,
      databaseUrl,
      auditStore,
      env: { ...deployment, OTEL_EXPORTER_OTLP_ENDPOINT: collector.url.href },
      auditRunProofKey: privacyKey,
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
      if (variant === "historical browser") {
        approvalId = crypto.randomUUID();
        await database.insert(approvalRequests).values({
          id: approvalId,
          ownerUserId: owner,
          runId,
          toolCallId: action.toolCallId,
          actionDigest: action.actionDigest,
          action,
        });
      } else {
        approvalId = (await store.open(action)).id;
      }
      const decidedId = approvalId;
      const continuation = action.continuation;
      if (variant === "explicit precedence" && continuation) {
        await withApprovalContext(
          { ...continuation, runId: "ambient-run", threadId: "ambient-thread" },
          () => store.decide(owner, decidedId, "deny"),
        );
      } else {
        await store.decide(owner, decidedId, "deny");
      }
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
                        ...(fullLineage
                          ? {
                              parent_run_id: parentRunId,
                              root_task_id: rootTaskId,
                            }
                          : {}),
                        ...(fullLineage || variant === "partially invalid"
                          ? { attempt_id: runId }
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
      expect(wire).not.toMatch(
        /another-run|another-thread|ambient-|openbotAuditRunProof/,
      );
      if (!fullLineage) expect(wire).not.toMatch(/parent_run_id|root_task_id/);
      if (!fullLineage && variant !== "partially invalid")
        expect(wire).not.toContain("attempt_id");
      await telemetry.flush();
      expect(productEvents).toEqual([
        expect.objectContaining({
          properties: expect.objectContaining({
            source_event: "approval.person_decided",
            user_id: context.user_id,
          }),
        }),
      ]);
      if (variant === "explicit precedence") {
        expect(productEvents).toEqual([
          expect.objectContaining({
            properties: expect.objectContaining({
              run_id: "ambient-run",
              thread_id: "ambient-thread",
            }),
          }),
        ]);
      } else {
        expect(JSON.stringify(productEvents)).not.toMatch(/run_id|thread_id/);
      }
      expect(JSON.stringify(productEvents)).not.toMatch(
        /root_task_id|attempt_id|work_item_key/,
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

test("unknown and failed projections retain their public envelope across deployments", async () => {
  const requests: string[] = [];
  using collector = serveCollector(async (request) => {
    requests.push(await request.text());
    return Response.json({});
  });
  for (const [deploymentId, eventType, status] of [
    ["first-installation", "mcp.call_succeeded", "unknown"],
    ["second-installation", "computer.action_allowed", "failed"],
  ] as const) {
    const targetId = crypto.randomUUID();
    const actorUserId = crypto.randomUUID();
    const controls = await installEnterpriseControls({
      database,
      databaseUrl,
      auditStore,
      env: {
        DEPLOYMENT_ID: deploymentId,
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url.href,
      },
    });
    try {
      await auditStore.insert({
        ...eventFor(targetId),
        actorUserId,
        eventType,
        payload: { ...privatePayload, action: "private invalid action" },
      });
    } finally {
      await controls.stop();
    }
    const {
      events: [row],
    } = await reader.list({ targetId, limit: 10 });
    if (!row) throw new Error("Missing persisted audit event");
    const wire = requests.at(-1);
    expect(wire).toBeDefined();
    expect(JSON.parse(wire ?? "")).toMatchObject({
      resourceLogs: [
        {
          resource: {
            attributes: expect.arrayContaining([
              stringAttribute("openbot.deployment_id", deploymentId),
            ]),
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: eventType },
                  attributes: expect.arrayContaining(
                    Object.entries({
                      stream: "openbot_audit",
                      canonical_source: "postgresql.audit_events",
                      data_class: "audit",
                      deployment_id: deploymentId,
                      projection_status: status,
                      audit_event_id: row.id,
                      target_type: "computer",
                      target_id: targetId,
                      actor_user_id: actorUserId,
                      initiator_kind: "person",
                      occurred_at: new Date(row.createdAt).toISOString(),
                    }).map(([key, value]) =>
                      stringAttribute(`openbot.${key}`, value),
                    ),
                  ),
                },
              ],
            },
          ],
        },
      ],
    });
    expect(wire).not.toMatch(/private[ -]|payload\.|openbot\.facet\./);
  }
  expect(requests).toHaveLength(2);
});

test.each(["enabled", "paused", "offline", "rejected", "retry exhausted"])(
  "a Bot run reaches the model, executes its tool and produces Activity and audit with export %s",
  async (mode) => {
    const requests: string[] = [];
    const rejectionStarted = Promise.withResolvers<void>();
    const releaseRejection = Promise.withResolvers<void>();
    using collector = serveCollector(async (request) => {
      requests.push(await request.text());
      if (mode === "rejected") {
        rejectionStarted.resolve();
        await releaseRejection.promise;
        return Response.json({}, { status: 400 });
      }
      return mode === "retry exhausted"
        ? Response.json(
            {},
            {
              status: 503,
              headers: { "retry-after": new Date(0).toUTCString() },
            },
          )
        : Response.json({});
    });
    const endpoint = collector.url.href;

    const owner = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const llm = new LLMock({ host: "127.0.0.1", port: 0 });
    let modelStep = 0;
    llm.on({ predicate: () => true }, () =>
      ++modelStep === 1
        ? {
            toolCalls: [
              {
                name: "mcp__fixture__request_review",
                arguments: JSON.stringify({ note: "private-model-tool-args" }),
              },
            ],
          }
        : { content: "Review queued." },
    );
    const originalBase = process.env.OPENAI_BASE_URL;
    let controls:
      | Awaited<ReturnType<typeof installEnterpriseControls>>
      | undefined;
    let approvalId: string | undefined;
    const receivedArgs: unknown[] = [];
    try {
      process.env.OPENAI_BASE_URL = `${await llm.start()}/v1`;
      if (mode === "offline") {
        await collector.stop(true);
        await expect(fetch(endpoint)).rejects.toHaveProperty(
          "code",
          "ECONNREFUSED",
        );
      }
      controls = await installEnterpriseControls({
        database,
        databaseUrl,
        auditStore,
        env: {
          ...deployment,
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          OPENBOT_OTEL_EXPORT: mode === "paused" ? "off" : "on",
        },
      });
      await database
        .insert(users)
        .values({ id: owner, email: `${owner}@example.test` });
      if (mode === "rejected") {
        // Keep a batch in flight while the Bot calls the model and runs the tool.
        await auditStore.insert(eventFor(crypto.randomUUID()));
        await rejectionStarted.promise;
      }
      const approvals = createApprovalStore(database);
      const { reviewer } = await buildAgents(
        [
          {
            id: "reviewer",
            name: "Reviewer",
            type: "built_in",
            systemPrompt: "Request review.",
          },
        ],
        { provider: "openai", defaultModel: "gpt-5.5" },
        "synthetic-fixture-key",
        undefined,
        async () => [
          {
            name: "mcp__fixture__request_review",
            ref: "fixture/request_review",
            description: "Request review of a note.",
            parameters: z.object({ note: z.string() }),
            execute: async (args) => {
              receivedArgs.push(args);
              const approval = await approvals.open(
                approvalAction({
                  actorId: owner,
                  botId: "reviewer",
                  continuation: {
                    runId,
                    threadId,
                    toolCallId: "review-call",
                    toolName: "mcp__fixture__request_review",
                    args,
                    messages: [],
                    state: {},
                    context: [],
                    forwardedProps: {},
                  },
                  toolRef: "computer_write_file",
                  effect: "write",
                  scope: "project",
                  args,
                  target: {},
                }),
              );
              approvalId = approval.id;
              await auditStore.insert(eventFor(runId));
              return "private-model-tool-result";
            },
          },
        ],
      );
      if (!reviewer) throw new Error("Missing fixture Bot");
      const events: string[] = [];
      await new Promise<void>((resolve, reject) => {
        reviewer
          .clone()
          .run({
            threadId,
            runId,
            messages: [
              { id: "user", role: "user", content: "private-model-prompt" },
            ],
            tools: [],
            state: {},
            context: [],
            forwardedProps: {},
          })
          .subscribe({
            next: (event: BaseEvent) => events.push(event.type),
            error: reject,
            complete: resolve,
          });
      });
      expect(receivedArgs).toEqual([{ note: "private-model-tool-args" }]);
      const modelRequests = llm.getRequests();
      expect(modelRequests).toHaveLength(2);
      expect(JSON.stringify(modelRequests[0]?.body)).toContain(
        "private-model-prompt",
      );
      expect(JSON.stringify(modelRequests[1]?.body)).toContain(
        "private-model-tool-result",
      );
      expect(events).toContain(EventType.TOOL_CALL_RESULT);
      expect(events.at(-1)).toBe(EventType.RUN_FINISHED);
      const activity = createActivityStore(database);
      const beforeStop = await activity.forBot(owner, "reviewer");
      expect(beforeStop.inProgress).toContainEqual(
        expect.objectContaining({
          id: `approval:${approvalId}`,
          kind: "approval",
          status: "waiting for you",
        }),
      );
      const { events: rows } = await reader.list({
        targetId: runId,
        limit: 10,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toEqual(eventFor(runId).payload);

      // A rejected HTTP response exercises the real flush. Inject a rejection after that
      // flush to also exercise the controls' handling of a rejected shutdown promise.
      let shutdownFailed = false;
      if (mode === "rejected") {
        const exporter = controls.exporter;
        if (!exporter) throw new Error("Missing fixture exporter");
        const shutdown = exporter.shutdown;
        exporter.shutdown = async () => {
          await shutdown();
          shutdownFailed = true;
          throw new Error("fixture shutdown failure");
        };
      }

      releaseRejection.resolve();
      await controls.stop();
      controls = undefined;
      if (mode === "rejected") expect(shutdownFailed).toBe(true);
      expect(await activity.forBot(owner, "reviewer")).toEqual(beforeStop);
      expect(
        (await reader.list({ targetId: runId, limit: 10 })).events,
      ).toEqual(rows);
      if (mode !== "paused" && mode !== "offline") {
        const runRequests = mode === "rejected" ? requests.slice(1) : requests;
        if (mode === "rejected") expect(requests).toHaveLength(2);
        expect(runRequests).toHaveLength(mode === "retry exhausted" ? 6 : 1);
        const expectedId = rows[0]?.id;
        if (!expectedId) throw new Error("Missing persisted audit ID");
        for (const wire of runRequests) {
          expect(wire).toContain(
            JSON.stringify(
              stringAttribute("openbot.audit_event_id", expectedId),
            ),
          );
          expect(wire).not.toMatch(/private-|payload\./);
        }
      } else {
        expect(requests).toEqual([]);
      }
      if (!approvalId) throw new Error("Missing fixture approval");
      await approvals.decide(owner, approvalId, "deny");
      expect((await activity.forBot(owner, "reviewer")).inProgress).toEqual([]);
      expect(
        (await reader.list({ targetId: approvalId, limit: 10 })).events.map(
          ({ eventType }) => eventType,
        ),
      ).toEqual(["approval.person_decided"]);
    } finally {
      releaseRejection.resolve();
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await llm.stop();
      await controls?.stop();
      if (approvalId) {
        await database
          .delete(approvalRequests)
          .where(eq(approvalRequests.id, approvalId));
        await database.delete(workItems).where(eq(workItems.key, approvalId));
      }
      await database.delete(users).where(eq(users.id, owner));
    }
  },
  15_000,
);
