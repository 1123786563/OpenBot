import { cn } from "@/lib/utils";

/**
 * The credit bar every credit read draws: how much of a grant has been spent.
 *
 * Deliberately smaller than the quota bar next door — a grant row is a compact line, not a
 * summary card, so it needs a bar and nothing else. The teal fill is the design's own accent;
 * there is no "nearly out" threshold to warn about here because a credit grant's whole story is
 * told by its balance and its expiry, not by a percentage crossing a line.
 */
export function CreditBar({
  total,
  used,
  className,
}: {
  total: number;
  used: number;
  className?: string;
}) {
  const ratio = total <= 0 ? 0 : Math.min(Math.max(used / total, 0), 1);
  return (
    <div
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
      role="progressbar"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-success transition-[width] duration-300 ease-out"
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}
