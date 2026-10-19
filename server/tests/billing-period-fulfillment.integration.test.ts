import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { createPaymentService } from "../src/billing/payments/service";
import { createPaymentStore } from "../src/billing/payments/store";
import { createReconciler } from "../src/billing/reconcile";
import { createBillingStore } from "../src/billing/store";
import { createDatabase } from "../src/db/client";
import {
  billingCustomers,
  billingSubscriptions,
  payerAccounts,
} from "../src/db/schema/billing";
import { creditGrants } from "../src/db/schema/credits";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * BP03 (#371) against a real PostgreSQL: the paid order's fulfillment — subscription activation
 * and the period's credit grant — split into idempotent halves that survive a partial failure
 * and recover by patching only what is missing. The store, the credit writer, the ownership
 * stamp and the reconciler are the production objects; only the provider (Lago) is a facade
 * double, because the period facts it answers are this test's inputs, not its subject.
 *
 * The delivery-complete verdict is then audited from the durable rows themselves (grant keyed
 * `plan:<orderId>`, subscription stamped with the order's owner), and a deterministic conflict
 * (a second paid order overlapping an owned entitlement) lands in `needs_resolution` with its
 * duplicate evidence — out of the sweep's retry list, never marked delivered.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const paymentStore = createPaymentStore(database);
const creditWriter = createCreditWriter(database);
const billingStore = createBillingStore(database);

const prefix = `bp371-${randomUUID().slice(0, 8)}`;
/** This run's deployment identity: the customer/subscription/grant keys all derive from it. */
const deploymentKey = `openbot-deployment-${prefix}`;
/** The payer the orders bind: a personal account created through the real payer module. */
const payer = { kind: "personal" as const, id: prefix };
const ownerKey = payerKey(payer);

const PERIOD_START = new Date("2026-10-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-11-01T00:00:00.000Z");
const PLAN_CREDITS_SCALED = 900_000; // 900 credits × CREDIT_SCALE

/** The Lago facade double: the plan gates pass, the provider answers an exact period — the
 * scenario's own, one deployment one current period, exactly the shape a real subscription
 * answers — and the ownership stamp is the REAL projection write (the thing being recovered
 * idempotently). */
function fakeLago(period: { start: Date; end: Date }) {
  const subscriptionId = `${deploymentKey}-pro`;
  return {
    subscriptionId,
    async getPlan() {
      return { found: true, interval: "monthly", currency: "CNY" };
    },
    async ensureSubscription() {
      return {
        currentPeriodStart: period.start.toISOString(),
        currentPeriodEnd: period.end.toISOString(),
      };
    },
    stampSubscriptionOwnership:
      billingStore.stampSubscriptionOwnership.bind(billingStore),
  };
}

/** The plan allowance's payout over the real credit writer, keyed `plan:<orderId>` exactly the
 * way the production assembly in src/index.ts wires it. */
function grantor(options: { failFirstGrant?: boolean; periodEnd?: Date } = {}) {
  const state = { failedOnce: false, grants: 0 };
  return {
    state,
    creditsFor: (planCode: string) =>
      planCode === "pro" ? PLAN_CREDITS_SCALED : null,
    async grantPlanCredits(input: {
      externalCustomerId: string;
      planCode: string;
      orderId: string;
      totalCents: number;
      expiresAt: Date | null;
    }) {
      if (options.failFirstGrant && !state.failedOnce) {
        state.failedOnce = true;
        throw new Error("ledger down (first attempt)");
      }
      if (input.expiresAt === null) return { inserted: false };
      const result = await creditWriter.grantCredits({
        externalCustomerId: input.externalCustomerId,
        source: "plan",
        totalCents: input.totalCents,
        expiresAt: input.expiresAt,
        reason: `plan allowance · ${input.planCode} · order ${input.orderId}`,
        idempotencyKey: `plan:${input.orderId}`,
      });
      state.grants += 1;
      return { inserted: result.inserted };
    },
    async readCurrentPeriodEnd() {
      return options.periodEnd ?? PERIOD_END;
    },
  };
}

function buildService(deps: {
  grantor: ReturnType<typeof grantor>;
  period: { start: Date; end: Date };
}) {
  return createPaymentService({
    providers: new Map(),
    store: paymentStore,
    catalog: new Map([
      ["pro", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
    ]),
    notifyBaseUrl: "https://payments.openbot.example",
    orderTtlMinutes: 15,
    latePaymentWindowHours: 24,
    acceptForeignCurrency: false,
    lago: fakeLago(deps.period),
    externalCustomerKey: deploymentKey,
    activePlanCode: async () => null,
    invalidateEntitlementCache: () => undefined,
    grantor: deps.grantor,
  });
}

/** One paid order on the personal payer, through the real store's confirm transaction. The
 * period is the caller's: sequential repurchases (the reconcile test's backdrop) and an
 * overlapping challenger (the conflict test's subject) differ only in this. */
async function paidOrder(
  transactionId: string,
  period: { start: Date; end: Date } = {
    start: PERIOD_START,
    end: PERIOD_END,
  },
) {
  const { order } = await paymentStore.insertOrder({
    planCode: "pro",
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: prefix,
    ownerPayerRef: payer,
    checkoutPayload: null,
  });
  const confirmed = await paymentStore.confirmPaid({
    id: order.id,
    expectedVersion: order.version,
    fromStatuses: ["pending"],
    channelTransactionId: transactionId,
    amountCents: 8800,
    periodStart: period.start,
    periodEnd: period.end,
  });
  expect(confirmed.claimed).toBe(true);
  return order.id;
}

const MONTH = 30 * 24 * 3600_000;

afterAll(async () => {
  await database
    .delete(paymentOrders)
    .where(eq(paymentOrders.createdBy, prefix));
  await database.delete(payerAccounts).where(eq(payerAccounts.payerId, prefix));
  await database
    .delete(creditGrants)
    .where(like(creditGrants.externalCustomerId, `%${prefix}%`));
  await database
    .delete(billingSubscriptions)
    .where(like(billingSubscriptions.externalCustomerId, `%${prefix}%`));
  await database
    .delete(billingCustomers)
    .where(like(billingCustomers.externalId, `%${prefix}%`));
  await database.$client.close();
});

test("AC1: Lago landed, the grant write failed — the retry patches only the grant half", async () => {
  await createPayerAccount(database, payer);
  await billingStore.ensureCustomerRow({ externalId: deploymentKey });
  await billingStore.upsertSubscription({
    externalCustomerId: deploymentKey,
    externalSubscriptionId: `${deploymentKey}-pro`,
    planCode: "pro",
    status: "active",
  });
  const orderId = await paidOrder(`tx-${prefix}-1`);

  // First pass: the ledger refuses. The order stays paid-but-not-delivered, and the failure
  // is retained on the row — the reason word and the next pass's schedule.
  const interrupted = buildService({
    grantor: grantor({ failFirstGrant: true }),
    period: { start: PERIOD_START, end: PERIOD_END },
  });
  await interrupted.sweepActivations();
  const stuck = await paymentStore.readOrder(orderId);
  expect(stuck?.status).toBe("paid");
  expect(stuck?.activationState).not.toBe("applied");
  expect(stuck?.activationFailureReason).toBe("grant_write_failed");
  expect(stuck?.activationNextRetryAt).not.toBeNull();

  // What the user reads meanwhile: money landed, the entitlement is still processing.
  const view = await interrupted.readOrder(orderId, { actorPayerRef: payer });
  expect(view.order?.fulfillmentState).toBe("processing");

  // The paid fact is already durable — the recovery never re-confirms money.
  const facts = await database
    .select()
    .from(paymentEvents)
    .where(eq(paymentEvents.orderId, orderId));
  expect(facts.filter((row) => row.kind === "fact")).toHaveLength(1);

  // Second pass: only the missing half is patched. Exactly one grant row exists afterwards,
  // in the order owner's account, expiring with the provider's period — never indefinite.
  const recovering = buildService({
    grantor: grantor(),
    period: { start: PERIOD_START, end: PERIOD_END },
  });
  await recovering.sweepActivations();
  const settled = await paymentStore.readOrder(orderId);
  expect(settled?.activationState).toBe("applied");
  expect(settled?.activationFailureReason).toBeNull();
  expect(settled?.activationNextRetryAt).toBeNull();

  const grants = await database
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, `plan:${orderId}`));
  expect(grants).toHaveLength(1);
  expect(grants[0]?.externalCustomerId).toBe(ownerKey);
  expect(grants[0]?.total).toBe(PLAN_CREDITS_SCALED);
  expect(grants[0]?.source).toBe("plan");
  expect(grants[0]?.expiresAt.getTime()).toBe(PERIOD_END.getTime());

  // The subscription projection carries the order's owner and the paid period (10.3): the
  // delivery's other half, stamped durably.
  const [subscription] = await database
    .select()
    .from(billingSubscriptions)
    .where(
      eq(billingSubscriptions.externalSubscriptionId, `${deploymentKey}-pro`),
    );
  expect(subscription?.ownerPayerKind).toBe("personal");
  expect(subscription?.ownerPayerId).toBe(prefix);
  expect(subscription?.allowancePeriodStart?.getTime()).toBe(
    PERIOD_START.getTime(),
  );
  expect(subscription?.allowancePeriodEnd?.getTime()).toBe(
    PERIOD_END.getTime(),
  );

  // A third pass and a replayed settle change nothing: one grant, one paid fact, delivered.
  await recovering.sweepActivations();
  const after = await database
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, `plan:${orderId}`));
  expect(after).toHaveLength(1);
  const finalView = await recovering.readOrder(orderId, {
    actorPayerRef: payer,
  });
  expect(finalView.order?.fulfillmentState).toBe("delivered");
});

test("AC2: a second paid order overlapping the owned entitlement lands in needs_resolution, with evidence and no retry", async () => {
  // A LATER billing period than AC1's order (sequential repurchases are legitimate), with the
  // challenger starting one day into it: the two overlap each other, and only each other.
  const later = {
    start: new Date(PERIOD_START.getTime() + 2 * MONTH),
    end: new Date(PERIOD_END.getTime() + 2 * MONTH),
  };
  const ownerOrderId = await paidOrder(`tx-${prefix}-owner`, later);
  const challengerOrderId = await paidOrder(`tx-${prefix}-challenger`, {
    start: new Date(later.start.getTime() + 24 * 3600_000),
    end: later.end,
  });

  const service = buildService({
    grantor: grantor({ periodEnd: later.end }),
    period: later,
  });
  await service.sweepActivations();
  await service.sweepActivations();

  const owner = await paymentStore.readOrder(ownerOrderId);
  expect(owner?.activationState).toBe("applied");

  const challenger = await paymentStore.readOrder(challengerOrderId);
  expect(challenger?.status).toBe("paid");
  expect(challenger?.activationState).toBe("needs_resolution");
  expect(challenger?.activationFailureReason).toBe("duplicate_paid");
  expect(challenger?.activationNextRetryAt).toBeNull();
  // The conflict's money facts stay: the challenger's paid fact was never undone.
  const challengerFacts = await database
    .select()
    .from(paymentEvents)
    .where(eq(paymentEvents.orderId, challengerOrderId));
  expect(challengerFacts.filter((row) => row.kind === "fact")).toHaveLength(1);
  // And no allowance was minted for a period another order owns.
  const challengerGrants = await database
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, `plan:${challengerOrderId}`));
  expect(challengerGrants).toHaveLength(0);
  // The user-facing state says unresolved, not processing and never delivered.
  const view = await service.readOrder(challengerOrderId, {
    actorPayerRef: payer,
  });
  expect(view.order?.fulfillmentState).toBe("needs_resolution");

  // The sweep's retry list no longer holds it (the store's list is the contract).
  const listed = await paymentStore.listPaidPendingActivationOrders(100);
  expect(listed.some((row) => row.id === challengerOrderId)).toBe(false);
});

test("AC2/对账: the reconciler's evidence covers both halves and the conflict", async () => {
  const reconciler = createReconciler(database, deploymentKey, (planCode) =>
    planCode === "pro" ? PLAN_CREDITS_SCALED : null,
  );
  const report = await reconciler.reconcile();
  // Only this run's rows are this test's subject; other runs' leftovers clean up after
  // themselves the same way this one does.
  const mine = report.findings.filter((finding) =>
    `${finding.subject} ${finding.detail}`.includes(prefix),
  );
  // Both halves of every applied order are present (no plan_grant_missing, no
  // applied_without_subscription, no activation_backlog for THIS run's orders) — the
  // delivered verdict stands on durable evidence, not on a function's return.
  const halfFindings = mine.filter((finding) =>
    [
      "plan_grant_missing",
      "plan_grant_owner_mismatch",
      "plan_grant_amount_mismatch",
      "applied_without_subscription",
      "activation_backlog",
    ].includes(finding.code),
  );
  expect(halfFindings).toHaveLength(0);
  // The deterministic conflict is the one finding this scenario is expected to leave: the
  // duplicate paid order, named, for the operator's queue.
  const duplicates = mine.filter(
    (finding) => finding.code === "duplicate_paid_order",
  );
  expect(duplicates).toHaveLength(1);
});
