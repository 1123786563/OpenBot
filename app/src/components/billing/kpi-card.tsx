/**
 * One number a person reads first: the label says what it counts, the value says how much.
 *
 * The usage page leads with three of these — money, tokens, events — because the question a
 * reader arrives with is "how much", and every answer below the row is the derivation.
 */
export function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-muted-foreground text-sm">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
    </div>
  );
}
