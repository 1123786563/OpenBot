import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import { createPayerAccountService } from "../src/billing/payer-accounts";
import { payerKey } from "../src/billing/payer";
import { billingCustomers } from "../src/db/schema/billing";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The read side of the ledger against a real database (audit A1): the summary must show only
 * what admission would actually let you spend — expired grants excluded, active holds subtracted
 * — and `grantCount` must count exactly the grants behind `remaining`.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const prefix = `sumtest-${randomUUID().slice(0, 8)}`;

// The same teardown discipline the other integration suites use: delete by the run's own prefix,
// children first, then close the pool. No shared fixture, no cross-test coupling.
afterAll(async () => {
  const { sql } = await import("drizzle-orm");
  // Allocation ids are random `cra-…`, so they are reached by subquery through their reservation,
  // never by their own id prefix.
  await database.execute(
    sql`DELETE FROM credit_reservation_allocations WHERE reservation_id IN (SELECT id FROM credit_reservations WHERE external_customer_id LIKE ${`${prefix}%`})`,
  );
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
    sql`DELETE FROM credit_grants WHERE idempotency_key LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM billing_credit_accounts WHERE external_customer_id LIKE ${`${prefix}%`} OR external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`${prefix}%`} OR external_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.$client.close();
});

test("an expired grant is not part of the balance, and a live hold is", async () => {
  const customer = `${prefix}-a`;
  const live = `${prefix}-live`;
  const expired = `${prefix}-expired`;

  // The account key rides in the constructor now (02.4's convergence): the reads answer this
  // deployment's own key, and no read call names a customer any more.
  const credits = createCredits({
    database,
    externalCustomerKey: customer,
    catalog: new Map(),
  });

  await writer.grantCredits({
    externalCustomerId: customer,
    source: "plan",
    totalCents: 10_000,
    expiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKey: live,
  });
  await writer.grantCredits({
    externalCustomerId: customer,
    source: "promo",
    totalCents: 5_000,
    expiresAt: new Date(Date.now() - 1_000),
    idempotencyKey: expired,
  });

  const beforeHold = await credits.summary();
  expect(beforeHold.plan).toEqual({
    total: 100,
    used: 0,
    remaining: 100,
    held: 0,
  });
  expect(beforeHold.rewards.remaining).toBe(0);
  expect(beforeHold.rewards.grantCount).toBe(0);
  expect(beforeHold.rewards.total).toBe(0);

  const reserved = await writer.reserveCredits({
    externalCustomerId: customer,
    idempotencyKey: `${prefix}-hold`,
    maximumCents: 2_100,
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(reserved.reserved).toBe(true);

  const held = await credits.summary();
  expect(held.plan.held).toBe(21);
  expect(held.plan.remaining).toBe(79);

  if (reserved.reserved) {
    await writer.releaseReservation(reserved.reservationId, "test");
  }
  const released = await credits.summary();
  expect(released.plan.remaining).toBe(100);
  expect(released.plan.held).toBe(0);

  // The page and the gate agree, to within the one unit a carried remainder occupies.
  const spendable = await writer.availableBalance(customer);
  expect(
    released.plan.remaining * 100 +
      released.rewards.remaining * 100 -
      spendable,
  ).toBeLessThanOrEqual(1);
});

/*
 * BP07/#375：个人余额面随答账户级能力状态（隔离=能力不可用+原因），读的是
 * billing_credit_accounts 的既有行——无行=从未被隔离=active；隔离行把行上必留的原因
 * 原样带出，页面据此说「能力不可用」而不是把冻结画成普通余额。
 */
test("the personal balance names the account capability status, quarantined reason and all", async () => {
  const plain = `${prefix}-plain`;
  const quarantined = `${prefix}-quarantined`;

  // 未注册账户行的 key：active 是「没有隔离事实」的诚实读法，不是猜测。
  const plainCredits = createCredits({
    database,
    externalCustomerKey: plain,
    catalog: new Map(),
  });
  const plainBalance = await plainCredits.personalBalance({
    kind: "personal",
    id: `${prefix}-user`,
  });
  expect(plainBalance.account).toEqual({
    status: "active",
    quarantineReason: null,
  });

  // 隔离行：经 payer 服务自己的隔离入口种下（原因必留），读侧原样带出。隔离的
  // Customer 必须是 personalBalance 实际解析的键（payerKey 的 personal 派生键），
  // 而不是调用方随手起的客户名——这正是读侧按解析键查账户行的含义。
  const resolvedKey = payerKey({ kind: "personal", id: `${prefix}-user` });
  await database.insert(billingCustomers).values({ externalId: resolvedKey });
  await createPayerAccountService(database).quarantineUnknownAccount({
    externalCustomerId: resolvedKey,
    reason: "bp07 fixture: unattributable legacy key",
    actor: "bp07-fixture",
  });
  const quarantinedCredits = createCredits({
    database,
    externalCustomerKey: resolvedKey,
    catalog: new Map(),
  });
  const quarantinedBalance = await quarantinedCredits.personalBalance({
    kind: "personal",
    id: `${prefix}-user`,
  });
  expect(quarantinedBalance.account).toEqual({
    status: "quarantined",
    quarantineReason: "bp07 fixture: unattributable legacy key",
  });
});
