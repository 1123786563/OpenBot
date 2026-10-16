/**
 * The wire contract of the creator's experiment surfaces (Issue #36 / DAG T30).
 *
 * This file is the ONE place the experiments contract is defined, exactly as
 * shared/ai-observability-runs.ts is for the runs chain: the browser renders these
 * shapes, and a backend contract change is a change here first. It mirrors two
 * server-side sources field for field — the T28 result service
 * (server/src/ai-observability/results.ts, whose REST route T29 mounts) and the T22
 * frozen submission (server/src/ai-observability/experiments.ts) — so the pages the
 * experiment chain renders cannot drift from what those services answer.
 *
 * Two URL faces have no server route yet (the coordinator's recorded leftover; a
 * later wiring ticket owns their implementation): submitting an experiment starts its
 * execution in one POST, and canceling settles a not-yet-terminal execution. The
 * shapes here are what those routes will answer, pinned so the wiring lands with zero
 * frontend change — the same discipline T18 applied to the steps contract:
 *
 *   POST /api/ai-observability/bots/:botId/experiments
 *     body: ExperimentSubmitInput → 200 SubmittedExperimentResult | 4xx { error }
 *   POST /api/ai-observability/bots/:botId/experiments/:experimentId/executions/:executionId/cancel
 *     → 200 CancelledExecutionResult | 4xx { error }
 *
 * The result read is T28's already-pinned face:
 *
 *   GET /api/ai-observability/bots/:botId/experiments/:experimentId/results/:executionId
 *     → 200 ExperimentResultsReport | 4xx { error }
 */

/**
 * The execution state machine's five words (T23's AiObservationExecutionState), the
 * vocabulary the results report's `state` fields speak. Closed by a database CHECK;
 * a body carrying anything else is damage, not a state to guess.
 */
export type ExperimentExecutionState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * The closed per-sample classification (T28's SAMPLE_CLASSES). The seven classes are
 * mutually exclusive facts of the database — a Judge problem is `scoring_failed`,
 * never mixed into the scored mean — and the order is display order, nothing more.
 */
export const EXPERIMENT_SAMPLE_CLASSES = [
  "scored",
  "in_progress",
  "execution_failed",
  "scoring_failed",
  "cancelled",
  "pending_reconciliation",
  "sync_failure",
] as const;

export type ExperimentSampleClass = (typeof EXPERIMENT_SAMPLE_CLASSES)[number];

/** T26's failed-row vocabulary (ScoringFailReason), as a scored sample's rule rows carry it. */
export type ExperimentRuleFailReason =
  | "not_equal"
  | "not_contained"
  | "no_match"
  | "comparison_false"
  | "non_numeric"
  | "output_not_json"
  | "path_missing"
  | "not_a_string";

/** T26's errored-row codes (ScoringFailureCode). */
export type ExperimentRuleErrorCode =
  | "RULE_SYNTAX_INVALID"
  | "EVALUATION_TIMEOUT"
  | "OUTPUT_MISSING";

/** One scoring rule's row, verbatim from T26 — the reason a `scored` sample shows. */
export type ExperimentRuleScore =
  | { id: string; index: number; status: "passed" }
  | {
      id: string;
      index: number;
      status: "failed";
      reason: ExperimentRuleFailReason;
    }
  | {
      id: string;
      index: number;
      status: "error";
      code: ExperimentRuleErrorCode;
      message: string;
    };

/** T28's scoring-failed codes, discriminating why a sample could not be scored. */
export type ExperimentScoringFailedCode =
  | "RULESET_UNAVAILABLE"
  | "OUTPUT_MISSING"
  | "EVALUATION_TIMEOUT"
  | "RULE_ERROR"
  | "NO_RULES";

/** T28's reconciliation codes, discriminating why a sample awaits reconciliation. */
export type ExperimentReconciliationCode =
  | "CASE_UNKNOWN"
  | "LEASE_EXPIRED"
  | "TICKET_FINISHED"
  | "TICKET_MISSING";

/** The per-sample reason, discriminated by class — the code is the contract. */
export type ExperimentSampleReason =
  | {
      class: "scored";
      passed: number;
      failed: number;
      rules: readonly ExperimentRuleScore[];
    }
  | {
      class: "in_progress";
      code: "EXECUTION_NOT_SETTLED";
      state: ExperimentExecutionState;
    }
  | { class: "execution_failed"; code: string }
  | {
      class: "scoring_failed";
      code: ExperimentScoringFailedCode;
      message?: string;
      rules?: readonly ExperimentRuleScore[];
    }
  | { class: "cancelled"; code: "CANCELLED" }
  | { class: "pending_reconciliation"; code: ExperimentReconciliationCode }
  | {
      class: "sync_failure";
      code: "CASE_RECORD_MISSING" | "CASE_RECORD_DAMAGED";
    };

export type ExperimentResultsSample = Readonly<{
  index: number;
  class: ExperimentSampleClass;
  /** The fraction of rules that passed; finite, or null unless the class is `scored`. */
  score: number | null;
  reason: ExperimentSampleReason;
  /** The case's projected usage record as plain JSON, or null when none survived. */
  usage: unknown;
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

/**
 * The safe execution record the report links back to (T23's row as the scope may read
 * it) — the "run detail" a result traces to, together with `resultLink`.
 */
export type ExperimentExecutionRecord = Readonly<{
  id: string;
  state: ExperimentExecutionState;
  errorCode: string | null;
  caseCount: number | null;
  toolRejections: number;
  experimentConfigHash: string;
  startedAt: string | null;
  settledAt: string | null;
  createdAt: string;
}>;

export type ExperimentResultsReport = Readonly<{
  experimentId: string;
  executionId: string;
  resultLink: string;
  state: ExperimentExecutionState;
  /** The scorer version the frozen configuration pinned (T22's judgeVersion). */
  scorerVersion: string | null;
  execution: ExperimentExecutionRecord;
  summary: ExperimentResultsSummary;
  samples: readonly ExperimentResultsSample[];
}>;

/**
 * The experiment configuration as the page submits it (T22's ExperimentConfigInput):
 * everything a freeze must pin, each field projected before it is stored — a secret
 * typed into any of them is refused by the projection, never frozen.
 */
export type ExperimentSubmitConfigInput = {
  /** Snapshot of the Bot's non-sensitive configuration. */
  botConfig: Record<string, unknown>;
  /** The prompt — or its version fingerprint — the evaluated runs are given. */
  prompt: string;
  /** The model the evaluated runs run on. */
  modelName: string;
  /** The model parameters: temperature and friends. */
  modelParameters: Record<string, unknown>;
  /** Tool fixtures: the structured stand-ins evaluation replays instead of live tools. */
  toolFixtures: Record<string, unknown>;
  /** The judge/scorer configuration. */
  judgeConfig: Record<string, unknown>;
  /** The judge/scorer version — the scoring code this experiment is pinned to. */
  judgeVersion: string;
  /**
   * T22's optional read-only tool whitelist. The page does not collect it (an absent
   * whitelist freezes as empty, which refuses every tool call — rule-scored pages do
   * not need one); the field stays in the contract because the freeze hashes it.
   */
  readOnlyTools?: readonly string[];
};

/** The submission body: the name, the pinned dataset version, and the configuration. */
export type ExperimentSubmitInput = {
  name: string;
  datasetVersionId: string;
  config: ExperimentSubmitConfigInput;
};

/**
 * The submission answer: what the page needs to say what froze and where to watch it
 * run. `executionId` is the run this submission started — the handle the results page
 * and the cancel write both address. `replayed` means the canonical configuration was
 * already frozen and the existing experiment answered (T22's idempotency).
 */
export type SubmittedExperimentResult = Readonly<{
  experimentId: string;
  executionId: string;
  name: string;
  datasetVersionId: string;
  datasetContentHash: string;
  configHash: string;
  replayed: boolean;
  canaryFindings: number;
}>;

/** The cancel answer: the execution settled into its cancelled terminal state. */
export type CancelledExecutionResult = Readonly<{
  executionId: string;
  state: "cancelled";
}>;
