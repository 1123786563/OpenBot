/**
 * Hindsight 08 (#385): safe degradation when the shared Hindsight service is down or timing
 * out.
 *
 * The person's confirmed memories are OpenBot authority rows; Hindsight is only the index and
 * ranker over them. An outage therefore must not erase what the person already confirmed and
 * still holds rights to — but the degradation may never buy availability with a single byte of
 * wrong memory. This module is a thin wrapper AROUND the two recall seams, not a parallel
 * implementation of them: the normal path is the seam verbatim, and the degradation path is
 * entered only through the seam's own failure path — the `*RecallUnavailableError` the seams
 * already throw when the service is unreachable, times out, or answers non-2xx. Every other
 * error (a refused scope, a malformed query, a database failure) propagates untouched, so
 * degradation never masks a real refusal as an outage.
 *
 * What the SQL fallback may return is decided by the SAME predicates as the indexed recall —
 * imported from the seam modules, never re-implemented here: the row-level review/tombstone
 * gate, #386's temporal visibility for preferences, and #383's live authorization snapshot for
 * source-bound rows (the asking workspace's boundary included; an empty snapshot still answers
 * empty, because nothing is ever guessed into a bank). The one capability the outage takes
 * away is semantic ranking, and the honest substitute is plain text matching: a memory answers
 * only when every whitespace-separated query term appears in its confirmed content — fewer,
 * never wronger, results. The answer says so: `degraded: true` means "text-matched confirmed
 * rows", and any caller that claims semantic indexing during the outage is lying.
 *
 * Recovery is not this module's job and never needs to be: confirmations that landed during
 * the outage already hold their pending sync-work rows (#384), and the queue drains them once
 * the service answers again — which the facade's next non-degraded answer reflects.
 */

import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { genericPersonalPreferences } from "../db/schema/hindsight-preferences";
import { sourceBoundMemories } from "../db/schema/hindsight-source-bound";
import type { PlatformScope } from "../enterprise/contracts";
import {
  type HindsightBankScope,
  resolveHindsightBankScope,
  resolveScopedHindsightBankScope,
} from "./bank-scope";
import {
  type PreferenceAuthorityRow,
  type PreferenceRecallService,
  PreferenceRecallUnavailableError,
  preferenceRecallEligible,
  type RecalledGenericPreference,
  temporallyVisible,
  timeUncertaintyOf,
  toRecalledPreferenceView,
} from "./preference-recall";
import {
  type AuthorizationSnapshot,
  type RecalledSourceBoundMemory,
  readScopedAuthorization,
  type SourceBoundAuthorizationStore,
  type SourceBoundRecallService,
  SourceBoundRecallUnavailableError,
  type SourceBoundRecordRow,
  sourceBoundRecallEligible,
  stillAuthorized,
  toRecalledSourceBoundView,
} from "./scoped-recall";

/** One degraded-capable answer: the memories, and whether they were text-matched, not ranked. */
export type DegradedRecallAnswer<T> = {
  memories: T[];
  /**
   * True exactly when the service could not be asked and the memories came from the SQL
   * fallback. Callers must not present a degraded answer as semantically indexed.
   */
  degraded: boolean;
};

/** The SQL-backed eligible-row read for preferences; mechanical filtering only. */
export interface DegradedPreferenceSearch {
  loadRecallEligible(
    tenantId: string,
    principalId: string,
  ): Promise<PreferenceAuthorityRow[]>;
}

/** The SQL-backed eligible-row read for source-bound rows; mechanical filtering only. */
export interface DegradedSourceBoundSearch {
  loadRecallEligible(
    tenantId: string,
    principalId: string,
  ): Promise<SourceBoundRecordRow[]>;
}

/** Bot-context economy: the degraded path answers at most as many rows as the indexed one. */
const DEGRADED_RECALL_LIMIT = 20;

/**
 * Whether a row's confirmed content answers the query under the outage's honest capabilities:
 * every whitespace-separated term must appear (case-insensitive substring). Semantic near-misses
 * do not answer at all — a missing memory during an outage is acceptable, a wrong one is not.
 */
export function contentMatchesQuery(content: string, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (!terms.length) return false;
  const haystack = content.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function createDegradedRecallFacade(
  preferences: PreferenceRecallService,
  sourceBound: SourceBoundRecallService,
  preferenceSearch: DegradedPreferenceSearch,
  sourceBoundSearch: DegradedSourceBoundSearch,
  authorizations: SourceBoundAuthorizationStore,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());

  /**
   * The preference fallback: eligibility re-verified in the policy layer even though the SQL
   * already filters for it (the SQL is the degradation's speed; the predicate here is its
   * truth), then #386's temporal window, then the text match. Order is the most recently
   * updated row first — a deterministic order for a deterministic answer, not a ranking claim.
   */
  async function degradedPreferenceRecall(
    scope: PlatformScope,
    input: { query: string; asOf?: Date },
  ): Promise<RecalledGenericPreference[]> {
    const identity = resolveHindsightBankScope(scope);
    const mode = input.asOf === undefined ? "current" : "historical";
    const rows = await preferenceSearch.loadRecallEligible(
      identity.tenantId,
      identity.principalId,
    );
    return rows
      .filter(
        (row) =>
          preferenceRecallEligible(row) &&
          temporallyVisible(row, input.asOf ?? now(), mode) &&
          contentMatchesQuery(row.content, input.query.trim()),
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, DEGRADED_RECALL_LIMIT)
      .map((row) =>
        toRecalledPreferenceView(row, timeUncertaintyOf(row, mode)),
      );
  }

  /**
   * The source-bound fallback. The bank set is resolved from a LIVE authorization snapshot
   * exactly as the indexed recall resolves it — an empty snapshot answers empty here too — and
   * each row must still pass #383's per-row authorization check against a second live read,
   * which is what keeps the asking workspace's boundary and source/Bot revocations enforced
   * under the outage.
   */
  async function degradedSourceBoundRecall(
    scope: PlatformScope,
    input: { query: string; askingAgentId?: string },
  ): Promise<RecalledSourceBoundMemory[]> {
    // Trusted-scope assertion first, through the same derivation as every other path: a forged
    // scope must be refused before any authorization read runs.
    const identity = resolveHindsightBankScope(scope);
    const first: AuthorizationSnapshot = await readScopedAuthorization(
      authorizations,
      identity.tenantId,
      identity.principalId,
      scope.workspaceId,
      input.askingAgentId,
    );
    const grant: HindsightBankScope = resolveScopedHindsightBankScope(scope, {
      workspaceActive: first.workspaceActive,
      sourceIds: first.sourceIds,
      agentId:
        input.askingAgentId !== undefined && first.agentAuthorized
          ? input.askingAgentId
          : undefined,
    });
    if (!grant.banks.length) return [];
    const rows = await sourceBoundSearch.loadRecallEligible(
      grant.tenantId,
      grant.principalId,
    );
    return rows
      .filter(
        (row) =>
          sourceBoundRecallEligible(row) &&
          stillAuthorized(row, first) &&
          contentMatchesQuery(row.content, input.query.trim()),
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, DEGRADED_RECALL_LIMIT)
      .map(toRecalledSourceBoundView);
  }

  return {
    /**
     * THE preference recall with a safety net: the seam's answer while the service answers;
     * on the seam's own unavailability signal — and only that — the SQL fallback, flagged
     * degraded so nobody can claim the outage indexed anything.
     */
    async recallGenericPreferences(
      scope: PlatformScope,
      input: { query: unknown; askingAgentId?: unknown; asOf?: unknown },
    ): Promise<DegradedRecallAnswer<RecalledGenericPreference>> {
      try {
        return {
          memories: await preferences.recallGenericPreferences(scope, input),
          degraded: false,
        };
      } catch (error) {
        if (!(error instanceof PreferenceRecallUnavailableError)) throw error;
        // The seam validated `query`/`asOf` before reaching the service; the fallback re-runs
        // the same plain-string gate so a malformed query stays a refusal, not an outage.
        const query = typeof input.query === "string" ? input.query.trim() : "";
        let asOf: Date | undefined;
        if (input.asOf !== undefined) {
          const parsed =
            input.asOf instanceof Date
              ? input.asOf
              : typeof input.asOf === "string"
                ? new Date(input.asOf)
                : null;
          if (!parsed || Number.isNaN(parsed.getTime())) {
            throw error;
          }
          asOf = parsed;
        }
        return {
          memories: await degradedPreferenceRecall(scope, { query, asOf }),
          degraded: true,
        };
      }
    },

    /** THE source-bound recall with the same safety net and the same discipline. */
    async recallSourceBoundMemories(
      scope: PlatformScope,
      input: { query: unknown; askingAgentId?: unknown },
    ): Promise<DegradedRecallAnswer<RecalledSourceBoundMemory>> {
      try {
        return {
          memories: await sourceBound.recallSourceBoundMemories(scope, input),
          degraded: false,
        };
      } catch (error) {
        if (!(error instanceof SourceBoundRecallUnavailableError)) throw error;
        const query = typeof input.query === "string" ? input.query.trim() : "";
        let askingAgentId: string | undefined;
        if (input.askingAgentId !== undefined) {
          askingAgentId =
            typeof input.askingAgentId === "string"
              ? input.askingAgentId
              : undefined;
        }
        return {
          memories: await degradedSourceBoundRecall(scope, {
            query,
            askingAgentId,
          }),
          degraded: true,
        };
      }
    },
  };
}

export type DegradedRecallFacade = ReturnType<
  typeof createDegradedRecallFacade
>;

/**
 * The SQL-backed preference search: confirmed-or-edited, enabled, un-forgotten, non-empty
 * rows of this principal in this company, newest update first. Only mechanical filters an
 * index would not need to own; every policy decision is re-made above.
 */
export function createDrizzleDegradedPreferenceSearch(
  database: Database,
): DegradedPreferenceSearch {
  const table = genericPersonalPreferences;
  return {
    async loadRecallEligible(tenantId, principalId) {
      return database
        .select()
        .from(table)
        .where(
          and(
            eq(table.tenantId, tenantId),
            eq(table.principalId, principalId),
            or(
              eq(table.reviewState, "confirmed"),
              eq(table.reviewState, "edited"),
            ),
            eq(table.enabled, true),
            isNull(table.deletedAt),
            ne(table.content, ""),
          ),
        )
        .orderBy(desc(table.updatedAt));
    },
  };
}

/** The SQL-backed source-bound search, same mechanical shape as the preference one. */
export function createDrizzleDegradedSourceBoundSearch(
  database: Database,
): DegradedSourceBoundSearch {
  const table = sourceBoundMemories;
  return {
    async loadRecallEligible(tenantId, principalId) {
      return database
        .select()
        .from(table)
        .where(
          and(
            eq(table.tenantId, tenantId),
            eq(table.principalId, principalId),
            or(
              eq(table.reviewState, "confirmed"),
              eq(table.reviewState, "edited"),
            ),
            eq(table.enabled, true),
            isNull(table.deletedAt),
            ne(table.content, ""),
          ),
        )
        .orderBy(desc(table.updatedAt));
    },
  };
}
