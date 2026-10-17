import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  type ExperimentComparisonSide,
  type ObservationExperimentFault,
  observationExperimentComparisonQueryOptions,
} from "@/lib/ai-observability/comparison";
import {
  isKnownCompatibilityField,
  isKnownExecutionState,
  isKnownSampleClass,
  judgeFacts,
} from "@/lib/ai-observability/experiments";
import { useDateTime } from "@/lib/i18n/datetime";
import type {
  ExperimentComparison,
  ExperimentCompatibilityEntry,
  ExperimentExecutionState,
  ExperimentRegressionRow,
  ExperimentSampleClass,
  ExperimentSampleDelta,
} from "../../../../shared/ai-observability-experiments";

/*
 * The creator's experiment comparison page (Issue #37): two experiments' configurations
 * side by side, the per-sample deltas over the shared frozen cases, and the regressions —
 * every fact from the T29 comparison contract in shared/ai-observability-experiments.ts.
 * The page judges nothing the interface did not: compatibility is the ledger's own
 * verdict, an incompatible pair explains its blocking fields and never a winner, and a
 * sample still in flight or awaiting reconciliation reads "not comparable" — its verdict
 * is open, so it masquerades neither as a regression nor as an improvement.
 *
 * The way back to the safe execution records is the experiments chain's adjudicated one,
 * reused across pages: each side renders its execution projection, and every regression
 * row carries both T28 result links verbatim — server-minted from the rows this scope
 * just read, so following one can never cross a scope the comparison did not.
 */

/** The four search parameters a comparison is addressed by — the read's own inputs. */
export type ExperimentComparisonSearch = Readonly<{
  baselineExperimentId?: string;
  baselineExecutionId?: string;
  candidateExperimentId?: string;
  candidateExecutionId?: string;
}>;

/** The one export format: the comparison the server answered, as JSON. */
function downloadComparison(comparison: ExperimentComparison, botId: string) {
  const blob = new Blob([JSON.stringify(comparison, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `experiment-comparison-${botId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ObservationExperimentComparisonPage({
  agentId,
  search,
}: {
  agentId: string;
  search: ExperimentComparisonSearch;
}) {
  const { t } = useTranslation("ai-observability-evaluations");
  const sides = {
    baseline: {
      experimentId: search.baselineExperimentId ?? "",
      executionId: search.baselineExecutionId ?? "",
    },
    candidate: {
      experimentId: search.candidateExperimentId ?? "",
      executionId: search.candidateExecutionId ?? "",
    },
  };
  const addressed = [
    sides.baseline.experimentId,
    sides.baseline.executionId,
    sides.candidate.experimentId,
    sides.candidate.executionId,
  ].every((id) => id.trim() !== "");

  const screen = useQuery({
    ...observationExperimentComparisonQueryOptions(agentId, sides),
    enabled: addressed,
  });

  const shell = (children: ReactNode) => (
    <PageShell
      backButton={{
        label: t("comparison.back"),
        linkProps: {
          params: { agentId },
          to: "/bots/$agentId/evaluations",
        },
      }}
      description={t("page.description")}
      title={t("comparison.untitled")}
    >
      {children}
    </PageShell>
  );

  if (!addressed) return shell(<SelectionSection agentId={agentId} />);
  if (screen.isPending) return null;

  // A transport-level error is the store failing to answer — the unavailable sentence.
  const fault: ObservationExperimentFault | null =
    observationScreenFault(screen);
  if (fault !== null) {
    return shell(
      <StateNotice
        className="mt-6"
        description={t(`availability.${fault}.description`)}
        title={t(`availability.${fault}.title`)}
      />,
    );
  }
  if (screen.data?.view !== "comparison") return null;
  const comparison = screen.data.comparison;

  return shell(
    <>
      <PageSection
        description={t("comparison.sidesDescription")}
        title={t("comparison.sidesTitle")}
      >
        <PageRows>
          <SideRow
            label={t("comparison.baseline")}
            side={comparison.baseline}
          />
          <SideRow
            label={t("comparison.candidate")}
            side={comparison.candidate}
            showSeparator
          />
        </PageRows>
      </PageSection>

      <PageSection
        description={t("comparison.compatibilityDescription")}
        title={t("comparison.compatibilityTitle")}
      >
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>
                {comparison.compatibility.compatible
                  ? t("comparison.compatible")
                  : t("comparison.incompatible")}
              </ItemTitle>
            </ItemContent>
            <ItemActions>
              <Button
                onClick={() => downloadComparison(comparison, agentId)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("comparison.download")}
              </Button>
            </ItemActions>
          </Item>
          {comparison.compatibility.fields.map((entry) => (
            <FieldRow entry={entry} key={entry.field} showSeparator />
          ))}
        </PageRows>
      </PageSection>

      {comparison.deltas === null ? null : (
        <PageSection
          description={t("comparison.deltasDescription")}
          title={t("comparison.deltasTitle")}
        >
          <PageRows>
            <MeanRow deltas={comparison.deltas} />
            {comparison.deltas.perSample.map((delta) => (
              <SampleDeltaRow
                delta={delta}
                key={delta.index}
                showSeparator
                baselineJudge={
                  comparison.baseline.report.samples[delta.index]?.judge
                }
                candidateJudge={
                  comparison.candidate.report.samples[delta.index]?.judge
                }
              />
            ))}
          </PageRows>
        </PageSection>
      )}

      {comparison.regressions === null ? null : (
        <PageSection
          description={t("comparison.regressionsDescription")}
          title={t("comparison.regressionsTitle")}
        >
          {comparison.regressions.length === 0 ? (
            <p className="mt-6 text-muted-foreground text-sm" role="status">
              {t("comparison.noRegressions")}
            </p>
          ) : (
            <PageRows>
              {comparison.regressions.map((row, index) => (
                <RegressionRowView
                  key={row.index}
                  row={row}
                  showSeparator={index > 0}
                />
              ))}
            </PageRows>
          )}
        </PageSection>
      )}
    </>,
  );
}

/*
 * The entry state: no experiment list face exists yet, so the page's own form addresses
 * the comparison — four ids, one Compare. The address it builds is the shareable,
 * machine-readable URL the query then reads.
 */
function SelectionSection({ agentId }: { agentId: string }) {
  const { t } = useTranslation("ai-observability-evaluations");
  const navigate = useNavigate();
  const [draft, setDraft] = useState({
    baselineExperimentId: "",
    baselineExecutionId: "",
    candidateExperimentId: "",
    candidateExecutionId: "",
  });
  const complete = Object.values(draft).every((id) => id.trim() !== "");
  const update = (patch: Partial<typeof draft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  return (
    <PageSection
      description={t("comparison.selectDescription")}
      title={t("comparison.selectTitle")}
    >
      <FieldGroup>
        {(
          [
            ["baselineExperimentId", "comparison.baselineExperiment"],
            ["baselineExecutionId", "comparison.baselineExecution"],
            ["candidateExperimentId", "comparison.candidateExperiment"],
            ["candidateExecutionId", "comparison.candidateExecution"],
          ] as const
        ).map(([field, label]) => (
          <Field key={field}>
            <FieldLabel htmlFor={`experiment-compare-${field}`}>
              {t(label)}
            </FieldLabel>
            <Input
              id={`experiment-compare-${field}`}
              onChange={(event) => update({ [field]: event.target.value })}
              value={draft[field]}
            />
          </Field>
        ))}
      </FieldGroup>
      {complete ? null : (
        <p className="mt-3 text-muted-foreground text-xs">
          {t("comparison.incomplete")}
        </p>
      )}
      <Button
        className="mt-4"
        disabled={!complete}
        onClick={() =>
          navigate({
            params: { agentId },
            search: draft,
            to: "/bots/$agentId/evaluations/experiment-comparisons",
          })
        }
        size="sm"
        type="button"
      >
        {t("comparison.compare")}
      </Button>
    </PageSection>
  );
}

/**
 * One side's own facts: the execution projection and the result link, verbatim. Every
 * numeric the row interpolates is finite-checked at the seam (OCR round 2, R2-08):
 * JSON can carry 1e999 — a typeof-number Infinity the guard cannot tell from a real
 * count — and `Infinity * 100` rounding to NaN% or a 1e999 s duration is not a
 * sentence. An execution state the vocabulary cannot name renders verbatim, never as
 * a raw i18n key.
 */
function SideRow({
  label,
  side,
  showSeparator = false,
}: {
  label: string;
  side: ExperimentComparisonSide;
  showSeparator?: boolean;
}) {
  const { t } = useTranslation("ai-observability-evaluations");
  const { formatDateTime } = useDateTime();
  const { execution, summary } = side.report;
  const stateWord = isKnownExecutionState(execution.state)
    ? t(`states.${execution.state as ExperimentExecutionState}`)
    : execution.state;
  const finite = (value: number): number | null =>
    Number.isFinite(value) ? value : null;
  const completionPercent = finite(side.completionRate);
  const meanScore =
    summary.meanScore === null ? null : finite(summary.meanScore);
  const durationMs =
    side.timing.durationMs === null ? null : finite(side.timing.durationMs);
  return (
    <>
      {showSeparator ? <Separator /> : null}
      <Item size="sm">
        <ItemContent>
          <ItemTitle>{label}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            <span className="break-all font-mono text-xs">
              {`${side.experimentId} · ${side.executionId}`}
            </span>
          </ItemDescription>
          <ItemDescription className="line-clamp-none">
            {[
              stateWord,
              t("results.base", { count: summary.sampleBase }),
              t("comparison.scored", { count: summary.scored }),
              summary.meanScore === null
                ? t("results.meanNone")
                : meanScore === null
                  ? null
                  : `${t("results.meanScore")} ${meanScore.toFixed(2)}`,
              completionPercent === null
                ? null
                : t("comparison.completion", {
                    percent: Math.round(completionPercent * 100),
                  }),
              Number.isFinite(side.usage.reported) &&
              Number.isFinite(side.usage.missing)
                ? t("comparison.usageLedger", {
                    reported: side.usage.reported,
                    missing: side.usage.missing,
                  })
                : null,
              durationMs === null
                ? null
                : t("comparison.duration", {
                    seconds: Math.round(durationMs / 1000),
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
             * execution record — the same adjudicated backlink the results page shows.
             */}
            <a
              className="break-all font-mono text-xs underline underline-offset-4"
              href={side.resultLink}
            >
              {side.resultLink}
            </a>
          </ItemDescription>
        </ItemContent>
      </Item>
    </>
  );
}

/** One ledger row: the witnesses, and what a difference on this field means. */
function FieldRow({
  entry,
  showSeparator,
}: {
  entry: ExperimentCompatibilityEntry;
  showSeparator: boolean;
}) {
  const { t } = useTranslation("ai-observability-evaluations");
  /*
   * The ledger's field names are a closed shared vocabulary (R3-02, R2-09's
   * standard): the bundle has a sentence for each of them, and a word it cannot
   * name — a newer server's field — renders itself, never `comparison.fields.<word>`
   * echoed as a raw key.
   */
  const fieldWord = isKnownCompatibilityField(entry.field)
    ? t(`comparison.fields.${entry.field}`)
    : entry.field;
  const witness = (value: string | null) =>
    value ?? t("comparison.witnessUnavailable");
  const verdict = entry.equal
    ? t("comparison.sameOnBothSides")
    : entry.blocking
      ? t("comparison.blockingDifference")
      : t("comparison.configDifference");
  return (
    <>
      {showSeparator ? <Separator /> : null}
      <Item size="sm">
        <ItemContent>
          <ItemTitle>{fieldWord}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            <span className="break-all font-mono text-xs">
              {`${witness(entry.baseline)} → ${witness(entry.candidate)}`}
            </span>
          </ItemDescription>
          <ItemDescription className="line-clamp-none">
            {verdict}
          </ItemDescription>
        </ItemContent>
      </Item>
    </>
  );
}

/** The mean delta: the arithmetic difference of the two means, or its own absence. */
function MeanRow({
  deltas,
}: {
  deltas: NonNullable<ExperimentComparison["deltas"]>;
}) {
  const { t } = useTranslation("ai-observability-evaluations");
  const { meanScore } = deltas;
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{t("results.meanScore")}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {[
            meanScore.baseline === null
              ? t("results.meanNone")
              : meanScore.baseline.toFixed(2),
            meanScore.candidate === null
              ? t("results.meanNone")
              : meanScore.candidate.toFixed(2),
            meanScore.delta === null
              ? t("comparison.meanDeltaNone")
              : t("comparison.meanDelta", {
                  delta: meanScore.delta.toFixed(2),
                }),
          ].join(" · ")}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/** One shared frozen case: both sides' classes and scores, and the closed direction word. */
function SampleDeltaRow({
  delta,
  showSeparator,
  baselineJudge,
  candidateJudge,
}: {
  delta: ExperimentSampleDelta;
  showSeparator: boolean;
  /** Each side's own judge record for this index (T27-rn L-3), when one answered. */
  baselineJudge: unknown;
  candidateJudge: unknown;
}) {
  const { t } = useTranslation("ai-observability-evaluations");
  /*
   * The class words are the shared seven-class closed set (R3-03, R2-09's standard):
   * a word the bundle cannot name renders itself, never `classes.<word>` as a key.
   */
  const classWord = (one: { class: ExperimentSampleClass }): string =>
    isKnownSampleClass(one.class) ? t(`classes.${one.class}`) : one.class;
  const side = (one: { class: ExperimentSampleClass; score: number | null }) =>
    [classWord(one), one.score === null ? null : one.score.toFixed(2)]
      .filter((part) => part !== null)
      .join(" ");
  // Each side's judge fact, beside the classes it belongs to — its own score or its
  // own failure code, never averaged into either side's rule score (T27-rn L-3).
  const judgeSide = (label: string, record: unknown) => {
    const facts = judgeFacts(record);
    if (facts === null) return null;
    return facts.kind === "scored"
      ? `${label} ${t("sample.judgeScored", { score: facts.score.toFixed(2) })}`
      : [label, t("sample.judgeFailed"), facts.code, facts.message ?? null]
          .filter((part) => part !== null)
          .join(" · ");
  };
  const judgeLine = [
    judgeSide(t("comparison.baseline"), baselineJudge),
    judgeSide(t("comparison.candidate"), candidateJudge),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <>
      {showSeparator ? <Separator /> : null}
      <Item size="sm">
        <ItemContent>
          <ItemTitle>
            {`#${delta.index} ${t(`comparison.direction.${delta.direction}`)}`}
          </ItemTitle>
          <ItemDescription className="line-clamp-none">
            {[
              side(delta.baseline),
              "→",
              side(delta.candidate),
              delta.scoreDelta === null
                ? t("comparison.scoreDeltaNone")
                : t("comparison.scoreDelta", {
                    delta: delta.scoreDelta.toFixed(2),
                  }),
            ].join(" · ")}
          </ItemDescription>
          {judgeLine === "" ? null : (
            <ItemDescription className="line-clamp-none">
              {judgeLine}
            </ItemDescription>
          )}
        </ItemContent>
      </Item>
    </>
  );
}

/** One regression: the frozen case, both sides' facts, and both result links. */
function RegressionRowView({
  row,
  showSeparator,
}: {
  row: ExperimentRegressionRow;
  showSeparator: boolean;
}) {
  const { t } = useTranslation("ai-observability-evaluations");
  // Same closed-set class word as the delta rows (R3-03): verbatim when unnameable.
  const classWord = (one: { class: ExperimentSampleClass }): string =>
    isKnownSampleClass(one.class) ? t(`classes.${one.class}`) : one.class;
  const one = (one: ExperimentRegressionRow["baseline"]) => (
    <ItemDescription className="line-clamp-none">
      {[
        classWord(one),
        one.score === null ? null : one.score.toFixed(2),
        one.code,
      ]
        .filter((part) => part !== null)
        .join(" · ")}
      {" · "}
      {/*
       * The T28 result link, server-minted from the row this scope just read — the
       * adjudicated way back to the safe execution record, shown verbatim.
       */}
      <a
        className="break-all font-mono text-xs underline underline-offset-4"
        href={one.resultLink}
      >
        {one.resultLink}
      </a>
    </ItemDescription>
  );
  return (
    <>
      {showSeparator ? <Separator /> : null}
      <Item size="sm">
        <ItemContent>
          <ItemTitle>
            {`#${row.index} ${t("comparison.direction.regressed")}`}
          </ItemTitle>
          <ItemDescription className="line-clamp-none">
            <span className="break-all font-mono text-xs">
              {t("comparison.case", {
                version: row.case.datasetVersionId,
                hash: row.case.contentHash,
              })}
            </span>
          </ItemDescription>
          {one(row.baseline)}
          {one(row.candidate)}
        </ItemContent>
      </Item>
    </>
  );
}
