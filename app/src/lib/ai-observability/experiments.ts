import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/*
 * The experiments chain's data module (#36). The wire contract — ExperimentResultsReport,
 * ExperimentSubmitInput and friends — lives in shared/ai-observability-experiments.ts, the
 * one place the browser and the T28/T22 server surfaces agree on, so a backend contract
 * change is a change to that file and nothing here. The module follows the shape of the
 * datasets chain's `lib/ai-observability/datasets.ts` on purpose: one chain, one file,
 * the same refusal-is-the-answer discipline.
 *
 * A refusal from the read endpoint is an answer, not a failure: 503 capability_missing is
 * the deployment saying evaluation is off, a 401/403 is the manage gate refusing to name a
 * Bot this caller cannot manage, and a scope-local 404 (RESULTS_*_NOT_FOUND) is a
 * different answer than the manage gate's — the same two-refusal split the runs detail
 * reads. The submit and cancel writes return their refusal code instead of throwing it,
 * so the page can say each code's own sentence.
 */

export type {
  CancelledExecutionResult,
  ExperimentExecutionRecord,
  ExperimentExecutionState,
  ExperimentResultsReport,
  ExperimentResultsSample,
  ExperimentResultsSummary,
  ExperimentRuleScore,
  ExperimentSampleClass,
  ExperimentSampleReason,
  ExperimentSubmitConfigInput,
  ExperimentSubmitInput,
  SubmittedExperimentResult,
} from "../../../../shared/ai-observability-experiments";

import type {
  ExperimentExecutionState,
  ExperimentResultsReport,
  ExperimentSubmitInput,
  SubmittedExperimentResult,
} from "../../../../shared/ai-observability-experiments";

export const observationExperimentKeys = {
  all: ["ai-observability-experiments"] as const,
  results: (botId: string, experimentId: string, executionId: string) =>
    [
      "ai-observability-experiments",
      "results",
      botId,
      experimentId,
      executionId,
    ] as const,
};

/** What the results screen is allowed to conclude — the chain's shared fault vocabulary. */
export type ObservationExperimentFault =
  | "disabled"
  | "forbidden"
  | "notFound"
  | "unavailable";

export type ObservationExperimentResultsScreen =
  | { view: "results"; report: ExperimentResultsReport }
  | { view: "fault"; fault: ObservationExperimentFault };

/** The server's error code, when it sent one in the house `{ error }` envelope. */
async function refusalCode(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof body?.error === "string" ? body?.error : null;
}

/** The read endpoint's classifier: a refusal is the screen's verdict, decided here once. */
export async function classifyRead(
  response: Response,
): Promise<{ fault: ObservationExperimentFault } | { ok: true }> {
  if (
    response.status === 503 &&
    (await refusalCode(response)) === "capability_missing"
  ) {
    return { fault: "disabled" };
  }
  if (response.status === 401 || response.status === 403) {
    return { fault: "forbidden" };
  }
  if (response.status === 404) {
    /*
     * Two different 404s, kept different on purpose: RESULTS_*_NOT_FOUND is about the
     * experiment or the execution (this scope does not hold it, so it does not exist for
     * this caller); the manage gate's OBSERVATION_BOT_* 404 refuses to name a Bot this
     * caller cannot manage — the same refusal a stranger's probe hears, so forbidden.
     */
    const code = await refusalCode(response);
    return code?.startsWith("RESULTS_")
      ? { fault: "notFound" }
      : { fault: "forbidden" };
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

/*
 * The states the database's own CHECK closes: pending, running, completed, failed,
 * cancelled. Unlike an upstream run state (an open vocabulary that fails closed to
 * "unknown"), a body carrying any other word here is damage to the contract — the
 * store failing to answer, never a state to guess or echo.
 */
const EXECUTION_STATES: readonly ExperimentExecutionState[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
];

function isExperimentResultsBody(
  body: unknown,
): body is ExperimentResultsReport {
  if (!isRecord(body)) return false;
  for (const field of ["experimentId", "executionId", "resultLink"]) {
    if (typeof body[field] !== "string") return false;
  }
  if (
    typeof body.state !== "string" ||
    !EXECUTION_STATES.includes(body.state as ExperimentExecutionState)
  ) {
    return false;
  }
  if (!isRecord(body.execution) || !isRecord(body.summary)) return false;
  if (!Array.isArray(body.samples)) return false;
  for (const sample of body.samples) {
    if (!isRecord(sample) || !isRecord(sample.reason)) return false;
  }
  return true;
}

export function observationExperimentResultsQueryOptions(
  botId: string,
  experimentId: string,
  executionId: string,
) {
  return queryOptions({
    queryKey: observationExperimentKeys.results(
      botId,
      experimentId,
      executionId,
    ),
    queryFn: async (): Promise<ObservationExperimentResultsScreen> => {
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(botId)}/experiments/${encodeURIComponent(experimentId)}/results/${encodeURIComponent(executionId)}`,
      );
      const verdict = await classifyRead(response);
      if ("fault" in verdict) return { view: "fault", fault: verdict.fault };
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isExperimentResultsBody(body)) {
        return { view: "fault", fault: "unavailable" };
      }
      return { view: "results", report: body };
    },
  });
}

/**
 * A write's verdict: the outcome, or the refusal code the page turns into its own
 * sentence. `null` means no code came back — the store did not answer.
 */
export type ObservationWriteAttempt<T> =
  | { ok: true; result: T }
  | { ok: false; refusal: string | null };

/** The submission: one POST freezes the configuration and starts the execution. */
export function observationSubmitExperimentMutationOptions() {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      body: ExperimentSubmitInput;
    }): Promise<ObservationWriteAttempt<SubmittedExperimentResult>> => {
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(variables.botId)}/experiments`,
        { method: "POST", body: variables.body },
      );
      if (!response.ok) {
        return { ok: false, refusal: await refusalCode(response) };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (
        !isRecord(body) ||
        typeof body.experimentId !== "string" ||
        typeof body.executionId !== "string" ||
        typeof body.configHash !== "string" ||
        typeof body.replayed !== "boolean"
      ) {
        return { ok: false, refusal: null };
      }
      return { ok: true, result: body as SubmittedExperimentResult };
    },
    // No invalidation: the submission creates data no query on this page caches yet
    // (the experiment list is a later chain's page).
  });
}

/**
 * The cancel write: settles a not-yet-terminal execution. On success the results read
 * is invalidated, because the settled report is the honest redraw — the page never
 * fakes the transition locally.
 */
export function observationCancelExecutionMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      experimentId: string;
      executionId: string;
    }): Promise<ObservationWriteAttempt<{ executionId: string }>> => {
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(variables.botId)}/experiments/${encodeURIComponent(variables.experimentId)}/executions/${encodeURIComponent(variables.executionId)}/cancel`,
        { method: "POST" },
      );
      if (!response.ok) {
        return { ok: false, refusal: await refusalCode(response) };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isRecord(body) || typeof body.executionId !== "string") {
        return { ok: false, refusal: null };
      }
      return { ok: true, result: { executionId: body.executionId } };
    },
    onSuccess: (attempt) => {
      if (attempt.ok) {
        void queryClient.invalidateQueries({
          queryKey: observationExperimentKeys.all,
        });
      }
    },
  });
}
