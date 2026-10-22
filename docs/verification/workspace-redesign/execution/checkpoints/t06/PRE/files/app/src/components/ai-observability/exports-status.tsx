import {
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconLoader2,
  IconPlayerStop,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  downloadExportArtifact,
  EXPORT_POLL_MS,
  type ExportJobListItem,
  observationExportsQueryOptions,
} from "@/lib/ai-observability/exports";
import { useDateTime } from "@/lib/i18n/datetime";
import { observationScreenFault, StateNotice } from "./state-notice";

/*
 * The creator's export status page (Issue #42): the Bot's export jobs and the file each
 * finished job produced. Every fact comes from the T34 job projection as the list
 * answers it (R2-40: no rows inline — a completed row names the detail endpoint in
 * artifactUrl, and the download fetches the bytes from there); nothing here can start,
 * widen or revive a job — the page is the status surface, and a permission change
 * reaches it on the next poll as the refusal it now is, with no stale row surviving.
 *
 * The export states are their own vocabulary, in the T34 words verbatim: queued and
 * running are in flight, failed names its closed-vocabulary code, and a failed
 * CAPABILITY_MISSING job is the integration-off sentence — a configuration state, not a
 * fault. The download rides along exactly when the state is completed, and it re-asks
 * the store rather than guessing when its own fetch is refused or fails.
 */

/** The state's own icon — one vocabulary, the T34 words. */
const EXPORT_STATE_ICONS: Record<
  ExportJobListItem["state"],
  React.ComponentType<{ className?: string }>
> = {
  queued: IconClock,
  running: IconLoader2,
  completed: IconCircleCheck,
  failed: IconCircleX,
  cancelled: IconPlayerStop,
};

export function ObservationExportsPage({
  agentId,
  pollMs = EXPORT_POLL_MS,
}: {
  agentId: string;
  pollMs?: number;
}) {
  const { t } = useTranslation("ai-observability-admin");
  return (
    <BotSubpage
      agentId={agentId}
      description={t("exports.page.description")}
      title={t("exports.page.title")}
    >
      {(agent) => <ObservationExportsList botId={agent.id} pollMs={pollMs} />}
    </BotSubpage>
  );
}

function ObservationExportsList({
  botId,
  pollMs,
}: {
  botId: string;
  pollMs: number;
}) {
  const { t } = useTranslation("ai-observability-admin");
  const { formatNumber } = useDateTime();
  const screen = useQuery(observationExportsQueryOptions(botId, pollMs));

  if (screen.isPending) return null;

  // A transport-level error is the store failing to answer — the unavailable sentence.
  const fault = observationScreenFault(screen);
  if (fault !== null) {
    return (
      <StateNotice
        className="mt-6"
        description={t(`availability.${fault}.description`)}
        title={t(`availability.${fault}.title`)}
      />
    );
  }
  if (screen.data === undefined || screen.data.view !== "list") return null;
  const { jobs, pagination } = screen.data;

  if (jobs.length === 0) {
    return (
      <StateNotice
        className="mt-6"
        description={t("exports.empty.description")}
        title={t("exports.empty.title")}
      />
    );
  }

  return (
    <>
      <PageRows>
        {jobs.map((job, index) => (
          <ExportJobRow
            job={job}
            key={job.jobId}
            showSeparator={index > 0}
            onDownloadSettled={() => {
              void screen.refetch();
            }}
          />
        ))}
      </PageRows>
      {pagination.nextOffset !== null ? (
        /*
         * The window, stated (OCR round 3, R3-07): the list is the first page of the
         * scope's jobs, so a truncated answer says what it is not showing rather than
         * silently standing in for the whole history. The poll still watches the
         * off-page scope (the lib's walk), so in-flight jobs beyond this window keep
         * the page live even though their rows are not drawn here.
         */
        <p aria-live="polite" className="mt-4 text-muted-foreground text-xs">
          {t("exports.truncated", {
            shown: formatNumber(jobs.length),
            total: formatNumber(pagination.total),
          })}
        </p>
      ) : null}
    </>
  );
}

function ExportJobRow({
  job,
  showSeparator,
  onDownloadSettled,
}: {
  job: ExportJobListItem;
  showSeparator: boolean;
  /* A download that did not land re-asks the list: the refusal (or the store
   * failure) it met on the detail face is the page's next answer too. */
  onDownloadSettled: () => void;
}) {
  const { t } = useTranslation("ai-observability-admin");
  const { formatNumber, formatTime } = useDateTime();
  const StateIcon = EXPORT_STATE_ICONS[job.state];

  return (
    <>
      {showSeparator ? <Separator /> : null}
      <Item size="sm">
        <ItemMedia variant="icon">
          <StateIcon className="size-4 text-muted-foreground" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{t(`exports.states.${job.state}`)}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {[
              formatTime(job.createdAt, { hour: "numeric", minute: "2-digit" }),
              job.settledAt === null
                ? null
                : t("exports.settled", {
                    time: formatTime(job.settledAt, {
                      hour: "numeric",
                      minute: "2-digit",
                    }),
                  }),
              /*
               * rowCount is null until the job completes (the shared contract's own
               * words), so "rows pending" is only honest while the job can still
               * produce them — a failed or cancelled job never will, and calling its
               * rows pending would contradict the terminal state named beside it.
               */
              job.rowCount !== null
                ? t("exports.rowCount", {
                    count: formatNumber(job.rowCount),
                    limit: formatNumber(job.rowLimit),
                  })
                : job.state === "queued" || job.state === "running"
                  ? t("exports.rowsPending")
                  : null,
            ]
              .filter((part) => part !== null)
              .join(" · ")}
          </ItemDescription>
          {job.state === "failed" && job.errorCode !== null ? (
            <ItemDescription className="line-clamp-none">
              {job.errorCode === "CAPABILITY_MISSING"
                ? t("availability.disabled.description")
                : t(`exports.errorCodes.${job.errorCode}`, {
                    defaultValue: job.errorCode,
                  })}
            </ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions>
          {job.state === "completed" ? (
            <Button
              onClick={() => {
                void downloadExportArtifact(job).then((outcome) => {
                  if (outcome !== "downloaded") onDownloadSettled();
                });
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("exports.download")}
            </Button>
          ) : null}
        </ItemActions>
      </Item>
    </>
  );
}
