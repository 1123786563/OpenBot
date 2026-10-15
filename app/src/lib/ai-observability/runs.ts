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
  RunSummary,
  RunsListResult,
  RunUsageReport,
} from "../../../../shared/ai-observability-runs";

import type {
  RunDetailResult,
  RunsListResult,
} from "../../../../shared/ai-observability-runs";

export const observationRunKeys = {
  all: ["ai-observability-runs"] as const,
  list: (botId: string, page: { cursor: string | null; limit: number }) =>
    ["ai-observability-runs", "list", botId, page] as const,
  detail: (botId: string, runId: string) =>
    ["ai-observability-runs", "detail", botId, runId] as const,
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

/** The server's error code, when it sent one in the house `{ error }` envelope. */
async function refusalCode(response: Response): Promise<string | null> {
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
 */
function isRunsListBody(body: unknown): body is RunsListResult {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<RunsListResult>;
  return (
    Array.isArray(candidate.runs) &&
    typeof candidate.pagination === "object" &&
    candidate.pagination !== null &&
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
  const upstream = (body as { upstream?: unknown }).upstream;
  if (typeof upstream !== "object" || upstream === null) return false;
  const status = (upstream as Record<string, unknown>).status;
  return (
    status === "present" || status === "unreconciled" || status === "absent"
  );
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
      return { view: "list", result: body };
    },
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
      return { view: "detail", result: body };
    },
  });
}
