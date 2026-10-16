import { createFileRoute } from "@tanstack/react-router";
import { ObservationDatasetDetailPage } from "@/components/ai-observability/dataset-detail";

/**
 * One dataset's frozen version history (Issue #27): the detail the list rows link to, behind
 * the /_authed layout like its list. The page is read-only by design — a frozen version
 * answers with its hash, and that is the whole of what may be done to it.
 */
export const Route = createFileRoute(
  "/_authed/_app/bots/$agentId/evaluations/$datasetId",
)({
  component: DatasetDetailPage,
});

function DatasetDetailPage() {
  const { agentId, datasetId } = Route.useParams();
  return (
    <ObservationDatasetDetailPage agentId={agentId} datasetId={datasetId} />
  );
}
