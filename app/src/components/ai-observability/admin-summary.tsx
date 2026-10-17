import { IconActivity } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
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
  ADMIN_TIME_WINDOWS,
  type AdminBotSummary,
  type AdminSummaryResult,
  type AdminTimeWindowId,
  observationAdminSummaryQueryOptions,
} from "@/lib/ai-observability/admin";
import { useDateTime } from "@/lib/i18n/datetime";
import { StateNotice } from "./state-notice";

/*
 * The administrator's observability page (Issue #42): the scope summary, the collection
 * health and the troubleshooting facts, every number from the T33 summary and nothing
 * else — the page fetches one endpoint, so the API's scope answer is the page's scope
 * answer, and a restricted role's smaller answer is the whole page, not a filtered view
 * of something larger.
 *
 * Three answers stay three answers, in the T13 vocabulary verbatim: a collection that
 * cannot answer (unreachable, authentication failure, upstream counts explicitly null) is
 * a fault; begun-but-unreconciled runs are syncing, shown beside the counts that exist;
 * disabled, unconfigured and capability-missing are configuration states, not faults —
 * and in all of them the local counts still answer.
 */

export function ObservationAdminSummaryPage() {
  const { t } = useTranslation("ai-observability-admin");
  const [window, setWindow] = useState<AdminTimeWindowId>("all");

  const screen = useQuery(observationAdminSummaryQueryOptions(window));

  return (
    <PageShell title={t("page.title")} description={t("page.description")}>
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {ADMIN_TIME_WINDOWS.map((preset) => (
            <WindowChip
              key={preset.id}
              active={window === preset.id}
              label={t(preset.labelKey)}
              onChoose={() => setWindow(preset.id)}
            />
          ))}
        </div>
        {/* The T33-rev3 note: enumeration is one Bot at a time by design (authorization
            before aggregation), so a full-range answer can be slow — and never widens. */}
        <p className="text-muted-foreground text-xs">
          {t("summary.scopeNote")}
        </p>
      </div>

      {screen.isPending ? null : screen.error ? (
        <StateNotice
          className="mt-6"
          description={t("availability.unavailable.description")}
          title={t("availability.unavailable.title")}
        />
      ) : screen.data?.view === "fault" ? (
        <StateNotice
          className="mt-6"
          description={t(`availability.${screen.data.fault}.description`)}
          title={t(`availability.${screen.data.fault}.title`)}
        />
      ) : screen.data === undefined ? null : (
        <AdminSummaryBody summary={screen.data.result} />
      )}
    </PageShell>
  );
}

function AdminSummaryBody({ summary }: { summary: AdminSummaryResult }) {
  const { t } = useTranslation("ai-observability-admin");
  const { formatNumber } = useDateTime();
  const { collection, bots } = summary;
  const readiness = collection.readiness;
  const inFlight = bots.some(
    (bot) =>
      bot.runs.pendingSync > 0 ||
      bot.exports.byState.queued + bot.exports.byState.running > 0,
  );

  return (
    <>
      <PageSection title={t("summary.healthTitle")}>
        {readiness.ready || readiness.reason === null ? (
          <StateNotice
            className="mt-4"
            description={t("readiness.ready.description")}
            title={t("readiness.ready.title")}
          />
        ) : (
          <StateNotice
            className="mt-4"
            description={t(`readiness.${readiness.reason}.description`)}
            title={t(`readiness.${readiness.reason}.title`)}
          />
        )}
        <p className="mt-2 max-w-prose text-muted-foreground text-sm">
          {t("summary.dropped", {
            queueFull: formatNumber(collection.dropped.queueFull),
            notReady: formatNumber(collection.dropped.notReady),
          })}
        </p>
        <p className="mt-1 max-w-prose text-muted-foreground text-xs">
          {t("summary.upstreamWindow")}
        </p>
        <p className="mt-1 max-w-prose text-muted-foreground text-xs">
          {t("summary.retention")}
        </p>
      </PageSection>

      <PageSection title={t("summary.botsTitle")}>
        {summary.botsTruncated ? (
          <StateNotice
            className="mt-4"
            description={t("summary.truncatedDescription", {
              // The sentence names the cutoff, so the cutoff is the count it shows.
              count: formatNumber(bots.length),
            })}
            title={t("summary.truncatedTitle")}
          />
        ) : null}
        {inFlight ? (
          <StateNotice
            className="mt-4"
            description={t("availability.syncing.description")}
            title={t("availability.syncing.title")}
          />
        ) : null}
        {bots.length === 0 ? (
          <StateNotice
            className="mt-4"
            description={t("availability.empty.description")}
            title={t("availability.empty.title")}
          />
        ) : (
          <PageRows>
            {bots.map((bot, index) => (
              <AdminBotRow
                bot={bot}
                key={bot.botId}
                showSeparator={index > 0}
              />
            ))}
          </PageRows>
        )}
      </PageSection>
    </>
  );
}

function WindowChip({
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

function AdminBotRow({
  bot,
  showSeparator,
}: {
  bot: AdminBotSummary;
  showSeparator: boolean;
}) {
  const { t } = useTranslation("ai-observability-admin");
  const { formatNumber, formatTime } = useDateTime();
  const exportsInFlight =
    bot.exports.byState.queued + bot.exports.byState.running;

  return (
    <>
      {showSeparator ? <Separator /> : null}
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconActivity className="size-4 text-muted-foreground" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{bot.botId}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {[
              t("summary.row.runs", { count: formatNumber(bot.runs.total) }),
              t("summary.row.failed", {
                count: formatNumber(bot.runs.byState.failed),
              }),
              t("summary.row.pending", {
                count: formatNumber(bot.runs.pendingSync),
              }),
              bot.collection.lastCollectedAt === null
                ? t("summary.row.neverCollected")
                : t("summary.row.lastCollected", {
                    time: formatTime(bot.collection.lastCollectedAt, {
                      hour: "numeric",
                      minute: "2-digit",
                    }),
                  }),
            ].join(" · ")}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <div className="flex flex-wrap justify-end gap-2">
            <span className="text-muted-foreground text-xs">
              {t("summary.row.experiments", {
                draft: formatNumber(bot.experiments.draft),
                frozen: formatNumber(bot.experiments.frozen),
              })}
            </span>
            <span className="text-muted-foreground text-xs">
              {t("summary.row.exports", {
                completed: formatNumber(bot.exports.byState.completed),
                failed: formatNumber(bot.exports.byState.failed),
                inFlight: formatNumber(exportsInFlight),
              })}
              {bot.exports.lastFailedErrorCode !== null
                ? ` · ${t("summary.row.lastFailedCode", {
                    code: bot.exports.lastFailedErrorCode,
                  })}`
                : ""}
            </span>
            {/* Upstream-derived: null means the collection could not answer — a named
                absence, never a zero in disguise (the upstream counts cover the store's
                most recent window, not the requested time window; the note in the health
                section says so). */}
            <span className="text-muted-foreground text-xs">
              {bot.runs.unboundUpstream === null
                ? t("summary.upstreamUnavailable")
                : t("summary.row.unbound", {
                    count: formatNumber(bot.runs.unboundUpstream),
                  })}
            </span>
            <span className="text-muted-foreground text-xs">
              {bot.runs.usage === null
                ? null
                : t("summary.row.usage", {
                    reported: formatNumber(bot.runs.usage.providerReported),
                    unavailable: formatNumber(bot.runs.usage.unavailable),
                  })}
            </span>
            {/* R2-46, made visible (R2fix F-1): when the upstream listing covered
                only the first window of a larger project, the unbound and usage
                counts beside this marker are window-bounded lower bounds — the
                flag false is silence, exact counts need no qualifier. */}
            {bot.runs.upstreamTruncated ? (
              <span className="text-muted-foreground text-xs">
                {t("summary.row.upstreamTruncated")}
              </span>
            ) : null}
          </div>
        </ItemActions>
      </Item>
    </>
  );
}
