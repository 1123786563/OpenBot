import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The pager every list on the billing screens uses: facts on the left, previous/next on the right.
 *
 * Extracted from the usage page's event pager, which was the only copy. The bill list needed the
 * same two buttons and the same "第 2 / 5 页 · 共 87 条", and a second hand-written copy would
 * have drifted on exactly the thing a reader checks — whether the page they are on is the page
 * they are being told about.
 *
 * `disabled` rather than hidden, so the control does not move under the reader's cursor when they
 * reach an end: a pager that reflows makes the next click a guess.
 */
export function BillingPager({
  page,
  totalPages,
  totalCount,
  hasNext,
  onPage,
  statusTemplate,
  className,
}: {
  page: number;
  totalPages: number;
  totalCount: number;
  hasNext: boolean;
  onPage: (page: number) => void;
  /**
   * An already-translated template carrying `{{page}}`, `{{totalPages}}` and `{{total}}`.
   *
   * Filled here rather than at the call site because the clamp is the part worth owning once: a
   * filter that shrank the result under a pager already sitting on page 4 must not read
   * "第 4 / 2 页". The reader is on an empty page, and the honest answer is "第 2 / 2 页".
   */
  statusTemplate: string;
  className?: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 pt-3",
        className,
      )}
    >
      <span className="text-muted-foreground text-xs tabular-nums">
        {statusTemplate
          .replace("{{page}}", String(clampedPage(page, totalPages)))
          .replace("{{totalPages}}", String(Math.max(totalPages, 1)))
          .replace("{{total}}", String(totalCount))}
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          {t("billing.pagerPrev")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasNext}
          onClick={() => onPage(page + 1)}
        >
          {t("billing.pagerNext")}
        </Button>
      </div>
    </div>
  );
}

/** A page past the end reads as the last page, so the status never overstates where the reader is. */
function clampedPage(page: number, totalPages: number): number {
  return Math.min(page, Math.max(totalPages, 1));
}
