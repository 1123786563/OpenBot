/**
 * The creator's read-only run query service (Issue #17 / DAG T11).
 *
 * Everything here answers through a trusted ObservationScope (T06) and the
 * authoritative run-binding table (T07): a run this scope did not bind is simply
 * not found, before any upstream call, so guessed ids learn nothing and no
 * upstream read can widen access. The only sanctioned way to reach Opik is the
 * OpikPort (T08) — and only its read operations; this surface performs no write
 * and accepts no caller-supplied upstream query, filter or locator, so it cannot
 * become an arbitrary upstream proxy. Upstream rows are untrusted values: state
 * maps fail-closed onto the T10 vocabulary, content survives only through the
 * T05 projection, and missing usage or duration is an explicit "unavailable",
 * never a zero that would claim the provider counted nothing.
 *
 * An unavailable upstream is an explainable error, never a disguised empty list;
 * only the port's verified 404 on the scope's project is a truthful empty page.
 * Pagination and the window cache are keyed by the scope (T06 `bindCursor` /
 * `cacheKey`), so a transfer, revocation or epoch bump makes outstanding cursors
 * and cached pages unreadable immediately — the old key space dies with the old
 * epoch. Producer credentials (T32) never appear here: reads carry the scope,
 * not the write-path credential.
 */
import type { RunBindingStore } from "../bindings";
import type { OpikConfig } from "../config";
import type { ObservationScope } from "../contracts";
import { ObservationScopeError } from "../contracts";
import type { OpikPort, OpikPortResult, OpikTraceRow } from "../opik-port";
import type { SafeRecord } from "../redaction";
import { projectSafeMetadata } from "../redaction";
import type { AttemptRunState } from "../run-lifecycle";
import { bindCursor, cacheKey, readCursor } from "../scope";

/** The upstream window this deployment is willing to fetch per read. */
export const DEFAULT_RUNS_WINDOW = 100;
/** The client-facing page contract: an explicit cap, not a silent clamp. */
export const MAX_RUNS_LIMIT = 100;
const CACHE_CAPACITY = 128;

export type RunsQueryErrorCode =
  /** T09: the integration is off, unconfigured, or no verified port backs it. */
  | "capability_missing"
  | "RUNS_QUERY_INPUT_INVALID"
  | "RUN_NOT_FOUND"
  | "OPIK_TIMEOUT"
  | "OPIK_UNREACHABLE"
  | "OPIK_UPSTREAM_ERROR"
  | "OPIK_CLIENT_ERROR"
  | "OPIK_MALFORMED_RESPONSE"
  | "OPIK_OWNERSHIP_DRIFT";

/** House convention: the code is the contract; nothing else rides along. */
export class RunsQueryError extends Error {
  constructor(
    public code: RunsQueryErrorCode,
    public status: 400 | 402 | 403 | 404 | 502 | 503,
  ) {
    super(code);
  }
}

/** Provider usage as reported upstream, or the explicit absence of a report. */
export type RunUsageReport =
  | {
      source: "provider";
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }
  | { source: "unavailable" };

/** One upstream trace row, reduced to what may safely be shown. */
export type RunSummary = {
  opikTraceId: string;
  state: AttemptRunState;
  durationMs: number | "unavailable";
  usage: RunUsageReport;
  metadata: SafeRecord;
};

export type RunsListResult = {
  runs: readonly RunSummary[];
  pagination: {
    /** Upstream's own count of the scope's traces — the truth, not the window. */
    total: number;
    /** How many rows the servable window actually holds. */
    window: number;
    offset: number;
    limit: number;
    nextCursor: string | null;
  };
};

export type RunDetailResult = {
  run: {
    runId: string;
    attemptId: string;
    traceId: string;
    opikTraceId: string | null;
    capability: string;
    state: AttemptRunState;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
  };
  upstream:
    | ({ status: "present" } & RunSummary)
    | { status: "unreconciled" }
    | { status: "absent" };
};

export type RunsQueryServiceDeps = Readonly<{
  /** T07's authoritative ownership seam: a run this scope did not bind is not found. */
  bindings: Pick<RunBindingStore, "latestAttempt">;
  config: () => OpikConfig;
  /** The verified port, or null when no verified contract backs this deployment. */
  port: OpikPort | null;
  /** Upstream fetch size per window. Default 100. */
  windowSize?: number;
  /** Window cache TTL. Default 5s — enough for list→detail locality, no staleness story. */
  cacheTtlMs?: number;
  now?: () => Date;
}>;

export type RunsQueryService = {
  list(
    scope: ObservationScope,
    input: { cursor?: string; limit?: number },
  ): Promise<RunsListResult>;
  detail(scope: ObservationScope, runId: string): Promise<RunDetailResult>;
};

type CachedWindow = {
  at: number;
  projectId: string | null;
  rows: readonly OpikTraceRow[];
  total: number;
};

/** Upstream status onto the T10 vocabulary. Unrecognized is unknown, never a guess. */
function runStateFromUpstream(status: unknown): AttemptRunState {
  if (status === "COMPLETED" || status === "OK") return "completed";
  if (status === "ERROR") return "failed";
  if (status === "IN_PROGRESS" || status === "RUNNING") return "running";
  return "unknown";
}

const USAGE_UNAVAILABLE: RunUsageReport = { source: "unavailable" };

/** Missing, partial or non-numeric usage is an explicit unavailable — never zeros. */
function usageFromUpstream(usage: unknown): RunUsageReport {
  if (typeof usage !== "object" || usage === null) return USAGE_UNAVAILABLE;
  const { prompt_tokens, completion_tokens, total_tokens } = usage as Record<
    string,
    unknown
  >;
  if (
    typeof prompt_tokens !== "number" ||
    typeof completion_tokens !== "number" ||
    typeof total_tokens !== "number" ||
    !Number.isFinite(prompt_tokens) ||
    !Number.isFinite(completion_tokens) ||
    !Number.isFinite(total_tokens)
  ) {
    return USAGE_UNAVAILABLE;
  }
  return {
    source: "provider",
    promptTokens: prompt_tokens,
    completionTokens: completion_tokens,
    totalTokens: total_tokens,
  };
}

/** The sanctioned duration field (T05 allowlist), raw and validated. */
function durationFromUpstream(metadata: unknown): number | "unavailable" {
  if (typeof metadata === "object" && metadata !== null) {
    const duration = (metadata as Record<string, unknown>).duration_ms;
    if (typeof duration === "number" && Number.isFinite(duration)) {
      return duration;
    }
  }
  return "unavailable";
}

function projectRow(row: OpikTraceRow): RunSummary {
  return {
    opikTraceId: row.id,
    state: runStateFromUpstream(row.status),
    durationMs: durationFromUpstream(row.metadata),
    usage: usageFromUpstream(row.usage),
    metadata: projectSafeMetadata(row.metadata),
  };
}

export function createRunsQueryService(
  deps: RunsQueryServiceDeps,
): RunsQueryService {
  const windowSize = deps.windowSize ?? DEFAULT_RUNS_WINDOW;
  const cacheTtlMs = deps.cacheTtlMs ?? 5_000;
  const now = deps.now ?? (() => new Date());
  const cache = new Map<string, CachedWindow>();

  /** The T09 gate: off, unconfigured or portless deployments answer capability_missing. */
  const gate = () => {
    const config = deps.config();
    if (!config.enabled || config.baseUrl === null || deps.port === null) {
      throw new RunsQueryError("capability_missing", 503);
    }
  };

  /** Every port failure becomes an explainable code; none becomes an empty page. */
  const unwrap = <T>(result: OpikPortResult<T>): T => {
    switch (result.outcome) {
      case "ok":
        return result.value;
      case "unavailable":
        throw new RunsQueryError(result.code, 503);
      case "upstream_error":
        throw new RunsQueryError(result.code, 502);
      case "malformed":
        throw new RunsQueryError(result.code, 502);
      case "ownership_drift":
        throw new RunsQueryError(result.code, 503);
    }
  };

  /**
   * The scope's servable window: the port's one verified listing operation over
   * the scope-derived project, cached under the scope key so an epoch bump
   * orphans it by construction.
   */
  const window = async (scope: ObservationScope): Promise<CachedWindow> => {
    const key = cacheKey(scope, "runs-window");
    const hit = cache.get(key);
    if (hit && now().getTime() - hit.at < cacheTtlMs) return hit;
    const port = deps.port;
    if (port === null) throw new RunsQueryError("capability_missing", 503);

    const project = unwrap(await port.retrieveProject(scope));
    let fresh: CachedWindow;
    if (project === null) {
      // The verified 404 on the scope's own project: no records exist. A
      // truthful empty window — the one empty that is not a disguise.
      fresh = { at: now().getTime(), projectId: null, rows: [], total: 0 };
    } else {
      const page = unwrap(
        await port.listTraces(scope, {
          projectId: project.id,
          size: windowSize,
        }),
      );
      fresh = {
        at: now().getTime(),
        projectId: project.id,
        rows: page.content,
        total: page.total,
      };
    }
    cache.set(key, fresh);
    if (cache.size > CACHE_CAPACITY) {
      cache.delete(cache.keys().next().value as string);
    }
    return fresh;
  };

  const list = async (
    scope: ObservationScope,
    input: { cursor?: string; limit?: number },
  ): Promise<RunsListResult> => {
    gate();
    let offset = 0;
    if (input.cursor !== undefined && input.cursor !== "") {
      // T06 downstream obligation: another scope's, another epoch's, a tampered
      // or restart-orphaned cursor is an authorization failure — 403, never a
      // silent return to page one and never a fake empty page.
      const payload = readCursor(scope, input.cursor);
      offset = Number.parseInt(payload, 10);
      if (!Number.isInteger(offset) || offset < 0) {
        throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
      }
    }
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUNS_LIMIT) {
      throw new RunsQueryError("RUNS_QUERY_INPUT_INVALID", 400);
    }
    const current = await window(scope);
    const rows = current.rows.slice(offset, offset + limit);
    const nextCursor =
      offset + limit < current.rows.length
        ? bindCursor(scope, String(offset + limit))
        : null;
    return {
      runs: rows.map(projectRow),
      pagination: {
        total: current.total,
        window: current.rows.length,
        offset,
        limit,
        nextCursor,
      },
    };
  };

  const detail = async (
    scope: ObservationScope,
    runId: string,
  ): Promise<RunDetailResult> => {
    gate();
    // Ownership first, upstream second: the authoritative table answers before
    // any network I/O, so a guessed id costs nothing and learns nothing.
    const binding = await deps.bindings.latestAttempt(scope, runId);
    if (binding === null) {
      throw new RunsQueryError("RUN_NOT_FOUND", 404);
    }
    const run: RunDetailResult["run"] = {
      runId: binding.runId,
      attemptId: binding.attemptId,
      traceId: binding.traceId,
      opikTraceId: binding.opikTraceId,
      capability: binding.capability,
      state: binding.state,
      createdAt: binding.createdAt.toISOString(),
      updatedAt: binding.updatedAt.toISOString(),
      expiresAt: binding.expiresAt.toISOString(),
    };
    if (binding.opikTraceId === null) {
      // Begun locally, never reconciled upstream: explicit, not an error and
      // not a fabricated empty projection. Upstream is not asked.
      return { run, upstream: { status: "unreconciled" } };
    }
    const current = await window(scope);
    const row = current.rows.find((item) => item.id === binding.opikTraceId);
    if (row === undefined) {
      // Reconciled, but outside the servable window: say so rather than
      // pretending the trace is gone.
      return { run, upstream: { status: "absent" } };
    }
    const summary = projectRow(row);
    // The upstream copy is the closed one; when it is visible its observed
    // state is the actual state, and the local row keeps the refs.
    return {
      run: { ...run, state: summary.state },
      upstream: { status: "present", ...summary },
    };
  };

  return { list, detail };
}
