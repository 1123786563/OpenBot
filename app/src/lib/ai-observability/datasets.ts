import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/*
 * The datasets chain's data module (#27). The wire contract — ObservationDatasetListItem,
 * CaseReviewOutcome and friends — lives in shared/ai-observability-datasets.ts, the one
 * place the browser and the T19/T20 server surfaces agree on, so a backend contract change
 * is a change to that file and nothing here. The module follows the shape of the runs
 * chain's `lib/ai-observability/runs.ts` on purpose: one chain, one file, the same
 * refusal-is-the-answer discipline.
 *
 * A refusal from the read endpoints is an answer, not a failure: 503 capability_missing is
 * the deployment saying evaluation is off, a 403/404 is the manage gate refusing to name a
 * Bot this caller cannot manage, anything else is the store failing to answer. The same
 * holds for the review/save writes, whose refusal codes (CASE_REVIEW_RUN_NOT_FOUND and
 * friends) are sentences the page must be able to say — so the mutations return the code
 * instead of throwing it.
 */

export type {
  CaseFragmentInput,
  CaseReviewOutcome,
  CaseReviewRequest,
  DatasetSyncState,
  FrozenDatasetCase,
  ObservationDatasetDetailResult,
  ObservationDatasetListItem,
  ObservationDatasetsResult,
  ObservationDatasetVersionItem,
  SaveDatasetVersionRequest,
  SavedDatasetVersionResult,
} from "../../../../shared/ai-observability-datasets";

import type {
  CaseReviewOutcome,
  CaseReviewRequest,
  ObservationDatasetDetailResult,
  ObservationDatasetsResult,
  SaveDatasetVersionRequest,
  SavedDatasetVersionResult,
} from "../../../../shared/ai-observability-datasets";

export const observationDatasetKeys = {
  all: ["ai-observability-datasets"] as const,
  list: (botId: string) =>
    ["ai-observability-datasets", "list", botId] as const,
  detail: (botId: string, datasetId: string) =>
    ["ai-observability-datasets", "detail", botId, datasetId] as const,
};

/** What the screen is allowed to conclude — the chain's shared fault vocabulary. */
export type ObservationDatasetFault = "disabled" | "forbidden" | "unavailable";

export type ObservationDatasetsScreen =
  | { view: "list"; result: ObservationDatasetsResult }
  | { view: "fault"; fault: ObservationDatasetFault };

export type ObservationDatasetDetailScreen =
  | { view: "detail"; result: ObservationDatasetDetailResult }
  | { view: "fault"; fault: ObservationDatasetFault };

/** The server's error code, when it sent one in the house `{ error }` envelope. */
async function refusalCode(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof body?.error === "string" ? body.error : null;
}

/** The read endpoints' classifier: a refusal is the screen's verdict, decided here once. */
async function classifyRead(
  response: Response,
): Promise<{ fault: ObservationDatasetFault } | { ok: true }> {
  if (
    response.status === 503 &&
    (await refusalCode(response)) === "capability_missing"
  ) {
    return { fault: "disabled" };
  }
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    /*
     * 404 is the manage-gate refusing to name a Bot this caller cannot manage — the same
     * refusal a stranger's probe hears, by design — or a dataset id outside this scope,
     * which the store answers the same way. A 401 means the session ended; the _authed
     * guard handles the redirect on the next navigation.
     */
    return { fault: "forbidden" };
  }
  if (!response.ok) {
    return { fault: "unavailable" };
  }
  return { ok: true };
}

/** A malformed success is the store failing to answer, never an empty page. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function observationDatasetsQueryOptions(botId: string) {
  return queryOptions({
    queryKey: observationDatasetKeys.list(botId),
    queryFn: async (): Promise<ObservationDatasetsScreen> => {
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(botId)}/datasets`,
      );
      const verdict = await classifyRead(response);
      if ("fault" in verdict) return { view: "fault", fault: verdict.fault };
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isRecord(body) || !Array.isArray(body.datasets)) {
        return { view: "fault", fault: "unavailable" };
      }
      return { view: "list", result: body as ObservationDatasetsResult };
    },
  });
}

export function observationDatasetDetailQueryOptions(
  botId: string,
  datasetId: string,
) {
  return queryOptions({
    queryKey: observationDatasetKeys.detail(botId, datasetId),
    queryFn: async (): Promise<ObservationDatasetDetailScreen> => {
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(botId)}/datasets/${encodeURIComponent(datasetId)}`,
      );
      const verdict = await classifyRead(response);
      if ("fault" in verdict) return { view: "fault", fault: verdict.fault };
      const body = (await response.json().catch(() => null)) as unknown;
      if (
        !isRecord(body) ||
        !isRecord(body.dataset) ||
        !Array.isArray(body.versions)
      ) {
        return { view: "fault", fault: "unavailable" };
      }
      return { view: "detail", result: body as ObservationDatasetDetailResult };
    },
  });
}

/**
 * A write's verdict: the outcome, or the refusal code the page turns into its own sentence.
 * `null` means no code came back — the store did not answer — which is its own sentence.
 */
export type ObservationWriteAttempt<T> =
  | { ok: true; result: T }
  | { ok: false; refusal: string | null };

export function observationReviewCaseMutationOptions() {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      body: CaseReviewRequest;
    }): Promise<ObservationWriteAttempt<CaseReviewOutcome>> => {
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(variables.botId)}/case-review/review`,
        { method: "POST", body: variables.body },
      );
      if (!response.ok) {
        return { ok: false, refusal: await refusalCode(response) };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isRecord(body) || !Array.isArray(body.preview)) {
        return { ok: false, refusal: null };
      }
      return { ok: true, result: body as CaseReviewOutcome };
    },
    /*
     * No queryClient, no invalidation: a review records an audit row and hands back a
     * projection preview — it changes nothing the page caches. The save below owns the
     * invalidation, because only it changes dataset state.
     */
  });
}

export function observationSaveCaseMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      body: SaveDatasetVersionRequest;
    }): Promise<ObservationWriteAttempt<SavedDatasetVersionResult>> => {
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(variables.botId)}/case-review/save`,
        { method: "POST", body: variables.body },
      );
      if (!response.ok) {
        return { ok: false, refusal: await refusalCode(response) };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isRecord(body) || !isRecord(body.version)) {
        return { ok: false, refusal: null };
      }
      return { ok: true, result: body as SavedDatasetVersionResult };
    },
    onSuccess: (attempt) => {
      if (attempt.ok) {
        void queryClient.invalidateQueries({
          queryKey: observationDatasetKeys.all,
        });
      }
    },
  });
}
