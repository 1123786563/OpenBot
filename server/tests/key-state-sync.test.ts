import { afterAll, beforeEach, describe, expect, test } from "../../tests/support/e2e-compat";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { payerKey } from "../src/billing/payer";
import { botServices } from "../src/db/schema/bot-services";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  creditGrants,
  creditLedger,
  creditReservations,
} from "../src/db/schema";
import {
  gatewayKeySyncDrift,
  gatewayKeySyncState,
  gatewayVirtualKeys,
} from "../src/db/schema/gateway";
import {
  DEFAULT_KEY_STATE_SYNC_INTERVAL_MS,
  type GatewayKeyStateSyncService,
  type GatewayKeySyncStateRow,
  createGatewayKeyStateStore,
  createGatewayKeyStateSyncService,
  createGatewayVirtualKeyStateClient,
  gatewayKeyStateSyncIntervalConfig,
  gatewayKeyStateSyncControls,
  installGatewayKeyStateSyncService,
} from "../src/gateway/key-state-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost 05.8 (#249, AC11/Q18): the key state sync. The gateway is where a short-lived
 * virtual key can die without OpenBot hearing about it — an operator deletes it, disables
 * it, or its expiry passes — and a key this deployment still believes `active` must become
 * unavailable the moment a sync observes the truth.
 *
 * The questions here are the ticket's own, asked against a real PostgreSQL and a fake
 * Bifrost management surface (test-only; production dials the configured endpoint with the
 * resolved admin credential):
 *
 * - CONSISTENCY: deleted → `revoked`, disabled → `revoked`, expired → `expired`; healthy
 *   keys are untouched; a locally revoked/expired key is NEVER resurrected (OpenBot owns
 *   the lifecycle, Q18 — the sync direction is gateway → local, toward unavailability only);
 *   remote-only keys OpenBot never issued are ignored, not imported.
 * - ZERO CREATION: a sync run — success, drift, or failure — adds no authorization, no
 *   credit grant, no ledger row, no reservation and no key record. From a gateway state
 *   change no OpenBot authorization can be derived.
 * - LAST-GOOD: a failed sync keeps every previously synced status and the last success
 *   time, counts the failure and records a fixed, displayable reason.
 * - QUERYABLE: the last successful sync time and the failure counters are one read away.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = randomUUID().slice(0, 8);
const prefix = `b5-249-${run}`;

const auditStore = createAuditStore(database);
const registry = createBotServiceRegistry(database, {
  encryptionKey: randomBytes(32).toString("base64"),
  credentialStore: createCredentialStore(database),
  auditStore,
});

/** The fake Bifrost this file integrates against: the per-key state read, stageable failures. */
const fake = startFakeBifrost();

const endpoint = {
  baseUrl: `http://127.0.0.1:${fake.port}`,
  requestTimeoutMs: 2_000,
  configVersion: 1,
};

/**
 * Sweep THIS file's prefix namespace clean before starting: a previous run that died before
 * its cleanup would otherwise leave active keys whose rows change what a deployment-wide
 * sync counts. Children before parents, the same order the final cleanup keeps; the prefix
 * (`b5-249-`) is this file's alone, so other files' rows in the shared dedicated database
 * are not touched.
 */
async function sweepOwnPrefix() {
  await database
    .delete(gatewayVirtualKeys)
    .where(like(gatewayVirtualKeys.id, `gvk-b5-249-%`));
  await database
    .delete(gatewayKeySyncDrift)
    .where(like(gatewayKeySyncDrift.keyId, `gvk-b5-249-%`));
  await database
    .delete(accessGrants)
    .where(like(accessGrants.userId, `b5-249-%`));
  await database
    .delete(auditEvents)
    .where(like(auditEvents.targetId, `gvk-b5-249-%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `b5-249-%`));
}

await sweepOwnPrefix();

/** Seed every remote key the tests reference as healthy; each test stages only its own drift. */
for (const id of [
  `vk-del-${run}`,
  `vk-del-survivor-${run}`,
  `vk-dis-${run}`,
  `vk-exp-${run}`,
  `vk-fut-${run}`,
  `vk-res-revoked-${run}`,
  `vk-res-expired-${run}`,
  `vk-zero-${run}`,
  `vk-last-keep-${run}`,
  `vk-last-flip-${run}`,
  `vk-rec-${run}`,
  `vk-single-${run}`,
]) {
  fake.remember(id);
}

/** A fresh sync-state row per test: the singleton must not leak one test's history into the next. */
beforeEach(async () => {
  await database.delete(gatewayKeySyncState);
});

afterAll(async () => {
  // Children before parents; audit rows are per-run prefixed and removable.
  await database
    .delete(gatewayVirtualKeys)
    .where(like(gatewayVirtualKeys.id, `gvk-${prefix}-%`));
  await database
    .delete(gatewayKeySyncDrift)
    .where(like(gatewayKeySyncDrift.keyId, `gvk-${prefix}-%`));
  await database
    .delete(accessGrants)
    .where(like(accessGrants.userId, `${prefix}-%`));
  await database
    .delete(auditEvents)
    .where(like(auditEvents.targetId, `gvk-${prefix}-%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}-%`));
  await database.$client.close();
  fake.stop();
});

/** A registered bot: grants' FK target; no service credential is needed for sync tests. */
async function registeredBot(suffix: string) {
  const botId = `${prefix}-bot-${suffix}`;
  await registry.register({
    botId,
    displayName: `Key Sync Bot ${suffix}`,
    kind: "external",
    capabilities: ["chat"],
  });
  return botId;
}

/** One authorization row, inserted directly — the sync never creates these (asserted below). */
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

/** One local key record for a `remoteId` the fake gateway knows (or knew) about. */
async function localKey(input: {
  suffix: string;
  grantId: string;
  botId: string;
  remoteId: string;
  status?: "active" | "revoked" | "expired";
  expiresAt?: Date | null;
}) {
  const [row] = await database
    .insert(gatewayVirtualKeys)
    .values({
      id: `gvk-${prefix}-${input.suffix}`,
      grantId: input.grantId,
      botId: input.botId,
      gatewayCustomerId: `${prefix}-cust`,
      gatewayVirtualKeyId: input.remoteId,
      valueHash: createHash("sha256")
        .update(`sk-bf-${input.suffix}-${run}`)
        .digest("hex"),
      credentialVersion: 1,
      status: input.status ?? "active",
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    })
    .returning();
  return row!;
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

/** The sync service under test: production store, production client adapter, fake gateway. */
function serviceFor(overrides?: {
  readGatewayEndpoint?: () => Promise<
    | { baseUrl: string; requestTimeoutMs: number; configVersion: number }
    | undefined
  >;
  resolveGatewayAdminCredential?: () => Promise<{ adminKey: string }>;
}): GatewayKeyStateSyncService {
  return createGatewayKeyStateSyncService({
    database,
    store: createGatewayKeyStateStore(database),
    client: createGatewayVirtualKeyStateClient({
      readGatewayEndpoint:
        overrides?.readGatewayEndpoint ?? (async () => endpoint),
      resolveGatewayAdminCredential:
        overrides?.resolveGatewayAdminCredential ??
        (async () => ({ adminKey: "test-admin-key" })),
    }),
  });
}

/** The drift records one successful outcome carried, unwrapped for the assertions below. */
function driftsOf(outcome: Awaited<ReturnType<GatewayKeyStateSyncService["runSync"]>>) {
  if (outcome.status !== "ok") {
    throw new Error(`expected a successful sync, got ${outcome.status}`);
  }
  return outcome.drifted;
}

describe("05.8 key state sync", () => {
  test("a key the gateway deleted is unavailable locally after one sync", async () => {
    const botId = await registeredBot("del");
    const grantId = await grant(botId, "del");
    const survivorGrant = await grant(botId, "del-survivor");
    await localKey({
      suffix: "del",
      grantId,
      botId,
      remoteId: `vk-del-${run}`,
    });
    const survivor = await localKey({
      suffix: "del-survivor",
      grantId: survivorGrant,
      botId,
      remoteId: `vk-del-survivor-${run}`,
    });
    // Deleted at the gateway: no remote row answers for it any more.
    fake.forget(`vk-del-${run}`);

    const outcome = await serviceFor().runSync();

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.checked).toBe(2);
    const drifts = outcome.drifted;
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      keyId: `gvk-${prefix}-del`,
      gatewayVirtualKeyId: `vk-del-${run}`,
      from: "active",
      to: "revoked",
      reasonCode: "gateway_key_deleted",
    });

    // Locally the deleted key is unavailable NOW; the healthy key is untouched.
    expect(await statusOf(`gvk-${prefix}-del`)).toBe("revoked");
    expect(await statusOf(survivor.id)).toBe("active");

    // The drift list is recorded: one append-only row names the key and why it flipped.
    const [driftRow] = await database
      .select()
      .from(gatewayKeySyncDrift)
      .where(eq(gatewayKeySyncDrift.keyId, `gvk-${prefix}-del`))
      .limit(1);
    expect(driftRow).toMatchObject({
      gatewayVirtualKeyId: `vk-del-${run}`,
      grantId,
      botId,
      fromStatus: "active",
      toStatus: "revoked",
      reasonCode: "gateway_key_deleted",
    });

    // The last success is queryable.
    const status = await serviceFor().readSyncStatus();
    expect(status.inFlight).toBe(false);
    expect(status.state.lastSuccessfulSyncAt).not.toBeNull();
    expect(status.state.consecutiveFailures).toBe(0);
    expect(status.state.lastAttemptStatus).toBe("ok");
  }, 30_000);

  test("a key the gateway disabled is revoked locally; expiry flips to expired, not revoked", async () => {
    const botId = await registeredBot("dis");
    const disabledGrant = await grant(botId, "dis");
    const expiredGrant = await grant(botId, "exp");
    const futureGrant = await grant(botId, "fut");
    await localKey({
      suffix: "dis",
      grantId: disabledGrant,
      botId,
      remoteId: `vk-dis-${run}`,
    });
    await localKey({
      suffix: "exp",
      grantId: expiredGrant,
      botId,
      remoteId: `vk-exp-${run}`,
    });
    await localKey({
      suffix: "fut",
      grantId: futureGrant,
      botId,
      remoteId: `vk-fut-${run}`,
    });
    fake.disable(`vk-dis-${run}`);
    fake.expire(`vk-exp-${run}`, new Date(Date.now() - 60_000));
    fake.expire(`vk-fut-${run}`, new Date(Date.now() + 600_000));

    const outcome = await serviceFor().runSync();

    expect(outcome.status).toBe("ok");
    expect(await statusOf(`gvk-${prefix}-dis`)).toBe("revoked");
    expect(await statusOf(`gvk-${prefix}-exp`)).toBe("expired");
    expect(await statusOf(`gvk-${prefix}-fut`)).toBe("active");
    const drifts = driftsOf(outcome);
    expect(drifts.find((d) => d.keyId === `gvk-${prefix}-dis`)).toMatchObject({
      to: "revoked",
      reasonCode: "gateway_key_disabled",
    });
    expect(drifts.find((d) => d.keyId === `gvk-${prefix}-exp`)).toMatchObject({
      to: "expired",
      reasonCode: "gateway_key_expired",
    });
    expect(drifts.find((d) => d.keyId === `gvk-${prefix}-fut`)).toBeUndefined();
  }, 30_000);

  test("sync never resurrects a locally revoked or expired key", async () => {
    const botId = await registeredBot("res");
    const revokedGrant = await grant(botId, "res-revoked");
    const expiredGrant = await grant(botId, "res-expired");
    await localKey({
      suffix: "res-revoked",
      grantId: revokedGrant,
      botId,
      remoteId: `vk-res-revoked-${run}`,
      status: "revoked",
    });
    await localKey({
      suffix: "res-expired",
      grantId: expiredGrant,
      botId,
      remoteId: `vk-res-expired-${run}`,
      status: "expired",
    });
    // The gateway still holds both keys, alive and well: OpenBot's own lifecycle
    // decisions (Q18) are not the gateway's to reverse.
    fake.activate(`vk-res-revoked-${run}`);
    fake.activate(`vk-res-expired-${run}`);

    const outcome = await serviceFor().runSync();

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.drifted).toHaveLength(0);
    expect(await statusOf(`gvk-${prefix}-res-revoked`)).toBe("revoked");
    expect(await statusOf(`gvk-${prefix}-res-expired`)).toBe("expired");
  }, 30_000);

  test("a sync creates no authorization, no credit, and imports no unknown remote key", async () => {
    const botId = await registeredBot("zero");
    const dyingGrant = await grant(botId, "zero-dying");
    const userId = `${prefix}-user-zero-dying`;
    await localKey({
      suffix: "zero-dying",
      grantId: dyingGrant,
      botId,
      remoteId: `vk-zero-${run}`,
    });
    // The gateway also holds a key OpenBot never issued (a manual key, 05.9's
    // concern): the sync must not read an authorization out of its existence.
    fake.remember(`vk-unknown-${run}`, { isActive: true });

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
    const [authBefore] = await database
      .select({ n: sql<number>`count(*)` })
      .from(accessGrants)
      .where(like(accessGrants.userId, `${prefix}-%`));
    const [keysBefore] = await database
      .select({ n: sql<number>`count(*)` })
      .from(gatewayVirtualKeys)
      .where(like(gatewayVirtualKeys.id, `gvk-${prefix}-%`));
    const [issuedBefore] = await database
      .select({ n: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "gateway.key_issued"),
          like(auditEvents.targetId, `${prefix}-%`),
        ),
      );

    fake.disable(`vk-zero-${run}`);
    const outcome = await serviceFor().runSync();
    expect(outcome.status).toBe("ok");

    // The drift landed…
    expect(await statusOf(`gvk-${prefix}-zero-dying`)).toBe("revoked");
    // …and NOTHING else was created: no grant, no ledger row, no reservation,
    // no authorization, no key record, no issuance event. The unknown remote
    // key was not imported either.
    expect(await countOf(creditGrants)).toBe(grantsBefore);
    expect(await countOf(creditLedger)).toBe(ledgerBefore);
    expect(await countOf(creditReservations)).toBe(reservationsBefore);
    const [authAfter] = await database
      .select({ n: sql<number>`count(*)` })
      .from(accessGrants)
      .where(like(accessGrants.userId, `${prefix}-%`));
    expect(Number(authAfter?.n)).toBe(Number(authBefore?.n));
    const [keysAfter] = await database
      .select({ n: sql<number>`count(*)` })
      .from(gatewayVirtualKeys)
      .where(like(gatewayVirtualKeys.id, `gvk-${prefix}-%`));
    expect(Number(keysAfter?.n)).toBe(Number(keysBefore?.n));
    const [issuedAfter] = await database
      .select({ n: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "gateway.key_issued"),
          like(auditEvents.targetId, `${prefix}-%`),
        ),
      );
    expect(Number(issuedAfter?.n)).toBe(Number(issuedBefore?.n));
    const unknown = await database
      .select({ id: gatewayVirtualKeys.id })
      .from(gatewayVirtualKeys)
      .where(eq(gatewayVirtualKeys.gatewayVirtualKeyId, `vk-unknown-${run}`));
    expect(unknown).toHaveLength(0);
  }, 30_000);

  test("a failed sync keeps the last-good statuses and the last success time, and records why", async () => {
    const botId = await registeredBot("last");
    const keepGrant = await grant(botId, "last-keep");
    const flipGrant = await grant(botId, "last-flip");
    const keeper = await localKey({
      suffix: "last-keep",
      grantId: keepGrant,
      botId,
      remoteId: `vk-last-keep-${run}`,
    });
    await localKey({
      suffix: "last-flip",
      grantId: flipGrant,
      botId,
      remoteId: `vk-last-flip-${run}`,
    });

    // First a good sync, to establish a last success worth keeping.
    const good = await serviceFor().runSync();
    expect(good.status).toBe("ok");
    const stateAfterGood: GatewayKeySyncStateRow = (
      await serviceFor().readSyncStatus()
    ).state;
    const lastGood = stateAfterGood.lastSuccessfulSyncAt;
    expect(lastGood).not.toBeNull();

    // Now the gateway goes down in several distinguishable ways. None of them
    // may move a single local status, the last success time, or go unrecorded.
    fake.stage("status-500");
    const failed500 = await serviceFor().runSync();
    expect(failed500.status).toBe("failed");
    if (failed500.status === "failed") {
      expect(failed500.stage).toBe("fetch");
      expect(failed500.reasonCode).toBe("gateway_key_sync_unexpected_status");
    }

    fake.stage("not-json");
    const failedJson = await serviceFor().runSync();
    expect(failedJson.status).toBe("failed");
    if (failedJson.status === "failed") {
      expect(failedJson.reasonCode).toBe("gateway_key_sync_invalid_response");
    }

    fake.stage("hang");
    const timingService = createGatewayKeyStateSyncService({
      database,
      store: createGatewayKeyStateStore(database),
      client: createGatewayVirtualKeyStateClient({
        readGatewayEndpoint: async () => ({
          baseUrl: endpoint.baseUrl,
          requestTimeoutMs: 150,
          configVersion: 1,
        }),
        resolveGatewayAdminCredential: async () => ({
          adminKey: "test-admin-key",
        }),
      }),
    });
    const failedTimeout = await timingService.runSync();
    expect(failedTimeout.status).toBe("failed");
    if (failedTimeout.status === "failed") {
      expect(failedTimeout.reasonCode).toBe("gateway_key_sync_timeout");
    }
    fake.stage("ok");

    // No credentials: a classified refusal, not a crash.
    const failedCredential = await serviceFor({
      resolveGatewayAdminCredential: async () => {
        throw new Error("no credential configured");
      },
    }).runSync();
    expect(failedCredential.status).toBe("failed");
    if (failedCredential.status === "failed") {
      expect(failedCredential.reasonCode).toBe(
        "gateway_key_sync_credential_unavailable",
      );
    }

    // No endpoint configured: the same, named.
    const failedEndpoint = await serviceFor({
      readGatewayEndpoint: async () => undefined,
    }).runSync();
    expect(failedEndpoint.status).toBe("failed");
    if (failedEndpoint.status === "failed") {
      expect(failedEndpoint.reasonCode).toBe(
        "gateway_key_sync_endpoint_not_configured",
      );
    }

    // Wrong credential: the gateway's own 401, classified.
    const failedAuth = await serviceFor({
      resolveGatewayAdminCredential: async () => ({ adminKey: "wrong-key" }),
    }).runSync();
    expect(failedAuth.status).toBe("failed");
    if (failedAuth.status === "failed") {
      expect(failedAuth.reasonCode).toBe("gateway_key_sync_unauthenticated");
    }

    // LAST-GOOD: every status is exactly what the good sync left…
    expect(await statusOf(keeper.id)).toBe("active");
    // …and the state row kept the success while counting the failures with
    // their most recent reason.
    const state = (await serviceFor().readSyncStatus()).state;
    expect(state.lastSuccessfulSyncAt).toBe(lastGood);
    // Six refusals — the 500, the non-JSON body, the hang past the deadline, the
    // unresolvable credential, the unconfigured endpoint and the 401 — each counted.
    expect(state.consecutiveFailures).toBe(6);
    expect(state.lastFailureReasonCode).toBe("gateway_key_sync_unauthenticated");
    expect(state.lastFailureAt).not.toBeNull();
    expect(state.lastAttemptStatus).toBe("failed");

    // And the failed runs created nothing either: this test's two keys are still
    // the only rows its own grants ever produced.
    const [keysNow] = await database
      .select({ n: sql<number>`count(*)` })
      .from(gatewayVirtualKeys)
      .where(like(gatewayVirtualKeys.id, `gvk-${prefix}-last-%`));
    expect(Number(keysNow?.n)).toBe(2);
  }, 30_000);

  test("the next good sync zeroes the failure count and moves the success time", async () => {
    const botId = await registeredBot("rec");
    const grantId = await grant(botId, "rec");
    await localKey({
      suffix: "rec",
      grantId,
      botId,
      remoteId: `vk-rec-${run}`,
    });

    fake.stage("status-500");
    expect((await serviceFor().runSync()).status).toBe("failed");
    const afterFailure = (await serviceFor().readSyncStatus()).state;
    expect(afterFailure.consecutiveFailures).toBe(1);

    fake.stage("ok");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const recovered = await serviceFor().runSync();
    expect(recovered.status).toBe("ok");
    const state = (await serviceFor().readSyncStatus()).state;
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastFailureReasonCode).toBeNull();
    expect(state.lastAttemptStatus).toBe("ok");
    expect(state.lastSuccessfulSyncAt).not.toBeNull();
    expect(state.lastSuccessfulSyncAt).not.toBe(afterFailure.lastSuccessfulSyncAt);
  }, 30_000);

  test("concurrent syncs share one run: the gateway is dialed once per key", async () => {
    const botId = await registeredBot("single");
    const grantId = await grant(botId, "single");
    await localKey({
      suffix: "single",
      grantId,
      botId,
      remoteId: `vk-single-${run}`,
    });
    fake.slow(50);

    // One service, two callers: the single-flight cell is the instance's, which is why the
    // deployment installs ONE (the on-demand trigger and the timer share it the same way).
    const service = serviceFor();
    const [first, second] = await Promise.all([
      service.runSync(),
      service.runSync(),
    ]);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status === "ok" && second.status === "ok") {
      expect(first.syncedAt).toBe(second.syncedAt);
    }
    expect(fake.readsFor(`vk-single-${run}`)).toBe(1);
    fake.slow(0);
  }, 30_000);

  test("the installed controls hand the on-demand trigger the same single-flight service", () => {
    const service = serviceFor();
    expect(gatewayKeyStateSyncControls()).toBeUndefined();
    installGatewayKeyStateSyncService(service);
    expect(gatewayKeyStateSyncControls()).toBe(service);
    installGatewayKeyStateSyncService(undefined);
    expect(gatewayKeyStateSyncControls()).toBeUndefined();
  });

  test("the cadence is configuration: default, override, and a loud refusal for nonsense", () => {
    expect(DEFAULT_KEY_STATE_SYNC_INTERVAL_MS).toBe(60_000);
    expect(gatewayKeyStateSyncIntervalConfig({})).toBe(60_000);
    expect(
      gatewayKeyStateSyncIntervalConfig({
        BIFROST_KEY_STATE_SYNC_INTERVAL_MS: "30000",
      }),
    ).toBe(30_000);
    expect(() =>
      gatewayKeyStateSyncIntervalConfig({
        BIFROST_KEY_STATE_SYNC_INTERVAL_MS: "0",
      }),
    ).toThrow("BIFROST_KEY_STATE_SYNC_INTERVAL_MS");
    expect(() =>
      gatewayKeyStateSyncIntervalConfig({
        BIFROST_KEY_STATE_SYNC_INTERVAL_MS: "soon",
      }),
    ).toThrow("BIFROST_KEY_STATE_SYNC_INTERVAL_MS");
  });
});

/**
 * A fake of the one Bifrost surface this ticket consumes: the per-key governance read
 * (`GET /api/governance/virtual-keys/{vk_id}`), with the failure modes the adapter must
 * classify. Test-only: production dials the configured endpoint, and nothing here is a
 * fallback for it.
 */
function startFakeBifrost() {
  type RemoteState = { isActive?: boolean; expiresAt?: string };
  const keys = new Map<string, RemoteState>();
  const reads = new Map<string, number>();
  let mode: "ok" | "status-500" | "not-json" | "hang" = "ok";
  let delayMs = 0;

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
      const match = url.pathname.match(/^\/api\/governance\/virtual-keys\/([^/]+)$/);
      if (request.method !== "GET" || !match) {
        return json(404, { error: "not found" });
      }
      const id = decodeURIComponent(match[1]!);
      reads.set(id, (reads.get(id) ?? 0) + 1);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (mode === "hang") await new Promise(() => {});
      if (mode === "status-500") {
        return json(500, { error: "failed to retrieve virtual key" });
      }
      if (mode === "not-json") {
        return new Response("<html>not the management api</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      const state = keys.get(id);
      if (!state) return json(404, { error: "Virtual key not found" });
      const virtualKey: Record<string, unknown> = { id };
      // A Go *bool with omitempty: absent means true, explicit false means disabled.
      if (state.isActive !== undefined) virtualKey.is_active = state.isActive;
      if (state.expiresAt !== undefined) virtualKey.expires_at = state.expiresAt;
      return json(200, { virtual_key: virtualKey });
    },
  });

  return {
    port: server.port,
    /** Present and healthy. */
    remember(id: string, state: RemoteState = {}) {
      keys.set(id, state);
    },
    /** Deleted at the gateway. */
    forget(id: string) {
      keys.delete(id);
    },
    disable(id: string) {
      keys.set(id, { ...keys.get(id), isActive: false });
    },
    activate(id: string) {
      keys.set(id, { ...keys.get(id), isActive: true });
    },
    expire(id: string, at: Date) {
      keys.set(id, { ...keys.get(id), expiresAt: at.toISOString() });
    },
    stage(next: "ok" | "status-500" | "not-json" | "hang") {
      mode = next;
    },
    slow(ms: number) {
      delayMs = ms;
    },
    readsFor(id: string) {
      return reads.get(id) ?? 0;
    },
    stop() {
      void server.stop(true);
    },
  };
}
