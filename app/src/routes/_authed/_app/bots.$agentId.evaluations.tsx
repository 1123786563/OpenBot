import { createFileRoute } from "@tanstack/react-router";
import { ObservationDatasetsPage } from "@/components/ai-observability/datasets-list";

/**
 * The datasets section of the evaluations page (Issue #27): the chain's real surface replaces
 * the T02 placeholder at the address the route convention recorded — one page for datasets
 * and experiments, so the experiment chains (#36 #37) add their sections beside this one
 * instead of claiming a second URL. Behind /_authed, a directly typed address walks the same
 * session guard every other page does.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/evaluations")(
  {
    component: EvaluationsPage,
  },
);

function EvaluationsPage() {
  const { agentId } = Route.useParams();
  return <ObservationDatasetsPage agentId={agentId} />;
}
