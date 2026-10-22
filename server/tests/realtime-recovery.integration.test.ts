import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { Hono, type MiddlewareHandler } from "hono";
import { createRealtimeSessionService } from "../src/billing/realtime-session";
import { createRealtimeUnitService } from "../src/billing/realtime-unit";
import { createRealtimeUsageService } from "../src/billing/realtime-usage";
import { createCreditSettleService } from "../src/billing/credit-settle";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount } from "../src/billing/payer";
import { createBillingCreditRoutes } from "../src/billing/routes";
import { createRecoveryScanner } from "../src/billing/recovery-scan";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
  PRICE_DIMENSIONS,
} from "../src/gateway/price-snapshot";
import { createDatabase } from "../src/db/client";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
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
 * Ticket 15.8 (#321) — 断线/重启恢复与实时消费展示, on a real PostgreSQL (TEST_DATABASE_URL).
 *
 *   AC-1  断线或重启后恢复不重复派发、不重复结算 — a SECOND service instance over the same
 *         database (the restarted relay) replays a unit's own key and converges on the
 *         original row: the original attempt identity, the original hold, no second unit,
 *         and a settlement that lands once and answers its first result to every replay;
 *         a hold whose outcome nobody knows reaches the recovery through 08.x's scan — a
 *         RecoveryItem for the unit's reservation — and the restore read answers the same
 *         frozen identity without minting anything;
 *   AC-2  同一账户的两个实时会话共享原子额度 — the account's balance is one atomic pool:
 *         when session A's holds exhaust it, session B's new unit is refused
 *         insufficient_credits and B is stopped by the same verdict, while everything A
 *         already holds keeps its settlement rights;
 *   AC-3  用户看到实时会话消费、待结算额度与异常原因 — the person's own realtime sessions
 *         answer per-session consumption, the amount still awaiting settlement, and the
 *         abnormal-state reason the doors themselves wrote;
 *   AC-4  界面不泄露他人会话或账户数据 — the read is the session's own personal payer,
 *         resolved server-side; another person's sessions are never in the answer.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b15-321-${randomUUID().slice(0, 8)}`;
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

/**
 * Every service factory here is called PER TEST STEP where the step stands for a process
 * lifetime: the restart story's whole point is that a NEW instance over the SAME database
 * answers from the durable rows, not from anything it could have kept in memory.
 */
const freshUnitService = () =>
  createRealtimeUnitService({
    database,
    ...readinessSeam(),
    settle: (request: unknown) => settleService.settle(request),
    environmentRate: ENVIRONMENT_RATE,
  });
const freshSessionService = () =>
  createRealtimeSessionService({ database, ...readinessSeam() });

type World = {
  userId: string;
  grantId: string;
  accountKey: string;
  actor: AuthenticatedActor;
  provider: string;
  model: string;
  establish: () => Promise<string>;
  openBody: (sessionId: string, unitKey: string) => Record<string, unknown>;
};

let seedCounter = 0;

/**
 * One world: an active grant under a funded personal payer and an open, priced realtime
 * cell, able to establish as many sessions as the scenario asks for. `unitCents` is the
 * account's whole balance in one unit's bound, so `unitsOfBalance` units exactly exhaust it.
 */
async function seedWorld(unitsOfBalance: number): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Recovery Bot ${n}`,
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
    totalCents: 100_00 * unitsOfBalance,
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
    reason: "realtime-recovery fixture",
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
    accountKey: account.externalCustomerId,
    actor: { id: userId, email: `${userId}@openbot.test`, role: "user" },
    provider,
    model,
    establish: async () => {
      const establishment = await freshSessionService().establish({
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
      return establishment.session.sessionId;
    },
    openBody: (sessionId: string, unitKey: string) => ({
      sessionId,
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

async function ledgerCount(world: World) {
  const rows = await database
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, world.accountKey));
  return rows.length;
}

async function unitsOfSession(sessionId: string) {
  return database
    .select()
    .from(realtimeUnits)
    .where(eq(realtimeUnits.sessionId, sessionId));
}

describe("Bifrost 15.8 (#321): a restart restores without re-dispatching or re-settling", () => {
  test("a restarted relay replays the unit's own key onto the original hold (AC1)", async () => {
    const world = await seedWorld(1);
    const beforeRestart = freshUnitService();
    const sessionId = await world.establish();

    const opened = await beforeRestart.openUnit(world.openBody(sessionId, "unit-1"));
    if (opened.status !== "reserved") throw new Error("fixture unit did not reserve");

    // The restart: a NEW service instance, the same durable rows. The replay of the same
    // unit key answers the ORIGINAL unit — same attempt, same hold — and mints nothing.
    const afterRestart = freshUnitService();
    const replay = await afterRestart.openUnit(world.openBody(sessionId, "unit-1"));
    expect(replay.status).toBe("reserved");
    if (replay.status !== "reserved") return;
    expect(replay.replay).toBe(true);
    expect(replay.unit.unitId).toBe(opened.unit.unitId);
    expect(replay.attemptId).toBe(opened.attemptId);
    expect(replay.reservationId).toBe(opened.reservationId);
    expect(await unitsOfSession(sessionId)).toHaveLength(1);
    expect(await ledgerCount(world)).toBe(0);

    // The settlement lands once through the restarted instance, and the replayed report
    // answers the first settlement — one charge, ever (不重复结算).
    const settled = await afterRestart.settleUnit({
      unitId: opened.unit.unitId,
      actualUsage: usageOf({ input: 1_000, output: 500 }),
      evidence: { kind: "provider_usage_report", reference: "restart-tail-1" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-restart-tail-1`,
    });
    expect(settled?.status).toBe("settled");
    const replayedSettle = await afterRestart.settleUnit({
      unitId: opened.unit.unitId,
      actualUsage: usageOf({ input: 1_000, output: 500 }),
      evidence: { kind: "provider_usage_report", reference: "restart-tail-1" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-restart-tail-2`,
    });
    expect(replayedSettle?.status).toBe("settled");
    if (replayedSettle?.status === "settled") {
      expect(replayedSettle.replay).toBe(true);
    }
    expect(await ledgerCount(world)).toBe(1);
  });

  test("the restore read answers the same frozen identity and mints nothing (AC1)", async () => {
    const world = await seedWorld(1);
    const sessionId = await world.establish();
    const service = freshUnitService();
    await service.openUnit(world.openBody(sessionId, "unit-1"));

    // A restarted relay's first read is the restore: the identity the establishment froze —
    // payer, model cell, both locked versions — answered unchanged, with no new rows.
    const restored = await freshSessionService().restore(sessionId);
    expect(restored?.sessionId).toBe(sessionId);
    expect(restored?.grantId).toBe(world.grantId);
    expect(restored?.payer).toEqual({ kind: "personal", id: world.userId });
    expect(restored?.model).toEqual({
      provider: world.provider,
      model: world.model,
      capability: "realtime",
    });
    expect(restored?.snapshotVersion).toBe(1);
    expect(restored?.rateVersion).toBe(0);
    expect(await unitsOfSession(sessionId)).toHaveLength(1);

    const units = await freshUnitService().listUnits(sessionId);
    expect(units).toHaveLength(1);
    expect(units[0]?.unitKey).toBe("unit-1");
  });

  test("an unanswered hold reaches the recovery through 08.x's scan, as a realtime item (AC1)", async () => {
    const world = await seedWorld(1);
    const sessionId = await world.establish();
    const service = freshUnitService();
    const opened = await service.openUnit({
      ...world.openBody(sessionId, "crash-1"),
      // A hold whose expiry the scan's clock has already passed: the killed-mid-flight
      // shape (the relay died between the hold and any settle), never an in-flight one.
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
    });
    if (opened.status !== "reserved") throw new Error("fixture unit did not reserve");
    await service.markProcessing(opened.unit.unitId);

    const scanner = createRecoveryScanner({
      database,
      // The scan runs "later": the hold's five seconds are behind the scan's clock.
      now: () => new Date(Date.now() + 60_000),
    });
    const pass = await scanner.scanOnce();
    const mine = pass.items.filter(
      (item) => item.reservationId === opened.reservationId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.capability).toBe("realtime");
    expect(mine[0]?.payerRef.externalCustomerId).toBe(world.accountKey);
    expect(mine[0]?.state).toBe("pending");

    // The recovery names the EXISTING hold; it does not mint a second unit for the session
    // and the unit rows the restore replays are unchanged (恢复走 08.x，不新建单元).
    expect(await unitsOfSession(sessionId)).toHaveLength(1);
  });
});

describe("Bifrost 15.8 (#321): two sessions of one account share the atomic quota (AC2)", () => {
  test("one session's holds exhaust the account; the other's new unit is refused and it stops", async () => {
    const world = await seedWorld(1);
    const sessionIdA = await world.establish();
    const sessionIdB = await world.establish();
    const service = freshUnitService();

    // Session A takes the account's whole balance as its hold.
    const aFirst = await service.openUnit(world.openBody(sessionIdA, "a-1"));
    expect(aFirst.status).toBe("reserved");

    // Session B — a different session id, the SAME account — asks for its own unit and the
    // answer is the balance's: refused insufficient_credits, holding nothing, and B is
    // stopped by the same verdict (一个耗尽会影响另一个的新单元).
    const bFirst = await service.openUnit(world.openBody(sessionIdB, "b-1"));
    expect(bFirst.status).toBe("refused");
    if (bFirst.status !== "refused") return;
    expect(bFirst.reasonCode).toBe("insufficient_credits");
    expect(bFirst.unit?.state).toBe("refused");
    expect(bFirst.unit?.refusalReason).toBe("insufficient_credits");

    const [bRow] = await database
      .select()
      .from(realtimeSessions)
      .where(eq(realtimeSessions.sessionId, sessionIdB))
      .limit(1);
    expect(bRow?.stoppedAt).not.toBeNull();
    expect(bRow?.stopReason).toBe("insufficient_credits");
    expect(bRow?.state).toBe("open"); // stopped, not closed — closing is 15.6's.

    // A's own next unit meets the same balance verdict — the account is one pool, reached
    // by both sessions through the same customer-lock serialization — and THIS refusal is
    // the one that stops A (the stop is written by the session's own refused open).
    const aSecond = await service.openUnit(world.openBody(sessionIdA, "a-2"));
    expect(aSecond.status).toBe("refused");
    if (aSecond.status !== "refused") return;
    expect(aSecond.reasonCode).toBe("insufficient_credits");
    const [aRow] = await database
      .select()
      .from(realtimeSessions)
      .where(eq(realtimeSessions.sessionId, sessionIdA))
      .limit(1);
    expect(aRow?.stoppedAt).not.toBeNull();

    // With A now stopped, its own later units answer the session's stop — never a second
    // door call.
    const aThird = await service.openUnit(world.openBody(sessionIdA, "a-3"));
    expect(aThird.status).toBe("refused");
    if (aThird.status !== "refused") return;
    expect(aThird.reasonCode).toBe("session_stopped");

    // What A already holds keeps its settlement rights exactly as before the competition.
    if (aFirst.status !== "reserved") return;
    const settled = await service.settleUnit({
      unitId: aFirst.unit.unitId,
      actualUsage: usageOf({ input: 800, output: 400 }),
      evidence: { kind: "provider_usage_report", reference: "duel-a-1" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-duel-a-1`,
    });
    expect(settled?.status).toBe("settled");
    expect(await ledgerCount(world)).toBe(1);
  });
});

/* The route harness for the view: the session guard as a switch, the same shape the
 * credit-views suite pins, so the boundary being tested is the route's own rule — the
 * account is the session's, never a parameter. */
function requireUserAs(actor: AuthenticatedActor | undefined) {
  const middleware: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    if (!actor) {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", actor);
    await next();
  };
  return middleware;
}

function viewApp(actor: AuthenticatedActor | undefined) {
  return new Hono<{ Variables: AppVariables }>().route(
    "/api/billing",
    createBillingCreditRoutes({
      credits: createCredits({
        database,
        externalCustomerKey: `openbot-deployment-${prefix}`,
        catalog: new Map(),
      }),
      requireUser: requireUserAs(actor),
      realtimeUsage: createRealtimeUsageService({ database }),
    }),
  );
}

type ViewSession = {
  sessionId: string;
  state: "open" | "closed";
  stopped: boolean;
  closed: boolean;
  abnormal: { kind: string; reason: string } | null;
  units: { settled: number; holding: number; unknown: number; refused: number };
  consumedCents: number;
  pendingCents: number;
};

async function readSessions(
  actor: AuthenticatedActor,
): Promise<{ status: number; body: { sessions?: ViewSession[]; error?: string } }> {
  const response = await viewApp(actor).request(
    "/api/billing/credits/realtime-sessions",
  );
  return { status: response.status, body: await response.json() };
}

describe("Bifrost 15.8 (#321): the person sees their realtime sessions' money and abnormal state (AC3, AC4)", () => {
  test("consumption, pending, and the doors' own reasons are visible — to the owner only", async () => {
    const owner = await seedWorld(2);
    const other = await seedWorld(1);
    const sessionIdA = await owner.establish();
    const sessionIdB = await owner.establish();
    const service = freshUnitService();

    // A takes the whole account as two holds; B — same account — is then stopped by the
    // balance; A settles one unit from processing; the grant is revoked and the next open's
    // authorization refusal closes A and sweeps the still-holding unit to unknown — the
    // 15.6 shutdown, driven the way production drives it.
    const a1 = await service.openUnit(owner.openBody(sessionIdA, "v-a-1"));
    if (a1.status !== "reserved") throw new Error("fixture unit did not reserve");
    await service.markProcessing(a1.unit.unitId);

    const a2 = await service.openUnit(owner.openBody(sessionIdA, "v-a-2"));
    if (a2.status !== "reserved") throw new Error("fixture unit did not reserve");
    await service.markProcessing(a2.unit.unitId);

    // B — same account — is stopped by the balance A's holds exhausted.
    const b1 = await service.openUnit(owner.openBody(sessionIdB, "v-b-1"));
    expect(b1.status).toBe("refused");

    const a1Settled = await service.settleUnit({
      unitId: a1.unit.unitId,
      actualUsage: usageOf({ input: 900, output: 300 }),
      evidence: { kind: "provider_usage_report", reference: "view-a-1" },
      settledBy: "realtime-relay",
      idempotencyKey: `${prefix}-view-a-1`,
    });
    expect(a1Settled?.status).toBe("settled");

    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, owner.grantId));
    const a3 = await service.openUnit(owner.openBody(sessionIdA, "v-a-3"));
    expect(a3.status).toBe("refused");
    if (a3.status !== "refused") return;
    expect(a3.reasonCode).toBe("grant_invalid");

    // The amounts the view must agree with: read them off the rows the doors wrote, so
    // the assertion is an agreement between two reads, not a restatement of one.
    const [a2Row] = await database
      .select({ maximum: creditReservations.maximum, charged: creditReservations.charged })
      .from(creditReservations)
      .where(eq(creditReservations.id, a2.reservationId))
      .limit(1);
    const [a1Row] = await database
      .select({ charged: creditReservations.charged })
      .from(creditReservations)
      .where(eq(creditReservations.id, a1.reservationId))
      .limit(1);
    expect(a1Row?.charged).not.toBeNull();

    const ownerView = await readSessions(owner.actor);
    expect(ownerView.status).toBe(200);
    const sessions = ownerView.body.sessions ?? [];
    expect(sessions).toHaveLength(2);
    const viewA = sessions.find((s) => s.sessionId === sessionIdA);
    const viewB = sessions.find((s) => s.sessionId === sessionIdB);
    expect(viewA).toBeDefined();
    expect(viewB).toBeDefined();
    if (!viewA || !viewB) return;

    // Session A: closed by the revocation (the door's own code), one settled unit whose
    // charge the view sums, one unknown tail whose ceiling stays occupied (待结算), one
    // refused row that held nothing.
    expect(viewA.state).toBe("closed");
    expect(viewA.abnormal?.kind).toBe("closed");
    expect(viewA.abnormal?.reason).toBe("grant_invalid");
    expect(viewA.units).toEqual({ settled: 1, holding: 0, unknown: 1, refused: 1 });
    expect(viewA.consumedCents).toBe(a1Row?.charged);
    expect(viewA.pendingCents).toBe(a2Row?.maximum);

    // Session B: stopped by the balance, refusing its own unit — a money verdict, never a
    // transport verdict, in the reason the page reads.
    expect(viewB.state).toBe("open");
    expect(viewB.stopped).toBe(true);
    expect(viewB.abnormal?.kind).toBe("stopped");
    expect(viewB.abnormal?.reason).toBe("insufficient_credits");
    expect(viewB.units).toEqual({ settled: 0, holding: 0, unknown: 0, refused: 1 });
    expect(viewB.consumedCents).toBe(0);
    expect(viewB.pendingCents).toBe(0);

    // The other person's view answers their own account: none of these sessions, and no
    // error dressing the emptiness up (AC4 — 不泄露他人会话或账户数据).
    const otherView = await readSessions(other.actor);
    expect(otherView.status).toBe(200);
    const otherIds = (otherView.body.sessions ?? []).map((s) => s.sessionId);
    expect(otherIds).not.toContain(sessionIdA);
    expect(otherIds).not.toContain(sessionIdB);

    // An unauthenticated ask is refused before any read.
    const anonymous = await viewApp(undefined).request(
      "/api/billing/credits/realtime-sessions",
    );
    expect(anonymous.status).toBe(401);
  });

  test("a request that names an account is answered 400, never a filtered answer (AC4)", async () => {
    const world = await seedWorld(1);
    const response = await viewApp(world.actor).request(
      "/api/billing/credits/realtime-sessions?userId=someone-else",
    );
    expect(response.status).toBe(400);
  });

  test("an account with no realtime sessions answers an empty list, not an error", async () => {
    const world = await seedWorld(1);
    const view = await readSessions(world.actor);
    expect(view.status).toBe(200);
    expect(view.body.sessions).toEqual([]);
  });
});

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_recovery_items WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM realtime_units WHERE session_id IN (SELECT session_id FROM realtime_sessions WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database
    .delete(realtimeSessions)
    .where(like(realtimeSessions.grantId, `${prefix}%`));
  await database
    .delete(creditReservations)
    .where(like(creditReservations.externalCustomerId, `openbot-personal-${prefix}%`));
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
