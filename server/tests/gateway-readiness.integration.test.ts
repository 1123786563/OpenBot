import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createEnterpriseStore,
  GATEWAY_ENDPOINT_KEY,
} from "../src/admin/settings-store";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
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
import {
  CREDIT_ADMISSION_EXTENSION_NAME,
  createEnterpriseGatewayNegotiationStore,
  createGatewayCapabilityNegotiationService,
  GATEWAY_NEGOTIATION_RESULT_KEY,
} from "../src/gateway/capability-negotiation";
import { createConversionRateStore } from "../src/gateway/conversion-rate-store";
import { createGatewayEndpointService } from "../src/gateway/endpoint-config";
import {
  assertGatewayReadyForBilling,
  createGatewayReadinessService,
  gatewayReadinessControls,
  GatewayNotReadyError,
  installGatewayReadinessService,
} from "../src/gateway/readiness";
import {
  createEnterpriseGatewayProbeStore,
  createGatewayProbeService,
  GATEWAY_PROBE_RESULT_KEY,
} from "../src/gateway/probe";
import { testEnvironment } from "./support/environment";
import { startFakeGateway, upstreamSecretMarker } from "./support/fake-gateway";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost 01.7 — the readiness gate against a real PostgreSQL, on
 * TEST_DATABASE_URL (tests/support/database.ts refuses the live database).
 * What only the database can prove: the five conjunctive conditions read the
 * real rows the sibling tickets write — the saved endpoint (01.1), the vault
 * credential (01.2), the persisted probe result (01.5), the persisted
 * negotiation verdict (01.6) and the conversion-rate pointer (01.3/01.4) —
 * and flipping each one flips the verdict, with the reasons naming every open
 * condition. Also here: the app wiring installs the gate, and a process whose
 * gate is missing refuses paid work instead of waving it through.
 *
 * Each test re-establishes a fully ready baseline first (`establishReady`),
 * then breaks exactly one condition, so a refusal names that one condition —
 * and only that one — over real rows.
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
const probeStore = createEnterpriseGatewayProbeStore(database);
const negotiationStore = createEnterpriseGatewayNegotiationStore(database);

/** The gate under test: the five conditions over the real rows, nothing else. */
const negotiationService = createGatewayCapabilityNegotiationService({
  store: negotiationStore,
  readGatewayEndpoint: () => endpointService.readGatewayEndpoint(),
  resolveGatewayAdminCredential: () =>
    credentialService.resolveGatewayAdminCredential(),
});
const gate = createGatewayReadinessService({
  readGatewayEndpoint: () => endpointService.readGatewayEndpoint(),
  resolveGatewayAdminCredential: () =>
    credentialService.resolveGatewayAdminCredential(),
  readLastGatewayProbe: () => probeStore.readGatewayProbeResult(),
  // The service's reader, not the raw row: a verdict answers only for the
  // configuration it decided against (01.6 owns the retirement rule).
  readLastGatewayNegotiation: () =>
    negotiationService.readLastGatewayNegotiation(),
  readConversionRate: () => rateStore.readConversionRate(),
});

const runId = randomUUID().slice(0, 8);
const adminId = `gateway-readiness-admin-${runId}`;
const admin = { userId: adminId, email: `admin-${runId}@openbot.test` };
const ADMIN_KEY = `readiness-integration-admin-key-${runId}`;

/** A fake gateway whose probe path answers ok and whose manifest has the extension. */
async function healthyFakeGateway() {
  return startFakeGateway(
    {
      kind: "response",
      status: 200,
      body: '{"authConfig":{"admin":{"exists":true}}}',
    },
    {
      "/api/plugins": {
        kind: "response",
        status: 200,
        body: JSON.stringify({
          plugins: [
            { name: "bifrost-anthropic", version: "1.2.3" },
            { name: CREDIT_ADMISSION_EXTENSION_NAME, version: "1.0.0" },
          ],
        }),
      },
    },
  );
}

async function runVerification() {
  const endpoint = createGatewayEndpointService({ store: enterpriseStore });
  const credential = createGatewayAdminCredentialService({
    database,
    encryptionKey,
    member: (userId) => enterpriseStore.member(userId),
  });
  const probe = createGatewayProbeService({
    store: createEnterpriseGatewayProbeStore(database),
    readGatewayEndpoint: () => endpoint.readGatewayEndpoint(),
    resolveGatewayAdminCredential: () =>
      credential.resolveGatewayAdminCredential(),
  });
  const negotiation = createGatewayCapabilityNegotiationService({
    store: createEnterpriseGatewayNegotiationStore(database),
    readGatewayEndpoint: () => endpoint.readGatewayEndpoint(),
    resolveGatewayAdminCredential: () =>
      credential.resolveGatewayAdminCredential(),
  });
  return {
    probeRun: await probe.probeGateway(),
    negotiationRun: await negotiation.negotiateGatewayCapabilities(),
  };
}

/**
 * Re-establish every condition green over the real rows: the credential and
 * the rate are re-saved (both writes are idempotent-ish rotations and repair
 * whatever the previous test left), the endpoint is re-pointed at a fresh
 * healthy fake, and the probe and negotiation run against it. Answers the
 * fake so a test can break one branch of it.
 */
async function establishReady() {
  const gateway = await healthyFakeGateway();
  const credential = await credentialService.saveGatewayAdminCredential(
    { adminKey: ADMIN_KEY },
    { userId: adminId, email: admin.email },
  );
  expect(credential.ok).toBe(true);
  const rate = await rateStore.save(
    { numerator: "100", denominator: "1" },
    admin.email,
  );
  expect(rate.ok).toBe(true);
  const saved = await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    { userId: adminId, email: admin.email },
  );
  expect(saved.ok).toBe(true);
  const { probeRun, negotiationRun } = await runVerification();
  expect(probeRun.ready && probeRun.result.status).toBe("ok");
  expect(negotiationRun.negotiated).toBe(true);
  const readiness = await gate.assertGatewayReadyForBilling();
  expect(readiness.ready).toBe(true);
  expect(readiness.configVersion).toBe(await currentEndpointVersion());
  return gateway;
}

async function currentEndpointVersion(): Promise<number> {
  const row = await enterpriseStore.readGatewayEndpointRow();
  return row.state === "configured" ? row.config.configVersion : 0;
}

const GATEWAY_SETTING_KEYS = [
  GATEWAY_ENDPOINT_KEY,
  GATEWAY_ADMIN_CREDENTIAL_KEY,
  GATEWAY_PROBE_RESULT_KEY,
  GATEWAY_NEGOTIATION_RESULT_KEY,
  "gateway_conversion_rate",
];

afterAll(async () => {
  // The wiring test leaves a gate installed; take it back out so no other
  // file inherits this process's module state.
  installGatewayReadinessService(undefined);
  for (const key of GATEWAY_SETTING_KEYS) {
    await database
      .delete(enterpriseSettings)
      .where(eq(enterpriseSettings.key, key));
  }
  await database
    .delete(credentials)
    .where(eq(credentials.kind, "gateway_admin"));
  await database.delete(users).where(eq(users.id, adminId));
  await database.$client.close();
});

test("setup: an administrator and clean gateway rows", async () => {
  for (const key of GATEWAY_SETTING_KEYS) {
    await database
      .delete(enterpriseSettings)
      .where(eq(enterpriseSettings.key, key));
  }
  await database
    .delete(credentials)
    .where(eq(credentials.kind, "gateway_admin"));
  await database
    .insert(users)
    .values([{ id: adminId, email: admin.email }])
    .onConflictDoNothing();
  await database
    .insert(userRoles)
    .values([{ userId: adminId, role: "admin" }])
    .onConflictDoNothing();
});

test("a fresh deployment refuses, naming all five conditions", async () => {
  const readiness = await gate.evaluateGatewayReadiness();
  expect(readiness.ready).toBe(false);
  expect(readiness.blockingReasons).toEqual([
    "gateway_readiness_endpoint_not_configured",
    "gateway_readiness_credential_not_configured",
    "gateway_readiness_probe_missing",
    "gateway_readiness_extension_not_negotiated",
    "gateway_readiness_rate_not_configured",
  ]);
  expect(readiness.configVersion).toBe(0);
  let caught: unknown;
  try {
    await gate.assertGatewayReadyForBilling();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GatewayNotReadyError);
  const message = (caught as GatewayNotReadyError).message;
  for (const reason of readiness.blockingReasons) {
    expect(message).toContain(reason);
  }
});

test("address and credential alone leave the verification branches open", async () => {
  const saved = await endpointService.saveGatewayEndpoint(
    { baseUrl: "http://127.0.0.1:1", requestTimeoutMs: 5_000 },
    { userId: adminId, email: admin.email },
  );
  expect(saved.ok).toBe(true);
  const credential = await credentialService.saveGatewayAdminCredential(
    { adminKey: ADMIN_KEY },
    { userId: adminId, email: admin.email },
  );
  expect(credential.ok).toBe(true);
  const readiness = await gate.evaluateGatewayReadiness();
  expect(readiness.blockingReasons).toEqual([
    "gateway_readiness_probe_missing",
    "gateway_readiness_extension_not_negotiated",
    "gateway_readiness_rate_not_configured",
  ]);
  expect(readiness.configVersion).toBe(await currentEndpointVersion());
});

test("probe ok and extension present close the verification branches; only the rate is missing", async () => {
  const gateway = await healthyFakeGateway();
  const saved = await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    { userId: adminId, email: admin.email },
  );
  expect(saved.ok).toBe(true);
  const { probeRun, negotiationRun } = await runVerification();
  expect(probeRun.ready && probeRun.result.status).toBe("ok");
  expect(negotiationRun.negotiated).toBe(true);
  const readiness = await gate.evaluateGatewayReadiness();
  expect(readiness.blockingReasons).toEqual([
    "gateway_readiness_rate_not_configured",
  ]);
  await gateway.stop();
});

test("the rate completes readiness; the verdict carries the configVersion to lock", async () => {
  const saved = await rateStore.save(
    { numerator: "100", denominator: "1" },
    admin.email,
  );
  expect(saved.ok).toBe(true);
  const readiness = await gate.assertGatewayReadyForBilling();
  expect(readiness.ready).toBe(true);
  expect(readiness.blockingReasons).toEqual([]);
  expect(readiness.configVersion).toBe(await currentEndpointVersion());
  expect(readiness.configVersion).toBeGreaterThanOrEqual(1);
});

test("a configuration change retires the probe and the negotiation", async () => {
  const gateway = await healthyFakeGateway();
  const saved = await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    { userId: adminId, email: admin.email },
  );
  expect(saved.ok).toBe(true);
  const readiness = await gate.evaluateGatewayReadiness();
  expect(readiness.blockingReasons).toEqual([
    "gateway_readiness_probe_missing",
    "gateway_readiness_extension_not_negotiated",
  ]);
  // The verdict still answers for the configuration it verified: rate and
  // credential stayed green, so only the retired branches are named.
  await gateway.stop();
});

test("re-verifying against the new configuration restores readiness at the new version", async () => {
  const gateway = await establishReady();
  expect((await gate.evaluateGatewayReadiness()).ready).toBe(true);
  await gateway.stop();
});

test("a probe that stops succeeding re-opens the gate, naming the probe's own status", async () => {
  const gateway = await establishReady();
  gateway.respondWith({ kind: "response", status: 401, body: "{}" });
  const { probeRun } = await runVerification();
  expect(probeRun.ready && probeRun.result.status).toBe("unauthenticated");
  expect((await gate.evaluateGatewayReadiness()).blockingReasons).toEqual([
    "gateway_readiness_probe_not_ok",
  ]);
  await gateway.stop();
});

test("an extension that disappears re-opens the gate", async () => {
  const gateway = await startFakeGateway(
    { kind: "response", status: 200, body: "{}" },
    {
      "/api/plugins": {
        kind: "response",
        status: 200,
        body: JSON.stringify({
          plugins: [{ name: "bifrost-anthropic", version: "1.2.3" }],
        }),
      },
    },
  );
  const credential = await credentialService.saveGatewayAdminCredential(
    { adminKey: ADMIN_KEY },
    { userId: adminId, email: admin.email },
  );
  expect(credential.ok).toBe(true);
  const saved = await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    { userId: adminId, email: admin.email },
  );
  expect(saved.ok).toBe(true);
  const { probeRun, negotiationRun } = await runVerification();
  expect(probeRun.ready && probeRun.result.status).toBe("ok");
  expect(negotiationRun.negotiated).toBe(true);
  expect((await gate.evaluateGatewayReadiness()).blockingReasons).toEqual([
    "gateway_readiness_extension_absent",
  ]);
  await gateway.stop();
});

test("an extension shipping an incompatible version re-opens the gate", async () => {
  const gateway = await startFakeGateway(
    { kind: "response", status: 200, body: "{}" },
    {
      "/api/plugins": {
        kind: "response",
        status: 200,
        body: JSON.stringify({
          plugins: [
            { name: CREDIT_ADMISSION_EXTENSION_NAME, version: "2.5.0" },
          ],
        }),
      },
    },
  );
  const saved = await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    { userId: adminId, email: admin.email },
  );
  expect(saved.ok).toBe(true);
  const { negotiationRun } = await runVerification();
  expect(negotiationRun.negotiated).toBe(true);
  expect((await gate.evaluateGatewayReadiness()).blockingReasons).toEqual([
    "gateway_readiness_extension_incompatible",
  ]);
  await gateway.stop();
});

test("a corrupt stored rate refuses as unavailable, and a legal save repairs it", async () => {
  const gateway = await establishReady();
  await database
    .update(enterpriseSettings)
    .set({
      value: { value: { numerator: "0", denominator: "1" }, rateVersion: 99 },
    })
    .where(eq(enterpriseSettings.key, "gateway_conversion_rate"));
  expect((await gate.evaluateGatewayReadiness()).blockingReasons).toEqual([
    "gateway_readiness_rate_unavailable",
  ]);
  const repaired = await rateStore.save(
    { numerator: "100", denominator: "1" },
    admin.email,
  );
  expect(repaired.ok).toBe(true);
  expect((await gate.evaluateGatewayReadiness()).ready).toBe(true);
  await gateway.stop();
});

test("a credential that stops resolving re-opens the gate", async () => {
  const gateway = await establishReady();
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_ADMIN_CREDENTIAL_KEY));
  expect((await gate.evaluateGatewayReadiness()).blockingReasons).toEqual([
    "gateway_readiness_credential_not_configured",
  ]);
  const restored = await credentialService.saveGatewayAdminCredential(
    { adminKey: ADMIN_KEY },
    { userId: adminId, email: admin.email },
  );
  expect(restored.ok).toBe(true);
  expect((await gate.evaluateGatewayReadiness()).ready).toBe(true);
  await gateway.stop();
});

test("a refusal echoing a 401 carries no upstream bytes and no address", async () => {
  const marker = upstreamSecretMarker();
  const gateway = await startFakeGateway(
    {
      kind: "response",
      status: 401,
      body: JSON.stringify({ error: marker.secret }),
    },
    {
      "/api/plugins": {
        kind: "response",
        status: 401,
        body: JSON.stringify({ error: marker.secret }),
      },
    },
  );
  const credential = await credentialService.saveGatewayAdminCredential(
    { adminKey: ADMIN_KEY },
    { userId: adminId, email: admin.email },
  );
  expect(credential.ok).toBe(true);
  const saved = await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    { userId: adminId, email: admin.email },
  );
  expect(saved.ok).toBe(true);
  await runVerification();
  let caught: unknown;
  try {
    await gate.assertGatewayReadyForBilling();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GatewayNotReadyError);
  const refusal = caught as GatewayNotReadyError;
  const rendered = refusal.message + JSON.stringify(refusal.readiness);
  for (const variant of [marker.secret, ...marker.variants.slice(1)]) {
    expect(rendered).not.toContain(variant);
  }
  expect(rendered).not.toContain(gateway.baseUrl);
  expect(rendered).not.toContain(ADMIN_KEY);
  await gateway.stop();
});

test("the app wiring installs the gate, which refuses fail-closed with nothing configured", async () => {
  const app = createApp(loadConfig(testEnvironment({})));
  expect(app).toBeDefined();
  const installed = gatewayReadinessControls();
  expect(installed).toBeDefined();
  const readiness = await installed?.evaluateGatewayReadiness();
  // A test app installs no enterprise controls, so every condition answers
  // fail-closed: the gate exists and refuses, rather than passing anything.
  expect(readiness?.ready).toBe(false);
  expect(readiness?.blockingReasons).toEqual([
    "gateway_readiness_endpoint_not_configured",
    "gateway_readiness_credential_not_configured",
    "gateway_readiness_probe_missing",
    "gateway_readiness_extension_not_negotiated",
    "gateway_readiness_rate_not_configured",
  ]);
  let caught: unknown;
  try {
    await assertGatewayReadyForBilling();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GatewayNotReadyError);
});
