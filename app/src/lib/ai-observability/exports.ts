import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/*
 * The export status page's data module (#42). The wire contract is the T34 job projection,
 * mirrored in shared/ai-observability-admin.ts: states queued/running/completed/failed/
 * cancelled, a closed-vocabulary error code exactly when failed, and the artifact riding
 * along exactly when completed.
 *
 * A refusal from this endpoint is an answer, not a failure: 401/403/404 is the manage gate
 * refusing to widen (a directly typed URL to someone else's Bot hears it on the first
 * load), anything else is the store failing to answer.
 *
 * The query polls while any job is still in flight, which is how a permission change
 * reaches the page: the poll's next answer is the refusal, and because a refusal replaces
 * the data rather than throwing beside it, no stale row survives the flip.
 */

export type {
  AdminExportJobState,
  ExportJobView,
} from "../../../../shared/ai-observability-admin";

import type { ExportJobView } from "../../../../shared/ai-observability-admin";

export const observationExportKeys = {
  all: ["ai-observability-exports"] as const,
  list: (botId: string) => ["ai-observability-exports", "list", botId] as const,
};

/** What the screen is allowed to conclude: the jobs, or the fault that explains them. */
export type ObservationExportsScreen =
  | { view: "list"; jobs: readonly ExportJobView[] }
  | { view: "fault"; fault: "forbidden" | "unavailable" };

const EXPORT_JOB_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJobView(value: unknown): value is ExportJobView {
  if (!isRecord(value)) return false;
  if (typeof value.jobId !== "string") return false;
  if (
    typeof value.state !== "string" ||
    !(EXPORT_JOB_STATES as readonly string[]).includes(value.state)
  ) {
    return false;
  }
  if (typeof value.rowLimit !== "number" || typeof value.createdAt !== "string")
    return false;
  if (value.rowCount !== null && typeof value.rowCount !== "number") {
    return false;
  }
  if (value.settledAt !== null && typeof value.settledAt !== "string")
    return false;
  if (value.errorCode !== null && typeof value.errorCode !== "string")
    return false;
  if (value.artifact !== undefined && !Array.isArray(value.artifact))
    return false;
  return true;
}

/** The default in-flight poll; tests shrink it to keep the flip fast. */
export const EXPORT_POLL_MS = 5_000;

export function observationExportsQueryOptions(
  botId: string,
  pollMs: number = EXPORT_POLL_MS,
) {
  return queryOptions({
    queryKey: observationExportKeys.list(botId),
    queryFn: async (): Promise<ObservationExportsScreen> => {
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(botId)}/exports`,
      );
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
        /*
         * The manage gate's unified not-found: a Bot this caller cannot manage does not
         * exist for them, which for the page is the forbidden answer. A queued or running
         * job behind a scope that just ended settles cancelled on the server; the page's
         * job is only to stop showing rows the refusal now disowns.
         */
        return { view: "fault", fault: "forbidden" };
      }
      if (!response.ok) {
        return { view: "fault", fault: "unavailable" };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isRecord(body) || !Array.isArray(body.jobs)) {
        return { view: "fault", fault: "unavailable" };
      }
      if (!body.jobs.every((job) => isJobView(job))) {
        /*
         * A state word this build has never heard of is not a row to half-draw — the
         * server's own projection is fail-closed on it, so a 200 carrying one is a body
         * this page cannot read, the unavailable fault rather than a guess.
         */
        return { view: "fault", fault: "unavailable" };
      }
      return { view: "list", jobs: body.jobs };
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.view === "list" &&
        data.jobs.some(
          (job) => job.state === "queued" || job.state === "running",
        )
        ? pollMs
        : false;
    },
  });
}
