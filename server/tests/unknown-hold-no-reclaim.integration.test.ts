import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { readCapacity } from "../src/billing/capacity";
import { createCreditWriter } from "../src/billing/credits-writer";
import { payerKey } from "../src/billing/payer";
import {
  attemptIdForReservation,
  createReservationStatusService,
} from "../src/billing/reservation-status";
import { createDatabase } from "../src/db/client";
import { accessGrants, botServices } from "../src/db/schema";
import { creditReservations } from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #259 (06.8): unknown-result holds are never reclaimed by the clock, on a real
 * PostgreSQL (TEST_DATABASE_URL; the dedicated 5590 verify database, never the live one).
 *
 * A provider call whose result never arrived (stream error, missing usage, cancellation) may
 * still have produced billable work, so its hold is NOT release evidence — Q12/AC15: the hold
 * keeps occupying available credit until a reliable cost is known. The clock is not that
 * evidence: advancing past `expiresAt` must NOT vacate an unknown hold's capacity the way it
 * vacates a plain reserved hold's (the F4 exclusion stays for `reserved` only), no timeout
 * path may flip the state, and an ordinary release must be refused. Only recovery — a
 * settlement or an evidence-backed release against the SAME reservation (same attempt id) —
 * may move an unknown hold to a terminal state.
 *
 * Isolation: every scenario seeds its own user/bot/grant prefix instead of cleaning up mid-run;
 * the fixtures are deleted by prefix in afterAll. The clock is advanced by moving the
 * reservation's own `expires_at` into the past — the exact field the capacity computation and
 * every expiry path read — so no test waits on a wall clock.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const statusService = createReservationStatusService({ database });
const prefix = `b5-259-${randomUUID().slice(0, 8)}`;

const GRANT_TOTAL = 10_000_00; // 10_000 credits, ×100

type World = {
  userId: string;
  grantId: string;
  customerKey: string;
};

let seedCounter = 0;

/** A customer with one live grant, an access grant for status scoping, nothing else. */
async function seedWorld(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const customerKey = payerKey({ kind: "personal", id: userId });

  await database.insert(botServices).values({
    botId,
    displayName: `Unknown Hold Bot ${n}`,
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

/** The one field every expiry path reads, moved into the past: the clock, advanced. */
async function expireReservation(reservationId: string) {
  await database
    .update(creditReservations)
    .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
    .where(eq(creditReservations.id, reservationId));
}

async function reservationRow(reservationId: string) {
  const [row] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId))
    .limit(1);
  if (!row) throw new Error(`no reservation row ${reservationId}`);
  return row;
}

afterAll(async () => {
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

// ── Entering unknown: the state and its evidence ──────────────────────────────────

test("an unknown-result hold enters the unknown state, recording why and when, and stays non-terminal", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);

  await writer.markReservationUnknown(reservationId, "stream_error");

  const row = await reservationRow(reservationId);
  expect(row.status).toBe("unknown");
  expect(row.unknownReason).toBe("stream_error");
  expect(row.unknownAt).not.toBeNull();
  // Non-terminal: only 08.x recovery or evidenced admin disposal may move it from here.
  expect(row.terminalAt).toBeNull();
  expect(row.applied).toBeNull();
  expect(row.released).toBeNull();

  // A duplicate unknown mark (the same event failing twice on different paths) never
  // overwrites the first evidence and never creates a second fact.
  await writer.markReservationUnknown(reservationId, "usage_missing");
  const again = await reservationRow(reservationId);
  expect(again.status).toBe("unknown");
  expect(again.unknownReason).toBe("stream_error");
});

// ── The core refusal: the clock never reclaims an unknown hold ────────────────────

test("the clock advancing past expiresAt leaves an unknown hold occupying its full capacity", async () => {
  const world = await seedWorld();
  const withoutHold = await writer.availableBalance(world.customerKey);
  const reservationId = await reserve(world, 500);
  expect(await writer.availableBalance(world.customerKey)).toBe(
    withoutHold - 500,
  );
  await writer.markReservationUnknown(reservationId, "usage_missing");

  // The clock advances past expiresAt …
  await expireReservation(reservationId);

  // … and the unknown hold still occupies exactly what it held: no passive reclaim, no
  // state flip, no release — the expiry field only ever fences NEW requests (Q12/AC15).
  expect(await writer.availableBalance(world.customerKey)).toBe(
    withoutHold - 500,
  );
  const row = await reservationRow(reservationId);
  expect(row.status).toBe("unknown");
  expect(row.terminalAt).toBeNull();

  // The capacity breakdown names the occupation per grant, so the balance is not a fluke
  // of one query: held includes the unknown hold, free excludes it, spendable follows.
  const capacity = await readCapacity(database, world.customerKey);
  const held = capacity.grants.reduce((sum, grant) => sum + grant.held, 0);
  expect(held).toBe(500);
  expect(capacity.spendableUnits).toBe(withoutHold - 500);
});

test("an unknown hold past its expiry still fences new admissions, while an expired plain reserved hold vacates", async () => {
  const world = await seedWorld();
  const withoutHold = await writer.availableBalance(world.customerKey);

  // Control, unchanged F4 rule: a PLAIN reserved hold whose expiry passed no longer
  // occupies — that reclamation is 06.11's domain and must keep working.
  const plainId = await reserve(world, 300);
  await expireReservation(plainId);
  expect(await writer.availableBalance(world.customerKey)).toBe(withoutHold);

  // The unknown twin, same clock: still occupying, so a new hold that would need the
  // same capacity is refused with what is actually available — never admitted on top.
  const unknownId = await reserve(world, 500);
  await writer.markReservationUnknown(unknownId, "stream_error");
  await expireReservation(unknownId);
  const admission = await writer.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-idem-after-unknown`,
    maximumCents: withoutHold,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  expect(admission).toEqual({
    reserved: false,
    availableCents: withoutHold - 500,
  });
});

// ── The doors an unknown hold refuses ─────────────────────────────────────────────

test("an ordinary release cannot change an unknown hold, past its expiry or not", async () => {
  const world = await seedWorld();
  const withoutHold = await writer.availableBalance(world.customerKey);
  const reservationId = await reserve(world, 500);
  await writer.markReservationUnknown(reservationId, "usage_missing");
  await expireReservation(reservationId);

  let refused: unknown;
  try {
    await writer.releaseReservation(reservationId, "late ordinary release");
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(Error);
  expect((refused as { code?: string }).code).toBe("reservation_conflict");

  // Nothing moved: the state, the hold, and the occupation are exactly as they were.
  const row = await reservationRow(reservationId);
  expect(row.status).toBe("unknown");
  expect(row.terminalAt).toBeNull();
  expect(row.releaseReason).toBeNull();
  expect(await writer.availableBalance(world.customerKey)).toBe(
    withoutHold - 500,
  );
});

test("the recovery release door takes an unknown hold with its evidence; the reserved and ordinary doors stay separate", async () => {
  const world = await seedWorld();
  const withoutHold = await writer.availableBalance(world.customerKey);

  // The recovery door refuses a plain reserved hold — that is releaseReservation's job,
  // and a recovery-only release must not become a second ordinary release path.
  const reservedId = await reserve(world, 300);
  let wrongDoor: unknown;
  try {
    await writer.releaseUnknownReservation(
      reservedId,
      "recovery without cause",
    );
  } catch (error) {
    wrongDoor = error;
  }
  expect(wrongDoor).toBeInstanceOf(Error);
  expect((wrongDoor as { code?: string }).code).toBe("reservation_conflict");
  expect((await reservationRow(reservedId)).status).toBe("reserved");

  // On an unknown hold the recovery release lands: terminal, evidenced, capacity back.
  const unknownId = await reserve(world, 500);
  await writer.markReservationUnknown(unknownId, "usage_missing");
  await expireReservation(unknownId);
  await writer.releaseUnknownReservation(
    unknownId,
    "provider confirmed no cost",
  );
  const released = await reservationRow(unknownId);
  expect(released.status).toBe("released");
  expect(released.releaseReason).toBe("provider confirmed no cost");
  expect(released.terminalAt).not.toBeNull();
  expect(released.applied).toBe(0);
  expect(released.released).toBe(500);
  // The unknown entry evidence survives as history, whatever became of the hold.
  expect(released.unknownReason).toBe("usage_missing");
  expect(released.unknownAt).not.toBeNull();
  expect(await writer.availableBalance(world.customerKey)).toBe(
    withoutHold - 300,
  );
});

// ── Recovery settlement: the same attempt id settles, once ────────────────────────

test("recovery settles an unknown hold by the same attempt id, even past expiry, exactly once", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  const attemptId = attemptIdForReservation(reservationId);
  await writer.markReservationUnknown(reservationId, "stream_error");
  await expireReservation(reservationId);
  // The grant lapses mid-flight too (Q24): an already-admitted call still settles.
  await database.execute(
    sql`UPDATE credit_grants SET expires_at = now() - interval '1 minute' WHERE external_customer_id = ${world.customerKey}`,
  );

  const settled = await writer.settleReservation({
    reservationId,
    actual: { numerator: 250n, denominator: 1n }, // 250 scaled units of the 500 held
    title: "recovery settlement",
  });
  expect(settled.chargedCents).toBe(250);
  expect(settled.appliedCents).toBe(250);
  expect(settled.releasedCents).toBe(250);

  // The SAME attempt id now answers settled — recovery never mints a new identity.
  expect(attemptIdForReservation(reservationId)).toBe(attemptId);
  const answer = await statusService.queryStatus({
    grantId: world.grantId,
    attemptId,
  });
  expect(answer.kind).toBe("answered");
  if (answer.kind !== "answered") return;
  expect(answer.outcome.status).toBe("settled");
  if (answer.outcome.status === "unknown") return;
  expect(answer.outcome.reservationId).toBe(reservationId);
  expect(answer.outcome.terminalAt).not.toBeNull();

  // Exactly one ledger fact, and a replay of the same actual answers the first result.
  const ledgerCount = () =>
    database
      .select({ count: sql<number>`count(*)::int` })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, `reservation:${reservationId}`));
  expect((await ledgerCount())[0].count).toBe(1);
  const replay = await writer.settleReservation({
    reservationId,
    actual: { numerator: 250n, denominator: 1n },
    title: "recovery settlement replay",
  });
  expect(replay.chargedCents).toBe(settled.chargedCents);
  expect(replay.appliedCents).toBe(settled.appliedCents);
  expect((await ledgerCount())[0].count).toBe(1);

  // The entry evidence survives as history on the settled row.
  const row = await reservationRow(reservationId);
  expect(row.status).toBe("settled");
  expect(row.unknownReason).toBe("stream_error");
  expect(row.unknownAt).not.toBeNull();
});

// ── The Status surface answers the unknown state without losing the old shapes ────

test("the status query answers an unknown-result hold with its evidence, and not-found stays bare", async () => {
  const world = await seedWorld();
  const reservationId = await reserve(world, 500);
  await writer.markReservationUnknown(reservationId, "usage_missing");

  const answer = await statusService.queryStatus({
    grantId: world.grantId,
    reservationId,
  });
  expect(answer.kind).toBe("answered");
  if (answer.kind !== "answered") return;
  expect(answer.outcome.status).toBe("unknown");
  if (
    answer.outcome.status === "unknown" &&
    !("reservationId" in answer.outcome)
  )
    return;
  expect(answer.outcome.reservationId).toBe(reservationId);
  expect(answer.outcome.unknownReason).toBe("usage_missing");
  expect(answer.outcome.unknownAt).not.toBeNull();
  expect(answer.outcome.terminalAt).toBeNull();

  // A reservation that does not exist still answers the bare not-found shape: status
  // unknown and nothing else — the two unknowns are told apart by the facts they carry.
  const nothing = await statusService.queryStatus({
    grantId: world.grantId,
    reservationId: `cr-${"0".repeat(16)}`,
  });
  expect(nothing).toEqual({
    kind: "answered",
    outcome: { status: "unknown" },
  });
});
