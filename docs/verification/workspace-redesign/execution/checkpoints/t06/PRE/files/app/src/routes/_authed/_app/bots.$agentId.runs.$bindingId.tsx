import { createFileRoute } from "@tanstack/react-router";
import { ObservationRunDetailPage } from "@/components/ai-observability/run-detail";

/**
 * The run-detail route (#19): the `$bindingId` segment is the local run id the list links
 * with. A thin wrapper — the page body lives in the component so tests mount it without the
 * authenticated runtime the layout drags in.
 */
export const Route = createFileRoute(
  "/_authed/_app/bots/$agentId/runs/$bindingId",
)({
  component: RunDetailPage,
});

function RunDetailPage() {
  const { agentId, bindingId } = Route.useParams();
  return <ObservationRunDetailPage agentId={agentId} bindingId={bindingId} />;
}
