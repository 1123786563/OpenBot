import type { QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { tenantKeys } from "./queries";
import { type ScopeSelection, selectionKeys } from "./selection";
import { streamWriteStillCurrent, useStreamScope } from "./stream-scope";

/*
 * The business-cache half of the selection, MT083 (Issue #126).
 *
 * WHERE MT081 AND MT082 LEFT OFF. The request faces are bound: `client` carries the selection pair
 * as headers on reviewed REST paths, `stream-scope` carries it on reviewed stream paths and tears
 * connections down when it moves. What had no mechanism was the CACHE those faces fill: a business
 * query's key named no company and no team, so one person's two scopes read one entry — and a
 * switch left the old scope's business data sitting in the cache the new scope was about to read.
 *
 * THIS MODULE IS THE RULE, NOT THE WIRING. It fixes where a business entry lives
 * (`scopedCachePrefix`: under the selection's own subtree, or the personal context's — so the
 * switch's existing removal discipline already covers it), hands business reads the SAME in-flight
 * refusal the tenant face guards with (`guarded`, exported from queries.ts since this ticket), and
 * hands business writes the SAME generation check a stream's writes pass (`cacheWriteGate`, the
 * optimistic-update counterpart: a rollback that outlived its scope is dropped, never replayed
 * into the scope that replaced it). Which surfaces adopt it is each surface's own ticket; per #126
 * every later Web ticket binds the same way rather than wrapping its own layer.
 *
 * ONE SOURCE. The reactive facts (`useScopedCache`) read the same cache entries MT082's
 * `useStreamScope` reads — the live current selection and the shared generation — through that
 * hook, so there is not a second observer set, a second storage listener or a second discipline to
 * keep in step: a second tab's switch runs the same seam in this tab (storage event →
 * `selectWorkspaceScope`), which moves the generation this module's guard reads and removes the
 * prefix this module hands out.
 */

/** The scoped cache's answer while the scope source (the signed-in user) is unresolved. */
export type ScopedCachePending = { status: "pending" };

/** The scope a business surface works under, with the cache facts that follow from it. */
export type ScopedCacheOpen = {
  /** The discriminator: the scope source has answered and this is a working scope. */
  status: "open";
  /** Whose business cache this is — the guard and the switch key the generation by it. */
  userId: string;
  /** The selection in force, or null: the personal context, cached under its own subtree. */
  selection: ScopeSelection | null;
  /** The cache generation at render time; any switch advances it. */
  generation: number;
  /** The prefix every business key of this scope composes onto; removed wholesale on a switch. */
  prefix: readonly unknown[];
  /**
   * Changes exactly when a business key must change: the pair moved, or the generation moved.
   * Identity-stable between those moments.
   */
  key: string;
};

export type ScopedCache = ScopedCachePending | ScopedCacheOpen;

const PENDING: ScopedCachePending = { status: "pending" };

/**
 * Where one scope's business entries live: under the selection's own workspace subtree, or — when
 * nothing is selected — under the personal context's, next to nothing else.
 *
 * Both prefixes are the ones the switch ALREADY removes (`selectWorkspaceScope`: a company change
 * drops the whole tenant subtree a selected prefix sits under, a team change drops the workspace
 * subtree itself, and moving from no selection into one drops the personal prefix), so a business
 * entry filed here is gone the moment its scope is — no second removal discipline to keep in step.
 * The reserved leading-colon token keeps the personal subtree from ever colliding with a tenant id.
 */
export function scopedCachePrefix(
  userId: string,
  selection: ScopeSelection | null,
): readonly unknown[] {
  return selection === null
    ? selectionKeys.personalScope(userId)
    : selectionKeys.workspaceScope(
        userId,
        selection.tenantId,
        selection.workspaceId,
      );
}

/**
 * The scope every business surface composes its keys onto, as one reactive value.
 *
 * `pending` means the scope SOURCE has not answered (the signed-in user is still loading) — the
 * same refusal MT082's streams live by: a business read is not established on a guess. Resolves as
 * soon as the auth read the route gate already made answers, because the storage read is
 * synchronous.
 */
export function useScopedCache(): ScopedCache {
  const scope = useStreamScope();
  return useMemo(() => {
    if (scope.status === "pending") return PENDING;
    return {
      status: "open",
      userId: scope.userId,
      selection: scope.selection,
      generation: scope.generation,
      prefix: scopedCachePrefix(scope.userId, scope.selection),
      // The stream key already names pair and generation — the two facts a business key turns on.
      key: scope.key,
    };
  }, [scope]);
}

/**
 * The gate a mutation captures when it writes optimistically, so its later rollback can check
 * itself: `stillCurrent()` is false once any switch has advanced the generation, which is exactly
 * the moment the rollback must NOT land — the old scope's entries are gone, and replaying a
 * snapshot into them (or into the new scope's key) would resurrect or corrupt what the switch just
 * cleared.
 *
 * The check itself is `streamWriteStillCurrent` (MT082) — the same generation entry, the same
 * comparison — re-exported here under the cache-side name so the business face has one import
 * point without a second implementation drifting beside the first.
 */
export function cacheWriteGate(
  queryClient: QueryClient,
  userId: string,
): {
  /** The generation at capture time. */
  at: number;
  /** Whether a write that left at `at` may still land. */
  stillCurrent(): boolean;
} {
  const at =
    queryClient.getQueryData<number>(tenantKeys.generation(userId)) ?? 0;
  return {
    at,
    stillCurrent: () => streamWriteStillCurrent(queryClient, userId, at),
  };
}
