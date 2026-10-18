import { describe, expect, test } from "bun:test";
import {
  inProgressStateIsPinned,
  serverCompatibilityEntryIsShared,
  serverCompatibilityFieldIsShared,
  serverCompatibilityFieldsAreShared,
  serverFragmentIsShared,
  serverFrozenCaseIsShared,
  serverJobIsSharedView,
  serverListItemIsShared,
  serverReconciliationCodeIsShared,
  serverResultsReportIsShared,
  serverRuleScoreIsShared,
  serverSampleClassesAreShared,
  serverSampleClassIsShared,
  serverSampleReasonIsShared,
  serverScoringFailedCodeIsShared,
  serverScoringFailReasonIsShared,
  serverScoringFailureCodeIsShared,
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
});
