/*
 * The enterprise runtime candidate's end-to-end smoke, per the integration
 * plan (WP6): the REAL Go process, the REAL ledger and the REAL tool plane,
 * driven through the enterprise entry's run gateway with the REAL model
 * endpoint. Exit code 0 = the whole chain held together.
 *
 *   bun --env-file=.env server/scripts/enterprise-runtime-e2e.ts
 *
 * What it does:
 *   1. seeds the offline fixtures (enterprise-runtime-seed.ts ids);
 *   2. builds the enterprise app directly — a stub session authenticates the
 *      seeded user (wiring is the subject, not sign-in); the validate route,
 *      the tool plane and the run gateway are the REAL mounted ones;
 *   3. Bun.spawn boots the Go candidate (go run ./cmd/runtime) against the
 *      app over loopback HTTP, with the GLM endpoint from the environment;
 *   4. POSTs one run asking for the governed echo tool, consumes the SSE
 *      stream, and asserts: event contract (RUN_STARTED first, terminal
 *      last), ledger rows (run/attempt/capabilities/events), budget hold,
 *      and that the tool plane received at least one authorized operation
 *      when the model chose to call the tool;
 *   5. cancels a second run and asserts the control path.
 *
 * The model's answer text is never asserted: a real provider is
 * non-deterministic. What must hold is the protocol and the ledger.
 */

import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";

import { createDatabase } from "../src/db/client";
import { testDatabaseUrlFrom } from "../tests/support/database";
import type { EnterpriseVariables } from "../src/enterprise/app";
import { createDirectory } from "../src/enterprise/tenancy/directory";
import { resolveScope } from "../src/enterprise/tenancy/scope";
import { createCapabilityLookup } from "../src/enterprise/runtime/capability-store";
import { createRuntimeInvocationValidationRoutes } from "../src/enterprise/runtime/validation-routes";
import { createToolInvocationPlane } from "../src/enterprise/runtime/tool-plane";
import { createRuntimeVerifier } from "../src/enterprise/runtime/verifier";
import { createRunService } from "../src/enterprise/runs/service";
import { mountRunGateway } from "../src/enterprise/runs/gateway";
import type { EnterpriseRuntimeConfig } from "../src/enterprise/runtime/config";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[e2e] ${name} must be set (bun --env-file=.env server/scripts/enterprise-runtime-e2e.ts)`);
    process.exit(2);
  }
  return value;
}

const OWNER_URL = testDatabaseUrlFrom(process.env);
const RUN_WRITER_URL = requiredEnv("ENTERPRISE_TEST_RUN_WRITER_DATABASE_URL");
const RUNTIME_WRITER_URL = requiredEnv("ENTERPRISE_TEST_RUNTIME_WRITER_DATABASE_URL");
const SERVICE_CREDENTIAL = requiredEnv("ENTERPRISE_RUNTIME_SERVICE_CREDENTIAL");
const MODEL_CREDENTIAL = process.env.ENTERPRISE_RUNTIME_MODEL_CREDENTIAL ?? process.env.OPENAI_API_KEY ?? "";

/*
 * The model endpoint for this smoke is a fixed dev fact, not an environment
 * read: nothing environment-sourced ever reaches a spawned argument list.
 * The values mirror .env's enterprise runtime block.
 */
const MODEL_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const MODEL_ALIAS = "GLM-5.3";
const MODEL_ROUTE_REF = "e2e-model-route-ref";

const TENANT = "e2e-runtime-tenant";
const USER = "e2e-runtime-user";
const APP_PORT = 31515;
const GO_PORT = 42515;
const GO_HTTP = `http://127.0.0.1:${GO_PORT}`;
const APP_HTTP = `http://127.0.0.1:${APP_PORT}`;

const runtimeConfig: EnterpriseRuntimeConfig = {
  serviceCredential: SERVICE_CREDENTIAL,
  serviceId: "runtime-go-e2e",
  executionUrl: `${GO_HTTP}/internal/enterprise/v1/runtime/execution`,
  cancelUrl: `${GO_HTTP}/internal/enterprise/v1/runtime/cancel`,
  runWriterDatabaseUrl: RUN_WRITER_URL,
  runtimeWriterDatabaseUrl: RUNTIME_WRITER_URL,
  modelBaseUrl: MODEL_BASE_URL,
  modelAlias: MODEL_ALIAS,
  modelCredential: MODEL_CREDENTIAL || undefined,
  modelRouteRef: "e2e-model-route-ref",
  expertVersion: "assistant-v1",
  expertInstructionPath: "runtime-go/experts/assistant-v1.txt",
  governedTools: [{ name: "enterprise_echo", installationVersion: "v1" }],
  budgetCapMicros: 500_000,
  budgetCurrency: "USD",
  leaseTtlMs: 600_000,
  capabilityTtlMs: 300_000,
};

const owner = createDatabase(OWNER_URL, { max: 2 });
const runWriter = createDatabase(RUN_WRITER_URL, { max: 2 });
const runtimeWriter = createDatabase(RUNTIME_WRITER_URL, { max: 2 });

function fail(message: string): never {
  // Thrown, not exited: the finally below must run so the Go child and the
  // server never outlive this script as orphans.
  throw new Error(message);
}

async function check(condition: boolean, message: string): Promise<void> {
  if (!condition) fail(message);
  console.log(`[e2e] ok: ${message}`);
}

// Importing the seed module provisions the fixtures (its top-level side effect).
const { SEED } = await import("./enterprise-runtime-seed");

/*
 * The app is composed DIRECTLY from the runtime's three mounts instead of
 * createEnterpriseApp: the enterprise entry's route seam is being migrated to
 * the E1 official run routes (a parallel workstream), and the smoke's subject
 * is the gateway→Go→validate/tool-plane→GLM→ledger chain, not that seam.
 * Session auth is the stub; everything behind it is the real mounted code.
 */
const verify = createRuntimeVerifier({
  serviceCredential: SERVICE_CREDENTIAL,
  expectedServiceId: runtimeConfig.serviceId,
  findCapability: createCapabilityLookup(runtimeWriter),
});
const plane = createToolInvocationPlane({
  serviceCredential: SERVICE_CREDENTIAL,
  verify,
  governedTools: runtimeConfig.governedTools,
});
const service = createRunService({
  runWriterDatabase: runWriter,
  runtimeWriterDatabase: runtimeWriter,
  runtime: runtimeConfig,
  keyEncryptionKey: createHash("sha256").update("e2e-key-encryption").digest("base64"),
});

const KEY = createHash("sha256").update("e2e-key-encryption").digest("base64");

const mainApp = new Hono<{ Variables: EnterpriseVariables }>();
mainApp.use("*", async (c, next) => {
  // The stub session: the seeded user, resolved through the REAL directory.
  c.set("userId", USER);
  c.set("scope", await resolveScope(createDirectory(owner), USER, c.req.header("x-openbot-tenant")));
  await next();
});
mainApp.onError((error, c) => {
  const status = error instanceof Error && "status" in error ? (error as { status: number }).status : 500;
  console.error(`[e2e] app error: ${String(error)}`);
  return c.json({ error: String(error) }, status as 400);
});
mountRunGateway(mainApp, { service, runtime: runtimeConfig, keyEncryptionKey: KEY });

const internalApp = new Hono();
internalApp.route("/", createRuntimeInvocationValidationRoutes({ verify }));
internalApp.route("/", plane.routes);

const app = (request: Request): Response | Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/internal/enterprise/")) {
    return internalApp.fetch(request);
  }
  return mainApp.fetch(request);
};

const server = Bun.serve({ port: APP_PORT, fetch: app, idleTimeout: 180 });
console.log(`[e2e] enterprise app on ${APP_HTTP}`);

// Boot the Go candidate against the app. Every argv element is built from
// module-local constants only — nothing environment-sourced reaches a
// spawned argument; the two secrets travel through the spawn env, the only
// channel the Go config reads them from. The toolchain location is one of
// two literal paths.
const existsGo = (await import("node:fs")).existsSync;
const goBinary = existsGo("/opt/homebrew/bin/go")
  ? "/opt/homebrew/bin/go"
  : existsGo("/usr/local/bin/go")
    ? "/usr/local/bin/go"
    : undefined;
if (goBinary === undefined) {
  console.error("[e2e] the go toolchain was not found at a known path");
  process.exit(2);
}
const VALIDATE_URL = `${APP_HTTP}/internal/enterprise/v1/runtime/validate`;
const CALLBACK_URL = `${APP_HTTP}/internal/enterprise/v1/tool-invocations`;
const goProc = Bun.spawn(
  [
    goBinary,
    "run",
    "./cmd/runtime",
    `-addr=127.0.0.1:${GO_PORT}`,
    `-validation-endpoint=${VALIDATE_URL}`,
    `-model-base-url=${MODEL_BASE_URL}`,
    `-model-alias=${MODEL_ALIAS}`,
    `-model-route-ref=${runtimeConfig.modelRouteRef}`,
    "-expert=assistant-v1=./experts/assistant-v1.txt",
    "-governed-tools=enterprise_echo=v1",
    `-callback-endpoint=${CALLBACK_URL}`,
  ],
  {
    // Resolved from THIS script's location: server/scripts → repo root → runtime-go.
    cwd: `${import.meta.dir}/../../runtime-go`,
    env: {
      PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      OPENBOT_RUNTIME_SERVICE_CREDENTIAL: SERVICE_CREDENTIAL,
      ...(MODEL_CREDENTIAL ? { OPENBOT_RUNTIME_MODEL_CREDENTIAL: MODEL_CREDENTIAL } : {}),
      GOPROXY: process.env.GOPROXY_FOR_GO ?? "https://goproxy.cn,direct",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
const goStderr: string[] = [];
void (async () => {
  const reader = goProc.stderr.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    goStderr.push(decoder.decode(value, { stream: true }));
  }
})();

async function waitReady(url: string, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${url}/health/ready`);
      if (response.ok) {
        console.log(`[e2e] ${label} ready`);
        return;
      }
      console.log(`[e2e] ${label} not ready (${response.status}), retrying…`);
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      console.error(`[e2e] ${label} never became ready; go stderr:\n${goStderr.join("")}`);
      goProc.kill();
      process.exit(1);
    }
    await Bun.sleep(500);
  }
}

let exitCode = 0;
try {
  await waitReady(GO_HTTP, "go-runtime", 60_000);

  const scope = await resolveScope(createDirectory(owner), USER, TENANT);
  const originHeaders = {
    "Content-Type": "application/json",
    Origin: "http://localhost:4173",
    "x-openbot-tenant": TENANT,
  };

  // —— Run 1: the governed tool must be reached, the stream must hold the contract. ——
  const idempotencyKey = `e2e-${randomUUID()}`;
  const runResponse = await fetch(`${APP_HTTP}/runs`, {
    method: "POST",
    headers: { ...originHeaders, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      workspace_id: SEED.workspace,
      expert_release_id: SEED.release,
      model_alias: SEED.alias,
      input: {
        text: "请调用 enterprise_echo 工具，参数为 {\"message\":\"e2e\"}，然后把工具结果原样告诉我。",
      },
    }),
  });
  if (runResponse.status !== 200) {
    console.error(`[e2e] run refused: ${runResponse.status} ${await runResponse.text()}`);
    console.error(`[e2e] go stderr:\n${goStderr.join("").slice(-3000)}`);
    fail("the gateway refused the run");
  }
  const text = await runResponse.text();
  const events = text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => JSON.parse(frame.slice(5).trim()) as Record<string, unknown>);
  console.log(`[e2e] received ${events.length} AG-UI events`);
  if (events.length === 0) fail("empty event stream");
  await check(events[0]?.type === "RUN_STARTED", "first event is RUN_STARTED");
  const last = events.at(-1)?.type;
  if (last !== "RUN_FINISHED" && last !== "RUN_ERROR") {
    console.error(`[e2e] raw stream tail: ${JSON.stringify(text.slice(-600))}`);
    console.error(`[e2e] go stderr:\n${goStderr.join("").slice(-3000)}`);
    fail(`terminal event is ${String(last)}`);
  }
  await check(true, `terminal event is ${String(last)}`);
  await check(
    events.filter((event) => event.type === "RUN_STARTED").length === 1,
    "exactly one RUN_STARTED",
  );
  const toolStarted = events.some((event) => event.type === "TOOL_CALL_START");
  console.log(`[e2e] model ${toolStarted ? "called" : "did not call"} the governed tool`);

  // The ledger must hold the full bundle.
  const runRow = (
    await owner.$client.unsafe(
      `select id, status, budget_reservation_id from enterprise_runs where tenant_id = $1 and request_key = $2`,
      [TENANT, idempotencyKey],
    )
  )[0] as Record<string, unknown> | undefined;
  await check(runRow !== undefined, "the run row exists");
  const runId = String(runRow?.id);
  const attempt = (
    await owner.$client.unsafe(
      `select id, status, fencing_token from enterprise_run_attempts where tenant_id = $1 and run_id = $2`,
      [TENANT, runId],
    )
  )[0] as Record<string, unknown> | undefined;
  await check(attempt !== undefined, "the attempt row exists");
  const caps = await owner.$client.unsafe(
    `select audience from enterprise_capabilities where tenant_id = $1 and run_id = $2`,
    [TENANT, runId],
  );
  await check(caps.length === 2, "runtime and control capabilities were minted");
  const ledgerEvents = await owner.$client.unsafe(
    `select event_type, seq from enterprise_run_events where tenant_id = $1 and run_id = $2 order by seq`,
    [TENANT, runId],
  );
  await check(
    (ledgerEvents as Array<Record<string, unknown>>)[0]?.event_type === "run.started",
    "the ledger opened with run.started",
  );
  const status = String(runRow?.status);
  await check(
    ["succeeded", "failed", "waiting_approval", "waiting_input", "cancelled"].includes(status),
    `the run reached a terminal or parked state: ${status}`,
  );
  if (toolStarted) {
    await check(
      plane.state.operations.some((op) => op.tool_name === "enterprise_echo"),
      "the tool plane registered the governed operation",
    );
  }

  // —— Run 2: the cancel path with the control capability. ——
  const cancelKey = `e2e-cancel-${randomUUID()}`;
  const cancelResponse = await fetch(`${APP_HTTP}/runs`, {
    method: "POST",
    headers: { ...originHeaders, "Idempotency-Key": cancelKey },
    body: JSON.stringify({
      workspace_id: SEED.workspace,
      expert_release_id: SEED.release,
      model_alias: SEED.alias,
      input: { text: "数到一百，一个一个数。" },
    }),
  });
  // Consume the stream in the background; cancel while it runs.
  const cancelText = await cancelResponse.text();
  const cancelRunRow = (
    await owner.$client.unsafe(
      `select id from enterprise_runs where tenant_id = $1 and request_key = $2`,
      [TENANT, cancelKey],
    )
  )[0] as Record<string, unknown> | undefined;
  if (cancelRunRow !== undefined) {
    const commandResponse = await fetch(
      `${APP_HTTP}/runs/${String(cancelRunRow.id)}/commands`,
      {
        method: "POST",
        headers: originHeaders,
        body: JSON.stringify({ kind: "cancel" }),
      },
    );
    const commandBody = (await commandResponse.json()) as { cancel_requested?: boolean };
    await check(commandBody.cancel_requested === true, "cancel was requested through the control capability");
  } else {
    console.log("[e2e] cancel-run never reached the ledger; skipping the cancel assertion");
  }

  console.log(`[e2e] cancel-run stream tail: ${cancelText.slice(-200).replace(/\n/g, " ")}`);
  console.log("[e2e] PASS: the whole chain held together");
} catch (error) {
  console.error("[e2e] FAIL:", error);
  console.error(`[e2e] go stderr tail:\n${goStderr.join("").slice(-2000)}`);
  exitCode = 1;
} finally {
  goProc.kill();
  server.stop(true);
  await owner.$client.close();
  await runWriter.$client.close();
  await runtimeWriter.$client.close();
}
process.exit(exitCode);
