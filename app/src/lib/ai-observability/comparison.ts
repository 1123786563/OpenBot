import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { classifyRead } from "./experiments";

/*
 * The experiment comparison's data module (#37). The wire contract — ExperimentComparison
 * and friends — lives in shared/ai-observability-experiments.ts, the one place the
 * browser and the T29 server surface agree on, so a backend contract change is a change
 * to that file and nothing here. The module is the experiments chain's own shape again:
 * one read, the same refusal-is-the-answer discipline, the same fault vocabulary the
 * results screen speaks — the comparison is a read of two experiments, so a refusal is
 * an answer, never an empty page.
 */

export type {
  ExperimentComparison,
  ExperimentComparisonSide,
  ExperimentCompatibilityEntry,
  ExperimentCompatibilityField,
  ExperimentRegressionRow,
  ExperimentSampleDelta,
} from "../../../../shared/ai-observability-experiments";

import type { ExperimentComparison } from "../../../../shared/ai-observability-experiments";

export type { ObservationExperimentFault } from "./experiments";

import type { ObservationExperimentFault } from "./experiments";

/** The two sides a comparison names — the four query parameters, nothing else. */
export type ExperimentComparisonSides = Readonly<{
  baseline: Readonly<{ experimentId: string; executionId: string }>;
  candidate: Readonly<{ experimentId: string; executionId: string }>;
}>;

export const observationComparisonKeys = {
  all: ["ai-observability-experiments", "comparison"] as const,
  sides: (botId: string, sides: ExperimentComparisonSides) =>
    [
      "ai-observability-experiments",
      "comparison",
      botId,
      sides.baseline.experimentId,
      sides.baseline.executionId,
      sides.candidate.experimentId,
      sides.candidate.executionId,
    ] as const,
};

export type ObservationComparisonScreen =
  | { view: "comparison"; comparison: ExperimentComparison }
  | { view: "fault"; fault: ObservationExperimentFault };

/** A malformed success is the store failing to answer, never an empty comparison. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/*
 * Entry-level shape defense (OCR round 1 medium, comparison page): the page reads
 * `meanScore.baseline.toFixed(2)`, indexes `report.samples[delta.index]`, and walks
 * each delta's and each regression row's nested halves — a body that dropped any of
 * those crashed mid-render instead of answering unavailable. Each guard covers the
 * fields the page reads; a class word the build has never heard of is a missing i18n
 * sentence, not a crash, so classes are claimed as strings while the direction — the
 * page's own four-word verdict — stays a closed set.
 */
function isComparisonHalf(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.class === "string" &&
    isNullableNumber(value.score)
  );
}

function isNullableNumberRecord(
  value: unknown,
  numberFields: readonly string[],
  nullableFields: readonly string[] = [],
): boolean {
  if (!isRecord(value)) return false;
  for (const field of numberFields) {
    if (typeof value[field] !== "number") return false;
  }
  for (const field of nullableFields) {
    if (!isNullableNumber(value[field])) return false;
  }
  return true;
}

/*
 * The side's report as SideRow reads it: the summary cells (mean after a `=== null`
 * check, so an undefined is a TypeError), the execution projection (state word,
 * config hash, both times) — OCR round 2: the round-1 guard stopped at samples and
 * let a side missing the rest through to undefined.toFixed and NaN%.
 */
function isSideReport(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.samples)) return false;
  if (
    !isNullableNumberRecord(
      value.summary,
      ["sampleBase", "scored"],
      ["meanScore"],
    )
  ) {
    return false;
  }
  return (
    isRecord(value.execution) &&
    typeof value.execution.state === "string" &&
    typeof value.execution.experimentConfigHash === "string" &&
    isNullableString(value.execution.startedAt) &&
    isNullableString(value.execution.settledAt)
  );
}

function isSampleDelta(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.index === "number" &&
    isComparisonHalf(value.baseline) &&
    isComparisonHalf(value.candidate) &&
    isNullableNumber(value.scoreDelta) &&
    (value.direction === "regressed" ||
      value.direction === "improved" ||
      value.direction === "unchanged" ||
      value.direction === "incomparable")
  );
}

function isRegressionRow(value: unknown): boolean {
  if (!isRecord(value) || typeof value.index !== "number") return false;
  if (
    !isRecord(value.case) ||
    typeof value.case.datasetVersionId !== "string" ||
    typeof value.case.contentHash !== "string"
  ) {
    return false;
  }
  for (const side of [value.baseline, value.candidate]) {
    if (
      !isRecord(side) ||
      typeof side.class !== "string" ||
      !isNullableNumber(side.score) ||
      !isNullableString(side.code) ||
      typeof side.resultLink !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function isCompatibilityEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.field === "string" &&
    isNullableString(value.baseline) &&
    isNullableString(value.candidate) &&
    typeof value.equal === "boolean" &&
    typeof value.blocking === "boolean"
  );
}

function isMeanScore(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNullableNumber(value.baseline) &&
    isNullableNumber(value.candidate) &&
    isNullableNumber(value.delta)
  );
}

function isComparisonSide(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.experimentId === "string" &&
    typeof value.executionId === "string" &&
    typeof value.resultLink === "string" &&
    // The deltas section indexes each side's samples by a delta's index, so a side
    // whose report lost its samples array crashes the map before any optional chain.
    isSideReport(value.report) &&
    // The side's own ledger row (OCR round 2): completionRate feeds a `*100`, usage
    // feeds two counts, timing feeds a seconds division — a missing or non-number
    // fact there is a NaN% or an undefined interpolation, not a sentence.
    typeof value.completionRate === "number" &&
    isNullableNumberRecord(value.usage, ["reported", "missing"]) &&
    isNullableNumberRecord(value.timing, [], ["durationMs"])
  );
}

function isExperimentComparisonBody(
  body: unknown,
): body is ExperimentComparison {
  if (!isRecord(body)) return false;
  if (!isComparisonSide(body.baseline) || !isComparisonSide(body.candidate))
    return false;
  if (!isRecord(body.compatibility)) return false;
  if (!Array.isArray(body.compatibility.fields)) return false;
  if (!body.compatibility.fields.every(isCompatibilityEntry)) return false;
  if (body.deltas !== null) {
    if (!isRecord(body.deltas)) return false;
    if (!isMeanScore(body.deltas.meanScore)) return false;
    if (!Array.isArray(body.deltas.perSample)) return false;
    if (!body.deltas.perSample.every(isSampleDelta)) return false;
  }
  if (body.regressions !== null) {
    if (!Array.isArray(body.regressions)) return false;
    if (!body.regressions.every(isRegressionRow)) return false;
  }
  return true;
}

export function observationExperimentComparisonQueryOptions(
  botId: string,
  sides: ExperimentComparisonSides,
) {
  return queryOptions({
    queryKey: observationComparisonKeys.sides(botId, sides),
    queryFn: async (): Promise<ObservationComparisonScreen> => {
      const query = new URLSearchParams({
        baselineExperimentId: sides.baseline.experimentId,
        baselineExecutionId: sides.baseline.executionId,
        candidateExperimentId: sides.candidate.experimentId,
        candidateExecutionId: sides.candidate.executionId,
      });
      const response = await tryClient(
        `/api/ai-observability/bots/${encodeURIComponent(botId)}/experiment-comparisons?${query.toString()}`,
      );
      const verdict = await classifyRead(response);
      if ("fault" in verdict) return { view: "fault", fault: verdict.fault };
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isExperimentComparisonBody(body)) {
        return { view: "fault", fault: "unavailable" };
      }
      return { view: "comparison", comparison: body };
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
