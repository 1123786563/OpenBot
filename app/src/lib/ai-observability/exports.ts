import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/*
 * The export status page's data module (#42). The wire contract is the T34 job
 * projection as the LIST answers it (R2-40): states queued/running/completed/
 * failed/cancelled, a closed-vocabulary error code exactly when failed — and no
 * artifact inline, ever. A completed row instead names the detail endpoint in
 * artifactUrl, and that is the one place the rows ride; the download below is
 * the page's only consumer of them.
 *
 * A refusal from this endpoint is an answer, not a failure: 401/403/404 is the manage gate
 * refusing to widen (a directly typed URL to someone else's Bot hears it on the first
 * load), anything else is the store failing to answer.
 *
 * The query polls while any job in the scope is still in flight — on the page the
 * reader sees, or (OCR round 3, R3-07 ≡ R3-14) beyond its window, which the read
 * finds by walking the remaining pages whenever the visible one is quiet but the
 * scope continues. The poll is how a permission change reaches the page: the poll's
 * next answer is the refusal, and because a refusal replaces the data rather than
 * throwing beside it, no stale row survives the flip.
 */

export type {
  AdminExportJobState,
  ExportJobListItem,
  ExportJobsResult,
} from "../../../../shared/ai-observability-admin";

import type {
  ExportJobListItem,
  ExportJobsResult,
} from "../../../../shared/ai-observability-admin";

export const observationExportKeys = {
  all: ["ai-observability-exports"] as const,
  list: (botId: string) => ["ai-observability-exports", "list", botId] as const,
};

/** What the screen is allowed to conclude: the jobs, or the fault that explains them. */
export type ObservationExportsScreen =
  | {
      view: "list";
      jobs: readonly ExportJobListItem[];
      /** The window facts the read was answered with (OCR round 3, R3-07 ≡ R3-14). */
      pagination: ExportJobsResult["pagination"];
      /** An in-flight job this page's window does not show — the poll's other half. */
      offPageInFlight: boolean;
    }
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

function isJobListItem(value: unknown): value is ExportJobListItem {
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
  /*
   * R2-40's shape, fail-closed (R2fix F-1): the artifactUrl is the download's
   * only route to the rows, so a completed row without it is a body this page
   * cannot act on — the unavailable fault, never a button that would save an
   * empty file. On any other state the key is simply absent.
   */
  if (value.state === "completed") {
    return typeof value.artifactUrl === "string";
  }
  return (
    value.artifactUrl === undefined || typeof value.artifactUrl === "string"
  );
}

/** The default in-flight poll; tests shrink it to keep the flip fast. */
export const EXPORT_POLL_MS = 5_000;

/**
 * The window the page reads. The server's own default (DEFAULT_EXPORTS_LIMIT = 20),
 * now named in the request instead of implied — R3-07 ≡ R3-14's first half: the
 * pagination contract is consumed, starting with asking for a window by name.
 */
const EXPORTS_PAGE_LIMIT = 20;

/** A job the page must keep an eye on: queued or running, not yet settled. */
const inFlight = (job: ExportJobListItem) =>
  job.state === "queued" || job.state === "running";

function isExportsPagination(
  value: unknown,
): value is ExportJobsResult["pagination"] {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  for (const field of ["total", "offset", "limit"]) {
    if (typeof record[field] !== "number") return false;
  }
  return record.nextOffset === null || typeof record.nextOffset === "number";
}

/**
 * One page of the list face, read and shape-defended. The request names its window
 * (`limit`/`offset`), and a 200 must carry the offset facts back — a body without
 * its pagination is a claim this page cannot size, the unavailable fault rather
 * than a list that silently pretends it is the whole scope.
 */
async function fetchExportsPage(
  botId: string,
  offset: number,
): Promise<ObservationExportsScreen> {
  const response = await tryClient(
    `/api/ai-observability/bots/${encodeURIComponent(botId)}/exports?limit=${EXPORTS_PAGE_LIMIT}&offset=${offset}`,
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
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>).jobs) ||
    !isExportsPagination((body as Record<string, unknown>).pagination)
  ) {
    return { view: "fault", fault: "unavailable" };
  }
  const list = body as ExportJobsResult;
  if (!list.jobs.every((job) => isJobListItem(job))) {
    /*
     * A state word this build has never heard of is not a row to half-draw — the
     * server's own projection is fail-closed on it, so a 200 carrying one is a body
     * this page cannot read, the unavailable fault rather than a guess.
     */
    return { view: "fault", fault: "unavailable" };
  }
  return {
    view: "list",
    jobs: list.jobs,
    pagination: list.pagination,
    offPageInFlight: false,
  };
}

export function observationExportsQueryOptions(
  botId: string,
  pollMs: number = EXPORT_POLL_MS,
) {
  return queryOptions({
    queryKey: observationExportKeys.list(botId),
    queryFn: async (): Promise<ObservationExportsScreen> => {
      const first = await fetchExportsPage(botId, 0);
      if (first.view !== "list") return first;
      /*
       * R3-07 ≡ R3-14's poll half: the poll must not close just because the visible
       * page looks quiet — the list is a window over the scope's jobs, and an
       * in-flight job beyond it would otherwise settle unobserved. When this page
       * holds nothing in flight but the scope continues, the remaining pages are
       * walked once per decision; anything in flight found out there (or a page
       * that will not answer — unknown keeps asking, the fail-closed direction
       * every guard here takes) holds the poll open, and a scope that is settled
       * everywhere closes it as before.
       *
       * The walk is bounded three ways so a hostile or drifting nextOffset chain
       * cannot spin it: each offset is visited at most once (cycles end), the walk
       * never steps past the scope's reported total (beyond it there is nothing),
       * and a scope too big for the visit budget answers conservatively — keep
       * polling — instead of walking forever.
       */
      let offPageInFlight = false;
      if (!first.jobs.some(inFlight)) {
        const visited = new Set<number>([0]);
        const budget = 200;
        let next = first.pagination.nextOffset;
        while (
          next !== null &&
          next < first.pagination.total &&
          !visited.has(next) &&
          visited.size <= budget
        ) {
          visited.add(next);
          const page = await fetchExportsPage(botId, next);
          if (page.view !== "list") {
            offPageInFlight = true;
            break;
          }
          offPageInFlight = page.jobs.some(inFlight);
          next = page.pagination.nextOffset;
        }
        /*
         * Out of walk with scope left to check — the visit budget spent, or a
         * nextOffset chain that cycles or overruns its own total — is not evidence
         * that everything settled: unknown holds the poll open, never a silent close.
         */
        if (!offPageInFlight && next !== null) {
          offPageInFlight = true;
        }
      }
      return {
        view: "list",
        jobs: first.jobs,
        pagination: first.pagination,
        offPageInFlight,
      };
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.view === "list" &&
        (data.jobs.some(inFlight) || data.offPageInFlight)
        ? pollMs
        : false;
    },
    /*
     * Spec A6 (permission changes show up without a reload): the poll covers the
     * in-flight case, but once every job settles it closes — and the app-wide
     * QueryClient turns focus refetch off. This page opts back in so the tab
     * returning to the foreground is a real refresh path in production, not
     * only in tests: the next answer is the refusal, and the download button
     * goes with the rows it belonged to.
     */
    refetchOnWindowFocus: true,
  });
}

/** What a download attempt may conclude — the page resyncs on the two failures. */
export type ExportArtifactDownload = "downloaded" | "refused" | "unavailable";

/*
 * The one download path (R2fix F-1): the list stopped carrying the rows inline
 * (R2-40), so the download fetches them from the detail endpoint the completed
 * row's artifactUrl names — the same manage gate, the same session, and the
 * file is that answer's artifact rows as JSON. A refusal (the manage gate
 * refusing to widen) or a store failure is reported back for the caller to
 * resync against the list; and nothing is saved when the body cannot be read —
 * an answer without its rows is not an empty export.
 */
export async function downloadExportArtifact(
  job: ExportJobListItem,
): Promise<ExportArtifactDownload> {
  const url = job.artifactUrl;
  if (typeof url !== "string") return "unavailable";
  let response: Response;
  try {
    response = await tryClient(url);
  } catch {
    return "unavailable";
  }
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    return "refused";
  }
  if (!response.ok) return "unavailable";
  const body = (await response.json().catch(() => null)) as unknown;
  if (
    !isRecord(body) ||
    !isRecord(body.job) ||
    !Array.isArray(body.job.artifact)
  ) {
    return "unavailable";
  }
  const blob = new Blob([JSON.stringify(body.job.artifact, null, 2)], {
    type: "application/json",
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `runs-export-${job.jobId}.json`;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
  return "downloaded";
}
