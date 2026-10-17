import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import {
  createPayerAccountService,
  PayerAccountMissingError,
  PayerOwnerUnknownError,
} from "../src/billing/payer-account";
import { deploymentExternalCustomerId } from "../src/billing/service";
import { createDatabase } from "../src/db/client";
import { billingCustomers } from "../src/db/schema/billing";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { payerAccounts } from "../src/db/schema/payer";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The payer account layer against a real PostgreSQL (ticket #215): idempotent provisioning,
 * the two uniqueness directions, fail-closed resolution and cross-account isolation. Real
 * connections, no mocks — the unique indexes and the concurrent insert race are the behaviour
 * under test, and they only exist in the database.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const service = createPayerAccountService(database);
const writer = createCreditWriter(database);
const credits = createCredits({
  database,
  externalCustomerKey: "unused-by-these-tests",
  catalog: new Map(),
});
const suite = `p215-${randomUUID().slice(0, 8)}`;

/** Every key this suite creates, for the teardown that leaves the shared test database clean. */
const keyPrefixes = [
  `payer-personal-${suite}`,
  `payer-company-${suite}`,
  `openbot-deployment-${suite}`,
  `payer-unknown-${suite}`,
];

const farFuture = () => new Date(Date.now() + 24 * 3600_000);

/**
 * The full sentence a refused write speaks, message and causes concatenated — the way the
 * credential suite reads constraint failures, so the assertion names the exact index Postgres
 * refused on rather than drizzle's generic "Failed query" envelope.
 */
async function failureSentence(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "the write unexpectedly succeeded",
    (error: unknown) => {
      const parts: string[] = [];
      let current: unknown = error;
      while (current instanceof Error) {
        parts.push(current.message);
        current = (current as { cause?: unknown }).cause;
      }
      return parts.join("\n");
    },
  );
}

/** Six single-connection databases: the concurrency test races on genuinely separate sockets. */
const racers = Array.from({ length: 6 }, () => {
  const racerDatabase = createDatabase(testDatabaseUrl(), { max: 1 });
  return {
    database: racerDatabase,
    service: createPayerAccountService(racerDatabase),
  };
});

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ANY(${sql.raw(
      `ARRAY[${keyPrefixes.map((p) => `'${p}%'`).join(",")}]`,
    )})`,
  );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ANY(${sql.raw(
      `ARRAY[${keyPrefixes.map((p) => `'${p}%'`).join(",")}]`,
    )})`,
  );
  await database.execute(
    sql`DELETE FROM credit_reservations WHERE external_customer_id LIKE ANY(${sql.raw(
      `ARRAY[${keyPrefixes.map((p) => `'${p}%'`).join(",")}]`,
    )})`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ANY(${sql.raw(
      `ARRAY[${keyPrefixes.map((p) => `'${p}%'`).join(",")}]`,
    )})`,
  );
  await database.execute(
    sql`DELETE FROM payer_accounts WHERE external_customer_id LIKE ANY(${sql.raw(
      `ARRAY[${keyPrefixes.map((p) => `'${p}%'`).join(",")}]`,
    )})`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ANY(${sql.raw(
      `ARRAY[${keyPrefixes.map((p) => `'${p}%'`).join(",")}]`,
    )})`,
  );
  await Promise.all(racers.map((racer) => racer.database.$client.close()));
  await database.$client.close();
});

test("createPayerAccount is idempotent: the second create answers the existing account", async () => {
  const payer = { kind: "personal" as const, id: `${suite}-u-idem` };
  const first = await service.createPayerAccount(payer);
  const second = await service.createPayerAccount(payer);

  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(second.account.id).toBe(first.account.id);
  expect(second.account.externalCustomerId).toBe(
    first.account.externalCustomerId,
  );
  expect(second.account.payer).toEqual(payer);

  const rows = await database
    .select({ id: payerAccounts.id })
    .from(payerAccounts)
    .where(
      sql`${payerAccounts.kind} = 'personal' AND ${payerAccounts.ownerId} = ${payer.id}`,
    );
  expect(rows).toHaveLength(1);
});

test("six connections creating the same payer concurrently leave exactly one effective mapping", async () => {
  const payer = { kind: "company" as const, id: `${suite}-t-race` };
  const results = await Promise.all(
    racers.map((racer) => racer.service.createPayerAccount(payer)),
  );

  expect(results.filter((result) => result.created)).toHaveLength(1);
  const ids = new Set(results.map((result) => result.account.id));
  expect(ids.size).toBe(1);

  const rows = await database
    .select({
      id: payerAccounts.id,
      externalCustomerId: payerAccounts.externalCustomerId,
    })
    .from(payerAccounts)
    .where(
      sql`${payerAccounts.kind} = 'company' AND ${payerAccounts.ownerId} = ${payer.id}`,
    );
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(results[0].account.id);
});

test("an externalCustomerId cannot belong to two accounts: the second write fails", async () => {
  const { account } = await service.createPayerAccount({
    kind: "personal",
    id: `${suite}-u-holds-key`,
  });

  // A different subject trying to claim the same billing key: the unique index refuses.
  const theft = await failureSentence(
    database.insert(payerAccounts).values({
      id: `pa-${randomUUID()}`,
      kind: "company",
      ownerId: `${suite}-t-key-thief`,
      externalCustomerId: account.externalCustomerId,
    }),
  );
  expect(theft).toContain(
    'duplicate key value violates unique constraint "payer_accounts_external_customer_unique_idx"',
  );
});

test("a key already claimed by an explicit binding makes provisioning fail loudly", async () => {
  // The 02.2 shape: an explicit mapping (here a legacy one) already owns the key this payer
  // would derive. Provisioning must surface the database's own violation — never a silent
  // no-op, and never a self-created second account.
  const payer = { kind: "personal" as const, id: `${suite}-u-bound` };
  const claimedKey = `payer-personal-${payer.id}`;
  await database
    .insert(billingCustomers)
    .values({ externalId: claimedKey, name: null })
    .onConflictDoNothing({ target: billingCustomers.externalId });
  await database.insert(payerAccounts).values({
    id: `pa-${randomUUID()}`,
    kind: "legacy_deployment",
    ownerId: `${suite}-bound-elsewhere`,
    externalCustomerId: claimedKey,
  });

  const sentence = await failureSentence(service.createPayerAccount(payer));
  expect(sentence).toContain(
    'duplicate key value violates unique constraint "payer_accounts_external_customer_unique_idx"',
  );

  // And the claim was not stolen: the key still maps to the explicit binding alone.
  const mappings = await database
    .select({ ownerId: payerAccounts.ownerId })
    .from(payerAccounts)
    .where(eq(payerAccounts.externalCustomerId, claimedKey));
  expect(mappings).toHaveLength(1);
  expect(mappings[0].ownerId).toBe(`${suite}-bound-elsewhere`);
});

test("a subject cannot hold a second account key: the second write fails", async () => {
  const payer = { kind: "personal" as const, id: `${suite}-u-two-keys` };
  const { account } = await service.createPayerAccount(payer);

  // The other key needs its own billing customer row so the test fails on the SUBJECT
  // uniqueness, not on the foreign key.
  const otherKey = `payer-personal-${suite}-u-two-keys-shadow`;
  await database
    .insert(billingCustomers)
    .values({ externalId: otherKey, name: null })
    .onConflictDoNothing({ target: billingCustomers.externalId });

  const secondKey = await failureSentence(
    database.insert(payerAccounts).values({
      id: `pa-${randomUUID()}`,
      kind: payer.kind,
      ownerId: payer.id,
      externalCustomerId: otherKey,
    }),
  );
  expect(secondKey).toContain(
    'duplicate key value violates unique constraint "payer_accounts_owner_unique_idx"',
  );
  expect(otherKey).not.toBe(account.externalCustomerId);
});

test("payerKey resolves the registered account, and nothing else", async () => {
  const payer = { kind: "personal" as const, id: `${suite}-u-resolve` };
  const { account } = await service.createPayerAccount(payer);
  expect(await service.payerKey(payer)).toBe(account.externalCustomerId);

  // An unregistered subject: fail closed. Never the derived string, never a fallback account.
  const ghost = { kind: "personal" as const, id: `${suite}-u-ghost` };
  await expect(service.payerKey(ghost)).rejects.toBeInstanceOf(
    PayerAccountMissingError,
  );

  // An isolated owner stays isolated even when a row exists (the 02.2 mapping writes such rows).
  const isolatedKey = `payer-unknown-${suite}-unk1`;
  await database
    .insert(billingCustomers)
    .values({ externalId: isolatedKey, name: null })
    .onConflictDoNothing({ target: billingCustomers.externalId });
  await database.insert(payerAccounts).values({
    id: `pa-${randomUUID()}`,
    kind: "unknown_owner",
    ownerId: `${suite}-unk1`,
    externalCustomerId: isolatedKey,
  });
  await expect(
    service.payerKey({ kind: "unknown_owner", id: `${suite}-unk1` }),
  ).rejects.toBeInstanceOf(PayerOwnerUnknownError);
  await expect(
    service.createPayerAccount({ kind: "unknown_owner", id: `${suite}-unk2` }),
  ).rejects.toBeInstanceOf(PayerOwnerUnknownError);
});

test("accounts are isolated: A's grants and ledger never surface in B's reads", async () => {
  const a = await service.createPayerAccount({
    kind: "personal",
    id: `${suite}-u-iso-a`,
  });
  const b = await service.createPayerAccount({
    kind: "personal",
    id: `${suite}-u-iso-b`,
  });
  const keyA = a.account.externalCustomerId;
  const keyB = b.account.externalCustomerId;
  expect(keyA).not.toBe(keyB);

  await writer.grantCredits({
    externalCustomerId: keyA,
    source: "promo",
    totalCents: 100_000,
    expiresAt: farFuture(),
    idempotencyKey: `${suite}-iso-grant`,
  });
  const reservation = await writer.reserveCredits({
    externalCustomerId: keyA,
    idempotencyKey: `${suite}-iso-reserve`,
    maximumCents: 40_000,
    expiresAt: farFuture(),
  });
  if (!reservation.reserved)
    throw new Error("expected the reservation to hold");
  await writer.settleReservation({
    reservationId: reservation.reservationId,
    actual: { numerator: 30_000n, denominator: 1n },
    title: "account A only",
  });

  // A sees its own grant and consumption.
  expect(await writer.availableBalance(keyA)).toBe(70_000);
  expect((await credits.grants(keyA)).map((grant) => grant.id)).toHaveLength(1);
  const consumptionA = await credits.consumption(
    { from: null, to: null, page: 1 },
    keyA,
  );
  expect(consumptionA.entries).toHaveLength(1);

  // B sees none of it: no aggregated balances, no leaked grant, no leaked ledger row.
  expect(await writer.availableBalance(keyB)).toBe(0);
  expect(await credits.grants(keyB)).toHaveLength(0);
  const consumptionB = await credits.consumption(
    { from: null, to: null, page: 1 },
    keyB,
  );
  expect(consumptionB.entries).toHaveLength(0);
});

test("creating an account creates no balance of any kind", async () => {
  const payer = { kind: "company" as const, id: `${suite}-t-fresh` };
  const { account } = await service.createPayerAccount(payer);

  expect(await writer.availableBalance(account.externalCustomerId)).toBe(0);
  const grants = await database
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(eq(creditGrants.externalCustomerId, account.externalCustomerId));
  expect(grants).toHaveLength(0);
  const ledger = await database
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, account.externalCustomerId));
  expect(ledger).toHaveLength(0);
});

test("a legacy_deployment account maps onto the existing deployment key, unmoved", async () => {
  const tenantId = `${suite}-deploy`;
  const { account } = await service.createPayerAccount({
    kind: "legacy_deployment",
    id: tenantId,
  });
  expect(account.externalCustomerId).toBe(
    deploymentExternalCustomerId(tenantId),
  );

  // The existing records stay on that key; the account row is the only new thing.
  const mappings = await database
    .select({ id: payerAccounts.id })
    .from(payerAccounts)
    .where(eq(payerAccounts.externalCustomerId, account.externalCustomerId));
  expect(mappings).toHaveLength(1);
});
