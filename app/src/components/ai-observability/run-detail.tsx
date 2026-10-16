import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { observationRunDetailQueryOptions } from "@/lib/ai-observability/runs";
import { useDateTime } from "@/lib/i18n/datetime";
import { ObservationRunSteps, projectedValueText } from "./run-steps";
import { formatDuration, STATE_ICONS, StateNotice } from "./runs-list";

/*
 * The creator's run detail (Issue #19). Every fact comes from the T11 detail contract; every
 * fact that contract could not answer is named as unavailable with its reason, never as zero
 * or a guess. The availability section is the page's second half on purpose: coverage verdict,
 * upstream binding status and data freshness are answers about the record's trustworthiness,
 * and a reader who wants only those should not have to re-read the facts to find them.
 *
 * The steps section is T18's step tree: the recorded timeline of model, tool and retrieval
 * spans, gated by the coverage verdict, never a row the record cannot vouch for.
 */

/** One label-and-value row; the optional note is the "why" behind an unavailable value. */
type FactRowSpec = {
  icon?: React.ReactNode;
  label: string;
  note?: string;
  value: React.ReactNode;
};

export function ObservationRunDetail({
  botId,
  runId,
}: {
  botId: string;
  runId: string;
}) {
  const { t } = useTranslation("ai-observability-runs");
  const { formatDateTime } = useDateTime();
  const screen = useQuery(observationRunDetailQueryOptions(botId, runId));

  if (screen.isPending) return null;

  // A transport-level error is the store failing to answer — the unavailable sentence.
  const fault = screen.error
    ? "unavailable"
    : screen.data.view === "fault"
      ? screen.data.fault
      : null;
  if (fault !== null) {
    return (
      <div className="mt-6">
        <StateNotice
          description={t(`availability.${fault}.description`)}
          title={t(`availability.${fault}.title`)}
        />
        {fault === "notFound" ? (
          /*
           * A typed address or a stale link is the usual way here; the list is the page
           * that can answer what runs do exist, so the way back is offered, not hidden.
           */
          <Button
            className="mt-2"
            render={
              <Link params={{ agentId: botId }} to="/bots/$agentId/runs" />
            }
            size="sm"
            variant="outline"
          >
            {t("detail.backToList")}
          </Button>
        ) : null}
      </div>
    );
  }

  const answer = screen.data;
  if (answer === undefined || answer.view !== "detail") return null;
  const { run, upstream } = answer.result;
  const present = upstream.status === "present" ? upstream : null;
  const StateIcon = STATE_ICONS[run.state];

  const overview: readonly FactRowSpec[] = [
    {
      icon: <StateIcon className="size-4 text-muted-foreground" />,
      label: t("detail.facts.state"),
      value: t(`states.${run.state}`),
    },
    {
      label: t("detail.facts.started"),
      value:
        present === null || present.createdAt === "unavailable"
          ? t("row.timeUnavailable")
          : formatDateTime(present.createdAt),
      note:
        present === null
          ? upstream.status === "unreconciled"
            ? t("availability.syncing.title")
            : t("detail.upstream.absentTitle")
          : undefined,
    },
    {
      label: t("detail.facts.duration"),
      value:
        present === null || present.durationMs === "unavailable"
          ? t("row.durationUnavailable")
          : formatDuration(present.durationMs),
    },
    {
      label: t("detail.facts.usage"),
      value:
        present === null || present.usage.source === "unavailable"
          ? t("row.tokensUnavailable")
          : t("row.tokens", { count: present.usage.totalTokens }),
      note:
        present !== null && present.usage.source === "provider"
          ? t("detail.facts.usageDetail", {
              prompt: present.usage.promptTokens,
              completion: present.usage.completionTokens,
            })
          : t("availability.tokenUnavailable.description"),
    },
    {
      label: t("detail.facts.recorded"),
      value: formatDateTime(run.createdAt),
    },
    {
      label: t("detail.facts.expires"),
      value: formatDateTime(run.expiresAt),
    },
  ];

  const availability: readonly FactRowSpec[] = [
    {
      label: t("detail.facts.coverage"),
      value: t(`capability.${run.capability}`),
      note:
        run.capability === "basic"
          ? t("availability.basic.description")
          : undefined,
    },
    {
      label: t("detail.facts.upstreamLink"),
      value:
        upstream.status === "present"
          ? t("detail.upstream.present")
          : upstream.status === "unreconciled"
            ? t("availability.syncing.title")
            : t("detail.upstream.absentTitle"),
      note:
        upstream.status === "unreconciled"
          ? t("availability.syncing.description")
          : upstream.status === "absent"
            ? t("detail.upstream.absentDescription")
            : undefined,
    },
    {
      label: t("detail.facts.updated"),
      value: formatDateTime(run.updatedAt),
    },
  ];

  const references: readonly FactRowSpec[] = [
    { label: t("detail.facts.run"), value: run.runId },
    { label: t("detail.facts.attempt"), value: run.attemptId },
    { label: t("detail.facts.trace"), value: run.traceId },
    {
      label: t("detail.facts.opikTrace"),
      value:
        run.opikTraceId === null
          ? t("detail.facts.notLinked")
          : run.opikTraceId,
    },
  ];

  const metadata: readonly FactRowSpec[] =
    present === null
      ? []
      : Object.entries(present.metadata).map(([key, value]) => ({
          label: key,
          value:
            projectedValueText(value, t("marker.truncated")) ??
            t("marker.omitted"),
        }));

  return (
    <>
      <PageSection title={t("detail.section.overview")}>
        <FactRows rows={overview} />
      </PageSection>

      <PageSection title={t("detail.section.availability")}>
        <FactRows rows={availability} />
      </PageSection>

      <PageSection title={t("detail.section.references")}>
        <FactRows rows={references} />
      </PageSection>

      <PageSection title={t("detail.section.metadata")}>
        {metadata.length === 0 ? (
          <PageEmpty>{t("detail.metadataEmpty")}</PageEmpty>
        ) : (
          <FactRows rows={metadata} />
        )}
      </PageSection>

      {/* T18's step tree: same page, same facts, gated by the coverage verdict above. */}
      <PageSection title={t("detail.section.steps")}>
        <ObservationRunSteps
          botId={botId}
          capability={run.capability}
          runId={runId}
          upstream={upstream.status}
        />
      </PageSection>
    </>
  );
}

/** The card of divided rows every section draws the same way. */
function FactRows({ rows }: { rows: readonly FactRowSpec[] }) {
  return (
    <PageRows>
      {rows.map((row, index) => (
        <Fragment key={row.label}>
          {index > 0 ? <Separator /> : null}
          <Item size="sm">
            {row.icon !== undefined ? (
              <ItemMedia variant="icon">{row.icon}</ItemMedia>
            ) : null}
            <ItemContent>
              <ItemTitle>{row.label}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {row.value}
              </ItemDescription>
              {row.note !== undefined ? (
                <ItemDescription className="line-clamp-none">
                  {row.note}
                </ItemDescription>
              ) : null}
            </ItemContent>
          </Item>
        </Fragment>
      ))}
    </PageRows>
  );
}

/**
 * The run-detail page body: the Bot frame plus the detail. Lives here rather than in the
 * route file so tests mount it without the authenticated runtime the layout drags in.
 */
export function ObservationRunDetailPage({
  agentId,
  bindingId,
}: {
  agentId: string;
  bindingId: string;
}) {
  const { t } = useTranslation("ai-observability-runs");
  return (
    <BotSubpage
      agentId={agentId}
      description={t("detail.description")}
      title={t("detail.title")}
    >
      {(agent) => <ObservationRunDetail botId={agent.id} runId={bindingId} />}
    </BotSubpage>
  );
}
