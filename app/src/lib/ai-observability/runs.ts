import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/*
 * The runs chain's data module (#18 list, #19 detail, #24 steps). The wire contract —
 * RunSummary, RunsListResult and friends — lives in shared/ai-observability-runs.ts, the
 * one place the browser and server/src/ai-observability/queries/runs.ts agree on, so a
 * backend contract change is a change to that file and nothing here.
 *
 * A refusal from this endpoint is an answer, not a failure: 503 capability_missing is the
 * deployment saying tracing is off, a 403 is the management gate, a 502/503 upstream code
 * is the store failing to answer. So the query reads the status through tryClient and
 * returns the screen's verdict instead of throwing — the fault vocabulary the page renders
 * is decided here, once, and every fault keeps its own sentence (T02: the states are
 * distinct facts, never borrowed words).
 */

export type {
  RunCapabilityLevel,
  RunDetailResult,
  RunState,
  RunStep,
  RunStepExecutionState,
  RunStepKind,
  RunStepRetrieval,
  RunStepState,
  RunStepsResult,
  RunSummary,
  RunsListResult,
  RunUsageReport,
} from "../../../../shared/ai-observability-runs";

import type {
  RunCapabilityLevel,
  RunDetailResult,
  RunState,
  RunStep,
  RunStepExecutionState,
  RunStepKind,
  RunStepsResult,
  RunsListResult,
} from "../../../../shared/ai-observability-runs";

export const observationRunKeys = {
  all: ["ai-observability-runs"] as const,
  list: (botId: string, page: { cursor: string | null; limit: number }) =>
    ["ai-observability-runs", "list", botId, page] as const,
  detail: (botId: string, runId: string) =>
    ["ai-observability-runs", "detail", botId, runId] as const,
  steps: (botId: string, runId: string) =>
    ["ai-observability-runs", "steps", botId, runId] as const,
};

/** What the screen is allowed to conclude: the list itself, or the fault that explains it. */
export type ObservationRunsScreen =
  | { view: "list"; result: RunsListResult }
  | {
      view: "fault";
      fault: "disabled" | "forbidden" | "unavailable";
    };

/** The detail page's own conclusion: the run, or the fault that explains its absence. */
export type ObservationRunDetailScreen =
  | { view: "detail"; result: RunDetailResult }
  | {
      view: "fault";
      fault: "disabled" | "forbidden" | "notFound" | "unavailable";
    };

/** The step tree's own conclusion: the timeline, or the fault that explains its absence. */
export type ObservationRunStepsScreen =
  | { view: "steps"; result: { steps: readonly ObservationRunStep[] } }
  | {
      view: "fault";
      fault: "disabled" | "forbidden" | "notFound" | "unavailable";
    };

/**
 * A step after the read boundary's coercion: identical to the wire's RunStep except that a
 * kind this build has never heard of is null — the row renders unnamed rather than being
 * dropped (a missing row would invent a timeline that says the step never happened).
 */
export type ObservationRunStep = Omit<RunStep, "kind"> & {
  kind: RunStepKind | null;
};

/**
 * The server's error code, when it sent one in the house `{ error }` envelope. Shared by
 * the runs chain and the two #42 pages, so a refusal is read the same way everywhere.
 */
export async function refusalCode(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof body?.error === "string" ? body.error : null;
}

/*
 * Runtime shape defense on success bodies (the T12 review's L-2, closed here): the server is
 * the contract's source of truth, but a 200 whose body lost its key fields would otherwise
 * render a page of undefined. Key fields missing is the store failing to answer — the same
 * unavailable fault as any other non-answer, never a disguised empty page.
 *
 * The T13 review deepened this to the shapes that crash rather than render undefined. Those
 * split by what the body is claiming: a "present" without its payload objects, or a cursor
 * that is neither string nor null, is a promise the body breaks — the unavailable fault. A
 * state string this build has never heard of is not a broken promise (the vocabulary simply
 * moved on), so it fails closed to "unknown", the same word the server gives upstream
 * statuses it cannot name — never a crash, never a guess.
 *
 * The OCR round 1 review closed the last gap: the LIST guard validated only the envelope,
 * while the row reads (`run.metadata.run_id`, walking metadata values for their states,
 * `run.usage.source`) crash on a row that lost its own shape. So a row is a claim too, and
 * gets the same depth the detail and steps guards already had.
 */
function isSafeRecordBody(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(isSafeValueBody);
}

function isRunSummaryRow(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return false;
  const record = row as Record<string, unknown>;
  for (const field of ["opikTraceId", "state", "createdAt", "capability"]) {
    if (typeof record[field] !== "string") return false;
  }
  /*
   * R4-4, the list half of R3-13: the row's coverage cell renders
   * `capability.<verdict>` straight off the body, so an unknown word echoes the
   * raw key mid-list — the same half-drawn row the detail guard refuses below.
   * The verdict vocabulary is the binding table's closed set (same words, same
   * reason): a body carrying any other word is contract drift, the store failing
   * to answer, never a verdict to draw.
   */
  if (
    !KNOWN_CAPABILITY_LEVELS.includes(record.capability as RunCapabilityLevel)
  ) {
    return false;
  }
  if (
    record.durationMs !== "unavailable" &&
    typeof record.durationMs !== "number"
  ) {
    return false;
  }
  /*
   * The usage report is either the provider's numbers or the explicit absence — a "provider"
   * without its counts would crash the token cell, and an unknown source is a promise the
   * body breaks rather than a vocabulary to guess at.
   */
  const usage = record.usage;
  if (typeof usage !== "object" || usage === null) return false;
  const usageRecord = usage as Record<string, unknown>;
  if (usageRecord.source === "provider") {
    for (const field of ["promptTokens", "completionTokens", "totalTokens"]) {
      if (typeof usageRecord[field] !== "number") return false;
    }
  } else if (usageRecord.source !== "unavailable") {
    return false;
  }
  // metadata is a SafeRecord: the row walks its values for their states, so a metadata
  // entry that is not a SafeValue crashes the markers derivation — the store failing.
  return isSafeRecordBody(record.metadata);
}

/**
 * The coverage verdicts the binding table can issue — the shared RunCapabilityLevel,
 * a closed, database-backed vocabulary: a body carrying any other word is contract
 * drift, not a verdict to draw.
 *
 * The detail guard claims it (OCR round 3, R3-13) because two things the page does
 * depend on it being exactly these three words: the coverage row renders
 * `capability.<verdict>` as an i18n key, and the steps section's gates answer basic
 * and unavailable with their own sentences and only detailed coverage asks the store
 * for a timeline. Before the claim, a 200 whose run lost `capability` half-drew the
 * page — `capability.undefined` echoed literally — and undefined passed both gates,
 * firing a steps query for a report the binding never adjudicated. The summary row
 * guard reuses the same closed set (R4-4): its coverage cell speaks the identical
 * `capability.<verdict>` face, so the list refuses the same drift the detail does.
 */
const KNOWN_CAPABILITY_LEVELS: readonly RunCapabilityLevel[] = [
  "detailed",
  "basic",
  "unavailable",
];

function isRunsListBody(body: unknown): body is RunsListResult {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<RunsListResult>;
  if (!Array.isArray(candidate.runs)) return false;
  for (const row of candidate.runs) {
    if (!isRunSummaryRow(row)) return false;
  }
  if (
    typeof candidate.pagination !== "object" ||
    candidate.pagination === null
  ) {
    return false;
  }
  const pagination = candidate.pagination as Record<string, unknown>;
  /*
   * The range sentence arithmetic (`offset + 1 … offset + window.length` of `total`) is
   * only as honest as its numbers; NaN here would read as a fabricated range.
   */
  for (const field of ["total", "window", "offset", "limit"]) {
    if (typeof pagination[field] !== "number") return false;
  }
  /*
   * A missing cursor is not "no next page": undefined would slip past the page's null
   * checks and arm a Next button that fires an undefined cursor.
   */
  return (
    (pagination.nextCursor === null ||
      typeof pagination.nextCursor === "string") &&
    typeof candidate.syncing === "boolean"
  );
}

function isRunDetailBody(body: unknown): body is RunDetailResult {
  if (typeof body !== "object" || body === null) return false;
  const run = (body as { run?: unknown }).run;
  if (typeof run !== "object" || run === null) return false;
  const record = run as Record<string, unknown>;
  for (const field of [
    "runId",
    "attemptId",
    "traceId",
    "state",
    "createdAt",
    "updatedAt",
    "expiresAt",
  ]) {
    if (typeof record[field] !== "string") return false;
  }
  /*
   * The two fields the page reads for its coverage verdict but the guard never
   * claimed (OCR round 3, R3-13): capability must speak the binding table's closed
   * verdict vocabulary — an unknown word is the store failing to answer, never a
   * half-drawn page echoing `capability.<word>` — and the upstream trace binding is
   * a string or the explicit null ("not linked"), never an absent-or-garbled key.
   * The summary row guard has claimed capability all along; the detail guard now
   * keeps the same promise (T7 deepened the present branch but skipped these).
   */
  if (
    typeof record.capability !== "string" ||
    !KNOWN_CAPABILITY_LEVELS.includes(record.capability as RunCapabilityLevel)
  ) {
    return false;
  }
  if (record.opikTraceId !== null && typeof record.opikTraceId !== "string") {
    return false;
  }
  const upstream = (body as { upstream?: unknown }).upstream;
  if (typeof upstream !== "object" || upstream === null) return false;
  const status = (upstream as Record<string, unknown>).status;
  if (
    status !== "present" &&
    status !== "unreconciled" &&
    status !== "absent"
  ) {
    return false;
  }
  if (status !== "present") return true;
  /*
   * "present" is the promise that the upstream record rides along: a present whose
   * payload objects are missing would crash the page mid-render (reading usage.source,
   * walking metadata), so it is the store failing to answer, not a record to half-draw.
   * The present branch keeps the same per-value promises the summary row does (OCR
   * round 2, R2-06 ≡ R2-07): a metadata entry that is not a SafeValue crashes
   * projectedValueText's switch, a "provider" usage without its counts crashes the
   * token cell, and createdAt/durationMs promise "a value or the explicit word".
   */
  const present = upstream as Record<string, unknown>;
  if (
    typeof present.metadata !== "object" ||
    present.metadata === null ||
    Array.isArray(present.metadata)
  ) {
    return false;
  }
  if (!Object.values(present.metadata).every(isSafeValueBody)) return false;
  const usage = present.usage;
  if (typeof usage !== "object" || usage === null) return false;
  const usageRecord = usage as Record<string, unknown>;
  if (usageRecord.source === "provider") {
    for (const field of ["promptTokens", "completionTokens", "totalTokens"]) {
      if (typeof usageRecord[field] !== "number") return false;
    }
  } else if (usageRecord.source !== "unavailable") {
    return false;
  }
  return (
    (present.createdAt === "unavailable" ||
      typeof present.createdAt === "string") &&
    (present.durationMs === "unavailable" ||
      typeof present.durationMs === "number")
  );
}

/*
 * The states this build can name. A newer server may already speak one it has never heard
 * of, so an unnamed state is coerced at the query boundary — where the fault vocabulary is
 * decided — and every consumer (the icons, the states.* labels, the list's filters) sees a
 * state that exists, with the honest word "unknown" in place of the one it cannot say.
 */
const KNOWN_RUN_STATES: readonly RunState[] = [
  "running",
  "completed",
  "failed",
  "canceled",
  "interrupted",
  "unknown",
];

function toKnownState(state: RunState): RunState {
  return KNOWN_RUN_STATES.includes(state) ? state : "unknown";
}

export function observationRunsQueryOptions(
  botId: string,
  page: { cursor: string | null; limit: number },
) {
  return queryOptions({
    queryKey: observationRunKeys.list(botId, page),
    queryFn: async (): Promise<ObservationRunsScreen> => {
      const search = new URLSearchParams({ limit: String(page.limit) });
      if (page.cursor !== null) search.set("cursor", page.cursor);
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(botId)}/runs?${search}`,
      );
      if (
        response.status === 503 &&
        (await refusalCode(response)) === "capability_missing"
      ) {
        return { view: "fault", fault: "disabled" };
      }
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
        /*
         * 404 here is the manage-gate refusing to name a Bot this caller cannot manage —
         * the same refusal a stranger's probe hears, by design. A 401 means the session
         * ended; the _authed guard handles the redirect on the next navigation.
         */
        return { view: "fault", fault: "forbidden" };
      }
      if (!response.ok) {
        return { view: "fault", fault: "unavailable" };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isRunsListBody(body)) {
        // A malformed success is the store failing to answer, never an empty page.
        return { view: "fault", fault: "unavailable" };
      }
      return {
        view: "list",
        result: {
          ...body,
          runs: body.runs.map((row) => ({
            ...row,
            state: toKnownState(row.state),
          })),
        },
      };
    },
    /*
     * Spec A6, the creator chains' half (admin/exports opt in the same way): after a
     * permission narrows, the tab returning to the foreground re-asks, so a revoked
     * scope answers forbidden instead of riding its stale answer until the next
     * navigation — the app-wide QueryClient turns focus refetch off.
     */
    refetchOnWindowFocus: true,
  });
}

export function observationRunDetailQueryOptions(botId: string, runId: string) {
  return queryOptions({
    queryKey: observationRunKeys.detail(botId, runId),
    queryFn: async (): Promise<ObservationRunDetailScreen> => {
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(botId)}/runs/${encodeURIComponent(runId)}`,
      );
      if (
        response.status === 503 &&
        (await refusalCode(response)) === "capability_missing"
      ) {
        return { view: "fault", fault: "disabled" };
      }
      if (response.status === 401 || response.status === 403) {
        return { view: "fault", fault: "forbidden" };
      }
      if (response.status === 404) {
        /*
         * Two different 404s, kept different on purpose: RUN_NOT_FOUND is about the run
         * (this scope did not bind it, so it does not exist for this caller); the manage
         * gate's OBSERVATION_BOT_* 404 refuses to name a Bot this caller cannot manage —
         * the same refusal a stranger's probe hears, so it renders as forbidden.
         */
        return (await refusalCode(response)) === "RUN_NOT_FOUND"
          ? { view: "fault", fault: "notFound" }
          : { view: "fault", fault: "forbidden" };
      }
      if (!response.ok) {
        return { view: "fault", fault: "unavailable" };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isRunDetailBody(body)) {
        return { view: "fault", fault: "unavailable" };
      }
      return {
        view: "detail",
        result: {
          ...body,
          run: { ...body.run, state: toKnownState(body.run.state) },
        },
      };
    },
    /*
     * Spec A6, the creator chains' half (admin/exports opt in the same way): after a
     * permission narrows, the tab returning to the foreground re-asks, so a revoked
     * scope answers forbidden instead of riding its stale answer until the next
     * navigation — the app-wide QueryClient turns focus refetch off.
     */
    refetchOnWindowFocus: true,
  });
}

/*
 * The steps read (Issue #24) answers with the same refusal vocabulary as the detail it
 * hangs off: a 503 capability_missing is tracing off, a 401/403 the management gate, and a
 * 404 the same two-refusal split (RUN_NOT_FOUND is about the run, anything else is the
 * manage gate refusing to name the Bot). The shape defense follows the Q-M1 ruling: a
 * structurally broken body is the store failing to answer — the unavailable fault, never a
 * half-drawn timeline — while a vocabulary the build has never heard of fails closed to the
 * honest word (unknown / unobserved / an unnamed kind) exactly as an unnamed run state does.
 */
function isSafeValueBody(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const state = (value as Record<string, unknown>).state;
  return state === "projected" || state === "truncated" || state === "omitted";
}

function isRetrievalBody(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const retrieval = value as Record<string, unknown>;
  if (retrieval.outcome === "miss") return true;
  if (retrieval.outcome === "degraded")
    return typeof retrieval.reason === "string";
  if (retrieval.outcome !== "hit") return false;
  return (
    typeof retrieval.fragmentCount === "number" &&
    Array.isArray(retrieval.kbIds) &&
    retrieval.kbIds.every((id) => typeof id === "string")
  );
}

function isRunStepsBody(body: unknown): body is RunStepsResult {
  if (typeof body !== "object" || body === null) return false;
  const steps = (body as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return false;
  for (const step of steps) {
    if (typeof step !== "object" || step === null) return false;
    const record = step as Record<string, unknown>;
    for (const field of ["spanId", "state", "startedAt", "endedAt"]) {
      if (typeof record[field] !== "string") return false;
    }
    if (
      record.parentSpanId !== null &&
      typeof record.parentSpanId !== "string"
    ) {
      return false;
    }
    if (record.name !== null && typeof record.name !== "string") return false;
    if (
      record.executionState !== undefined &&
      typeof record.executionState !== "string"
    ) {
      return false;
    }
    if (
      record.input !== undefined &&
      record.input !== null &&
      !isSafeValueBody(record.input)
    ) {
      return false;
    }
    if (
      record.output !== undefined &&
      record.output !== null &&
      !isSafeValueBody(record.output)
    ) {
      return false;
    }
    if (record.retrieval !== undefined && !isRetrievalBody(record.retrieval)) {
      return false;
    }
  }
  return true;
}

const KNOWN_STEP_KINDS: readonly RunStepKind[] = ["model", "tool", "retrieval"];
const KNOWN_EXECUTION_STATES: readonly RunStepExecutionState[] = [
  "proposed",
  "executed",
  "unobserved",
];
const KNOWN_STEP_STATES: readonly RunStep["state"][] = [
  "completed",
  "failed",
  "canceled",
  "unknown",
];

/**
 * One step onto what this build can name. Vocabulary drift fails closed per fact — an
 * unheard terminal or determination renders its honest word, an unheard kind renders
 * unnamed — and T15's A3 invariant is enforced at the read boundary: a step not observed
 * as executed is never allowed to arrive claiming success, whatever the body said.
 */
function toKnownStep(step: RunStep): ObservationRunStep {
  const executionState =
    step.executionState !== undefined &&
    !KNOWN_EXECUTION_STATES.includes(step.executionState)
      ? "unobserved"
      : step.executionState;
  let state = KNOWN_STEP_STATES.includes(step.state) ? step.state : "unknown";
  if (executionState !== undefined && executionState !== "executed") {
    // Only an execution this deployment observed may be completed (A3); proposed and
    // unobserved are terminal unknown, never success.
    state = "unknown";
  }
  return {
    ...step,
    kind: KNOWN_STEP_KINDS.includes(step.kind) ? step.kind : null,
    state,
    executionState,
  };
}

export function observationRunStepsQueryOptions(botId: string, runId: string) {
  return queryOptions({
    queryKey: observationRunKeys.steps(botId, runId),
    queryFn: async (): Promise<ObservationRunStepsScreen> => {
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(botId)}/runs/${encodeURIComponent(runId)}/steps`,
      );
      if (
        response.status === 503 &&
        (await refusalCode(response)) === "capability_missing"
      ) {
        return { view: "fault", fault: "disabled" };
      }
      if (response.status === 401 || response.status === 403) {
        return { view: "fault", fault: "forbidden" };
      }
      if (response.status === 404) {
        // The same two-refusal split as the detail: RUN_NOT_FOUND is about the run.
        return (await refusalCode(response)) === "RUN_NOT_FOUND"
          ? { view: "fault", fault: "notFound" }
          : { view: "fault", fault: "forbidden" };
      }
      if (!response.ok) {
        return { view: "fault", fault: "unavailable" };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isRunStepsBody(body)) {
        return { view: "fault", fault: "unavailable" };
      }
      return { view: "steps", result: { steps: body.steps.map(toKnownStep) } };
    },
    /*
     * Spec A6, the creator chains' half (admin/exports opt in the same way): after a
     * permission narrows, the tab returning to the foreground re-asks, so a revoked
     * scope answers forbidden instead of riding its stale answer until the next
     * navigation — the app-wide QueryClient turns focus refetch off.
     */
    refetchOnWindowFocus: true,
  });
}
