import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ObservationExperimentComparisonPage } from "@/components/ai-observability/experiment-comparison";

/**
 * The experiment comparison (Issue #37): two experiments' configurations, deltas and
 * regressions on one page. The comparison spans two experiments, so — exactly like its
 * server face /bots/:botId/experiment-comparisons — it cannot nest under either
 * experiment's path: the four ids arrive as search parameters and nothing else. Behind
 * /_authed like every page in the chain, so a typed address walks the session guard;
 * the scope check is the comparison read's own manage gate.
 */
const comparisonSearchSchema = z.object({
  baselineExperimentId: z.string().optional(),
  baselineExecutionId: z.string().optional(),
  candidateExperimentId: z.string().optional(),
  candidateExecutionId: z.string().optional(),
});

export const Route = createFileRoute(
  "/_authed/_app/bots/$agentId/evaluations/experiment-comparisons",
)({
  validateSearch: comparisonSearchSchema,
  component: ComparisonPage,
});

function ComparisonPage() {
  const { agentId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <ObservationExperimentComparisonPage agentId={agentId} search={search} />
  );
}
