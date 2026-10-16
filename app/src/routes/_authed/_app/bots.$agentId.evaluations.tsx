import { createFileRoute } from "@tanstack/react-router";
import { ObservationEvaluationsPage } from "@/components/ai-observability/evaluations-page";

/**
 * The evaluations page (Issues #27/#36): the datasets section and the experiments
 * section beside it — one page for both chains, per the route convention, so neither
 * claims a second URL. The experiment results live one route deeper, at
 * /bots/$agentId/evaluations/experiments/$experimentId/$executionId. Behind /_authed,
 * a directly typed address walks the same session guard every other page does.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/evaluations")(
  {
    component: EvaluationsPage,
  },
);

function EvaluationsPage() {
  const { agentId } = Route.useParams();
  return <ObservationEvaluationsPage agentId={agentId} />;
}
