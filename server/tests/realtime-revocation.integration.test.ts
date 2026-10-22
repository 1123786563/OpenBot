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
 * Ticket 15.6 — 授权撤销或 Key 到期后阻止后续单元并尽力关停, on a real PostgreSQL.
 *
 *   AC-1  授权撤销后不开始新单元，且会话被尽力关停 — the grant's revocation refuses the
 *         next unit (the door's own `grant_invalid`) and CLOSES the session in the same
 *         transaction: the 0193 closed shape (`closed_at` + `close_reason`) finally
 *         written, by the verdict that earned it. Key expiry reaches this door as the
 *         same authorization family (05.8/05.7 collapse an expired or revoked credential
 *         onto the grant's unusable state), so one family, one shutdown.
 *   AC-2  关停扫尾 — the session's still-holding units move to `unknown` in the same
 *         transaction: their usage is unconfirmable BY the shutdown, the hold is kept
 *         (never released, never silently charged), and 15.7's tail settlement may still
 *         settle them when evidence arrives.
 *   AC-3  网关不可达时后续单元被拒绝 — the gateway-side posture (the Go gate treats an
 *         unreachable door as refused and latches): at THIS door the equivalent is that
 *         no later unit of a closed session is ever admitted — `session_not_open` for
 *         every key, before the door is asked.
 *   AC-4  关停不取消已发生费用的结算 — the unknowned unit's hold still settles through
 *         06.9 after the close: once, exactly as before the shutdown.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b15-319-${randomUUID().slice(0, 8)}`;
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
  createRealtimeUnitService({ database, ...readinessSeam() });

type World = {
  userId: string;
  grantId: string;
  sessionId: string;
  openBody: (unitKey: string) => Record<string, unknown>;
};

let seedCounter = 0;

/** One established session with balance for several units — the revocation fixture. */
async function seedSession(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Revocation Bot ${n}`,
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
    reason: "realtime-revocation fixture",
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
    throw new Error(`fixture session did not establish: ${JSON.stringify(establishment)}`);
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

async function sessionRow(sessionId: string) {
  const [row] = await database
    .select()
    .from(realtimeSessions)
    .where(eq(realtimeSessions.sessionId, sessionId))
    .limit(1);
  return row;
}

async function ledgerCount(world: World) {
  const rows = await database
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, `openbot-personal-${world.userId}`));
  return rows.length;
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

describe("Bifrost 15.6 (#319): revocation stops later units and shuts the session down", () => {
  test("a mid-session revocation closes the session and unknowns its holding units (AC1, AC2)", async () => {
    const world = await seedSession();
    const service = unitService();

    const first = await service.openUnit(world.openBody("unit-1"));
    if (first.status !== "reserved") throw new Error("fixture unit did not reserve");
    await service.markProcessing(first.unit.unitId);

    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, world.grantId));

    // The next unit is refused with the door's own authorization code — and the refusal
    // closes the session in the same transaction: closed_at and close_reason land through
    // the shape 0193 reserved for exactly this.
    const second = await service.openUnit(world.openBody("unit-2"));
    expect(second.status).toBe("refused");
    if (second.status !== "refused") return;
    expect(second.reasonCode).toBe("grant_invalid");

    const closed = await sessionRow(world.sessionId);
    expect(closed?.state).toBe("closed");
    expect(closed?.closedAt).not.toBeNull();
    expect(closed?.closeReason).toBe("grant_invalid");

    // The holding unit moved to unknown in the same commit: its usage is unconfirmable by
    // the shutdown, its hold is KEPT (neither released nor charged), and the row carries
    // the shutdown's own reason.
    const units = await database
      .select()
      .from(realtimeUnits)
      .where(eq(realtimeUnits.sessionId, world.sessionId))
      .orderBy(asc(realtimeUnits.createdAt));
    expect(units).toHaveLength(2);
    expect(units[0].state).toBe("unknown");
    expect(units[0].unknownReason).toBe("shutdown_tail_unconfirmed");
    expect(units[0].reservationId).not.toBeNull();
    expect(units[0].attemptId).not.toBeNull();
    expect(units[1].state).toBe("refused");
    expect(units[1].refusalReason).toBe("grant_invalid");

    // No new hold, no charge: the shutdown itself bills nothing.
    expect(await ledgerCount(world)).toBe(0);
  });

  test("a closed session admits no later unit, whatever key it arrives under (AC3)", async () => {
    const world = await seedSession();
    const service = unitService();

    await service.openUnit(world.openBody("unit-1"));
    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, world.grantId));
    await service.openUnit(world.openBody("unit-2")); // the closing refusal

    for (const key of ["unit-3", "unit-4"]) {
      const later = await service.openUnit(world.openBody(key));
      expect(later.status).toBe("refused");
      if (later.status !== "refused") return;
      expect(later.reasonCode).toBe("session_not_open");
    }

    const units = await database
      .select()
      .from(realtimeUnits)
      .where(eq(realtimeUnits.sessionId, world.sessionId));
    expect(units).toHaveLength(2);
  });

  test("the shutdown does not cancel settlement: the unknowned tail still settles once (AC4)", async () => {
    const world = await seedSession();
    const service = unitService();

    const first = await service.openUnit(world.openBody("unit-1"));
    if (first.status !== "reserved") throw new Error("fixture unit did not reserve");
    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, world.grantId));
    await service.openUnit(world.openBody("unit-2")); // the shutdown

    const settled = await settleService.settle({
      reservationId: first.reservationId,
      actualUsage: usageOf({ input: 800, output: 400 }),
      evidence: { kind: "provider_usage_report", reference: "rev-1" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-settle-1`,
    });
    expect(settled.status).toBe("settled");
    expect(await ledgerCount(world)).toBe(1);

    const replay = await settleService.settle({
      reservationId: first.reservationId,
      actualUsage: usageOf({ input: 800, output: 400 }),
      evidence: { kind: "provider_usage_report", reference: "rev-1" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-settle-2`,
    });
    expect(replay.status).toBe("settled");
    expect(await ledgerCount(world)).toBe(1);
  });

  test("an explicit close is idempotent: only an open session closes, and the reason sticks", async () => {
    const world = await seedSession();
    const units = unitService();
    await units.openUnit(world.openBody("unit-1"));

    const closed = await sessionService().close(world.sessionId, "client_disconnected");
    expect(closed?.state).toBe("closed");
    expect(closed?.closeReason).toBe("client_disconnected");

    const again = await sessionService().close(world.sessionId, "other");
    expect(again).toBeUndefined();

    const row = await sessionRow(world.sessionId);
    expect(row?.closeReason).toBe("client_disconnected");
  });
});
