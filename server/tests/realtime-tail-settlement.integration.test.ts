import { randomUUID } from "node:crypto";
import { asc, eq, like, sql } from "drizzle-orm";
import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createRealtimeSessionService } from "../src/billing/realtime-session";
import { createRealtimeUnitService } from "../src/billing/realtime-unit";
import { createCreditSettleService } from "../src/billing/credit-settle";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount } from "../src/billing/payer";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  PRICE_DIMENSIONS,
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
  realtimeUnits,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 15.7 — 关停尾部费用只结算一次, on a real PostgreSQL (TEST_DATABASE_URL).
 *
 *   AC-1  关停后的尾部费用在原预留上限内结算，且只结算一次 — the tail settles through
 *         06.9 (the reservation's own fence is the money idempotency), the unit row moves
 *         to `settled` with its timestamp, and a replay — after a repeated shutdown or a
 *         repeated report — answers the FIRST result with one ledger row, ever.
 *   AC-2  尾部无法确认时进入 unknown 并保持预留 — the shutdown's unknowned units keep
 *         their holds until evidence arrives; evidence settles them from `unknown`.
 *   AC-3  尾部结算不超过原预留上限 — a tail whose exact cost exceeds the unit's bound
 *         does NOT settle: the whole unit goes `unknown` (`tail_exceeds_bound`), the hold
 *         is kept, the ledger stays empty — the overage is neither silently charged nor
 *         silently dropped (Q26: 超出部分进入 unknown，不静默追加).
 *   AC-4  无法约束尾部的上报不可结算 — only the closed evidence vocabulary may stand
 *         under a settle (06.9's own discipline, composed unchanged); anything else is a
 *         refusal that moves no money and no row.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b15-320-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE: ConversionRate = { numerator: 100n, denominator: 1n };
const settleService = createCreditSettleService({
  database,
  environmentRate: ENVIRONMENT_RATE,
});

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

const sessionService = () =>
  createRealtimeSessionService({ database, ...readinessSeam() });
const unitService = () =>
  createRealtimeUnitService({
    database,
    ...readinessSeam(),
    settle: (request: unknown) => settleService.settle(request),
    environmentRate: ENVIRONMENT_RATE,
  });

type World = {
  userId: string;
  grantId: string;
  sessionId: string;
  openBody: (unitKey: string) => Record<string, unknown>;
};

let seedCounter = 0;

async function seedSession(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Tail Bot ${n}`,
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
    state: "open",
    reason: "realtime-tail fixture",
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

  const establishment = await sessionService().establish({
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

function usageOf(quantities: Partial<Record<string, number>>) {
  const usage: Record<string, number> = {};
  for (const dimension of PRICE_DIMENSIONS) {
    usage[dimension] = quantities[dimension] ?? 0;
  }
  return usage;
}

async function unitsOf(sessionId: string) {
  return database
    .select()
    .from(realtimeUnits)
    .where(eq(realtimeUnits.sessionId, sessionId))
    .orderBy(asc(realtimeUnits.createdAt));
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

async function reservationStatus(reservationId: string) {
  const [row] = await database
    .select({ status: creditReservations.status })
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId))
    .limit(1);
  return row?.status;
}

afterAll(async () => {
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

describe("Bifrost 15.7 (#320): the shutdown tail settles once, within the bound", () => {
  test("a within-bound tail settles through 06.9 exactly once, and the replay answers it (AC1)", async () => {
    const world = await seedSession();
    const service = unitService();
    const opened = await service.openUnit(world.openBody("unit-1"));
    if (opened.status !== "reserved")
      throw new Error("fixture unit did not reserve");
    await service.markProcessing(opened.unit.unitId);

    const body = {
      unitId: opened.unit.unitId,
      actualUsage: usageOf({ input: 1_000, output: 500 }),
      evidence: { kind: "provider_usage_report", reference: "tail-1" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-tail-1`,
    };
    const settled = await service.settleUnit(body);
    expect(settled?.status).toBe("settled");
    if (settled?.status !== "settled") return;
    expect(settled.unit.state).toBe("settled");
    expect(settled.unit.settledAt).not.toBeNull();
    expect(settled.settle.reservationId).toBe(opened.reservationId);
    expect(await ledgerCount(world)).toBe(1);
    expect(await reservationStatus(opened.reservationId)).toBe("settled");

    // The repeated report answers the FIRST settlement: one ledger row, ever.
    const replay = await service.settleUnit({
      ...body,
      idempotencyKey: `${prefix}-tail-2`,
    });
    expect(replay?.status).toBe("settled");
    expect(await ledgerCount(world)).toBe(1);
    const [row] = await unitsOf(world.sessionId);
    expect(row.state).toBe("settled");
  });

  test("a shutdown-unknowned tail settles from unknown when its evidence arrives, once (AC1, AC2)", async () => {
    const world = await seedSession();
    const service = unitService();
    const opened = await service.openUnit(world.openBody("unit-1"));
    if (opened.status !== "reserved")
      throw new Error("fixture unit did not reserve");
    await service.markProcessing(opened.unit.unitId);

    // The shutdown unknowns the holding unit (15.6); the hold is kept.
    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, world.grantId));
    await service.openUnit(world.openBody("unit-2"));
    let [row] = await unitsOf(world.sessionId);
    expect(row.state).toBe("unknown");
    expect(row.unknownReason).toBe("shutdown_tail_unconfirmed");
    expect(await reservationStatus(opened.reservationId)).toBe("reserved");

    // The tail's usage report settles it FROM unknown — within the bound, exactly once.
    const settled = await service.settleUnit({
      unitId: opened.unit.unitId,
      actualUsage: usageOf({ input: 800, output: 300 }),
      evidence: {
        kind: "provider_usage_report",
        reference: "tail-after-shutdown",
      },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-tail-3`,
    });
    expect(settled?.status).toBe("settled");
    expect(await ledgerCount(world)).toBe(1);
    [row] = await unitsOf(world.sessionId);
    expect(row.state).toBe("settled");
    expect(row.unknownReason).toBeNull();

    // A repeated shutdown close (idempotent) plus a repeated report still settles once.
    await sessionService().close(world.sessionId, "grant_invalid");
    const replay = await service.settleUnit({
      unitId: opened.unit.unitId,
      actualUsage: usageOf({ input: 800, output: 300 }),
      evidence: {
        kind: "provider_usage_report",
        reference: "tail-after-shutdown",
      },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-tail-4`,
    });
    expect(replay?.status).toBe("settled");
    expect(await ledgerCount(world)).toBe(1);
  });

  test("an overage tail never settles: the unit goes unknown, the hold kept, the ledger empty (AC3)", async () => {
    const world = await seedSession();
    const service = unitService();
    const opened = await service.openUnit(world.openBody("unit-1"));
    if (opened.status !== "reserved")
      throw new Error("fixture unit did not reserve");

    // 2,000,000 input tokens at the fixture basis cost well over the 100.00 bound.
    const overage = await service.settleUnit({
      unitId: opened.unit.unitId,
      actualUsage: usageOf({ input: 2_000_000 }),
      evidence: { kind: "provider_usage_report", reference: "overage" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-overage`,
    });
    expect(overage?.status).toBe("unknown");
    if (overage?.status !== "unknown") return;
    expect(overage.reasonCode).toBe("tail_exceeds_bound");
    expect(overage.unit.state).toBe("unknown");
    expect(overage.unit.unknownReason).toBe("tail_exceeds_bound");

    // The hold is kept for the recovery (08.x) — nothing charged, nothing dropped.
    expect(await reservationStatus(opened.reservationId)).toBe("reserved");
    expect(await ledgerCount(world)).toBe(0);
  });

  test("only enforceable evidence and holding units settle — every other shape refuses (AC4)", async () => {
    const world = await seedSession();
    const service = unitService();

    // A refused unit holds nothing: its "tail" is a refusal with no money to move.
    await database.insert(gatewayModelOpenScopes).values({
      provider: `${world.grantId}-closed`,
      model: "m",
      capability: "realtime",
      state: "closed",
      reason: "fixture",
      changedBy: "test",
    });
    const opened = await service.openUnit(world.openBody("unit-1"));
    if (opened.status !== "reserved")
      throw new Error("fixture unit did not reserve");

    // An evidence kind outside the closed vocabulary is refused before anything moves.
    const badEvidence = await service.settleUnit({
      unitId: opened.unit.unitId,
      actualUsage: usageOf({ input: 10 }),
      evidence: { kind: "client_attested_usage", reference: "nope" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-bad-ev`,
    });
    expect(badEvidence?.status).toBe("refused");
    if (badEvidence?.status !== "refused") return;
    expect(badEvidence.reasonCode).toBe("request_invalid");
    expect(await ledgerCount(world)).toBe(0);

    // A usage shape the vocabulary cannot read refuses the same way.
    const badUsage = await service.settleUnit({
      unitId: opened.unit.unitId,
      actualUsage: { input: 10, made_up_dimension: 1 },
      evidence: { kind: "provider_usage_report" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-bad-use`,
    });
    expect(badUsage?.status).toBe("refused");
    expect(await ledgerCount(world)).toBe(0);

    // And a unit that does not exist answers nothing.
    const missing = await service.settleUnit({
      unitId: "ru-does-not-exist",
      actualUsage: usageOf({ input: 10 }),
      evidence: { kind: "provider_usage_report" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-missing`,
    });
    expect(missing).toBeUndefined();
  });
});
