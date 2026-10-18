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
 *     ledger, each pinned both directions between the server sources and shared.
 */

import type {
  AdminSummaryResult,
  ExportJobListItem,
  ExportJobView,
} from "../../../shared/ai-observability-admin";
import type {
  CaseFragmentInput,
  FrozenDatasetCase,
} from "../../../shared/ai-observability-datasets";
import type {
  EXPERIMENT_COMPATIBILITY_FIELDS,
  EXPERIMENT_SAMPLE_CLASSES,
  ExperimentCompatibilityEntry,
  ExperimentCompatibilityField,
  ExperimentReconciliationCode,
  ExperimentResultsReport,
  ExperimentRuleErrorCode,
  ExperimentRuleFailReason,
  ExperimentRuleScore,
  ExperimentSampleClass,
  ExperimentSampleReason,
  ExperimentScoringFailedCode,
} from "../../../shared/ai-observability-experiments";
import type { AdminSummary } from "../../src/ai-observability/admin-summary";
import type { CaseFragment } from "../../src/ai-observability/case-review";
import type {
  COMPATIBILITY_FIELDS,
  CompatibilityEntry,
  CompatibilityField,
} from "../../src/ai-observability/comparison";
import type { FrozenDatasetCase as ServerFrozenDatasetCase } from "../../src/ai-observability/datasets";
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
 * True only when A and B are mutually assignable — the same shape, by either direction.
 *
 * The checks are tuple-wrapped on purpose: a naked `A extends B` distributes over a
 * union A, so a pin over two vocabularies that drifted degrades to `boolean` (some
 * members yes, some no) instead of `false` — the assignment of `true` still checks
 * and the pin goes hollow. R4-39 proved this on the class-union pin: one changed
 * word fired only the tuple pins until the wrap was added. Wrapping in a 1-tuple
 * (which is covariant, so `[A] extends [B]` iff `A extends B`) pins the WHOLE union
 * against the WHOLE union — every word, or the pin is false.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

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
