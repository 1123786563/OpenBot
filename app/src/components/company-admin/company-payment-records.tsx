import { useTranslation } from "react-i18next";
import { InvoiceStatusPill } from "@/components/billing/invoice-status";
import {
  SectionPage,
  SectionTable,
} from "@/components/company-admin/company-admin-area";
import { money } from "@/lib/billing/format";
import {
  activationFailureCopyKey,
  anomalyLines,
  FULFILLMENT_COPY_KEYS,
} from "@/lib/billing/fulfillment";
import type { BillingInvoice } from "@/lib/billing/invoices";
import { useDateTime } from "@/lib/i18n/datetime";

/*
 * The company's payment records (BP07/#375): the finance reader's table of the company
 * account's own orders, lifted out of the tenant billing route the same way the personal
 * billing views were lifted out of theirs — so the whole surface renders and is tested
 * without a router under it.
 *
 * ONE RECORD VOCABULARY: the rows are `BillingInvoice`s — the same shape the personal orders
 * page renders, through the same vocabulary modules (FULFILLMENT_COPY_KEYS, anomalyLines,
 * InvoiceStatusPill) — so a finance reader and an account holder can never be told two
 * different stories about the same order. The money is each order's own snapshotted currency
 * (never a Lago estimate dressed as 实付), the payer label is the scope's own word (公司), and
 * the delivery/anomaly columns answer the same independent-states sentences the spec spells:
 * 「已付款，权益处理中」 while an order converges, a named state for the operator's queue.
 */

export function CompanyPaymentRecords({
  payments,
}: {
  payments: readonly BillingInvoice[];
}) {
  const { t } = useTranslation("company-admin");
  if (payments.length === 0) {
    return (
      <SectionPage
        description={t("billing.payments.description")}
        title={t("billing.payments.title")}
      >
        <p className="text-muted-foreground mt-3 rounded-lg border border-dashed bg-card/50 px-4 py-10 text-center text-sm">
          {t("billing.payments.empty")}
        </p>
      </SectionPage>
    );
  }
  return (
    <SectionPage
      description={t("billing.payments.description")}
      title={t("billing.payments.title")}
    >
      <SectionTable
        head={[
          t("billing.payments.column.plan"),
          t("billing.payments.column.amount"),
          t("billing.payments.column.payer"),
          t("billing.payments.column.status"),
          t("billing.payments.column.fulfillment"),
          t("billing.payments.column.paidAt"),
        ]}
        label={t("billing.payments.title")}
      >
        {payments.map((record) => (
          <CompanyPaymentRow key={record.invoiceId} record={record} />
        ))}
      </SectionTable>
    </SectionPage>
  );
}

/**
 * One company payment record: the plan it bought, the money in its OWN snapshotted currency,
 * the payer label (the scope's own word — these rows are the company's by construction), the
 * money state, the delivery progress with its retained reason, and the anomaly lines with
 * their counts — every word through the closed vocabulary maps, never a raw code.
 */
function CompanyPaymentRow({ record }: { record: BillingInvoice }) {
  const { t } = useTranslation("company-admin");
  const { t: settings } = useTranslation("settings");
  const { formatDateTime } = useDateTime();
  const anomalies = anomalyLines(record.anomalies);
  return (
    <tr className="border-border border-t">
      <td className="px-4 py-2 whitespace-nowrap">
        {record.planCode}
        <span className="text-muted-foreground block font-mono text-xs">
          {record.invoiceId}
        </span>
      </td>
      <td className="px-4 py-2 whitespace-nowrap tabular-nums">
        {money(record.amountCents, record.currency)}
      </td>
      <td className="px-4 py-2 text-xs">
        {t(`billing.payments.payer.${record.payerKind}`)}
      </td>
      <td className="px-4 py-2">
        <InvoiceStatusPill status={record.status} />
      </td>
      <td className="px-4 py-2">
        {record.fulfillment ? (
          <div
            data-testid={`company-fulfillment-${record.invoiceId}`}
            className="flex flex-col items-start gap-0.5"
          >
            <span
              className={
                record.fulfillment.state === "delivered"
                  ? "text-success text-xs font-medium"
                  : "text-xs font-medium"
              }
            >
              {settings(FULFILLMENT_COPY_KEYS[record.fulfillment.state])}
            </span>
            {record.fulfillment.state !== "delivered" &&
            record.fulfillment.failureReason ? (
              <span className="text-muted-foreground text-xs">
                {settings(
                  activationFailureCopyKey(record.fulfillment.failureReason),
                )}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">–</span>
        )}
        {anomalies.length > 0 ? (
          <ul
            data-testid={`company-anomalies-${record.invoiceId}`}
            className="mt-1 list-inside list-disc"
          >
            {anomalies.map((line) => (
              <li
                key={line.code}
                className="text-muted-foreground text-xs"
                data-testid={`company-anomaly-${record.invoiceId}-${line.code}`}
              >
                {settings(line.copyKey)}
                {line.count > 1 ? ` ×${line.count}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </td>
      <td className="text-muted-foreground px-4 py-2 whitespace-nowrap text-xs tabular-nums">
        {record.settledAt ? formatDateTime(record.settledAt) : "—"}
      </td>
    </tr>
  );
}

/** The account-level capability status, for the finance reader's authorized eyes (BP07/#375). */
export function CompanyAccountStatus({
  account,
}: {
  account: {
    externalCustomerId: string;
    status: "active" | "quarantined";
    quarantineReason: string | null;
  } | null;
}) {
  const { t } = useTranslation("company-admin");
  if (account?.status !== "quarantined") return null;
  return (
    <p
      data-testid="company-account-quarantined"
      className="text-destructive mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
    >
      {t("billing.account.quarantined", {
        reason: account.quarantineReason ?? "",
      })}
    </p>
  );
}
