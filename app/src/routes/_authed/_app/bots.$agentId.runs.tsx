import {
  createFileRoute,
  Outlet,
  useChildMatches,
} from "@tanstack/react-router";
import { ObservationRunsPage } from "@/components/ai-observability/runs-list";

/**
 * The creator's run list (Issue #18): one screen of recorded runs with the filters the
 * loaded page supports, behind the /_authed layout so a directly typed URL walks the same
 * session guard every other page does.
 *
 * The generated tree nests the run detail under this route
 * (`/bots/$agentId/runs/$bindingId`, OCR round 1 critical #1), so this component is on
 * screen whenever the detail mounts — a component that renders only the list keeps the
 * detail unmountable, leaving the URL changed while the screen stays put. When a child
 * is active the Outlet takes over and the list stands down: the detail is a full
 * BotSubpage shell with its own back link to this list, so the two are consecutive
 * screens rather than stacked ones.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/runs")({
  component: RunsPage,
});

function RunsPage() {
  const { agentId } = Route.useParams();
  const childActive = useChildMatches().length > 0;
  if (childActive) {
    return <Outlet />;
  }
  return <ObservationRunsPage agentId={agentId} />;
}
