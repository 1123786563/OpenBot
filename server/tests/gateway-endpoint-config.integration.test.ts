import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createEnterpriseStore,
  GATEWAY_ENDPOINT_KEY,
} from "../src/admin/settings-store";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings, userRoles, users } from "../src/db/schema";
import {
  createGatewayEndpointService,
  type GatewayEndpointConfig,
} from "../src/gateway/endpoint-config";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The gateway endpoint configuration against a real PostgreSQL, gated on TEST_DATABASE_URL the way
 * the rest of the integration suite is (tests/support/database.ts refuses the live `openbot`
 * database). What only the database can prove: a save survives a restart (a fresh store over the
 * same rows), the configVersion strictly increases across saves, saves serialize — including the
 * first one on an empty table, where a row lock locks nothing — and the writer's role is read from
 * the same `user_roles` table `requireAdmin` consults.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createEnterpriseStore(database);
const service = createGatewayEndpointService({ store });

const runId = randomUUID().slice(0, 8);
const adminId = `gateway-admin-${runId}`;
const memberId = `gateway-member-${runId}`;
const admin = { userId: adminId, email: `admin-${runId}@openbot.test` };
const member = { userId: memberId, email: `member-${runId}@openbot.test` };

/** The stored configuration, or undefined for absent and corrupted alike. */
function currentRow(): Promise<GatewayEndpointConfig | undefined> {
  return store
    .readGatewayEndpointRow()
    .then((row) => (row.state === "configured" ? row.config : undefined));
}

afterAll(async () => {
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_ENDPOINT_KEY));
  await database.delete(users).where(eq(users.id, adminId));
  await database.delete(users).where(eq(users.id, memberId));
  await database.$client.close();
});

test("setup: a clean row and the actors, one administrator and one plain member", async () => {
  // The version assertions below are absolute on a clean table, so the row is removed first: a
  // leftover from a failed earlier run (afterAll never ran) must not fail this one.
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_ENDPOINT_KEY));
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

test("a save is refused for a member and writes nothing", async () => {
  const before = await currentRow();
  const result = await service.saveGatewayEndpoint(
    { baseUrl: "http://member-gateway:8090" },
    member,
  );
  expect(result).toMatchObject({ ok: false, status: 403 });
  expect(await currentRow()).toEqual(before);
});

test("an administrator's first save stores version 1 and survives a restart", async () => {
  const saved = await service.saveGatewayEndpoint(
    { baseUrl: "http://gateway-a:8090", requestTimeoutMs: 2500 },
    admin,
  );
  expect(saved).toEqual({
    ok: true,
    config: {
      baseUrl: "http://gateway-a:8090",
      requestTimeoutMs: 2500,
      configVersion: 1,
    },
  });

  // A restart is a new store over the same rows: the address and the version both come back.
  const restartedDb = createDatabase(testDatabaseUrl(), TEST_POOL);
  const restarted = createEnterpriseStore(restartedDb);
  try {
    expect(await restarted.readGatewayEndpointRow()).toEqual({
      state: "configured",
      config: {
        baseUrl: "http://gateway-a:8090",
        requestTimeoutMs: 2500,
        configVersion: 1,
      },
    });
  } finally {
    await restartedDb.$client.close();
  }
});

test("consecutive saves strictly increase the version", async () => {
  const first = await service.saveGatewayEndpoint(
    { baseUrl: "http://gateway-b:8090" },
    admin,
  );
  const second = await service.saveGatewayEndpoint(
    { baseUrl: "http://gateway-c:8090" },
    admin,
  );
  expect(first.ok && second.ok).toBe(true);
  if (first.ok && second.ok) {
    expect(second.config.configVersion).toBeGreaterThan(
      first.config.configVersion,
    );
    expect((await currentRow())?.baseUrl).toBe("http://gateway-c:8090");
  }
});

test("a save that names a configVersion is refused: versions are server-assigned", async () => {
  const before = await currentRow();
  const result = await service.saveGatewayEndpoint(
    { baseUrl: "http://gateway-old:8090", configVersion: 1 },
    admin,
  );
  expect(result).toMatchObject({ ok: false, status: 400 });
  expect(await currentRow()).toEqual(before);
});

test("concurrent saves serialize: each gets its own version, none is lost", async () => {
  const start = (await currentRow())?.configVersion ?? 0;
  const parallel = await Promise.all(
    ["http://gateway-x:8090", "http://gateway-y:8090"].map((baseUrl) =>
      service.saveGatewayEndpoint({ baseUrl }, admin),
    ),
  );
  const versions = parallel
    .filter((result) => result.ok)
    .map((result) => (result.ok ? result.config.configVersion : 0));
  expect(versions.length).toBe(2);
  expect(new Set(versions).size).toBe(2);
  expect((await currentRow())?.configVersion ?? 0).toBe(start + 2);
});

test("concurrent FIRST saves on an empty table get distinct consecutive versions", async () => {
  // The race review F1 reproduced: with no row to lock, two simultaneous first saves both read
  // "nothing" and both computed version 1. The advisory lock taken before the read closes that
  // window, so even the very first pair serializes into 1 and 2.
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, GATEWAY_ENDPOINT_KEY));
  const parallel = await Promise.all(
    ["http://gateway-first-a:8090", "http://gateway-first-b:8090"].map(
      (baseUrl) => service.saveGatewayEndpoint({ baseUrl }, admin),
    ),
  );
  const versions = parallel
    .filter((result) => result.ok)
    .map((result) => (result.ok ? result.config.configVersion : 0))
    .sort((a, b) => a - b);
  expect(versions).toEqual([1, 2]);
  expect((await currentRow())?.configVersion).toBe(2);
});

test("the stored row announces itself on the settings topic, like every other setting", async () => {
  let notified = false;
  const listener = await database.$client.listen(
    "enterprise_settings_changed",
    () => {
      notified = true;
    },
  );
  try {
    await service.saveGatewayEndpoint(
      { baseUrl: "http://gateway-notify:8090" },
      admin,
    );
    for (let i = 0; i < 40 && !notified; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(notified).toBe(true);
  } finally {
    await listener.unlisten();
  }
});

test("the read carries no credential field", async () => {
  const read = await service.readGatewayEndpoint();
  expect(Object.keys(read as object).sort()).toEqual([
    "baseUrl",
    "configVersion",
    "requestTimeoutMs",
  ]);
});

test("a malformed stored row reads as unconfigured, and the next version never goes backwards", async () => {
  const tampered = {
    value: { baseUrl: "not a url at all", configVersion: 40 },
  };
  await database
    .insert(enterpriseSettings)
    .values({
      key: GATEWAY_ENDPOINT_KEY,
      value: tampered,
      updatedBy: "tamper-test",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: enterpriseSettings.key,
      set: { value: tampered, updatedAt: new Date() },
    });
  expect(await store.readGatewayEndpointRow()).toEqual({ state: "corrupted" });
  // A damaged row must not fall back to the environment's address either: a consumer that saw
  // version 40 would be handed version 0 and traffic would silently switch endpoints.
  const withEnvFallback = createGatewayEndpointService({
    store,
    envDefault: {
      baseUrl: "http://env-gateway:8090",
      requestTimeoutMs: 5000,
      configVersion: 0,
    },
  });
  expect(await withEnvFallback.readGatewayEndpoint()).toBeUndefined();
  // The broken address reads as unconfigured, but the version it carried still counts: the next
  // save is 41, so no consumer that saw version 40 can be handed a lower one.
  const repaired = await service.saveGatewayEndpoint(
    { baseUrl: "http://gateway-repaired:8090" },
    admin,
  );
  expect(repaired).toMatchObject({
    ok: true,
    config: {
      baseUrl: "http://gateway-repaired:8090",
      configVersion: 41,
    },
  });
});
