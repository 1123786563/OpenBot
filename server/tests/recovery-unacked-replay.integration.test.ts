import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { asc, eq, like, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createRecoveryScanner } from "../src/billing/recovery-scan";
import { createRecoveryReplay } from "../src/billing/recovery-replay";
import { createUsageDelivery } from "../src/billing/usage-delivery";
import {
  createUsageOutbox,
  type UsageOutboxRecord,
} from "../src/billing/usage-outbox";
import { createDatabase } from "../src/db/client";
import { accessGrants, botServices, usageOutbox } from "../src/db/schema";
import {
  creditRecoveryItems,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

/*
 * Bifrost #277 (08.2): the recovery branch for a result that was PERSISTED but whose
 * delivery was never ACKED, on a real PostgreSQL (TEST_DATABASE_URL — the dedicated 5594
 * verify database, never the live one).
 *
 * THE CRASH SHAPE THIS HANDLES. The PostLLM settlement wrote its result to the usage
 * outbox (07.8: eventId + reservationId + the exact actual cost) and the process died
 * before the delivery sweeper could settle the hold and ack the row. The hold is left
 * occupying credit with nobody holding the thread, so the 08.1 scan names it a
 * RecoveryItem. THIS module is the recovery action for that item: re-deliver the SAME
 * persisted result to Settle under the SAME idempotency key — never re-collecting usage,
 * never re-dispatching a provider attempt — so the ledger converges on exactly ONE
 * settlement at the original amount, the outbox row is acked, and the item is resolved.
 *
 * THE CONVERGENCE IS THE POINT. settleReservation (06.x) treats `settled` as terminal:
 * replaying the same actual returns the first result, so a replay racing a delayed first
 * delivery — or an ack lost after the settle landed (08.3's shape) — still leaves exactly
 * one ledger entry. A different actual, or a released hold, is a real conflict: the item
 * is retained (never lost) with failure_count incremented and the stable conflict kind as
 * its lastReason.
 *
 * HOW IT IS PROVED HERE. Everything runs against the real tables; one scenario drives the
 * replay through a REAL second process (tests/support/recovery-replay-worker.ts) to prove
 * the handler is persistence-driven, not module memory. The delivery effect is injectable
 * so the tests can count settle invocations (duplicate-delivery suppression) and inject
 * one transient failure (retention + later convergence); the injected wrapper delegates to
 * the production effect — `createCreditUsageTarget(createCreditWriter(database))` — the
 * exact call the first delivery used.
 *
 * Isolation: every scenario seeds its own user/bot/grant prefix and the fixtures are
 * deleted by prefix in afterAll. No test waits on a wall clock: unknown marks name the
 * hold immediately, and expiry paths move the row's own `expires_at` into the past.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const outbox = createUsageOutbox(database);
const scanner = createRecoveryScanner({ database });
const prefix = `b5-277-${randomUUID().slice(0, 8)}`;
const workerScript = join(hereDir, "support", "recovery-replay-worker.ts");

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
    displayName: `Unacked Replay Bot ${n}`,
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

/**
 * The crash shape's first half: the PostLLM settlement's result, persisted to the outbox
 * (07.8) with the reservation identity and the exact actual cost. The credits target
 * stays `pending` — the ack is what the crash lost.
 */
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

/** The recovery item the scan named for a reservation, or null. */
async function recoveryItemRow(reservationId: string) {
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

async function outboxRow(eventId: string) {
  const [row] = await database
    .select()
    .from(usageOutbox)
    .where(eq(usageOutbox.eventId, eventId))
    .limit(1);
  return row ?? null;
}

/** How many reservation rows exist for one customer: a replay that re-admitted would add one. */
async function reservationCount(customerKey: string) {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, customerKey));
  return row?.count ?? 0;
}

/**
 * The replay with a counting/injectable delivery effect. `failFirst` makes the FIRST
 * settle invocation throw the given error before delegating to the production effect —
 * the injection seam only reroutes the delivery call; every fact still moves through the
 * real tables.
 */
function makeReplay(options: { failFirst?: Error } = {}) {
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
      if (options.failFirst && settleCalls === 1) throw options.failFirst;
      await productionEffect(record);
    },
  });
  return { replay, settleCalls: () => settleCalls };
}

/**
 * Park an item this scenario deliberately leaves retained (`pending` by design). Claiming
 * it takes it off the pending queue — which is what a real coordinator does when a worker
 * owns a retained item — so later scenarios' batches claim exactly their own slice.
 */
async function parkRetainedItem(reservationId: string, owner: string) {
  const item = await recoveryItemRow(reservationId);
  if (!item) throw new Error(`fixture item missing for ${reservationId}`);
  const parked = await scanner.claimRecoveryItem(item.id, owner);
  if (!parked) throw new Error(`fixture park refused for ${item.id}`);
}

/** One real subprocess run: 08.2's replay worker, or 08.1's scan worker for `scan`. */
function runWorkerInSubprocess(...args: string[]): Promise<string> {
  const script =
    args[0] === "scan"
      ? join(hereDir, "support", "recovery-scan-worker.ts")
      : workerScript;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`worker exited ${code}: ${err || out}`));
    });
  });
}

afterAll(async () => {
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

// ── AC1+AC2: persisted result, ack lost → replayed once, one settlement, original amount ──

test("a result persisted but never acked is replayed to exactly one settlement at the original amount", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  const eventId = `${prefix}-evt-1`;
  // The result was persisted (67/2 = 33.5 exact) and the process died before delivery.
  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "67",
    denominator: "2",
  });
  // The dead process never marked the hold; recovery names it (the unknown-mark shape).
  await writer.markReservationUnknown(reservationId, "dispatch_result_unknown");
  const scanPass = await scanner.scanOnce();
  expect(
    scanPass.items.some((item) => item.reservationId === reservationId),
  ).toBe(true);

  const { replay } = makeReplay();
  const batch = await replay.replayUnackedResults("worker-a", 10);

  expect(batch).toMatchObject({ claimed: 1, replayed: 1, failed: 0 });

  // AC2: exactly ONE settlement, at the ORIGINAL persisted amount (67/2 → floor 33,
  // remainder 1/2) — the replay settled from the persisted facts, not a re-collection.
  const ledger = await ledgerRows(world.customerKey);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.credits).toBe(33);
  expect(ledger[0]?.requestId).toBe(eventId);
  const reservation = await reservationRow(reservationId);
  expect(reservation?.status).toBe("settled");
  expect(reservation?.actualNumerator).toBe("67");
  expect(reservation?.actualDenominator).toBe("2");
  expect(reservation?.charged).toBe(33);
  expect(reservation?.remainderNumerator).toBe("1");
  expect(reservation?.remainderDenominator).toBe("2");
  // AC1 (no re-collection, no re-admission): the replay never minted a second attempt —
  // the customer still has exactly one reservation, the original one.
  expect(await reservationCount(world.customerKey)).toBe(1);

  // The ack the crash lost is now written.
  const record = await outboxRow(eventId);
  expect(record?.creditsStatus).toBe("delivered");

  // The item is resolved, not lost and not reprocessable.
  const item = await recoveryItemRow(reservationId);
  expect(item?.state).toBe("resolved");
  expect(item?.failureCount).toBe(0);
  expect(item?.lastReason).toBe("result_replayed_delivered");

  // A second pass has nothing to claim: a resolved item is never re-delivered.
  const second = await replay.replayUnackedResults("worker-a", 10);
  expect(second.claimed).toBe(0);
  expect(await ledgerRows(world.customerKey)).toHaveLength(1);
});

// ── AC3: an already-confirmed delivery is never re-delivered ──────────────────────────

test("a record already delivered to credits is not re-delivered; the item resolves as already-delivered", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 400);
  const eventId = `${prefix}-evt-2`;
  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "50",
    denominator: "1",
  });
  // The scan named the hold while it was unknown; THEN the first delivery completed.
  await writer.markReservationUnknown(reservationId, "stream_error");
  await scanner.scanOnce();
  const delivery = createUsageDelivery({
    outbox,
    sendToLago: async () => {},
    chargeCredits: async (record) => {
      const { createCreditUsageTarget } = await import(
        "../src/billing/usage-delivery"
      );
      await createCreditUsageTarget(writer)(record);
    },
  });
  await delivery.runBatch(10);
  expect((await outboxRow(eventId))?.creditsStatus).toBe("delivered");
  const ledgerAfterFirst = await ledgerRows(world.customerKey);
  expect(ledgerAfterFirst).toHaveLength(1);

  const { replay, settleCalls } = makeReplay();
  const batch = await replay.replayUnackedResults("worker-b", 10);

  expect(batch).toMatchObject({ claimed: 1, replayed: 0, failed: 0 });
  // AC3: ZERO settle invocations for an already-delivered record.
  expect(settleCalls()).toBe(0);
  expect(await ledgerRows(world.customerKey)).toHaveLength(1);
  const item = await recoveryItemRow(reservationId);
  expect(item?.state).toBe("resolved");
  expect(item?.lastReason).toBe("result_already_delivered");
});

// ── AC4: a failed replay retains the RecoveryItem and counts the failure ──────────────

test("a replay conflict retains the item as pending with the failure counted and named", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 300);
  const eventId = `${prefix}-evt-3`;
  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "80",
    denominator: "1",
  });
  await writer.markReservationUnknown(reservationId, "dispatch_result_unknown");
  await scanner.scanOnce();

  // An evidenced disposal raced the replay: the hold was released out from under it.
  await writer.releaseUnknownReservation(reservationId, "no_cost_evidence");

  const { replay } = makeReplay();
  const batch = await replay.replayUnackedResults("worker-c", 10);

  expect(batch).toMatchObject({ claimed: 1, replayed: 0, failed: 1 });
  // The item is RETAINED — pending again, failure counted, stable conflict kind named.
  const item = await recoveryItemRow(reservationId);
  expect(item).not.toBeNull();
  expect(item?.state).toBe("pending");
  expect(item?.failureCount).toBe(1);
  expect(item?.lastReason).toBe("reservation_released");
  // No money moved, and the outbox row's own attempt bookkeeping saw the failure.
  expect(await ledgerRows(world.customerKey)).toHaveLength(0);
  const record = await outboxRow(eventId);
  expect(record?.creditsStatus).toBe("pending");
  expect(record?.creditsAttempts).toBe(1);
  expect(record?.creditsLastErrorCode).toBe("reservation_released");

  // Park the retained item: a later scenario's pass must not churn it (a real worker
  // would own it while deciding the disposal).
  await parkRetainedItem(reservationId, "park-worker-c");
});

test("a transient replay failure is retained, then a later pass converges to one settlement", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 300);
  const eventId = `${prefix}-evt-4`;
  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "25",
    denominator: "1",
  });
  await writer.markReservationUnknown(reservationId, "dispatch_result_unknown");
  await scanner.scanOnce();

  const { UsageDeliveryError } = await import(
    "../src/billing/usage-delivery-error"
  );
  const { replay } = makeReplay({
    failFirst: new UsageDeliveryError("transient_test_failure"),
  });

  const failed = await replay.replayUnackedResults("worker-d", 10);
  expect(failed).toMatchObject({ claimed: 1, replayed: 0, failed: 1 });
  let item = await recoveryItemRow(reservationId);
  expect(item?.state).toBe("pending");
  expect(item?.failureCount).toBe(1);
  expect(item?.lastReason).toBe("transient_test_failure");
  expect(await ledgerRows(world.customerKey)).toHaveLength(0);

  const converged = await replay.replayUnackedResults("worker-d", 10);
  expect(converged).toMatchObject({ claimed: 1, replayed: 1, failed: 0 });
  const ledger = await ledgerRows(world.customerKey);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.credits).toBe(25);
  expect(ledger[0]?.requestId).toBe(eventId);
  item = await recoveryItemRow(reservationId);
  expect(item?.state).toBe("resolved");
  expect(item?.failureCount).toBe(1);
});

// ── Idempotency-key convergence: the settle landed but the ack was lost ───────────────

test("a replay over an already-settled hold converges on the first settlement and acks", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 400);
  const eventId = `${prefix}-evt-5`;
  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "45",
    denominator: "1",
  });
  // The scan named the item; the first delivery's settle THEN landed but the process
  // died before the ack. The hold is settled; the outbox row is still pending.
  await writer.markReservationUnknown(reservationId, "stream_error");
  await scanner.scanOnce();
  const item = await recoveryItemRow(reservationId);
  expect(item?.state).toBe("pending");
  const { createCreditUsageTarget } = await import(
    "../src/billing/usage-delivery"
  );
  const record = await outboxRow(eventId);
  if (!record) throw new Error("fixture outbox row missing");
  await createCreditUsageTarget(writer)(record);
  expect((await reservationRow(reservationId))?.status).toBe("settled");
  expect((await outboxRow(eventId))?.creditsStatus).toBe("pending");

  const { replay, settleCalls } = makeReplay();
  const batch = await replay.replayUnackedResults("worker-e", 10);

  // 08.3's contract (updated by #278): the settled-but-ack-lost branch NEVER issues a
  // Settle — the settlement is verified read-only against the hold and only the ack is
  // backfilled, so the spy count is ZERO, not the idempotent convergence ride of one.
  expect(batch).toMatchObject({
    claimed: 1,
    settledAckRecovered: 1,
    failed: 0,
  });
  expect(settleCalls()).toBe(0);
  // Same idempotency facts: the first settlement stands untouched — the ledger still
  // holds exactly ONE entry at the original amount.
  const ledger = await ledgerRows(world.customerKey);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.credits).toBe(45);
  expect(ledger[0]?.requestId).toBe(eventId);
  expect((await outboxRow(eventId))?.creditsStatus).toBe("delivered");
  const resolved = await recoveryItemRow(reservationId);
  expect(resolved?.state).toBe("resolved");
  expect(resolved?.lastReason).toBe("result_settled_ack_recovered");
});

// ── Not this handler's shape: no persisted result — the item is retained, untouched ───

test("an item whose reservation has no persisted result is released uncounted and retained", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 200);
  // Unknown hold with NO outbox record: not the persisted-result shape this ticket
  // handles (08.9's evidenced disposal and 08.4's retry own those).
  await writer.markReservationUnknown(reservationId, "dispatch_result_unknown");
  await scanner.scanOnce();

  const { replay, settleCalls } = makeReplay();
  const batch = await replay.replayUnackedResults("worker-f", 10);

  expect(batch).toMatchObject({ claimed: 1, replayed: 0, failed: 0 });
  expect(settleCalls()).toBe(0);
  const item = await recoveryItemRow(reservationId);
  expect(item).not.toBeNull();
  expect(item?.state).toBe("pending");
  expect(item?.failureCount).toBe(0);
  expect(item?.lastReason).toBe("no_persisted_result");
  expect(await ledgerRows(world.customerKey)).toHaveLength(0);
  expect((await reservationRow(reservationId))?.status).toBe("unknown");

  // Park the retained item: 08.4/08.9 own it; later scenarios must not claim it.
  await parkRetainedItem(reservationId, "park-worker-f");
});

// ── Cross-process: the replay is persistence-driven, provable from another process ────

test("a fresh process's replay converges the crash shape on the real tables", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 600);
  const eventId = `${prefix}-evt-6`;
  await persistResult({
    eventId,
    reservationId,
    customerKey: world.customerKey,
    numerator: "90",
    denominator: "1",
  });
  await writer.markReservationUnknown(reservationId, "dispatch_result_unknown");
  const scanPass = JSON.parse(await runWorkerInSubprocess("scan")) as {
    itemsGenerated: number;
  };
  expect(scanPass.itemsGenerated).toBeGreaterThanOrEqual(1);

  const batch = JSON.parse(
    await runWorkerInSubprocess("replay-unacked", "worker-g", "10"),
  ) as { claimed: number; replayed: number; failed: number };

  expect(batch).toMatchObject({ claimed: 1, replayed: 1, failed: 0 });
  const ledger = await ledgerRows(world.customerKey);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.credits).toBe(90);
  expect(ledger[0]?.requestId).toBe(eventId);
  expect((await reservationRow(reservationId))?.status).toBe("settled");
  expect((await outboxRow(eventId))?.creditsStatus).toBe("delivered");
  expect((await recoveryItemRow(reservationId))?.state).toBe("resolved");
});
