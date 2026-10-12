import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The credit writer against a real PostgreSQL, gated on TEST_DATABASE_URL the way the rest of
 * the integration suite is. The two guarantees under test: a keyed grant happens exactly once
 * (the partial unique index is the authority, not a read-check), and the customer floor lets a
 * first-ever grant create its own customer row instead of failing on the foreign key.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const prefix = `cgtest-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_reservations WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`${prefix}%`}`,
  );
  await database.$client.close();
});

test("a keyed grant inserts once; the retry answers the existing row", async () => {
  const key = `${prefix}-key-1`;
  const first = await writer.grantCredits({
    externalCustomerId: `${prefix}-customer`,
    source: "plan",
    totalCents: 900_000, // 9000 credits, ×100
    expiresAt: new Date("2026-11-01T00:00:00Z"),
    reason: "plan allowance · pro · order po-x",
    idempotencyKey: key,
  });
  expect(first.inserted).toBe(true);
  expect(first.grant.total).toBe(900_000);
  expect(first.grant.used).toBe(0);

  // The retried activation, the replayed callback, the sweep's next pass: same key, one row.
  const retry = await writer.grantCredits({
    externalCustomerId: `${prefix}-customer`,
    source: "plan",
    totalCents: 900_000,
    expiresAt: new Date("2026-11-01T00:00:00Z"),
    reason: "plan allowance · pro · order po-x",
    idempotencyKey: key,
  });
  expect(retry.inserted).toBe(false);
  expect(retry.grant.id).toBe(first.grant.id);

  const rows = await database
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, key));
  expect(rows).toHaveLength(1);
});

test("a keyless grant always inserts: two presses mean two grants", async () => {
  const customer = `${prefix}-promo`;
  const grant = (totalCents: number) =>
    writer.grantCredits({
      externalCustomerId: customer,
      source: "promo",
      totalCents,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: "运营活动",
      idempotencyKey: null,
    });
  const first = await grant(1_000);
  const second = await grant(1_000);
  expect(first.inserted).toBe(true);
  expect(second.inserted).toBe(true);
  expect(second.grant.id).not.toBe(first.grant.id);
});

test("the customer floor: a first-ever grant creates its own customer row", async () => {
  const customer = `${prefix}-never-seen`;
  const { grant } = await writer.grantCredits({
    externalCustomerId: customer,
    source: "signin",
    totalCents: 500,
    expiresAt: new Date("2026-12-01T00:00:00Z"),
  });
  expect(grant.externalCustomerId).toBe(customer);
  const rows = await database.execute(
    sql`SELECT external_id FROM billing_customers WHERE external_id = ${customer}`,
  );
  expect(rows.length).toBe(1);
});

test("a fractional or negative amount is refused before any insert", async () => {
  await expect(
    writer.grantCredits({
      externalCustomerId: `${prefix}-bad`,
      source: "promo",
      totalCents: 10.5,
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    }),
  ).rejects.toThrow(TypeError);
  await expect(
    writer.grantCredits({
      externalCustomerId: `${prefix}-bad`,
      source: "promo",
      totalCents: -1,
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    }),
  ).rejects.toThrow(TypeError);
});

/*
 * The withdrawal half. The spec's four states, each pinned against real SQL: the split across
 * grants, the idempotent retry, the honest shortfall, and the concurrent draws. Grants are
 * seeded through grantCredits so each test owns exact balances on its own customer.
 */
describe("consumeCredits", () => {
  async function seedGrant(
    customer: string,
    total: number,
    tag: string,
    expiresAt = new Date(Date.now() + 24 * 3600_000),
  ) {
    const { grant } = await writer.grantCredits({
      externalCustomerId: customer,
      source: "promo",
      totalCents: total,
      expiresAt,
      reason: tag,
      idempotencyKey: `${prefix}-seed-${tag}-${randomUUID().slice(0, 8)}`,
    });
    return grant.id;
  }

  test("a draw within one grant applies in full and reports the remainder", async () => {
    const customer = `${prefix}-c1`;
    await seedGrant(customer, 1_000, "one");
    const result = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 300,
      idempotencyKey: `${prefix}-draw-1`,
      title: "模型调用",
    });
    expect(result.inserted).toBe(true);
    expect(result.applied).toBe(300);
    expect(result.remaining).toBe(700);
    expect(await writer.readBalance(customer)).toBe(700);
  });

  test("a draw spanning two grants splits soonest-expiry-first", async () => {
    const customer = `${prefix}-c2`;
    // The LATER-expiring grant is bigger; the draw must eat the SOONER one dry first.
    await seedGrant(customer, 400, "soon", new Date(Date.now() + 1 * 3600_000));
    await seedGrant(
      customer,
      2_000,
      "late",
      new Date(Date.now() + 24 * 3600_000),
    );
    const result = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 600,
      idempotencyKey: `${prefix}-draw-2`,
      title: "模型调用",
    });
    expect(result.applied).toBe(600);
    expect(result.remaining).toBe(1_800);
    const [row] = await database
      .select({ grantId: creditLedger.grantId, credits: creditLedger.credits })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, `${prefix}-draw-2`));
    expect(row?.credits).toBe(600);
    expect(row?.grantId).not.toBeNull();
  });

  test("a retried report of the same key is the first answer, never a second draw", async () => {
    const customer = `${prefix}-c3`;
    await seedGrant(customer, 1_000, "idem");
    const first = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 200,
      idempotencyKey: `${prefix}-draw-3`,
      title: "模型调用",
    });
    expect(first.inserted).toBe(true);
    const retry = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 200,
      idempotencyKey: `${prefix}-draw-3`,
      title: "模型调用",
    });
    expect(retry.inserted).toBe(false);
    expect(retry.applied).toBe(200);
    expect(await writer.readBalance(customer)).toBe(800);
  });

  test("a cost beyond the balance: the ledger keeps the whole truth, grants draw to zero", async () => {
    const customer = `${prefix}-c4`;
    await seedGrant(customer, 250, "short");
    const result = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 1_000,
      idempotencyKey: `${prefix}-draw-4`,
      title: "模型调用",
    });
    expect(result.inserted).toBe(true);
    expect(result.applied).toBe(250);
    expect(result.remaining).toBe(0);
    const [row] = await database
      .select({ credits: creditLedger.credits, applied: creditLedger.applied })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, `${prefix}-draw-4`));
    expect(row).toEqual({ credits: 1_000, applied: 250 });
  });

  test("a zero-balance draw is still recorded — consumption facts stand without funding", async () => {
    const customer = `${prefix}-c5`;
    const result = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 500,
      idempotencyKey: `${prefix}-draw-5`,
      title: "模型调用",
    });
    expect(result.inserted).toBe(true);
    expect(result.applied).toBe(0);
    const [row] = await database
      .select({ credits: creditLedger.credits, applied: creditLedger.applied })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, `${prefix}-draw-5`));
    expect(row).toEqual({ credits: 500, applied: 0 });
  });

  test("an expired grant funds nothing", async () => {
    const customer = `${prefix}-c6`;
    await seedGrant(customer, 1_000, "expired", new Date(Date.now() - 1_000));
    const result = await writer.consumeCredits({
      externalCustomerId: customer,
      amountCents: 100,
      idempotencyKey: `${prefix}-draw-6`,
      title: "模型调用",
    });
    expect(result.applied).toBe(0);
    expect(await writer.readBalance(customer)).toBe(0);
  });

  test("concurrent draws never overdraw: racing draws absorb at most the grant's total", async () => {
    const customer = `${prefix}-c7`;
    await seedGrant(customer, 1_000, "race");
    const draws = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        writer.consumeCredits({
          externalCustomerId: customer,
          amountCents: 400, // 4 × 400 = 1600 > 1000: the row lock must hold.
          idempotencyKey: `${prefix}-draw-7-${n}`,
          title: "模型调用",
        }),
      ),
    );
    const applied = draws.reduce((sum, draw) => sum + draw.applied, 0);
    expect(applied).toBe(1_000);
    expect(await writer.readBalance(customer)).toBe(0);
  });
});

describe("reservations", () => {
  const farFuture = () => new Date(Date.now() + 3600_000);
  async function seedGrant(
    customer: string,
    total: number,
    tag: string,
    expiresAt = new Date(Date.now() + 24 * 3600_000),
  ) {
    const { grant } = await writer.grantCredits({
      externalCustomerId: customer,
      source: "promo",
      totalCents: total,
      expiresAt,
      reason: tag,
      idempotencyKey: `${prefix}-rseed-${tag}-${randomUUID().slice(0, 8)}`,
    });
    return grant.id;
  }

  test("two concurrent 700 holds against 1000 capacity reserve exactly one", async () => {
    const customer = `${prefix}-r1`;
    await seedGrant(customer, 1_000, "cap");
    const reserve = (key: string, maximumCents: number) =>
      writer.reserveCredits({
        externalCustomerId: customer,
        idempotencyKey: `${prefix}-${key}`,
        maximumCents,
        expiresAt: farFuture(),
      });
    const results = await Promise.all([reserve("r1", 700), reserve("r2", 700)]);
    expect(results.filter((result) => result.reserved)).toHaveLength(1);
    expect(results.find((result) => !result.reserved)).toEqual({
      reserved: false,
      availableCents: 300,
    });
    expect(await writer.availableBalance(customer)).toBe(300);
  });
  const reserve = (customer: string, key: string, maximumCents: number) =>
    writer.reserveCredits({
      externalCustomerId: customer,
      idempotencyKey: `${prefix}-${key}`,
      maximumCents,
      expiresAt: farFuture(),
    });
  const whole = (n: number): { numerator: bigint; denominator: bigint } => ({
    numerator: BigInt(n),
    denominator: 1n,
  });
  const reservedId = (result: Awaited<ReturnType<typeof reserve>>) => {
    if (!result.reserved) throw new Error("expected a reservation");
    return result.reservationId;
  };

  async function grantRows(customer: string) {
    return database
      .select({ id: creditGrants.id, used: creditGrants.used })
      .from(creditGrants)
      .where(eq(creditGrants.externalCustomerId, customer))
      .orderBy(creditGrants.expiresAt);
  }

  test("a hold spans grants earliest-expiry first and settlement releases the unused part", async () => {
    const customer = `${prefix}-r2`;
    const late = await seedGrant(
      customer,
      500,
      "late",
      new Date(Date.now() + 48 * 3600_000),
    );
    const soon = await seedGrant(
      customer,
      300,
      "soon",
      new Date(Date.now() + 2 * 3600_000),
    );
    const id = reservedId(await reserve(customer, "span", 600));
    const allocations = await database.execute(
      sql`SELECT grant_id, amount FROM credit_reservation_allocations WHERE reservation_id = ${id} ORDER BY amount DESC`,
    );
    expect(allocations.map((row) => [row.grant_id, row.amount])).toEqual([
      [soon, 300],
      [late, 300],
    ]);
    expect(await writer.availableBalance(customer)).toBe(200);

    const settled = await writer.settleReservation({
      reservationId: id,
      actual: whole(350),
      title: "模型调用",
    });
    expect(settled).toMatchObject({
      chargedCents: 350,
      appliedCents: 350,
      releasedCents: 250,
    });
    const used = Object.fromEntries(
      (await grantRows(customer)).map((row) => [row.id, row.used]),
    );
    expect(used[soon]).toBe(300);
    expect(used[late]).toBe(50);
    expect(await writer.availableBalance(customer)).toBe(450);
    expect(await writer.readBalance(customer)).toBe(450);

    const [sums] = await database.execute(
      sql`SELECT (SELECT sum(used) FROM credit_grants WHERE external_customer_id = ${customer})::int AS used,
                 (SELECT sum(applied) FROM credit_ledger WHERE external_customer_id = ${customer})::int AS applied`,
    );
    expect(sums).toEqual({ used: 350, applied: 350 });
  });

  test("reserve, settle and release replay to the first result; conflicts are refused", async () => {
    const customer = `${prefix}-r3`;
    await seedGrant(customer, 1_000, "replay");
    const first = await reserve(customer, "k3", 400);
    const id = reservedId(first);
    expect(await reserve(customer, "k3", 400)).toEqual(first);
    await expect(reserve(customer, "k3", 401)).rejects.toThrow(
      /different reservation/,
    );
    await expect(reserve(`${customer}-other`, "k3", 400)).rejects.toThrow(
      /different reservation/,
    );
    expect(await writer.availableBalance(customer)).toBe(600);

    const settled = await writer.settleReservation({
      reservationId: id,
      actual: whole(100),
      title: "t",
    });
    expect(
      await writer.settleReservation({
        reservationId: id,
        actual: whole(100),
        title: "t",
      }),
    ).toEqual(settled);
    expect(
      await writer.settleReservation({
        reservationId: id,
        actual: { numerator: 200n, denominator: 2n },
        title: "t",
      }),
    ).toEqual(settled);
    await expect(
      writer.settleReservation({
        reservationId: id,
        actual: whole(101),
        title: "t",
      }),
    ).rejects.toThrow(/different actual/);
    await writer.releaseReservation(id, "late failure");
    expect(await writer.readBalance(customer)).toBe(900);

    const other = reservedId(await reserve(customer, "k3b", 300));
    await writer.releaseReservation(other, "stream failed");
    await writer.releaseReservation(other, "stream failed again");
    await expect(
      writer.settleReservation({
        reservationId: other,
        actual: whole(1),
        title: "t",
      }),
    ).rejects.toThrow(/already released/);
    expect(await writer.availableBalance(customer)).toBe(900);
    const rows = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, customer));
    expect(rows).toHaveLength(1);
  });

  test("concurrent settlements of one hold charge once", async () => {
    const customer = `${prefix}-r4`;
    await seedGrant(customer, 1_000, "csettle");
    const id = reservedId(await reserve(customer, "k4", 500));
    await Promise.all(
      [1, 2, 3].map(() =>
        writer.settleReservation({
          reservationId: id,
          actual: whole(500),
          title: "t",
        }),
      ),
    );
    expect(await writer.readBalance(customer)).toBe(500);
  });

  test("expired grants hold nothing, and an admitted hold still settles after its grant lapses", async () => {
    const customer = `${prefix}-r5`;
    await seedGrant(customer, 1_000, "gone", new Date(Date.now() - 1_000));
    expect(await reserve(customer, "k5", 100)).toEqual({
      reserved: false,
      availableCents: 0,
    });
    expect(await writer.availableBalance(customer)).toBe(0);

    const lapsing = await seedGrant(
      customer,
      400,
      "lapsing",
      new Date(Date.now() + 60_000),
    );
    const id = reservedId(await reserve(customer, "k5b", 400));
    await database.execute(
      sql`UPDATE credit_grants SET expires_at = now() - interval '1 second' WHERE id = ${lapsing}`,
    );
    const settled = await writer.settleReservation({
      reservationId: id,
      actual: whole(250),
      title: "t",
    });
    expect(settled.appliedCents).toBe(250);
    expect(
      (await grantRows(customer)).find((row) => row.id === lapsing)?.used,
    ).toBe(250);
  });

  test("invalid and out-of-range input is rejected before touching state", async () => {
    const customer = `${prefix}-r6`;
    await seedGrant(customer, 1_000, "invalid");
    for (const maximumCents of [0, -5, 1.5, Number.NaN, 2_147_483_648]) {
      await expect(reserve(customer, "k6", maximumCents)).rejects.toThrow(
        TypeError,
      );
    }
    await expect(
      writer.reserveCredits({
        externalCustomerId: customer,
        idempotencyKey: `${prefix}-k6`,
        maximumCents: 10,
        expiresAt: new Date(Number.NaN),
      }),
    ).rejects.toThrow(TypeError);
    const id = reservedId(await reserve(customer, "k6ok", 100));
    for (const actual of [
      { numerator: -1n, denominator: 1n },
      { numerator: 1n, denominator: 0n },
      { numerator: 1n, denominator: 10n ** 61n },
    ]) {
      await expect(
        writer.settleReservation({ reservationId: id, actual, title: "t" }),
      ).rejects.toThrow(TypeError);
    }
    await expect(
      writer.settleReservation({
        reservationId: id,
        actual: whole(2_147_483_648),
        title: "t",
      }),
    ).rejects.toThrow(/32-bit/);
    expect(await writer.availableBalance(customer)).toBe(900);
  });

  test("fractional costs carry an exact per-customer remainder instead of rounding each event", async () => {
    const customer = `${prefix}-r7`;
    await seedGrant(customer, 1_000, "frac");
    const settle = async (
      key: string,
      numerator: bigint,
      denominator: bigint,
    ) =>
      writer.settleReservation({
        reservationId: reservedId(await reserve(customer, key, 10)),
        actual: { numerator, denominator },
        title: "t",
      });

    // Three events of 1/3 unit: each alone would round to 0 or 1; together exactly one unit.
    const a = await settle("k7a", 1n, 3n);
    expect(a.chargedCents).toBe(0);
    expect(a.remainder).toEqual({ numerator: 1n, denominator: 3n });
    // An owed fraction keeps one unit of capacity unavailable.
    expect(await writer.availableBalance(customer)).toBe(999);
    const b = await settle("k7b", 1n, 3n);
    expect(b.chargedCents).toBe(0);
    expect(b.remainder).toEqual({ numerator: 2n, denominator: 3n });
    const c = await settle("k7c", 1n, 3n);
    expect(c.chargedCents).toBe(1);
    expect(c.remainder).toEqual({ numerator: 0n, denominator: 1n });
    expect(await writer.availableBalance(customer)).toBe(999);

    // Mixed denominators: 1/2 + 1/3 + 2/3 = 3/2 → 1 charged, 1/2 carried.
    await settle("k7d", 1n, 2n);
    await settle("k7e", 1n, 3n);
    const f = await settle("k7f", 2n, 3n);
    expect(f.chargedCents).toBe(1);
    expect(f.remainder).toEqual({ numerator: 1n, denominator: 2n });

    const [sums] = await database.execute(
      sql`SELECT (SELECT sum(used) FROM credit_grants WHERE external_customer_id = ${customer})::int AS used,
                 (SELECT sum(applied) FROM credit_ledger WHERE external_customer_id = ${customer})::int AS applied`,
    );
    expect(sums).toEqual({ used: 2, applied: 2 });
  });

  test("cost above the hold is ledgered in full but only held capacity is applied", async () => {
    const customer = `${prefix}-r8`;
    await seedGrant(customer, 1_000, "over");
    const id = reservedId(await reserve(customer, "k8", 100));
    const settled = await writer.settleReservation({
      reservationId: id,
      actual: whole(160),
      title: "t",
    });
    expect(settled).toMatchObject({
      chargedCents: 160,
      appliedCents: 100,
      releasedCents: 0,
    });
    const [row] = await database
      .select({ credits: creditLedger.credits, applied: creditLedger.applied })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, customer));
    expect(row).toEqual({ credits: 160, applied: 100 });
  });
});
