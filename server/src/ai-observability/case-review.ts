/**
 * The case review and save service (Issue #26 / DAG T20).
 *
 * A dataset case is distilled, not harvested: the creator reads one observed run through the
 * T11 query surface, selects the fragments worth evaluating, and writes the reference output
 * the evaluated run will be scored against. This service is the seam that review passes
 * through. Its two operations share one discipline — ownership first, projection always,
 * audit last:
 *
 *   Ownership first: the source run must be one the trusted scope bound (T07's
 *   `latestAttempt`, exactly T11's detail seam). A guessed run id under the wrong scope is
 *   simply not found — before any projection, before any audit row, before any freeze. The
 *   provenance that rides into the frozen version (run, attempt, binding) is read from that
 *   binding, never accepted from the caller: a fragment claiming another attempt of the run
 *   is refused, because provenance the reviewer did not observe is forged, not curated.
 *
 *   Projection always: every fragment is projected through the T05 pipeline before anything
 *   else sees it. The review's answer carries the projection preview — including how many
 *   cases the deny patterns refused — and the save delegates to T19's freeze, which projects
 *   once more anyway. No path here can freeze a credential into an evaluation dataset, even
 *   if a caller claims the content is safe.
 *
 *   Audit last: the review decision and the saved version each leave one audit row carrying
 *   attribution (actor, person initiator) and the database's own timestamp. The row holds
 *   references and counts, never case content; a reviewer's note is the one free-text corner
 *   and it is projected before it is recorded, so a secret typed into a note is refused, not
 *   echoed.
 */

import type { SafeValue } from "../../../shared/ai-observability";
import type { CaseFragmentInput } from "../../../shared/ai-observability-datasets";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { RunBindingStore } from "./bindings";
import type { ObservationScope } from "./contracts";
import type {
  DatasetCaseInput,
  FrozenDatasetCase,
  ObservationDataset,
  ObservationDatasetStore,
  ObservationDatasetVersion,
} from "./datasets";
import { freezeCases, MAX_DATASET_CASES } from "./datasets";
import { projectSafeText } from "./redaction";
import { assertObservationScope } from "./scope";

export type CaseReviewErrorCode =
  | "CASE_REVIEW_INPUT_INVALID"
  | "CASE_REVIEW_RUN_NOT_FOUND";

export class CaseReviewError extends Error {
  constructor(
    public code: CaseReviewErrorCode,
    public status: 400 | 404,
  ) {
    super(code);
  }
}

/**
 * One fragment the reviewer selected from the observed run's record. R2-56: the shared
 * contract's own type, aliased under the server's historical spelling — one definition,
 * shared/ai-observability-datasets.ts, so this file and the browser cannot drift.
 */
export type CaseFragment = CaseFragmentInput;

export type CaseReviewDecision = "approved" | "rejected";

export type ReviewCasesInput = {
  runId: string;
  decision: CaseReviewDecision;
  cases: readonly CaseFragment[];
  /** Why, in the reviewer's own words. Projected before it is recorded. */
  note?: string;
};

export type CaseReviewOutcome = Readonly<{
  decision: CaseReviewDecision;
  runId: string;
  attemptId: string;
  bindingId: string;
  /** Exactly what a save of these cases would freeze: the projected preview. */
  preview: readonly FrozenDatasetCase[];
  /** How many cases the redaction policy refused outright — the canary count. */
  canaryFindings: number;
}>;

export type SaveReviewedInput = {
  datasetName: string;
  runId: string;
  cases: readonly CaseFragment[];
};

export type SavedDatasetVersion = Readonly<{
  dataset: ObservationDataset;
  version: ObservationDatasetVersion;
  replayed: boolean;
  canaryFindings: number;
}>;

export type CaseReviewServiceDeps = Readonly<{
  /** T07's authoritative ownership seam: a run this scope did not bind is not found. */
  bindings: Pick<RunBindingStore, "latestAttempt">;
  /** The T19 freeze pipeline; saving is its job, this service only reaches it. */
  datasets: Pick<ObservationDatasetStore, "saveVersion">;
  /** The audit seam every review action is recorded through. */
  audit: Pick<AuditStore, "insert">;
}>;

export type CaseReviewService = Readonly<{
  /**
   * Record a review decision over fragments selected from one observed run. The audit row is
   * the review record — attribution and time are its columns, not a separate table.
   */
  review(
    scope: ObservationScope,
    input: ReviewCasesInput,
  ): Promise<CaseReviewOutcome>;
  /**
   * Freeze the reviewed fragments as one immutable dataset version, through T19's freeze
   * pipeline: projected content, canonical hash, idempotent (scope, dataset, hash) version
   * key. Saving the same selection again hits the same version.
   */
  saveReviewed(
    scope: ObservationScope,
    input: SaveReviewedInput,
  ): Promise<SavedDatasetVersion>;
}>;

/** A non-empty opaque reference; empty or whitespace-only is refused before any query. */
function reference(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CaseReviewError("CASE_REVIEW_INPUT_INVALID", 400);
  }
  return value;
}

/**
 * How many cases the deny patterns refused outright — the canary the reviewer must see.
 * The unit is the case: one with any refused field still counts once, because the
 * number answers "how many of my cases came back damaged", not "how many fields"
 * (OCR m107: the toolFixtures projection is a SafeValue too — an omitted fixture
 * node, top-level or deep, is exactly the damage the count exists to surface).
 * OCR R3-31: a truncated node is the same damage, so it counts the same — a
 * >8KiB text leaf or an oversized record value freezes as { state: "truncated" }
 * with no omission anywhere, and the dataset would not hold what the reviewer
 * saw. Alignment with this function's own comment and the m107 declaration.
 */
function countCanaryFindings(frozen: readonly FrozenDatasetCase[]): number {
  // The fixtures tree carries SafeValue nodes at every level: an omitted leaf
  // (deny-refused, past the depth cap) or a truncated node (past the byte cap)
  // is the damage the count exists to surface, wherever it sits.
  const valueHasOmission = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(valueHasOmission);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.state === "omitted" || record.state === "truncated")
        return true;
      return Object.values(record).some(valueHasOmission);
    }
    return false;
  };
  const fixturesOmitted = (fixtures: SafeValue): boolean =>
    fixtures.state === "omitted" ||
    fixtures.state === "truncated" ||
    (fixtures.state === "projected" && valueHasOmission(fixtures.value));
  return frozen.filter(
    (one) =>
      one.safeInput.state !== "projected" ||
      one.referenceOutput.state !== "projected" ||
      fixturesOmitted(one.toolFixtures),
  ).length;
}

export function createCaseReviewService(
  deps: CaseReviewServiceDeps,
): CaseReviewService {
  /**
   * The shared half of review and save: validate the fragments (before any query), answer
   * the ownership question from the binding table, and hand back the freeze-ready cases
   * with their projection. A run the scope did not bind throws RUN_NOT_FOUND before
   * anything else happens — no preview, no audit row, no freeze.
   */
  const assemble = async (
    scope: ObservationScope,
    runId: string,
    fragments: readonly CaseFragment[],
  ) => {
    reference(runId);
    if (
      !Array.isArray(fragments) ||
      fragments.length === 0 ||
      fragments.length > MAX_DATASET_CASES
    ) {
      throw new CaseReviewError("CASE_REVIEW_INPUT_INVALID", 400);
    }
    for (const one of fragments) {
      reference(one.input);
      reference(one.referenceOutput);
      if (one.attemptId !== undefined) reference(one.attemptId);
      if (
        typeof one.toolFixtures !== "object" ||
        one.toolFixtures === null ||
        Array.isArray(one.toolFixtures)
      ) {
        throw new CaseReviewError("CASE_REVIEW_INPUT_INVALID", 400);
      }
    }

    const binding = await deps.bindings.latestAttempt(scope, runId);
    if (binding === null) {
      throw new CaseReviewError("CASE_REVIEW_RUN_NOT_FOUND", 404);
    }

    const cases: DatasetCaseInput[] = fragments.map((one) => {
      // Provenance is read from the binding, never trusted from the caller: a fragment
      // claiming a different attempt of the run is forged, not curated.
      const attemptId =
        one.attemptId === undefined ? binding.attemptId : one.attemptId;
      if (attemptId !== binding.attemptId) {
        throw new CaseReviewError("CASE_REVIEW_INPUT_INVALID", 400);
      }
      return {
        input: one.input,
        referenceOutput: one.referenceOutput,
        toolFixtures: one.toolFixtures,
        sourceRunId: runId,
        sourceAttemptId: attemptId,
        sourceBindingId: binding.id,
      };
    });

    const frozen = freezeCases(cases);
    return {
      binding,
      cases,
      frozen,
      canaryFindings: countCanaryFindings(frozen),
    };
  };

  return {
    async review(scope, input) {
      assertObservationScope(scope);
      if (input.decision !== "approved" && input.decision !== "rejected") {
        throw new CaseReviewError("CASE_REVIEW_INPUT_INVALID", 400);
      }
      if (input.note !== undefined && typeof input.note !== "string") {
        throw new CaseReviewError("CASE_REVIEW_INPUT_INVALID", 400);
      }
      const assembled = await assemble(scope, input.runId, input.cases);

      // The note is the one free-text corner of the audit payload, so it is projected
      // before it is recorded: a secret typed into a rejection note is refused, not
      // echoed into a trail that is append-only forever.
      const payload: Record<string, unknown> = {
        decision: input.decision,
        runId: input.runId,
        attemptId: assembled.binding.attemptId,
        bindingId: assembled.binding.id,
        cases: assembled.cases.length,
        canaryFindings: assembled.canaryFindings,
      };
      if (input.note !== undefined && input.note.trim() !== "") {
        payload.note = projectSafeText(input.note, { allowFreeText: true });
      }
      await recordAuditEvent(deps.audit, {
        eventType: "opik.case_reviewed",
        targetType: "ai_observation_run",
        targetId: input.runId,
        actorUserId: scope.actorId,
        payload,
      });

      return {
        decision: input.decision,
        runId: input.runId,
        attemptId: assembled.binding.attemptId,
        bindingId: assembled.binding.id,
        preview: assembled.frozen,
        canaryFindings: assembled.canaryFindings,
      };
    },

    async saveReviewed(scope, input) {
      assertObservationScope(scope);
      // The name is checked before anything is read: an empty one is a 400, not a paid
      // assemble over the ownership lookup and all 200 case projections.
      const datasetName = reference(input.datasetName);
      const assembled = await assemble(scope, input.runId, input.cases);

      const saved = await deps.datasets.saveVersion(scope, {
        datasetName,
        cases: assembled.cases,
      });

      // The audit row follows the freeze, and deliberately so: it records what the
      // database now holds, including whether this save replayed an existing version.
      // If the insert fails the version is still frozen — correctly, immutably — and
      // the replay of this call hits the same version and writes the missing row.
      await recordAuditEvent(deps.audit, {
        eventType: "opik.dataset_version_saved",
        targetType: "ai_observation_dataset",
        targetId: saved.dataset.id,
        actorUserId: scope.actorId,
        payload: {
          datasetId: saved.dataset.id,
          datasetName: saved.dataset.name,
          versionId: saved.version.id,
          contentHash: saved.version.contentHash,
          cases: assembled.cases.length,
          canaryFindings: assembled.canaryFindings,
          replayed: saved.replayed,
          runId: input.runId,
          bindingId: assembled.binding.id,
        },
      });

      return { ...saved, canaryFindings: assembled.canaryFindings };
    },
  };
}
