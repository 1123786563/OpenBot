/**
 * The person's Hindsight memory reads (#387/#389/#391, FR-4): the judgment candidates waiting
 * for review, the evidence chain behind a judgment or an answer citation, and the cleanup
 * progress of what the person forgot.
 *
 * Every call here rides `client` with no company or team selection: the server resolves one
 * trusted scope per request from the session, and the fix wave's brief pins that no tenant,
 * principal or bank id may leave the browser on this surface. What these queries receive is
 * already only the person's own, currently authorized answer — an entry the person can no
 * longer see arrives as `{ state: "unavailable" }` and is never inferred into content.
 *
 * Dates cross the wire as ISO strings, so every `Date` the server types carries `string` here.
 */

import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

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
  evidence: (ids: readonly string[]) =>
    ["hindsight", "evidence", ...ids] as const,
  cleanup: ["hindsight", "cleanup"] as const,
};

/** The review surface's data source (#389 AC2): open candidates, newest first, basis included. */
export const judgmentCandidatesQueryOptions = () =>
  queryOptions({
    queryKey: hindsightKeys.candidates,
    queryFn: (): Promise<JudgmentCandidate[]> =>
      client("/api/hindsight/judgments/candidates", "candidates", {
        fallbackKey: "hindsight.loadCandidates",
      }),
  });

/**
 * Expand basis ids into what the person is entitled to see NOW (#387 AC1/AC3). A POST because
 * the id list rides the body; still a cached read, invalidated by every write below so an
 * operation's effect shows on the next expansion without a manual reload.
 */
export const evidenceInspectionQueryOptions = (ids: readonly string[]) =>
  queryOptions({
    queryKey: hindsightKeys.evidence(ids),
    enabled: ids.length > 0,
    queryFn: (): Promise<EvidenceInspection[]> =>
      client("/api/hindsight/evidence", "evidence", {
        method: "POST",
        body: { ids: [...ids] },
        fallbackKey: "hindsight.loadEvidence",
      }),
  });

/** The cleanup picture as a pure read (#391 AC3): the claim, its legs, and the external note. */
export const cleanupStatusQueryOptions = () =>
  queryOptions({
    queryKey: hindsightKeys.cleanup,
    queryFn: async (): Promise<CleanupStatus> =>
      (
        await client("/api/hindsight/cleanup", {
          fallbackKey: "hindsight.loadCleanup",
        })
      ).json(),
  });
