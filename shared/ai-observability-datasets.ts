/**
 * The wire contract of the creator's dataset surfaces (Issue #27 list/detail, over the T19
 * store; Issue #26 review/save, through the T20 service).
 *
 * This file is the ONE place the datasets contract is defined, beside the runs contract in
 * `shared/ai-observability-runs.ts`: the browser renders these shapes, and the wiring ticket
 * (T33) answers them. The backend endpoints do not exist yet on purpose — the mounting seam
 * is integration-owned — so until T33 wires the routes, this file is the agreement the
 * frontend is built against and the tests mock. Two mirror rules keep it honest:
 *
 *   - `FrozenDatasetCase` and `CaseReviewOutcome` are byte-for-byte the shapes
 *     server/src/ai-observability/{datasets,case-review}.ts already export. A change there
 *     is a change here, first.
 *   - The read shapes (`ObservationDatasetListItem`, `ObservationDatasetVersionItem`) and the
 *     save result are *projections* of the T19/T20 rows, not the rows: a wire answer carries
 *     what a person reads (names, counts, hashes, times), never the scope key, the storage
 *     locator or the actor id — those are facts of the store, not of the answer.
 */

import type { SafeText, SafeValue } from "./ai-observability";

/** The upstream synchronization vocabulary of a dataset subject (T19's state machine). */
export type DatasetSyncState = "pending" | "syncing" | "synced" | "failed";

/**
 * One case as a frozen version holds it: projected content plus opaque provenance ids.
 * Mirrors T19's `FrozenDatasetCase` exactly — the freeze pipeline produces these, the
 * review preview returns them, and there is no second spelling.
 */
export type FrozenDatasetCase = Readonly<{
  safeInput: SafeText;
  referenceOutput: SafeText;
  toolFixtures: SafeValue;
  sourceRunId: string;
  sourceAttemptId: string;
  sourceBindingId: string | null;
}>;

/** One dataset as the list answers it: the subject row reduced to readable facts. */
export type ObservationDatasetListItem = {
  id: string;
  name: string;
  syncState: DatasetSyncState;
  createdAt: string;
  updatedAt: string;
  /** How many frozen versions the dataset holds. */
  versionCount: number;
  /** When the newest version froze, or null when no version exists yet. */
  latestVersionAt: string | null;
};

export type ObservationDatasetsResult = {
  datasets: readonly ObservationDatasetListItem[];
};

/**
 * One frozen version as the history answers it. The content itself stays behind the hash:
 * `contentHash` plus the policy version under which it was projected is the whole identity a
 * person needs to pin an experiment to, and `caseCount` answers "how big is it" without
 * shipping every case over the wire again.
 */
export type ObservationDatasetVersionItem = {
  id: string;
  datasetId: string;
  /** sha-256 of the canonical JSON of the frozen cases — the version's identity, in full. */
  contentHash: string;
  /** The redaction policy the content was projected under, e.g. "opik-redaction/5". */
  redactionPolicyVersion: string;
  caseCount: number;
  createdAt: string;
};

export type ObservationDatasetDetailResult = {
  dataset: {
    id: string;
    name: string;
    syncState: DatasetSyncState;
    createdAt: string;
    updatedAt: string;
  };
  /** Newest first (T19's `listVersions` order: createdAt desc, id desc as the tiebreaker). */
  versions: readonly ObservationDatasetVersionItem[];
};

/** One fragment the reviewer selected from an observed run. Mirrors T20's `CaseFragment`. */
export type CaseFragmentInput = {
  input: string;
  referenceOutput: string;
  toolFixtures: Record<string, unknown>;
  /** The attempt the fragment was observed on; must match the run's latest bound attempt. */
  attemptId?: string;
};

/** The body of POST …/case-review/review, with the decision the save flow always reviews under. */
export type CaseReviewRequest = {
  runId: string;
  decision: "approved" | "rejected";
  cases: readonly CaseFragmentInput[];
  note?: string;
};

/** Mirrors T20's `CaseReviewOutcome`: the projection preview is exactly what a save freezes. */
export type CaseReviewOutcome = Readonly<{
  decision: "approved" | "rejected";
  runId: string;
  attemptId: string;
  bindingId: string;
  preview: readonly FrozenDatasetCase[];
  /** How many cases the redaction policy refused part of — the canary the reviewer must see. */
  canaryFindings: number;
}>;

/** The body of POST …/case-review/save. */
export type SaveDatasetVersionRequest = {
  datasetName: string;
  runId: string;
  cases: readonly CaseFragmentInput[];
};

/** The save answer: the projected version plus the idempotency verdict the UI reports. */
export type SavedDatasetVersionResult = {
  datasetId: string;
  datasetName: string;
  version: {
    id: string;
    contentHash: string;
    redactionPolicyVersion: string;
    caseCount: number;
    createdAt: string;
  };
  /** True when the same content already made this version and the existing row was returned. */
  replayed: boolean;
  canaryFindings: number;
};
