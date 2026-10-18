import { describe, expect, test } from "bun:test";
import {
  inProgressStateIsPinned,
  sameRejectsAnyOnBothSides,
  sameRejectsAnyOnLeft,
  sameRejectsAnyOnRight,
  serverCancelledExecutionIsShared,
  serverCaseReviewOutcomeIsShared,
  serverComparisonSideIsShared,
  serverCompatibilityEntryIsShared,
  serverCompatibilityFieldIsShared,
  serverCompatibilityFieldsAreShared,
  serverDatasetListItemProjectionIsShared,
  serverDatasetSubjectProjectionIsShared,
  serverDatasetVersionProjectionIsShared,
  serverExperimentComparisonIsShared,
  serverExperimentConfigIsShared,
  serverExperimentSubmitInputIsShared,
  serverFragmentIsShared,
  serverFrozenCaseIsShared,
  serverJobIsSharedView,
  serverListItemIsShared,
  serverReconciliationCodeIsShared,
  serverRegressionRowIsShared,
  serverResultsReportIsShared,
  serverRuleScoreIsShared,
  serverSampleClassesAreShared,
  serverSampleClassIsShared,
  serverSampleDeltaIsShared,
  serverSampleReasonIsShared,
  serverSavedVersionAnswerIsShared,
  serverScoringFailedCodeIsShared,
  serverScoringFailReasonIsShared,
  serverScoringFailureCodeIsShared,
  serverSubmittedExperimentIsShared,
  serverSummaryIsSharedView,
  sharedListItemIsServer,
  sharedViewIsServerJob,
} from "./types/ai-observability-contracts";

/**
 * The admin contract's anti-drift seam (OCR m216, repaired by R2-55): the shared view
 * types and the server projections are definitions TypeScript otherwise never compares —
 * m215 was exactly the drift this file exists to catch.
 *
 * R2-55 found the original seam hollow twice over: one assertion indexed a key that does
 * not exist (`AdminSummaryResult["summary"]`), and the whole file sat outside every
 * type checker's scope — bun strips types, and server/tsconfig.json does not include
 * `tests/`. So the assertions here are now IMPORTED from `tests/types/ai-observability-
 * contracts.ts`, which tsconfig DOES include: `bun run typecheck` executes the
 * conditional types for real, and this file keeps them running under bun as well.
 * A drift in either direction now fails the type gate, and these runtime assertions
 * fail the suite.
 */

describe("the admin contract types do not drift (m216, enforced by tsc via R2-55)", () => {
  test("the server's summary satisfies the shared AdminSummaryResult (both directions)", () => {
    expect(serverSummaryIsSharedView).toBe(true);
  });

  test("the server's projected export job satisfies the shared ExportJobView", () => {
    expect(serverJobIsSharedView).toBe(true);
    expect(sharedViewIsServerJob).toBe(true);
  });

  test("the R2-40 list projection satisfies the shared ExportJobListItem", () => {
    expect(serverListItemIsShared).toBe(true);
    expect(sharedListItemIsServer).toBe(true);
  });

  test("the R2-56 datasets mirror is one definition, imported — not two spellings", () => {
    expect(serverFrozenCaseIsShared).toBe(true);
    expect(serverFragmentIsShared).toBe(true);
  });

  test("the R2-57 in_progress state stays pinned to the words the server produces", () => {
    expect(inProgressStateIsPinned).toBe(true);
  });

  test("the R4-39 experiments mirror stays one vocabulary, not two spellings", () => {
    expect(serverSampleClassesAreShared).toBe(true);
    expect(serverSampleClassIsShared).toBe(true);
    expect(serverScoringFailedCodeIsShared).toBe(true);
    expect(serverReconciliationCodeIsShared).toBe(true);
    expect(serverRuleScoreIsShared).toBe(true);
    expect(serverScoringFailReasonIsShared).toBe(true);
    expect(serverScoringFailureCodeIsShared).toBe(true);
    expect(serverSampleReasonIsShared).toBe(true);
    expect(serverResultsReportIsShared).toBe(true);
    expect(serverCompatibilityFieldsAreShared).toBe(true);
    expect(serverCompatibilityFieldIsShared).toBe(true);
    expect(serverCompatibilityEntryIsShared).toBe(true);
  });

  // R5-51: the helper itself cannot go hollow — an `any` on either side reads as
  // drift, so an anchor typed against an `any`-degenerate source is false, not
  // vacuously true.
  test("Same<> rejects `any` on either side instead of agreeing with everything (R5-51)", () => {
    expect(sameRejectsAnyOnLeft).toBe(false);
    expect(sameRejectsAnyOnRight).toBe(false);
    expect(sameRejectsAnyOnBothSides).toBe(false);
  });

  // R5-45: the case-review faces — the T20 review outcome, the save answer and
  // the dataset read projections against their shared wire shapes.
  test("the R5-45 case-review and dataset-read faces stay the shared shapes", () => {
    expect(serverCaseReviewOutcomeIsShared).toBe(true);
    expect(serverSavedVersionAnswerIsShared).toBe(true);
    expect(serverDatasetSubjectProjectionIsShared).toBe(true);
    expect(serverDatasetVersionProjectionIsShared).toBe(true);
    expect(serverDatasetListItemProjectionIsShared).toBe(true);
  });

  // R5-46: the experiment write faces — the T22 submit body both directions and
  // the submit/cancel answers against the shared result shapes.
  test("the R5-46 experiment write faces stay the shared shapes", () => {
    expect(serverExperimentConfigIsShared).toBe(true);
    expect(serverExperimentSubmitInputIsShared).toBe(true);
    expect(serverSubmittedExperimentIsShared).toBe(true);
    expect(serverCancelledExecutionIsShared).toBe(true);
  });

  // R5-52: the T29 comparison shapes whole — side, delta, regression row and the
  // top-level comparison, not only the compatibility ledger.
  test("the R5-52 comparison shapes stay the shared shapes", () => {
    expect(serverComparisonSideIsShared).toBe(true);
    expect(serverSampleDeltaIsShared).toBe(true);
    expect(serverRegressionRowIsShared).toBe(true);
    expect(serverExperimentComparisonIsShared).toBe(true);
  });
});
