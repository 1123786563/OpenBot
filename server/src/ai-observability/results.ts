/**
 * The experiment result query and its failure taxonomy (Issue #34 / DAG T28).
 *
 * A result report is READ, never minted: the execution row is the truth T23 settled, the
 * rule set is the configuration T22 froze, and the score is what T26's deterministic
 * scorer answers when the two meet — so scoring happens here, at read time, and the same
 * query always answers the same report (no clock, no randomness, no second write path,
 * no result table to drift out of sync with the execution it claims to describe).
 *
 * ## The taxonomy (Issue #34 AC2 — a failure is never a score of 0)
 *
 * Every sample of the dataset version's case list — the sample BASE — is classified into
 * exactly one closed class:
 *
 *  - `scored`            — executed and honestly scored; carries a finite fraction.
 *  - `in_progress`       — the execution is not settled and its claim ticket is live.
 *  - `execution_failed`  — the case did not run to an honest ending (`CASE_FAILED`), or
 *                          the whole execution settled `failed` (the row's error code).
 *  - `scoring_failed`    — the case ran but could not be honestly scored: no output, an
 *                          output the redaction policy withheld or cut (`OUTPUT_MISSING`),
 *                          the deterministic budget ran out (`EVALUATION_TIMEOUT`), a rule
 *                          errored (`RULE_ERROR`), the frozen rule set is unusable
 *                          (`RULESET_UNAVAILABLE`) or empty (`NO_RULES`).
 *  - `cancelled`         — the execution settled cancelled (the revocation seam).
 *  - `pending_reconciliation` — the truth is not decided yet in a way only lease recovery
 *                          or re-observation can settle: a case whose ending the runner
 *                          could not observe (`CASE_UNKNOWN`), or an unsettled execution
 *                          whose claim ticket is orphaned — an expired lease, a finished
 *                          ticket over an unsettled row, or a ticket the retention sweep
 *                          took (`LEASE_EXPIRED` / `TICKET_FINISHED` / `TICKET_MISSING`).
 *  - `sync_failure`      — the settled record did not land intact: a base case missing
 *                          from the stored result, or a case record that is not the
 *                          result contract's shape (`CASE_RECORD_MISSING` / `CASE_RECORD_DAMAGED`).
 *
 * The five failure classes the issue names are distinct on purpose: an execution failure
 * never impersonates a scoring failure, a cancellation never impersonates either, and a
 * record gap never becomes a guessed outcome. The mean covers `scored` samples only, and
 * the summary names the base and every exclusion count, so a mean over one sample of ten
 * cannot quietly present itself as the experiment's score.
 *
 * ## Authorization (Issue #34 AC3/AC4, spec A5/A7/A9)
 *
 * Every read is scope-keyed through the same stores that wrote the rows, so a guessed
 * experiment, dataset version or execution id — or another scope's real one — is simply
 * not found. The result link is unfakeable because the service mints it from the row it
 * just read in the caller's scope: an execution that does not name the requested
 * experiment is not found, and no client input ever names a scope, an epoch or a link.
 */
import { and, eq, sql } from "drizzle-orm";
import type { SafeText, SafeValue } from "../../../shared/ai-observability";
import type { Database } from "../db/client";
import { workItems } from "../db/schema/work";
import type { ObservationScope } from "./contracts";
import type { ObservationDatasetStore } from "./datasets";
import {
  EXECUTION_WORK_KIND,
  type ExecutionState,
  isTerminalExecutionState,
  type ObservationExecution,
  type ObservationExecutionStore,
  parseExecutionState,
} from "./executions";
import type { ObservationExperimentStore } from "./experiments";
import { assertObservationScope } from "./scope";
import {
  extractRuleSet,
  type RuleScore,
  scoreRunOutput,
} from "./scoring/rules";

/** The closed classification vocabulary. The order is display order, nothing more. */
export const SAMPLE_CLASSES = [
  "scored",
  "in_progress",
  "execution_failed",
  "scoring_failed",
  "cancelled",
  "pending_reconciliation",
  "sync_failure",
] as const;

export type SampleClass = (typeof SAMPLE_CLASSES)[number];

export type ScoringFailedCode =
  | "RULESET_UNAVAILABLE"
  | "OUTPUT_MISSING"
  | "EVALUATION_TIMEOUT"
  | "RULE_ERROR"
  | "NO_RULES";

export type ReconciliationCode =
  | "CASE_UNKNOWN"
  | "LEASE_EXPIRED"
  | "TICKET_FINISHED"
  | "TICKET_MISSING";

/** The per-sample reason, discriminated by class — the code is the contract. */
export type SampleReason =
  | {
      class: "scored";
      passed: number;
      failed: number;
      rules: readonly RuleScore[];
    }
  | {
      class: "in_progress";
      code: "EXECUTION_NOT_SETTLED";
      state: "pending" | "running";
    }
  | { class: "execution_failed"; code: string }
  | {
      class: "scoring_failed";
      code: ScoringFailedCode;
      message?: string;
      rules?: readonly RuleScore[];
    }
  | { class: "cancelled"; code: "CANCELLED" }
  | { class: "pending_reconciliation"; code: ReconciliationCode }
  | {
      class: "sync_failure";
      code: "CASE_RECORD_MISSING" | "CASE_RECORD_DAMAGED";
    };

export type ExperimentResultsSample = Readonly<{
  index: number;
  class: SampleClass;
  /** The fraction of rules that passed; finite, or null unless the class is `scored`. */
  score: number | null;
  reason: SampleReason;
  /** The case's projected usage record as plain JSON, or null when none survived. */
  usage: unknown;
  /**
   * The case's projected judge record (T27) as plain JSON, or null when no judge
   * answered for this case. A scoring fact beside the rule score — its own status
   * (`scored` or `failed` with a JUDGE_* code), never a number averaged into `score`.
   */
  judge: unknown;
  /** The server-minted link back to this report, which names the execution id. */
  resultLink: string;
}>;

export type ExperimentResultsSummary = Readonly<{
  /** How many samples the pinned dataset version freezes — the base the mean stands on. */
  sampleBase: number;
  scored: number;
  executionFailed: number;
  scoringFailed: number;
  cancelled: number;
  pendingReconciliation: number;
  syncFailure: number;
  inProgress: number;
  /** The mean over scored samples only; null when none — never a masked zero. */
  meanScore: number | null;
}>;

export type ExperimentResultsReport = Readonly<{
  experimentId: string;
  executionId: string;
  resultLink: string;
  state: ExecutionState;
  /** The scorer version the frozen configuration pinned (T22's judgeVersion). */
  scorerVersion: string | null;
  /** The safe execution record this report links back to, as the scope may read it. */
  execution: Readonly<{
    id: string;
    state: ExecutionState;
    errorCode: string | null;
    caseCount: number | null;
    toolRejections: number;
    experimentConfigHash: string;
    startedAt: string | null;
    settledAt: string | null;
    createdAt: string;
  }>;
  summary: ExperimentResultsSummary;
  samples: readonly ExperimentResultsSample[];
}>;

export type ExperimentResultsErrorCode =
  | "RESULTS_INPUT_INVALID"
  | "RESULTS_EXPERIMENT_NOT_FOUND"
  | "RESULTS_EXECUTION_NOT_FOUND"
  | "RESULTS_DATASET_VERSION_NOT_FOUND";

export class ExperimentResultsError extends Error {
  constructor(
    public code: ExperimentResultsErrorCode,
    public status: 400 | 404,
  ) {
    super(code);
  }
}

/** A non-empty opaque reference; only emptiness is refused, like every store here. */
function reference(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExperimentResultsError("RESULTS_INPUT_INVALID", 400);
  }
  return value;
}

/** Where each class lands in the summary counts — the explicit base-and-exclusions ledger. */
const CLASS_TO_SUMMARY: Record<
  SampleClass,
  keyof Omit<ExperimentResultsSummary, "sampleBase" | "meanScore">
> = {
  scored: "scored",
  in_progress: "inProgress",
  execution_failed: "executionFailed",
  scoring_failed: "scoringFailed",
  cancelled: "cancelled",
  pending_reconciliation: "pendingReconciliation",
  sync_failure: "syncFailure",
};

/** The claim-ticket state one execution's work item is in, read for reconciliation. */
export type WorkTicketState = Readonly<{
  claimedBy: string | null;
  finishedAt: Date | null;
  /** `lease_until < now()` — judged on the database clock, the one that wrote the lease. */
  leaseExpired: boolean;
}>;

/**
 * The work-queue read behind the `ticket` seam. One row by (kind, key); the lease
 * comparison happens in SQL against `now()` because that is the clock the queue writes
 * leases with — two clocks pretending to be one is how a live lease gets stolen.
 */
export function createWorkTicketReader(
  db: Database,
): (executionId: string) => Promise<WorkTicketState | null> {
  return async (executionId) => {
    const rows = await db
      .select({
        claimedBy: workItems.claimedBy,
        finishedAt: workItems.finishedAt,
        leaseExpired: sql<boolean>`(${workItems.leaseUntil} < now())`,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, EXECUTION_WORK_KIND),
          eq(workItems.key, executionId),
        ),
      );
    return rows[0] ?? null;
  };
}

/** One stored case record, as the T28 settle contract writes it. */
type StoredCase = {
  index: number;
  status: "completed" | "failed" | "unknown";
  output?: SafeText | SafeValue;
  usage?: SafeText | SafeValue;
  judge?: SafeText | SafeValue;
  /** The admission's own refusal word (T25-rev L-1); a failed case may carry one. */
  reason?: string;
};

/**
 * Read the settled result defensively. Anything that is not the contract's shape — a
 * missing record for a base index, a case that is not `{index, status, output?, usage?, judge?}`
 * with an envelope where a projection belongs — is damage to report, never content to
 * interpret: the caller classifies it `sync_failure` rather than guessing an outcome.
 */
function readStoredCases(
  result: unknown,
  base: number,
): Map<number, StoredCase | "damaged"> {
  const cases = new Map<number, StoredCase | "damaged">();
  const root = result as { cases?: unknown } | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.cases)) {
    return cases;
  }
  for (const element of root.cases) {
    if (!element || typeof element !== "object" || Array.isArray(element)) {
      continue;
    }
    const record = element as Record<string, unknown>;
    if (
      typeof record.index !== "number" ||
      !Number.isInteger(record.index) ||
      record.index < 0 ||
      record.index >= base
    ) {
      continue;
    }
    // R4-29: two records claiming the same base index is corruption that reached the
    // store (write-side settleCompleted does not enforce uniqueness). The guard
    // discipline holds here too — damage to report, never content to interpret — so
    // a repeated index damages the whole case instead of the last write silently
    // reinterpreting which record is the truth.
    if (cases.has(record.index)) {
      cases.set(record.index, "damaged");
      continue;
    }
    const status = record.status;
    if (status !== "completed" && status !== "failed" && status !== "unknown") {
      cases.set(record.index, "damaged");
      continue;
    }
    const reason = record.reason;
    if (reason !== undefined && typeof reason !== "string") {
      cases.set(record.index, "damaged");
      continue;
    }
    const envelope = (value: unknown): value is SafeText | SafeValue =>
      !!value &&
      typeof value === "object" &&
      (value as { state?: unknown }).state !== undefined;
    if (
      (record.output !== undefined && !envelope(record.output)) ||
      (record.usage !== undefined && !envelope(record.usage)) ||
      (record.judge !== undefined && !envelope(record.judge))
    ) {
      cases.set(record.index, "damaged");
      continue;
    }
    cases.set(record.index, {
      index: record.index,
      status,
      ...(record.output === undefined ? {} : { output: record.output }),
      ...(record.usage === undefined ? {} : { usage: record.usage }),
      ...(record.judge === undefined ? {} : { judge: record.judge }),
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return cases;
}

/**
 * Serve a projected stored record (usage, judge) as plain JSON, envelopes
 * unwrapped. Only fully
 * projected content answers its value; a withheld or cut leaf answers null — the REST
 * contract never echoes a projection state it cannot honestly fill. Non-finite leaves
 * (a jsonb numeric that parses past JS infinity — the T26-rev3 overflow leftover)
 * answer null too: an overflowed usage number is a non-numeric data fact, never an
 * `Infinity` on the wire.
 *
 * The deep discipline (T28-rev L-1, tightened in T29): the write path wraps every
 * record field and array item of a projected payload in its own envelope, so a deep
 * object without `state`, a bare primitive where an envelope belongs, or an unknown
 * state word is storage damage, not content — it answers null, exactly like the shape
 * violations readStoredCases classifies as CASE_RECORD_DAMAGED. The read never
 * interprets what the contract cannot have produced.
 */
function plainEnvelope(envelope: SafeText | SafeValue | undefined): unknown {
  if (envelope?.state !== "projected" || !("value" in envelope)) return null;
  /** An envelope: only projected content answers a value, every other state nulls. */
  const unwrap = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const envelope = value as { state?: unknown };
    if (envelope.state === "projected") {
      return "value" in envelope
        ? payload((envelope as { value: unknown }).value)
        : "text" in envelope
          ? payload((envelope as { text: unknown }).text)
          : null;
    }
    // omitted, truncated, or a word the contract never minted: withheld.
    return null;
  };
  /** A payload: primitives serve as leaves; records and arrays hold envelopes only. */
  const payload = (value: unknown): unknown => {
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) return value.map(unwrap);
      const out: Record<string, unknown> = {};
      for (const [key, one] of Object.entries(
        value as Record<string, unknown>,
      )) {
        out[key] = unwrap(one);
      }
      return out;
    }
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  };
  return payload(envelope.value);
}

export type ExperimentResultService = Readonly<{
  /**
   * The result report for one execution of one experiment, inside the caller's scope.
   * Every id is read scope-keyed; anything not found — or not this experiment's
   * execution — answers the 404, not an empty report.
   */
  query(
    scope: ObservationScope,
    input: { experimentId: string; executionId: string },
  ): Promise<ExperimentResultsReport>;
}>;

export function createExperimentResultService(
  deps: Readonly<{
    experiments: Pick<ObservationExperimentStore, "getExperiment">;
    executions: Pick<ObservationExecutionStore, "get">;
    datasets: Pick<ObservationDatasetStore, "getVersion">;
    ticket: (executionId: string) => Promise<WorkTicketState | null>;
  }>,
): ExperimentResultService {
  return {
    async query(scope, input) {
      assertObservationScope(scope);
      reference(input.experimentId);
      reference(input.executionId);

      const experiment = await deps.experiments.getExperiment(
        scope,
        input.experimentId,
      );
      if (!experiment) {
        throw new ExperimentResultsError("RESULTS_EXPERIMENT_NOT_FOUND", 404);
      }
      const version = await deps.datasets.getVersion(
        scope,
        experiment.datasetVersionId,
      );
      if (!version) {
        // The pinned version is the sample base; without it no mean could name its
        // base honestly, so the read refuses rather than inventing one.
        throw new ExperimentResultsError(
          "RESULTS_DATASET_VERSION_NOT_FOUND",
          404,
        );
      }
      const execution = await deps.executions.get(scope, input.executionId);
      if (!execution || execution.experimentId !== experiment.id) {
        // The unfakeable back-link: an execution that does not name this experiment
        // is not this experiment's result, whoever's id it is.
        throw new ExperimentResultsError("RESULTS_EXECUTION_NOT_FOUND", 404);
      }

      const state = parseExecutionState(execution.state);
      const base = version.cases.length;
      const resultLink = `/api/ai-observability/bots/${scope.botId}/experiments/${experiment.id}/results/${execution.id}`;
      const judgeVersion = experiment.config.judgeVersion as SafeText;
      const scorerVersion =
        judgeVersion.state === "projected" ? judgeVersion.text : null;

      // Mutable while the classification runs; the report serves it frozen.
      const summary: {
        -readonly [K in keyof ExperimentResultsSummary]: ExperimentResultsSummary[K];
      } = {
        sampleBase: base,
        scored: 0,
        executionFailed: 0,
        scoringFailed: 0,
        cancelled: 0,
        pendingReconciliation: 0,
        syncFailure: 0,
        inProgress: 0,
        meanScore: null,
      };
      const scoreSum = { total: 0 };

      const push = (
        index: number,
        sampleClass: SampleClass,
        reason: SampleReason,
        usage: unknown = null,
        score: number | null = null,
        judge: unknown = null,
      ): ExperimentResultsSample => {
        summary[CLASS_TO_SUMMARY[sampleClass]] += 1;
        if (sampleClass === "scored" && score !== null) scoreSum.total += score;
        return {
          index,
          class: sampleClass,
          score,
          reason,
          usage,
          judge,
          resultLink,
        };
      };

      let samples: ExperimentResultsSample[];
      if (isTerminalExecutionState(state)) {
        if (state === "cancelled") {
          samples = Array.from({ length: base }, (_, index) =>
            push(index, "cancelled", { class: "cancelled", code: "CANCELLED" }),
          );
        } else if (state === "failed") {
          const code = execution.errorCode ?? "EXECUTION_FAILED";
          samples = Array.from({ length: base }, (_, index) =>
            push(index, "execution_failed", {
              class: "execution_failed",
              code,
            }),
          );
        } else {
          // Completed: the only state with per-case records to read.
          const stored = readStoredCases(execution.result, base);
          const ruleSet = extractRuleSet(
            experiment.config.judgeConfig as SafeValue,
          );
          samples = Array.from({ length: base }, (_, index) => {
            const record = stored.get(index);
            if (record === undefined) {
              return push(index, "sync_failure", {
                class: "sync_failure",
                code: "CASE_RECORD_MISSING",
              });
            }
            if (record === "damaged") {
              return push(index, "sync_failure", {
                class: "sync_failure",
                code: "CASE_RECORD_DAMAGED",
              });
            }
            if (record.status === "failed") {
              return push(index, "execution_failed", {
                class: "execution_failed",
                // The admission's own refusal word when the case carries one
                // (T25-rev L-1): the code names why, not just that it failed.
                code: record.reason ?? "CASE_FAILED",
              });
            }
            if (record.status === "unknown") {
              return push(index, "pending_reconciliation", {
                class: "pending_reconciliation",
                code: "CASE_UNKNOWN",
              });
            }
            const usage = plainEnvelope(record.usage);
            const judge = plainEnvelope(record.judge);
            if (!ruleSet.ok) {
              return push(
                index,
                "scoring_failed",
                {
                  class: "scoring_failed",
                  code: "RULESET_UNAVAILABLE",
                  message: ruleSet.message,
                },
                usage,
                null,
                judge,
              );
            }
            if (ruleSet.rules.length === 0) {
              return push(
                index,
                "scoring_failed",
                { class: "scoring_failed", code: "NO_RULES" },
                usage,
                null,
                judge,
              );
            }
            const run = scoreRunOutput(ruleSet, record.output ?? null);
            if (run.error) {
              return push(
                index,
                "scoring_failed",
                {
                  class: "scoring_failed",
                  code: run.error.code,
                  message: run.error.message,
                },
                usage,
                null,
                judge,
              );
            }
            const errored = run.results.filter((row) => row.status === "error");
            if (errored.length > 0) {
              return push(
                index,
                "scoring_failed",
                {
                  class: "scoring_failed",
                  code: "RULE_ERROR",
                  message: errored[0].message,
                  rules: run.results,
                },
                usage,
                null,
                judge,
              );
            }
            const passed = run.results.filter(
              (row) => row.status === "passed",
            ).length;
            const failed = run.results.length - passed;
            const score = passed / run.results.length;
            // The overflow guard: a fraction over a non-empty rule list is finite by
            // construction, and a non-finite score must never reach the wire — it is
            // a scoring failure, not a number.
            if (!Number.isFinite(score)) {
              return push(
                index,
                "scoring_failed",
                {
                  class: "scoring_failed",
                  code: "RULE_ERROR",
                  message: "non-finite score",
                },
                usage,
                null,
                judge,
              );
            }
            return push(
              index,
              "scored",
              { class: "scored", passed, failed, rules: run.results },
              usage,
              score,
              judge,
            );
          });
        }
      } else {
        // Pending or running: the claim ticket decides between honest progress and
        // lease-recovery territory.
        const unsettledState = state === "running" ? "running" : "pending";
        const ticket = await deps.ticket(execution.id);
        const orphanCode: ReconciliationCode | null =
          ticket === null
            ? "TICKET_MISSING"
            : ticket.finishedAt !== null
              ? "TICKET_FINISHED"
              : ticket.claimedBy !== null && ticket.leaseExpired
                ? "LEASE_EXPIRED"
                : null;
        samples = Array.from({ length: base }, (_, index) =>
          orphanCode === null
            ? push(index, "in_progress", {
                class: "in_progress",
                code: "EXECUTION_NOT_SETTLED",
                state: unsettledState,
              })
            : push(index, "pending_reconciliation", {
                class: "pending_reconciliation",
                code: orphanCode,
              }),
        );
      }

      if (summary.scored > 0) {
        const mean = scoreSum.total / summary.scored;
        summary.meanScore = Number.isFinite(mean) ? mean : null;
      }

      return {
        experimentId: experiment.id,
        executionId: execution.id,
        resultLink,
        state,
        scorerVersion,
        execution: projectExecution(execution, state),
        summary,
        samples,
      };
    },
  };
}

/** The execution record as the report serves it: dates as ISO strings, nothing else. */
function projectExecution(
  execution: ObservationExecution,
  state: ExecutionState,
): ExperimentResultsReport["execution"] {
  return {
    id: execution.id,
    state,
    errorCode: execution.errorCode,
    caseCount: execution.caseCount,
    toolRejections: execution.toolRejections,
    experimentConfigHash: execution.experimentConfigHash,
    startedAt: execution.startedAt?.toISOString() ?? null,
    settledAt: execution.settledAt?.toISOString() ?? null,
    createdAt: execution.createdAt.toISOString(),
  };
}
