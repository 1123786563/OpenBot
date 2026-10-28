import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { carriedRemainder } from "../src/billing/capacity";
import { createCreditWriter } from "../src/billing/credits-writer";
import {
  createPayerAccount,
  payerKey,
  type PayerRef,
} from "../src/billing/payer";
import { createDatabase } from "../src/db/client";
import { creditChargeRemainders } from "../src/db/schema/credit-reservations";
import { creditGrants } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * B5-257 (Bifrost 06.6, parent spec AC12 / Q9+Q14): repeated small costs accumulate the
 * correct remainder PER ACCOUNT, instead of rounding each event up to the smallest display
 * unit. The account dimension is the PayerRef-derived key (payer.ts payerKey) — the same
 * key every production caller resolves server-side (payer-binding.ts, credit-reserve.ts) —
 * never the virtual key and never the deployment key. Against the dedicated PostgreSQL test
 * database, this file pins the ticket's four acceptance criteria:
 *
 * 1. Ten fees of 0.001 credit accumulate to exactly one 0.01 charge (and the ticket's own
 *    two-0.005 example) — no per-event round-up.
 * 2. The remainder is carried per account: two accounts never move each other's fraction,
 *    ledger or balance.
 * 3. A virtual-key rotation and a grant renewal neither lose nor duplicate the remainder —
 *    the same PayerRef derives the same account key, so the fraction simply continues.
 * 4. A owed fraction occupies exactly one unit of capacity, and availableBalance and the
 *    reserveCredits admission answer the SAME figure (the one capacity definition in
 *    capacity.ts is shared by both sides).
 *
 * Every account below is opened through createPayerAccount + payerKey — the production
 * wiring — and every figure is asserted against exact rationals, so any regression in the
 * accumulate/isolate/carry chain flips a hard number.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const prefix = `rem-${randomUUID().slice(0, 8)}`;
const keyLike = `openbot-personal-${prefix}%`;

/** 0.001 credit = 1/10 of a scaled unit (×100); ten of them are exactly one unit (0.01 credit). */
const MICRO_FEE = { numerator: 1n, denominator: 10n };

const farFuture = () => new Date(Date.now() + 3_600_000);

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_reservations WHERE external_customer_id LIKE ${keyLike}`,
  );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${keyLike}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${keyLike}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${keyLike}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${keyLike}`,
  );
  await database.$client.close();
});

/** Open one payer account the way production does: PayerRef → mapping row → derived key. */
async function openAccount(tag: string) {
  const ref: PayerRef = { kind: "personal", id: `${prefix}-${tag}` };
  const { account } = await createPayerAccount(database, ref);
  const key = payerKey(ref);
  // The mapping row's key IS the PayerRef derivation — the remainder can only land there.
  expect(account.externalCustomerId).toBe(key);
  return { ref, key };
}

/** Seed one promo grant of `units` scaled units (×100) on the account. */
async function seedGrant(key: string, units: number, tag: string) {
  const { grant } = await writer.grantCredits({
    externalCustomerId: key,
    source: "promo",
    totalCents: units,
    expiresAt: farFuture(),
    reason: tag,
    idempotencyKey: `${prefix}-seed-${tag}`,
  });
  return grant.id;
}

/** One admitted hold + one exact-rational settlement; the ticket's unit of billing work. */
async function settleFraction(
  key: string,
  tag: string,
  actual: { numerator: bigint; denominator: bigint },
) {
  const reserved = await writer.reserveCredits({
    externalCustomerId: key,
    idempotencyKey: `${prefix}-${tag}`,
    maximumCents: 1,
    expiresAt: farFuture(),
  });
  if (!reserved.reserved) {
    throw new Error(
      `reserve refused (available ${reserved.availableCents}) for ${tag}`,
    );
  }
  return writer.settleReservation({
    reservationId: reserved.reservationId,
    actual,
    title: "模型调用",
  });
}

/** One 0.001-credit fee: reserve a 1-unit ceiling, settle exactly 1/10 of a unit. */
const microFee = (key: string, tag: string) =>
  settleFraction(key, tag, MICRO_FEE);

async function ledgerSummary(key: string) {
  const [row] = await database.execute<{
    rows: number;
    charged: number;
    largest: number;
  }>(
    sql`SELECT count(*)::int AS rows, coalesce(sum(credits), 0)::int AS charged,
               coalesce(max(credits), 0)::int AS largest
        FROM credit_ledger WHERE external_customer_id = ${key}`,
  );
  return row;
}

async function grantUsed(key: string) {
  const [row] = await database.execute<{ used: number }>(
    sql`SELECT coalesce(sum(used), 0)::int AS used FROM credit_grants
        WHERE external_customer_id = ${key}`,
  );
  return row.used;
}

describe("per-account charge remainders (B5-257, AC12)", () => {
  test("ten 0.001-credit fees accumulate to exactly one 0.01 charge — never a per-event round-up", async () => {
    const account = await openAccount("t1-ten-micro");
    await seedGrant(account.key, 100, "t1"); // 1.00 credit of capacity

    const results = [];
    for (let i = 1; i <= 10; i++) {
      results.push(await microFee(account.key, `t1-fee-${i}`));
    }

    // The first nine charge NOTHING: each carries its exact growing fraction instead of
    // rounding up to the smallest display unit. The fraction is stored in lowest terms
    // (the schema's contract), so the value is asserted exactly via cross-multiplication:
    // after fee i the owed fraction is exactly i/10 of a unit, whatever its spelling.
    for (const [index, result] of results.slice(0, 9).entries()) {
      expect(result.chargedCents).toBe(0);
      expect(result.remainder.numerator * 10n).toEqual(
        BigInt(index + 1) * result.remainder.denominator,
      );
    }
    // The tenth completes exactly one unit: 0.01 credits in TOTAL, charged once.
    expect(results[9].chargedCents).toBe(1);
    expect(results[9].remainder).toEqual({ numerator: 0n, denominator: 1n });

    const ledger = await ledgerSummary(account.key);
    expect(ledger).toEqual({ rows: 10, charged: 1, largest: 1 });
    expect(await grantUsed(account.key)).toBe(1);
    expect(await writer.availableBalance(account.key)).toBe(99);
    expect(await carriedRemainder(database, account.key)).toEqual({
      numerator: 0n,
      denominator: 1n,
    });
  });

  test("two 0.005-credit fees settle as one 0.01 charge — the ticket's own example", async () => {
    const account = await openAccount("t2-two-halves");
    await seedGrant(account.key, 100, "t2");

    const first = await settleFraction(account.key, "t2-fee-1", {
      numerator: 1n,
      denominator: 2n,
    });
    expect(first.chargedCents).toBe(0);
    expect(first.remainder).toEqual({ numerator: 1n, denominator: 2n });

    const second = await settleFraction(account.key, "t2-fee-2", {
      numerator: 1n,
      denominator: 2n,
    });
    expect(second.chargedCents).toBe(1);
    expect(second.remainder).toEqual({ numerator: 0n, denominator: 1n });

    expect(await ledgerSummary(account.key)).toEqual({
      rows: 2,
      charged: 1,
      largest: 1,
    });
  });

  test("two accounts carry isolated remainders — one account's accumulation never moves the other's", async () => {
    const alice = await openAccount("t3-alice");
    const bob = await openAccount("t3-bob");
    expect(alice.key).not.toBe(bob.key);
    await seedGrant(alice.key, 100, "t3-alice");
    await seedGrant(bob.key, 100, "t3-bob");

    // Alice accrues nine tenths; Bob accrues one. Each fraction stays on its own account.
    for (let i = 1; i <= 9; i++) {
      const result = await microFee(alice.key, `t3-alice-${i}`);
      expect(result.chargedCents).toBe(0);
    }
    const bobFirst = await microFee(bob.key, "t3-bob-1");
    expect(bobFirst.chargedCents).toBe(0);
    expect(bobFirst.remainder).toEqual({ numerator: 1n, denominator: 10n });

    // Bob's snapshot before Alice's clearing charge.
    expect(await carriedRemainder(database, bob.key)).toEqual({
      numerator: 1n,
      denominator: 10n,
    });
    expect(await ledgerSummary(bob.key)).toEqual({
      rows: 1,
      charged: 0,
      largest: 0,
    });
    expect(await writer.availableBalance(bob.key)).toBe(99);
    expect(await grantUsed(bob.key)).toBe(0);

    // Alice's tenth fee clears HER remainder — one unit, from HER grants.
    const aliceTenth = await microFee(alice.key, "t3-alice-10");
    expect(aliceTenth.chargedCents).toBe(1);
    expect(aliceTenth.remainder).toEqual({ numerator: 0n, denominator: 1n });

    // Bob is exactly where he was: same fraction, same (empty) charges, same balance.
    expect(await carriedRemainder(database, bob.key)).toEqual({
      numerator: 1n,
      denominator: 10n,
    });
    expect(await ledgerSummary(bob.key)).toEqual({
      rows: 1,
      charged: 0,
      largest: 0,
    });
    expect(await writer.availableBalance(bob.key)).toBe(99);
    expect(await grantUsed(bob.key)).toBe(0);

    // The remainder records are per-account rows, queryable for user detail and
    // reconciliation — one row per PayerRef-derived key, each with its own fraction.
    const rows = await database
      .select({
        key: creditChargeRemainders.externalCustomerId,
        numerator: creditChargeRemainders.numerator,
        denominator: creditChargeRemainders.denominator,
      })
      .from(creditChargeRemainders)
      .where(
        inArray(creditChargeRemainders.externalCustomerId, [
          alice.key,
          bob.key,
        ]),
      );
    expect(rows).toHaveLength(2);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get(alice.key)?.numerator).toBe("0");
    expect(byKey.get(bob.key)?.numerator).toBe("1");
    expect(byKey.get(bob.key)?.denominator).toBe("10");
  });

  test("a virtual-key rotation and a grant renewal neither lose nor duplicate the remainder", async () => {
    const account = await openAccount("t4-rotation");
    await seedGrant(account.key, 100, "t4-seed");

    // Session 1 (virtual key 1's idempotency keys): nine fees, 9/10 owed.
    for (let i = 1; i <= 9; i++) {
      const result = await microFee(account.key, `t4-session1-${i}`);
      expect(result.chargedCents).toBe(0);
    }
    expect(await carriedRemainder(database, account.key)).toEqual({
      numerator: 9n,
      denominator: 10n,
    });

    // Rotation: the SAME PayerRef derives the SAME account key — the fraction's home is
    // untouched by which virtual key (or how many) made the calls. A renewal mints a new
    // grant into the same account.
    expect(payerKey(account.ref)).toBe(account.key);
    const renewal = await writer.grantCredits({
      externalCustomerId: account.key,
      source: "plan",
      totalCents: 100,
      expiresAt: farFuture(),
      reason: "renewal",
      idempotencyKey: `${prefix}-t4-renewal`,
    });
    expect(renewal.inserted).toBe(true);

    // Session 2 (fresh idempotency keys, as a new key session would mint): the tenth fee
    // clears the carried remainder EXACTLY ONCE.
    const tenth = await microFee(account.key, "t4-session2-10");
    expect(tenth.chargedCents).toBe(1);
    expect(tenth.remainder).toEqual({ numerator: 0n, denominator: 1n });
    expect(await ledgerSummary(account.key)).toEqual({
      rows: 10,
      charged: 1,
      largest: 1,
    });

    // A fresh cycle starts from zero — a stale or duplicated fraction would charge
    // immediately or carry a doubled fraction instead of these exact values.
    const fresh1 = await microFee(account.key, "t4-session3-1");
    expect(fresh1.chargedCents).toBe(0);
    expect(fresh1.remainder).toEqual({ numerator: 1n, denominator: 10n });
    const fresh2 = await microFee(account.key, "t4-session3-2");
    expect(fresh2.chargedCents).toBe(0);
    expect(fresh2.remainder).toEqual({ numerator: 1n, denominator: 5n });

    // The renewal grant sits untouched: the charge drew the seed grant only, and the
    // account total charged across rotation and renewal is exactly one unit.
    const [renewalRow] = await database
      .select({ used: creditGrants.used })
      .from(creditGrants)
      .where(eq(creditGrants.idempotencyKey, `${prefix}-t4-renewal`));
    expect(renewalRow.used).toBe(0);
    expect(await grantUsed(account.key)).toBe(1);
  });

  test("an owed fraction occupies exactly one unit — availableBalance and admission answer the same figure", async () => {
    const account = await openAccount("t5-capacity");
    await seedGrant(account.key, 100, "t5");

    for (let i = 1; i <= 9; i++) await microFee(account.key, `t5-fee-${i}`);

    // 100 free units − 1 unit occupied by the owed 9/10.
    expect(await writer.availableBalance(account.key)).toBe(99);
    // Admission is the SAME semantics: one unit more than available is refused, naming
    // exactly the balance availableBalance answers.
    expect(
      await writer.reserveCredits({
        externalCustomerId: account.key,
        idempotencyKey: `${prefix}-t5-refused`,
        maximumCents: 100,
        expiresAt: farFuture(),
      }),
    ).toEqual({ reserved: false, availableCents: 99 });
    // Exactly available is admitted, and the clearing settlement absorbs the fraction.
    const admitted = await writer.reserveCredits({
      externalCustomerId: account.key,
      idempotencyKey: `${prefix}-t5-admitted`,
      maximumCents: 99,
      expiresAt: farFuture(),
    });
    if (!admitted.reserved) throw new Error("expected the 99-unit hold");
    const settled = await writer.settleReservation({
      reservationId: admitted.reservationId,
      actual: MICRO_FEE,
      title: "模型调用",
    });
    expect(settled.chargedCents).toBe(1);
    expect(settled.remainder).toEqual({ numerator: 0n, denominator: 1n });

    // The same 99 the owed fraction occupied before is what one whole charge leaves after:
    // one capacity definition, consistent on both sides of the clearing charge.
    expect(await writer.availableBalance(account.key)).toBe(99);
    expect(await ledgerSummary(account.key)).toEqual({
      rows: 10,
      charged: 1,
      largest: 1,
    });
  });
});
