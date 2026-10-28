import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { createRealtimeSessionService } from "../src/billing/realtime-session";
import { createRealtimeUnitService } from "../src/billing/realtime-unit";
import { createCreditSettleService } from "../src/billing/credit-settle";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount } from "../src/billing/payer";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
} from "../src/gateway/price-snapshot";
import { PRICE_DIMENSIONS } from "../src/gateway/price-snapshot";
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
  realtimeUnits,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 15.5 — 余额耗尽后不开始新的付费单元, on a real PostgreSQL (TEST_DATABASE_URL).
 *
 *   AC-1  余额耗尽后不开始新的计费单元 — the balance covers exactly one unit: the second
 *         unit's open is refused insufficient_credits and the SESSION is marked stopped in
 *         the same transaction;
 *   AC-2  耗尽后供应商不会收到新的计费输入 — after the stop, every further unit open is
 *         refused `session_stopped` carrying the stop's own reason — before the reserve
 *         door is asked, so no new hold could ever cover new provider input;
 *   AC-3  耗尽原因对用户可见且与网络错误可区分 — the session record answers stoppedAt and
 *         stopReason ('insufficient_credits'), closed-set codes the recovery and user
 *         surfaces read — a balance verdict, never a transport verdict;
 *   AC-4  已发生费用的结算责任不受停止影响 — the first unit's hold settles through 06.9
 *         after the stop exactly as before it, once, with the ledger row to show.
 *
 *   停止不等于关闭：the stopped session's state stays 'open' — closing (and the closed
 *   shape 0193 reserves) is 15.6's revocation/expiry semantics, not the balance's.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b15-318-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);

/** 100 credits per USD — with the ledger's ×100 scale, 1 USD = 10 000 units. */
const ENVIRONMENT_RATE: ConversionRate = { numerator: 100n, denominator: 1n };

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

function readinessSeam() {
  return {
    readReadiness: async () => ({ ready: true as const }),
  };
}

const settleService = createCreditSettleService({
  database,
  environmentRate: ENVIRONMENT_RATE,
});

const unitService = () =>
  createRealtimeUnitService({ database, ...readinessSeam() });

type World = {
  userId: string;
  grantId: string;
  sessionId: string;
  openBody: (unitKey: string) => Record<string, unknown>;
};

let seedCounter = 0;

/** One established session whose balance covers exactly ONE unit of the fixture's bound. */
async function seedOneUnitSession(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Exhaustion Bot ${n}`,
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
    status: "active",
    revokedAt: null,
  });
  const { account } = await createPayerAccount(database, {
    kind: "personal",
    id: userId,
  });
  await fixtureWriter.grantCredits({
    externalCustomerId: account.externalCustomerId,
    source: "plan",
    totalCents: 100_00,
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
    state: "open",
    reason: "realtime-exhaustion fixture",
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

  const establishment = await createRealtimeSessionService({
    database,
    ...readinessSeam(),
  }).establish({
    grantId,
    payer: { kind: "personal", id: userId },
    model: { provider, model, capability: "realtime" },
    snapshotVersion: 1,
    rateVersion: 0,
  });
  if (establishment.status !== "established") {
    throw new Error(
      `fixture session did not establish: ${JSON.stringify(establishment)}`,
    );
  }

  return {
    userId,
    grantId,
    sessionId: establishment.session.sessionId,
    openBody: (unitKey: string) => ({
      sessionId: establishment.session.sessionId,
      unitKey,
      kind: "response",
      boundCents: 100_00,
      boundEvidence: [{ kind: "provider_max_tokens", maximumTokens: 4096 }],
    }),
  };
}

/** The usage a settled tail reports: small input/output token counts, zeros elsewhere. */
function usageOf(quantities: Partial<Record<string, number>>) {
  const usage: Record<string, number> = {};
  for (const dimension of PRICE_DIMENSIONS) {
    usage[dimension] = quantities[dimension] ?? 0;
  }
  return usage;
}

async function sessionRow(sessionId: string) {
  const [row] = await database
    .select()
    .from(realtimeSessions)
    .where(eq(realtimeSessions.sessionId, sessionId))
    .limit(1);
  return row;
}

async function reservationCount(world: World) {
  const rows = await database
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(
      eq(
        creditReservations.externalCustomerId,
        `openbot-personal-${world.userId}`,
      ),
    );
  return rows.length;
}

async function ledgerCount(world: World) {
  const rows = await database
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(
      eq(creditLedger.externalCustomerId, `openbot-personal-${world.userId}`),
    );
  return rows.length;
}

describe("Bifrost 15.5 (#318): balance exhaustion stops the session's later units", () => {
  test("exhaustion marks the session stopped; later units never reach the door (AC1, AC2)", async () => {
    const world = await seedOneUnitSession();
    const service = unitService();

    const first = await service.openUnit(world.openBody("unit-1"));
    expect(first.status).toBe("reserved");

    // The balance covered exactly one unit: the second is refused for the balance itself.
    const second = await service.openUnit(world.openBody("unit-2"));
    expect(second.status).toBe("refused");
    if (second.status !== "refused") return;
    expect(second.reasonCode).toBe("insufficient_credits");

    // The stop is a session fact, written by the refused open itself: stopped_at and
    // stop_reason land together, and the session is NOT closed (closing is 15.6's).
    const stopped = await sessionRow(world.sessionId);
    expect(stopped?.state).toBe("open");
    expect(stopped?.stoppedAt).not.toBeNull();
    expect(stopped?.stopReason).toBe("insufficient_credits");

    // Every later unit is refused by the session's own stop — before the reserve door is
    // asked, so no hold, no ledger row, and no provider input a new unit could cover.
    const third = await service.openUnit(world.openBody("unit-3"));
    expect(third.status).toBe("refused");
    if (third.status !== "refused") return;
    expect(third.reasonCode).toBe("session_stopped");
    expect(third.detail.stopReason).toBe("insufficient_credits");
    // The pre-existence refusal writes no unit row — the stopped session row is the evidence.
    expect(third.unit).toBeNull();

    const units = await database
      .select()
      .from(realtimeUnits)
      .where(eq(realtimeUnits.sessionId, world.sessionId));
    expect(units).toHaveLength(2);
    expect(await reservationCount(world)).toBe(1);
    expect(await ledgerCount(world)).toBe(0);
  });

  test("the stop reason is visible on the session record and distinguishable from transport failures (AC3)", async () => {
    const world = await seedOneUnitSession();
    const service = unitService();

    await service.openUnit(world.openBody("unit-1"));
    await service.openUnit(world.openBody("unit-2"));

    // The record the user and bot surfaces read (restore) names the balance verdict with
    // its own closed code — never a network-shaped answer for a money verdict.
    const restored = await createRealtimeSessionService({
      database,
      ...readinessSeam(),
    }).restore(world.sessionId);
    expect(restored?.state).toBe("open");
    expect(restored?.stoppedAt).toBeDefined();
    expect(restored?.stopReason).toBe("insufficient_credits");
    expect(restored?.stopReason).not.toBe("network_error");
    expect(restored?.closeReason).toBeNull();
  });

  test("fees already incurred still settle after the stop — once (AC4)", async () => {
    const world = await seedOneUnitSession();
    const service = unitService();

    const first = await service.openUnit(world.openBody("unit-1"));
    if (first.status !== "reserved")
      throw new Error("fixture unit did not reserve");
    await service.openUnit(world.openBody("unit-2")); // the stop

    const settled = await settleService.settle({
      reservationId: first.reservationId,
      actualUsage: usageOf({ input: 1000, output: 500 }),
      evidence: { kind: "provider_usage_report", reference: "resp-1" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-settle-1`,
    });
    expect(settled.status).toBe("settled");
    expect(await ledgerCount(world)).toBe(1);

    // The replay answers the FIRST settlement — the stop changed nothing about the fee.
    const replay = await settleService.settle({
      reservationId: first.reservationId,
      actualUsage: usageOf({ input: 1000, output: 500 }),
      evidence: { kind: "provider_usage_report", reference: "resp-1" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-settle-2`,
    });
    expect(replay.status).toBe("settled");
    expect(await ledgerCount(world)).toBe(1);
  });

  test("a stopped session's replay converges on the original answer — no bypass through the same key", async () => {
    const world = await seedOneUnitSession();
    const service = unitService();

    await service.openUnit(world.openBody("unit-1"));
    await service.openUnit(world.openBody("unit-2"));

    // Replaying the refused unit's own key answers ITS recorded refusal — the stop is not
    // a second chance for the same unit, and the session is not re-marked.
    const replay = await service.openUnit(world.openBody("unit-2"));
    expect(replay.status).toBe("refused");
    if (replay.status !== "refused") return;
    expect(replay.reasonCode).toBe("insufficient_credits");
    expect(replay.detail.replay).toBe(true);

    const units = await database
      .select()
      .from(realtimeUnits)
      .where(eq(realtimeUnits.sessionId, world.sessionId));
    expect(units).toHaveLength(2);
  });
});

afterAll(async () => {
  // Units go first (their session FK); they are addressed through their sessions' grants.
  await database.execute(
    sql`DELETE FROM realtime_units WHERE session_id IN (SELECT session_id FROM realtime_sessions WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database
    .delete(realtimeSessions)
    .where(like(realtimeSessions.grantId, `${prefix}%`));
  await database
    .delete(creditReservations)
    .where(
      like(
        creditReservations.externalCustomerId,
        `openbot-personal-${prefix}%`,
      ),
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
