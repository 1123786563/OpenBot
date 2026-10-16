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

function isComparisonSide(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.experimentId === "string" &&
    typeof value.executionId === "string" &&
    typeof value.resultLink === "string" &&
    isRecord(value.report)
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
  if (body.deltas !== null && !isRecord(body.deltas)) return false;
  if (body.deltas !== null && !Array.isArray(body.deltas.perSample))
    return false;
  if (body.regressions !== null && !Array.isArray(body.regressions))
    return false;
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
  });
}
