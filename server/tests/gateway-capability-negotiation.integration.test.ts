import { afterAll, expect, test } from "../../tests/support/e2e-compat";
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
import {
  CREDIT_ADMISSION_EXTENSION_NAME,
  createEnterpriseGatewayNegotiationStore,
  createGatewayCapabilityNegotiationService,
  GATEWAY_EXTENSIONS_MANAGEMENT_PATH,
  GATEWAY_NEGOTIATION_RESULT_KEY,
  type GatewayCapabilityNegotiation,
} from "../src/gateway/capability-negotiation";
import { createConversionRateStore } from "../src/gateway/conversion-rate-store";
import { createGatewayEndpointService } from "../src/gateway/endpoint-config";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { startFakeGateway, upstreamSecretMarker } from "./support/fake-gateway";

/*
 * Bifrost 01.6 — the capability negotiation against a real PostgreSQL, on
 * TEST_DATABASE_URL (tests/support/database.ts refuses the live database).
 * What only the database can prove: a completed negotiation survives a
 * restart (a fresh service over the same rows), the AC05 refusal path —
 * healthy 200 but no extension — is a persisted `absent` verdict a gate can
 * read, a configuration save retires the stored verdict (AC04) without
 * deleting it, and a negotiation that did not complete persists nothing and
 * damages no saved configuration.
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
const adminId = `gateway-negotiation-admin-${runId}`;
const admin = { userId: adminId, email: `admin-${runId}@openbot.test` };
const ADMIN_KEY = `negotiation-integration-admin-key-${runId}`;

const COMPATIBLE_MANIFEST = JSON.stringify({
  plugins: [
    { name: "bifrost-anthropic", version: "1.2.3" },
    { name: CREDIT_ADMISSION_EXTENSION_NAME, version: "1.4.2" },
  ],
});
const MANIFEST_WITHOUT_EXTENSION = JSON.stringify({
  plugins: [{ name: "bifrost-anthropic", version: "1.2.3" }],
});

function negotiationService() {
  const endpoint = createGatewayEndpointService({ store: enterpriseStore });
  const credential = createGatewayAdminCredentialService({
    database,
    encryptionKey,
    member: (userId) => enterpriseStore.member(userId),
  });
  return createGatewayCapabilityNegotiationService({
    store: createEnterpriseGatewayNegotiationStore(database),
    readGatewayEndpoint: () => endpoint.readGatewayEndpoint(),
    resolveGatewayAdminCredential: () =>
      credential.resolveGatewayAdminCredential(),
    log: capturedLog,
  });
}

function currentEndpointVersion(): Promise<number | undefined> {
  return enterpriseStore
    .readGatewayEndpointRow()
    .then((row) =>
      row.state === "configured" ? row.config.configVersion : undefined,
    );
}

async function storedNegotiationRow(): Promise<unknown> {
  const [row] = await database
    .select({ value: enterpriseSettings.value })
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_NEGOTIATION_RESULT_KEY))
    .limit(1);
  return row?.value;
}

async function rateRowSnapshot() {
  const rows = await database
    .select({ value: enterpriseSettings.value })
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, "gateway_conversion_rate"));
  return rows[0]?.value;
}

async function startNegotiationGateway(manifestBody: string) {
  return startFakeGateway(
    {
      kind: "response",
      status: 200,
      body: '{"authConfig":{"admin":{"exists":true}}}',
    },
    {
      [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: {
        kind: "response",
        status: 200,
        body: manifestBody,
      },
    },
  );
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
    .where(eq(enterpriseSettings.key, GATEWAY_NEGOTIATION_RESULT_KEY));
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, "gateway_conversion_rate"));
  await database
    .delete(credentials)
    .where(eq(credentials.kind, "gateway_admin"));
  await database.delete(users).where(eq(users.id, adminId));
  await database.$client.close();
});

test("setup: the administrator, a conversion rate, and a clean negotiation row", async () => {
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_NEGOTIATION_RESULT_KEY));
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

test("a healthy gateway with a compatible extension persists present, and a restart reads it", async () => {
  const gateway = await startNegotiationGateway(COMPATIBLE_MANIFEST);
  await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    admin,
  );
  await credentialService.saveGatewayAdminCredential(
    { adminKey: ADMIN_KEY },
    admin,
  );

  const run = await negotiationService().negotiateGatewayCapabilities();
  expect(run.negotiated).toBe(true);
  if (!run.negotiated) throw new Error("expected a negotiation, got a refusal");
  expect(run.negotiation.creditAdmissionExtension).toBe("present");
  expect(run.negotiation.extensionVersion).toBe("1.4.2");
  expect(run.negotiation.configVersion).toBe(await currentEndpointVersion());

  // A fresh service over the same rows — the restart a gate lives through.
  const reopened = await negotiationService().readLastGatewayNegotiation();
  expect(reopened).toEqual(run.negotiation);

  // Both hops carried the credential.
  expect(
    gateway.requests.every(
      (request) => request.authorization === `Bearer ${ADMIN_KEY}`,
    ),
  ).toBe(true);
  await gateway.stop();
});

test("a healthy gateway without the extension persists absent — healthy is not ready (AC05)", async () => {
  const gateway = await startNegotiationGateway(MANIFEST_WITHOUT_EXTENSION);
  await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    admin,
  );

  const run = await negotiationService().negotiateGatewayCapabilities();
  await gateway.stop();
  expect(run.negotiated).toBe(true);
  if (!run.negotiated) throw new Error("expected a negotiation, got a refusal");
  expect(run.negotiation.creditAdmissionExtension).toBe("absent");
  expect(run.negotiation.reasonCode).toBe(
    "gateway_capability_extension_absent",
  );

  // The refusal path is a real, persisted verdict a downstream gate reads.
  const last = await negotiationService().readLastGatewayNegotiation();
  expect(last?.creditAdmissionExtension).toBe("absent");
  const raw = await storedNegotiationRow();
  expect((raw as GatewayCapabilityNegotiation).creditAdmissionExtension).toBe(
    "absent",
  );
});

test("a configuration save retires the stored verdict without deleting it (AC04)", async () => {
  const versionBefore = await currentEndpointVersion();
  const before = await negotiationService().readLastGatewayNegotiation();
  expect(before).toBeDefined();
  expect(before?.configVersion).toBe(versionBefore);

  // A save bumps the configVersion: the stored verdict is now about a past revision.
  const gateway = await startNegotiationGateway(COMPATIBLE_MANIFEST);
  await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    admin,
  );
  const versionAfter = await currentEndpointVersion();
  expect(versionAfter).toBe((versionBefore ?? 0) + 1);

  expect(
    await negotiationService().readLastGatewayNegotiation(),
  ).toBeUndefined();
  // Invalidated, not deleted: the history stays on file.
  const raw = await storedNegotiationRow();
  expect((raw as GatewayCapabilityNegotiation).configVersion).toBe(
    versionBefore,
  );

  // The next negotiation completes against the new revision and answers again.
  const run = await negotiationService().negotiateGatewayCapabilities();
  await gateway.stop();
  expect(run.negotiated).toBe(true);
  if (!run.negotiated) throw new Error("expected a negotiation, got a refusal");
  expect(run.negotiation.configVersion).toBe(versionAfter);
  expect(
    (await negotiationService().readLastGatewayNegotiation())?.configVersion,
  ).toBe(versionAfter);
});

test("an older completion never overwrites a newer persisted negotiation", async () => {
  const store = createEnterpriseGatewayNegotiationStore(database);
  const newer: GatewayCapabilityNegotiation = {
    creditAdmissionExtension: "present",
    extensionVersion: "1.4.2",
    reasonCode: "gateway_capability_extension_present",
    supportedRange: null,
    checkedAt: new Date(Date.now() + 3_600_000).toISOString(),
    configVersion: 3,
  };
  const older: GatewayCapabilityNegotiation = {
    ...newer,
    checkedAt: new Date(Date.now() - 3_600_000).toISOString(),
    configVersion: 2,
  };
  await store.saveGatewayNegotiationResult(newer);
  await store.saveGatewayNegotiationResult(older);
  expect((await store.readGatewayNegotiationResult())?.checkedAt).toBe(
    newer.checkedAt,
  );
});

test("a damaged persisted row reads as absent, and the next negotiation repairs it", async () => {
  await database
    .insert(enterpriseSettings)
    .values({
      key: GATEWAY_NEGOTIATION_RESULT_KEY,
      value: { creditAdmissionExtension: "fine" },
      updatedBy: "tamper-test",
    })
    .onConflictDoUpdate({
      target: enterpriseSettings.key,
      set: { value: { creditAdmissionExtension: "fine" } },
    });
  expect(
    await negotiationService().readLastGatewayNegotiation(),
  ).toBeUndefined();

  const gateway = await startNegotiationGateway(COMPATIBLE_MANIFEST);
  await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    admin,
  );
  const run = await negotiationService().negotiateGatewayCapabilities();
  await gateway.stop();
  expect(run.negotiated).toBe(true);
  const last = await negotiationService().readLastGatewayNegotiation();
  expect(last?.creditAdmissionExtension).toBe("present");
});

test("a manifest refusal persists nothing and leaves the saved configuration untouched", async () => {
  const marker = upstreamSecretMarker();
  const beforeRate = await rateRowSnapshot();
  expect(beforeRate).toBeDefined();
  // The raw stored verdict, before anything this test does — a failed
  // negotiation must leave exactly this row on file (readLast answers
  // undefined after the save below, which is AC04, not this test's subject).
  const beforeStoredRaw = JSON.stringify(await storedNegotiationRow());

  const gateway = await startFakeGateway(
    {
      kind: "response",
      status: 200,
      body: '{"authConfig":{"admin":{"exists":true}}}',
    },
    {
      [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: {
        kind: "response",
        status: 401,
        body: JSON.stringify({
          error: `denied: ${marker.secret}`,
          detail: marker.secret,
        }),
        headers: { "x-bf-trace": marker.secret },
      },
    },
  );
  await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    admin,
  );
  const versionAfterSave = await currentEndpointVersion();

  const run = await negotiationService().negotiateGatewayCapabilities();
  await gateway.stop();

  expect(run).toEqual({
    negotiated: false,
    reasonCode: "gateway_negotiation_manifest_unauthorized",
  });
  // The stored negotiation row is exactly the one from before — nothing new persisted.
  expect(JSON.stringify(await storedNegotiationRow())).toBe(beforeStoredRaw);
  // The failed negotiation changed no saved configuration: the endpoint save
  // before it did, so compare against the post-save state.
  expect(await currentEndpointVersion()).toBe(versionAfterSave);
  expect(await rateRowSnapshot()).toEqual(beforeRate);

  // No upstream bytes in any persisted row or log line.
  const settingsRows = await database
    .select({ value: enterpriseSettings.value })
    .from(enterpriseSettings);
  const credentialRows = await database
    .select({ encryptedValue: credentials.encryptedValue })
    .from(credentials)
    .where(eq(credentials.kind, "gateway_admin"));
  for (const content of [
    JSON.stringify(settingsRows),
    JSON.stringify(credentialRows),
    logLines.join("\n"),
  ]) {
    for (const variant of marker.variants) {
      expect(content).not.toContain(variant);
    }
  }
});

test("the log never carries the gateway address or the credential", async () => {
  const rendered = logLines.join("\n");
  expect(rendered).not.toContain(ADMIN_KEY);
  for (const line of logLines) {
    expect(line).not.toMatch(/127\.0\.0\.1:\d+/);
  }
  expect(rendered.length).toBeGreaterThan(0);
});
