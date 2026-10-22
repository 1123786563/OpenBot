import { Skeleton } from "@/components/ui/skeleton";

/**
 * The loading shape of a `PageRows` card: rows of the settings-item silhouette, held in the same
 * card the rows will land in (hairline + `shadow-card`, squared rows), so the swap from loading to
 * loaded moves pixels as little as possible.
 *
 * Replaces the `isPending ? null` blanks: a screen that renders nothing while it loads reads as
 * broken for exactly as long as the request takes, and a skeleton of the shape that is coming reads
 * as working.
 */
export function PageRowsSkeleton({
  rows = 4,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      data-slot="page-rows-skeleton"
      className={`mt-4 overflow-hidden rounded-2xl border border-border bg-card shadow-card dark:border-transparent dark:shadow-none ${className ?? ""}`}
    >
      {/* Purely decorative placeholder rows; static keys are fine because the count never reorders. */}
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: Skeleton rows are static decorations; there is no identity to key by.
          key={index}
          className="flex items-center gap-2.5 px-3 py-2.5"
          aria-hidden="true"
        >
          <Skeleton className="size-7 rounded-sm" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The loading shape of a bare table (`overflow-x-auto rounded-lg` recipe): one header line plus
 * body rows, at the heights those rows actually render.
 */
export function TableSkeleton({
  rows = 6,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      data-slot="table-skeleton"
      className={`mt-4 overflow-hidden rounded-lg border border-border bg-card ${className ?? ""}`}
    >
      <div
        className="flex items-center gap-4 border-border border-b px-4 py-2"
        aria-hidden="true"
      >
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: Skeleton rows are static decorations; there is no identity to key by.
          key={index}
          className="flex items-center gap-4 border-border border-t px-4 py-2"
          aria-hidden="true"
        >
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-44" />
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="ml-auto h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}
