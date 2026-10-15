import { createFileRoute } from "@tanstack/react-router";
import { ObservationRunsPage } from "@/components/ai-observability/runs-list";

/**
 * The creator's run list (Issue #18): one screen of recorded runs with the filters the
 * loaded page supports, behind the /_authed layout so a directly typed URL walks the same
 * session guard every other page does.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/runs")({
  component: RunsPage,
});

function RunsPage() {
  const { agentId } = Route.useParams();
  return <ObservationRunsPage agentId={agentId} />;
}
