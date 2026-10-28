import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createCredits } from "../src/billing/credits";
import {
  createPayerAccount,
  PayerAccountConflictError,
  payerKey,
  readPayerAccount,
  readPayerAccountForKey,
} from "../src/billing/payer";
import { createDatabase } from "../src/db/client";
import { billingCustomers, payerAccounts } from "../src/db/schema/billing";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { rejectionOf } from "./support/pg-errors";

/*
 * The payer account layer against a real PostgreSQL, gated on TEST_DATABASE_URL the way the rest
 * of the integration suite is (tests/support/database.ts refuses the live `openbot` database).
 * The guarantees under test are the ticket's acceptance criteria: creating an account for the
 * same subject is idempotent even when callers race on separate connections (the database's
 * unique indexes arbitrate, not a read-check), the account ↔ externalCustomerId mapping is
 * unique in BOTH directions, grants and ledger rows stay invisible across accounts through the
 * public read interfaces, and account creation copies, moves or splits no balance at all.
 * CreditWriter's own amount and idempotency semantics are used exactly as they stand — this
 * ticket adds the account layer, it does not touch the billing math.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const run = randomUUID().slice(0, 8);

/** Every external customer key this run created; the cleanup deletes exactly these. */
const createdKeys = new Set<string>();
/** The extra pools the concurrency test opens; closed alongside the main one. */
const extraDatabases: ReturnType<typeof createDatabase>[] = [];

function track(key: string): string {
  createdKeys.add(key);
  return key;
}

afterAll(async () => {
  const keys = [...createdKeys];
  if (keys.length > 0) {
    await database.execute(
      sql`DELETE FROM payer_accounts WHERE external_customer_id IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    );
    // billing_customers cascades to the grants, ledger, reservations and remainders.
    await database.execute(
      sql`DELETE FROM billing_customers WHERE external_id IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    );
  }
  for (const extra of extraDatabases) await extra.$client.close();
  await database.$client.close();
});

describe("createPayerAccount is idempotent per subject", () => {
  test("a second create answers the existing account instead of a second row", async () => {
    const ref = { kind: "personal" as const, id: `payer-1-${run}` };
    const first = await createPayerAccount(database, ref);
    expect(first.inserted).toBe(true);
    expect(first.account.externalCustomerId).toBe(payerKey(ref));

    const again = await createPayerAccount(database, ref);
    expect(again.inserted).toBe(false);
    expect(again.account.id).toBe(first.account.id);

    track(first.account.externalCustomerId);
    const rows = await database
      .select({ id: payerAccounts.id })
      .from(payerAccounts)
      .where(
        and(
          eq(payerAccounts.kind, ref.kind),
          eq(payerAccounts.payerId, ref.id),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  test("creating the account floors the billing customer row but no balance", async () => {
    const ref = { kind: "company" as const, id: `payer-2-${run}` };
    const { account } = await createPayerAccount(database, ref);
    track(account.externalCustomerId);
    expect(
      await readPayerAccountForKey(database, account.externalCustomerId),
    ).toEqual(account);

    const balances = await database.execute(
      sql`SELECT (SELECT count(*) FROM credit_grants WHERE external_customer_id = ${account.externalCustomerId}) AS grants,
                 (SELECT count(*) FROM credit_ledger WHERE external_customer_id = ${account.externalCustomerId}) AS ledger`,
    );
    expect(Number(balances[0].grants)).toBe(0);
    expect(Number(balances[0].ledger)).toBe(0);
  });
});

/** The two counts a balance check reads, as numbers — `count(*)` crosses the driver as a string. */
async function balanceCounts(key: string) {
  const rows = await database.execute(
    sql`SELECT (SELECT count(*) FROM credit_grants WHERE external_customer_id = ${key}) AS grants,
               (SELECT count(*) FROM credit_ledger WHERE external_customer_id = ${key}) AS ledger`,
  );
  return { grants: Number(rows[0].grants), ledger: Number(rows[0].ledger) };
}

describe("concurrent creates for one subject leave exactly one mapping", () => {
  test("six connections racing the same ref all answer the one account row", async () => {
    const ref = { kind: "personal" as const, id: `payer-race-${run}` };
    // Separate database instances = separate connection pools: the inserts genuinely land on
    // different connections, so the unique index — not event-loop luck — decides the winner.
    const lanes = Array.from({ length: 6 }, () => {
      const lane = createDatabase(testDatabaseUrl(), { max: 1 });
      extraDatabases.push(lane);
      return lane;
    });

    const answers = await Promise.all(
      lanes.map((lane) => createPayerAccount(lane, ref)),
    );
    track(answers[0].account.externalCustomerId);

    const ids = new Set(answers.map((answer) => answer.account.id));
    expect(ids.size).toBe(1);
    expect(answers.filter((answer) => answer.inserted)).toHaveLength(1);

    const rows = await database.execute(
      sql`SELECT count(*) AS n FROM payer_accounts WHERE kind = ${ref.kind} AND payer_id = ${ref.id}`,
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe("the account ↔ externalCustomerId mapping is unique in both directions", () => {
  test("a second account for the same subject is refused by the database", async () => {
    const ref = { kind: "personal" as const, id: `payer-uq1-${run}` };
    const { account } = await createPayerAccount(database, ref);
    track(account.externalCustomerId);

    // A second account row for the same subject, keyed on a hand-made different customer id.
    await database.execute(
      sql`INSERT INTO billing_customers (external_id) VALUES (${`stray-${run}`})`,
    );
    track(`stray-${run}`);
    const rejection = await rejectionOf(() =>
      database.insert(payerAccounts).values({
        id: `pa-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        kind: ref.kind,
        payerId: ref.id,
        externalCustomerId: `stray-${run}`,
      }),
    );
    expect(rejection.code).toBe("23505");
    expect(rejection.message).toContain("payer_accounts_subject_unique_idx");
  });

  test("a second account claiming the same externalCustomerId is refused", async () => {
    const ref = { kind: "company" as const, id: `payer-uq2-${run}` };
    const { account } = await createPayerAccount(database, ref);
    track(account.externalCustomerId);

    const rejection = await rejectionOf(() =>
      database.insert(payerAccounts).values({
        id: `pa-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        kind: "personal",
        payerId: `other-subject-${run}`,
        externalCustomerId: account.externalCustomerId,
      }),
    );
    expect(rejection.code).toBe("23505");
    expect(rejection.message).toContain(
      "payer_accounts_external_customer_unique_idx",
    );
  });
});

describe("a create that finds a mapping it cannot own refuses loudly instead of borrowing", () => {
  /** A hand-placed account row for one subject sitting on another subject's derived key. */
  async function strayRowOn(key: string, ownerPayerId: string) {
    await database
      .insert(billingCustomers)
      .values({ externalId: key, name: null })
      .onConflictDoNothing({ target: billingCustomers.externalId });
    await database.insert(payerAccounts).values({
      id: `pa-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      kind: "personal",
      payerId: ownerPayerId,
      externalCustomerId: key,
    });
  }

  test("the key already owned by another subject: payer_account_conflict, no second row", async () => {
    // The review's exact fixture: kind and key do not agree (a personal row for subject X on
    // subject Y's derived key), the way a hand-placed or migrated-in row can disagree.
    const subjectY = `clash-y-${run}`;
    const key = payerKey({ kind: "personal", id: subjectY });
    await strayRowOn(track(key), `clash-x-${run}`);

    let error: unknown;
    try {
      await createPayerAccount(database, { kind: "personal", id: subjectY });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(PayerAccountConflictError);
    expect((error as PayerAccountConflictError).code).toBe(
      "payer_account_conflict",
    );
    expect((error as Error).message).toContain(
      "already belongs to a personal payer account",
    );

    // No second mapping appeared: the key still has the one stray row, and the refused subject
    // has none — the loud refusal is the only thing the failed create left behind.
    const forKey = await database.execute(
      sql`SELECT count(*) AS n FROM payer_accounts WHERE external_customer_id = ${key}`,
    );
    expect(Number(forKey[0].n)).toBe(1);
    const forSubject = await database.execute(
      sql`SELECT count(*) AS n FROM payer_accounts WHERE kind = 'personal' AND payer_id = ${subjectY}`,
    );
    expect(Number(forSubject[0].n)).toBe(0);
  });

  test("the conflicting row vanishing before the re-read: the no-mapping refusal, no row", async () => {
    // The branch the conflict path keeps for an interleaving nobody can stage by hand: the
    // insert lost a unique index, but neither re-read finds any row. Staged deterministically
    // with a fixture-only AFTER INSERT statement trigger — it runs after ON CONFLICT DO NOTHING
    // resolved the skipped insert but before the module's re-reads, and deletes the conflicting
    // row — exactly the vanished-mapping state the loud error exists for.
    const subjectY = `vanish-y-${run}`;
    const key = payerKey({ kind: "personal", id: subjectY });
    await strayRowOn(track(key), `vanish-x-${run}`);

    // Bind parameters cannot appear inside a CREATE FUNCTION body, and the key is this test's
    // own uuid-derived string, so it is inlined as a quoted literal rather than bound.
    const keyLiteral = `'${key.replaceAll("'", "''")}'`;
    await database.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION payer_test_vanish()
        RETURNS trigger AS $vanish$
        BEGIN
          DELETE FROM payer_accounts WHERE external_customer_id = ${keyLiteral};
          RETURN NULL;
        END
        $vanish$ LANGUAGE plpgsql`),
    );
    try {
      await database.execute(
        sql`CREATE TRIGGER payer_test_vanish AFTER INSERT ON payer_accounts
          FOR EACH STATEMENT EXECUTE FUNCTION payer_test_vanish()`,
      );

      let error: unknown;
      try {
        await createPayerAccount(database, { kind: "personal", id: subjectY });
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(PayerAccountConflictError);
      expect((error as PayerAccountConflictError).code).toBe(
        "payer_account_conflict",
      );
      expect((error as Error).message).toContain("no mapping was found");
    } finally {
      await database.execute(
        sql`DROP TRIGGER IF EXISTS payer_test_vanish ON payer_accounts`,
      );
      await database.execute(sql`DROP FUNCTION IF EXISTS payer_test_vanish()`);
    }

    // Nothing was inserted: the subject has no row, and the key's stray row was consumed by the
    // fixture itself, so the table holds neither of this test's mappings.
    const rows = await database.execute(
      sql`SELECT count(*) AS n FROM payer_accounts
          WHERE (kind = 'personal' AND payer_id = ${subjectY})
             OR external_customer_id = ${key}`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe("grants and ledger rows of one account are invisible to another", () => {
  test("A's grant, hold and settlement never surface in B's reads", async () => {
    const alice = { kind: "personal" as const, id: `payer-iso-a-${run}` };
    const bob = { kind: "personal" as const, id: `payer-iso-b-${run}` };
    const accountA = (await createPayerAccount(database, alice)).account;
    const accountB = (await createPayerAccount(database, bob)).account;
    track(accountA.externalCustomerId);
    track(accountB.externalCustomerId);

    // The full billing life on A: a deposit, a hold, and a settlement — CreditWriter exactly as
    // it stands, only fed A's account key.
    await writer.grantCredits({
      externalCustomerId: accountA.externalCustomerId,
      source: "promo",
      totalCents: 1_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: "isolation fixture",
      idempotencyKey: `payer-iso-grant-${run}`,
    });
    const hold = await writer.reserveCredits({
      externalCustomerId: accountA.externalCustomerId,
      idempotencyKey: `payer-iso-hold-${run}`,
      maximumCents: 800,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    expect(hold).toEqual({ reserved: true, reservationId: expect.any(String) });
    if (!hold.reserved) throw new Error("hold was refused");
    await writer.settleReservation({
      reservationId: hold.reservationId,
      actual: { numerator: 250n, denominator: 1n },
      title: "isolation call",
    });

    // B's balance through the writer's own read: zero, and A's grant does not leak into it.
    expect(await writer.availableBalance(accountB.externalCustomerId)).toBe(0);
    expect(await writer.availableBalance(accountA.externalCustomerId)).toBe(
      750,
    );

    // The page's reads, one resolved ref per call: B sees no summary, no grant, no consumption.
    const credits = createCredits({
      database,
      externalCustomerKey: accountA.externalCustomerId,
      catalog: new Map(),
    });
    expect((await credits.summary(bob)).rewards.remaining).toBe(0);
    expect(await credits.grants(bob)).toHaveLength(0);
    const bobPage = await credits.consumption(
      { from: null, to: null, page: 1 },
      bob,
    );
    expect(bobPage.pagination.totalCount).toBe(0);
    expect(bobPage.entries).toHaveLength(0);

    // And A's own reads still answer A's facts, so the zeros above are isolation, not emptiness.
    const alicePage = await credits.consumption(
      { from: null, to: null, page: 1 },
      alice,
    );
    expect(alicePage.pagination.totalCount).toBe(1);
    expect(alicePage.entries[0].credits).toBe(2.5);
  });
});

describe("account creation moves no balance anywhere", () => {
  test("a legacy deployment account maps the key with existing grants untouched", async () => {
    const tenantId = `payer-legacy-${run}`;
    const legacyKey = payerKey({ kind: "legacy_deployment", id: tenantId });
    // Records that predate the account layer, sitting on the deployment key the way production's
    // do — written through the writer before any payer account exists for them.
    await writer.grantCredits({
      externalCustomerId: legacyKey,
      source: "plan",
      totalCents: 50_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: "pre-account fixture",
      idempotencyKey: `payer-legacy-grant-${run}`,
    });
    track(legacyKey);
    const before = await balanceCounts(legacyKey);
    expect(before).toEqual({ grants: 1, ledger: 0 });

    const { account, inserted } = await createPayerAccount(database, {
      kind: "legacy_deployment",
      id: tenantId,
    });
    expect(inserted).toBe(true);
    expect(account.externalCustomerId).toBe(legacyKey);
    expect(
      await readPayerAccount(database, {
        kind: "legacy_deployment",
        id: tenantId,
      }),
    ).toEqual(account);

    // No grant copied, split or migrated: the deployment key keeps exactly what it had, and the
    // balance the writer answers is the one those rows always priced.
    expect(await balanceCounts(legacyKey)).toEqual(before);
    expect(await writer.availableBalance(legacyKey)).toBe(50_000);
    const replayed = await database.execute(
      sql`SELECT count(*) AS n FROM credit_grants WHERE idempotency_key = ${`payer-legacy-grant-${run}`}`,
    );
    expect(Number(replayed[0].n)).toBe(1);
  });

  test("personal and company accounts are born with no balance rows at all", async () => {
    const personal = { kind: "personal" as const, id: `payer-born-1-${run}` };
    const company = { kind: "company" as const, id: `payer-born-2-${run}` };
    const a = await createPayerAccount(database, personal);
    const b = await createPayerAccount(database, company);
    track(a.account.externalCustomerId);
    track(b.account.externalCustomerId);
    for (const key of [
      a.account.externalCustomerId,
      b.account.externalCustomerId,
    ]) {
      expect(await balanceCounts(key)).toEqual({ grants: 0, ledger: 0 });
    }
  });
});

describe("unknown_owner stays quarantined on the write path too", () => {
  test("createPayerAccount refuses to open an account for an unknown owner", async () => {
    await expect(
      createPayerAccount(database, {
        kind: "unknown_owner",
        id: `payer-unknown-${run}`,
      }),
    ).rejects.toThrow(TypeError);
  });
});
