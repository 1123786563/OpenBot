import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  createRealtimeSessionService,
  REALTIME_SESSION_ID_PREFIX,
} from "../src/billing/realtime-session";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount } from "../src/billing/payer";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
} from "../src/gateway/price-snapshot";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
  payerAccounts,
} from "../src/db/schema";
import {
  creditReservations,
  realtimeSessions,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 15.1 — the realtime session's fixed identity, on a real PostgreSQL
 * (TEST_DATABASE_URL).
 *
 *   AC-1  会话建立时固定 payer、授权、模型与价格版本，会话期间不变 — the row copies the
 *         grant, the SERVER-resolved payer, the model cell and both versions at
 *         establishment; a mid-flight revocation, scope closure or new price version
 *         changes the next session, never the restored row;
 *   AC-2  授权失效、门禁未就绪或模型不再开放时拒绝建立会话 — the four refusal classes
 *         (plus the price-basis ones the same door owns), each writing NO row;
 *   AC-3  会话身份持久化，断线或重启后可还原归属 — a FRESH service instance (the restart
 *         stand-in) restores the same attribution from the row alone;
 *   AC-4  会话建立本身不产生供应商计费派发 — after establishment: zero reservation rows,
 *         zero ledger rows — the money a session spends moves per unit (15.2), never here.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b15-314-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);

const V1_AMOUNTS = {
  input: "0.000001",
  output: "0.000002",
  reasoning: "0.0000003",
  image: "0.01",
  image_output: "0.02",
  audio_input: "0.0001",
  audio_output: "0.0002",
  cache_read: "0.0000001",
  cache_write: "0.0000015",
  video: "0.01",
  video_input: "0.0001",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
};

/** 03.2-shaped fixture dims: every dimension of the vocabulary priced known. */
function dimsOf(amounts: Record<string, string>) {
  const dims: Record<string, { status: "known"; amount: string }> = {};
  for (const [dimension, amount] of Object.entries(amounts)) {
    dims[dimension] = { status: "known", amount };
  }
  return dims;
}

/** The readiness seam the tests flip: a mutable deployment posture. */
function readinessSeam(initial: boolean) {
  const state = { ready: initial };
  return {
    readReadiness: async () =>
      state.ready
        ? { ready: true as const }
        : {
            ready: false as const,
            reasonCode: "gateway_readiness_gate_unavailable",
            blockingReasons: ["gateway_readiness_gate_unavailable"],
          },
    set: (ready: boolean) => {
      state.ready = ready;
    },
  };
}

type World = {
  userId: string;
  grantId: string;
  provider: string;
  model: string;
  establishBody: (overrides?: Record<string, unknown>) => Record<string, unknown>;
};

let seedCounter = 0;

async function seedWorld(
  options: { grantStatus?: "active" | "revoked"; scopeState?: "open" | "closed" } = {},
): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Realtime Bot ${n}`,
    kind: "external",
    capabilities: ["realtime"],
    status: "active",
  });
  await database.insert(accessGrants).values({
    grantId,
    userId,
    botId,
    externalIdentity: `${prefix}:ext:${n}`,
    scope: "model-access",
    status: options.grantStatus ?? "active",
    revokedAt:
      (options.grantStatus ?? "active") === "revoked" ? new Date() : null,
  });
  const { account } = await createPayerAccount(database, {
    kind: "personal",
    id: userId,
  });
  await fixtureWriter.grantCredits({
    externalCustomerId: account.externalCustomerId,
    source: "plan",
    totalCents: 10_000_00,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-seed-grant-${n}`,
  });

  await database.insert(gatewayModelCatalogRefs).values({
    provider,
    model,
    capability: "realtime",
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}` },
    configVersion: 1,
    fetchedAt: new Date(),
  });
  await createEnterpriseGatewayPriceSnapshotStore(database).appendSnapshots([
    {
      ref: { provider, model, capability: "realtime" },
      dims: dimsOf(V1_AMOUNTS) as never,
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: null,
    },
  ]);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "realtime",
    state: options.scopeState ?? "open",
    reason: "realtime-session fixture",
    changedBy: "test",
  });
  await database
    .insert(gatewayCatalogSyncState)
    .values({
      id: GATEWAY_CATALOG_SYNC_STATE_ID,
      lastSuccessfulSyncAt: new Date(Date.now() - 60 * 1000),
    })
    .onConflictDoUpdate({
      target: gatewayCatalogSyncState.id,
      set: { lastSuccessfulSyncAt: new Date(Date.now() - 60 * 1000) },
    });

  return {
    userId,
    grantId,
    provider,
    model,
    establishBody: (overrides: Record<string, unknown> = {}) => ({
      grantId,
      payer: { kind: "personal", id: userId },
      model: { provider, model, capability: "realtime" },
      snapshotVersion: 1,
      rateVersion: 0,
      ...overrides,
    }),
  };
}

/** Count this run's session rows for one grant. */
async function sessionRowCount(grantId: string): Promise<number> {
  const rows = await database
    .select({ sessionId: realtimeSessions.sessionId })
    .from(realtimeSessions)
    .where(eq(realtimeSessions.grantId, grantId));
  return rows.length;
}

afterAll(async () => {
  await database
    .delete(realtimeSessions)
    .where(like(realtimeSessions.grantId, `${prefix}%`));
  await database
    .delete(creditReservations)
    .where(
      like(creditReservations.externalCustomerId, `openbot-personal-${prefix}%`),
    );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database
    .delete(payerAccounts)
    .where(like(payerAccounts.payerId, `${prefix}%`));
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database
    .delete(gatewayModelOpenScopes)
    .where(like(gatewayModelOpenScopes.provider, `${prefix}%`));
  await database
    .delete(gatewayModelCatalogRefs)
    .where(like(gatewayModelCatalogRefs.provider, `${prefix}%`));
});

describe("Bifrost 15.1 (#314): the four establishment refusals", () => {
  test("a revoked grant refuses — 授权失效, no row written", async () => {
    const world = await seedWorld({ grantStatus: "revoked" });
    const service = createRealtimeSessionService({
      database,
      readReadiness: readinessSeam(true).readReadiness,
    });
    const outcome = await service.establish(world.establishBody());
    expect(outcome).toEqual({
      status: "refused",
      reasonCode: "grant_invalid",
      detail: { grantId: world.grantId },
    });
    expect(await sessionRowCount(world.grantId)).toBe(0);
  });

  test("a not-ready gate refuses — 门禁未就绪, the blocking reasons carried, no row", async () => {
    const world = await seedWorld();
    const seam = readinessSeam(false);
    const service = createRealtimeSessionService({
      database,
      readReadiness: seam.readReadiness,
    });
    const outcome = await service.establish(world.establishBody());
    expect(outcome).toEqual({
      status: "refused",
      reasonCode: "admission_not_ready",
      detail: {
        reasonCode: "gateway_readiness_gate_unavailable",
        blockingReasons: ["gateway_readiness_gate_unavailable"],
      },
    });
    expect(await sessionRowCount(world.grantId)).toBe(0);
  });

  test("a closed scope refuses — 模型不再开放, no row", async () => {
    const world = await seedWorld({ scopeState: "closed" });
    const service = createRealtimeSessionService({
      database,
      readReadiness: readinessSeam(true).readReadiness,
    });
    const outcome = await service.establish(world.establishBody());
    expect(outcome).toEqual({
      status: "refused",
      reasonCode: "model_not_open",
      detail: {
        provider: world.provider,
        model: world.model,
        capability: "realtime",
      },
    });
    expect(await sessionRowCount(world.grantId)).toBe(0);
  });

  test("a stale catalog refuses with 03.6's own code — no row", async () => {
    const world = await seedWorld();
    await database
      .update(gatewayCatalogSyncState)
      .set({ lastSuccessfulSyncAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID));
    const service = createRealtimeSessionService({
      database,
      readReadiness: readinessSeam(true).readReadiness,
      catalogFreshnessWindowMs: 15 * 60 * 1000,
    });
    try {
      const outcome = await service.establish(world.establishBody());
      expect(outcome.status).toBe("refused");
      if (outcome.status === "refused") {
        expect(outcome.reasonCode).toBe("catalog_stale");
      }
      expect(await sessionRowCount(world.grantId)).toBe(0);
    } finally {
      await database
        .update(gatewayCatalogSyncState)
        .set({ lastSuccessfulSyncAt: new Date(Date.now() - 60 * 1000) })
        .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID));
    }
  });

  test("an unresolvable snapshot version refuses — price_basis_not_found, no row", async () => {
    const world = await seedWorld();
    const service = createRealtimeSessionService({
      database,
      readReadiness: readinessSeam(true).readReadiness,
    });
    const outcome = await service.establish(
      world.establishBody({ snapshotVersion: 99 }),
    );
    expect(outcome).toEqual({
      status: "refused",
      reasonCode: "price_basis_not_found",
      detail: { snapshotVersion: 99 },
    });
    expect(await sessionRowCount(world.grantId)).toBe(0);
  });

  test("a mismatched payer claim refuses — payer_conflict, no row", async () => {
    const world = await seedWorld();
    const service = createRealtimeSessionService({
      database,
      readReadiness: readinessSeam(true).readReadiness,
    });
    const outcome = await service.establish(
      world.establishBody({ payer: { kind: "personal", id: "someone-else" } }),
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.reasonCode).toBe("payer_conflict");
    }
    expect(await sessionRowCount(world.grantId)).toBe(0);
  });

  test("the request-shape discipline: account-identity and company-scope fields refused on presence", async () => {
    const world = await seedWorld();
    const service = createRealtimeSessionService({
      database,
      readReadiness: readinessSeam(true).readReadiness,
    });
    for (const field of ["userId", "workspaceId", "organizationId"]) {
      const outcome = await service.establish(
        world.establishBody({ [field]: "x" }),
      );
      expect(outcome).toEqual({
        status: "refused",
        reasonCode: "request_invalid",
        detail: { field },
      });
    }
    expect(await sessionRowCount(world.grantId)).toBe(0);
  });
});

describe("Bifrost 15.1 (#314): the identity fixes at establishment", () => {
  test("establishment freezes payer/model/versions and survives mid-flight changes (AC1)", async () => {
    const world = await seedWorld();
    const service = createRealtimeSessionService({
      database,
      readReadiness: readinessSeam(true).readReadiness,
    });
    const outcome = await service.establish(world.establishBody());
    expect(outcome.status).toBe("established");
    if (outcome.status !== "established") return;
    const session = outcome.session;
    expect(session.sessionId.startsWith(REALTIME_SESSION_ID_PREFIX)).toBe(true);
    expect(session.payer).toEqual({ kind: "personal", id: world.userId });
    expect(session.model).toEqual({
      provider: world.provider,
      model: world.model,
      capability: "realtime",
    });
    expect(session.snapshotVersion).toBe(1);
    expect(session.rateVersion).toBe(0);
    expect(session.state).toBe("open");

    // 会话期间注入变更: revoke the grant, close the scope, and append a new price
    // version — the restored identity must not move on any axis.
    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, world.grantId));
    await database
      .update(gatewayModelOpenScopes)
      .set({ state: "closed" })
      .where(
        like(gatewayModelOpenScopes.provider, world.provider),
      );
    await createEnterpriseGatewayPriceSnapshotStore(database).appendSnapshots([
      {
        ref: {
          provider: world.provider,
          model: world.model,
          capability: "realtime",
        },
        dims: dimsOf({ ...V1_AMOUNTS, input: "0.000009" }) as never,
        fetchedAt: new Date().toISOString(),
        source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
        configVersion: 1,
        rateVersion: null,
      },
    ]);

    const restored = await service.restore(session.sessionId);
    expect(restored).toEqual(session);
  });

  test("a fresh service instance restores the same attribution — the restart stand-in (AC3)", async () => {
    const world = await seedWorld();
    const first = createRealtimeSessionService({
      database,
      readReadiness: readinessSeam(true).readReadiness,
    });
    const outcome = await first.establish(world.establishBody());
    expect(outcome.status).toBe("established");
    if (outcome.status !== "established") return;

    // A new instance shares nothing with the first but the row: the restored identity is
    // derived from the persisted record alone, never from process state.
    const restarted = createRealtimeSessionService({
      database,
      readReadiness: readinessSeam(true).readReadiness,
    });
    const restored = await restarted.restore(outcome.session.sessionId);
    expect(restored).toEqual(outcome.session);

    // And the row itself carries the same frozen facts a direct read sees.
    const [row] = await database
      .select()
      .from(realtimeSessions)
      .where(eq(realtimeSessions.sessionId, outcome.session.sessionId));
    expect(row.payerId).toBe(world.userId);
    expect(row.payerKind).toBe("personal");
    expect(row.model).toBe(world.model);
    expect(row.snapshotVersion).toBe(1);
    expect(row.state).toBe("open");
  });

  test("establishment produces no billing dispatch — no reservation, no ledger (AC4)", async () => {
    const world = await seedWorld();
    const service = createRealtimeSessionService({
      database,
      readReadiness: readinessSeam(true).readReadiness,
    });
    const outcome = await service.establish(world.establishBody());
    expect(outcome.status).toBe("established");
    if (outcome.status !== "established") return;

    const reservations = await database
      .select({ id: creditReservations.id })
      .from(creditReservations)
      .where(
        like(
          creditReservations.externalCustomerId,
          `openbot-personal-${prefix}%`,
        ),
      );
    expect(reservations).toHaveLength(0);
    const ledger = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(
        like(creditLedger.externalCustomerId, `openbot-personal-${prefix}%`),
      );
    expect(ledger).toHaveLength(0);
    // Exactly one identity row — and nothing else anywhere.
    expect(await sessionRowCount(world.grantId)).toBe(1);
  });
});
