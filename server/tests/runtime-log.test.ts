import { expect, test } from "bun:test";
import { join } from "node:path";
import { version } from "../../package.json";

const writerPath = join(import.meta.dir, "../src/telemetry/runtime-log.ts");

function runWriter(script: string, env: Record<string, string> = {}) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
      import { writeRuntimeLog } from ${JSON.stringify(writerPath)};
      ${script}
    `,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
}

test("writes a single structured API startup line to stdout without an OTLP endpoint", () => {
  const result = runWriter(
    `writeRuntimeLog("api_listening", { port: 3010 });`,
    {
      DEPLOYMENT_ID: "test-deployment",
      OTEL_SERVICE_NAME: "test-service",
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const [line, ...rest] = result.stdout.toString().split("\n");
  expect(rest).toEqual([""]);
  expect(JSON.parse(line)).toEqual({
    stream: "openbot_runtime",
    schema_version: 1,
    source: "openbot",
    canonical_source: "openbot.stdout",
    data_class: "runtime",
    projection_status: "known",
    occurred_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    severity: "info",
    service: "test-service",
    deployment_id: "test-deployment",

    version,
    component: "api",
    event_category: "api_listening",
    operation: "startup",
    outcome: "succeeded",
    port: 3010,
  });
});

test("emits only catalogued failure diagnostics and allowlisted numeric measurements", () => {
  const result = runWriter(
    `
    const secret = "SENSITIVE-123";
    const payload = {
      request: new Request("https://test.invalid", { headers: { Authorization: secret } }),
      exception: new Error(secret),
      response: new Response(secret),
      credentials: secret,
      prompt: secret,
      tool_args: { path: secret },
      tool_result: secret,
      file_content: secret,
      diagnostic: secret,
      port: { toJSON: () => secret },
      duration_ms: 12.5,
    };
    payload.self = payload;
    writeRuntimeLog("routine_sweep_failed", payload);
    writeRuntimeLog("SENSITIVE-123", payload);
    writeRuntimeLog("constructor", payload);
  `,
    {
      DEPLOYMENT_ID: "SENSITIVE-123\ninvalid",
      OTEL_SERVICE_NAME: "Bearer SENSITIVE-123",
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("");
  const stderr = result.stderr.toString();
  expect(stderr).not.toContain("SENSITIVE-123");
  const [line, ...rest] = stderr.split("\n");
  expect(rest).toEqual([""]);
  const record = JSON.parse(line);
  expect(record).toEqual({
    stream: "openbot_runtime",
    schema_version: 1,
    source: "openbot",
    canonical_source: "openbot.stderr",
    data_class: "runtime",
    projection_status: "known",
    occurred_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    severity: "warn",
    service: "openbot",
    deployment_id: "unconfigured",
    version,
    component: "routines",
    event_category: "routine_sweep_failed",
    operation: "sweep",
    outcome: "failed",
    error_category: "routine_sweep_error",
    diagnostic: "Routine sweep did not complete.",
    duration_ms: 12.5,
  });
  expect(record.diagnostic.length).toBeLessThanOrEqual(160);
});

test("the migration runner emits a controlled failure and preserves the original rejection", () => {
  const migratePath = join(import.meta.dir, "../scripts/migrate.ts");
  const result = runWriter(`
    const { runMigrations } = await import(${JSON.stringify(migratePath)});
    const failed = new Error("private migration error");
    const client = { end: async () => {} };
    try {
      await runMigrations(client, "unused", async () => { throw failed; });
      process.exitCode = 1;
    } catch (caught) {
      if (caught !== failed) process.exitCode = 2;
    }
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("");
  const line = result.stderr.toString();
  expect(line).not.toContain("private migration error");
  expect(JSON.parse(line)).toMatchObject({
    stream: "openbot_runtime",
    severity: "error",
    component: "migration",
    operation: "apply",
    outcome: "failed",
    error_category: "migration_error",
  });
});

test("the worker reports invalid startup configuration and exits without an exporter", () => {
  const workerPath = join(import.meta.dir, "../../worker/src/index.ts");
  const result = Bun.spawnSync(
    [process.execPath, "--no-env-file", workerPath],
    {
      env: { DEPLOYMENT_ID: "worker-test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(JSON.parse(result.stderr.toString())).toMatchObject({
    deployment_id: "worker-test",
    component: "worker",
    event_category: "worker_configuration_failed",
    outcome: "failed",
    diagnostic: expect.stringContaining("WORKER_SHARED_SECRET"),
  });
}, 20_000);

test("startup still announces its wait once and emits only private, bounded legacy diagnostics", () => {
  const checkPath = join(
    import.meta.dir,
    "../src/intelligence-entitlement-check.ts",
  );
  const result = runWriter(
    `
    const { reportIntelligenceEntitlement } = await import(${JSON.stringify(checkPath)});
    let elapsed = 0;
    let reads = 0;
    await reportIntelligenceEntitlement({
      entitlements: async () => {
        reads++;
        throw Object.assign(new Error("PRIVATE UPSTREAM BODY".repeat(1000)), {
          status: 503,
          toJSON() { throw new Error("must not serialize errors"); },
        });
      },
      windowMs: 3000,
      now: () => elapsed,
      sleep: async (ms) => { elapsed += ms; },
    });
    if (reads !== 3 || elapsed !== 3000) process.exitCode = 1;
    `,
    { DEPLOYMENT_ID: "startup-test" },
  );

  expect(result.exitCode).toBe(0);
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  expect(stdout + stderr).not.toContain("PRIVATE UPSTREAM BODY");
  expect(JSON.parse(stdout)).toMatchObject({
    deployment_id: "startup-test",
    component: "api",
    event_category: "intelligence_entitlement_waiting",
    wait_window_ms: 3000,
    diagnostic: expect.stringContaining("Waiting for Intelligence"),
  });
  const legacy = JSON.parse(stderr);
  expect(legacy).toMatchObject({
    stream: "openbot_runtime",
    deployment_id: "startup-test",
    component: "api",
    event_category: "legacy_unstructured",
    legacy_event: "intelligence_entitlement_unreadable",
    projection_status: "unknown",
    http_status: 503,
  });
  expect(Buffer.byteLength(legacy.diagnostic, "utf8")).toBeLessThanOrEqual(160);
});
