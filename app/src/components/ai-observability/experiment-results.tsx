import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StateNotice } from "@/components/ai-observability/runs-list";
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
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  type ExperimentResultsSample,
  type ExperimentSampleClass,
  judgeFacts,
  observationCancelExecutionMutationOptions,
  observationExperimentResultsQueryOptions,
} from "@/lib/ai-observability/experiments";
import { useDateTime } from "@/lib/i18n/datetime";
import { queryClient } from "@/query-client";

/*
 * The creator's experiment results (Issue #36): the per-sample answer of one execution.
 * Every fact comes from the T28 report contract in shared/ai-observability-experiments.ts;
 * every fact that contract could not answer keeps its own sentence, never a guess.
 *
 * The result link is shown verbatim and clickable — the server-minted, unfakeable trace
 * back to the safe execution record (T28's AC4 discipline): the report's own execution
 * projection renders beside it, so a reader can verify the run the numbers came from
 * without leaving the page. The cancel write settles a not-yet-terminal execution and
 * lets the invalidated read redraw the honest state.
 */

/** The summary ledger's classes, in display order, keyed onto their count fields. */
const SUMMARY_CLASSES: readonly (readonly [
  classField: ExperimentSampleClass,
  countField:
    | "scored"
    | "inProgress"
    | "executionFailed"
    | "scoringFailed"
    | "cancelled"
    | "pendingReconciliation"
    | "syncFailure",
])[] = [
  ["scored", "scored"],
  ["in_progress", "inProgress"],
  ["execution_failed", "executionFailed"],
  ["scoring_failed", "scoringFailed"],
  ["cancelled", "cancelled"],
  ["pending_reconciliation", "pendingReconciliation"],
  ["sync_failure", "syncFailure"],
];

export function ObservationExperimentResultsPage({
  agentId,
  experimentId,
  executionId,
}: {
  agentId: string;
  experimentId: string;
  executionId: string;
}) {
  const { t } = useTranslation("ai-observability-evaluations");
  const { formatDateTime } = useDateTime();
  const screen = useQuery(
    observationExperimentResultsQueryOptions(
      agentId,
      experimentId,
      executionId,
    ),
  );
  const cancelExecution = useMutation(
    observationCancelExecutionMutationOptions(queryClient),
  );
  const [cancelRefusal, setCancelRefusal] = useState<string | null | undefined>(
    undefined,
  );

  if (screen.isPending) return null;

  // A transport-level error is the store failing to answer — the unavailable sentence.
  const fault = screen.error
    ? "unavailable"
    : screen.data?.view === "fault"
      ? screen.data.fault
      : null;
  if (fault !== null) {
    return (
      <PageShell
        backButton={{
          label: t("results.back"),
          linkProps: {
            params: { agentId },
            to: "/bots/$agentId/evaluations",
          },
        }}
        description={t("page.description")}
        title={t("results.untitled")}
      >
        <StateNotice
          className="mt-6"
          description={t(`availability.${fault}.description`)}
          title={t(`availability.${fault}.title`)}
        />
      </PageShell>
    );
  }

  const report = screen.data?.view === "results" ? screen.data.report : null;
  if (report === null) return null;

  const cancelable = report.state === "pending" || report.state === "running";
  const { execution, summary } = report;

  return (
    <PageShell
      backButton={{
        label: t("results.back"),
        linkProps: {
          params: { agentId },
          to: "/bots/$agentId/evaluations",
        },
      }}
      description={t("page.description")}
      title={t("results.untitled")}
    >
      <PageSection
        description={t("results.executionDescription")}
        title={t("results.executionTitle")}
      >
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t(`states.${execution.state}`)}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {[
                  execution.errorCode,
                  execution.caseCount === null
                    ? null
                    : t("results.base", { count: execution.caseCount }),
                  t("results.toolRejections", {
                    count: execution.toolRejections,
                  }),
                  report.scorerVersion === null
                    ? t("results.scorerUnavailable")
                    : t("results.scorerVersion", {
                        version: report.scorerVersion,
                      }),
                  execution.startedAt === null
                    ? null
                    : formatDateTime(execution.startedAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                  execution.settledAt === null
                    ? null
                    : formatDateTime(execution.settledAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </ItemDescription>
              <ItemDescription className="line-clamp-none">
                <span className="break-all font-mono text-xs">
                  {execution.experimentConfigHash}
                </span>
                {" · "}
                {/*
                 * The result link is the report's own unfakeable trace back to the safe
                 * execution record — the server minted it from the row this scope just
                 * read, so following it can never cross a scope the report did not.
                 */}
                <a
                  className="break-all font-mono text-xs underline underline-offset-4"
                  href={report.resultLink}
                >
                  {report.resultLink}
                </a>
              </ItemDescription>
            </ItemContent>
            {cancelable ? (
              <ItemActions>
                <Button
                  disabled={cancelExecution.isPending}
                  onClick={() =>
                    cancelExecution.mutate(
                      {
                        botId: agentId,
                        experimentId: report.experimentId,
                        executionId: report.executionId,
                      },
                      {
                        onSuccess: (attempt) => {
                          if (!attempt.ok) setCancelRefusal(attempt.refusal);
                        },
                      },
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {t("results.cancel")}
                </Button>
              </ItemActions>
            ) : null}
          </Item>
        </PageRows>
        {cancelRefusal !== undefined ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {cancelRefusal === null
              ? t("error.unreachable")
              : t(`error.${cancelRefusal}`, {
                  defaultValue: t("error.unreachable"),
                })}
          </p>
        ) : null}
      </PageSection>

      <PageSection
        description={t("results.summaryDescription")}
        title={t("results.summaryTitle")}
      >
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>
                {summary.meanScore === null
                  ? t("results.meanNone")
                  : `${t("results.meanScore")} ${summary.meanScore.toFixed(2)}`}
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                {[
                  t("results.base", { count: summary.sampleBase }),
                  ...SUMMARY_CLASSES.map(
                    ([classField, countField]) =>
                      `${t(`classes.${classField}`)}: ${summary[countField]}`,
                  ),
                ].join(" · ")}
              </ItemDescription>
            </ItemContent>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description={t("results.samplesDescription")}
        title={t("results.samplesTitle")}
      >
        <PageRows>
          {report.samples.map((sample, index) => (
            <SampleRow
              key={sample.index}
              sample={sample}
              showSeparator={index > 0}
            />
          ))}
        </PageRows>
      </PageSection>
    </PageShell>
  );
}

/** One sample's line: class word, score, reason, judge, usage — text only, never code. */
function SampleRow({
  sample,
  showSeparator,
}: {
  sample: ExperimentResultsSample;
  showSeparator: boolean;
}) {
  const { t } = useTranslation("ai-observability-evaluations");
  const reason = sample.reason;
  const reasonText =
    reason.class === "scored"
      ? [
          t("sample.passedRules", { count: reason.passed }),
          t("sample.failedRules", { count: reason.failed }),
          ...reason.rules
            .filter((rule) => rule.status !== "passed")
            .map((rule) =>
              rule.status === "failed"
                ? `${rule.id}: ${rule.reason}`
                : `${rule.id}: ${rule.code}`,
            ),
        ].join(" · ")
      : [
          sample.score === null ? t("sample.scoreUnavailable") : null,
          reason.code,
        ]
          .filter((part) => part !== null)
          .join(" · ");
  // The judge's own fact beside the rule score (T27-rn L-3): what it answered, or
  // its own failure code — never averaged into the sample's score, never a guess.
  const judge = judgeFacts(sample.judge);
  const judgeText =
    judge === null
      ? null
      : judge.kind === "scored"
        ? [
            t("sample.judgeScored", {
              score: judge.score.toFixed(2),
            }),
            judge.rationale,
          ].join(" · ")
        : [t("sample.judgeFailed"), judge.code, judge.message ?? null]
            .filter((part) => part !== null)
            .join(" · ");
  return (
    <>
      {showSeparator ? <Separator /> : null}
      <Item size="sm">
        <ItemContent>
          <ItemTitle>
            {`#${sample.index} ${t(`classes.${sample.class}`)}`}
          </ItemTitle>
          <ItemDescription className="line-clamp-none">
            {/* A missing score is its own fact — unavailable, never a masked zero. */}
            {sample.score === null
              ? reasonText
              : [sample.score.toFixed(2), reasonText].join(" · ")}
          </ItemDescription>
          {judgeText === null ? null : (
            <ItemDescription className="line-clamp-none">
              {judgeText}
            </ItemDescription>
          )}
          {sample.usage === null || sample.usage === undefined ? null : (
            <ItemDescription className="line-clamp-none">
              {`${t("sample.usage")}: ${JSON.stringify(sample.usage)}`}
            </ItemDescription>
          )}
        </ItemContent>
      </Item>
    </>
  );
}
