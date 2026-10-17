import {
  createFileRoute,
  Outlet,
  useChildMatches,
} from "@tanstack/react-router";
import { ObservationEvaluationsPage } from "@/components/ai-observability/evaluations-page";

/**
 * The evaluations page (Issues #27/#36): the datasets section and the experiments
 * section beside it — one page for both chains, per the route convention, so neither
 * claims a second URL. The experiment results live one route deeper, at
 * /bots/$agentId/evaluations/experiments/$experimentId/$executionId. Behind /_authed,
 * a directly typed address walks the same session guard every other page does.
 *
 * The generated tree nests three children under this route — the dataset detail
 * (`/$datasetId`), the experiment results (`/experiments/$experimentId/$executionId`)
 * and the comparison (`/experiment-comparisons`, OCR round 1 critical #2) — so this
 * component is on screen whenever any of them mounts; a component that renders only
 * the combined page keeps all three unmountable, leaving the URL changed while the
 * screen stays put. When a child is active the Outlet takes over and this page stands
 * down: each child is a full shell with its own back link to this page, so the two are
 * consecutive screens rather than stacked ones.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/evaluations")(
  {
    component: EvaluationsPage,
  },
);

function EvaluationsPage() {
  const { agentId } = Route.useParams();
  const childActive = useChildMatches().length > 0;
  if (childActive) {
    return <Outlet />;
  }
  return <ObservationEvaluationsPage agentId={agentId} />;
}
