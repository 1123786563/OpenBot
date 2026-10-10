import { IconCircleCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { money } from "@/lib/billing/format";
import type { PurchasePlanEntry } from "@/lib/billing/payments";
import { cn } from "@/lib/utils";

/** One plan as a card: its code, its price, and whether it is the one being bought. */
export function PriceCard({
  entry,
  selected,
  onSelect,
  disabled,
}: {
  entry: PurchasePlanEntry;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "relative rounded-xl border bg-card p-4 text-left transition-colors",
        selected ? "border-primary ring-primary/30 ring-2" : "hover:border-foreground/20",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      <span className="font-mono text-sm">{entry.planCode}</span>
      <span className="mt-2 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums">
          {money(entry.amountCents, entry.currency)}
        </span>
        <span className="text-muted-foreground text-sm">
          /{t("subscribe.perMonthShort")}
        </span>
      </span>
      {selected ? (
        <IconCircleCheck className="text-primary absolute top-3 right-3 size-5" />
      ) : null}
    </button>
  );
}
