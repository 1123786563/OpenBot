/**
 * The person's Hindsight memory reads (#387/#389/#391, FR-4): the judgment candidates waiting
 * for review, the judgments they already adopted, the evidence chain behind a judgment or an
 * answer citation, and the cleanup progress of what the person forgot.
 *
 * Every call here rides `client` with the scope the screen holds (MT089's family, FIX-W12
 * FR2-1): the selection pair rides the request as the reviewed `x-openbot-tenant` /
 * `x-openbot-workspace` headers, and the server's own membership decides what the pair may
 * see — a request without a selection is refused by the resolver, never answered from a
 * guessed company. The cache follows the same discipline as the memory rows beside it: every
 * key sits under the scope's own prefix (MT083), so a switch drops the old scope's answers
 * wholesale, and `guarded` refuses an answer that outlived the selection it left under.
 *
 * What these queries receive is already only the person's own, currently authorized answer —
 * an entry the person can no longer see arrives as `{ state: "unavailable" }` and is never
 * inferred into content.
 *
 * Dates cross the wire as ISO strings, so every `Date` the server types carries `string` here.
 */

import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/** The single scope a judgment and all of its evidence share; inherited, never widened. */
export type JudgmentScope =
  | { kind: "general" }
  | { kind: "team"; workspaceId: string }
  | { kind: "source"; sourceId: string }
  | { kind: "bot"; agentId: string };

/** The authorization fact a source-bound memory stays bound to (#383). */
export type EvidenceRestriction =
  | { kind: "team"; workspaceId: string }
  | { kind: "source"; sourceId: string }
  | { kind: "bot"; agentId: string };

/** One basis entry as the candidate and review surfaces carry it: content, source, and time. */
export type JudgmentEvidenceView =
  | {
      kind: "preference";
      /** The OpenBot record id — the id the evidence seam expands. */
      id: string;
      content: string;
      provenance: string;
      /** When the person marked this preference general. */
      markedGenericAt: string;
      /** The fact's validity window (#386); `effectiveUntil: null` = still current. */
      effectiveFrom: string | null;
      effectiveUntil: string | null;
    }
  | {
      kind: "source_bound";
      id: string;
      content: string;
      provenance: string;
      restriction: EvidenceRestriction;
      /** When the fact was formed. */
      formedAt: string;
    }
  | {
      kind: "derived_judgment";
      id: string;
      content: string;
      provenance: string;
      scope: JudgmentScope;
      /** When that judgment was proposed. */
      proposedAt: string;
    };

/** What the person sees of one candidate (#389): the claim, its scope, and its complete basis. */
export type JudgmentCandidate = {
  id: string;
  content: string;
  provenance: string;
  scope: JudgmentScope;
  reviewState: "unreviewed";
  proposedAt: string;
  /** In lead order — nothing is summarized away. */
  evidence: JudgmentEvidenceView[];
};

/** A judgment the person adopted: the current text and the complete basis it still stands on. */
export type ReviewedJudgment = {
  id: string;
  content: string;
  provenance: string;
  scope: JudgmentScope;
  reviewState: "confirmed" | "edited";
  reviewedAt: string;
  evidence: JudgmentEvidenceView[];
};

/** A judgment's basis as its inspection renders it, one level deep. */
export type JudgmentBasisEntry =
  | Extract<JudgmentEvidenceView, { kind: "preference" }>
  | Extract<JudgmentEvidenceView, { kind: "source_bound" }>
  | {
      kind: "derived_judgment";
      id: string;
      content: string;
      provenance: string;
      scope: JudgmentScope;
      reviewState: "confirmed" | "edited";
      reviewedAt: string;
    };

/** What the person may launch from one expanded basis entry, as the seam advertises it. */
export type EvidenceAction = "edit" | "correct" | "forget";

/**
 * One basis entry as the evidence seam answers NOW (#387): availability is re-decided per row
 * at inspect time, and an entry that is missing, foreign, forgotten or no longer authorized
 * answers `{ state: "unavailable" }` with no content — the seam's own vocabulary, held as-is.
 */
export type EvidenceInspection =
  | {
      state: "available";
      kind: "preference";
      id: string;
      content: string;
      provenance: string;
      markedGenericAt: string;
      effectiveFrom: string | null;
      effectiveUntil: string | null;
      /** The correcting row when this basis is a superseded historical fact; null = chain head. */
      supersededBy: string | null;
      /** The window closed at an unknowable time — display the uncertainty, never a date. */
      supersededTimeUnknown: boolean;
      correctedAt: string | null;
      actions: EvidenceAction[];
    }
  | {
      state: "available";
      kind: "source_bound";
      id: string;
      content: string;
      provenance: string;
      restriction: EvidenceRestriction;
      formedAt: string;
      actions: EvidenceAction[];
    }
  | {
      state: "available";
      kind: "derived_judgment";
      id: string;
      content: string;
      provenance: string;
      scope: JudgmentScope;
      reviewState: "confirmed" | "edited";
      reviewedAt: string;
      /** The complete basis, one level deep. */
      evidence: JudgmentBasisEntry[];
      actions: EvidenceAction[];
    }
  | { state: "unavailable"; id: string };

/**
 * The person's own cleanup progress (#391 AC3): the claim only when all three legs hold actual
 * evidence, each leg's own observation, and the separate external-model-logs note. The screen
 * renders the booleans; it never rewords a leg into a claim the server did not make.
 */
export type CleanupStatus = {
  controlledCopiesCleared: boolean;
  summary: string | null;
  externalModelLogs: { coveredByThisClaim: false; note: string };
  activeData: {
    cleared: boolean;
    documents: number;
    outstanding: number;
    unverified: number;
    resurrected: number;
    observedAt: string | null;
    blockedByOpenRestore: boolean;
  };
  finishedTaskPayloads: {
    cleared: boolean;
    checked: boolean;
    retentionDays: number | null;
    banksChecked: number;
    beyondWindow: number | null;
    reason: string | null;
  };
  controlledBackups: {
    cleared: boolean;
    registered: number;
    outstanding: number | null;
    oldestOutstandingTakenAt: string | null;
  };
  computedAt: string;
};

/** What a forget answers (#390 AC3): stopped using it now, remote cleanup tracked, never "cleared". */
export type MemoryRevocation = {
  stoppedUsingAt: string;
  remoteDeletion: { attempted: boolean; outstanding: number };
  summary: string;
};

export const hindsightKeys = {
  all: ["hindsight"] as const,
  candidates: ["hindsight", "judgment-candidates"] as const,
  adopted: ["hindsight", "judgments-adopted"] as const,
  memories: ["hindsight", "memories"] as const,
  evidence: (ids: readonly string[]) =>
    ["hindsight", "evidence", ...ids] as const,
  cleanup: ["hindsight", "cleanup"] as const,
};

/** The scope tail every factory below composes onto, or the pending placeholder beside. */
const pending = (tail: readonly unknown[]) => [...tail, ":scope-pending"];

/**
 * The review surface's data source (#389 AC2): open candidates, newest first, basis included.
 * Keyed under the scope's own prefix, answered through the generation guard, so one person's
 * two scopes never read one entry and a switch drops the old scope's candidates wholesale.
 */
export function scopedJudgmentCandidatesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...hindsightKeys.candidates]
        : pending(hindsightKeys.candidates),
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<JudgmentCandidate[]>(() => {})
        : async ({ signal }): Promise<JudgmentCandidate[]> =>
            guarded(queryClient, open.userId, () =>
              client("/api/hindsight/judgments/candidates", "candidates", {
                signal,
                fallbackKey: "hindsight.loadCandidates",
                ...(open.selection ?? {}),
              }),
            ),
  });
}

/**
 * What the person already adopted (#389, FIX-W12 FR2-3): the server's own adopted listing, so
 * the group survives a reload and a fresh session instead of living only in the page that
 * confirmed it. Each row arrived re-verified against current authorization, so what lists here
 * is exactly what the next answer may still use.
 */
export function scopedAdoptedJudgmentsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...hindsightKeys.adopted]
        : pending(hindsightKeys.adopted),
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<ReviewedJudgment[]>(() => {})
        : async ({ signal }): Promise<ReviewedJudgment[]> =>
            guarded(queryClient, open.userId, () =>
              client("/api/hindsight/judgments/adopted", "adopted", {
                signal,
                fallbackKey: "hindsight.loadAdopted",
                ...(open.selection ?? {}),
              }),
            ),
  });
}

/**
 * A memory entry the listing answers: one of the two raw kinds the person's answers read,
 * never a judgment — judgments have their own two listings on the same page.
 */
export type PersonalMemoryEntry =
  | Extract<JudgmentEvidenceView, { kind: "preference" }>
  | Extract<JudgmentEvidenceView, { kind: "source_bound" }>;

/**
 * The person's own Hindsight memory entries (FIX-W12 FR2-3, #387 AC1): the confirmed
 * preferences and source-bound facts a Bot's answers read, newest change first. Each row
 * arrived re-verified against current authorization, so the entry a person expands from here
 * is one the next answer may still use — the closed loop scenario 1 asks for: checkable,
 * correctable, forgettable.
 */
export function scopedPersonalMemoriesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...hindsightKeys.memories]
        : pending(hindsightKeys.memories),
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<PersonalMemoryEntry[]>(() => {})
        : async ({ signal }): Promise<PersonalMemoryEntry[]> =>
            guarded(queryClient, open.userId, () =>
              client("/api/hindsight/memories", "memories", {
                signal,
                fallbackKey: "hindsight.loadMemories",
                ...(open.selection ?? {}),
              }),
            ),
  });
}

/**
 * Expand basis ids into what the person is entitled to see NOW (#387 AC1/AC3). A POST because
 * the id list rides the body; still a cached read, invalidated by every write below so an
 * operation's effect shows on the next expansion without a manual reload.
 */
export function scopedEvidenceInspectionQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  ids: readonly string[],
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...hindsightKeys.evidence(ids)]
        : pending(hindsightKeys.evidence(ids)),
    enabled: open !== null && ids.length > 0,
    queryFn:
      open === null
        ? () => new Promise<EvidenceInspection[]>(() => {})
        : async ({ signal }): Promise<EvidenceInspection[]> =>
            guarded(queryClient, open.userId, () =>
              client("/api/hindsight/evidence", "evidence", {
                method: "POST",
                body: { ids: [...ids] },
                signal,
                fallbackKey: "hindsight.loadEvidence",
                ...(open.selection ?? {}),
              }),
            ),
  });
}

/** The cleanup picture as a pure read (#391 AC3): the claim, its legs, and the external note. */
export function scopedCleanupStatusQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...hindsightKeys.cleanup]
        : pending(hindsightKeys.cleanup),
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<CleanupStatus>(() => {})
        : async ({ signal }): Promise<CleanupStatus> =>
            guarded(queryClient, open.userId, async () => {
              const response = await client("/api/hindsight/cleanup", {
                signal,
                fallbackKey: "hindsight.loadCleanup",
                ...(open.selection ?? {}),
              });
              return (await response.json()) as CleanupStatus;
            }),
  });
}
