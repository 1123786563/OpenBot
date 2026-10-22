import { randomUUID } from "node:crypto";
import { asc, eq, like, sql } from "drizzle-orm";
import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { readCapacity } from "../src/billing/capacity";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createProviderQueryRecovery } from "../src/billing/recovery-provider-query";
import { createRecoveryReplay } from "../src/billing/recovery-replay";
import {
  createRecoveryRetry,
  DEFAULT_RECOVERY_RETRY_CONFIG,
  resolveRecoveryRetryConfig,
  retryBackoffMs,
} from "../src/billing/recovery-retry";
import { createRecoveryScanner } from "../src/billing/recovery-scan";
import {
  createUsageOutbox,
  type UsageOutboxRecord,
} from "../src/billing/usage-outbox";
import { createDatabase } from "../src/db/client";
import { accessGrants, botServices, usageOutbox } from "../src/db/schema";
import {
  creditRecoveryItems,
  creditRecoveryQueries,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #279 (08.4): the background retry for unknown-dispatch recovery items, on a
 * real PostgreSQL (TEST_DATABASE_URL — the dedicated bf7 verify database, never the live
 * one).
 *
 * WHAT THE SCHEDULER IS FOR. The recovery lanes left their batch entries for "08.4's
 * scheduler" to drive; this pass is that driver: it claims DUE pending items, routes each
 * to its lane by the facts (a persisted outbox row → 08.2's replay; none → 08.5's
 * provider query where a source is wired), and — the lanes could not do this — spaces the
 * retries: every failure stamps next_retry_at = now + backoff(failure_count), the count
 * grows, and at the threshold the item leaves the automatic lanes for 08.9's manual
 * disposal queue with no next retry at all.
 *
 * WHAT THE ACs DEMAND OF THESE TESTS, AND WHERE EACH LIVES:
 *   重试按退避策略执行，failureCount 与最近原因可查询 — the controllable-clock passes below
 *     assert the exact backoff stamps (base after failure 1, base × multiplier after 2,
 *     capped) and that a pass before the stamp claims nothing; failure_count/last_reason
 *     are read straight from the item rows (the same columns the admin review answers).
 *   重试期间预留持续占用可用积分 — every failure scenario reads the reservation row (still
 *     `unknown`, never released) and readCapacity (the hold still counts against the
 *     grant) after the retries.
 *   超过阈值后进入人工处置队列 — the threshold scenario: next_retry_at is NULL, the item is
 *     still pending (the review queue's own read), and no later pass claims it.
 *   重试不产生重复结算或重复派发 — three passes over one item, two failing: exactly ONE
 *     ledger charge row, ONE reservation for the customer (no re-admission), ONE outbox
 *     row (no re-collection), the third pass converging on the first delivery's result.
 *
 * The replay's delivery effect is injectable (fail N times, then delegate to the
 * production effect) so a retry can be made to fail without standing up a broken
 * database; every fact still moves through the real tables. The provider query's witness
 * is the module's own seam (a source answering still-unknown / settled-evidence on cue).
 * No test waits on a wall clock: the scheduler's `now` is a handle the tests advance.
 *
 * RUNNER NOTE: imports `bun:test` through tests/support/bun-test-compat for the same
 * reason the other recovery suites do (src/db/client.ts's graph cannot resolve under the
 * e2e runner's Node runtime); the ticket's Verification command
 * (`bun test server/tests/recovery-retry.test.ts`) is run literally.
 *
 * Isolation: every scenario seeds its own user/bot/grant prefix; fixtures are deleted by
 * prefix in afterAll.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const outbox = createUsageOutbox(database);
const scanner = createRecoveryScanner({ database });
const prefix = `b5-279-${randomUUID().slice(0, 8)}`;

const GRANT_TOTAL = 10_000_00; // 10_000 credits, ×100

type World = {
  userId: string;
  grantId: string;
  customerKey: string;
};

let seedCounter = 0;

/** A customer with one live grant, a payer mapping, an access grant, nothing else. */
async function seedWorld(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const customerKey = `openbot-personal-${userId}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Recovery Retry Bot ${n}`,
    kind: "external",
    capabilities: ["chat"],
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
  await writer.grantCredits({
    externalCustomerId: customerKey,
    source: "plan",
    totalCents: GRANT_TOTAL,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-grant-${n}`,
  });
  return { userId, grantId, customerKey };
}

/** One hold of `maximum` over the world's account; expires in one hour. */
async function reserve(world: World, maximum: number) {
  const result = await writer.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-idem-${randomUUID().slice(0, 8)}`,
    maximumCents: maximum,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  if (!result.reserved) {
    throw new Error(`fixture reserve refused: ${JSON.stringify(result)}`);
  }
  return result.reservationId;
}

/** The crash shape's persisted half: the settlement result, in the outbox, ack lost. */
async function persistResult(input: {
  eventId: string;
  reservationId: string;
  customerKey: string;
  numerator: string;
  denominator: string;
}) {
  await outbox.record({
    eventId: input.eventId,
    source: "llm",
    externalCustomerId: input.customerKey,
    transactionId: input.eventId,
    inputTokens: 1200,
    outputTokens: 340,
    model: "gpt-4.1",
    client: "web",
    occurredAt: new Date("2026-10-18T08:00:00.000Z"),
    reservationId: input.reservationId,
    actualCostNumerator: input.numerator,
    actualCostDenominator: input.denominator,
  });
}

/** The unknown hold the scan names: 06.8's mark, then 08.1's discovery. */
async function nameUnknownHold(reservationId: string) {
  await writer.markReservationUnknown(reservationId, "dispatch_result_unknown");
  const pass = await scanner.scanOnce();
  const item = pass.items.find(
    (found) => found.reservationId === reservationId,
  );
  if (!item) {
    throw new Error("fixture scan did not name the unknown hold");
  }
  return item;
}

async function itemRow(reservationId: string) {
  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.reservationId, reservationId))
    .limit(1);
  return row ?? null;
}

async function reservationRow(reservationId: string) {
  const [row] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId))
    .limit(1);
  return row ?? null;
}

async function ledgerRows(customerKey: string) {
  return database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey))
    .orderBy(asc(creditLedger.createdAt), asc(creditLedger.id));
}

async function reservationCount(customerKey: string) {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, customerKey));
  return row?.count ?? 0;
}

async function outboxCount(reservationId: string) {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(usageOutbox)
    .where(eq(usageOutbox.reservationId, reservationId));
  return row?.count ?? 0;
}

/**
 * Test isolation: every scenario asserts its pass counters EXACTLY, but the due-read is a
 * global query — an item one test leaves pending would surface in the next test's `due`.
 * A test therefore retires its own still-pending item when it is done asserting, by
 * stamping a next_retry_at no later test's clock reaches. Items a test left resolved,
 * escalated at the same threshold, or parked on conclusive evidence are excluded from the
 * due-read by the scheduler's own gates and need nothing — this retires the rest.
 */
async function retireItem(reservationId: string) {
  await database
    .update(creditRecoveryItems)
    .set({ nextRetryAt: new Date("9999-12-31T00:00:00.000Z") })
    .where(eq(creditRecoveryItems.reservationId, reservationId));
}

/**
 * The controllable clock: the scheduler's `now` reads this value, and the tests advance
 * it between passes instead of waiting.
 */
function makeClock(startMs: number) {
  let at = startMs;
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
    set: (ms: number) => {
      at = ms;
    },
  };
}

/**
 * The replay with a counting/injectable delivery effect. `failTimes` makes the FIRST N
 * settle invocations throw the given error before delegating to the production effect —
 * the injection seam only reroutes the delivery call; every fact still moves through the
 * real tables.
 */
function makeReplay(options: { failTimes?: number; error?: Error } = {}) {
  let settleCalls = 0;
  const productionEffect = async (record: UsageOutboxRecord) => {
    const { createCreditUsageTarget } = await import(
      "../src/billing/usage-delivery"
    );
    await createCreditUsageTarget(writer)(record);
  };
  const replay = createRecoveryReplay({
    database,
    outbox,
    settle: async (record) => {
      settleCalls += 1;
      if (settleCalls <= (options.failTimes ?? 0)) {
        throw options.error ?? new Error("injected delivery failure");
      }
      await productionEffect(record);
    },
  });
  return { replay, settleCalls: () => settleCalls };
}

/**
 * The retry scheduler under test: the injected clock decides time, and a small policy
 * (base 1000ms, ×2, threshold from the scenario) keeps every stamp exactly assertable.
 */
function makeRetry(options: {
  clock: ReturnType<typeof makeClock>;
  replay: ReturnType<typeof makeReplay>["replay"];
  providerQuery?: ReturnType<typeof createProviderQueryRecovery>;
  failureThreshold?: number;
}) {
  return createRecoveryRetry({
    database,
    replay: options.replay,
    providerQuery: options.providerQuery,
    scanner,
    now: options.clock.now,
    log: () => {},
    config: {
      baseIntervalMs: 1_000,
      backoffMultiplier: 2,
      maxIntervalMs: 8_000,
      failureThreshold: options.failureThreshold ?? 5,
      batchLimit: 10,
    },
  });
}

afterAll(async () => {
  // The evidence rows' ids are minted (`crq-<hex>`), not prefixed: reach them through
  // this suite's own items before those go.
  await database.execute(
    sql`DELETE FROM credit_recovery_queries WHERE item_id IN (SELECT id FROM credit_recovery_items WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`})`,
  );
  await database
    .delete(usageOutbox)
    .where(like(usageOutbox.externalCustomerId, `openbot-personal-${prefix}%`));
  await database
    .delete(creditRecoveryItems)
    .where(
      like(
        creditRecoveryItems.externalCustomerId,
        `openbot-personal-${prefix}%`,
      ),
    );
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
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database.$client.close();
});

// ── AC1 (the pure half): the backoff policy itself ──

test("the backoff grows by the multiplier from the base and is capped", () => {
  const config = {
    ...DEFAULT_RECOVERY_RETRY_CONFIG,
    baseIntervalMs: 1_000,
    backoffMultiplier: 2,
    maxIntervalMs: 8_000,
  };
  expect(retryBackoffMs(1, config)).toBe(1_000);
  expect(retryBackoffMs(2, config)).toBe(2_000);
  expect(retryBackoffMs(3, config)).toBe(4_000);
  expect(retryBackoffMs(4, config)).toBe(8_000);
  // The cap, however many failures accumulate — never 2^1000, never Infinity.
  expect(retryBackoffMs(1_000, config)).toBe(8_000);
});

test("retryBackoffMs refuses a count that names no failure", () => {
  expect(() => retryBackoffMs(0, DEFAULT_RECOVERY_RETRY_CONFIG)).toThrow(
    TypeError,
  );
  expect(() => retryBackoffMs(1.5, DEFAULT_RECOVERY_RETRY_CONFIG)).toThrow(
    TypeError,
  );
});

test("the retry policy refuses nonsense configurations", () => {
  expect(() => resolveRecoveryRetryConfig({ baseIntervalMs: 0 })).toThrow(
    TypeError,
  );
  expect(() => resolveRecoveryRetryConfig({ backoffMultiplier: 0.5 })).toThrow(
    TypeError,
  );
  expect(() =>
    resolveRecoveryRetryConfig({ maxIntervalMs: 500, baseIntervalMs: 1_000 }),
  ).toThrow(TypeError);
  expect(() => resolveRecoveryRetryConfig({ failureThreshold: 0 })).toThrow(
    TypeError,
  );
  expect(() => resolveRecoveryRetryConfig({ batchLimit: 0 })).toThrow(
    TypeError,
  );
  expect(
    resolveRecoveryRetryConfig({ baseIntervalMs: 5_000 }).baseIntervalMs,
  ).toBe(5_000);
  expect(
    resolveRecoveryRetryConfig({ backoffMultiplier: 1 }).backoffMultiplier,
  ).toBe(1);
});

// ── AC1+AC2: a failing replay retries on the backoff, and the hold never stops occupying ──

test("a failed retry stamps the backoff, is not due before it, and stays occupied", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  const eventId = `${prefix}-evt-backoff`;
  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "67",
    denominator: "2",
  });
  await nameUnknownHold(reservationId);

  const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
  const clock = makeClock(T0);
  const { replay } = makeReplay({ failTimes: 99 });
  const retry = makeRetry({ clock, replay });

  // Pass 1 at T0: the never-failed item is due immediately; the delivery fails.
  const pass1 = await retry.runRetryPass("retry-worker-1");
  expect(pass1.due).toBe(1);
  expect(pass1.claimed).toBe(1);
  expect(pass1.replayFailed).toBe(1);
  expect(pass1.retryScheduled).toBe(1);

  const after1 = await itemRow(reservationId);
  expect(after1?.state).toBe("pending");
  expect(after1?.failureCount).toBe(1);
  expect(after1?.lastReason).toBe("delivery_failed");
  expect(after1?.nextRetryAt?.toISOString()).toBe(
    new Date(T0 + 1_000).toISOString(),
  );

  // AC2: the failed retries changed no accounting state — the hold is still `unknown`
  // and still counts against the grant's free capacity in full.
  expect((await reservationRow(reservationId))?.status).toBe("unknown");
  const capacityAfterFailure = await readCapacity(database, world.customerKey);
  expect(capacityAfterFailure.freeUnits).toBe(GRANT_TOTAL - 500);

  // A pass 1ms before the stamp claims nothing: not due yet.
  clock.set(T0 + 999);
  const early = await retry.runRetryPass("retry-worker-1");
  expect(early.due).toBe(0);
  expect(early.claimed).toBe(0);
  expect(early.skippedNoQueryLane).toBe(0);

  // Due at the stamp: the second failure spaces the NEXT attempt by base × multiplier.
  clock.set(T0 + 1_000);
  const pass2 = await retry.runRetryPass("retry-worker-1");
  expect(pass2.claimed).toBe(1);
  expect(pass2.replayFailed).toBe(1);
  expect(pass2.retryScheduled).toBe(1);

  const after2 = await itemRow(reservationId);
  expect(after2?.failureCount).toBe(2);
  expect(after2?.lastReason).toBe("delivery_failed");
  expect(after2?.nextRetryAt?.toISOString()).toBe(
    new Date(T0 + 1_000 + 2_000).toISOString(),
  );

  // Still occupied after two failed retries; nothing released, nothing re-admitted.
  expect((await reservationRow(reservationId))?.status).toBe("unknown");
  expect(await reservationCount(world.customerKey)).toBe(1);
  const capacityAfterTwo = await readCapacity(database, world.customerKey);
  expect(capacityAfterTwo.freeUnits).toBe(GRANT_TOTAL - 500);

  await retireItem(reservationId);
});

// ── AC4: retries converge on exactly one settlement, one hold, one record ──

test("repeated retries produce no duplicate settlement and no re-admission", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  const eventId = `${prefix}-evt-converge`;
  // 67/2 = 33.5 exact: the recorded rational the replay must re-deliver unchanged.
  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "67",
    denominator: "2",
  });
  await nameUnknownHold(reservationId);

  const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
  const clock = makeClock(T0);
  const { replay, settleCalls } = makeReplay({ failTimes: 2 });
  const retry = makeRetry({ clock, replay });

  // Three passes: fail, fail (backoff base then ×2), then the delivery lands.
  const pass1 = await retry.runRetryPass("retry-worker-2");
  expect(pass1.replayFailed).toBe(1);
  clock.advance(1_000);
  const pass2 = await retry.runRetryPass("retry-worker-2");
  expect(pass2.replayFailed).toBe(1);
  clock.advance(2_000);
  const pass3 = await retry.runRetryPass("retry-worker-2");
  expect(pass3.replayed).toBe(1);
  expect(pass3.replayFailed).toBe(0);

  // Every pass attempted the delivery exactly once (3 attempts), but the ledger holds
  // exactly ONE settlement row at the ORIGINAL persisted amount (67/2 → floor 33,
  // remainder 1/2): the settle converged on the first result, never a re-collection.
  expect(settleCalls()).toBe(3);
  const ledger = await ledgerRows(world.customerKey);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.credits).toBe(33);
  expect(ledger[0]?.requestId).toBe(eventId);

  // No re-admission (one reservation ever), no usage re-collection (one outbox row), and
  // the resolved item is out of every future pass.
  expect(await reservationCount(world.customerKey)).toBe(1);
  expect(await outboxCount(reservationId)).toBe(1);
  const settled = await reservationRow(reservationId);
  expect(settled?.status).toBe("settled");
  const pass4 = await retry.runRetryPass("retry-worker-2");
  expect(pass4.due).toBe(0);
});

// ── AC3: the threshold ends the retries and leaves the item to the manual queue ──

test("past the failure threshold the item enters the manual queue with no next retry", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 700);
  const eventId = `${prefix}-evt-threshold`;
  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "101",
    denominator: "4",
  });
  await nameUnknownHold(reservationId);

  const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
  const clock = makeClock(T0);
  const { replay } = makeReplay({ failTimes: 99 });
  const retry = makeRetry({ clock, replay, failureThreshold: 2 });

  const pass1 = await retry.runRetryPass("retry-worker-3");
  expect(pass1.retryScheduled).toBe(1);
  expect(pass1.escalatedToManual).toBe(0);
  clock.advance(1_000);
  const pass2 = await retry.runRetryPass("retry-worker-3");
  expect(pass2.replayFailed).toBe(1);
  expect(pass2.escalatedToManual).toBe(1);

  // The escalated item: failure_count at the threshold, NO next retry (NULL), and still
  // `pending` — which is exactly the review queue's read (state <> 'resolved') that the
  // admin surface answers with failureCount and lastReason.
  const escalated = await itemRow(reservationId);
  expect(escalated?.failureCount).toBe(2);
  expect(escalated?.lastReason).toBe("delivery_failed");
  expect(escalated?.nextRetryAt).toBeNull();
  expect(escalated?.state).toBe("pending");

  // No later pass — at any time — claims it again: the scheduler is done with this item.
  clock.advance(60 * 60_000);
  const later = await retry.runRetryPass("retry-worker-3");
  expect(later.due).toBe(0);
  expect(later.claimed).toBe(0);

  // AC2 held to the very end of the automatic lanes: the hold still occupies in full,
  // released by nothing here — only 08.9's evidenced disposal may move it.
  expect((await reservationRow(reservationId))?.status).toBe("unknown");
  const capacity = await readCapacity(database, world.customerKey);
  expect(capacity.freeUnits).toBe(GRANT_TOTAL - 700);

  // This test's threshold is 2; later scenarios schedule with 5 — retire so the
  // escalated item never shows up in their due-reads.
  await retireItem(reservationId);
});

// ── AC1/AC2 for the no-result shape: no witness wired, nothing is invented ──

test("a no-result item with no wired query lane is skipped untouched", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 300);
  // No persisted result: the dispatch died before PostLLM could write anything.
  await nameUnknownHold(reservationId);

  const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
  const clock = makeClock(T0);
  const { replay, settleCalls } = makeReplay();
  const retry = makeRetry({ clock, replay });

  const pass = await retry.runRetryPass("retry-worker-4");
  expect(pass.due).toBe(1);
  expect(pass.skippedNoQueryLane).toBe(1);
  expect(pass.claimed).toBe(0);

  // Untouched: no claim churn, no failure counted, nothing scheduled — the item waits
  // with its detection facts for a wired witness or the manual queue's dwell alerting.
  const untouched = await itemRow(reservationId);
  expect(untouched?.state).toBe("pending");
  expect(untouched?.failureCount).toBe(0);
  expect(untouched?.claimedAt).toBeNull();
  expect(untouched?.claimedBy).toBeNull();
  expect(untouched?.nextRetryAt).toBeNull();

  // No settle was attempted and the hold still occupies.
  expect(settleCalls()).toBe(0);
  expect((await reservationRow(reservationId))?.status).toBe("unknown");
  const capacity = await readCapacity(database, world.customerKey);
  expect(capacity.freeUnits).toBe(GRANT_TOTAL - 300);

  await retireItem(reservationId);
});

// ── The query lane: still-unknown counts and backs off; conclusive evidence parks the item ──

test("a still-unknown witness counts the failure and backs the next query off", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 400);
  await nameUnknownHold(reservationId);

  const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
  const clock = makeClock(T0);
  const { replay } = makeReplay();
  const answer: { conclusion: "still_unknown"; summary: string } = {
    conclusion: "still_unknown",
    summary: "no record of the request",
  };
  const providerQuery = createProviderQueryRecovery({
    database,
    source: {
      name: "fixture-witness",
      queryFinalState: async () => answer,
    },
  });
  const retry = makeRetry({ clock, replay, providerQuery });

  const pass1 = await retry.runRetryPass("retry-worker-5");
  expect(pass1.claimed).toBe(1);
  expect(pass1.queryStillUnknown).toBe(1);
  expect(pass1.retryScheduled).toBe(1);

  const after1 = await itemRow(reservationId);
  expect(after1?.failureCount).toBe(1);
  expect(after1?.lastReason).toBe("provider_still_unknown");
  expect(after1?.nextRetryAt?.toISOString()).toBe(
    new Date(T0 + 1_000).toISOString(),
  );

  // Not due before the stamp; due at it, and the second still-unknown spaces further.
  clock.set(T0 + 999);
  expect((await retry.runRetryPass("retry-worker-5")).claimed).toBe(0);
  clock.set(T0 + 1_000);
  const pass2 = await retry.runRetryPass("retry-worker-5");
  expect(pass2.queryStillUnknown).toBe(1);
  const after2 = await itemRow(reservationId);
  expect(after2?.failureCount).toBe(2);
  expect(after2?.nextRetryAt?.toISOString()).toBe(
    new Date(T0 + 1_000 + 2_000).toISOString(),
  );

  // The queries only asked; the hold is untouched and still occupying.
  expect((await reservationRow(reservationId))?.status).toBe("unknown");
  const capacity = await readCapacity(database, world.customerKey);
  expect(capacity.freeUnits).toBe(GRANT_TOTAL - 400);

  await retireItem(reservationId);
});

test("conclusive evidence parks the item for the disposal and no pass re-asks", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 200);
  await nameUnknownHold(reservationId);

  const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
  const clock = makeClock(T0);
  const { replay } = makeReplay();
  const providerQuery = createProviderQueryRecovery({
    database,
    source: {
      name: "fixture-witness",
      queryFinalState: async () => ({
        conclusion: "settled_evidence",
        usage: { input: 900, output: 110 },
        summary: "provider ledger shows the usage",
      }),
    },
  });
  const retry = makeRetry({ clock, replay, providerQuery });

  const pass1 = await retry.runRetryPass("retry-worker-6");
  expect(pass1.querySettledEvidence).toBe(1);
  expect(pass1.retryScheduled).toBe(0);

  // The evidence row exists for 08.9 to stand on; the item is pending, uncounted,
  // awaiting the disposal — NOT scheduled for another retry.
  const after = await itemRow(reservationId);
  expect(after?.state).toBe("pending");
  expect(after?.failureCount).toBe(0);
  expect(after?.lastReason).toBe("provider_settled_evidence");
  expect(after?.nextRetryAt).toBeNull();
  const [evidence] = await database
    .select()
    .from(creditRecoveryQueries)
    .where(eq(creditRecoveryQueries.itemId, after!.id))
    .limit(1);
  expect(evidence?.conclusion).toBe("settled_evidence");

  // No later pass re-asks the witness: conclusive evidence is the end of the automatic
  // lanes for this item (re-asking would only pile duplicate evidence rows).
  clock.advance(60 * 60_000);
  const pass2 = await retry.runRetryPass("retry-worker-6");
  expect(pass2.due).toBe(0);
  const evidenceCount = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(creditRecoveryQueries)
    .where(eq(creditRecoveryQueries.itemId, after!.id));
  expect(evidenceCount[0]?.count).toBe(1);

  await retireItem(reservationId);
});
