import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, like } from "drizzle-orm";
import pino from "pino";
import { createEnterpriseStore } from "../src/admin/settings-store";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  enterpriseSettings,
  auditEvents,
  userRoles,
  users,
} from "../src/db/schema";
import {
  adminKeyFingerprint,
  createGatewayAdminCredentialService,
  GATEWAY_ADMIN_CREDENTIAL_KEY,
  GatewayAdminCredentialNotConfiguredError,
  GatewayAdminCredentialStaleError,
} from "../src/gateway/admin-credential";
import { gatewayAdminCredentialRoutes } from "../src/gateway/admin-credential-routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost 01.2 (#208) against the real PostgreSQL of the dedicated test database: the credential is
 * encrypted at rest, every read path an administrator or a log can reach answers only the redacted
 * status, a rotation strictly increments configVersion and rejects the references built on the one
 * before, and a deployment that never configured a credential says so plainly.
 */

const KEY_ONE = "bifrost-admin-key-one-7f3a9c2e";
const KEY_TWO = "bifrost-admin-key-two-c41d8823";
const KEY_THREE = "bifrost-admin-key-three-55b0e9aa";

/** The plaintext and every encoding a log line might plausibly carry it in. */
function leakVariants(key: string): string[] {
  return [
    key,
    Buffer.from(key).toString("base64"),
    Buffer.from(key).toString("base64url"),
    Buffer.from(key).toString("hex"),
  ];
}

/** The content must not contain the key, nor any encoding a log or JSON line might carry it in. */
export function expectClean(text: string, keys: string[], where: string) {
  for (const key of keys) {
    for (const variant of leakVariants(key)) {
      if (text.includes(variant)) {
        throw new Error(
          `${where} leaked key material: ${JSON.stringify(variant)}`,
        );
      }
    }
  }
}

const encryptionKey = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32)),
).toString("base64");
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const enterpriseStore = createEnterpriseStore(database);
const auditStore = createAuditStore(database);

const logLines: string[] = [];
const capturedLog = pino({ level: "trace" }, {
  write(chunk: string) {
    logLines.push(chunk);
  },
} as pino.DestinationStream);

const service = createGatewayAdminCredentialService({
  database,
  encryptionKey,
  member: (userId) => enterpriseStore.member(userId),
  auditStore,
  log: capturedLog,
});

const runId = randomUUID().slice(0, 8);
const adminId = `gateway-cred-admin-${runId}`;
const memberId = `gateway-cred-member-${runId}`;
const admin = { userId: adminId, email: `admin-${runId}@openbot.test` };
const member = { userId: memberId, email: `member-${runId}@openbot.test` };

/** Live (non-revoked) gateway admin credential rows. History rows are excluded. */
function liveCredentialRows() {
  return database
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.kind, "gateway_admin"),
        eq(credentials.provider, "bifrost"),
        eq(credentials.keyId, "admin"),
        isNull(credentials.revokedAt),
      ),
    );
}

function refRow() {
  return database
    .select({ value: enterpriseSettings.value })
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_ADMIN_CREDENTIAL_KEY));
}

async function cleanSlate() {
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_ADMIN_CREDENTIAL_KEY));
  await database
    .delete(credentials)
    .where(eq(credentials.kind, "gateway_admin"));
  // `audit_events` is append-only by trigger, so nothing here deletes rows: the audit assertions
  // below scope themselves to this run's actor id instead, which no other run shares.
}

const ADMIN_ACTOR: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: adminId,
    email: admin.email,
    role: "admin",
  } as never);
  await next();
};

test("the leak sweep detects what it exists to detect", () => {
  // A redaction assertion that cannot fail is worse than none: this pins the sweep to the four
  // encodings above, so a future key-carrying path cannot slide past it silently.
  expect(() =>
    expectClean(`token=${KEY_ONE}`, [KEY_ONE], "self-check"),
  ).toThrow(/self-check/);
  expect(() =>
    expectClean(
      `token=${Buffer.from(KEY_ONE).toString("base64")}`,
      [KEY_ONE],
      "self-check",
    ),
  ).toThrow();
  expect(() =>
    expectClean(
      `token=${Buffer.from(KEY_ONE).toString("hex")}`,
      [KEY_ONE],
      "self-check",
    ),
  ).toThrow();
  expect(() =>
    expectClean("nothing here", [KEY_ONE], "self-check"),
  ).not.toThrow();
});

const routeApp = new Hono().route(
  "/api/admin/gateway/credential",
  gatewayAdminCredentialRoutes(ADMIN_ACTOR, service),
);

beforeAll(async () => {
  await cleanSlate();
  await database
    .insert(users)
    .values([
      { id: adminId, email: admin.email },
      { id: memberId, email: member.email },
    ])
    .onConflictDoNothing();
  await database
    .insert(userRoles)
    .values([
      { userId: adminId, role: "admin" },
      { userId: memberId, role: "user" },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await cleanSlate();
  await database.delete(users).where(eq(users.id, adminId));
  await database.delete(users).where(eq(users.id, memberId));
  await database.$client.close();
});

test("a save is refused for a plain member and writes nothing", async () => {
  const refused = await service.saveGatewayAdminCredential(
    { adminKey: KEY_ONE },
    member,
  );
  expect(refused).toEqual({
    ok: false,
    status: 403,
    error: "Only an administrator may change the gateway credential.",
  });
  expect((await refRow()).length).toBe(0);
  expect((await liveCredentialRows()).length).toBe(0);
});

test("the first save stores version 1, encrypted at rest, and answers only the redacted status", async () => {
  const saved = await service.saveGatewayAdminCredential(
    { adminKey: KEY_ONE },
    admin,
  );
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  expect(saved.status.state).toBe("configured");
  expect(saved.status.configVersion).toBe(1);
  expect(Object.keys(saved.status).sort()).toEqual([
    "configVersion",
    "fingerprint",
    "state",
    "updatedAt",
  ]);
  expectClean(JSON.stringify(saved), [KEY_ONE], "save result");

  const rows = await liveCredentialRows();
  expect(rows.length).toBe(1);
  expectClean(rows[0].encryptedValue, [KEY_ONE], "encrypted_value");
  const envelope = JSON.parse(rows[0].encryptedValue) as {
    version: number;
    iv: string;
    ciphertext: string;
  };
  expect(envelope.version).toBe(1);
  expect(envelope.iv.length).toBeGreaterThan(0);
  expect(envelope.ciphertext.length).toBeGreaterThan(0);
});

test("the status read returns the redacted shape and never key material", async () => {
  const read = await service.readGatewayAdminCredential();
  expect(read.state).toBe("configured");
  if (read.state !== "configured") return;
  expect(read.configVersion).toBe(1);
  expect(read.fingerprint).toMatch(/^[0-9a-f]{4}$/);
  expectClean(JSON.stringify(read), [KEY_ONE], "status read");
});

test("the internal resolve decrypts to the saved key and binds the current ref", async () => {
  const resolved = await service.resolveGatewayAdminCredential();
  expect(resolved.adminKey).toBe(KEY_ONE);
  expect(resolved.ref.configVersion).toBe(1);
  const [row] = await liveCredentialRows();
  expect(resolved.ref.credentialId).toBe(row.id);
});

test("rotation increments configVersion, revokes the old credential, and rejects old references", async () => {
  const before = await service.resolveGatewayAdminCredential();
  const rotated = await service.saveGatewayAdminCredential(
    { adminKey: KEY_TWO },
    admin,
  );
  expect(rotated.ok).toBe(true);
  if (!rotated.ok) return;
  expect(rotated.status.configVersion).toBe(before.ref.configVersion + 1);
  expect(rotated.status.fingerprint).toBe(adminKeyFingerprint(KEY_TWO));
  expect(rotated.status.fingerprint).not.toBe(adminKeyFingerprint(KEY_ONE));
  expectClean(JSON.stringify(rotated), [KEY_ONE, KEY_TWO], "rotate result");

  const rows = await liveCredentialRows();
  expect(rows.length).toBe(1);
  expect(rows[0].id).not.toBe(before.ref.credentialId);

  const allRows = await database
    .select({ id: credentials.id, revokedAt: credentials.revokedAt })
    .from(credentials)
    .where(eq(credentials.kind, "gateway_admin"));
  expect(allRows.length).toBe(2);
  const oldRow = allRows.find((row) => row.id === before.ref.credentialId);
  expect(oldRow?.revokedAt).not.toBeNull();

  // The current reference resolves to the new key...
  const resolved = await service.resolveGatewayAdminCredential();
  expect(resolved.adminKey).toBe(KEY_TWO);
  expect(resolved.ref.configVersion).toBe(rotated.status.configVersion);

  // ...and a caller still holding the old reference is refused, not served.
  expect(
    service.resolveGatewayAdminCredential(before.ref),
  ).rejects.toBeInstanceOf(GatewayAdminCredentialStaleError);
  // A ref that names the right version but the wrong credential id is stale too.
  expect(
    service.resolveGatewayAdminCredential({
      credentialId: before.ref.credentialId,
      configVersion: rotated.status.configVersion,
    }),
  ).rejects.toBeInstanceOf(GatewayAdminCredentialStaleError);
});

test("the HTTP surface serves the same redaction: a write over HTTP is readable only as status", async () => {
  const put = await routeApp.request("/api/admin/gateway/credential", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminKey: KEY_THREE }),
  });
  expect(put.status).toBe(200);
  const body = await put.text();
  expectClean(body, [KEY_THREE], "HTTP write response");
  const status = (await JSON.parse(body)) as {
    status: { configVersion: number };
  };
  expect(status.status.configVersion).toBeGreaterThan(2);

  const get = await routeApp.request("/api/admin/gateway/credential", {
    method: "GET",
  });
  expect(get.status).toBe(200);
  const getBody = await get.text();
  expectClean(getBody, [KEY_ONE, KEY_TWO, KEY_THREE], "HTTP read response");

  // The internal entry resolves what the HTTP surface wrote, and nothing else can.
  const resolved = await service.resolveGatewayAdminCredential();
  expect(resolved.adminKey).toBe(KEY_THREE);
});

test("audit records for saves carry no key material", async () => {
  const events = await database
    .select({ eventType: auditEvents.eventType, payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        like(auditEvents.eventType, "gateway_admin_credential.%"),
        eq(auditEvents.actorUserId, adminId),
      ),
    )
    .orderBy(auditEvents.createdAt);
  expect(events.length).toBeGreaterThanOrEqual(3);
  expect(events.map((event) => event.eventType)).toContain(
    "gateway_admin_credential.saved",
  );
  expectClean(
    JSON.stringify(events),
    [KEY_ONE, KEY_TWO, KEY_THREE],
    "audit trail",
  );
});

test("concurrent saves serialize: strictly increasing versions, one live credential", async () => {
  const [first, second] = await Promise.all([
    service.saveGatewayAdminCredential(
      { adminKey: `concurrent-a-${runId}` },
      admin,
    ),
    service.saveGatewayAdminCredential(
      { adminKey: `concurrent-b-${runId}` },
      admin,
    ),
  ]);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  const versions = [
    first.status.configVersion,
    second.status.configVersion,
  ].sort((a, b) => a - b);
  expect(versions[1]).toBe(versions[0] + 1);
  expect((await liveCredentialRows()).length).toBe(1);
  const resolved = await service.resolveGatewayAdminCredential();
  expect(resolved.ref.configVersion).toBe(versions[1]);
});

test("a fresh service over the same rows (a restart) reads the same status and resolves the same key", async () => {
  const before = await service.readGatewayAdminCredential();
  const resolvedBefore = await service.resolveGatewayAdminCredential();
  const restartedDatabase = createDatabase(testDatabaseUrl(), TEST_POOL);
  const restarted = createGatewayAdminCredentialService({
    database: restartedDatabase,
    encryptionKey,
    member: (userId) => createEnterpriseStore(restartedDatabase).member(userId),
    log: capturedLog,
  });
  try {
    expect(await restarted.readGatewayAdminCredential()).toEqual(before);
    const resolved = await restarted.resolveGatewayAdminCredential();
    expect(resolved.adminKey).toBe(resolvedBefore.adminKey);
    expect(resolved.ref).toEqual(resolvedBefore.ref);
  } finally {
    await restartedDatabase.$client.close();
  }
});

test("a reference row that exists but does not validate reads as unconfigured and resolve refuses", async () => {
  await database
    .update(enterpriseSettings)
    .set({ value: { foo: "bar" } })
    .where(eq(enterpriseSettings.key, GATEWAY_ADMIN_CREDENTIAL_KEY));
  const read = await service.readGatewayAdminCredential();
  expect(read).toEqual({ state: "unconfigured" });
  expect(service.resolveGatewayAdminCredential()).rejects.toBeInstanceOf(
    GatewayAdminCredentialNotConfiguredError,
  );
});

test("a save whose stored reference names a missing credential is refused and audited without key material", async () => {
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_ADMIN_CREDENTIAL_KEY));
  await database.insert(enterpriseSettings).values({
    key: GATEWAY_ADMIN_CREDENTIAL_KEY,
    value: {
      credentialId: randomUUID(),
      configVersion: 9,
      fingerprint: "dead",
      updatedAt: new Date().toISOString(),
    },
    updatedBy: "tamper",
    updatedAt: new Date(),
  });
  const refused = await service.saveGatewayAdminCredential(
    { adminKey: `tampered-${runId}` },
    admin,
  );
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.status).toBe(404);
  expectClean(JSON.stringify(refused), [`tampered-${runId}`], "refused save");

  const refusalEvents = await database
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "gateway_admin_credential.save_refused"),
        eq(auditEvents.actorUserId, adminId),
      ),
    );
  expect(refusalEvents.length).toBeGreaterThan(0);
  expectClean(
    JSON.stringify(refusalEvents),
    [`tampered-${runId}`],
    "refusal audit",
  );
});

test("with the reference row gone but a live credential present, the next save rotates it and numbering restarts clean", async () => {
  const liveBefore = await liveCredentialRows();
  expect(liveBefore.length).toBe(1);
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_ADMIN_CREDENTIAL_KEY));

  const saved = await service.saveGatewayAdminCredential(
    { adminKey: `recovered-${runId}` },
    admin,
  );
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  expect(saved.status.configVersion).toBe(1);
  expect((await liveCredentialRows()).length).toBe(1);
  expect((await liveCredentialRows())[0].id).not.toBe(liveBefore[0].id);
});

test("with nothing configured, the status says unconfigured and resolve refuses", async () => {
  await cleanSlate();
  expect(await service.readGatewayAdminCredential()).toEqual({
    state: "unconfigured",
  });
  const response = await routeApp.request("/api/admin/gateway/credential", {
    method: "GET",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: { state: "unconfigured" } });
  expect(service.resolveGatewayAdminCredential()).rejects.toBeInstanceOf(
    GatewayAdminCredentialNotConfiguredError,
  );
});

test("application logs — including the damage warnings — carry no key material", async () => {
  // The success path logs nothing at all (that is the point), so the redaction assertion needs a
  // path that does log: a reference row that exists but does not validate warns on both the read
  // and the resolve. Everything the module has written so far — every level — is then swept for
  // the key and its encodings.
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_ADMIN_CREDENTIAL_KEY));
  await database.insert(enterpriseSettings).values({
    key: GATEWAY_ADMIN_CREDENTIAL_KEY,
    value: { foo: "bar" },
    updatedBy: "tamper",
    updatedAt: new Date(),
  });
  expect(await service.readGatewayAdminCredential()).toEqual({
    state: "unconfigured",
  });
  expect(service.resolveGatewayAdminCredential()).rejects.toBeInstanceOf(
    GatewayAdminCredentialNotConfiguredError,
  );

  expect(logLines.length).toBeGreaterThan(0);
  expectClean(
    logLines.join("\n"),
    [KEY_ONE, KEY_TWO, KEY_THREE],
    "application log",
  );
});
