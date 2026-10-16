/**
 * The experiment comparison interface and its compatibility verdict (Issue #35 / DAG T29).
 *
 * A comparison is READ, never minted: both sides are T28 result reports over T23-settled
 * executions, re-scored at read time by the frozen rule sets, and every number below is a
 * function of those two reports — no second scoring path, no winner-declaring logic, no
 * significance test nobody asked for. The interface answers arithmetic and class facts; the
 * reader draws conclusions.
 *
 * ## Compatibility (Issue #35 AC1)
 *
 * Two experiments are comparable exactly when they evaluate the same frozen sample set and
 * the same scoring definition:
 *
 *  - `datasetContentHash` — T19's content-addressed identity of the frozen cases. Equal
 *    hashes mean byte-identical sample bases under one redaction policy, so index N names
 *    the same case on both sides. Different hashes mean the deltas would compare apples to
 *    cases that were never asked — the comparison refuses to rank them.
 *  - `judgeVersion` + `judgeConfig` — the scoring definition T22 froze. Different scorers
 *    produce different fractions over the same outputs; a withheld judgeVersion cannot
 *    even be attested, so it is unknown, never assumed equal.
 *
 * Everything else the freeze pins — readOnlyTools, modelName, modelParameters, prompt,
 * botConfig, toolFixtures — is the *configuration being compared*, the experiment's
 * variable, not an incompatibility: those differences ride the ledger with `equal` flags so
 * a reader sees exactly what changed, but they never block the verdict. An incompatible
 * pair answers the per-field ledger and both sides' own facts, and `deltas`/`regressions`
 * stay null — no quality winner is claimed across different cases or different scorers.
 *
 * ## Missing values (Issue #35 AC2)
 *
 * Along T28's explicit-base discipline: a side with no scored samples keeps a null mean and
 * the mean delta stays null; a sample that failed on one side keeps a null scoreDelta — a
 * missing score is never a 0, a −1, or a silently dropped row; an unsettled execution keeps
 * a null durationMs. Completion rate counts settled samples only (the base minus in-progress
 * and pending-reconciliation), and the usage ledger counts records present and missing
 * rather than padding absent ones.
 *
 * ## Regressions (Issue #35 AC3)
 *
 * A regressed sample is a class fact, not a story: every row carries the T28 classes and
 * codes verbatim on both sides, the frozen case (dataset version + content hash) and the
 * two server-minted result links. Unknown stays `pending_reconciliation/CASE_UNKNOWN`,
 * metrics-only stays `scoring_failed/OUTPUT_MISSING` — the comparison mints no explanation
 * the underlying records do not already make.
 *
 * ## Non-terminal samples (the T29-rev L-1 fix, before the page consumed the verdict)
 *
 * `in_progress` (a healthy execution still in flight) and `pending_reconciliation` (an
 * orphan awaiting recovery) have no final answer yet: their settlement may still score
 * anything, so they keep the fail-closed `incomparable` and never enter `regressions` —
 * they masquerade neither as regressions nor as improvements. Only terminal classes
 * (`execution_failed`, `scoring_failed`, `cancelled`, `sync_failure`) can close a
 * scored sample's verdict; a `scored → terminal-failure` pair is the honest scoreless
 * regression.
 *
 * ## Authorization (Issue #35 AC4, spec A5/A9)
 *
 * One scope answers both sides: every read — the experiment rows for the ledger and the
 * T28 reports for the samples — is scope-keyed through the same stores, so a guessed
 * experiment, execution or dataset version on either side is simply not found, and an
 * execution that does not name its experiment cannot be linked in. Rule experiments
 * compare without any model judge: the deterministic T26 scorer is the whole scoring path.
 */
import { createHash } from "node:crypto";
import type { SafeText, SafeValue } from "../../../shared/ai-observability";
import type { ObservationScope } from "./contracts";
import type { ObservationDatasetStore } from "./datasets";
import { canonicalJson } from "./datasets";
import type { ObservationExecutionStore } from "./executions";
import type {
  ObservationExperiment,
  ObservationExperimentStore,
} from "./experiments";
import {
  createExperimentResultService,
  ExperimentResultsError,
  type ExperimentResultsReport,
  type SampleClass,
  type SampleReason,
  type WorkTicketState,
} from "./results";
import { assertObservationScope } from "./scope";

/** The frozen fields the ledger names, in display order. */
export const COMPATIBILITY_FIELDS = [
  "datasetContentHash",
  "judgeVersion",
  "judgeConfig",
  "readOnlyTools",
  "modelName",
  "modelParameters",
  "prompt",
  "botConfig",
  "toolFixtures",
] as const;

export type CompatibilityField = (typeof COMPATIBILITY_FIELDS)[number];

export type CompatibilityEntry = Readonly<{
  field: CompatibilityField;
  /** A compact witness identifying each side's content: text, a JSON list, or sha256:… */
  baseline: string | null;
  candidate: string | null;
  equal: boolean;
  /** True when a difference on this field refuses the comparison. */
  blocking: boolean;
}>;

export type ComparisonSideInput = Readonly<{
  experimentId: string;
  executionId: string;
}>;

/** One side's own facts: the T28 report verbatim plus the comparison's derived ledgers. */
export type ComparisonSide = Readonly<{
  experimentId: string;
  executionId: string;
  resultLink: string;
  report: ExperimentResultsReport;
  /** Settled samples over the base: (base − inProgress − pendingReconciliation) / base. */
  completionRate: number;
  timing: Readonly<{
    startedAt: string | null;
    settledAt: string | null;
    /** settled − started in ms; null while either end is unknown, never a masked 0. */
    durationMs: number | null;
  }>;
  /** Usage presence: values ride report.samples[].usage, missing stays counted. */
  usage: Readonly<{ reported: number; missing: number }>;
}>;

export type SampleDelta = Readonly<{
  index: number;
  baseline: Readonly<{ class: SampleClass; score: number | null }>;
  candidate: Readonly<{ class: SampleClass; score: number | null }>;
  /** Finite only when both sides scored; a missing score never masquerades as a 0. */
  scoreDelta: number | null;
  /**
   * The closed four-word verdict. Non-terminal classes on either side keep
   * `incomparable` — an open settlement is never a regressed or improved fact.
   */
  direction: "regressed" | "improved" | "unchanged" | "incomparable";
}>;

export type RegressionRow = Readonly<{
  index: number;
  /** The frozen case both sides evaluated (the shared content hash names its content). */
  case: Readonly<{ datasetVersionId: string; contentHash: string }>;
  baseline: Readonly<{
    class: SampleClass;
    score: number | null;
    /** The T28 reason code; null when scored — the class already says everything. */
    code: string | null;
    resultLink: string;
  }>;
  candidate: Readonly<{
    class: SampleClass;
    score: number | null;
    code: string | null;
    resultLink: string;
  }>;
}>;

export type ExperimentComparison = Readonly<{
  baseline: ComparisonSide;
  candidate: ComparisonSide;
  compatibility: Readonly<{
    compatible: boolean;
    fields: readonly CompatibilityEntry[];
  }>;
  /** Null when incompatible — no deltas, no winner, across different cases or scorers. */
  deltas: Readonly<{
    meanScore: Readonly<{
      baseline: number | null;
      candidate: number | null;
      delta: number | null;
    }>;
    perSample: readonly SampleDelta[];
  }> | null;
  /** Null when incompatible; the regressed samples otherwise, possibly none. */
  regressions: readonly RegressionRow[] | null;
}>;

export type ExperimentComparisonErrorCode =
  | "COMPARISON_INPUT_INVALID"
  /**
   * Storage damage (T29-rev L-2): the two rows claim one content hash but pin frozen
   * bases of different sizes — the freeze pipeline cannot produce this, so the read
   * refuses instead of indexing a sample that is not there.
   */
  | "COMPARISON_SAMPLE_BASE_DIVERGED";

export class ExperimentComparisonError extends Error {
  constructor(
    public code: ExperimentComparisonErrorCode,
    public status: 400 | 502,
  ) {
    super(code);
  }
}

/** A non-empty opaque reference; only emptiness is refused, like every store here. */
function reference(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExperimentComparisonError("COMPARISON_INPUT_INVALID", 400);
  }
  return value;
}

/** A projected text as its witness, or null when the policy withheld it — unknown, not equal. */
function textWitness(value: SafeText): string | null {
  return value.state === "projected" ? value.text : null;
}

/** A structural field's witness: the identity of its canonical form, never its payload. */
function structureWitness(value: SafeText | SafeValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function structuralEqual(
  baseline: SafeText | SafeValue,
  candidate: SafeText | SafeValue,
): boolean {
  return canonicalJson(baseline) === canonicalJson(candidate);
}

function textEqual(baseline: SafeText, candidate: SafeText): boolean {
  return (
    baseline.state === "projected" &&
    candidate.state === "projected" &&
    baseline.text === candidate.text
  );
}

/** The per-field ledger over two frozen experiments. */
function compatibility(
  baseline: ObservationExperiment,
  candidate: ObservationExperiment,
): ExperimentComparison["compatibility"] {
  const fields: CompatibilityEntry[] = [
    {
      field: "datasetContentHash",
      baseline: baseline.datasetContentHash,
      candidate: candidate.datasetContentHash,
      equal: baseline.datasetContentHash === candidate.datasetContentHash,
      blocking: true,
    },
    {
      field: "judgeVersion",
      baseline: textWitness(baseline.config.judgeVersion),
      candidate: textWitness(candidate.config.judgeVersion),
      equal: textEqual(
        baseline.config.judgeVersion,
        candidate.config.judgeVersion,
      ),
      blocking: true,
    },
    {
      field: "judgeConfig",
      baseline: structureWitness(baseline.config.judgeConfig),
      candidate: structureWitness(candidate.config.judgeConfig),
      equal: structuralEqual(
        baseline.config.judgeConfig,
        candidate.config.judgeConfig,
      ),
      blocking: true,
    },
    {
      field: "readOnlyTools",
      baseline: canonicalJson(baseline.config.readOnlyTools.map(textWitness)),
      candidate: canonicalJson(candidate.config.readOnlyTools.map(textWitness)),
      equal:
        canonicalJson(baseline.config.readOnlyTools.map(textWitness)) ===
        canonicalJson(candidate.config.readOnlyTools.map(textWitness)),
      blocking: false,
    },
    {
      field: "modelName",
      baseline: textWitness(baseline.config.modelName),
      candidate: textWitness(candidate.config.modelName),
      equal: textEqual(baseline.config.modelName, candidate.config.modelName),
      blocking: false,
    },
    {
      field: "modelParameters",
      baseline: structureWitness(baseline.config.modelParameters),
      candidate: structureWitness(candidate.config.modelParameters),
      equal: structuralEqual(
        baseline.config.modelParameters,
        candidate.config.modelParameters,
      ),
      blocking: false,
    },
    {
      field: "prompt",
      baseline: structureWitness(baseline.config.prompt),
      candidate: structureWitness(candidate.config.prompt),
      equal: structuralEqual(baseline.config.prompt, candidate.config.prompt),
      blocking: false,
    },
    {
      field: "botConfig",
      baseline: structureWitness(baseline.config.botConfig),
      candidate: structureWitness(candidate.config.botConfig),
      equal: structuralEqual(
        baseline.config.botConfig,
        candidate.config.botConfig,
      ),
      blocking: false,
    },
    {
      field: "toolFixtures",
      baseline: structureWitness(baseline.config.toolFixtures),
      candidate: structureWitness(candidate.config.toolFixtures),
      equal: structuralEqual(
        baseline.config.toolFixtures,
        candidate.config.toolFixtures,
      ),
      blocking: false,
    },
  ];
  return {
    compatible: fields.every((one) => !one.blocking || one.equal),
    fields,
  };
}

/** One side's derived ledgers over its T28 report. */
function side(
  experimentId: string,
  report: ExperimentResultsReport,
): ComparisonSide {
  const { summary, samples, execution } = report;
  const unsettled = summary.inProgress + summary.pendingReconciliation;
  const started = execution.startedAt ? Date.parse(execution.startedAt) : null;
  const settled = execution.settledAt ? Date.parse(execution.settledAt) : null;
  const span = started !== null && settled !== null ? settled - started : null;
  return {
    experimentId,
    executionId: report.executionId,
    resultLink: report.resultLink,
    report,
    completionRate:
      summary.sampleBase === 0
        ? 0
        : (summary.sampleBase - unsettled) / summary.sampleBase,
    timing: {
      startedAt: execution.startedAt,
      settledAt: execution.settledAt,
      durationMs: span !== null && Number.isFinite(span) ? span : null,
    },
    usage: {
      reported: samples.filter((one) => one.usage !== null).length,
      missing: samples.filter((one) => one.usage === null).length,
    },
  };
}

/** The reason code for the regression rows: the class discriminant, verbatim. */
function reasonCode(reason: SampleReason): string | null {
  return reason.class === "scored" ? null : reason.code;
}

/** The classes whose verdict is still open: fail-closed to `incomparable`, never ranked. */
const UNSETTLED_CLASSES: readonly SampleClass[] = [
  "in_progress",
  "pending_reconciliation",
];

export type ExperimentComparisonService = Readonly<{
  /**
   * Compare two executions of two experiments, inside the caller's scope. Every id is read
   * scope-keyed on both sides; anything not found — or an execution that does not name its
   * experiment — answers the 404, never an empty side.
   */
  compare(
    scope: ObservationScope,
    input: Readonly<{
      baseline: ComparisonSideInput;
      candidate: ComparisonSideInput;
    }>,
  ): Promise<ExperimentComparison>;
}>;

export function createExperimentComparisonService(
  deps: Readonly<{
    experiments: Pick<ObservationExperimentStore, "getExperiment">;
    executions: Pick<ObservationExecutionStore, "get">;
    datasets: Pick<ObservationDatasetStore, "getVersion">;
    /** The work-queue read for lease-recovery classification (T34's ticket table). */
    ticket: (executionId: string) => Promise<WorkTicketState | null>;
  }>,
): ExperimentComparisonService {
  const results = createExperimentResultService(deps);
  return {
    async compare(scope, input) {
      assertObservationScope(scope);
      reference(input.baseline.experimentId);
      reference(input.baseline.executionId);
      reference(input.candidate.experimentId);
      reference(input.candidate.executionId);

      // The frozen rows the ledger compares, read scope-keyed like every store here.
      const readExperiment = async (id: string) => {
        const row = await deps.experiments.getExperiment(scope, id);
        if (!row) {
          throw new ExperimentResultsError("RESULTS_EXPERIMENT_NOT_FOUND", 404);
        }
        return row;
      };
      const baselineRow = await readExperiment(input.baseline.experimentId);
      const candidateRow = await readExperiment(input.candidate.experimentId);

      // Both T28 reports: the taxonomy, the explicit bases and the unfakeable result
      // links all ride verbatim, so the comparison adds nothing it must keep honest.
      const baselineReport = await results.query(scope, input.baseline);
      const candidateReport = await results.query(scope, input.candidate);

      const compatible = compatibility(baselineRow, candidateRow);
      const baselineSide = side(input.baseline.experimentId, baselineReport);
      const candidateSide = side(input.candidate.experimentId, candidateReport);

      if (!compatible.compatible) {
        return {
          baseline: baselineSide,
          candidate: candidateSide,
          compatibility: compatible,
          deltas: null,
          regressions: null,
        };
      }

      const base = baselineReport.summary.sampleBase;
      if (candidateReport.summary.sampleBase !== base) {
        // Equal hash ⇒ equal base is the invariant the freeze pipeline forges; a read
        // that sees it broken is looking at damaged rows, and answers its code rather
        // than indexing a sample that is not there (T29-rev L-2).
        throw new ExperimentComparisonError(
          "COMPARISON_SAMPLE_BASE_DIVERGED",
          502,
        );
      }
      const perSample: SampleDelta[] = [];
      const regressions: RegressionRow[] = [];
      for (let index = 0; index < base; index += 1) {
        const before = baselineReport.samples[index];
        const after = candidateReport.samples[index];
        const bothScored =
          before.class === "scored" &&
          after.class === "scored" &&
          before.score !== null &&
          after.score !== null;
        const scoreDelta = bothScored ? after.score - before.score : null;
        let direction: SampleDelta["direction"];
        if (
          UNSETTLED_CLASSES.includes(before.class) ||
          UNSETTLED_CLASSES.includes(after.class)
        ) {
          // Still open on a side: the settlement may yet answer anything, so the
          // direction stays incomparable — never a premature regressed or improved.
          direction = "incomparable";
        } else if (bothScored && scoreDelta !== null) {
          direction =
            scoreDelta === 0
              ? "unchanged"
              : scoreDelta < 0
                ? "regressed"
                : "improved";
        } else if (before.class === "scored") {
          // Used to pass, now fails terminally: a regression the missing score keeps
          // scoreless — never a fabricated −1.
          direction = "regressed";
        } else if (after.class === "scored") {
          direction = "improved";
        } else {
          direction = "incomparable";
        }
        perSample.push({
          index,
          baseline: { class: before.class, score: before.score },
          candidate: { class: after.class, score: after.score },
          scoreDelta:
            scoreDelta !== null && Number.isFinite(scoreDelta)
              ? scoreDelta
              : null,
          direction,
        });
        if (direction === "regressed") {
          regressions.push({
            index,
            case: {
              datasetVersionId: baselineRow.datasetVersionId,
              contentHash: baselineRow.datasetContentHash,
            },
            baseline: {
              class: before.class,
              score: before.score,
              code: reasonCode(before.reason),
              resultLink: before.resultLink,
            },
            candidate: {
              class: after.class,
              score: after.score,
              code: reasonCode(after.reason),
              resultLink: after.resultLink,
            },
          });
        }
      }

      const before = baselineReport.summary.meanScore;
      const after = candidateReport.summary.meanScore;
      const meanDelta =
        before !== null && after !== null && Number.isFinite(after - before)
          ? after - before
          : null;

      return {
        baseline: baselineSide,
        candidate: candidateSide,
        compatibility: compatible,
        deltas: {
          meanScore: { baseline: before, candidate: after, delta: meanDelta },
          perSample,
        },
        regressions,
      };
    },
  };
}
