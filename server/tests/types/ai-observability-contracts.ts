/*
 * The ai-observability wire contracts' TYPE-LEVEL anti-drift assertions — under tsc (R2-55).
 *
 * m216 put assertions like these inside a bun test file, and R2-55 showed what that was
 * worth: `server/tsconfig.json` does not include `tests/`, and bun strips types before
 * running, so the conditional types were never checked by anything — the file's own
 * "compile error" claim was aspirational, and one assertion (`AdminSummaryResult["summary"]`,
 * a key that does not exist) had been broken from birth without a single checker noticing.
 *
 * This file is the fix's home: `server/tsconfig.json` includes `tests/types/**`, so every
 * assertion below IS executed by `bun run typecheck`. The assertions are constants —
 * `true` when the two definitions agree — so drift in either direction turns the type
 * checker's exit code non-zero. The runtime twin (`tests/opik-admin-contract.test.ts`)
 * imports the same constants so bun keeps executing the file and the pair cannot split.
 *
 * What is pinned here:
 *   - the admin summary (server projection <-> shared AdminSummaryResult, both directions);
 *   - the export job views: the detail projection (projectJob <-> ExportJobView) and the
 *     R2-40 list projection (projectJobListItem <-> ExportJobListItem), both directions;
 *   - the R2-56 datasets mirror, where the server now imports the shared types outright
 *     (the import IS the anti-drift; these assertions pin the alias spelling too);
 *   - the R2-57 experiments mirror's known seam: the in_progress sample reason's `state`;
 *   - R4-39: the experiments mirror whole — the seven-class vocabulary, the T26 rule
 *     row and its reason words, the T28 codes and report, and the T29 compatibility
 *     ledger, each pinned both directions between the server sources and shared;
 *   - R5-45: the case-review faces — the T20 review outcome both directions, the save
 *     answer and the dataset read projections against the shared wire shapes;
 *   - R5-46: the experiment write faces — the T22 submit body both directions, the
 *     submit and cancel answers against the shared result shapes;
 *   - R5-51: the Same<> helper itself — an `any` on either side is drift, never
 *     agreement, so no anchor can go hollow the way R2-55's and R4-39's did;
 *   - R5-52: the T29 comparison shapes whole — side, delta, regression row and the
 *     top-level comparison, not only the compatibility ledger.
 */

import type {
  AdminSummaryResult,
  ExportJobListItem,
  ExportJobView,
} from "../../../shared/ai-observability-admin";
import type {
  CaseFragmentInput,
  CaseReviewOutcome,
  FrozenDatasetCase,
  ObservationDatasetDetailResult,
  ObservationDatasetListItem,
  ObservationDatasetVersionItem,
  SavedDatasetVersionResult,
} from "../../../shared/ai-observability-datasets";
import type {
  CancelledExecutionResult,
  EXPERIMENT_COMPATIBILITY_FIELDS,
  EXPERIMENT_SAMPLE_CLASSES,
  ExperimentComparison,
  ExperimentComparisonSide,
  ExperimentCompatibilityEntry,
  ExperimentCompatibilityField,
  ExperimentReconciliationCode,
  ExperimentRegressionRow,
  ExperimentResultsReport,
  ExperimentRuleErrorCode,
  ExperimentRuleFailReason,
  ExperimentRuleScore,
  ExperimentSampleClass,
  ExperimentSampleDelta,
  ExperimentSampleReason,
  ExperimentScoringFailedCode,
  ExperimentSubmitConfigInput,
  ExperimentSubmitInput,
  SubmittedExperimentResult,
} from "../../../shared/ai-observability-experiments";
import type { AdminSummary } from "../../src/ai-observability/admin-summary";
import type {
  CaseFragment,
  CaseReviewOutcome as ServerCaseReviewOutcome,
} from "../../src/ai-observability/case-review";
import type {
  COMPATIBILITY_FIELDS,
  ComparisonSide,
  CompatibilityEntry,
  CompatibilityField,
  RegressionRow,
  SampleDelta,
  ExperimentComparison as ServerExperimentComparison,
} from "../../src/ai-observability/comparison";
import type {
  ObservationDataset,
  ObservationDatasetVersion,
  FrozenDatasetCase as ServerFrozenDatasetCase,
} from "../../src/ai-observability/datasets";
import type { ObservationExecution } from "../../src/ai-observability/executions";
import type {
  ExperimentConfigInput,
  ObservationExperiment,
  SaveExperimentInput,
} from "../../src/ai-observability/experiments";
import type {
  ReconciliationCode,
  SAMPLE_CLASSES,
  SampleClass,
  SampleReason,
  ScoringFailedCode,
  ExperimentResultsReport as ServerExperimentResultsReport,
} from "../../src/ai-observability/results";
import type {
  projectJob,
  projectJobListItem,
} from "../../src/ai-observability/routes/exports";
import type {
  RuleScore,
  ScoringFailReason,
  ScoringFailureCode,
} from "../../src/ai-observability/scoring/rules";

/**
 * True only when A is the `any` type. `1 & any` is `any`, and everything extends
 * `any`, so the probe `0 extends 1 & A` fires exactly for `any` — for every other
 * type `1 & A` is a concrete intersection `0` does not extend. This is the guard
 * that keeps the anchor below from going hollow (R5-51).
 */
type IsAny<A> = 0 extends 1 & A ? true : false;

/**
 * True only when A and B are mutually assignable — the same shape, by either direction
 * — AND neither side is `any`. An `any` on either side is drift by definition: it can
 * absorb every shape, so mutual assignability proves nothing (R5-51).
 *
 * The checks are tuple-wrapped on purpose: a naked `A extends B` distributes over a
 * union A, so a pin over two vocabularies that drifted degrades to `boolean` (some
 * members yes, some no) instead of `false` — the assignment of `true` still checks
 * and the pin goes hollow. R4-39 proved this on the class-union pin: one changed
 * word fired only the tuple pins until the wrap was added. Wrapping in a 1-tuple
 * (which is covariant, so `[A] extends [B]` iff `A extends B`) pins the WHOLE union
 * against the WHOLE union — every word, or the pin is false.
 */
type Same<A, B> =
  IsAny<A> extends true
    ? false
    : IsAny<B> extends true
      ? false
      : [A] extends [B]
        ? [B] extends [A]
          ? true
          : false
        : false;

// ---------------------------------------------------------------------------
// R5-51: `any` is drift, never agreement. `[any] extends [B]` and
// `[B] extends [any]` are BOTH true for every B, so the tuple-wrapped Same above
// answers `true` the moment either side degenerates to `any` — an anchor written
// against an `any`-typed source was vacuously green (R2-55's broken assertion and
// R4-39's union wrap were the earlier two hollow-anchor modes; this is the third).
// These pins say what the honest answer is: any on either side is `false`.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: the probe IS any — the pin exists to prove Same reads it as drift
export type SameRejectsAnyOnLeft = Same<any, { readonly pinned: "word" }>;
// biome-ignore lint/suspicious/noExplicitAny: the probe IS any — the pin exists to prove Same reads it as drift
export type SameRejectsAnyOnRight = Same<{ readonly pinned: "word" }, any>;
// biome-ignore lint/suspicious/noExplicitAny: the probes ARE any — the pin exists to prove Same reads them as drift
export type SameRejectsAnyOnBothSides = Same<any, any>;

// ---------------------------------------------------------------------------
// The admin summary (m216's original seam, fixed per R2-55: the real keys).
// ---------------------------------------------------------------------------

/** The server's summary IS the shared answer, field for field. */
export type ServerSummaryIsSharedView = Same<AdminSummary, AdminSummaryResult>;

// ---------------------------------------------------------------------------
// The export jobs: the detail projection and the R2-40 list projection.
// ---------------------------------------------------------------------------

/** True only when the server's projected job (detail) IS the shared wire view. */
export type ServerJobIsSharedView = Same<
  ReturnType<typeof projectJob>,
  ExportJobView
>;

/** True only when the server's projected job (list) IS the shared list item. */
export type ServerListItemIsShared = Same<
  ReturnType<typeof projectJobListItem>,
  ExportJobListItem
>;

// Opposite directions too: the shared views must not be narrower than the server's
// projections, or the browser would silently drop fields the server answers with.
export type SharedViewIsServerJob =
  ExportJobView extends Partial<ReturnType<typeof projectJob>> ? true : false;
export type SharedListItemIsServer =
  ExportJobListItem extends Partial<ReturnType<typeof projectJobListItem>>
    ? true
    : false;

// ---------------------------------------------------------------------------
// R2-56: the datasets mirror. The server imports the shared types outright, so
// these assert the server-side aliases are exactly the shared spellings.
// ---------------------------------------------------------------------------

export type ServerFrozenCaseIsShared = Same<
  ServerFrozenDatasetCase,
  FrozenDatasetCase
>;
export type ServerFragmentIsShared = Same<CaseFragment, CaseFragmentInput>;

// ---------------------------------------------------------------------------
// R2-57: the experiments mirror's pinned seam. The server's results service is
// the producer; shared is narrowed to match it. Both in_progress `state` fields
// must stay the same two words, or the page can render a state upstream never says.
// ---------------------------------------------------------------------------

type ServerInProgressState = Extract<
  SampleReason,
  { class: "in_progress" }
>["state"];
type SharedInProgressState = Extract<
  ExperimentSampleReason,
  { class: "in_progress" }
>["state"];

export type InProgressStateIsPinned = Same<
  ServerInProgressState,
  SharedInProgressState
>;

// ---------------------------------------------------------------------------
// R4-39: the experiments mirror, whole. results.ts (the T28 producer),
// scoring/rules.ts (the T26 vocabulary) and comparison.ts (the T29 ledger) each
// hand-draw the words the shared contract names; every one is pinned here, both
// directions, so the shared file header's "the pages cannot drift" promise is a
// type-checked fact and not a comment. The class/field tuples pin display order
// too — both sides declare the order is display order, so a reordering is drift.
// ---------------------------------------------------------------------------

/** The seven-class vocabulary: the tuple (order included) and the member union. */
export type ServerSampleClassesAreShared = Same<
  typeof SAMPLE_CLASSES,
  typeof EXPERIMENT_SAMPLE_CLASSES
>;
export type ServerSampleClassIsShared = Same<
  SampleClass,
  ExperimentSampleClass
>;

/** T28's scoring-failed and reconciliation codes, word for word. */
export type ServerScoringFailedCodeIsShared = Same<
  ScoringFailedCode,
  ExperimentScoringFailedCode
>;
export type ServerReconciliationCodeIsShared = Same<
  ReconciliationCode,
  ExperimentReconciliationCode
>;

/** T26's rule row and its two closed reason vocabularies (failed words, error codes). */
export type ServerRuleScoreIsShared = Same<RuleScore, ExperimentRuleScore>;
export type ServerScoringFailReasonIsShared = Same<
  ScoringFailReason,
  ExperimentRuleFailReason
>;
export type ServerScoringFailureCodeIsShared = Same<
  ScoringFailureCode,
  ExperimentRuleErrorCode
>;

/** The whole per-sample reason — the discriminated union the results rows speak. */
export type ServerSampleReasonIsShared = Same<
  SampleReason,
  ExperimentSampleReason
>;

/** The T28 report itself, field for field — the shared header's headline promise. */
export type ServerResultsReportIsShared = Same<
  ServerExperimentResultsReport,
  ExperimentResultsReport
>;

/** T29's compatibility ledger: the field tuple (order included), member type, entry. */
export type ServerCompatibilityFieldsAreShared = Same<
  typeof COMPATIBILITY_FIELDS,
  typeof EXPERIMENT_COMPATIBILITY_FIELDS
>;
export type ServerCompatibilityFieldIsShared = Same<
  CompatibilityField,
  ExperimentCompatibilityField
>;
export type ServerCompatibilityEntryIsShared = Same<
  CompatibilityEntry,
  ExperimentCompatibilityEntry
>;

// ---------------------------------------------------------------------------
// R5-45: the case-review and dataset-read faces. The T20 service's review
// outcome is a named server type, pinned both directions outright. The save
// answer and the read projections are inline literals in
// server/src/ai-observability/routes/{case-review,datasets}.ts, so their
// mirrors here are drawn field-by-field from the T19/T20 store row types those
// literals read: the row supplies each carried field's type, the mirror fixes
// the shape, and shared must stay that shape or the pin goes false. The
// derived fields (timestamps, the case count) are marked — a route that stops
// deriving them the same way needs this mirror re-checked by hand. Annotating
// the routes themselves (the R2-56 import closure) stays a server-src ticket.
// ---------------------------------------------------------------------------

/** The T20 review outcome: the service's own answer IS the shared contract. */
export type ServerCaseReviewOutcomeIsShared = Same<
  ServerCaseReviewOutcome,
  CaseReviewOutcome
>;

/** The save answer's flat projection, field for field as routes/case-review.ts builds it. */
type ServerSavedVersionAnswer = {
  datasetId: ObservationDataset["id"];
  datasetName: ObservationDataset["name"];
  version: {
    id: ObservationDatasetVersion["id"];
    contentHash: ObservationDatasetVersion["contentHash"];
    redactionPolicyVersion: ObservationDatasetVersion["redactionPolicyVersion"];
    /** Derived: `version.cases.length`. */
    caseCount: number;
    /** Derived: `version.createdAt.toISOString()`. */
    createdAt: string;
  };
  replayed: boolean;
  canaryFindings: number;
};
export type ServerSavedVersionAnswerIsShared = Same<
  ServerSavedVersionAnswer,
  SavedDatasetVersionResult
>;

/** `projectDatasetSubject` — the detail page's dataset sub-shape, field for field. */
type ServerDatasetSubjectProjection = {
  id: ObservationDataset["id"];
  name: ObservationDataset["name"];
  syncState: ObservationDataset["syncState"];
  /** Derived: `createdAt.toISOString()`. */
  createdAt: string;
  /** Derived: `updatedAt.toISOString()`. */
  updatedAt: string;
};
export type ServerDatasetSubjectProjectionIsShared = Same<
  ServerDatasetSubjectProjection,
  ObservationDatasetDetailResult["dataset"]
>;

/** `projectDatasetVersion` — one history row, field for field. */
type ServerDatasetVersionProjection = {
  id: ObservationDatasetVersion["id"];
  datasetId: ObservationDatasetVersion["datasetId"];
  contentHash: ObservationDatasetVersion["contentHash"];
  redactionPolicyVersion: ObservationDatasetVersion["redactionPolicyVersion"];
  /** Derived: `version.cases.length`. */
  caseCount: number;
  /** Derived: `version.createdAt.toISOString()`. */
  createdAt: string;
};
export type ServerDatasetVersionProjectionIsShared = Same<
  ServerDatasetVersionProjection,
  ObservationDatasetVersionItem
>;

/** The list face's row projection (routes/datasets.ts GET /), field for field. */
type ServerDatasetListItemProjection = {
  id: ObservationDataset["id"];
  name: ObservationDataset["name"];
  syncState: ObservationDataset["syncState"];
  /** Derived: `createdAt.toISOString()`. */
  createdAt: string;
  /** Derived: `updatedAt.toISOString()`. */
  updatedAt: string;
  /** The store's aggregate, passed through. */
  versionCount: number;
  /** Derived: `latestVersionAt?.toISOString() ?? null`. */
  latestVersionAt: string | null;
};
export type ServerDatasetListItemProjectionIsShared = Same<
  ServerDatasetListItemProjection,
  ObservationDatasetListItem
>;

// ---------------------------------------------------------------------------
// R5-46: the experiment write faces. The T22 frozen submission's input types
// are pinned against the shared submit body, both directions; the submit and
// cancel answers are inline literals in routes/experiments.ts, mirrored
// field-by-field from the row types those literals read (same discipline and
// same caveats as the R5-45 block above).
// ---------------------------------------------------------------------------

/** The configuration a freeze pins: the server's input IS the shared body. */
export type ServerExperimentConfigIsShared = Same<
  ExperimentConfigInput,
  ExperimentSubmitConfigInput
>;
export type ServerExperimentSubmitInputIsShared = Same<
  SaveExperimentInput,
  ExperimentSubmitInput
>;

/** The submit answer, field for field as routes/experiments.ts builds it. */
type ServerSubmittedExperimentAnswer = {
  experimentId: ObservationExperiment["id"];
  executionId: ObservationExecution["id"];
  name: ObservationExperiment["name"];
  datasetVersionId: ObservationExperiment["datasetVersionId"];
  datasetContentHash: ObservationExperiment["datasetContentHash"];
  configHash: ObservationExperiment["configHash"];
  /** The submit service's idempotency verdict, passed through. */
  replayed: boolean;
  /** The freeze pipeline's canary count, passed through. */
  canaryFindings: number;
};
export type ServerSubmittedExperimentIsShared = Same<
  ServerSubmittedExperimentAnswer,
  SubmittedExperimentResult
>;

/** The cancel answer, field for field. */
type ServerCancelledExecutionAnswer = {
  executionId: ObservationExecution["id"];
  state: "cancelled";
};
export type ServerCancelledExecutionIsShared = Same<
  ServerCancelledExecutionAnswer,
  CancelledExecutionResult
>;

// ---------------------------------------------------------------------------
// R5-52: the T29 comparison shapes, whole. comparison.ts hand-draws four shapes
// the shared contract names — side, per-sample delta, regression row and the
// top-level comparison — and only the ledger entry was anchored before, so a
// drift in the other three degraded the page to its unavailable state silently
// (the runtime guard catches bad VALUES, never a renamed or reshaped wire field).
// Each is pinned both directions here.
// ---------------------------------------------------------------------------

export type ServerComparisonSideIsShared = Same<
  ComparisonSide,
  ExperimentComparisonSide
>;
export type ServerSampleDeltaIsShared = Same<
  SampleDelta,
  ExperimentSampleDelta
>;
export type ServerRegressionRowIsShared = Same<
  RegressionRow,
  ExperimentRegressionRow
>;
export type ServerExperimentComparisonIsShared = Same<
  ServerExperimentComparison,
  ExperimentComparison
>;

// ---------------------------------------------------------------------------
// The constants the type checker (and the runtime twin) actually evaluate.
// ---------------------------------------------------------------------------

export const serverSummaryIsSharedView: ServerSummaryIsSharedView = true;
export const serverJobIsSharedView: ServerJobIsSharedView = true;
export const serverListItemIsShared: ServerListItemIsShared = true;
export const sharedViewIsServerJob: SharedViewIsServerJob = true;
export const sharedListItemIsServer: SharedListItemIsServer = true;
export const serverFrozenCaseIsShared: ServerFrozenCaseIsShared = true;
export const serverFragmentIsShared: ServerFragmentIsShared = true;
export const inProgressStateIsPinned: InProgressStateIsPinned = true;
export const serverSampleClassesAreShared: ServerSampleClassesAreShared = true;
export const serverSampleClassIsShared: ServerSampleClassIsShared = true;
export const serverScoringFailedCodeIsShared: ServerScoringFailedCodeIsShared = true;
export const serverReconciliationCodeIsShared: ServerReconciliationCodeIsShared = true;
export const serverRuleScoreIsShared: ServerRuleScoreIsShared = true;
export const serverScoringFailReasonIsShared: ServerScoringFailReasonIsShared = true;
export const serverScoringFailureCodeIsShared: ServerScoringFailureCodeIsShared = true;
export const serverSampleReasonIsShared: ServerSampleReasonIsShared = true;
export const serverResultsReportIsShared: ServerResultsReportIsShared = true;
export const serverCompatibilityFieldsAreShared: ServerCompatibilityFieldsAreShared = true;
export const serverCompatibilityFieldIsShared: ServerCompatibilityFieldIsShared = true;
export const serverCompatibilityEntryIsShared: ServerCompatibilityEntryIsShared = true;
export const sameRejectsAnyOnLeft: SameRejectsAnyOnLeft = false;
export const sameRejectsAnyOnRight: SameRejectsAnyOnRight = false;
export const sameRejectsAnyOnBothSides: SameRejectsAnyOnBothSides = false;
export const serverCaseReviewOutcomeIsShared: ServerCaseReviewOutcomeIsShared = true;
export const serverSavedVersionAnswerIsShared: ServerSavedVersionAnswerIsShared = true;
export const serverDatasetSubjectProjectionIsShared: ServerDatasetSubjectProjectionIsShared = true;
export const serverDatasetVersionProjectionIsShared: ServerDatasetVersionProjectionIsShared = true;
export const serverDatasetListItemProjectionIsShared: ServerDatasetListItemProjectionIsShared = true;
export const serverExperimentConfigIsShared: ServerExperimentConfigIsShared = true;
export const serverExperimentSubmitInputIsShared: ServerExperimentSubmitInputIsShared = true;
export const serverSubmittedExperimentIsShared: ServerSubmittedExperimentIsShared = true;
export const serverCancelledExecutionIsShared: ServerCancelledExecutionIsShared = true;
export const serverComparisonSideIsShared: ServerComparisonSideIsShared = true;
export const serverSampleDeltaIsShared: ServerSampleDeltaIsShared = true;
export const serverRegressionRowIsShared: ServerRegressionRowIsShared = true;
export const serverExperimentComparisonIsShared: ServerExperimentComparisonIsShared = true;
