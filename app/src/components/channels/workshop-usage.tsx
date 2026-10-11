import { useTranslation } from "react-i18next";
import type { WorkshopSnapshot, WorkshopTurn } from "@/lib/workshop/client";

/**
 * The usage card: what this workshop has cost, from the snapshot the tab already holds.
 *
 * The server's aggregate computes the totals (B6); this card renders them and the turn
 * counts. The arithmetic here is deliberately defensive — a turn without usage is a turn
 * that streamed and was never billed, not a zero to silently average over — and the empty
 * state is a sentence, never a NaN or a blank.
 */
export function WorkshopUsageView({
  snapshot,
}: {
  snapshot: WorkshopSnapshot;
}) {
  const { t } = useTranslation("workshop");
  const turns = snapshot.turns;
  const totals = snapshot.usage.total;

  const finished = turns.filter(
    (turn: WorkshopTurn) => turn.status === "succeeded",
  ).length;
  const failed = turns.filter((turn: WorkshopTurn) =>
    ["failed", "cancelled"].includes(turn.status),
  ).length;

  const empty =
    turns.length === 0 && totals.inputTokens === 0 && totals.outputTokens === 0;

  if (empty) {
    return (
      <p className="p-4 text-sm text-muted-foreground">{t("usage.empty")}</p>
    );
  }

  return (
    <div className="space-y-3 p-4">
      <dl className="grid grid-cols-2 gap-2">
        <Stat
          label={t("usage.inputTokens")}
          value={formatTokens(totals.inputTokens)}
        />
        <Stat
          label={t("usage.outputTokens")}
          value={formatTokens(totals.outputTokens)}
        />
        <Stat label={t("usage.turns")} value={String(turns.length)} />
        <Stat label={t("usage.succeeded")} value={String(finished)} />
        <Stat label={t("usage.failed")} value={String(failed)} />
        <Stat label={t("usage.cost")} value={formatCost(totals.cost)} />
      </dl>
      <p className="text-xs text-muted-foreground">{t("usage.note")}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** Thousands separators; "0" for zero, never NaN from a null that slipped through. */
function formatTokens(tokens: number | undefined | null): string {
  const value =
    typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0;
  return value.toLocaleString();
}

/** Cost is optional (a deployment without pricing sends none); absent renders a dash. */
function formatCost(cost: number | undefined | null): string {
  if (typeof cost !== "number" || !Number.isFinite(cost)) return "—";
  return cost.toFixed(2);
}
