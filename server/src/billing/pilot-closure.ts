import { createCreditPackReconciliation } from "./credit-pack-checkout";
import type { CreditPackTestChannel } from "./credit-pack-test-channel";
import type { PaidCreditLedger } from "./paid-ledger";
import type { TestCreditLedger } from "./test-credit";

export type PilotClosureLedgers = {
  credit: Pick<TestCreditLedger, "releaseClosedReservations">;
  paid: Pick<
    PaidCreditLedger,
    | "pendingOrders"
    | "closureCutoff"
    | "closePilotOrders"
    | "refunds"
    | "advanceClosureOrder"
    | "verifyOrder"
    | "closeTestPackOrder"
    | "testPackRefundDispatch"
    | "applyTestPackRefundResult"
  >;
};

export async function reconcilePilotClosure(
  accountId: string,
  ledgers: PilotClosureLedgers,
  channels: CreditPackTestChannel[],
) {
  const cutoff = await ledgers.paid.closureCutoff(accountId);
  if (!cutoff) return;
  await ledgers.credit.releaseClosedReservations(accountId);
  const errors: { orderId: string; error: string }[] = [];
  for (const order of await ledgers.paid.pendingOrders(accountId)) {
    if (order.flexpriceCheckout) continue;
    const channel = channels.find(
      (candidate) =>
        candidate.kind === order.channel &&
        candidate.fixture === (order.testMerchant !== null) &&
        (!candidate.fixture || candidate.merchant === order.testMerchant),
    );
    if (!channel) {
      errors.push({
        orderId: order.id,
        error: "No original channel configured.",
      });
      continue;
    }
    try {
      await createCreditPackReconciliation(
        ledgers.paid,
        channel,
      ).reconcileOrder(order.id, true);
    } catch {
      errors.push({
        orderId: order.id,
        error: "Payment reconciliation unavailable.",
      });
    }
  }
  await ledgers.paid.closePilotOrders(accountId);
  for (const refund of await ledgers.paid.refunds(accountId)) {
    if (refund.state !== "requested" && refund.state !== "processing") continue;
    const channel = channels.find(({ kind }) => kind === refund.channel);
    try {
      if (
        channel &&
        (await createCreditPackReconciliation(
          ledgers.paid,
          channel,
        ).refreshRefund(refund.orderId, true))
      )
        continue;
      errors.push({
        orderId: refund.orderId,
        error: "No original channel configured.",
      });
    } catch {
      errors.push({
        orderId: refund.orderId,
        error: "Refund reconciliation unavailable.",
      });
    }
  }
  return {
    cutoff,
    pendingOrders: (await ledgers.paid.pendingOrders(accountId)).map(
      ({ id }) => id,
    ),
    refunds: (await ledgers.paid.refunds(accountId)).map(
      ({
        id,
        orderId,
        channel,
        state,
        reason,
        amountCents,
        usedMicrocredits,
        manualReviewCents,
      }) => ({
        id,
        orderId,
        channel,
        state,
        reason,
        amountCents,
        usedMicrocredits,
        manualReviewCents,
      }),
    ),
    errors,
  };
}
