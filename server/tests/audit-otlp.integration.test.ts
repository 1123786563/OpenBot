import { afterAll, expect, test } from "bun:test";
import { installEnterpriseControls } from "../src/admin/controls";
import {
  type AuditStore,
  addAuditTap,
  createAuditReader,
  createAuditStore,
} from "../src/audit";
import { createDatabase } from "../src/db/client";
import { createOtelEventExporter } from "../src/telemetry/otel";
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
