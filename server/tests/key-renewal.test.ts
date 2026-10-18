import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { payerKey } from "../src/billing/payer";
import { botServiceRoutes } from "../src/bot-services/auth";
import { createBindingOfferIssuer } from "../src/bot-services/binding-codes";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  botBindingOffers,
  botServices,
  credentials,
  creditGrants,
  creditLedger,
  creditReservations,
  gatewayCatalogSyncState,
} from "../src/db/schema";
import { gatewayCustomers, gatewayVirtualKeys } from "../src/db/schema/gateway";
import {
  createCatalogFreshnessGate,
} from "../src/gateway/catalog-freshness";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import {
  createGatewayCustomerProvisioner,
  type GatewayCustomerProvisioner,
} from "../src/gateway/customer";
import {
  createGatewayKeyIssuer,
  createGatewayVirtualKeyClient,
  createKeyIssuanceRoutes,
} from "../src/gateway/key-issuance";
import {
  createGatewayKeyRenewalService,
  createGatewayVirtualKeyDeactivationClient,
} from "../src/gateway/key-renewal";
import {
  GatewayNotReadyError,
  type GatewayReadiness,
  type GatewayReadinessService,
} from "../src/gateway/readiness";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost 05.6 (#247): renewal re-verification and account state. Renewal is NOT a time
 * extension: every renewal re-runs the whole verdict — the grant is still active (04.5's
 * seam), the account mapping and the readiness gate still hold (05.1 + 01.7), the models are
 * still open (03.7/03.8's selectable set), and the catalog evidence is still fresh (03.6) —
 * and only then mints the next credentialVersion, deactivating every previous version per
 * 05.7's rule (gateway-side disable, local `revoked`). Accounting is untouched by
 * construction: no credit grant, no ledger row, no reservation, no new authorization.
 *
 * The integration runs on a real PostgreSQL against a fake Bifrost management surface
 * (customers create/lookup, virtual-keys create and update). The freshness verdict is the
 * REAL 03.6 gate over a real `gateway_catalog_sync_state` row, not a mock.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = randomUUID().slice(0, 8);

/** A fresh deployment key per run: ciphertext from an earlier run must not verify. */
const encryptionKey = randomBytes(32).toString("base64");
const auditStore = createAuditStore(database);
const credentialStore = createCredentialStore(database);
const registry = createBotServiceRegistry(database, {
  encryptionKey,
  credentialStore,
  auditStore,
});

/** The fake Bifrost this file integrates against: customers + virtual-keys create/update. */
const fake = startFakeBifrost();

const endpoint = {
  baseUrl: `http://127.0.0.1:${fake.server.port}`,
  requestTimeoutMs: 2_000,
  configVersion: 1,
};

/** The test's clock: every term in this file is measured on it, moved only by hand. */
let clockNow = new Date("2026-10-18T00:00:00.000Z");
const testClock = { now: () => clockNow };

/** A gate that passes, the way 01.7's installed service answers on a ready deployment. */
function readyGate(): GatewayReadinessService {
  const readiness: GatewayReadiness = {
    ready: true,
    blockingReasons: [],
    configVersion: endpoint.configVersion,
    checkedAt: clockNow.toISOString(),
  };
  return {
    evaluateGatewayReadiness: async () => readiness,
    assertGatewayReadyForBilling: async () => readiness,
  };
}

/** A gate that refuses, the way 01.7's service answers when a condition is unmet. */
function refusingGate(): GatewayReadinessService {
  const readiness: GatewayReadiness = {
    ready: false,
    blockingReasons: ["gateway_readiness_probe_missing"],
    configVersion: endpoint.configVersion,
    checkedAt: clockNow.toISOString(),
  };
  return {
    evaluateGatewayReadiness: async () => readiness,
    assertGatewayReadyForBilling: async () => {
      throw new GatewayNotReadyError(readiness, [
        {
          reason: "gateway_readiness_probe_missing",
          message: "No successful probe is on file (test gate).",
        },
      ]);
    },
  };
}

/** The 05.1 provisioner seam, pointed at the fake Bifrost. */
function provisionerFor(gate: GatewayReadinessService = readyGate()) {
  return createGatewayCustomerProvisioner({
    database,
    readGatewayEndpoint: async () => endpoint,
    resolveGatewayAdminCredential: async () => ({ adminKey: "test-admin-key" }),
    gate,
  });
}

/** The REAL 03.6 freshness gate over the test database and the test clock. */
function freshnessGate() {
  return createCatalogFreshnessGate({ database, now: testClock.now });
}

/** The 05.3 issuer seam (a renewal follows a claim), pointed at the fake Bifrost. */
function issuerFor(overrides?: {
  gate?: GatewayReadinessService;
  provisionCustomer?: GatewayCustomerProvisioner["provisionCustomer"];
}) {
  return createGatewayKeyIssuer({
    database,
    resolveForBot: registry.modelAccess.resolveForBot,
    provisionCustomer:
      overrides?.provisionCustomer ??
      provisionerFor(overrides?.gate).provisionCustomer,
    client: createGatewayVirtualKeyClient({
      readGatewayEndpoint: async () => endpoint,
      resolveGatewayAdminCredential: async () => ({
        adminKey: "test-admin-key",
      }),
    }),
    keyTtlMinutes: 15,
    now: testClock.now,
  });
}

/** The renewal service under test: real verdict seams, real adapters, fake gateway. */
function renewalFor(overrides?: {
  gate?: GatewayReadinessService;
  provisionCustomer?: GatewayCustomerProvisioner["provisionCustomer"];
  selectable?: { provider: string; model: string; capability: string }[];
}) {
  const selectable = overrides?.selectable ?? [
    { provider: "fake-provider", model: "renewal-chat", capability: "chat" },
  ];
  return createGatewayKeyRenewalService({
    database,
    resolveForBot: registry.modelAccess.resolveForBot,
    provisionCustomer:
      overrides?.provisionCustomer ??
      provisionerFor(overrides?.gate).provisionCustomer,
    listSelectableModels: async () => selectable,
    assertCatalogFresh: (modelRef, now) =>
      freshnessGate().assertCatalogFresh(modelRef, now),
    createClient: createGatewayVirtualKeyClient({
      readGatewayEndpoint: async () => endpoint,
      resolveGatewayAdminCredential: async () => ({
        adminKey: "test-admin-key",
      }),
    }),
    deactivationClient: createGatewayVirtualKeyDeactivationClient({
      readGatewayEndpoint: async () => endpoint,
      resolveGatewayAdminCredential: async () => ({
        adminKey: "test-admin-key",
      }),
    }),
    keyTtlMinutes: 15,
    now: testClock.now,
    auditStore,
  });
}

/** The Bot's selectable refs a composition hands to the bundle and the renewal alike. */
function selectableFor(overrides?: Parameters<typeof renewalFor>[0]) {
  return (
    overrides?.selectable ?? [
      { provider: "fake-provider", model: "renewal-chat", capability: "chat" },
    ]
  );
}

/** The bot-facing app under test: the real 04.2 door with claim + renew mounted. */
function appFor(overrides?: Parameters<typeof renewalFor>[0]) {
  return botServiceRoutes({
    authenticate: registry.authenticate,
    keys: createKeyIssuanceRoutes({
      issue: issuerFor(overrides).issueKeyForGrant,
      renew: renewalFor(overrides).renewKeyForGrant,
      bundle: {
        readGatewayEndpoint: async () => endpoint,
        listSelectableModels: async () => selectableFor(overrides),
      },
    }),
  });
}

/** A renew request through the route: the bot's credential names the caller. */
function renewKey(
  app: ReturnType<typeof botServiceRoutes>,
  secret: string,
  grantId: unknown,
) {
  return app.request("/keys/renew", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ grantId }),
  });
}

/** The full claim→row read for one grant, ordered by version. */
async function keyRowsFor(grantId: string) {
  return database
    .select()
    .from(gatewayVirtualKeys)
    .where(eq(gatewayVirtualKeys.grantId, grantId))
    .orderBy(gatewayVirtualKeys.credentialVersion);
}

const prefix = `b5-247-${run}`;

/**
 * Move the test clock and keep the catalog evidence fresh at it — what production's 5-minute
 * sync cadence guarantees anyway (sync faster than the freshness cap). The renewal's
 * freshness verdict reads this row live.
 */
async function advanceClock(ms: number) {
  clockNow = new Date(clockNow.getTime() + ms);
  const syncedAt = new Date(clockNow.getTime() - 60_000);
  await database
    .insert(gatewayCatalogSyncState)
    .values({
      id: GATEWAY_CATALOG_SYNC_STATE_ID,
      lastSuccessfulSyncAt: syncedAt,
      consecutiveFailures: 0,
      lastAttemptAt: syncedAt,
      lastAttemptStatus: "ok",
    })
    .onConflictDoUpdate({
      target: gatewayCatalogSyncState.id,
      set: {
        lastSuccessfulSyncAt: syncedAt,
        consecutiveFailures: 0,
        lastFailureReasonCode: null,
        lastFailureAt: null,
        lastAttemptAt: syncedAt,
        lastAttemptStatus: "ok",
        updatedAt: new Date(),
      },
    });
}

afterAll(async () => {
  // Children before parents; audit rows stay (append-only by design, ids are per-run).
  await database
    .delete(gatewayVirtualKeys)
    .where(like(gatewayVirtualKeys.botId, `${prefix}%`));
  await database
    .delete(gatewayCustomers)
    .where(like(gatewayCustomers.payerId, `${prefix}%`));
  await database
    .delete(accessGrants)
    .where(like(accessGrants.userId, `${prefix}%`));
  await database
    .delete(botBindingOffers)
    .where(like(botBindingOffers.botId, `${prefix}%`));
  await database
    .delete(credentials)
    .where(like(credentials.keyId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database
    .delete(gatewayCatalogSyncState)
    .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID));
  await database.$client.close();
  fake.stop();
});

/** A registered, credentialed bot under this file's prefix. */
async function credentialedBot(suffix: string) {
  const botId = `${prefix}-${suffix}`;
  await registry.register({
    botId,
    displayName: `Renewal Bot ${suffix}`,
    kind: "external",
    capabilities: ["chat"],
  });
  const issued = await registry.credentials.issue(botId);
  return { botId, secret: issued.secret };
}

const offerIssuer = createBindingOfferIssuer({ database, auditStore });

/** One confirmed grant via the real 04.5 flow: issue a code at the bot, confirm as the user.
 * The catalog evidence is made fresh at the current test clock — production's sync cadence
 * keeps it that way, and the renewal's freshness verdict reads it live. */
async function confirmGrant(userId: string, botId: string, identity: string) {
  await advanceClock(0);
  const offer = await offerIssuer.issue(
    { botId, status: "active" },
    { externalIdentityHint: identity },
  );
  const { grant } = await registry.modelAccess.confirm(
    userId,
    offer.bindingCode,
  );
  return grant;
}

describe("05.6 key renewal re-validation", () => {
  test("renewal succeeds while the grant is valid: new credentialVersion, complete bundle, old version revoked", async () => {
    const app = appFor();
    const bot = await credentialedBot("renew");
    const userId = `${prefix}-renew-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    const claim = await app.request("/keys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bot.secret}`,
      },
      body: JSON.stringify({ grantId: grant.grantId }),
    });
    expect(claim.status).toBe(200);
    const claimBody = (await claim.json()) as {
      key: { secret: string; credentialVersion: number; expiresAt: string };
    };

    // The clock moves: the Bot renews near the end of the first term.
    await advanceClock(14 * 60_000);
    const response = await renewKey(app, bot.secret, grant.grantId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      key: {
        secret: string;
        credentialVersion: number;
        grantId: string;
        botId: string;
        customerId: string;
        status: string;
        expiresAt: string | null;
      };
      bundle: {
        endpoint: string;
        modelRefs: { provider: string; model: string; capability: string }[];
        secret: string;
        expiresAt: string | null;
        credentialVersion: number;
      };
      supersededVersions: number[];
    };

    // A NEW version with a NEW plaintext, billing the same customer.
    expect(body.key.credentialVersion).toBe(2);
    expect(body.key.secret.startsWith("sk-bf-")).toBe(true);
    expect(body.key.secret).not.toBe(claimBody.key.secret);
    expect(body.key.grantId).toBe(grant.grantId);
    expect(body.key.botId).toBe(bot.botId);
    expect(body.supersededVersions).toEqual([1]);

    // The renewal answer carries the whole contract the claim carried (05.4's bundle),
    // naming the new version and its own term.
    expect(body.bundle.endpoint).toBe(endpoint.baseUrl);
    expect(body.bundle.modelRefs.length).toBeGreaterThan(0);
    expect(body.bundle.secret).toBe(body.key.secret);
    expect(body.bundle.credentialVersion).toBe(2);
    expect(body.bundle.expiresAt).toBe(body.key.expiresAt);
    // The term is fresh: renewedAt + TTL, strictly after the first key's expiry moment.
    expect(body.key.expiresAt).toBe(
      new Date(clockNow.getTime() + 15 * 60_000).toISOString(),
    );
    expect(Date.parse(body.key.expiresAt ?? "")).toBeGreaterThan(
      Date.parse(claimBody.key.expiresAt),
    );

    // Locally: exactly one active version — the new one; the old is revoked (05.7's
    // word for a version that may start no new request), never resurrected by the sync.
    const rows = await keyRowsFor(grant.grantId);
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => ({ version: row.credentialVersion, status: row.status })),
    ).toEqual([
      { version: 1, status: "revoked" },
      { version: 2, status: "active" },
    ]);
    expect(rows[1]!.valueHash).toBe(
      createHash("sha256").update(body.key.secret).digest("hex"),
    );

    // Remotely: the old key was deactivated (05.7's rule), the new one is live.
    expect(fake.deactivations).toHaveLength(1);
    const oldRemoteId = (
      await keyRowsFor(grant.grantId)
    )[0]!.gatewayVirtualKeyId;
    expect(fake.deactivations[0]!.id).toBe(oldRemoteId);
    expect(fake.deactivations[0]!.body.is_active).toBe(false);
    const oldRemote = fake.keyById(oldRemoteId);
    expect(oldRemote?.isActive).toBe(false);

    // The renewal is on the audit trail, naming the act — never the secret. The row is
    // found by its subject (the new key's id): audit rows are append-only across runs.
    const fingerprint = createHash("sha256")
      .update(body.key.secret)
      .digest("hex")
      .slice(-4);
    const [audit] = await database
      .select({ payload: sql<string>`payload::text` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "gateway.key_renewed"),
          eq(auditEvents.targetId, body.key.keyId),
        ),
      );
    expect(audit).toBeDefined();
    const payload = JSON.parse(audit!.payload) as {
      grantId: string;
      credentialVersion: number;
      supersededVersions: number[];
      fingerprint: string;
    };
    expect(payload.grantId).toBe(grant.grantId);
    expect(payload.credentialVersion).toBe(2);
    expect(payload.supersededVersions).toEqual([1]);
    expect(payload.fingerprint).toBe(fingerprint);
  }, 30_000);

  test("renewal after revocation is refused the uniform way, and nothing is created", async () => {
    const app = appFor();
    const botA = await credentialedBot("rev-a");
    const botB = await credentialedBot("rev-b");
    const userIdA = `${prefix}-rev-user-a`;
    const userIdB = `${prefix}-rev-user-b`;
    const grantA = await confirmGrant(userIdA, botA.botId, `slack:${userIdA}`);
    const grantB = await confirmGrant(userIdB, botB.botId, `slack:${userIdB}`);

    // Both grants hold a live first version before the refusals.
    for (const [bot, grant] of [
      [botA, grantA],
      [botB, grantB],
    ] as const) {
      const claim = await renewKey(app, bot.secret, grant.grantId);
      expect(claim.status).toBe(200);
      await claim.json();
    }
    const createsBefore = fake.calls.vkCreate;
    const deactivationsBefore = fake.calls.vkDeactivate;

    await registry.modelAccess.revokeForUser(grantB.grantId, userIdB);

    // Revoked: the uniform 403 (04.6 — state is not probeable), no new version, no
    // deactivation, nothing written.
    const revoked = await renewKey(app, botB.secret, grantB.grantId);
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toEqual({
      error: "That model access grant cannot be used.",
      code: "model_access_grant_refused",
    });

    // Cross-Bot renewal reads as the same refusal — another Bot cannot renew what it
    // was never granted.
    const crossBot = await renewKey(app, botB.secret, grantA.grantId);
    expect(crossBot.status).toBe(403);

    // An unknown grantId is the same silence.
    const unknown = await renewKey(app, botA.secret, randomUUID());
    expect(unknown.status).toBe(403);

    expect(fake.calls.vkCreate).toBe(createsBefore);
    expect(fake.calls.vkDeactivate).toBe(deactivationsBefore);
    const rowsB = await keyRowsFor(grantB.grantId);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.credentialVersion).toBe(1);
    expect(rowsB[0]!.status).toBe("active");
  }, 30_000);

  test("renewal with a not-ready gate is refused before anything is dialed or stored", async () => {
    const app = appFor({ gate: refusingGate() });
    const bot = await credentialedBot("gate");
    const userId = `${prefix}-gate-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);
    const createsBefore = fake.calls.vkCreate;
    const deactivationsBefore = fake.calls.vkDeactivate;

    const response = await renewKey(app, bot.secret, grant.grantId);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("gateway_not_ready");

    // No key row, no remote call of either kind (counters are file-global: relative).
    expect(await keyRowsFor(grant.grantId)).toHaveLength(0);
    expect(fake.calls.vkCreate).toBe(createsBefore);
    expect(fake.calls.vkDeactivate).toBe(deactivationsBefore);
  }, 30_000);

  test("renewal when the models are no longer open is refused with its reason", async () => {
    // The filter answers an empty selectable set — the administrator's scope no longer
    // offers this Bot anything (03.8 folds scope, price and freshness into this answer).
    const app = appFor({ selectable: [] });
    const bot = await credentialedBot("scope");
    const userId = `${prefix}-scope-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);
    const createsBefore = fake.calls.vkCreate;

    const response = await renewKey(app, bot.secret, grant.grantId);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("renewal_models_not_available");

    expect(await keyRowsFor(grant.grantId)).toHaveLength(0);
    expect(fake.calls.vkCreate).toBe(createsBefore);
  }, 30_000);

  test("renewal on a stale catalog is refused with the freshness verdict", async () => {
    const app = appFor();
    const bot = await credentialedBot("stale");
    const userId = `${prefix}-stale-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    // The REAL 03.6 evidence: a sync-state row whose last full success predates the
    // freshness cap. The gate reads it live; the verdict is the database's, not a mock's.
    await database
      .delete(gatewayCatalogSyncState)
      .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID));
    await database.insert(gatewayCatalogSyncState).values({
      id: GATEWAY_CATALOG_SYNC_STATE_ID,
      lastSuccessfulSyncAt: new Date(clockNow.getTime() - 60 * 60_000),
      consecutiveFailures: 0,
      lastAttemptAt: new Date(clockNow.getTime() - 60 * 60_000),
      lastAttemptStatus: "ok",
    });

    try {
      const createsBefore = fake.calls.vkCreate;
      const deactivationsBefore = fake.calls.vkDeactivate;
      const response = await renewKey(app, bot.secret, grant.grantId);
      expect(response.status).toBe(503);
      const body = (await response.json()) as {
        code: string;
        detail?: { reasonCode?: string };
      };
      expect(body.code).toBe("renewal_catalog_stale");

      expect(await keyRowsFor(grant.grantId)).toHaveLength(0);
      expect(fake.calls.vkCreate).toBe(createsBefore);
      expect(fake.calls.vkDeactivate).toBe(deactivationsBefore);
    } finally {
      await database
        .delete(gatewayCatalogSyncState)
        .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID));
    }
  }, 30_000);

  test("renewal creates no credit grant, no ledger row, no reservation and no new authorization", async () => {
    const app = appFor();
    const bot = await credentialedBot("acct");
    const userId = `${prefix}-acct-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    const first = await renewKey(app, bot.secret, grant.grantId);
    expect(first.status).toBe(200);
    await first.json();

    // Counts are scoped to THIS user's payer key (the suite shares one database); the
    // authorization count is scoped to the user.
    const payer = payerKey({ kind: "personal", id: userId });
    const countOf = async (
      table:
        | typeof creditGrants
        | typeof creditLedger
        | typeof creditReservations,
    ) => {
      const [row] = await database
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .where(eq(table.externalCustomerId, payer));
      return Number(row?.n ?? 0);
    };
    const grantsBefore = await countOf(creditGrants);
    const ledgerBefore = await countOf(creditLedger);
    const reservationsBefore = await countOf(creditReservations);
    const [userGrantsBefore] = await database
      .select({ n: sql<number>`count(*)` })
      .from(accessGrants)
      .where(eq(accessGrants.userId, userId));

    await advanceClock(10 * 60_000);
    const response = await renewKey(app, bot.secret, grant.grantId);
    expect(response.status).toBe(200);
    await response.json();

    expect(await countOf(creditGrants)).toBe(grantsBefore);
    expect(await countOf(creditLedger)).toBe(ledgerBefore);
    expect(await countOf(creditReservations)).toBe(reservationsBefore);
    const [userGrantsAfter] = await database
      .select({ n: sql<number>`count(*)` })
      .from(accessGrants)
      .where(eq(accessGrants.userId, userId));
    expect(Number(userGrantsAfter?.n)).toBe(Number(userGrantsBefore?.n));
  }, 30_000);

  test("clock-driven renewal: past the old term a valid grant still renews onto a fresh term", async () => {
    const app = appFor();
    const bot = await credentialedBot("clock");
    const userId = `${prefix}-clock-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    const claim = await renewKey(app, bot.secret, grant.grantId);
    expect(claim.status).toBe(200);
    const claimBody = (await claim.json()) as {
      key: { expiresAt: string; credentialVersion: number };
    };

    // The clock runs past the first key's whole term: the key is dead by the clock.
    await advanceClock(16 * 60_000);
    expect(Date.parse(claimBody.key.expiresAt)).toBeLessThan(
      clockNow.getTime(),
    );

    // The grant is what renewal trusts, not the old key's liveness: the renewal answers
    // a brand-new term measured from NOW, not a stitch onto the dead record.
    const response = await renewKey(app, bot.secret, grant.grantId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      key: { expiresAt: string | null; credentialVersion: number };
      supersededVersions: number[];
    };
    expect(body.key.credentialVersion).toBe(2);
    expect(body.key.expiresAt).toBe(
      new Date(clockNow.getTime() + 15 * 60_000).toISOString(),
    );
    expect(body.supersededVersions).toEqual([1]);
  }, 30_000);

  test("a gateway refusing the deactivation refuses the whole renewal and writes nothing", async () => {
    const app = appFor();
    const bot = await credentialedBot("defail");
    const userId = `${prefix}-defail-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    const claim = await renewKey(app, bot.secret, grant.grantId);
    expect(claim.status).toBe(200);
    await claim.json();

    fake.stage({ vkDeactivateRespondWith: "status-500" });
    try {
      const response = await renewKey(app, bot.secret, grant.grantId);
      expect(response.status).toBe(502);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("renewal_vk_unexpected_status");
    } finally {
      fake.stage({ vkDeactivateRespondWith: "valid" });
    }

    // The transaction rolled back: still exactly one active version, the old one.
    const rows = await keyRowsFor(grant.grantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.credentialVersion).toBe(1);
    expect(rows[0]!.status).toBe("active");
  }, 30_000);
});

/**
 * A fake of the Bifrost management surfaces this ticket integrates with: customers (05.1's
 * seam) and virtual-keys create (05.3's) plus the update surface a renewal's deactivation
 * rides (PUT with is_active:false). Unique names, bearer-authenticated, and a `stage` for
 * the failure modes the adapters must classify. Test-only: production dials the configured
 * endpoint, and nothing here is a fallback for it.
 */
function startFakeBifrost() {
  const customers = new Map<string, { id: string }>();
  type VkBody = {
    name?: unknown;
    customer_id?: unknown;
    allow_all_providers?: unknown;
  };
  const virtualKeys = new Map<
    string,
    {
      id: string;
      value: string;
      customerId: string | null;
      isActive: boolean;
    }
  >();
  const calls = { vkCreate: 0, vkDeactivate: 0 };
  const deactivations: { id: string; body: Record<string, unknown> }[] = [];
  let vkRespondWith: "valid" | "status-500" | "not-json" = "valid";
  let vkDeactivateRespondWith: "valid" | "status-500" | "missing" = "valid";

  function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== "Bearer test-admin-key") {
        return json(401, { error: "unauthorized" });
      }
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        url.pathname === "/api/governance/customers"
      ) {
        const name = ((await request.json()) as { name?: unknown }).name;
        if (typeof name !== "string" || name.length === 0) {
          return json(400, { error: "Customer name is required" });
        }
        if (customers.has(name)) {
          return json(409, {
            error: "A customer with this name already exists",
          });
        }
        const id = crypto.randomUUID();
        customers.set(name, { id });
        return json(200, { message: "ok", customer: { id, name } });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/governance/customers"
      ) {
        const search = url.searchParams.get("search") ?? "";
        const matched = [...customers.entries()]
          .filter(([name]) => name.includes(search))
          .map(([name, entry]) => ({ id: entry.id, name }));
        return json(200, { customers: matched, count: matched.length });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/governance/virtual-keys"
      ) {
        calls.vkCreate += 1;
        let body: VkBody;
        try {
          body = (await request.json()) as VkBody;
        } catch {
          return json(400, { error: "Invalid JSON" });
        }
        if (typeof body.name !== "string" || body.name.length === 0) {
          return json(400, { error: "Virtual key name is required" });
        }
        if (vkRespondWith === "status-500") {
          return json(500, { error: "failed to create virtual key" });
        }
        if (vkRespondWith === "not-json") {
          return new Response("<html>not the management api</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        const id = crypto.randomUUID();
        const value = `sk-bf-${crypto.randomUUID().replaceAll("-", "")}`;
        virtualKeys.set(id, {
          id,
          value,
          customerId:
            typeof body.customer_id === "string" ? body.customer_id : null,
          isActive: true,
        });
        return json(200, {
          message: "ok",
          virtual_key: { id, value, name: body.name },
        });
      }
      const deactivatelatch = url.pathname.match(
        /^\/api\/governance\/virtual-keys\/([^/]+)$/,
      );
      if (request.method === "PUT" && deactivatelatch) {
        calls.vkDeactivate += 1;
        const id = deactivatelatch[1] ?? "";
        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return json(400, { error: "Invalid JSON" });
        }
        deactivations.push({ id, body });
        if (vkDeactivateRespondWith === "status-500") {
          return json(500, { error: "failed to update virtual key" });
        }
        if (vkDeactivateRespondWith === "missing") {
          return json(404, { error: "Virtual key not found" });
        }
        const held = virtualKeys.get(id);
        if (!held) {
          return json(404, { error: "Virtual key not found" });
        }
        if (body.is_active === false) held.isActive = false;
        return json(200, {
          message: "ok",
          virtual_key: { id: held.id, is_active: held.isActive },
        });
      }
      return json(404, { error: "not found" });
    },
  });

  return {
    server,
    calls,
    deactivations,
    stage(next: {
      vkRespondWith?: typeof vkRespondWith;
      vkDeactivateRespondWith?: typeof vkDeactivateRespondWith;
    }) {
      if (next.vkRespondWith !== undefined) vkRespondWith = next.vkRespondWith;
      if (next.vkDeactivateRespondWith !== undefined) {
        vkDeactivateRespondWith = next.vkDeactivateRespondWith;
      }
    },
    virtualKeysForCustomer(customerId: string) {
      return [...virtualKeys.values()].filter(
        (vk) => vk.customerId === customerId,
      );
    },
    keyById(id: string) {
      return virtualKeys.get(id);
    },
    async stop() {
      await server.stop(true);
    },
  };
}
