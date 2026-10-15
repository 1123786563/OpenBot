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

import type { RunsListResult } from "../../../../shared/ai-observability-runs";

export const observationRunKeys = {
  all: ["ai-observability-runs"] as const,
  list: (botId: string, page: { cursor: string | null; limit: number }) =>
    ["ai-observability-runs", "list", botId, page] as const,
};

/** What the screen is allowed to conclude: the list itself, or the fault that explains it. */
export type ObservationRunsScreen =
  | { view: "list"; result: RunsListResult }
  | {
      view: "fault";
      fault: "disabled" | "forbidden" | "unavailable";
    };

/** The server's error code, when it sent one in the house `{ error }` envelope. */
async function refusalCode(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof body?.error === "string" ? body.error : null;
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
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        // A malformed success is the store failing to answer, never an empty page.
        return { view: "fault", fault: "unavailable" };
      }
      return { view: "list", result: body as RunsListResult };
    },
  });
}
