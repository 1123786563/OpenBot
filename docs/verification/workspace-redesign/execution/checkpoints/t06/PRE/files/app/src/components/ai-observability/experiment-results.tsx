import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { finite } from "@/components/ai-observability/experiment-comparison";
import {
  observationScreenFault,
  StateNotice,
} from "@/components/ai-observability/state-notice";
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
  isKnownExecutionState,
  isKnownSampleClass,
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
  const fault = observationScreenFault(screen);
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
  /*
   * The render-face finite guard (R5-2, R2-08's discipline extended to every numeric
   * this page interpolates): JSON can carry 1e999 — a typeof-number Infinity the wire
   * guard cannot tell from a real count — and "Infinity" is not a statistic. A
   * non-finite number renders as its field's own absence, never as a value.
   */
  const caseCount =
    execution.caseCount === null ? null : finite(execution.caseCount);
  const toolRejections = finite(execution.toolRejections);
  const meanScore =
    summary.meanScore === null ? null : finite(summary.meanScore);
  const sampleBase = finite(summary.sampleBase);
  const classCounts = SUMMARY_CLASSES.map(
    ([classField, countField]) =>
      [classField, finite(summary[countField])] as const,
  );

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
              <ItemTitle>
                {/*
                 * A state word the vocabulary has never heard of renders verbatim
                 * (OCR round 2, R2-09) — a missing i18n sentence is not a key to
                 * echo. The guard claims the field as a string; the fallback keeps
                 * the render honest for a newer server's word.
                 */}
                {isKnownExecutionState(execution.state)
                  ? t(`states.${execution.state}`)
                  : execution.state}
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                {[
                  execution.errorCode,
                  caseCount === null
                    ? null
                    : t("results.base", { count: caseCount }),
                  toolRejections === null
                    ? null
                    : t("results.toolRejections", { count: toolRejections }),
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
                  onClick={() => {
                    // A retry starts from a clean slate — the previous attempt's
                    // answer described a request that is no longer the one in flight.
                    setCancelRefusal(undefined);
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
                        // A request that never answered at all (the network layer
                        // rejected before any HTTP verdict) is its own sentence.
                        onError: () => setCancelRefusal(null),
                      },
                    );
                  }}
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
                {meanScore === null
                  ? t("results.meanNone")
                  : `${t("results.meanScore")} ${meanScore.toFixed(2)}`}
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                {[
                  sampleBase === null
                    ? null
                    : t("results.base", { count: sampleBase }),
                  ...classCounts.map(([classField, count]) =>
                    count === null
                      ? null
                      : `${t(`classes.${classField}`)}: ${count}`,
                  ),
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
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
  // The score cell is finite-checked like every numeric this page interpolates
  // (R5-2): a 1e999 body renders as the score's absence, never as "Infinity".
  const score = sample.score === null ? null : finite(sample.score);
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
            {/*
             * The class words are the shared seven-class closed set (R3-04, R2-09's
             * standard): a word the bundle cannot name renders itself — the same
             * verbatim fallback the execution state beside it already uses — never
             * `classes.<word>` echoed as a raw key.
             */}
            {`#${sample.index} ${
              isKnownSampleClass(sample.class)
                ? t(`classes.${sample.class}`)
                : sample.class
            }`}
          </ItemTitle>
          <ItemDescription className="line-clamp-none">
            {/* A missing score is its own fact — unavailable, never a masked zero. */}
            {score === null
              ? reasonText
              : [score.toFixed(2), reasonText].join(" · ")}
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
