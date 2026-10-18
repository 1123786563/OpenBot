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
import {
  EXPERIMENT_COMPATIBILITY_FIELDS,
  EXPERIMENT_SAMPLE_CLASSES,
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

/*
 * Whether the build's states.* sentences can name this execution state (OCR round 2,
 * R2-09): a newer server's word is a missing i18n sentence, and the pages render the
 * raw state verbatim instead of echoing a key the bundle has never heard of.
 */
export function isKnownExecutionState(state: string): boolean {
  return (EXECUTION_STATES as readonly string[]).includes(state);
}

/*
 * Two more closed vocabularies behind dynamic i18n keys (OCR round 3, R3-02/03/04,
 * the R2-09 standard): the comparison ledger's frozen fields and the seven per-sample
 * classes are both database-closed sets the shared contract exports as constants. A
 * word outside them is a missing i18n sentence, not a key to echo — the pages render
 * the word itself, and these predicates are how they tell the two cases apart.
 */
export function isKnownCompatibilityField(field: string): boolean {
  return (EXPERIMENT_COMPATIBILITY_FIELDS as readonly string[]).includes(field);
}

export function isKnownSampleClass(klass: string): boolean {
  return (EXPERIMENT_SAMPLE_CLASSES as readonly string[]).includes(klass);
}

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
  // The page renders the execution projection's state as a word — a non-string there
  // is not a fact to fall back to, so it is claimed here (OCR round 2, R2-09).
  if (typeof body.execution.state !== "string") return false;
  /*
   * The execution projection's own record row (OCR round 4, R4-3): the page reads
   * seven facts off it — the state above, plus the error code, the case base, the
   * tool-rejection count, both timestamps, and the frozen-configuration hash it
   * prints beside the result link. Each is claimed with the same null semantics
   * the page's `=== null` checks promise: a missing errorCode/caseCount/timestamp
   * used to slip past the null check and render `undefined` (or an invalid date)
   * as if it were a fact. `id` and `createdAt` stay unclaimed on purpose — the
   * page never reads them; the claims are one-to-one with the render face.
   */
  if (
    body.execution.errorCode !== null &&
    typeof body.execution.errorCode !== "string"
  ) {
    return false;
  }
  if (
    body.execution.caseCount !== null &&
    typeof body.execution.caseCount !== "number"
  ) {
    return false;
  }
  if (typeof body.execution.toolRejections !== "number") return false;
  if (
    body.execution.startedAt !== null &&
    typeof body.execution.startedAt !== "string"
  ) {
    return false;
  }
  if (
    body.execution.settledAt !== null &&
    typeof body.execution.settledAt !== "string"
  ) {
    return false;
  }
  if (typeof body.execution.experimentConfigHash !== "string") return false;
  /*
   * The scorer version the record row names (OCR round 4, R4-5): the page's
   * `=== null` check sends a missing version to the versioned sentence, where
   * `undefined` would interpolate as an empty fact — the null-or-string promise
   * is claimed, so the honest "unavailable" sentence is the only alternative.
   */
  if (body.scorerVersion !== null && typeof body.scorerVersion !== "string") {
    return false;
  }
  /*
   * The OCR round 1 review: the page calls `.toFixed(2)` on the mean and on every
   * sample score after only a `=== null` check, so an undefined slips through to a
   * TypeError — a number-or-null promise the summary and each sample must keep. The
   * sample's index and class ride the same row (`#3 Scored`), so they are claimed here
   * too: a missing index is a crash, a class word the build has never heard of is a
   * missing i18n sentence, not a crash — claimed as a string, not a closed set.
   */
  if (
    body.summary.meanScore !== null &&
    typeof body.summary.meanScore !== "number"
  ) {
    return false;
  }
  if (typeof body.summary.sampleBase !== "number") return false;
  /*
   * The seven class counts (OCR round 4, R4-0): the summary ledger interpolates
   * every class's number beside its name, so a count that lost its number renders
   * `undefined` as a statistic — each of the seven is a promise the body keeps.
   */
  for (const countField of [
    "scored",
    "inProgress",
    "executionFailed",
    "scoringFailed",
    "cancelled",
    "pendingReconciliation",
    "syncFailure",
  ] as const) {
    if (typeof body.summary[countField] !== "number") return false;
  }
  if (!Array.isArray(body.samples)) return false;
  for (const sample of body.samples) {
    if (!isRecord(sample) || !isRecord(sample.reason)) return false;
    if (typeof sample.index !== "number") return false;
    if (typeof sample.class !== "string") return false;
    if (sample.score !== null && typeof sample.score !== "number") return false;
    /*
     * The scored reason's row reads `reason.rules.filter(...)` after counts the page
     * interpolates (OCR round 2, R2-09): the guard used to claim only "a record", so
     * a scored reason without its rules array reached the renderer as
     * undefined.filter. Each entry's id and status are claimed too — the row prints
     * them; anything deeper (a failed rule's reason) is a string the page would show
     * as text, so the claim stops where the crash stops.
     */
    if (sample.reason.class === "scored") {
      if (typeof sample.reason.passed !== "number") return false;
      if (typeof sample.reason.failed !== "number") return false;
      if (!Array.isArray(sample.reason.rules)) return false;
      for (const rule of sample.reason.rules) {
        if (!isRecord(rule)) return false;
        if (typeof rule.id !== "string" || typeof rule.status !== "string") {
          return false;
        }
      }
    } else {
      /*
       * Every non-scored reason's sentence is its code (OCR round 4, R4-2): the
       * page joins `reason.code` into the row text, so a reason that lost its code
       * rendered `undefined` as a fact. The class word itself is claimed too — it
       * is the discriminator the page branches on; a reason without one is not a
       * branch to guess. Both are string claims, not closed sets: a newer code is
       * text the row shows, the same discipline as the sample's class above.
       */
      if (typeof sample.reason.class !== "string") return false;
      if (typeof sample.reason.code !== "string") return false;
    }
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
    /*
     * Spec A6, the creator chains' half (admin/exports opt in the same way): after a
     * permission narrows, the tab returning to the foreground re-asks, so a revoked
     * scope answers forbidden instead of riding its stale answer until the next
     * navigation — the app-wide QueryClient turns focus refetch off.
     */
    refetchOnWindowFocus: true,
  });
}

/**
 * A write's verdict: the outcome, or the refusal code the page turns into its own
 * sentence. `null` means no code came back — the store did not answer.
 */
export type ObservationWriteAttempt<T> =
  | { ok: true; result: T }
  | { ok: false; refusal: string | null };

/** A judge record's display facts, as the T27 contract shapes them. */
export type ObservationJudgeFacts =
  | { kind: "scored"; score: number; rationale: string }
  | { kind: "failed"; code: string; message?: string };

/**
 * The sample's judge record, read defensively (T27-rn L-3): a `scored` record needs a
 * finite 0-bounded score and its rationale, a `failed` record its JUDGE_* code —
 * anything else is not a judge fact the page can speak, and answers null rather than
 * a guess. The judge's score is never the sample's score: the rule score stands alone.
 */
export function judgeFacts(value: unknown): ObservationJudgeFacts | null {
  if (!isRecord(value)) return null;
  if (value.status === "scored") {
    return typeof value.score === "number" &&
      Number.isFinite(value.score) &&
      value.score >= 0 &&
      value.score <= 1 &&
      typeof value.rationale === "string"
      ? { kind: "scored", score: value.score, rationale: value.rationale }
      : null;
  }
  if (value.status === "failed" && typeof value.code === "string") {
    return {
      kind: "failed",
      code: value.code,
      ...(typeof value.message === "string" && value.message !== ""
        ? { message: value.message }
        : {}),
    };
  }
  return null;
}

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
        typeof body.replayed !== "boolean" ||
        // T30-rev L-1: the canary count is part of the pinned answer — a body that
        // omits it is not the contract, and the canary sentence must never silently
        // vanish behind a success story.
        typeof body.canaryFindings !== "number"
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
