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
 *   - the R2-57 experiments mirror's known seam: the in_progress sample reason's `state`.
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
import type { ExperimentSampleReason } from "../../../shared/ai-observability-experiments";
import type { AdminSummary } from "../../src/ai-observability/admin-summary";
import type { CaseFragment } from "../../src/ai-observability/case-review";
import type { FrozenDatasetCase as ServerFrozenDatasetCase } from "../../src/ai-observability/datasets";
import type { SampleReason } from "../../src/ai-observability/results";
import type {
  projectJob,
  projectJobListItem,
} from "../../src/ai-observability/routes/exports";

/** True only when A and B are mutually assignable — the same shape, by either direction. */
type Same<A, B> = A extends B ? (B extends A ? true : false) : false;

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
