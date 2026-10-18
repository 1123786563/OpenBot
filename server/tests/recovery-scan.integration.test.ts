import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq, like, sql } from "drizzle-orm";
import { readCapacity } from "../src/billing/capacity";
import { createPayerAccount } from "../src/billing/payer";
import { createRecoveryScanner } from "../src/billing/recovery-scan";
import { createCreditWriter } from "../src/billing/credits-writer";
import {
  attemptIdForReservation,
} from "../src/billing/reservation-status";
import { createDatabase } from "../src/db/client";
import { accessGrants, botServices, usageOutbox } from "../src/db/schema";
import {
  creditRecoveryItems,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

/*
 * Bifrost #276 (08.1): the unknown-dispatch recovery scan, on a real PostgreSQL
 * (TEST_DATABASE_URL — the dedicated 5594 verify database, never the live one).
 *
 * WHAT THE SCAN IS FOR. A process killed between the reserve and the settlement leaves a
 * hold whose outcome nobody knows: plain `reserved` with its expiry passing in the dark
 * (killed before dispatch, or before PostLLM could mark it), or `unknown` (06.8's explicit
 * mark after the result never arrived). The scan finds both, writes ONE RecoveryItem per
 * such reservation fixing the attempt identity, the original reservation, the payment
 * account and the locked price versions AT DETECTION TIME — and does NOTHING else. No
 * release, no re-dispatch, no settlement: a recovery item is a discovery record, never a
 * money fact (Q12/Q25/Q29: the clock is not release evidence, and only recovery handlers
 * move the hold).
 *
 * HOW IT IS PROVED HERE. The restart and multi-worker criteria run through a REAL second
 * process (tests/support/recovery-scan-worker.ts): a fresh `bun` subprocess opens its own
 * pool, scans or claims, prints JSON and exits. No mock stands in for the persistence.
 *
 * RUNNER NOTE (recorded for the reviewer): this file imports `bun:test` directly, not
 * tests/support/e2e-compat, because it tests modules whose graph reaches `import { SQL }
 * from "../../tests/support/bun-compat"` (src/db/client.ts) — on this branch (BASE 3e8a6072 + integration layer) that
 * import cannot resolve under the e2e runner's Node runtime, and e2e-compat suites cannot
 * collect under plain `bun test` (the bced6121 migration's known gap; main's cb636f02
 * schedules exactly such Bun-runtime suites via `bun test`). The ticket's Verification
 * command (`bun test server/tests/recovery-scan.integration.test.ts`) is therefore run
 * literally. At integration this suite belongs in the bun-runtime manifest the same way the
 * other server DB integration suites do.
 *
 * Isolation: every scenario seeds its own user/bot/grant prefix and the fixtures are
 * deleted by prefix in afterAll. The clock is advanced by moving the reservation's own
 * `expires_at` into the past — the field every expiry path reads — so no test waits on a
 * wall clock.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const scanner = createRecoveryScanner({ database });
const prefix = `b5-276-${randomUUID().slice(0, 8)}`;
const workerScript = join(hereDir, "support", "recovery-scan-worker.ts");

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
    displayName: `Recovery Scan Bot ${n}`,
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
  await createPayerAccount(database, { kind: "personal", id: userId });
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

/** The one field every expiry path reads, moved into the past: the clock, advanced. */
async function expireReservation(reservationId: string) {
  await database
    .update(creditReservations)
    .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
    .where(eq(creditReservations.id, reservationId));
}

/** The recovery item a reservation was named by, or null when the scan never named it. */
async function recoveryItemRow(reservationId: string) {
  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.reservationId, reservationId))
    .limit(1);
  return row ?? null;
}

/** One real subprocess run of the worker: the operation runs in its own process. */
function runWorker(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript, ...args], {
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
    .delete(creditRecoveryItems)
    .where(
      like(creditRecoveryItems.externalCustomerId, `openbot-personal-${prefix}%`),
    );
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
  await database.execute(
    sql`DELETE FROM payer_accounts WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database.$client.close();
});

// ── AC07-1: killed before / after dispatch — a fresh process's scan finds both ─────

test("a hold left reserved by a killed process is discovered by a fresh process's scan once its expiry passed", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  // The process died somewhere between the reserve and any outcome: the hold stays plain
  // reserved, and the clock passes its expiry during the outage.
  await expireReservation(reservationId);

  // A fresh process — not this one, not its memory — runs the scan.
  const pass = JSON.parse(await runWorker("scan")) as {
    itemsGenerated: number;
    items: {
      reservationId: string;
      attemptId: string;
      state: string;
      lastReason: string | null;
      payerRef: { externalCustomerId: string; kind: string | null; payerId: string | null };
      maximum: number;
    }[];
  };

  const item = pass.items.find((entry) => entry.reservationId === reservationId);
  expect(item).toBeDefined();
  expect(pass.itemsGenerated).toBeGreaterThanOrEqual(1);
  expect(item?.attemptId).toBe(attemptIdForReservation(reservationId));
  expect(item?.state).toBe("pending");
  expect(item?.lastReason).toBe("hold_expired_without_result");
  // The payer account and its mapping, fixed at detection.
  expect(item?.payerRef).toEqual({
    externalCustomerId: world.customerKey,
    kind: "personal",
    payerId: world.userId,
  });
  expect(item?.maximum).toBe(500);

  const row = await recoveryItemRow(reservationId);
  expect(row?.state).toBe("pending");
  expect(row?.failureCount).toBe(0);
});

test("a young in-flight hold is not named by the scan", async () => {
  const world = await seedWorld();
  // The other side of the killed-process shape: a plain reserved hold whose expiry has
  // NOT passed is a live request still in flight. The production change that would fail
  // this test is dropping the scan's `expires_at < now` guard on reserved holds — every
  // running call would then become a recovery incident the moment a scan swept by.
  const reservationId = await reserve(world, 500);

  const pass = await scanner.scanOnce();

  expect(pass.itemsGenerated).toBe(0);
  expect(await recoveryItemRow(reservationId)).toBeNull();
});

test("a hold marked unknown before the process died is discovered with its unknown reason", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  await writer.markReservationUnknown(reservationId, "stream_error");

  // Fresh process, fresh scan: the unknown mark is the discovery input, expiry irrelevant.
  const pass = JSON.parse(await runWorker("scan")) as {
    items: {
      reservationId: string;
      lastReason: string | null;
    }[];
  };
  const item = pass.items.find((entry) => entry.reservationId === reservationId);
  expect(item).toBeDefined();
  expect(item?.lastReason).toBe("stream_error");
});

test("the discovered item fixes the locked price basis the hold was admitted under", async () => {
  const world = await seedWorld();
  // The credit writer mints holds without a protocol price lock; a protocol hold carries
  // all five lock fields. Seed the lock the way the protocol reserve (06.5) writes it —
  // all five together — and expect the scan to copy all five, unaltered.
  const reservationId = await reserve(world, 300);
  await writer.markReservationUnknown(reservationId, "usage_missing");
  await database
    .update(creditReservations)
    .set({
      provider: "openai",
      model: "gpt-4o-mini",
      capability: "chat",
      snapshotVersion: 3,
      rateVersion: 7,
    })
    .where(eq(creditReservations.id, reservationId));

  await scanner.scanOnce();

  const item = await recoveryItemRow(reservationId);
  expect(item).not.toBeNull();
  expect(item?.provider).toBe("openai");
  expect(item?.model).toBe("gpt-4o-mini");
  expect(item?.capability).toBe("chat");
  expect(item?.snapshotVersion).toBe(3);
  expect(item?.rateVersion).toBe(7);
});

// ── AC07-2: the scan never re-dispatches and never charges — twice over ───────────

test("a second scan generates nothing new, and no pass moves one money fact", async () => {
  const world = await seedWorld();
  const unknownId = await reserve(world, 500);
  await writer.markReservationUnknown(unknownId, "usage_missing");
  await expireReservation(unknownId);
  const expiredId = await reserve(world, 300);
  await expireReservation(expiredId);

  const first = await scanner.scanOnce();
  const second = await scanner.scanOnce();
  expect(first.itemsGenerated).toBe(2);
  // The re-scan re-finds the same holds and creates nothing: one item per reservation, ever.
  expect(second.itemsGenerated).toBe(0);

  // No money fact moved, in either pass: the grant book is exactly what the fixture wrote,
  // the consumption ledger is still empty, no new holds were taken (a re-dispatch through
  // admission would be a new reservation), nothing went out through the usage outbox, and
  // no hold changed its state.
  const bookCounts = async () =>
    (
      await database
        .select({ count: sql<number>`count(*)::int` })
        .from(creditGrants)
        .where(eq(creditGrants.externalCustomerId, world.customerKey))
    )[0].count;
  expect(await bookCounts()).toBe(1);
  const ledgerCount = async () =>
    (
      await database
        .select({ count: sql<number>`count(*)::int` })
        .from(creditLedger)
        .where(eq(creditLedger.externalCustomerId, world.customerKey))
    )[0].count;
  expect(await ledgerCount()).toBe(0);

  const reservations = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, world.customerKey));
  expect(reservations).toHaveLength(2);
  for (const row of reservations) {
    expect(["reserved", "unknown"]).toContain(row.status);
    expect(row.terminalAt).toBeNull();
    expect(row.applied).toBeNull();
    expect(row.released).toBeNull();
    expect(row.releaseReason).toBeNull();
  }

  const outboxCount = (
    await database.select().from(usageOutbox).where(eq(usageOutbox.externalCustomerId, world.customerKey))
  ).length;
  expect(outboxCount).toBe(0);

  // And the unknown hold still occupies: the scan did not quietly release it.
  const capacity = await readCapacity(database, world.customerKey);
  const held = capacity.grants.reduce((sum, grant) => sum + grant.held, 0);
  expect(held).toBe(500);
});

// ── AC07-3: two workers race the claim — exactly one wins ─────────────────────────

test("two real subprocess workers race the claim and exactly one wins the item", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  await writer.markReservationUnknown(reservationId, "stream_error");
  await scanner.scanOnce();
  const item = await recoveryItemRow(reservationId);
  expect(item?.state).toBe("pending");

  const [w1, w2] = await Promise.all([
    runWorker("claim", `${prefix}-w1`, "10"),
    runWorker("claim", `${prefix}-w2`, "10"),
  ]);
  const claimed1 = JSON.parse(w1) as { id: string }[];
  const claimed2 = JSON.parse(w2) as { id: string }[];

  // Exactly one process owns the item; the other was handed nothing.
  const winners = [claimed1, claimed2].filter((claimed) =>
    claimed.some((entry) => entry.id === item?.id),
  );
  expect(winners).toHaveLength(1);
  const winnerId = claimed1.some((entry) => entry.id === item?.id)
    ? `${prefix}-w1`
    : `${prefix}-w2`;

  const row = await recoveryItemRow(reservationId);
  expect(row?.state).toBe("claimed");
  expect(row?.claimedBy).toBe(winnerId);
  expect(row?.claimedAt).not.toBeNull();
});

test("a claimed item cannot be claimed again, by id, by anyone", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 400);
  await writer.markReservationUnknown(reservationId, "usage_missing");
  await scanner.scanOnce();
  const item = await recoveryItemRow(reservationId);

  const first = await scanner.claimRecoveryItem(item!.id, `${prefix}-a`);
  expect(first?.state).toBe("claimed");
  const second = await scanner.claimRecoveryItem(item!.id, `${prefix}-b`);
  expect(second).toBeNull();

  const row = await recoveryItemRow(reservationId);
  expect(row?.claimedBy).toBe(`${prefix}-a`);
});

// ── AC07-4 / step 4: the item is a fixed snapshot; the scan has no side doors ─────

test("settlement after detection leaves the discovered item exactly as it was recorded", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  await writer.markReservationUnknown(reservationId, "stream_error");
  await scanner.scanOnce();
  const before = await recoveryItemRow(reservationId);

  // Recovery's own door: the same reservation settles, once.
  const settled = await writer.settleReservation({
    reservationId,
    actual: { numerator: 250n, denominator: 1n },
    title: "recovery settlement",
  });
  expect(settled.chargedCents).toBe(250);

  // The item is untouched history: settlement changes the hold, never the discovery.
  const after = await recoveryItemRow(reservationId);
  expect(after).toEqual(before);
});

test("an account with no payer mapping is recorded unattributed, never guessed", async () => {
  await seedWorld();
  // A writer-direct hold on a customer key no payer account maps: exactly the row shape
  // the attribution module answers "unattributed" for. The scan must not invent a payer.
  const orphanKey = `openbot-personal-${prefix}-orphan`;
  // The customer floor the writer itself lays (no payer account row — a key with no mapping):
  await writer.grantCredits({
    externalCustomerId: orphanKey,
    source: "plan",
    totalCents: 1_000_00,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-orphan-grant`,
  });
  const reservationId = await reserve(
    { userId: "orphan", grantId: "orphan", customerKey: orphanKey },
    200,
  );
  await writer.markReservationUnknown(reservationId, "usage_missing");

  await scanner.scanOnce();

  const item = await recoveryItemRow(reservationId);
  expect(item?.externalCustomerId).toBe(orphanKey);
  expect(item?.payerKind).toBeNull();
  expect(item?.payerId).toBeNull();
});

// ── The periodic sweep, in the maintenance pattern ─────────────────────────────────

test("the sweep starter discovers holds on its own clock and stops cleanly", async () => {
  const { startRecoveryScanSweeps } = await import("../src/billing/maintenance");
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  await writer.markReservationUnknown(reservationId, "usage_missing");

  const sweeps = startRecoveryScanSweeps(scanner, {
    firstRunMs: 20,
    intervalMs: 60_000,
    log: () => undefined,
  });
  try {
    // The first pass fires 20ms in; give it a moment, then expect the item on disk.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const item = await recoveryItemRow(reservationId);
    expect(item).not.toBeNull();
  } finally {
    sweeps.stop();
  }
});

// ── The claim queue honours FIFO order and its own consistency CHECK ───────────────

test("claims hand out the oldest detections first, across passes, before anything newer", async () => {
  const world = await seedWorld();
  // detected_at is a PASS-level stamp: holds named by one scan share it. And the FIFO
  // the claim really enforces is about WHICH pending items a batch hands out — the
  // select's `order by detected_at` picks the oldest ones. (The order of the returned
  // ARRAY is the UPDATE's RETURNING order, not the declared keys — a desc flip on the
  // select leaves the array order untouched, so an index-order assertion would be
  // heap-order luck, the very flake the single-pass version had. Composition is the
  // contract that exists.) The production change that would fail this test is dropping
  // or inverting the claim select's `order by detected_at`: a newer discovery would be
  // handed out over an older one.
  //
  // Two passes of an advancing injected clock name three holds: two in the first pass
  // (stamped an ancient t1, older than anything else in the shared verify database),
  // one in the second (t1 + 30min). A bounded claim of 2 must take exactly the two
  // batch-1 items — never the batch-2 discovery.
  let clock = new Date(Date.now() - 48 * 60 * 60_000);
  const batched = createRecoveryScanner({
    database,
    now: () => (clock = new Date(clock.getTime() + 30 * 60_000)),
  });
  const oldest = await reserve(world, 100);
  await writer.markReservationUnknown(oldest, "usage_missing");
  const secondOldest = await reserve(world, 100);
  await writer.markReservationUnknown(secondOldest, "usage_missing");
  await batched.scanOnce(); // batch 1: both stamped t1
  const newest = await reserve(world, 100);
  await writer.markReservationUnknown(newest, "usage_missing");
  await batched.scanOnce(); // batch 2: stamped t1 + 30min

  // Premise: the two passes really stamped different detected_at — the keys FIFO reads.
  const [oldestRow, newestRow] = await Promise.all([
    recoveryItemRow(oldest),
    recoveryItemRow(newest),
  ]);
  expect(oldestRow!.detectedAt.getTime()).toBeLessThan(newestRow!.detectedAt.getTime());

  const claimed = await scanner.claimRecoveryItems(`${prefix}-fifo`, 2);
  expect(new Set(claimed.map((entry) => entry.reservationId))).toEqual(
    new Set([oldest, secondOldest]),
  );
  const winner = claimed.find((entry) => entry.reservationId === oldest);
  expect(winner?.claimedBy).toBe(`${prefix}-fifo`);
  expect(winner?.claimedAt).not.toBeNull();
});
