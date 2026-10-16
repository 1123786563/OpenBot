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
  EXPORT_POLL_MS,
  type ExportJobView,
  observationExportsQueryOptions,
} from "@/lib/ai-observability/exports";
import { useDateTime } from "@/lib/i18n/datetime";
import { StateNotice } from "./runs-list";

/*
 * The creator's export status page (Issue #42): the Bot's export jobs and the file each
 * finished job produced. Every fact comes from the T34 job projection; nothing here can
 * start, widen or revive a job — the page is the status surface, and a permission change
 * reaches it on the next poll as the refusal it now is, with no stale row surviving.
 *
 * The export states are their own vocabulary, in the T34 words verbatim: queued and
 * running are in flight, failed names its closed-vocabulary code, and a failed
 * CAPABILITY_MISSING job is the integration-off sentence — a configuration state, not a
 * fault. The artifact rides along exactly when the state is completed, and so does the
 * download.
 */

/** The state's own icon — one vocabulary, the T34 words. */
const EXPORT_STATE_ICONS: Record<
  ExportJobView["state"],
  React.ComponentType<{ className?: string }>
> = {
  queued: IconClock,
  running: IconLoader2,
  completed: IconCircleCheck,
  failed: IconCircleX,
  cancelled: IconPlayerStop,
};

/** The one download format: the artifact rows as JSON, byte-for-byte what the route sent. */
function downloadArtifact(job: ExportJobView): void {
  const blob = new Blob([JSON.stringify(job.artifact ?? [], null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `runs-export-${job.jobId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

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
  const screen = useQuery(observationExportsQueryOptions(botId, pollMs));

  if (screen.isPending) return null;

  // A transport-level error is the store failing to answer — the unavailable sentence.
  const fault = screen.error
    ? "unavailable"
    : screen.data?.view === "fault"
      ? screen.data.fault
      : null;
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
  const jobs = screen.data.jobs;

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
    <PageRows>
      {jobs.map((job, index) => (
        <ExportJobRow job={job} key={job.jobId} showSeparator={index > 0} />
      ))}
    </PageRows>
  );
}

function ExportJobRow({
  job,
  showSeparator,
}: {
  job: ExportJobView;
  showSeparator: boolean;
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
              job.rowCount === null
                ? t("exports.rowsPending")
                : t("exports.rowCount", {
                    count: formatNumber(job.rowCount),
                    limit: formatNumber(job.rowLimit),
                  }),
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
              onClick={() => downloadArtifact(job)}
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
