/**
 * The administrator's scope summary (Issue #39 / DAG T33).
 *
 * The route authorizes first and hands this service already-minted
 * ObservationScopes; every aggregate below is keyed by the scope, so the same
 * bot id under another scope is a different key space that simply never
 * appears. The summary is a BYPASS query, never part of a run's critical
 * path: it reads the local authoritative tables (T07 bindings, T22
 * experiments, T34 export jobs) plus the T13 health snapshot, performs no
 * write of any kind, and treats an Opik failure as a fact to report — the
 * upstream-derived numbers go explicitly null rather than zero, and the
 * local counts still answer. No new table: everything here reads what the
 * earlier tickets already own (acceptance: no migration).
 *
 * Honesty rules, straight from the parent Spec:
 *   - pending is positive evidence (begun, never reconciled), never a guess;
 *   - a failed run is a business outcome, distinct from a collection that
 *     cannot answer (unreachable/authentication_failure) and from a capability
 *     the deployment never had (disabled/unconfigured/capability_missing) —
 *     the T13 readiness vocabulary verbatim, no new enumeration invented;
 *   - missing usage is counted as unavailable, never summed as zero;
 *   - an upstream trace this scope never bound is the unbound count an
 *     administrator may see and a creator may not.
 */
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  type AiObservationBindingCapability,
  type AiObservationBindingState,
  aiObservationBindings,
} from "../db/schema/ai-observability-bindings";
import { aiObservationExperiments } from "../db/schema/ai-observability-experiments";
import { aiObservationExportJobs } from "../db/schema/ai-observability-exports";
import type { OpikConfig } from "./config";
import type { ObservationScope } from "./contracts";
import type {
  OpikHealthService,
  OpikHealthSnapshot,
  OpikReadiness,
  OpikReadinessReason,
} from "./health";
import type { OpikPort } from "./opik-port";
import { DEFAULT_RUNS_WINDOW, projectRow } from "./queries/runs";

/** The time filter every aggregate honors: inclusive bounds, null for open. */
export type AdminSummaryWindow = Readonly<{
  from: Date | null;
  to: Date | null;
}>;

export type AdminBotRunSummary = Readonly<{
  /** Live bindings begun inside the window (soft-deleted rows are not evidence). */
  total: number;
  byState: Readonly<Record<AiObservationBindingState, number>>;
  /** Begun but never reconciled upstream — the "still syncing" evidence. */
  pendingSync: number;
  /** The capability verdicts of those bindings; basic is not detailed. */
  capabilities: Readonly<Record<AiObservationBindingCapability, number>>;
  /**
   * Upstream traces this scope never bound. Null when collection cannot
   * answer — an unknown count, never a zero in disguise.
   */
  unboundUpstream: number | null;
  /**
   * Usage honesty: how many upstream rows the provider actually reported
   * tokens for, and how many did not. Null when collection cannot answer.
   */
  usage: Readonly<{ providerReported: number; unavailable: number }> | null;
  /**
   * R2-46: true when the upstream listing covered only the first window of a
   * larger project — the summary reads one page and never walks on, so when the
   * project's total exceeds that window, `unboundUpstream` and `usage` are
   * window-bounded lower bounds over what was seen, and this flag says so. A
   * partial count must not masquerade as the exact answer (the honesty rule at
   * the file's head): an exact count carries the flag false; an unanswerable
   * count stays null beside the flag false — null already says "unknown".
   */
  upstreamTruncated: boolean;
}>;

export type AdminBotSummary = Readonly<{
  botId: string;
  runs: AdminBotRunSummary;
  experiments: Readonly<{ draft: number; frozen: number }>;
  exports: Readonly<{
    byState: Readonly<
      Record<
        "queued" | "running" | "completed" | "failed" | "cancelled",
        number
      >
    >;
    /** The most recent failed job's closed-vocabulary code, if any. */
    lastFailedErrorCode: string | null;
  }>;
  collection: Readonly<{
    /** Last write this scope's live bindings recorded inside the window. */
    lastCollectedAt: string | null;
  }>;
}>;

export type AdminSummary = Readonly<{
  window: Readonly<{
    from: string | null;
    to: string | null;
    botId: string | null;
  }>;
  /** Deployment-level collection facts, shared by every bot in the answer. */
  collection: Readonly<{
    /** The T13 readiness answer, reason verbatim from its closed vocabulary. */
    readiness: Readonly<{ ready: boolean; reason: OpikReadinessReason | null }>;
    dropped: Readonly<{ queueFull: number; notReady: number }>;
  }>;
  bots: readonly AdminBotSummary[];
  botsTruncated: boolean;
}>;

export type AdminSummaryService = {
  summarize(input: {
    scopes: readonly ObservationScope[];
    window: AdminSummaryWindow;
    botId: string | null;
  }): Promise<AdminSummary>;
};

/** R2-47: the scope summaries' concurrency ceiling — 8 at a time, never the whole fleet. */
const SUMMARY_CONCURRENCY = 8;

/**
 * The project lookups' per-request cache (R2-47): one `summarize` call asks each
 * distinct scope key at most once, whatever the scopes array carries. Request-scoped
 * by construction — a new request builds a new cache, so no staleness story exists.
 */
type ProjectLookup = Awaited<ReturnType<OpikPort["retrieveProject"]>>;

/**
 * The portless answer, unreachable through the readiness gate (a portless deployment
 * is never `ready`), made explicit so the seam stays total without a cast.
 */
const PROJECT_PORTLESS: ProjectLookup = {
  outcome: "unavailable",
  operation: "retrieveProject",
  code: "OPIK_UNREACHABLE",
};

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        // The claim is synchronous between awaits, so no two runners take one index.
        const index = next;
        if (index >= items.length) return;
        next += 1;
        results[index] = await worker(items[index]);
      }
    },
  );
  // The old Promise.all semantics stand: any scope failing fails the whole summary.
  await Promise.all(runners);
  return results;
}

export function createAdminSummaryService(deps: {
  database: Database;
  config: () => OpikConfig;
  /** The verified port, or null when no verified contract backs this deployment. */
  port: OpikPort | null;
  healthService: Pick<OpikHealthService, "snapshot" | "writeStats">;
  /** Upstream window size per scope. Default the runs query window (100). */
  windowSize?: number;
  now?: () => Date;
}): AdminSummaryService {
  const windowSize = deps.windowSize ?? DEFAULT_RUNS_WINDOW;

  const summarizeOne = async (
    scope: ObservationScope,
    window: AdminSummaryWindow,
    readiness: OpikReadiness,
    getProject: (scope: ObservationScope) => Promise<ProjectLookup>,
  ): Promise<AdminBotSummary> => {
    const bindingRows = await deps.database
      .select({
        state: aiObservationBindings.state,
        capability: aiObservationBindings.capability,
        opikTraceId: aiObservationBindings.opikTraceId,
        updatedAt: aiObservationBindings.updatedAt,
      })
      .from(aiObservationBindings)
      .where(
        and(
          eq(aiObservationBindings.scopeKey, scope.key),
          isNull(aiObservationBindings.deletedAt),
          ...(window.from
            ? [gte(aiObservationBindings.createdAt, window.from)]
            : []),
          ...(window.to
            ? [lte(aiObservationBindings.createdAt, window.to)]
            : []),
        ),
      );

    const byState: Record<AiObservationBindingState, number> = {
      running: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      interrupted: 0,
      unknown: 0,
    };
    const capabilities: Record<AiObservationBindingCapability, number> = {
      basic: 0,
      detailed: 0,
      unavailable: 0,
    };
    let pendingSync = 0;
    let lastCollectedAt: Date | null = null;
    for (const row of bindingRows) {
      byState[row.state] += 1;
      capabilities[row.capability] += 1;
      if (row.opikTraceId === null) pendingSync += 1;
      if (
        lastCollectedAt === null ||
        row.updatedAt.getTime() > lastCollectedAt.getTime()
      ) {
        lastCollectedAt = row.updatedAt;
      }
    }

    const experimentRows = await deps.database
      .select({ state: aiObservationExperiments.state })
      .from(aiObservationExperiments)
      .where(
        and(
          eq(aiObservationExperiments.scopeKey, scope.key),
          ...(window.from
            ? [gte(aiObservationExperiments.createdAt, window.from)]
            : []),
          ...(window.to
            ? [lte(aiObservationExperiments.createdAt, window.to)]
            : []),
        ),
      );
    const experiments = { draft: 0, frozen: 0 };
    for (const row of experimentRows) experiments[row.state] += 1;

    const exportRows = await deps.database
      .select({
        state: aiObservationExportJobs.state,
        errorCode: aiObservationExportJobs.errorCode,
        settledAt: aiObservationExportJobs.settledAt,
      })
      .from(aiObservationExportJobs)
      .where(
        and(
          eq(aiObservationExportJobs.scopeKey, scope.key),
          ...(window.from
            ? [gte(aiObservationExportJobs.createdAt, window.from)]
            : []),
          ...(window.to
            ? [lte(aiObservationExportJobs.createdAt, window.to)]
            : []),
        ),
      );
    const exportStates = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    let lastFailed: { at: Date; code: string } | null = null;
    for (const row of exportRows) {
      exportStates[row.state] += 1;
      if (row.state === "failed" && row.errorCode !== null && row.settledAt) {
        if (
          lastFailed === null ||
          row.settledAt.getTime() > lastFailed.at.getTime()
        ) {
          lastFailed = { at: row.settledAt, code: row.errorCode };
        }
      }
    }

    /*
     * The upstream half: only when the T13 probe says collection can answer.
     * Any failure here keeps the readiness the probe reported and makes the
     * upstream-derived facts explicitly null — the request still succeeds,
     * the local counts still answer, and nobody upstairs fails.
     */
    let unboundUpstream: number | null = null;
    let usage: { providerReported: number; unavailable: number } | null = null;
    let upstreamTruncated = false;
    const port = deps.port;
    const config = deps.config();
    if (
      readiness.ready &&
      port !== null &&
      config.enabled &&
      config.baseUrl !== null
    ) {
      try {
        const project = await getProject(scope);
        if (project.outcome !== "ok") throw new Error(project.outcome);
        if (project.value === null) {
          // The verified 404 on the scope's own project: truthfully nothing.
          unboundUpstream = 0;
          usage = { providerReported: 0, unavailable: 0 };
        } else {
          const page = await port.listTraces(scope, {
            projectId: project.value.id,
            size: windowSize,
          });
          if (page.outcome !== "ok") throw new Error(page.outcome);
          const rows = page.value.content;
          // R2-46: one page is all this summary reads. A project bigger than the
          // window makes the per-row counts partial — say so, never let them
          // masquerade as the project's exact answer.
          upstreamTruncated = page.value.total > rows.length;
          const ids = rows.map((row) => row.id);
          const bound = new Set(
            ids.length === 0
              ? []
              : (
                  await deps.database
                    .select({ opikTraceId: aiObservationBindings.opikTraceId })
                    .from(aiObservationBindings)
                    .where(
                      and(
                        eq(aiObservationBindings.scopeKey, scope.key),
                        inArray(aiObservationBindings.opikTraceId, ids),
                      ),
                    )
                )
                  .map((row) => row.opikTraceId)
                  .filter((id): id is string => id !== null),
          );
          unboundUpstream = ids.filter((id) => !bound.has(id)).length;
          usage = { providerReported: 0, unavailable: 0 };
          for (const row of rows) {
            if (projectRow(row).usage.source === "provider") {
              usage.providerReported += 1;
            } else {
              usage.unavailable += 1;
            }
          }
        }
      } catch {
        unboundUpstream = null;
        usage = null;
      }
    }

    return {
      botId: scope.botId,
      runs: {
        total: bindingRows.length,
        byState,
        pendingSync,
        capabilities,
        unboundUpstream,
        usage,
        upstreamTruncated,
      },
      experiments,
      exports: {
        byState: exportStates,
        lastFailedErrorCode: lastFailed?.code ?? null,
      },
      collection: {
        lastCollectedAt: lastCollectedAt?.toISOString() ?? null,
      },
    };
  };

  return {
    summarize: async ({ scopes, window, botId }) => {
      let snapshot: OpikHealthSnapshot;
      try {
        snapshot = await deps.healthService.snapshot();
      } catch {
        snapshot = {
          readiness: { ready: false, reason: "unreachable" } as const,
          writes: deps.healthService.writeStats(),
        };
      }
      const stats = snapshot.writes;
      // The scopes are independent summaries (OCR m169): each does its own counts
      // against shared tables. R2-47: at most SUMMARY_CONCURRENCY at a time — the
      // old bare Promise.all put every scope's ~400 DB queries and ~2 upstream
      // requests on the wire at once; the bounded map keeps the failure semantics
      // (any scope failing fails the whole summary) without the stampede. The
      // project lookup is request-cached, so a scope key costs one upstream call
      // no matter how often the array names it.
      const projectCache = new Map<string, Promise<ProjectLookup>>();
      const getProject = (scope: ObservationScope): Promise<ProjectLookup> => {
        const hit = projectCache.get(scope.key);
        if (hit) return hit;
        const pending =
          deps.port?.retrieveProject(scope) ??
          Promise.resolve(PROJECT_PORTLESS);
        projectCache.set(scope.key, pending);
        return pending;
      };
      const bots = await mapWithConcurrency(
        scopes,
        SUMMARY_CONCURRENCY,
        (scope) => summarizeOne(scope, window, snapshot.readiness, getProject),
      );
      return {
        window: {
          from: window.from?.toISOString() ?? null,
          to: window.to?.toISOString() ?? null,
          botId,
        },
        collection: {
          readiness: {
            ready: snapshot.readiness.ready,
            reason: snapshot.readiness.ready ? null : snapshot.readiness.reason,
          },
          dropped: {
            queueFull: stats.droppedFull,
            notReady: stats.refusedNotReady,
          },
        },
        bots,
        botsTruncated: false,
      };
    },
  };
}
