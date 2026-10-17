import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import {
  createEnterpriseStore,
  GATEWAY_ENDPOINT_KEY,
} from "../src/admin/settings-store";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  enterpriseSettings,
  userRoles,
  users,
} from "../src/db/schema";
import {
  createGatewayAdminCredentialService,
  GATEWAY_ADMIN_CREDENTIAL_KEY,
} from "../src/gateway/admin-credential";
import { createConversionRateStore } from "../src/gateway/conversion-rate-store";
import {
  createGatewayEndpointService,
  type GatewayEndpointConfig,
} from "../src/gateway/endpoint-config";
import {
  createEnterpriseGatewayProbeStore,
  createGatewayProbeService,
  GATEWAY_PROBE_RESULT_KEY,
  type GatewayProbeRecord,
} from "../src/gateway/probe";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { startFakeGateway, upstreamSecretMarker } from "./support/fake-gateway";

/*
 * Bifrost 01.5 — the probe against a real PostgreSQL, on TEST_DATABASE_URL (tests/support/
 * database.ts refuses the live database). What only the database can prove: a probe result
 * survives a restart (a fresh service over the same rows), a failed probe leaves the saved
 * endpoint configuration and the conversion rate exactly as they were, a save racing the probe
 * does not re-label the result, and the persisted row — the one a status page reads after a
 * restart — carries no upstream bytes.
 */

const encryptionKey = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32)),
).toString("base64");

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const enterpriseStore = createEnterpriseStore(database);
const endpointService = createGatewayEndpointService({
  store: enterpriseStore,
});
const credentialService = createGatewayAdminCredentialService({
  database,
  encryptionKey,
  member: (userId) => enterpriseStore.member(userId),
});
const rateStore = createConversionRateStore({ database });

const logLines: string[] = [];
const capturedLog = pino({ level: "trace" }, {
  write(chunk: string) {
    logLines.push(chunk);
  },
} as pino.DestinationStream);

const runId = randomUUID().slice(0, 8);
const adminId = `gateway-probe-admin-${runId}`;
const admin = { userId: adminId, email: `admin-${runId}@openbot.test` };
const ADMIN_KEY = `probe-integration-admin-key-${runId}`;

function probeService() {
  const endpoint = createGatewayEndpointService({ store: enterpriseStore });
  const credential = createGatewayAdminCredentialService({
    database,
    encryptionKey,
    member: (userId) => enterpriseStore.member(userId),
  });
  return createGatewayProbeService({
    store: createEnterpriseGatewayProbeStore(database),
    readGatewayEndpoint: () => endpoint.readGatewayEndpoint(),
    resolveGatewayAdminCredential: () =>
      credential.resolveGatewayAdminCredential(),
    log: capturedLog,
  });
}

function currentEndpointRow(): Promise<GatewayEndpointConfig | undefined> {
  return enterpriseStore
    .readGatewayEndpointRow()
    .then((row) => (row.state === "configured" ? row.config : undefined));
}

async function rateRowSnapshot() {
  const rows = await database
    .select({ value: enterpriseSettings.value })
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, "gateway_conversion_rate"));
  return rows[0]?.value;
}

/** Wait until the named condition holds, so request arrivals are deterministic. */
async function waitFor(condition: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterAll(async () => {
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_ENDPOINT_KEY));
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_ADMIN_CREDENTIAL_KEY));
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_PROBE_RESULT_KEY));
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, "gateway_conversion_rate"));
  await database
    .delete(credentials)
    .where(eq(credentials.kind, "gateway_admin"));
  await database.delete(users).where(eq(users.id, adminId));
  await database.$client.close();
});

test("setup: the administrator, a conversion rate, and a clean result row", async () => {
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_PROBE_RESULT_KEY));
  // The rate exists so the "a failed probe changed nothing" test has something to lose.
  await rateStore.save({ numerator: "100", denominator: "1" }, admin.email);
  await database
    .insert(users)
    .values([{ id: adminId, email: admin.email }])
    .onConflictDoNothing();
  await database
    .insert(userRoles)
    .values([{ userId: adminId, role: "admin" }])
    .onConflictDoNothing();
});

test("a healthy gateway answers ok, persists, and the result survives a restart", async () => {
  const gateway = await startFakeGateway({
    kind: "response",
    status: 200,
    body: '{"authConfig":{"admin":{"exists":true}}}',
  });
  await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    admin,
  );
  await credentialService.saveGatewayAdminCredential(
    { adminKey: ADMIN_KEY },
    admin,
  );

  const run = await probeService().probeGateway();
  expect(run.ready).toBe(true);
  if (!run.ready) throw new Error("expected a probe, got a refusal");
  expect(run.result.status).toBe("ok");
  expect(run.result.reasonCode).toBe("gateway_probe_ok");
  const savedVersion = (await currentEndpointRow())?.configVersion;
  expect(run.result.configVersion).toBe(savedVersion);

  // A fresh service over the same rows — the restart a status page lives through.
  const reopened = await probeService().readLastGatewayProbe();
  expect(reopened).toEqual(run.result);

  // The request carried the credential, and the fake served no secret material.
  expect(gateway.requests[0]?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
  await gateway.stop();
});

test("a real fetch deadline is classified as a timeout, not a crash or a refusal", async () => {
  const gateway = await startFakeGateway({ kind: "hang" });
  await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 100 },
    admin,
  );
  const run = await probeService().probeGateway();
  await gateway.stop();
  expect(run.ready).toBe(true);
  if (!run.ready) throw new Error("expected a probe, got a refusal");
  expect(run.result.status).toBe("timeout");
  expect(run.result.reasonCode).toBe("gateway_probe_timeout");
  expect(run.result.durationMs).toBeLessThan(5_000);
  const persisted = await probeService().readLastGatewayProbe();
  expect(persisted?.status).toBe("timeout");
});

test("a dead address is unreachable, and the failure changed no saved configuration", async () => {
  const beforeRate = await rateRowSnapshot();
  expect(beforeRate).toBeDefined();

  const gateway = await startFakeGateway({
    kind: "response",
    status: 200,
    body: "{}",
  });
  const deadUrl = gateway.baseUrl;
  await gateway.stop(); // nothing listens there now
  await endpointService.saveGatewayEndpoint(
    { baseUrl: deadUrl, requestTimeoutMs: 2_000 },
    admin,
  );
  const afterSave = await currentEndpointRow();

  const run = await probeService().probeGateway();
  expect(run.ready).toBe(true);
  if (!run.ready) throw new Error("expected a probe, got a refusal");
  expect(run.result.status).toBe("unreachable");
  expect(run.result.reasonCode).toBe("gateway_probe_connection_failed");

  // The failed probe touched only its own row: the endpoint and the rate are untouched.
  expect(await currentEndpointRow()).toEqual(afterSave);
  expect(await rateRowSnapshot()).toEqual(beforeRate);
});

test("a 401 carrying upstream secrets is stored and logged without any of them", async () => {
  const marker = upstreamSecretMarker();
  const gateway = await startFakeGateway({
    kind: "response",
    status: 401,
    body: JSON.stringify({
      error: `denied: ${marker.secret}`,
      detail: marker.secret,
    }),
    headers: { "x-bf-trace": marker.secret },
  });
  await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    admin,
  );

  const run = await probeService().probeGateway();
  await gateway.stop();
  expect(run.ready).toBe(true);
  if (!run.ready) throw new Error("expected a probe, got a refusal");
  expect(run.result.status).toBe("unauthenticated");
  expect(run.result.reasonCode).toBe("gateway_probe_unauthorized");

  const persisted = await probeService().readLastGatewayProbe();
  for (const content of [
    JSON.stringify(run.result),
    JSON.stringify(persisted),
    logLines.join("\n"),
  ]) {
    for (const variant of marker.variants) {
      expect(content).not.toContain(variant);
    }
  }
});

test("a save racing the probe leaves the result bound to the version it dialed", async () => {
  const gateway = await startFakeGateway({ kind: "hold" });
  await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    admin,
  );
  const dialedVersion = (await currentEndpointRow())?.configVersion;

  const runPromise = probeService().probeGateway();
  await waitFor(() => gateway.requests.length === 1, "the probe to arrive");
  await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    admin,
  );
  gateway.release();
  const run = await runPromise;
  await gateway.stop();

  expect(run.ready).toBe(true);
  if (!run.ready) throw new Error("expected a probe, got a refusal");
  expect(run.result.status).toBe("ok");
  expect(run.result.configVersion).toBe(dialedVersion);
  // The probe did not rewrite the configuration either: the save's version stands.
  expect((await currentEndpointRow())?.configVersion).toBe(
    (dialedVersion ?? 0) + 1,
  );
  const persisted = await probeService().readLastGatewayProbe();
  expect(persisted?.configVersion).toBe(dialedVersion);
});

test("an older completion never overwrites a newer persisted result", async () => {
  const store = createEnterpriseGatewayProbeStore(database);
  const newer: GatewayProbeRecord = {
    status: "ok",
    reasonCode: "gateway_probe_ok",
    checkedAt: new Date(Date.now() + 3_600_000).toISOString(),
    configVersion: 3,
    durationMs: 12,
  };
  const older: GatewayProbeRecord = {
    ...newer,
    checkedAt: new Date(Date.now() - 3_600_000).toISOString(),
    configVersion: 2,
  };
  await store.saveGatewayProbeResult(newer);
  await store.saveGatewayProbeResult(older);
  expect((await store.readGatewayProbeResult())?.checkedAt).toBe(
    newer.checkedAt,
  );
});

test("a damaged persisted row reads as absent rather than as a probe answer", async () => {
  await database
    .insert(enterpriseSettings)
    .values({
      key: GATEWAY_PROBE_RESULT_KEY,
      value: { status: "fine", body: "whatever a hand edit wrote" },
      updatedBy: "tamper-test",
    })
    .onConflictDoUpdate({
      target: enterpriseSettings.key,
      set: { value: { status: "fine", body: "whatever a hand edit wrote" } },
    });
  const service = probeService();
  expect(await service.readLastGatewayProbe()).toBeUndefined();
  // And the damaged row did not stop the next probe from persisting over it.
  const gateway = await startFakeGateway({
    kind: "response",
    status: 200,
    body: "{}",
  });
  await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    admin,
  );
  const run = await service.probeGateway();
  await gateway.stop();
  expect(run.ready).toBe(true);
  const persisted = await service.readLastGatewayProbe();
  expect(persisted?.status).toBe("ok");
});

test("the log never carries the gateway address or the credential", async () => {
  const rendered = logLines.join("\n");
  expect(rendered).not.toContain(ADMIN_KEY);
  // Probe log lines identify the configuration by version, never by address.
  for (const line of logLines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.baseUrl).toBeUndefined();
    expect(String(line)).not.toMatch(/127\.0\.0\.1:\d+/);
  }
  expect(rendered.length).toBeGreaterThan(0);
});
