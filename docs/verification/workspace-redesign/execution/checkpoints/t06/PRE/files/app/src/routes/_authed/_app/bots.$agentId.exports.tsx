import { createFileRoute } from "@tanstack/react-router";
import { ObservationExportsPage } from "@/components/ai-observability/exports-status";

/**
 * The creator's export status page (#42): this Bot's export jobs and the file each
 * finished job produced, behind the /_authed layout so a directly typed URL walks the same
 * session guard every other page does — and the page's own query walks the manage gate on
 * every load, so a typed-in address to someone else's Bot answers forbidden.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/exports")({
  component: ExportsPage,
});

function ExportsPage() {
  const { agentId } = Route.useParams();
  return <ObservationExportsPage agentId={agentId} />;
}
