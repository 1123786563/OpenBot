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

import type { SafeValue } from "../../../../shared/ai-observability";
import type {
  RunCapabilityLevel,
  RunDetailResult,
  RunStep,
  RunStepKind,
  RunStepRetrieval,
  RunStepState,
  RunStepsResult,
  RunSummary,
  RunsListResult,
  RunUsageReport,
} from "../../../../shared/ai-observability-runs";
import type { RunBindingStore } from "../bindings";
import type { OpikConfig } from "../config";
import type { ObservationScope } from "../contracts";
import { ObservationScopeError } from "../contracts";
import type {
  OpikPort,
  OpikPortResult,
  OpikSpanRow,
  OpikTraceRow,
} from "../opik-port";
import { projectSafeMetadata, projectSafeText } from "../redaction";
import type { AttemptRunState } from "../run-lifecycle";
import { bindCursor, cacheKey, readCursor, scopeCacheKey } from "../scope";

/** The upstream window this deployment is willing to fetch per read. */
export const DEFAULT_RUNS_WINDOW = 100;
/** The client-facing page contract: an explicit cap, not a silent clamp. */
export const MAX_RUNS_LIMIT = 100;
/** The span-walk ceiling: defensive only, the retention window bounds real totals. */
const MAX_SPAN_PAGES = 100;
const CACHE_CAPACITY = 128;

export type RunsQueryErrorCode =
  /** T09: the integration is off, unconfigured, or no verified port backs it. */
  | "capability_missing"
  | "RUNS_QUERY_INPUT_INVALID"
  /** Issue #18: a filter was named that the verified port cannot pass upstream today. */
  | "RUNS_QUERY_FILTER_UNSUPPORTED"
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
    public status: 400 | 402 | 403 | 404 | 422 | 502 | 503,
  ) {
    super(code);
  }
}

/*
 * The wire contract lives in shared/ai-observability-runs.ts — the one place the browser
 * and this service agree on (Issue #18: a contract change is a change there first). It is
 * re-exported so the server's own import surface keeps its historical spelling.
 */
export type {
  RunCapabilityLevel,
  RunDetailResult,
  RunState,
  RunSummary,
  RunsListResult,
  RunUsageReport,
} from "../../../../shared/ai-observability-runs";

export type RunsQueryServiceDeps = Readonly<{
  /** T07's authoritative ownership seam: a run this scope did not bind is not found. */
  bindings: Pick<RunBindingStore, "latestAttempt"> &
    /*
     * Issue #18's optional joins: row-level capability and the list-level syncing count.
     * Optional because they are additive reads — a wiring (or parallel stream) that
     * injects only the historical seam still answers, with capability failing closed to
     * "unavailable" and syncing to false, exactly like an unverified verdict elsewhere.
     */
    Partial<
      Pick<RunBindingStore, "capabilitiesByOpikTraceIds" | "countUnreconciled">
    >;
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
  /**
   * The run's step timeline (Issue #24 / T18-server): the bound trace's spans, read
   * back over the port and projected mechanically onto the wire's step shapes. The
   * same ownership discipline as detail — the binding answers before any upstream
   * call — and never cached: a step read is per-trace, with no list→detail locality
   * to exploit.
   */
  steps(scope: ObservationScope, runId: string): Promise<RunStepsResult>;
  /**
   * Drop the scope's cached window: the M1 deletion precondition's invalidation
   * target. The very next read goes upstream again, so a deletion that just
   * changed the data face is served, not the pre-deletion page. Wiring (T33)
   * hands this to the retention worker's `invalidateReads` seam.
   */
  invalidate(scope: ObservationScope): void;
  /**
   * The same drop from the stored scope key alone — the entry point the
   * retention worker's `invalidateReads` seam actually reaches: a deletion
   * record freezes a scope key, never a scope object.
   */
  invalidateKey(scopeKey: string): void;
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

/**
 * The upstream start time (Issue #18). A string that parses as a date is normalized to
 * ISO; anything else — missing, a number, a lie — is an explicit unavailable, never a
 * fabricated time. The value is display data, not authorization, so it survives as text.
 */
function createdAtFromUpstream(row: OpikTraceRow): string | "unavailable" {
  const started = row.start_time;
  if (typeof started !== "string") return "unavailable";
  const parsed = Date.parse(started);
  if (Number.isNaN(parsed)) return "unavailable";
  return new Date(parsed).toISOString();
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

/**
 * One upstream trace row onto what may safely be shown. The one projection the
 * read paths share: T11's query surface serves it directly, and T34's export
 * freezes it into artifacts — so an export can never carry anything the query
 * surface would have refused.
 */
export function projectRow(
  row: OpikTraceRow,
  capability: RunCapabilityLevel = "unavailable",
): RunSummary {
  return {
    opikTraceId: row.id,
    state: runStateFromUpstream(row.status),
    createdAt: createdAtFromUpstream(row),
    durationMs: durationFromUpstream(row.metadata),
    usage: usageFromUpstream(row.usage),
    capability,
    metadata: projectSafeMetadata(row.metadata),
  };
}

/*
 * The step projection (Issue #24 / T18-server). The recorder families the tree renders are
 * named by the spans themselves: T14's model spans (`model:<id>`) and T15's steps (`tool:<name>`,
 * bare `retrieval`). A span outside those families is not a recorded step — it is dropped,
 * never invented into the timeline. The T15 attributes ride inside the span row's `input`
 * object (the verified OTLP read-back shape); anything else there is untrusted data.
 */

/** The recorder families, read off the span name the recorders themselves write. */
function stepFamily(name: unknown): RunStepKind | null {
  if (typeof name !== "string") return null;
  if (name === "retrieval") return "retrieval";
  if (name === "tool" || name.startsWith("tool:")) return "tool";
  if (name === "model" || name.startsWith("model:")) return "model";
  return null;
}

/** The display name: the span's own name minus its kind prefix. Empty folds into null (L-3). */
function stepDisplayName(kind: RunStepKind, name: unknown): string | null {
  if (typeof name !== "string") return null;
  const stripped =
    kind === "retrieval" ? "" : name.slice(name.indexOf(":") + 1);
  return stripped.trim() === "" ? null : stripped;
}

/** The attribute carrier: a non-object `input` is a row without recorder attributes. */
function stepAttributes(row: OpikSpanRow): Record<string, unknown> {
  return typeof row.input === "object" && row.input !== null
    ? (row.input as Record<string, unknown>)
    : {};
}

/** T05 on read: content rides the wire only through the projection, deny patterns first. */
function stepContent(value: unknown): SafeValue | null {
  if (typeof value !== "string") return null;
  const safe = projectSafeText(value, { allowFreeText: true });
  if (safe.state === "omitted") return safe;
  if (safe.state === "truncated") {
    return {
      state: "truncated",
      value: safe.text,
      originalBytes: safe.originalBytes,
    };
  }
  return { state: "projected", value: safe.text };
}

/** The retrieval outcome summary, in T15's shapes; a half-said outcome makes no claim. */
function stepRetrieval(
  attributes: Record<string, unknown>,
): RunStepRetrieval | undefined {
  const outcome = attributes.retrieval_outcome;
  if (outcome === "miss") return { outcome: "miss" };
  if (outcome === "degraded") {
    const reason = attributes.degraded_reason;
    if (typeof reason !== "string") return undefined;
    const safe = projectSafeText(reason, { allowFreeText: true });
    return safe.state === "omitted"
      ? undefined
      : { outcome: "degraded", reason: safe.text };
  }
  if (outcome === "hit") {
    const count = attributes.fragment_count;
    const kbIds = attributes.kb_ids;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      return undefined;
    }
    if (!Array.isArray(kbIds) || !kbIds.every((id) => typeof id === "string")) {
      return undefined;
    }
    return { outcome: "hit", fragmentCount: count, kbIds };
  }
  return undefined;
}

/**
 * One span row onto the wire's step. A row without its window (start/end) is the store
 * failing to answer, not a step without a time; terminal vocabulary and T15's determination
 * fail closed onto the words this build can say, and A3 holds at the read boundary: only an
 * execution this deployment observed may keep a terminal state, whatever the row claims.
 */
function projectStep(row: OpikSpanRow): RunStep | null {
  const kind = stepFamily(row.name);
  if (kind === null) return null;
  const attributes = stepAttributes(row);
  if (typeof row.start_time !== "string" || typeof row.end_time !== "string") {
    throw new RunsQueryError("OPIK_MALFORMED_RESPONSE", 502);
  }
  const determination = attributes.execution_state;
  const executionState =
    determination === "proposed" ||
    determination === "executed" ||
    determination === "unobserved"
      ? determination
      : undefined;
  const recorded = attributes.span_state;
  const terminal: RunStepState =
    recorded === "completed" ||
    recorded === "failed" ||
    recorded === "canceled" ||
    recorded === "unknown"
      ? recorded
      : "unknown";
  const state: RunStepState =
    kind === "tool" && executionState !== "executed" ? "unknown" : terminal;
  // Input rides with the attributes (row.input.input); output is the attribute the
  // upstream mapper lifts into its own field (row.output.output). A retrieval step
  // records a query only — its hit summary rides `retrieval`, never an output.
  const input = stepContent(attributes.input);
  const output =
    kind === "retrieval"
      ? null
      : typeof row.output === "object" && row.output !== null
        ? stepContent((row.output as Record<string, unknown>).output)
        : null;
  const retrieval =
    kind === "retrieval" ? stepRetrieval(attributes) : undefined;
  return {
    kind,
    spanId: row.id,
    parentSpanId:
      typeof row.parent_span_id === "string" ? row.parent_span_id : null,
    name: stepDisplayName(kind, row.name),
    state,
    startedAt: row.start_time,
    endedAt: row.end_time,
    ...(executionState !== undefined ? { executionState } : {}),
    ...(input !== null ? { input } : {}),
    ...(output !== null ? { output } : {}),
    ...(retrieval !== undefined ? { retrieval } : {}),
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
    /*
     * Issue #18's two page facts, answered per request so a transfer or revocation is
     * effective on the very next call: the capability verdicts joined from this scope's
     * own binding rows (an unbound trace is the honest "unavailable", never a guess), and
     * whether bindings exist that never reconciled upstream — the "still syncing" signal.
     */
    const verdicts = deps.bindings.capabilitiesByOpikTraceIds;
    const joined = verdicts
      ? await verdicts(
          scope,
          rows.map((row) => row.id),
        )
      : null;
    const unreconciled = deps.bindings.countUnreconciled;
    const syncing = unreconciled ? (await unreconciled(scope)) > 0 : false;
    return {
      runs: rows.map((row) =>
        projectRow(row, joined?.get(row.id) ?? "unavailable"),
      ),
      pagination: {
        total: current.total,
        window: current.rows.length,
        offset,
        limit,
        nextCursor,
      },
      syncing,
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
    const summary = projectRow(row, binding.capability);
    // The upstream copy is the closed one; when it is visible its observed
    // state is the actual state, and the local row keeps the refs.
    return {
      run: { ...run, state: summary.state },
      upstream: { status: "present", ...summary },
    };
  };

  const steps = async (
    scope: ObservationScope,
    runId: string,
  ): Promise<RunStepsResult> => {
    gate();
    // Ownership first, upstream second — same discipline as detail: a guessed run
    // id answers not-found before any network I/O.
    const binding = await deps.bindings.latestAttempt(scope, runId);
    if (binding === null) {
      throw new RunsQueryError("RUN_NOT_FOUND", 404);
    }
    if (binding.opikTraceId === null) {
      // Begun locally, never reconciled upstream: an honest empty timeline, and
      // upstream is not asked.
      return { steps: [] };
    }
    const port = deps.port;
    if (port === null) throw new RunsQueryError("capability_missing", 503);
    const project = unwrap(await port.retrieveProject(scope));
    if (project === null) {
      // The verified 404 on the scope's own project: the truthful empty, the
      // one that is not a disguise.
      return { steps: [] };
    }
    // Walk the envelope until the trace's spans are covered; a page that never
    // arrives whole keeps asking rather than truncating the timeline. The page
    // ceiling is defensive only — the retention window bounds real totals.
    const rows: OpikSpanRow[] = [];
    let page = 1;
    for (;;) {
      const result = unwrap(
        await port.listSpans(scope, {
          projectId: project.id,
          traceId: binding.opikTraceId,
          size: windowSize,
          page,
        }),
      );
      rows.push(...result.content);
      if (
        rows.length >= result.total ||
        result.content.length === 0 ||
        page >= MAX_SPAN_PAGES
      ) {
        break;
      }
      page += 1;
    }
    // First occurrence wins on a duplicate span id (L-4): the row answers once,
    // never a keyed warning downstream.
    const seen = new Set<string>();
    const projected: RunStep[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const step = projectStep(row);
      if (step !== null) projected.push(step);
    }
    // Upstream rows arrive newest-first; the wire answers the chronology. A
    // start time that will not parse keeps the wire order (stable sort).
    projected.sort((a, b) => {
      const left = Date.parse(a.startedAt);
      const right = Date.parse(b.startedAt);
      if (Number.isNaN(left) || Number.isNaN(right)) return 0;
      return left - right;
    });
    return { steps: projected };
  };

  /** The M1 precondition's target: the exact key the window caches under. */
  const invalidate = (scope: ObservationScope) => {
    cache.delete(cacheKey(scope, "runs-window"));
  };

  const invalidateKey = (scopeKey: string) => {
    cache.delete(scopeCacheKey(scopeKey, "runs-window"));
  };

  return { list, detail, steps, invalidate, invalidateKey };
}
