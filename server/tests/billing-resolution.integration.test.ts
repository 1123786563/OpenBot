import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createAccountReconciler } from "../src/billing/account-reconcile";
import {
  type AccountResolutionOutcome,
  createAccountResolutionService,
} from "../src/billing/account-resolution";
import { readCapacity } from "../src/billing/capacity";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createRecoveryScanner } from "../src/billing/recovery-scan";
import { createDatabase } from "../src/db/client";
import { accessGrants, botServices } from "../src/db/schema";
import {
  billingAccountResolutions,
  payerAccounts,
} from "../src/db/schema/billing";
import { creditReservations } from "../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost BP06 (#374): the per-account billing anomaly pass and the account-level
 * resolution registry, on a real PostgreSQL (TEST_DATABASE_URL — the dedicated bf7 verify
 * database, never the live one).
 *
 * WHAT THE ACs DEMAND OF THESE TESTS, AND WHERE EACH LIVES:
 *
 *   汇总金额相等但个体交易错配仍报错；跨账户发放/消费不被相互抵消 — the account pass's
 *     per-GRANT identity catches a row-level break the account sums hide (two grants whose
 *     mismatches cancel exactly), and a ledger row attributed across accounts is named on
 *     BOTH books — never netted away by either side's agreeing totals.
 *
 *   未经证据不能释放未知 hold；技术期限过后仍占可用余额 — the pass LISTS the unknown hold
 *     with its occupancy and deadline flag, and the test reads the capacity after the
 *     deadline: the hold still occupies in full, its status unchanged, released by nothing
 *     here (only 08.9's evidenced disposal may move it — a different module's suite).
 *
 *   授权补发/结算/释放/平台承担损失与人工退款结果登记可重放不重复；未授权或超可退额拒绝 —
 *     the registry: an authorized command registers once and replays by its recorded row
 *     (no second row, no second audit event); an unauthorized command refuses with a
 *     denial in the trail; a refund past the account's refundable ceiling (paid facts on
 *     its OWN orders minus registered refunds) refuses with the numbers in the refusal.
 *
 * Fixture honesty: the credit identity breaks are seeded by direct row writes — the
 * writer keeps grants and ledger in sync in one transaction, so a broken pair is exactly
 * the crashed-migration/manual-surgery world the pass audits (the same discipline T7's
 * suite uses). Everything the registry does goes through its service.
 *
 * Isolation: every scenario seeds under its own prefix; fixtures are deleted by prefix in
 * afterAll. The pass reads whole tables, so assertions are prefix-scoped (this suite's
 * entries matched by account key, never by report length).
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const scanner = createRecoveryScanner({ database });
const accountReconciler = createAccountReconciler({ database });
const prefix = `bp06-${randomUUID().slice(0, 8)}`;

const GRANT_TOTAL = 10_000_00; // 10_000 credits, ×100

/** The in-memory audit capture: the registry's trail, as the assertions read it. */
function makeAudit() {
  const events: AuditEventInput[] = [];
  const store: AuditStore = {
    insert: async (event) => {
      events.push(event);
    },
  };
  return {
    store,
    events,
    of: (eventType: string) => events.filter((e) => e.eventType === eventType),
  };
}

let seedCounter = 0;

/** A credit account with one live grant, seeded through the writer. */
async function seedAccount(): Promise<string> {
  const n = ++seedCounter;
  const accountKey = `openbot-personal-${prefix}-user-${n}`;
  await writer.grantCredits({
    externalCustomerId: accountKey,
    source: "plan",
    totalCents: GRANT_TOTAL,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-grant-${n}`,
  });
  return accountKey;
}

/** The pass's entry for one account, or null. */
async function entryOf(accountKey: string) {
  const report = await accountReconciler.reconcileAccounts();
  return (
    report.accounts.find((entry) => entry.accountKey === accountKey) ?? null
  );
}

afterAll(async () => {
  await database
    .delete(billingAccountResolutions)
    .where(like(billingAccountResolutions.idempotencyKey, `${prefix}%`));
  await database
    .delete(paymentEvents)
    .where(like(paymentEvents.orderId, `${prefix}%`));
  await database
    .delete(paymentOrders)
    .where(like(paymentOrders.id, `${prefix}%`));
  await database
    .delete(payerAccounts)
    .where(
      like(payerAccounts.externalCustomerId, `openbot-personal-${prefix}%`),
    );
  await database.execute(
    sql`DELETE FROM credit_reservations WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_recovery_items WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
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

// ── AC1: sums agree, the individual row does not ──

test("a grant-level mismatch the account sums hide is still reported", async () => {
  const accountKey = await seedAccount();
  // Two grants whose mismatches cancel EXACTLY: g1 drawn 100 more than its rows say,
  // g2 drawn 100 less. Account sums: used == applied. The pass must still name both.
  await database.insert(creditGrants).values({
    id: `${prefix}-g1`,
    externalCustomerId: accountKey,
    source: "plan",
    reason: "fixture",
    total: 1_000,
    used: 600,
    expiresAt: new Date(Date.now() + 24 * 3600_000),
    status: "active",
    idempotencyKey: `${prefix}-gk1`,
  });
  await database.insert(creditGrants).values({
    id: `${prefix}-g2`,
    externalCustomerId: accountKey,
    source: "plan",
    reason: "fixture",
    total: 1_000,
    used: 200,
    expiresAt: new Date(Date.now() + 24 * 3600_000),
    status: "active",
    idempotencyKey: `${prefix}-gk2`,
  });
  await database.insert(creditLedger).values([
    {
      id: `${prefix}-l1`,
      externalCustomerId: accountKey,
      grantId: `${prefix}-g1`,
      title: "fixture draw",
      idempotencyKey: `${prefix}-lk1`,
      credits: 500,
      applied: 500,
    },
    {
      id: `${prefix}-l2`,
      externalCustomerId: accountKey,
      grantId: `${prefix}-g2`,
      title: "fixture draw",
      idempotencyKey: `${prefix}-lk2`,
      credits: 300,
      applied: 300,
    },
  ]);
  // The seeded writer grant's used is 0 and its rows 0 — it agrees.

  const entry = await entryOf(accountKey);
  expect(entry).not.toBeNull();
  const mismatches = entry!.anomalies.filter(
    (a) => a.code === "grant_ledger_row_mismatch",
  );
  expect(mismatches.map((a) => a.subject).sort()).toEqual([
    `${prefix}-g1`,
    `${prefix}-g2`,
  ]);
  // And the sum identity did NOT fire: the account's own totals agree (600 + 200 used
  // == 500 + 300 applied), so the sum-level pass would have said nothing.
  expect(
    entry!.anomalies.filter(
      (a) => a.code === "account_grants_ledger_divergence",
    ),
  ).toEqual([]);
});

test("a cross-account attribution is named on BOTH books, never netted", async () => {
  const accountA = await seedAccount();
  const accountB = await seedAccount();
  // A draw recorded on A's books, attributed to B's grant: both sides' sums still agree
  // within their own accounts; only the attribution check can see it.
  await database.insert(creditGrants).values({
    id: `${prefix}-xg`,
    externalCustomerId: accountB,
    source: "plan",
    reason: "fixture",
    total: 1_000,
    used: 400,
    expiresAt: new Date(Date.now() + 24 * 3600_000),
    status: "active",
    idempotencyKey: `${prefix}-xgk`,
  });
  await database.insert(creditLedger).values({
    id: `${prefix}-xl`,
    externalCustomerId: accountA,
    grantId: `${prefix}-xg`,
    title: "fixture draw",
    idempotencyKey: `${prefix}-xlk`,
    credits: 400,
    applied: 400,
  });

  const entryA = await entryOf(accountA);
  const entryB = await entryOf(accountB);
  expect(
    entryA!.anomalies.filter(
      (a) => a.code === "cross_account_ledger_attribution",
    ),
  ).toHaveLength(1);
  expect(
    entryB!.anomalies.filter(
      (a) => a.code === "cross_account_ledger_attribution",
    ),
  ).toHaveLength(1);
});

// ── AC2: the unknown hold, listed and still occupying past its deadline ──

test("an unknown hold is listed, and past its technical deadline still occupies in full", async () => {
  const accountKey = await seedAccount();
  const reserveResult = await writer.reserveCredits({
    externalCustomerId: accountKey,
    idempotencyKey: `${prefix}-hold-idem`,
    maximumCents: 400,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  if (!reserveResult.reserved) throw new Error("fixture reserve refused");
  const reservationId = reserveResult.reservationId;
  await writer.markReservationUnknown(reservationId, "dispatch_result_unknown");

  // Before the deadline: listed, occupying, not yet past.
  let entry = await entryOf(accountKey);
  expect(entry!.unknownHolds).toHaveLength(1);
  expect(entry!.unknownHolds[0]).toMatchObject({
    reservationId,
    maximumCredits: 400,
    pastTechnicalDeadline: false,
    namedForRecovery: false,
  });

  // The technical deadline passes (the row's own clock moved, never a wall wait).
  await database
    .update(creditReservations)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(creditReservations.id, reservationId));

  entry = await entryOf(accountKey);
  expect(entry!.unknownHolds[0].pastTechnicalDeadline).toBe(true);

  // AC2's second half: the deadline changed NOTHING about occupancy — the hold still
  // counts against the account's capacity in full, its status unchanged, released by
  // nothing here (no evidence, no release; 08.9 owns that decision on its own evidence).
  const [hold] = await database
    .select({ status: creditReservations.status })
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId));
  expect(hold?.status).toBe("unknown");
  const capacity = await readCapacity(database, accountKey);
  expect(capacity.freeUnits).toBe(GRANT_TOTAL - 400);

  // And once the scan names it, the list says so (the recovery linkage an operator reads).
  await scanner.scanOnce();
  entry = await entryOf(accountKey);
  expect(entry!.unknownHolds[0].namedForRecovery).toBe(true);
});

// ── AC1 (payments): anomalies attribute through the mapping; unowned stays unattributed ──

test("payment anomalies attribute through the payer mapping; unowned orders are never guessed", async () => {
  const accountKey = await seedAccount();
  await database.insert(payerAccounts).values({
    id: `${prefix}-pa`,
    kind: "personal",
    payerId: `${prefix}-payer`,
    externalCustomerId: accountKey,
  });

  const ownedOrderId = `${prefix}-po1`;
  await database.insert(paymentOrders).values({
    id: ownedOrderId,
    planCode: "pro",
    provider: "alipay",
    amountCents: 8_800,
    currency: "CNY",
    status: "paid",
    activationState: "applied",
    channelTransactionId: `${ownedOrderId}-tx`,
    checkoutPayload: null,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    paidAt: new Date(),
    version: 2,
    ownerPayerKind: "personal",
    ownerPayerId: `${prefix}-payer`,
  });
  await database.insert(paymentEvents).values({
    id: `${ownedOrderId}-anom`,
    orderId: ownedOrderId,
    kind: "anomaly",
    code: "amount_mismatch",
    state: null,
    channelTransactionId: `${ownedOrderId}-tx`,
    amountCents: 7_700,
    detail: "fixture",
  });

  const unownedOrderId = `${prefix}-po2`;
  await database.insert(paymentOrders).values({
    id: unownedOrderId,
    planCode: "pro",
    provider: "alipay",
    amountCents: 8_800,
    currency: "CNY",
    status: "paid",
    activationState: "applied",
    channelTransactionId: `${unownedOrderId}-tx`,
    checkoutPayload: null,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    paidAt: new Date(),
    version: 2,
  });
  await database.insert(paymentEvents).values({
    id: `${unownedOrderId}-anom`,
    orderId: unownedOrderId,
    kind: "anomaly",
    code: "over_paid",
    state: null,
    channelTransactionId: `${unownedOrderId}-tx`,
    amountCents: 9_900,
    detail: "fixture",
  });

  const report = await accountReconciler.reconcileAccounts();
  const entry = report.accounts.find((e) => e.accountKey === accountKey);
  expect(entry).not.toBeNull();
  expect(
    entry!.anomalies.filter(
      (a) => a.code === "payment_anomaly_open" && a.subject === ownedOrderId,
    ),
  ).toHaveLength(1);
  // The unowned order is listed for the operator and attributed to NOBODY.
  expect(report.unattributedPaymentAnomalies).toContainEqual({
    orderId: unownedOrderId,
    code: "over_paid",
  });
  const anyEntry = report.accounts.find((e) =>
    e.anomalies.some((a) => a.subject === unownedOrderId),
  );
  expect(anyEntry).toBeUndefined();
});

// ── AC3: the resolution registry ──

function makeService(options: { authorize: boolean }) {
  const audit = makeAudit();
  const service = createAccountResolutionService({
    database,
    authorize: () => options.authorize,
    audit: audit.store,
  });
  return { service, audit };
}

test("an authorized command registers once; its replay answers the recorded row", async () => {
  const accountKey = await seedAccount();
  const { service, audit } = makeService({ authorize: true });
  const command = {
    accountKey,
    action: "reissue" as const,
    reasonCode: "paid_not_delivered",
    evidence: { kind: "reconcile_finding" as const, reference: `${prefix}-f1` },
    operatorId: `${prefix}-admin`,
    idempotencyKey: `${prefix}-cmd-1`,
    detail: "redeliver the plan grant the failed activation owed",
  };

  const first = await service.recordResolution(command);
  expect(first.status).toBe("registered");

  // The transport retry: the SAME key answers the recorded row — no second row, no
  // second audit event (可重放不重复).
  const replay = await service.recordResolution({
    ...command,
    detail: "retry",
  });
  expect(replay.status).toBe("replayed");
  if (first.status !== "registered" || replay.status !== "replayed") return;
  expect(replay.resolution.id).toBe(first.resolution.id);
  expect(await service.resolutionsOf(accountKey)).toHaveLength(1);
  expect(audit.of("billing.account_resolution.recorded")).toHaveLength(1);
});

test("an unauthorized command refuses, leaves no row, and records the refusal", async () => {
  const accountKey = await seedAccount();
  const { service, audit } = makeService({ authorize: false });
  const refused = await service.recordResolution({
    accountKey,
    action: "settle",
    reasonCode: "operator_verified",
    evidence: { kind: "operator_statement", reference: `${prefix}-stmt` },
    operatorId: `${prefix}-notadmin`,
    idempotencyKey: `${prefix}-cmd-2`,
    detail: "should not land",
  });
  expect(refused).toMatchObject({
    status: "refused",
    reasonCode: "unauthorized",
  });
  expect(await service.resolutionsOf(accountKey)).toHaveLength(0);
  expect(audit.of("billing.account_resolution.denied")).toHaveLength(1);
});

test("a refund past the account's refundable ceiling refuses with the numbers", async () => {
  const accountKey = await seedAccount();
  await database.insert(payerAccounts).values({
    id: `${prefix}-pa2`,
    kind: "personal",
    payerId: `${prefix}-payer2`,
    externalCustomerId: accountKey,
  });
  // The account's own paid order: 8800 cents paid and facted.
  const orderId = `${prefix}-po3`;
  await database.insert(paymentOrders).values({
    id: orderId,
    planCode: "pro",
    provider: "alipay",
    amountCents: 8_800,
    currency: "CNY",
    status: "paid",
    activationState: "applied",
    channelTransactionId: `${orderId}-tx`,
    checkoutPayload: null,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    paidAt: new Date(),
    version: 2,
    ownerPayerKind: "personal",
    ownerPayerId: `${prefix}-payer2`,
  });
  await database.insert(paymentEvents).values({
    id: `${orderId}-fact`,
    orderId,
    kind: "fact",
    code: "paid",
    state: "paid",
    channelTransactionId: `${orderId}-tx`,
    amountCents: 8_800,
    detail: "fixture",
  });

  const { service } = makeService({ authorize: true });
  // A refund within the paid facts registers.
  const within = await service.recordResolution({
    accountKey,
    action: "refund",
    reasonCode: "duplicate_payment",
    evidence: { kind: "payment_event", reference: `${orderId}-fact` },
    operatorId: `${prefix}-admin`,
    idempotencyKey: `${prefix}-cmd-3`,
    amountCents: 5_000,
    detail: "manual channel refund, half the paid amount",
  });
  expect(within.status).toBe("registered");

  // The next refund would pass the ceiling (8800 − 5000 = 3800 refundable): refused,
  // with the numbers the operator needs, and nothing registered.
  const over: AccountResolutionOutcome = await service.recordResolution({
    accountKey,
    action: "refund",
    reasonCode: "duplicate_payment",
    evidence: { kind: "payment_event", reference: `${orderId}-fact` },
    operatorId: `${prefix}-admin`,
    idempotencyKey: `${prefix}-cmd-4`,
    amountCents: 3_801,
    detail: "one cent past",
  });
  expect(over).toMatchObject({
    status: "refused",
    reasonCode: "refund_ceiling_exceeded",
    detail: { refundableCents: 3_800, requestedCents: 3_801 },
  });
  expect(await service.resolutionsOf(accountKey)).toHaveLength(1);

  // Money on an order nobody attributes to the account does not widen the ceiling: an
  // unowned paid order's facts are not this account's refundable balance.
  const otherOrderId = `${prefix}-po4`;
  await database.insert(paymentOrders).values({
    id: otherOrderId,
    planCode: "pro",
    provider: "alipay",
    amountCents: 50_000,
    currency: "CNY",
    status: "paid",
    activationState: "applied",
    channelTransactionId: `${otherOrderId}-tx`,
    checkoutPayload: null,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    paidAt: new Date(),
    version: 2,
  });
  await database.insert(paymentEvents).values({
    id: `${otherOrderId}-fact`,
    orderId: otherOrderId,
    kind: "fact",
    code: "paid",
    state: "paid",
    channelTransactionId: `${otherOrderId}-tx`,
    amountCents: 50_000,
    detail: "fixture",
  });
  const stranger: AccountResolutionOutcome = await service.recordResolution({
    accountKey,
    action: "refund",
    reasonCode: "duplicate_payment",
    evidence: { kind: "payment_event", reference: `${otherOrderId}-fact` },
    operatorId: `${prefix}-admin`,
    idempotencyKey: `${prefix}-cmd-5`,
    amountCents: 3_801,
    detail: "still past the account's own ceiling",
  });
  expect(stranger).toMatchObject({
    status: "refused",
    reasonCode: "refund_ceiling_exceeded",
  });
});

test("shape refusals: no evidence, a refund without an amount, a malformed reason", async () => {
  const accountKey = await seedAccount();
  const { service } = makeService({ authorize: true });
  const base = {
    accountKey,
    action: "release" as const,
    reasonCode: "operator_verified",
    evidence: { kind: "recovery_evidence" as const, reference: `${prefix}-q1` },
    operatorId: `${prefix}-admin`,
    idempotencyKey: `${prefix}-cmd-6`,
    detail: "fixture",
  };

  const noEvidence: AccountResolutionOutcome = await service.recordResolution({
    ...base,
    idempotencyKey: `${prefix}-cmd-6a`,
    evidence: undefined as unknown as typeof base.evidence,
  });
  expect(noEvidence).toMatchObject({
    status: "refused",
    reasonCode: "request_invalid",
  });

  const refundNoAmount: AccountResolutionOutcome =
    await service.recordResolution({
      ...base,
      action: "refund",
      idempotencyKey: `${prefix}-cmd-6b`,
    });
  expect(refundNoAmount).toMatchObject({
    status: "refused",
    reasonCode: "request_invalid",
    detail: { field: "amountCents" },
  });

  const badReason: AccountResolutionOutcome = await service.recordResolution({
    ...base,
    reasonCode: "Not A Code",
    idempotencyKey: `${prefix}-cmd-6c`,
  });
  expect(badReason).toMatchObject({
    status: "refused",
    reasonCode: "request_invalid",
  });

  expect(await service.resolutionsOf(accountKey)).toHaveLength(0);
});
