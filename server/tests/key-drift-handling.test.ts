import { afterAll, beforeEach, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  botServices,
  creditGrants,
  creditLedger,
  creditReservations,
} from "../src/db/schema";
import {
  gatewayCustomers,
  gatewayKeyDriftEvents,
  gatewayKeySyncDrift,
  gatewayKeySyncState,
  gatewayVirtualKeys,
} from "../src/db/schema/gateway";
import { createGatewayCustomerProvisioner } from "../src/gateway/customer";
import {
  createGatewayKeyDriftStore,
} from "../src/gateway/key-drift";
import {
  createGatewayKeyIssuer,
  createGatewayVirtualKeyClient,
  GatewayVirtualKeyError,
} from "../src/gateway/key-issuance";
import {
  createGatewayKeyRenewalService,
  createGatewayVirtualKeyDeactivationClient,
  GatewayKeyRenewalError,
} from "../src/gateway/key-renewal";
import {
  createGatewayKeyStateSyncService,
  createGatewayKeyStateStore,
  createGatewayVirtualKeyStateClient,
  type GatewayKeyStateSyncService,
} from "../src/gateway/key-state-sync";
import type { GatewayReadinessService } from "../src/gateway/readiness";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost 05.9 (#250, AC11/Q18): OWNERSHIP DRIFT DISPOSITION and MANUAL KEYS.
 *
 * The gateway is where a short-lived key's RECORD can change behind OpenBot's back — an
 * operator moves the key to another Customer, narrows what it may call, or rewrites its
 * term. The local record then describes a key that no longer exists, and every downstream
 * act (the next issuance, the next renewal) would stand on a lie about WHO the key bills
 * and WHAT it may do. So 05.9 keeps the same discipline 05.5 wrote for expiry:
 *
 * DRIFT IS A VERDICT, NOT AN ERASER. A field mismatch does not rewrite the key's status —
 * the key may still work at the gateway, and OpenBot's own word for it does not change.
 * The verdict is: the mismatch is recorded as an auditable, disposable drift event, and
 * the key's AUTHORIZATION is paused — issuance and renewal for that grant refuse with a
 * typed reason until a human disposes of the event. Availability drift (05.8's deleted/
 * disabled/expired) still flips the status; the two verdicts are independent answers to
 * the same remote read.
 *
 * MINIMAL FIELD SET. Only the fields OpenBot's own mint wrote are compared — the owner
 * (customer_id), the access scope (allow_all_providers with no per-provider narrowing)
 * and the term (expires_at, within a small tolerance so JSON reformatting is not drift).
 * Detection that is too wide pauses grants for cosmetic diffs — the false-pause is the
 * failure mode this file pins with its healthy-key cases.
 *
 * MANUAL KEYS ARE NOT ADOPTED. The sync addresses only the ids OpenBot issued; a key an
 * operator created at the gateway is invisible BY CONSTRUCTION — no local record, no
 * authorization, no account mapping, no credit is ever derived from its existence, and
 * (07.x's admission guarantee, asserted here) a key with no local record has nothing to
 * redeem it against.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = randomUUID().slice(0, 8);
const prefix = `b5-250-${run}`;

/** One clock reading the healthy keys' terms are written against, local and remote alike. */
const BASE = Date.now();
/** A term every healthy key carries: ten minutes out, identical on both sides. */
const HEALTHY_EXPIRES_AT = new Date(BASE + 600_000);

const auditStore = createAuditStore(database);
const registry = createBotServiceRegistry(database, {
  encryptionKey: randomBytes(32).toString("base64"),
  credentialStore: createCredentialStore(database),
  auditStore,
});

/** The fake Bifrost this file integrates against: customers, key creates, per-key reads. */
const fake = startFakeBifrost();

const endpoint = {
  baseUrl: `http://127.0.0.1:${fake.port}`,
  requestTimeoutMs: 2_000,
  configVersion: 1,
};

/** Sweep THIS file's prefix namespace clean; children before parents, twice a run.
 *
 * The keys issued during a test carry the issuer's own random ids (`gvk-<hex>`), not this
 * file's prefix — so every sweep deletes through the grants this run created, which name
 * every key ever minted against them.
 */
async function sweepOwnPrefix() {
  await database.execute(sql`
    DELETE FROM gateway_key_drift_events
    WHERE key_id LIKE ${`gvk-${prefix}-%`}
       OR grant_id IN (SELECT grant_id FROM access_grants WHERE user_id LIKE ${`${prefix}-%`})
  `);
  await database.execute(sql`
    DELETE FROM gateway_key_sync_drift
    WHERE key_id LIKE ${`gvk-${prefix}-%`}
       OR grant_id IN (SELECT grant_id FROM access_grants WHERE user_id LIKE ${`${prefix}-%`})
  `);
  await database.execute(sql`
    DELETE FROM gateway_virtual_keys
    WHERE grant_id IN (SELECT grant_id FROM access_grants WHERE user_id LIKE ${`${prefix}-%`})
  `);
  await database
    .delete(gatewayVirtualKeys)
    .where(like(gatewayVirtualKeys.id, `gvk-${prefix}-%`));
  // Audit rows stay: the trail is append-only by design (0007), and every assertion below
  // scopes itself to this run's ids, so rows from earlier runs never bleed into one.
  await database
    .delete(accessGrants)
    .where(like(accessGrants.userId, `${prefix}-%`));
  await database
    .delete(gatewayCustomers)
    .where(like(gatewayCustomers.payerId, `${prefix}-%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}-%`));
}

await sweepOwnPrefix();

/** A fresh sync-state row per test: the singleton must not leak one test's history into the next. */
beforeEach(async () => {
  await database.delete(gatewayKeySyncState);
  fake.resetCreates();
  await sweepOwnPrefix();
});

/** A registered bot: grants' FK target. */
async function registeredBot(suffix: string) {
  const botId = `${prefix}-bot-${suffix}`;
  await registry.register({
    botId,
    displayName: `Key Drift Bot ${suffix}`,
    kind: "external",
    capabilities: ["chat"],
  });
  return botId;
}

/** One authorization row, inserted directly. */
async function grant(botId: string, suffix: string) {
  const grantId = randomUUID();
  await database.insert(accessGrants).values({
    grantId,
    userId: `${prefix}-user-${suffix}`,
    botId,
    externalIdentity: `slack:${prefix}-user-${suffix}`,
    scope: "model-access",
    source: "binding-code",
  });
  return grantId;
}

/** One healthy local key for a `remoteId` the fake gateway answers with matching fields. */
async function localKey(input: {
  suffix: string;
  grantId: string;
  botId: string;
  remoteId: string;
  status?: "active" | "revoked" | "expired";
  customerId?: string;
  expiresAt?: Date | null;
}) {
  const customerId = input.customerId ?? `${prefix}-cust-${input.suffix}`;
  const expiresAt =
    input.expiresAt === undefined ? HEALTHY_EXPIRES_AT : input.expiresAt;
  const [row] = await database
    .insert(gatewayVirtualKeys)
    .values({
      id: `gvk-${prefix}-${input.suffix}`,
      grantId: input.grantId,
      botId: input.botId,
      gatewayCustomerId: customerId,
      gatewayVirtualKeyId: input.remoteId,
      valueHash: createHash("sha256")
        .update(`sk-bf-${input.suffix}-${run}`)
        .digest("hex"),
      credentialVersion: 1,
      status: input.status ?? "active",
      ...(expiresAt === null ? {} : { expiresAt }),
    })
    .returning();
  // The gateway answers with the same fields the local record carries: healthy until a
  // test mutates exactly one side.
  fake.remember(input.remoteId, {
    isActive: true,
    customerId,
    allowAllProviders: true,
    providerConfigs: 0,
    expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
  });
  return { row: row!, customerId };
}

/** The local status of one of this run's key rows, read fresh. */
async function statusOf(keyId: string) {
  const [row] = await database
    .select({ status: gatewayVirtualKeys.status })
    .from(gatewayVirtualKeys)
    .where(eq(gatewayVirtualKeys.id, keyId))
    .limit(1);
  return row?.status;
}

/** The sync service under test: production store, production client, fake gateway, real audit. */
function syncService(): GatewayKeyStateSyncService {
  return createGatewayKeyStateSyncService({
    database,
    store: createGatewayKeyStateStore(database),
    client: createGatewayVirtualKeyStateClient({
      readGatewayEndpoint: async () => endpoint,
      resolveGatewayAdminCredential: async () => ({
        adminKey: "test-admin-key",
      }),
    }),
    auditStore,
  });
}

/** The drift-event rows for one local key, read fresh. */
async function driftEventsFor(keyId: string) {
  return database
    .select()
    .from(gatewayKeyDriftEvents)
    .where(eq(gatewayKeyDriftEvents.keyId, keyId));
}

/** The store under test: production queries, the boot audit trail for dispositions. */
function driftStore() {
  return createGatewayKeyDriftStore(database, { auditStore });
}

/** The audit rows of one type for THIS RUN — scoped by target, never the whole table. */
async function auditsOf(
  eventType: string,
  scope?: { targetId?: string; targetIdPrefix?: string },
) {
  const conditions = [eq(auditEvents.eventType, eventType)];
  if (scope?.targetId !== undefined) {
    conditions.push(eq(auditEvents.targetId, scope.targetId));
  }
  if (scope?.targetIdPrefix !== undefined) {
    conditions.push(like(auditEvents.targetId, scope.targetIdPrefix));
  }
  return database
    .select()
    .from(auditEvents)
    .where(and(...conditions));
}

/** A gate that passes, the way 01.7's installed service answers on a ready deployment. */
function readyGate(): GatewayReadinessService {
  const readiness = {
    ready: true,
    blockingReasons: [],
    configVersion: endpoint.configVersion,
    checkedAt: new Date().toISOString(),
  };
  return {
    evaluateGatewayReadiness: async () => readiness,
    assertGatewayReadyForBilling: async () => readiness,
  };
}

/** The 05.1 provisioner seam, pointed at the fake Bifrost. */
function provisionerFor() {
  return createGatewayCustomerProvisioner({
    database,
    readGatewayEndpoint: async () => endpoint,
    resolveGatewayAdminCredential: async () => ({ adminKey: "test-admin-key" }),
    gate: readyGate(),
  });
}

/** The issuer under test: real grant seam, real provisioner, real client adapter. */
function issuerFor() {
  return createGatewayKeyIssuer({
    database,
    resolveForBot: registry.modelAccess.resolveForBot,
    provisionCustomer: provisionerFor().provisionCustomer,
    client: createGatewayVirtualKeyClient({
      readGatewayEndpoint: async () => endpoint,
      resolveGatewayAdminCredential: async () => ({
        adminKey: "test-admin-key",
      }),
    }),
    keyTtlMinutes: 15,
    auditStore,
  });
}

/** The renewal service under test: the same real seams, stubbed catalog verdicts. */
function renewalFor() {
  return createGatewayKeyRenewalService({
    database,
    resolveForBot: registry.modelAccess.resolveForBot,
    provisionCustomer: provisionerFor().provisionCustomer,
    listSelectableModels: async () => [
      { provider: "openai", model: "gpt-test", capability: "chat" as const },
    ],
    assertCatalogFresh: async () => ({
      fresh: true,
      lastSuccessfulSyncAt: new Date(BASE).toISOString(),
      ageMs: 1_000,
      windowMs: 900_000,
    }),
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
    auditStore,
  });
}

/** The identity a registered Bot presents; resolveForBot only trusts active ones. */
function identityFor(botId: string) {
  return { botId, status: "active" as const };
}

describe("05.9 key drift handling", () => {
  test("ownership drift records an auditable event, keeps the key's status, and pauses the grant's issuance and renewal without touching an unaffected authorization", async () => {
    const botId = await registeredBot("own");
    const driftedGrant = await grant(botId, "own-drift");
    const healthyGrant = await grant(botId, "own-healthy");
    const drifted = await localKey({
      suffix: "own-drift",
      grantId: driftedGrant,
      botId,
      remoteId: `vk-own-drift-${run}`,
    });
    const healthy = await localKey({
      suffix: "own-healthy",
      grantId: healthyGrant,
      botId,
      remoteId: `vk-own-healthy-${run}`,
    });

    // An operator moved the drifted key to another customer at the gateway.
    fake.moveOwner(`vk-own-drift-${run}`, "cust-elsewhere");

    const outcome = await syncService().runSync();
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;

    // The verdict: exactly one field-drift event, naming both sides of the mismatch…
    expect(outcome.driftEvents).toHaveLength(1);
    expect(outcome.driftEvents[0]).toMatchObject({
      keyId: drifted.row.id,
      grantId: driftedGrant,
      botId,
      gatewayVirtualKeyId: `vk-own-drift-${run}`,
      reasonCode: "gateway_key_owner_changed",
      localCustomerId: drifted.customerId,
      remoteCustomerId: "cust-elsewhere",
    });

    // …and the event is PERSISTED as an auditable, undisposed row.
    const events = await driftEventsFor(drifted.row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reasonCode: "gateway_key_owner_changed",
      localCustomerId: drifted.customerId,
      remoteCustomerId: "cust-elsewhere",
      disposition: null,
      disposedAt: null,
    });

    // DRIFT IS A VERDICT, NOT AN ERASER: the key's own status did not move.
    expect(await statusOf(drifted.row.id)).toBe("active");
    expect(await statusOf(healthy.row.id)).toBe("active");

    // The ALERT: the trail names the detection — this run's key, this run's row.
    const detected = await auditsOf("gateway.key_drift_detected", {
      targetId: drifted.row.id,
    });
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      targetType: "gateway_virtual_key",
      targetId: drifted.row.id,
    });

    // THE PAUSE: issuance for the drifted grant refuses with the typed reason…
    let issuanceRefused = false;
    try {
      await issuerFor().issueKeyForGrant(driftedGrant, identityFor(botId));
    } catch (error) {
      issuanceRefused =
        error instanceof GatewayVirtualKeyError &&
        error.reasonCode === "gateway_vk_grant_drift_paused";
    }
    expect(issuanceRefused).toBe(true);
    // …no remote create, no new local row: the pause held before anything moved.
    expect(fake.vkCreates()).toBe(0);
    const [keysForGrant] = await database
      .select({ n: sql<number>`count(*)` })
      .from(gatewayVirtualKeys)
      .where(eq(gatewayVirtualKeys.grantId, driftedGrant));
    expect(Number(keysForGrant?.n)).toBe(1);

    // …and renewal refuses the same way.
    let renewalRefused = false;
    try {
      await renewalFor().renewKeyForGrant(driftedGrant, identityFor(botId));
    } catch (error) {
      renewalRefused =
        error instanceof GatewayKeyRenewalError &&
        error.reasonCode === "renewal_grant_drift_paused";
    }
    expect(renewalRefused).toBe(true);
    expect(fake.vkCreates()).toBe(0);

    // NO COLLATERAL: the healthy authorization on the same deployment issues normally
    // (its seeded record was version 1, so the claim is the next version).
    const issued = await issuerFor().issueKeyForGrant(
      healthyGrant,
      identityFor(botId),
    );
    expect(issued.credentialVersion).toBe(2);
    expect(fake.vkCreates()).toBe(1);
  }, 30_000);

  test("scope drift — a narrowed key or one with per-provider configs attached — is recorded and pauses; a healthy scope is not drift", async () => {
    const botId = await registeredBot("scope");
    const narrowedGrant = await grant(botId, "scope-narrow");
    const configsGrant = await grant(botId, "scope-configs");
    await localKey({
      suffix: "scope-narrow",
      grantId: narrowedGrant,
      botId,
      remoteId: `vk-scope-narrow-${run}`,
    });
    await localKey({
      suffix: "scope-configs",
      grantId: configsGrant,
      botId,
      remoteId: `vk-scope-configs-${run}`,
    });

    // One key lost its all-provider surface; another had per-provider configs attached.
    fake.narrowScope(`vk-scope-narrow-${run}`);
    fake.attachProviderConfigs(`vk-scope-configs-${run}`, 2);

    const outcome = await syncService().runSync();
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.driftEvents).toHaveLength(2);
    expect(
      outcome.driftEvents.every(
        (event) => event.reasonCode === "gateway_key_scope_changed",
      ),
    ).toBe(true);

    // Both grants are paused for issuance.
    for (const pausedGrant of [narrowedGrant, configsGrant]) {
      let refused = false;
      try {
        await issuerFor().issueKeyForGrant(pausedGrant, identityFor(botId));
      } catch (error) {
        refused =
          error instanceof GatewayVirtualKeyError &&
          error.reasonCode === "gateway_vk_grant_drift_paused";
      }
      expect(refused).toBe(true);
    }
    expect(fake.vkCreates()).toBe(0);
  }, 30_000);

  test("term drift — a rewritten or removed expiry — is recorded and pauses; reformatting-level differences are not drift", async () => {
    const botId = await registeredBot("term");
    const extendedGrant = await grant(botId, "term-extended");
    const removedGrant = await grant(botId, "term-removed");
    const cosmeticGrant = await grant(botId, "term-cosmetic");
    await localKey({
      suffix: "term-extended",
      grantId: extendedGrant,
      botId,
      remoteId: `vk-term-extended-${run}`,
    });
    await localKey({
      suffix: "term-removed",
      grantId: removedGrant,
      botId,
      remoteId: `vk-term-removed-${run}`,
    });
    await localKey({
      suffix: "term-cosmetic",
      grantId: cosmeticGrant,
      botId,
      remoteId: `vk-term-cosmetic-${run}`,
    });

    // A term rewritten an hour out is drift; a removed term is drift; a difference within
    // the tolerance is reformatting, not drift.
    fake.reterm(`vk-term-extended-${run}`, new Date(BASE + 600_000 + 3_600_000));
    fake.reterm(`vk-term-removed-${run}`, null);
    fake.reterm(
      `vk-term-cosmetic-${run}`,
      new Date(BASE + 600_000 + 500),
    );

    const outcome = await syncService().runSync();
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;

    const events = outcome.driftEvents;
    expect(events).toHaveLength(2);
    expect(
      events.find(
        (event) => event.reasonCode === "gateway_key_term_changed",
      ),
    ).toBeDefined();

    // The extended key's grant is paused; the cosmetic one is not (its seeded record was
    // version 1, so this claim is version 2).
    let extendedRefused = false;
    try {
      await issuerFor().issueKeyForGrant(extendedGrant, identityFor(botId));
    } catch (error) {
      extendedRefused =
        error instanceof GatewayVirtualKeyError &&
        error.reasonCode === "gateway_vk_grant_drift_paused";
    }
    expect(extendedRefused).toBe(true);

    const issued = await issuerFor().issueKeyForGrant(
      cosmeticGrant,
      identityFor(botId),
    );
    expect(issued.credentialVersion).toBe(2);
  }, 30_000);

  test("one outstanding event per key and reason; disposal re-arms detection when the mismatch persists", async () => {
    const botId = await registeredBot("rearm");
    const grantId = await grant(botId, "rearm");
    const key = await localKey({
      suffix: "rearm",
      grantId,
      botId,
      remoteId: `vk-rearm-${run}`,
    });
    fake.moveOwner(`vk-rearm-${run}`, "cust-elsewhere");

    // Two syncs, one persistent mismatch: one outstanding event, not a pile.
    await syncService().runSync();
    await syncService().runSync();
    expect(await driftEventsFor(key.row.id)).toHaveLength(1);

    // A human disposes of the event — but the gateway still disagrees.
    const store = driftStore();
    const [event] = await driftEventsFor(key.row.id);
    const disposed = await store.dispose({
      eventId: event!.id,
      decision: "accepted",
      disposedBy: "admin-1",
      note: "reviewed with the operator",
    });
    expect(disposed.disposed).toBe(true);

    // The pause lifted… for now: the next sync re-detects and records a NEW event.
    const reDetect = await syncService().runSync();
    expect(reDetect.status).toBe("ok");
    if (reDetect.status !== "ok") return;
    expect(reDetect.driftEvents).toHaveLength(1);
    expect(await driftEventsFor(key.row.id)).toHaveLength(2);

    // …and the pause stands again: an unresolved mismatch pauses, every time it is truth.
    let refused = false;
    try {
      await issuerFor().issueKeyForGrant(grantId, identityFor(botId));
    } catch (error) {
      refused =
        error instanceof GatewayVirtualKeyError &&
        error.reasonCode === "gateway_vk_grant_drift_paused";
    }
    expect(refused).toBe(true);
  }, 30_000);

  test("an accepted disposition lifts the pause, is auditable, and cannot be disposed twice", async () => {
    const botId = await registeredBot("dispose");
    const grantId = await grant(botId, "dispose");
    const key = await localKey({
      suffix: "dispose",
      grantId,
      botId,
      remoteId: `vk-dispose-${run}`,
    });
    fake.moveOwner(`vk-dispose-${run}`, "cust-elsewhere");
    await syncService().runSync();

    const store = driftStore();
    const [event] = await driftEventsFor(key.row.id);
    await store.dispose({
      eventId: event!.id,
      decision: "accepted",
      disposedBy: "admin-2",
    });

    // The row carries the whole disposition — who, when, what, and (optionally) why.
    const [disposedRow] = await driftEventsFor(key.row.id);
    expect(disposedRow).toMatchObject({
      disposition: "accepted",
      disposedBy: "admin-2",
      dispositionNote: null,
    });
    expect(disposedRow!.disposedAt).not.toBeNull();

    // The trail names the human act, on this exact event.
    const disposedAudits = await auditsOf("gateway.key_drift_disposed", {
      targetId: event!.id,
    });
    expect(disposedAudits).toHaveLength(1);
    expect(disposedAudits[0]!.payload).toMatchObject({
      eventId: event!.id,
      decision: "accepted",
    });

    // The grant issues again (the seeded record was version 1, so this is version 2).
    const issued = await issuerFor().issueKeyForGrant(grantId, identityFor(botId));
    expect(issued.credentialVersion).toBe(2);

    // A second disposal of the same event is refused — the decision is written once.
    const second = await store.dispose({
      eventId: event!.id,
      decision: "key_revoked",
      disposedBy: "admin-3",
    });
    expect(second.disposed).toBe(false);
    expect(
      await auditsOf("gateway.key_drift_disposed", { targetId: event!.id }),
    ).toHaveLength(1);
  }, 30_000);

  test("a key_revoked disposition retires the drifted key and lifts the pause", async () => {
    const botId = await registeredBot("revoke");
    const grantId = await grant(botId, "revoke");
    const key = await localKey({
      suffix: "revoke",
      grantId,
      botId,
      remoteId: `vk-revoke-${run}`,
    });
    fake.moveOwner(`vk-revoke-${run}`, "cust-elsewhere");
    await syncService().runSync();

    const store = driftStore();
    const [event] = await driftEventsFor(key.row.id);
    await store.dispose({
      eventId: event!.id,
      decision: "key_revoked",
      disposedBy: "admin-4",
    });

    // The drifted key is dead locally — the word the sync and revocation share.
    expect(await statusOf(key.row.id)).toBe("revoked");

    // And the grant issues again.
    const issued = await issuerFor().issueKeyForGrant(grantId, identityFor(botId));
    expect(issued.credentialVersion).toBe(2);
  }, 30_000);

  test("a key an operator created at the gateway is never adopted: no record, no authorization, no account mapping, no credit", async () => {
    const botId = await registeredBot("manual");
    const grantId = await grant(botId, "manual");
    await localKey({
      suffix: "manual",
      grantId,
      botId,
      remoteId: `vk-manual-seen-${run}`,
    });
    // The operator's own key: healthy, owned by someone, never issued by OpenBot.
    fake.remember(`vk-manual-${run}`, {
      isActive: true,
      customerId: "cust-operators-own",
      allowAllProviders: true,
      providerConfigs: 0,
      expiresAt: null,
    });

    const countsBefore = await deploymentCounts();
    const outcome = await syncService().runSync();
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.driftEvents).toHaveLength(0);

    // NOTHING was adopted: the manual key exists only at the gateway. No local record…
    const [manualRows] = await database
      .select({ n: sql<number>`count(*)` })
      .from(gatewayVirtualKeys)
      .where(
        eq(gatewayVirtualKeys.gatewayVirtualKeyId, `vk-manual-${run}`),
      );
    expect(Number(manualRows?.n)).toBe(0);
    // …no authorization, no account mapping, no credit, no ledger, no reservation…
    const countsAfter = await deploymentCounts();
    expect(countsAfter).toEqual(countsBefore);
    // …and no issuance to audit for this run's keys.
    expect(
      await auditsOf("gateway.key_issued", {
        targetIdPrefix: `gvk-${prefix}-%`,
      }),
    ).toHaveLength(0);

    // The admission assertion (07.x guarantees the enforcement; 05.9 leaves the seam
    // honest): a key with no local record has nothing to resolve or redeem it against —
    // the only keys this deployment names are the ones it issued.
    expect(await statusOf(`gvk-${prefix}-manual`)).toBe("active");
  }, 30_000);

  test("availability drift still wins: a deleted key flips with no field event; a disabled key with a moved owner gets both verdicts", async () => {
    const botId = await registeredBot("avail");
    const deletedGrant = await grant(botId, "avail-del");
    const disabledGrant = await grant(botId, "avail-dis");
    const deleted = await localKey({
      suffix: "avail-del",
      grantId: deletedGrant,
      botId,
      remoteId: `vk-avail-del-${run}`,
    });
    const disabled = await localKey({
      suffix: "avail-dis",
      grantId: disabledGrant,
      botId,
      remoteId: `vk-avail-dis-${run}`,
    });

    fake.forget(`vk-avail-del-${run}`);
    fake.disable(`vk-avail-dis-${run}`);
    fake.moveOwner(`vk-avail-dis-${run}`, "cust-elsewhere");

    const outcome = await syncService().runSync();
    expect(outcome.status).toBe("ok");

    // Deleted: the 05.8 flip, and nothing to compare fields against — no field event.
    expect(await statusOf(deleted.row.id)).toBe("revoked");
    expect(await driftEventsFor(deleted.row.id)).toHaveLength(0);
    const [syncDriftRows] = await database
      .select({ n: sql<number>`count(*)` })
      .from(gatewayKeySyncDrift)
      .where(
        and(
          eq(gatewayKeySyncDrift.keyId, deleted.row.id),
          eq(gatewayKeySyncDrift.reasonCode, "gateway_key_deleted"),
        ),
      );
    expect(Number(syncDriftRows?.n)).toBe(1);

    // Disabled AND owner-moved: both verdicts land — the flip AND the field event.
    expect(await statusOf(disabled.row.id)).toBe("revoked");
    const disabledEvents = await driftEventsFor(disabled.row.id);
    expect(disabledEvents).toHaveLength(1);
    expect(disabledEvents[0]).toMatchObject({
      reasonCode: "gateway_key_owner_changed",
      remoteCustomerId: "cust-elsewhere",
    });
  }, 30_000);

  test("the drift reasons and decisions are closed sets the store refuses to leave", async () => {
    const store = driftStore();
    // An unknown disposition decision is refused, not stored.
    let refused = false;
    try {
      await store.dispose({
        eventId: `gkde-${randomBytes(8).toString("hex")}`,
        decision: "promoted" as never,
        disposedBy: "admin-x",
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  test("a grant with no outstanding drift never pauses — the healthy path is the fast path", async () => {
    const botId = await registeredBot("clean");
    const grantId = await grant(botId, "clean");
    const key = await localKey({
      suffix: "clean",
      grantId,
      botId,
      remoteId: `vk-clean-${run}`,
    });

    const outcome = await syncService().runSync();
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.driftEvents).toHaveLength(0);
      expect(outcome.checked).toBe(1);
    }
    expect(await driftEventsFor(key.row.id)).toHaveLength(0);
    expect(await statusOf(key.row.id)).toBe("active");

    const store = driftStore();
    expect(await store.outstandingReasonsForGrant(grantId)).toEqual([]);

    // Issuance runs the pause check on every claim; a clean grant sails through it (the
    // seeded record was version 1, so this claim is version 2).
    const issued = await issuerFor().issueKeyForGrant(grantId, identityFor(botId));
    expect(issued.credentialVersion).toBe(2);
  }, 30_000);
});

/** The deployment-wide counts the zero-adoption test holds still. */
async function deploymentCounts() {
  const count = async (
    table:
      | typeof accessGrants
      | typeof gatewayVirtualKeys
      | typeof gatewayCustomers
      | typeof creditGrants
      | typeof creditLedger
      | typeof creditReservations,
  ) => {
    const [row] = await database.select({ n: sql<number>`count(*)` }).from(table);
    return Number(row?.n ?? 0);
  };
  return {
    grants: await count(accessGrants),
    keys: await count(gatewayVirtualKeys),
    customerMappings: await count(gatewayCustomers),
    creditGrants: await count(creditGrants),
    ledger: await count(creditLedger),
    reservations: await count(creditReservations),
  };
}

/**
 * A fake of the Bifrost surfaces this ticket consumes: the per-key governance read with the
 * fields OpenBot's mint wrote (owner, scope, term), the virtual-key create the issuance and
 * renewal run, and the deactivation PUT. Test-only: production dials the configured endpoint.
 */
function startFakeBifrost() {
  type RemoteKey = {
    isActive: boolean;
    customerId: string | null;
    allowAllProviders: boolean;
    providerConfigs: number;
    expiresAt: string | null;
  };
  const customers = new Map<string, string>();
  const keys = new Map<string, RemoteKey>();
  let vkCreates = 0;

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
        const body = (await request.json()) as { name?: unknown };
        if (typeof body.name !== "string" || body.name.length === 0) {
          return json(400, { error: "Customer name is required" });
        }
        if (customers.has(body.name)) {
          return json(200, {
            customer: { id: customers.get(body.name), name: body.name },
          });
        }
        const id = crypto.randomUUID();
        customers.set(body.name, id);
        return json(200, { customer: { id, name: body.name } });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/governance/customers"
      ) {
        const search = url.searchParams.get("search") ?? "";
        const matched = [...customers.entries()]
          .filter(([name]) => name.includes(search))
          .map(([name, id]) => ({ id, name }));
        return json(200, { customers: matched, count: matched.length });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/governance/virtual-keys"
      ) {
        vkCreates += 1;
        const body = (await request.json()) as {
          name?: unknown;
          customer_id?: unknown;
          expires_at?: unknown;
        };
        if (typeof body.name !== "string" || body.name.length === 0) {
          return json(400, { error: "Virtual key name is required" });
        }
        const id = crypto.randomUUID();
        keys.set(id, {
          isActive: true,
          customerId:
            typeof body.customer_id === "string" ? body.customer_id : null,
          allowAllProviders: true,
          providerConfigs: 0,
          expiresAt:
            typeof body.expires_at === "string" ? body.expires_at : null,
        });
        return json(200, {
          virtual_key: { id, value: `sk-bf-${id.slice(0, 12)}` },
        });
      }
      const keyMatch = url.pathname.match(
        /^\/api\/governance\/virtual-keys\/([^/]+)$/,
      );
      if (request.method === "GET" && keyMatch) {
        const id = decodeURIComponent(keyMatch[1]!);
        const key = keys.get(id);
        if (!key) return json(404, { error: "Virtual key not found" });
        return json(200, {
          virtual_key: {
            id,
            is_active: key.isActive,
            customer_id: key.customerId,
            allow_all_providers: key.allowAllProviders,
            provider_configs: Array.from({ length: key.providerConfigs }, () => ({
              provider: "openai",
            })),
            expires_at: key.expiresAt,
          },
        });
      }
      if (request.method === "PUT" && keyMatch) {
        const id = decodeURIComponent(keyMatch[1]!);
        const key = keys.get(id);
        if (!key) return json(404, { error: "Virtual key not found" });
        const body = (await request.json()) as { is_active?: unknown };
        if (body.is_active === false) key.isActive = false;
        return json(200, { virtual_key: { id } });
      }
      return json(404, { error: "not found" });
    },
  });

  return {
    port: server.port,
    remember(id: string, state: RemoteKey) {
      keys.set(id, state);
    },
    /** The create counter, zeroed between tests: assertions count their own test's mints. */
    resetCreates() {
      vkCreates = 0;
    },
    forget(id: string) {
      keys.delete(id);
    },
    disable(id: string) {
      const key = keys.get(id);
      if (key) key.isActive = false;
    },
    moveOwner(id: string, customerId: string | null) {
      const key = keys.get(id);
      if (key) key.customerId = customerId;
    },
    narrowScope(id: string) {
      const key = keys.get(id);
      if (key) key.allowAllProviders = false;
    },
    attachProviderConfigs(id: string, count: number) {
      const key = keys.get(id);
      if (key) key.providerConfigs = count;
    },
    reterm(id: string, expiresAt: Date | null) {
      const key = keys.get(id);
      if (key) key.expiresAt = expiresAt === null ? null : expiresAt.toISOString();
    },
    vkCreates() {
      return vkCreates;
    },
    stop() {
      void server.stop(true);
    },
  };
}

afterAll(async () => {
  await sweepOwnPrefix();
  await database.$client.close();
  fake.stop();
});

/** The reason codes a field drift can carry — closed, like every gateway taxonomy here. */
