import {
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconLoader2,
  IconMinus,
  IconPlayerPause,
  IconPlayerStop,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { useState } from "react";
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
  observationRunsQueryOptions,
  type RunState,
  type RunSummary,
} from "@/lib/ai-observability/runs";
import { useDateTime } from "@/lib/i18n/datetime";
import type { SafeValue } from "../../../../shared/ai-observability";

/*
 * The creator's run list (Issue #18). Every fact it shows comes from the wire contract in
 * shared/ai-observability-runs.ts; every fact the wire could not answer is named as
 * unavailable rather than guessed, and the five screen conditions — empty, disabled,
 * forbidden, syncing, upstream-unavailable — each keep their own T02 sentence.
 *
 * The verified port supports no upstream filter today (the route answers 422 rather than
 * silently ignoring one), so both filters are client-side over the loaded page and say so
 * on screen. When the port gains a verified filter operation, the same named params go
 * server-side and this note is the seam to delete.
 */

/** One screenful; the window the server is willing to serve is 100, this asks for less. */
const PAGE_LIMIT = 20;

/** The state's own icon, shared with the detail page — one vocabulary, two pages. */
export const STATE_ICONS: Record<
  RunState,
  React.ComponentType<{ className?: string }>
> = {
  completed: IconCircleCheck,
  failed: IconCircleX,
  running: IconLoader2,
  canceled: IconPlayerStop,
  interrupted: IconPlayerPause,
  unknown: IconMinus,
};

const STATE_FILTERS: readonly RunState[] = [
  "completed",
  "failed",
  "running",
  "canceled",
  "interrupted",
  "unknown",
];

/** Each time filter's label and cutoff; "all" keeps everything. */
const TIME_FILTERS = [
  { id: "all", labelKey: "filter.timeAll", ms: Number.POSITIVE_INFINITY },
  { id: "hour", labelKey: "filter.timeHour", ms: 3_600_000 },
  { id: "day", labelKey: "filter.timeDay", ms: 86_400_000 },
  { id: "week", labelKey: "filter.timeWeek", ms: 604_800_000 },
] as const;

type TimeFilterId = (typeof TIME_FILTERS)[number]["id"];

/** Duration as display text; the detail page renders the same words for the same number. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} m ${Math.round(seconds % 60)} s`;
}

/** A metadata leaf as display text, when it was projected as a string. */
function projectedText(value: SafeValue | undefined): string | null {
  if (value?.state !== "projected" || typeof value.value !== "string")
    return null;
  return value.value;
}

export function ObservationRunsList({ botId }: { botId: string }) {
  const { t } = useTranslation("ai-observability-runs");
  const { formatNumber } = useDateTime();

  // The cursor stack is the page history: forward pushes, back pops, and page one is null.
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1];
  const [stateFilter, setStateFilter] = useState<RunState | "all">("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilterId>("all");

  const screen = useQuery(
    observationRunsQueryOptions(botId, { cursor, limit: PAGE_LIMIT }),
  );

  if (screen.isPending) return null;

  // A transport-level error is the store failing to answer — the unavailable sentence.
  const fault = screen.error
    ? "unavailable"
    : screen.data.view === "fault"
      ? screen.data.fault
      : null;
  if (fault !== null) {
    /*
     * A fault while paginating is most often a cursor the server rotated out from under
     * the person (a restart or an ownership epoch bump — T06's deliberate failure), so
     * the way back to page one is offered rather than hidden behind the refusal.
     */
    return (
      <div className="mt-6">
        <StateNotice
          description={t(`availability.${fault}.description`)}
          title={t(`availability.${fault}.title`)}
        />
        {cursors.length > 1 ? (
          <Button
            className="mt-2"
            onClick={() => setCursors([null])}
            size="sm"
            variant="outline"
          >
            {t("pagination.reset")}
          </Button>
        ) : null}
      </div>
    );
  }

  const answer = screen.data;
  if (answer === undefined || answer.view !== "list") return null;
  const { result } = answer;
  const cutoff =
    TIME_FILTERS.find((filter) => filter.id === timeFilter)?.ms ??
    Number.POSITIVE_INFINITY;
  const rows = result.runs.filter((run) => {
    if (stateFilter !== "all" && run.state !== stateFilter) return false;
    if (Number.isFinite(cutoff)) {
      /*
       * An undated row is neither inside nor outside the range — hiding it would turn
       * "unknown" into "not shown", which is exactly the conflation the Spec forbids.
       */
      if (
        run.createdAt !== "unavailable" &&
        Date.now() - Date.parse(run.createdAt) > cutoff
      ) {
        return false;
      }
    }
    return true;
  });
  const pagination = result.pagination;

  return (
    <>
      {result.syncing ? (
        <StateNotice
          className="mt-6"
          description={t("availability.syncing.description")}
          title={t("availability.syncing.title")}
        />
      ) : null}

      <div className="mt-4 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <FilterChip
            active={stateFilter === "all"}
            label={t("filter.stateAll")}
            onChoose={() => setStateFilter("all")}
          />
          {STATE_FILTERS.map((state) => (
            <FilterChip
              key={state}
              active={stateFilter === state}
              label={t(`states.${state}`)}
              onChoose={() => setStateFilter(state)}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {TIME_FILTERS.map((filter) => (
            <FilterChip
              key={filter.id}
              active={timeFilter === filter.id}
              label={t(filter.labelKey)}
              onChoose={() => setTimeFilter(filter.id)}
            />
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          {t("filter.loadedPageOnly")}
        </p>
      </div>

      {result.runs.length === 0 ? (
        <StateNotice
          className="mt-6"
          description={t("availability.empty.description")}
          title={t("availability.empty.title")}
        />
      ) : rows.length === 0 ? (
        <p className="mt-6 text-muted-foreground text-sm" role="status">
          {t("filter.noMatch")}
        </p>
      ) : (
        <PageRows>
          {rows.map((run, index) => (
            <RunRow
              botId={botId}
              key={run.opikTraceId}
              run={run}
              showSeparator={index > 0}
            />
          ))}
        </PageRows>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        {result.runs.length > 0 ? (
          <p aria-live="polite" className="text-muted-foreground text-xs">
            {t("pagination.range", {
              from: pagination.offset + 1,
              to: pagination.offset + result.runs.length,
              total: formatNumber(pagination.total),
            })}
          </p>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button
            disabled={cursors.length <= 1 || screen.isFetching}
            onClick={() => setCursors(cursors.slice(0, -1))}
            size="sm"
            variant="outline"
          >
            {t("pagination.previous")}
          </Button>
          <Button
            disabled={pagination.nextCursor === null || screen.isFetching}
            onClick={() =>
              pagination.nextCursor !== null &&
              setCursors([...cursors, pagination.nextCursor])
            }
            size="sm"
            variant="outline"
          >
            {t("pagination.next")}
          </Button>
        </div>
      </div>
    </>
  );
}

function FilterChip({
  active,
  label,
  onChoose,
}: {
  active: boolean;
  label: string;
  onChoose: () => void;
}) {
  return (
    <Button
      aria-pressed={active}
      onClick={onChoose}
      size="sm"
      type="button"
      /* The fill is the state, as on every other set of switches in the app. */
      variant={active ? "default" : "outline"}
    >
      {label}
    </Button>
  );
}

/** One availability sentence: a title and the description that qualifies it. */
export function StateNotice({
  className,
  description,
  title,
}: {
  className?: string;
  description: string;
  title: string;
}) {
  return (
    <div className={className} role="status">
      <p className="font-medium text-sm">{title}</p>
      <p className="mt-1 max-w-prose text-muted-foreground text-sm">
        {description}
      </p>
    </div>
  );
}

function RunRow({
  botId,
  run,
  showSeparator,
}: {
  botId: string;
  run: RunSummary;
  showSeparator: boolean;
}) {
  const { t } = useTranslation("ai-observability-runs");
  const { formatTime } = useDateTime();
  const StateIcon = STATE_ICONS[run.state];
  /*
   * The detail route is keyed by the local run id, which only the binding-backed
   * metadata carries; a row without one is read-only and draws no chevron, because a
   * chevron on a row that goes nowhere is a promise the row cannot keep.
   */
  const runId = projectedText(run.metadata.run_id);
  const model = projectedText(run.metadata.model);
  // Withheld and cut values are visible facts, not silent absences (Spec §9).
  const metadataStates = new Set(
    Object.values(run.metadata).map((value) => value.state),
  );
  const markers = (["omitted", "truncated"] as const).filter((marker) =>
    metadataStates.has(marker),
  );

  return (
    <>
      {showSeparator ? <Separator /> : null}
      <Item
        render={
          runId !== null ? (
            <Link
              params={{ agentId: botId, bindingId: runId }}
              to="/bots/$agentId/runs/$bindingId"
            />
          ) : undefined
        }
        size="sm"
      >
        <ItemMedia variant="icon">
          <StateIcon className="size-4 text-muted-foreground" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{t(`states.${run.state}`)}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {[
              run.createdAt === "unavailable"
                ? t("row.timeUnavailable")
                : formatTime(run.createdAt, {
                    hour: "numeric",
                    minute: "2-digit",
                  }),
              run.durationMs === "unavailable"
                ? t("row.durationUnavailable")
                : formatDuration(run.durationMs),
              ...(model !== null ? [model] : []),
              ...markers.map((marker) => t(`marker.${marker}`)),
            ].join(" · ")}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <span
            className="text-muted-foreground text-xs"
            title={
              run.usage.source === "unavailable"
                ? t("availability.tokenUnavailable.description")
                : undefined
            }
          >
            {run.usage.source === "unavailable"
              ? t("row.tokensUnavailable")
              : t("row.tokens", { count: run.usage.totalTokens })}
          </span>
          <span className="text-muted-foreground text-xs">
            {t(`capability.${run.capability}`)}
          </span>
          {runId !== null ? (
            <IconChevronRight className="size-4 text-muted-foreground" />
          ) : null}
        </ItemActions>
      </Item>
    </>
  );
}

/**
 * The run-list page body: the Bot frame plus the list. Lives here rather than in the
 * route file so tests mount it without the authenticated runtime the layout drags in.
 */
export function ObservationRunsPage({ agentId }: { agentId: string }) {
  const { t } = useTranslation("ai-observability-runs");
  return (
    <BotSubpage
      agentId={agentId}
      description={t("page.description")}
      title={t("page.title")}
    >
      {(agent) => <ObservationRunsList botId={agent.id} />}
    </BotSubpage>
  );
}
