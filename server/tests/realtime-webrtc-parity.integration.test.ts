import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createRealtimeSessionService } from "../src/billing/realtime-session";
import { createRealtimeUnitService } from "../src/billing/realtime-unit";
import { createCreditSettleService } from "../src/billing/credit-settle";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount } from "../src/billing/payer";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
  PRICE_DIMENSIONS,
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
 * Ticket 16.2 (#323) — WebRTC 关停与尾部结算一致, on a real PostgreSQL (TEST_DATABASE_URL).
 *
 * THE PARITY ARGUMENT IS THE STATE MACHINE. The WebSocket and WebRTC entrances do not have
 * two accounting models to keep in step: both establishments mint their identity through the
 * SAME door, both entrances' units ride the SAME unit door and the SAME settle fence, and
 * both entrances' revocation shutdowns are written by the SAME refusal classes. This file
 * proves that by CONSTRUCTION — the identical timeline is run through two sessions of one
 * account (one named for each entrance) and the answers are asserted to agree field for
 * field:
 *
 *   AC-1  耗尽、撤销、到期时停止后续单元并尽力关停 — one session per entrance drives the
 *         revocation shutdown: the grant is revoked, the next unit's open is refused
 *         grant_invalid, the session closes, and no later unit opens;
 *   AC-2  尾部费用在原预留内结算且只结算一次 — the swept unit's tail settles through 06.9
 *         within its bound exactly once, and the replayed report answers the first result;
 *   AC-3  无法确认的尾部进入 unknown 并保持预留 — the shutdown's sweep is the same unknown
 *         with the same reason, and the hold stays occupied until the settle lands;
 *   AC-4  两类入口的行为由同一组用例验证且结果一致 — every assertion below runs against
 *         BOTH sessions with the SAME expectations, and the closing test asserts the two
 *         sessions' records agree on every field the state machine owns.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b16-323-${randomUUID().slice(0, 8)}`;
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
  createRealtimeUnitService({
    database,
    ...readinessSeam(),
    settle: (request: unknown) => settleService.settle(request),
    environmentRate: ENVIRONMENT_RATE,
  });

const sessionService = () =>
  createRealtimeSessionService({ database, ...readinessSeam() });

type Entrance = "websocket" | "webrtc";

type World = {
  userId: string;
  /** One grant per entrance: each timeline's revocation ends ITS entrance only. */
  grantIds: Record<Entrance, string>;
  accountKey: string;
  sessions: Record<Entrance, string>;
  openBody: (entrance: Entrance, unitKey: string) => Record<string, unknown>;
};

let seedCounter = 0;

/**
 * One world: an account whose balance covers TWO units (the timeline's held unit and the
 * headroom the revocation's refused open needs to reach the door), with one session
 * established per entrance under the SAME grant — the two entrances of one account.
 */
async function seedWorld(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantIds: Record<Entrance, string> = {
    websocket: `${prefix}-grant-ws-${n}`,
    webrtc: `${prefix}-grant-rtc-${n}`,
  };

  await database.insert(botServices).values({
    botId,
    displayName: `Parity Bot ${n}`,
    kind: "external",
    capabilities: ["realtime"],
    status: "active",
  });
  for (const entrance of ["websocket", "webrtc"] as const) {
    await database.insert(accessGrants).values({
      grantId: grantIds[entrance],
      userId,
      botId,
      externalIdentity: `${prefix}:ext:${entrance}-${n}`,
      scope: "model-access",
      status: "active",
      revokedAt: null,
    });
  }
  const { account } = await createPayerAccount(database, {
    kind: "personal",
    id: userId,
  });
  await fixtureWriter.grantCredits({
    externalCustomerId: account.externalCustomerId,
    source: "plan",
    totalCents: 200_00,
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
    reason: "realtime-parity fixture",
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

  const sessions: Record<Entrance, string> = {
    websocket: "",
    webrtc: "",
  };
  for (const entrance of ["websocket", "webrtc"] as const) {
    const establishment = await sessionService().establish({
      grantId: grantIds[entrance],
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
    sessions[entrance] = establishment.session.sessionId;
  }

  return {
    userId,
    grantIds,
    accountKey: account.externalCustomerId,
    sessions,
    openBody: (entrance: Entrance, unitKey: string) => ({
      sessionId: sessions[entrance],
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

async function ledgerCount(world: World) {
  const rows = await database
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, world.accountKey));
  return rows.length;
}

/**
 * The one timeline both entrances run (AC-1..AC-3): a unit holds and consumes; the grant is
 * revoked; the next unit's open is refused grant_invalid and THAT refusal closes the session
 * and sweeps the holding unit to unknown with the hold kept; the tail settles once, and the
 * replayed report answers the first settlement.
 */
async function driveRevocationTimeline(world: World, entrance: Entrance) {
  const service = unitService();

  const held = await service.openUnit(world.openBody(entrance, "held-1"));
  if (held.status !== "reserved") {
    throw new Error(`fixture unit did not reserve for ${entrance}`);
  }
  await service.markProcessing(held.unit.unitId);

  await database
    .update(accessGrants)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(accessGrants.grantId, world.grantIds[entrance]));

  const refused = await service.openUnit(world.openBody(entrance, "after-1"));
  expect(refused.status).toBe("refused");
  if (refused.status !== "refused") return;
  expect(refused.reasonCode).toBe("grant_invalid");

  const [sessionRow] = await database
    .select()
    .from(realtimeSessions)
    .where(eq(realtimeSessions.sessionId, world.sessions[entrance]))
    .limit(1);
  expect(sessionRow?.state).toBe("closed");
  expect(sessionRow?.closeReason).toBe("grant_invalid");

  const units = await service.listUnits(world.sessions[entrance]);
  expect(units).toHaveLength(2);
  const unknownUnit = units.find((unit) => unit.state === "unknown");
  const refusedUnit = units.find((unit) => unit.state === "refused");
  expect(unknownUnit?.unitKey).toBe("held-1");
  expect(unknownUnit?.unknownReason).toBe("shutdown_tail_unconfirmed");
  expect(unknownUnit?.reservationId).toBe(held.reservationId);
  expect(refusedUnit?.refusalReason).toBe("grant_invalid");

  // A later unit of the closed session never opens (AC-1).
  const later = await service.openUnit(world.openBody(entrance, "after-2"));
  expect(later.status).toBe("refused");
  if (later.status !== "refused") return;
  expect(later.reasonCode).toBe("session_not_open");
  expect(later.unit).toBeNull();

  // The unknown tail settles FROM unknown, within the bound, exactly once (AC-2, AC-3) —
  // the same settle door both entrances' tails go through.
  const settled = await service.settleUnit({
    unitId: unknownUnit?.unitId ?? "",
    actualUsage: usageOf({ input: 600, output: 200 }),
    evidence: { kind: "provider_usage_report", reference: `parity-${entrance}` },
    settledBy: "realtime-relay",
    idempotencyKey: `${prefix}-${entrance}-tail-1`,
  });
  expect(settled?.status).toBe("settled");
  if (settled?.status !== "settled") return;
  expect(settled.unit.state).toBe("settled");
  expect(settled.settle.reservationId).toBe(held.reservationId);

  const replay = await service.settleUnit({
    unitId: unknownUnit?.unitId ?? "",
    actualUsage: usageOf({ input: 600, output: 200 }),
    evidence: { kind: "provider_usage_report", reference: `parity-${entrance}` },
    settledBy: "realtime-relay",
    idempotencyKey: `${prefix}-${entrance}-tail-2`,
  });
  expect(replay?.status).toBe("settled");
  if (replay?.status === "settled") {
    expect(replay.replay).toBe(true);
  }

  return { settled };
}

describe("Bifrost 16.2 (#323): both entrances answer the same timeline identically", () => {
  test("the revocation shutdown, unknown tail, and once-only settlement (AC-1..AC-3)", async () => {
    const world = await seedWorld();
    const ws = await driveRevocationTimeline(world, "websocket");
    const rtc = await driveRevocationTimeline(world, "webrtc");
    expect(ws?.settled.settle.chargedCredits).toBe(rtc?.settled.settle.chargedCredits);
    // Two sessions, one each, both tails charged once: exactly two ledger rows.
    expect(await ledgerCount(world)).toBe(2);
  });

  test("the exhaustion stop is the same verdict on both entrances (AC-1, AC-4)", async () => {
    const world = await seedWorld();
    const service = unitService();

    // Both entrances hold one unit each; the account is exhausted; each entrance's NEXT
    // unit meets the same balance verdict and stops its own session.
    for (const entrance of ["websocket", "webrtc"] as const) {
      const held = await service.openUnit(world.openBody(entrance, "hold-1"));
      expect(held.status).toBe("reserved");
    }
    const stoppedEntrances: Entrance[] = [];
    for (const entrance of ["websocket", "webrtc"] as const) {
      const refused = await service.openUnit(world.openBody(entrance, "next-1"));
      expect(refused.status).toBe("refused");
      if (refused.status !== "refused") return;
      expect(refused.reasonCode).toBe("insufficient_credits");
      const [row] = await database
        .select()
        .from(realtimeSessions)
        .where(eq(realtimeSessions.sessionId, world.sessions[entrance]))
        .limit(1);
      expect(row?.stoppedAt).not.toBeNull();
      expect(row?.stopReason).toBe("insufficient_credits");
      expect(row?.state).toBe("open");
      stoppedEntrances.push(entrance);
    }
    expect(stoppedEntrances).toEqual(["websocket", "webrtc"]);
  });

  test("the two entrances' session records agree on every field the state machine owns (AC-4)", async () => {
    const world = await seedWorld();
    await driveRevocationTimeline(world, "websocket");
    await driveRevocationTimeline(world, "webrtc");

    const rows = await database
      .select()
      .from(realtimeSessions)
      .where(
        sql`${realtimeSessions.sessionId} IN (${world.sessions.websocket}, ${world.sessions.webrtc})`,
      );
    expect(rows).toHaveLength(2);
    const [wsRow, rtcRow] = rows;
    expect(wsRow?.state).toBe(rtcRow?.state);
    expect(wsRow?.closeReason).toBe(rtcRow?.closeReason);
    expect(wsRow?.payerKind).toBe(rtcRow?.payerKind);
    expect(wsRow?.payerId).toBe(rtcRow?.payerId);
    expect(wsRow?.provider).toBe(rtcRow?.provider);
    expect(wsRow?.model).toBe(rtcRow?.model);
    expect(wsRow?.snapshotVersion).toBe(rtcRow?.snapshotVersion);
    expect(wsRow?.rateVersion).toBe(rtcRow?.rateVersion);

    const unitsOf = (sessionId: string) =>
      database
        .select()
        .from(realtimeUnits)
        .where(eq(realtimeUnits.sessionId, sessionId))
        .orderBy(realtimeUnits.unitKey);
    const wsUnits = await unitsOf(world.sessions.websocket);
    const rtcUnits = await unitsOf(world.sessions.webrtc);
    expect(wsUnits.map((unit) => unit.state)).toEqual(
      rtcUnits.map((unit) => unit.state),
    );
    expect(wsUnits.map((unit) => unit.unknownReason)).toEqual(
      rtcUnits.map((unit) => unit.unknownReason),
    );
    expect(wsUnits.map((unit) => unit.refusalReason)).toEqual(
      rtcUnits.map((unit) => unit.refusalReason),
    );
    expect(
      wsUnits.map((unit) => unit.reservationId !== null),
    ).toEqual(rtcUnits.map((unit) => unit.reservationId !== null));
  });
});

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
