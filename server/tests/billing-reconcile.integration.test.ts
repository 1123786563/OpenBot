import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { createReconciler } from "../src/billing/reconcile";
import { createDatabase } from "../src/db/client";
import { billingSubscriptions } from "../src/db/schema/billing";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The reconciliation skeleton against a real PostgreSQL (T7). Every test builds its own
 * rows in one customer's namespace and cleans them up: the pass reads WHOLE tables, so the
 * tests must not depend on (or disturb) whatever else the database holds — they assert on
 * THEIR findings (matched by subject), never on the report's total length.
 *
 * The three breaks under test are the ones the invariant comments name: a paid order
 * without its fact row (half-committed confirm), an applied order with no live projection
 * row (entitlement lost after grant), and the credit identity split (grants.used vs
 * ledger.applied disagreeing).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `rct-${randomUUID().slice(0, 8)}`;
// This test deployment's own customer key: the projection side of the three-way scopes to
// it, exactly as the production assembly scopes to the deployment's key.
const reconciler = createReconciler(database, prefix);

/** This test's rows only: subject-prefix matched, so neighbours in the table are invisible. */
const mine = <T extends { subject: string }>(findings: readonly T[]) =>
  findings.filter((finding) => finding.subject.startsWith(prefix));

afterAll(async () => {
  await database
    .delete(paymentEvents)
    .where(like(paymentEvents.orderId, `${prefix}%`));
  await database
    .delete(paymentOrders)
    .where(like(paymentOrders.id, `${prefix}%`));
  await database
    .delete(creditLedger)
    .where(like(creditLedger.externalCustomerId, `${prefix}%`));
  await database
    .delete(creditGrants)
    .where(like(creditGrants.externalCustomerId, `${prefix}%`));
  await database
    .delete(billingSubscriptions)
    .where(like(billingSubscriptions.externalCustomerId, `${prefix}%`));
  await database.$client.close();
});

/** One settled-and-activated order, its fact, its grant/ledger pair, and a live projection row. */
async function agreeingWorld(): Promise<string> {
  const orderId = `${prefix}-ok`;
  await database.insert(paymentOrders).values({
    id: orderId,
    planCode: "pro",
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    status: "paid",
    activationState: "applied",
    channelTransactionId: `${prefix}-tx-ok`,
    checkoutPayload: null,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    version: 2,
  });
  await database.insert(paymentEvents).values({
    id: `${orderId}-fact`,
    orderId,
    kind: "fact",
    code: "paid",
    state: "paid",
    channelTransactionId: `${prefix}-tx-ok`,
  });
  // The credit identity for this customer: one grant fully drawn, one ledger row recording
  // exactly that draw.
  await database.insert(creditGrants).values({
    id: `${prefix}-g1`,
    externalCustomerId: prefix,
    source: "plan",
    reason: "test",
    total: 1000,
    used: 1000,
    expiresAt: new Date(Date.now() + 24 * 3600_000),
    status: "active",
    idempotencyKey: `${prefix}-gk1`,
  });
  await database.insert(creditLedger).values({
    id: `${prefix}-l1`,
    externalCustomerId: prefix,
    grantId: `${prefix}-g1`,
    title: "模型调用",
    requestId: null,
    idempotencyKey: `${prefix}-lk1`,
    credits: 1000,
    applied: 1000,
  });
  // A live projection row (applied orders ↔ live subscription).
  await database.insert(billingSubscriptions).values({
    externalCustomerId: prefix,
    provider: "lago",
    providerSubscriptionId: `${prefix}-sub`,
    planCode: "pro",
    status: "active",
  });
  return orderId;
}

describe("reconcile (the skeleton, over real tables)", () => {
  test("an agreeing world yields no findings for it", async () => {
    await agreeingWorld();
    const report = await reconciler.reconcile();
    expect(mine(report.findings)).toEqual([]);
    // And the counts saw this world's rows at all (checked > 0 proves the pass read them).
    expect(report.checked.paidOrders).toBeGreaterThanOrEqual(1);
    expect(report.checked.appliedOrders).toBeGreaterThanOrEqual(1);
    expect(report.checked.creditCustomers).toBeGreaterThanOrEqual(1);
  });

  test("a paid order without its fact row is paid_without_fact, named by order id", async () => {
    const orderId = `${prefix}-nofact`;
    await database.insert(paymentOrders).values({
      id: orderId,
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      status: "paid",
      activationState: "pending",
      channelTransactionId: `${prefix}-tx-nofact`,
      checkoutPayload: null,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      version: 2,
    });
    const report = await reconciler.reconcile();
    const findings = mine(report.findings);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: "payment",
      code: "paid_without_fact",
      subject: orderId,
    });
  });

  test("a fact naming a different transaction is fact_transaction_mismatch", async () => {
    const orderId = `${prefix}-swap`;
    await database.insert(paymentOrders).values({
      id: orderId,
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      status: "paid",
      activationState: "pending",
      channelTransactionId: `${prefix}-tx-order`,
      checkoutPayload: null,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      version: 2,
    });
    await database.insert(paymentEvents).values({
      id: `${orderId}-fact`,
      orderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `${prefix}-tx-other`, // the swap
    });
    const report = await reconciler.reconcile();
    const findings = mine(report.findings);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: "payment",
      code: "fact_transaction_mismatch",
      subject: orderId,
    });
  });

  test("an applied order with no live projection row is applied_without_subscription", async () => {
    const orderId = `${prefix}-nolive`;
    await database.insert(paymentOrders).values({
      id: orderId,
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      status: "paid",
      activationState: "applied", // granted…
      channelTransactionId: `${prefix}-tx-nolive`,
      checkoutPayload: null,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      version: 2,
    });
    await database.insert(paymentEvents).values({
      id: `${orderId}-fact`,
      orderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `${prefix}-tx-nolive`,
    });
    // …but NO live projection row for this customer (the agreeing world used `prefix` as its
    // customer; this order's customer has none). The single-customer membership ask: the
    // finding fires when the customer key has no live row.
    const before = await reconciler.reconcile();
    void before; // (the world above may hold the agreeing customer's live row — see below)
    // Neutralize the agreeing world's live row for a clean single-customer ask.
    await database
      .update(billingSubscriptions)
      .set({ status: "canceled" })
      .where(eq(billingSubscriptions.externalCustomerId, prefix));
    const report = await reconciler.reconcile();
    const findings = report.findings.filter(
      (finding) =>
        finding.code === "applied_without_subscription" &&
        finding.subject.startsWith(prefix),
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]).toMatchObject({
      category: "payment",
      code: "applied_without_subscription",
      subject: expect.stringMatching(new RegExp(`^${prefix}`)),
    });
  });

  test("a split credit identity is grants_ledger_divergence, named by customer, with the delta", async () => {
    // Break the agreeing customer's identity: the ledger says 1000 was absorbed (it does),
    // the grant says only 600 was drawn — manual surgery's signature.
    await database
      .update(creditGrants)
      .set({ used: 600 })
      .where(eq(creditGrants.id, `${prefix}-g1`));
    const report = await reconciler.reconcile();
    const finding = report.findings.find(
      (item) =>
        item.code === "grants_ledger_divergence" && item.subject === prefix,
    );
    expect(finding).toBeDefined();
    expect(finding?.category).toBe("credits");
    expect(finding?.detail).toContain("600");
    expect(finding?.detail).toContain("1000");
  });
});
