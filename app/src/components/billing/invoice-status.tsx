import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { InvoiceStatus } from "@/lib/billing/invoices";

/**
 * A bill's money state, as the same pill the subscription hero uses.
 *
 * The colour carries one distinction, not five: paid is the one a reader is looking for, so paid
 * is the one with ink. Everything else is a neutral chip whose label does the work — a cancelled
 * bill in the destructive colour would read as "something went wrong" when the truth is "a person
 * changed their mind", and a pending one would read as an error while it is simply a QR code
 * somebody has not scanned yet.
 */
const TONE: Record<InvoiceStatus, string> = {
  paid: "bg-success/10 text-success",
  pending: "bg-muted text-muted-foreground",
  blocked: "bg-destructive/10 text-destructive",
  canceled: "bg-muted text-muted-foreground",
  expired: "bg-muted text-muted-foreground",
};

export function InvoiceStatusPill({
  status,
  className,
}: {
  status: InvoiceStatus;
  className?: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE[status],
        className,
      )}
    >
      {t(`invoicesPage.status.${status}`)}
    </span>
  );
}

/** The channel that carried the money, in the deployment's configured words only. */
export function InvoiceMethodLabel({ method }: { method: "alipay" | "wechat" }) {
  const { t } = useTranslation("settings");
  return <span>{t(`invoicesPage.method.${method}`)}</span>;
}
