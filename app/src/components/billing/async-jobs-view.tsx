import { IconListCheck } from "@tabler/icons-react";
import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  scopedAsyncJobsQueryOptions,
  type AsyncJobStatus,
  type AsyncJobUsage,
} from "@/lib/billing/async-jobs";
import { credits } from "@/lib/billing/format";
import { pendingSettlementReasonCopyKey } from "@/lib/billing/pending-settlement-reasons";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { queryClient } from "@/query-client";

/**
 * The person's async jobs page (Bifrost 17.8, #332): every job of their own with its
 * status in the code table the money lanes hold, the reason a waiting state waits for,
 * and the amounts in the ledger's own numbers.
 *
 * The rows are read-only by the ticket's own shape — a job's money moves on the server's
 * settle and cancel lanes, never from this page — so every row is kind 3 of the layout's
 * row kinds: the state and the amounts in `ItemActions`, no chevron, nothing to click. The
 * attribution each row shows is the job row's own frozen grant/payer (the server reads
 * those columns, never the key's live state), so a key that died after the submit changes
 * nothing the page says — which is what 归属不变 looks like on a screen.
 *
 * The reason sentence rides 08.7's own vocabulary (pending-settlement-reasons): a waiting
 * state's code gets its sentence from the one table that translates, and a code nobody
 * mapped reads as the fallback sentence — never the raw code, never an internal string.
 */

export function AsyncJobsView({ scope }: { scope: ScopedCache }) {
  const { t } = useTranslation("settings");
  const jobs = useQuery(scopedAsyncJobsQueryOptions(queryClient, scope));

  return (
    <PageShell
      title={t("creditsPage.asyncJobs.title")}
      description={t("creditsPage.asyncJobs.description")}
    >
      <PageSection title={t("creditsPage.asyncJobs.section")}>
        {jobs.isPending ? null : jobs.error ? (
          <p className="text-destructive text-sm" role="alert">
            {t("creditsPage.asyncJobs.loadFailed")}
          </p>
        ) : jobs.data.length === 0 ? (
          <PageEmpty>{t("creditsPage.asyncJobs.empty")}</PageEmpty>
        ) : (
          <PageRows>
            {jobs.data.map((job, index) => (
              <Fragment key={job.jobId}>
                {index > 0 ? <Separator /> : null}
                <AsyncJobRow job={job} />
              </Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}

/*
 * The status words as literal i18n keys — the typed `t` accepts the answer and the
 * typecheck holds the locale tables to every key (a sentence missing from a locale fails
 * the build, not the reader), the same discipline the pending-reason vocabulary keeps.
 */
type AsyncJobStatusKey =
  | `creditsPage.asyncJobs.status.${"queued" | "running" | "pendingSettlement" | "settled" | "refused" | "cancelled"}`;

const STATUS_KEYS: Record<AsyncJobStatus, AsyncJobStatusKey> = {
  queued: "creditsPage.asyncJobs.status.queued",
  running: "creditsPage.asyncJobs.status.running",
  "pending-settlement": "creditsPage.asyncJobs.status.pendingSettlement",
  settled: "creditsPage.asyncJobs.status.settled",
  refused: "creditsPage.asyncJobs.status.refused",
  cancelled: "creditsPage.asyncJobs.status.cancelled",
};

function AsyncJobRow({ job }: { job: AsyncJobUsage }) {
  const { t } = useTranslation("settings");
  const reasonKey = pendingSettlementReasonCopyKey(job.statusReason);
  return (
    // data-attribution carries the row's FROZEN owner (the server reads the job row's own
    // columns, never the key's live state): a job submitted under a key that has since
    // expired keeps this answer, which is 归属不变 as the page can show it.
    <Item
      size="sm"
      data-testid="async-job-row"
      data-status={job.status}
      data-attribution={job.attribution.payerId}
    >
      <ItemMedia variant="icon">
        <IconListCheck className="size-5" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{job.model.model}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {job.providerJobId === null
            ? t("creditsPage.asyncJobs.dispatchUnconfirmed")
            : t("creditsPage.asyncJobs.dispatched")}
          {" · "}
          {t("creditsPage.asyncJobs.cap", { amount: credits(job.maximumCents / 100) })}
          {job.settledCents > 0
            ? ` · ${t("creditsPage.asyncJobs.settled", {
                amount: credits(job.settledCents / 100),
              })}`
            : ""}
          {job.pendingCents > 0
            ? ` · ${t("creditsPage.asyncJobs.pending", {
                amount: credits(job.pendingCents / 100),
              })}`
            : ""}
        </ItemDescription>
        {reasonKey !== null ? (
          <ItemFooter>
            <p className="text-muted-foreground text-xs" data-testid="async-job-reason">
              {t(reasonKey)}
            </p>
          </ItemFooter>
        ) : null}
      </ItemContent>
      <ItemActions>
        <span
          className="text-muted-foreground text-sm"
          data-testid="async-job-status"
        >
          {t(STATUS_KEYS[job.status])}
        </span>
      </ItemActions>
    </Item>
  );
}
