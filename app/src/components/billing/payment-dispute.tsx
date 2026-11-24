import { Text } from "@astryxdesign/core/Text";
import { creditsText, type PaymentDispute } from "@/lib/billing/queries";

const progress: Record<PaymentDispute["progress"], string> = {
  open: "Payment disputed. This order’s credits are frozen.",
  awaiting_settlement:
    "Payment reversed. Remaining credits are blocked while dispatched usage settles.",
  reversed: "Payment reversed. Remaining credits were revoked.",
  manual_reconciliation:
    "Payment reversed. Support is reconciling the cost of settled usage.",
  reconciled: "Payment reversed. Support reconciled the cost of settled usage.",
};

export function PaymentDisputeDetails({
  dispute,
}: {
  dispute: PaymentDispute;
}) {
  return (
    <>
      <Text role="status">{progress[dispute.progress]}</Text>
      <Text type="supporting">
        Dispute {dispute.id} · {creditsText(dispute.usedMicrocredits)} credits
        used
      </Text>
      {dispute.revokedMicrocredits !== null && (
        <Text type="supporting">
          {creditsText(dispute.revokedMicrocredits)} credits revoked
          {dispute.manualReviewCents !== null &&
            ` · CN¥${(dispute.manualReviewCents / 100).toFixed(2)} for settled usage`}
        </Text>
      )}
    </>
  );
}
