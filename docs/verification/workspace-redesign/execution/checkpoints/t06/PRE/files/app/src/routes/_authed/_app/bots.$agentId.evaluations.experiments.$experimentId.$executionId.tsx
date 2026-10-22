import { createFileRoute } from "@tanstack/react-router";
import { ObservationExperimentResultsPage } from "@/components/ai-observability/experiment-results";

/**
 * One experiment execution's results (Issue #36): the per-sample answer the
 * submission's View results link lands on. The static `experiments` segment keeps it
 * apart from the dataset detail at /bots/$agentId/evaluations/$datasetId, so one
 * address can never be read as the other. Behind /_authed like the page it links
 * from: the scope check is the results read's own manage gate, which answers
 * forbidden for a Bot this caller cannot manage — never disguised as not-found.
 */
export const Route = createFileRoute(
  "/_authed/_app/bots/$agentId/evaluations/experiments/$experimentId/$executionId",
)({
  component: ExperimentResultsPage,
});

function ExperimentResultsPage() {
  const { agentId, experimentId, executionId } = Route.useParams();
  return (
    <ObservationExperimentResultsPage
      agentId={agentId}
      experimentId={experimentId}
      executionId={executionId}
    />
  );
}
