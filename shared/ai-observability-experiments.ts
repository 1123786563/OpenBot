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
 * The two write faces are mounted (server/src/ai-observability/routes/experiments.ts,
 * inside createAiObservabilityRoutes): submitting an experiment starts its execution
 * in one POST (the audited freeze and the billing-gated start under one request, the
 * freeze idempotent on the frozen-configuration key), and canceling settles a
 * not-yet-terminal execution. The shapes here are the contract those routes answer
 * and the pages consume — the same discipline T18 applied to the steps contract:
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
 *
 * The comparison read is T29's already-mounted face (Issue #37 / DAG T31 pins it here
 * for the page): the comparison spans two experiments, so the four ids arrive as query
 * parameters and nothing else:
 *
 *   GET /api/ai-observability/bots/:botId/experiment-comparisons
 *     ?baselineExperimentId&baselineExecutionId&candidateExperimentId&candidateExecutionId
 *     → 200 ExperimentComparison | 4xx { error }
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
      /**
       * R2-57: the words the server actually produces (results.ts narrows an
       * unsettled execution to exactly these two — a settled execution lands in
       * a terminal class, never here). The five-word execution-state vocabulary
       * was wider than the truth and is narrowed to match the producer; the
       * anti-drift assertion in server/tests/types pins both sides to each other.
       */
      state: "pending" | "running";
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
  /**
   * The case's projected judge record (T27) as plain JSON, or null when no judge
   * answered for this case. A scoring fact beside the rule score — its own status
   * (`scored` with a 0..1 score and rationale, or `failed` with a JUDGE_* code) —
   * never a number averaged into `score`. Contract gap closed by the T-routes
   * ticket: the server has answered this field since T27-rn.
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

/**
 * The frozen fields the comparison's ledger names, in display order (T29's
 * COMPATIBILITY_FIELDS). The first three block the verdict — a different sample set or
 * scoring definition refuses to rank; the rest are the configuration being compared,
 * shown with their difference, never blocking.
 */
export const EXPERIMENT_COMPATIBILITY_FIELDS = [
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

export type ExperimentCompatibilityField =
  (typeof EXPERIMENT_COMPATIBILITY_FIELDS)[number];

/** One ledger row: each side's compact witness (text, a JSON list, or sha256:…). */
export type ExperimentCompatibilityEntry = Readonly<{
  field: ExperimentCompatibilityField;
  baseline: string | null;
  candidate: string | null;
  equal: boolean;
  /** True when a difference on this field refuses the comparison. */
  blocking: boolean;
}>;

/** One side's own facts: the T28 report verbatim plus the comparison's derived ledgers. */
export type ExperimentComparisonSide = Readonly<{
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

/** One frozen case's per-sample verdict — the closed four-word direction vocabulary. */
export type ExperimentSampleDelta = Readonly<{
  index: number;
  baseline: Readonly<{
    class: ExperimentSampleClass;
    score: number | null;
  }>;
  candidate: Readonly<{
    class: ExperimentSampleClass;
    score: number | null;
  }>;
  /** Finite only when both sides scored; a missing score never masquerades as a 0. */
  scoreDelta: number | null;
  /**
   * The closed four-word verdict. Non-terminal classes on either side keep
   * `incomparable` — an open settlement is never a regressed or improved fact.
   */
  direction: "regressed" | "improved" | "unchanged" | "incomparable";
}>;

/** A regressed sample: the frozen case plus both sides' classes, codes and result links. */
export type ExperimentRegressionRow = Readonly<{
  index: number;
  /** The frozen case both sides evaluated (the shared content hash names its content). */
  case: Readonly<{ datasetVersionId: string; contentHash: string }>;
  baseline: Readonly<{
    class: ExperimentSampleClass;
    score: number | null;
    /** The T28 reason code; null when scored — the class already says everything. */
    code: string | null;
    resultLink: string;
  }>;
  candidate: Readonly<{
    class: ExperimentSampleClass;
    score: number | null;
    code: string | null;
    resultLink: string;
  }>;
}>;

/**
 * The whole comparison (T29's ExperimentComparison). Null when incompatible — no
 * deltas, no regressions, no winner across different cases or scorers; the field ledger
 * and both sides' own facts still arrive.
 */
export type ExperimentComparison = Readonly<{
  baseline: ExperimentComparisonSide;
  candidate: ExperimentComparisonSide;
  compatibility: Readonly<{
    compatible: boolean;
    fields: readonly ExperimentCompatibilityEntry[];
  }>;
  deltas: Readonly<{
    meanScore: Readonly<{
      baseline: number | null;
      candidate: number | null;
      delta: number | null;
    }>;
    perSample: readonly ExperimentSampleDelta[];
  }> | null;
  /** Null when incompatible; the regressed samples otherwise, possibly none. */
  regressions: readonly ExperimentRegressionRow[] | null;
}>;
