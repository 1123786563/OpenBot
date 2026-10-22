import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  createRealtimeSessionService,
} from "../src/billing/realtime-session";
import {
  createRealtimeUnitService,
  REALTIME_UNIT_ID_PREFIX,
  REALTIME_UNIT_KINDS,
} from "../src/billing/realtime-unit";
import { ATTEMPT_ID_PREFIX } from "../src/billing/reservation-status";
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
  realtimeUnits,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 15.2 — the realtime billing unit, on a real PostgreSQL (TEST_DATABASE_URL).
 *
 *   AC-1  每个计费单元在处理前都有独立 attemptId 与预留 — every openUnit either takes its
 *         own hold with its own `att-` attempt identity, or refuses and holds nothing;
 *   AC-2  同一会话的多个单元共享同一账户的原子额度 — units of one session reserve through
 *         the same transactional door over the same account, and the balance arithmetic is
 *         the writer's own: when only one unit's bound fits, the second is refused;
 *   AC-3  预留失败的单元不进入处理，且不产生供应商计费输入 — a refused unit keeps its row
 *         (the recorded reason) and no reservation, no ledger row, and no processing;
 *   AC-4  单元状态可查询并支持恢复 — a fresh service instance (the restart stand-in) reads
 *         the same unit states from the rows alone.
 *
 *   plus the state machine's own flows (reserved → processing, the guarded transition) and
 *   the replay convergence one-unit-per-(session, key) pins.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b15-315-${randomUUID().slice(0, 8)}`;
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

/** The readiness seam the establishment door reads: a mutable deployment posture. */
function readinessSeam() {
  return {
    readReadiness: async () => ({ ready: true as const }),
  };
}

type World = {
  userId: string;
  grantId: string;
  provider: string;
  model: string;
  sessionId: string;
  openBody: (unitKey: string, overrides?: Record<string, unknown>) => Record<string, unknown>;
};

let seedCounter = 0;

/** One established session — the unit door's frozen admission basis. */
async function seedSession(options: {
  grantCreditsCents?: number;
  grantStatus?: "active" | "revoked";
  scopeState?: "open" | "closed";
} = {}): Promise<World> {
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
    totalCents: options.grantCreditsCents ?? 10_000_00,
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
    reason: "realtime-unit fixture",
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

  if (options.grantStatus === "revoked") {
    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, grantId));
  }

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
    throw new Error(`fixture session did not establish: ${JSON.stringify(establishment)}`);
  }

  return {
    userId,
    grantId,
    provider,
    model,
    sessionId: establishment.session.sessionId,
    openBody: (unitKey: string, overrides: Record<string, unknown> = {}) => ({
      sessionId: establishment.session.sessionId,
      unitKey,
      kind: "response",
      boundCents: 100_00,
      boundEvidence: [{ kind: "provider_max_tokens", maximumTokens: 4096 }],
      ...overrides,
    }),
  };
}

/** This run's unit rows for one session. */
async function unitRows(sessionId: string) {
  return database
    .select()
    .from(realtimeUnits)
    .where(eq(realtimeUnits.sessionId, sessionId));
}

/** This world's account key — reservations and ledger rows are scoped to it. */
function accountKey(world: World): string {
  return `openbot-personal-${world.userId}`;
}

/** One world's reservation rows — the account its session's units share. */
async function reservationRows(world: World) {
  return database
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(
      eq(creditReservations.externalCustomerId, accountKey(world)),
    );
}

async function ledgerRows(world: World) {
  return database
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, accountKey(world)));
}

const unitService = () =>
  createRealtimeUnitService({ database });

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

describe("Bifrost 15.2 (#315): independent unit attempts over one account", () => {
  test("two units each reserve with their own attempt and reservation (AC1, AC2)", async () => {
    const world = await seedSession();
    const service = unitService();

    const first = await service.openUnit(world.openBody("unit-1", { kind: "input_audio" }));
    const second = await service.openUnit(world.openBody("unit-2", { kind: "response" }));

    expect(first.status).toBe("reserved");
    expect(second.status).toBe("reserved");
    if (first.status !== "reserved" || second.status !== "reserved") return;
    // Independent attempt identities, independent holds — same account, two holds.
    expect(first.unit.unitId.startsWith(REALTIME_UNIT_ID_PREFIX)).toBe(true);
    expect(second.unit.unitId.startsWith(REALTIME_UNIT_ID_PREFIX)).toBe(true);
    expect(first.attemptId.startsWith(ATTEMPT_ID_PREFIX)).toBe(true);
    expect(second.attemptId.startsWith(ATTEMPT_ID_PREFIX)).toBe(true);
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(first.reservationId).not.toBe(second.reservationId);
    expect(first.unit.state).toBe("reserved");
    expect(second.unit.state).toBe("reserved");
    // The frozen basis echoes back: the session's own versions.
    expect(first.snapshotVersion).toBe(1);
    expect(first.rateVersion).toBe(0);

    const holds = await reservationRows(world);
    expect(holds).toHaveLength(2);
    expect((await ledgerRows(world))).toHaveLength(0);
  });

  test("balance for one unit only: the second unit is refused and holds nothing (票面步骤4, AC2, AC3)", async () => {
    // 100.00 credits granted; each unit's bound is 100.00 — exactly one fits.
    const world = await seedSession({ grantCreditsCents: 100_00 });
    const service = unitService();

    const first = await service.openUnit(world.openBody("unit-1"));
    const second = await service.openUnit(world.openBody("unit-2"));

    expect(first.status).toBe("reserved");
    expect(second.status).toBe("refused");
    if (second.status !== "refused") return;
    expect(second.reasonCode).toBe("insufficient_credits");
    expect(second.detail.maximumCredits).toBe(100_00);
    // The refused unit keeps its row as the recorded evidence — with the door's own code
    // and NO reservation beside it: the durable proof no provider input can be billed to it.
    expect(second.unit?.state).toBe("refused");
    expect(second.unit?.refusalReason).toBe("insufficient_credits");
    expect(second.unit?.reservationId).toBeNull();
    expect(second.unit?.attemptId).toBeNull();

    const holds = await reservationRows(world);
    expect(holds).toHaveLength(1);
    expect((await ledgerRows(world))).toHaveLength(0);
    // And the refused unit never reaches processing.
    const move = await service.markProcessing(second.unit!.unitId);
    expect(move?.status).toBe("not_moved");
  });

  test("the refused unit's door refusals pass through with the door's own codes (AC3)", async () => {
    const world = await seedSession();
    const service = unitService();

    // A revoked grant stops the NEXT unit — the session's identity stays frozen, the door
    // re-proves the authorization live.
    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, world.grantId));
    const revoked = await service.openUnit(world.openBody("unit-1"));
    expect(revoked.status).toBe("refused");
    if (revoked.status !== "refused") return;
    expect(revoked.reasonCode).toBe("grant_invalid");
    expect(revoked.unit?.refusalReason).toBe("grant_invalid");
    expect((await reservationRows(world))).toHaveLength(0);
    expect((await ledgerRows(world))).toHaveLength(0);
  });

  test("a mid-session scope close stops the next unit (model_not_open), the session row untouched", async () => {
    const world = await seedSession();
    const service = unitService();

    await database
      .update(gatewayModelOpenScopes)
      .set({ state: "closed" })
      .where(like(gatewayModelOpenScopes.provider, world.provider));

    const outcome = await service.openUnit(world.openBody("unit-1"));
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("model_not_open");
    // The unit row is recorded; the session's identity row is not closed by a unit refusal.
    const [sessionRow] = await database
      .select()
      .from(realtimeSessions)
      .where(eq(realtimeSessions.sessionId, world.sessionId));
    expect(sessionRow.state).toBe("open");
    expect((await reservationRows(world))).toHaveLength(0);
  });
});

describe("Bifrost 15.2 (#315): the unit state machine", () => {
  test("reserved → processing is the guarded transition; only reserved moves", async () => {
    const world = await seedSession();
    const service = unitService();

    const opened = await service.openUnit(world.openBody("unit-1"));
    expect(opened.status).toBe("reserved");
    if (opened.status !== "reserved") return;

    const moved = await service.markProcessing(opened.unit.unitId);
    expect(moved?.status).toBe("processing");
    expect(moved?.unit.state).toBe("processing");
    expect(moved?.unit.reservationId).toBe(opened.reservationId);

    // A second move refuses: the unit is already processing.
    const again = await service.markProcessing(opened.unit.unitId);
    expect(again?.status).toBe("not_moved");
    expect(again?.unit.state).toBe("processing");

    // A unit id that does not exist answers undefined, never a move.
    expect(await service.markProcessing("ru-does-not-exist")).toBeUndefined();
  });

  test("no pending state is ever observable — the insert and the outcome commit as one", async () => {
    const world = await seedSession();
    const service = unitService();
    await service.openUnit(world.openBody("unit-1"));
    await service.openUnit(world.openBody("unit-2", { boundCents: 1_000_000_00 }));
    const rows = await unitRows(world.sessionId);
    for (const row of rows) {
      expect(row.state).not.toBe("pending");
    }
  });

  test("replay converges on the original unit and its original answer (结算重放不重扣)", async () => {
    const world = await seedSession({ grantCreditsCents: 100_00 });
    const service = unitService();

    const first = await service.openUnit(world.openBody("unit-1"));
    expect(first.status).toBe("reserved");
    // The second unit exhausts the balance and is refused.
    await service.openUnit(world.openBody("unit-2"));

    // Replay the held unit's key: same unit, same ids, replay-flagged, no new hold.
    const replayHeld = await service.openUnit(world.openBody("unit-1"));
    expect(replayHeld.status).toBe("reserved");
    if (replayHeld.status === "reserved" && first.status === "reserved") {
      expect(replayHeld.unit.unitId).toBe(first.unit.unitId);
      expect(replayHeld.reservationId).toBe(first.reservationId);
      expect(replayHeld.attemptId).toBe(first.attemptId);
      expect(replayHeld.replay).toBe(true);
      // The replayed answer reads the locked versions off the hold itself.
      expect(replayHeld.snapshotVersion).toBe(1);
      expect(replayHeld.rateVersion).toBe(0);
    }

    // Replay the refused unit's key: still the recorded refusal, still no hold.
    const replayRefused = await service.openUnit(world.openBody("unit-2"));
    expect(replayRefused.status).toBe("refused");
    if (replayRefused.status !== "refused") return;
    expect(replayRefused.reasonCode).toBe("insufficient_credits");
    expect(replayRefused.unit?.reservationId).toBeNull();

    expect(await reservationRows(world)).toHaveLength(1);
    expect((await unitRows(world.sessionId))).toHaveLength(2);
  });
});

describe("Bifrost 15.2 (#315): queryable, restorable unit state (AC4)", () => {
  test("a fresh service instance restores the same unit states — the restart stand-in", async () => {
    const world = await seedSession();
    const first = unitService();
    const opened = await first.openUnit(world.openBody("unit-1"));
    const refused = await first.openUnit(world.openBody("unit-2", { boundCents: 1_000_000_00 }));
    expect(opened.status).toBe("reserved");
    expect(refused.status).toBe("refused");

    const restarted = createRealtimeUnitService({ database });
    const units = await restarted.listUnits(world.sessionId);
    expect(units).toHaveLength(2);
    // Oldest first — the held unit was opened first.
    expect(units[0]?.state).toBe("reserved");
    expect(units[0]?.attemptId).not.toBeNull();
    expect(units[1]?.state).toBe("refused");
    expect(units[1]?.attemptId).toBeNull();
    expect(units[1]?.refusalReason).not.toBeNull();

    if (opened.status !== "reserved") return;
    const single = await restarted.unitState(opened.unit.unitId);
    expect(single).toEqual(opened.unit);
  });
});

describe("Bifrost 15.2 (#315): the door's own refusal shapes", () => {
  test("a session that does not exist refuses without a row (session_not_found)", async () => {
    const service = unitService();
    const outcome = await service.openUnit({
      sessionId: "rs-no-such-session",
      unitKey: "unit-1",
      kind: "response",
      boundCents: 100_00,
      boundEvidence: [{ kind: "provider_max_tokens", maximumTokens: 4096 }],
    });
    expect(outcome).toEqual({
      status: "refused",
      unit: null,
      reasonCode: "session_not_found",
      detail: { sessionId: "rs-no-such-session" },
    });
  });

  test("a closed session admits no unit (session_not_open)", async () => {
    const world = await seedSession();
    // 15.6's close path is a later ticket; the shape is reachable directly, and the door
    // must refuse units against it the moment it exists.
    await database
      .update(realtimeSessions)
      .set({ state: "closed", closedAt: new Date(), closeReason: "test" })
      .where(eq(realtimeSessions.sessionId, world.sessionId));
    const outcome = await unitService().openUnit(world.openBody("unit-1"));
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("session_not_open");
    expect((await unitRows(world.sessionId))).toHaveLength(0);
  });

  test("the request-shape discipline: closed fields, positive bound, mechanism evidence", async () => {
    const world = await seedSession();
    const service = unitService();
    const cases: Array<[Record<string, unknown>, string]> = [
      [world.openBody("bad-1", { kind: "vibes" }), "kind"],
      [world.openBody("bad-2", { boundCents: 0 }), "boundCents"],
      [world.openBody("bad-3", { boundCents: 1.5 }), "boundCents"],
      [world.openBody("bad-4", { unitKey: "" }), "unitKey"],
      [world.openBody("bad-5", { boundEvidence: [] }), "boundEvidence"],
      [
        world.openBody("bad-6", {
          boundEvidence: [{ kind: "conservative_estimate", maximumTokens: 1000 }],
        }),
        "boundEvidence",
      ],
    ];
    for (const [body, field] of cases) {
      const outcome = await service.openUnit(body);
      expect(outcome.status).toBe("refused");
      if (outcome.status === "refused") {
        expect(outcome.reasonCode).toBe("request_invalid");
        expect(outcome.detail).toEqual({ field });
        expect(outcome.unit).toBeNull();
      }
    }
    expect(await unitRows(world.sessionId)).toHaveLength(0);
    // The whole kind set is open — every member admits.
    for (const kind of REALTIME_UNIT_KINDS) {
      const outcome = await service.openUnit(world.openBody(`kind-${kind}`, { kind }));
      expect(outcome.status).toBe("reserved");
    }
  });
});
