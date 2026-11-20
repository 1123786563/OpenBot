import { expect, spyOn, test } from "bun:test";
import { createOtelEventExporter } from "../src/telemetry/otel";

/**
 * The audit trail keeps the command a Bot ran in full; what leaves for an outside collector must
 * not carry the credentials in it. Checked against a real OTLP/HTTP collector on 127.0.0.1, because
 * the bytes on the wire are the thing that has to be clean.
 */
test("the Collector receives the audit replica without any command text", async () => {
  const secret = "fixture-value-7f3a91c0d2";
  const received: string[] = [];
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push(await request.text());
      return new Response("{}");
    },
  });
  try {
    const exporter = createOtelEventExporter({
      DEPLOYMENT_ID: "test-deployment",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/logs`,
    });
    exporter?.emit({
      id: "3967be97-04d1-4ffa-a6aa-d71af0b78f18",
      createdAt: new Date("2026-11-20T06:00:00.000Z"),
      eventType: "computer.action_allowed",
      targetType: "computer",
      targetId: "bot-1",
      initiatorKind: "person",
      initiatorId: null,
      payload: {
        bot: "bot-1",
        action: "computer_run_command",
        command: `curl -H "Authorization: Bearer ${secret}" https://api.example.test`,
        nested: { command: `export API_TOKEN=${secret}` },
        // A credential written positionally is the shape that used to survive: it is not a `NAME=value`
        // and not a named flag, so nothing matched it before it reached the wire.
        positional: { command: `redis-cli -a ${secret} SET k v` },
      },
    });
    await exporter?.shutdown();
  } finally {
    collector.stop(true);
  }
  const wire = received.join("");
  expect(wire).toContain("computer_run_command");
  expect(wire).toContain("openbot.facet.action");
  expect(wire).toContain("openbot.audit_event_id");
  expect(wire).toContain("3967be97-04d1-4ffa-a6aa-d71af0b78f18");
  expect(wire).not.toContain("curl -H");
  expect(wire).not.toContain("redis-cli");
  expect(wire).not.toContain("payload.");
  expect(wire).not.toContain(secret);
});

test("a rejected facet emits a bounded runtime diagnostic and a public failed audit replica", async () => {
  const received: string[] = [];
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push(await request.text());
      return new Response("{}");
    },
  });
  const diagnostics: string[] = [];
  const log = spyOn(console, "info").mockImplementation((line: string) => {
    diagnostics.push(line);
  });
  const secret = "private-approval-decision";
  const auditEventId = "3967be97-04d1-4ffa-a6aa-d71af0b78f18";
  try {
    const exporter = createOtelEventExporter({
      DEPLOYMENT_ID: "test-deployment",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/logs`,
    });
    exporter?.emit({
      id: auditEventId,
      createdAt: new Date("2026-11-20T06:00:00.000Z"),
      eventType: "approval.person_decided",
      targetType: "approval",
      initiatorKind: "person",
      initiatorId: null,
      payload: { decision: secret, effect: "write" },
    });
    await exporter?.shutdown();
  } finally {
    log.mockRestore();
    collector.stop(true);
  }
  expect(diagnostics.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({
      stream: "openbot_runtime",
      schema_version: 1,
      deployment_id: "test-deployment",
      source: "openbot",
      canonical_source: "openbot.stdout",
      data_class: "runtime",
      projection_status: "known",
      event_category: "audit_projection_failed",
      severity: "warn",
    }),
  ]);
  const wire = received.join("");
  expect(wire).toContain(auditEventId);
  expect(wire).toContain("openbot_audit");
  expect(wire).toContain('"stringValue":"failed"');
  expect(wire).not.toContain("openbot.facet.");
  expect(wire + diagnostics.join("")).not.toContain(secret);
});
