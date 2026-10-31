/**
 * The evidence chain behind an answer citation (#387, FR-4). #732 shrank this module to
 * that one read: the judgment review, the memory listings and the cleanup progress were
 * the old engine's surfaces and left with the old paths.
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

export const hindsightKeys = {
  all: ["hindsight"] as const,
  evidence: (ids: readonly string[]) =>
    ["hindsight", "evidence", ...ids] as const,
};

/** The scope tail the evidence factory composes onto, or the pending placeholder beside. */
const pending = (tail: readonly unknown[]) => [...tail, ":scope-pending"];

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
