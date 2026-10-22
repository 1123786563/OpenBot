import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ObservationDatasetsBody } from "@/components/ai-observability/datasets-list";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { requireBotObservabilityAccess } from "@/lib/observability/route-guard";

/**
 * The creator's dataset chain (T02 route convention): reviewed cases and frozen dataset
 * versions for one Bot. The guard reads the server-decided canManage verdict so a directly
 * typed URL is refused before any page body renders.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/datasets")({
  beforeLoad: ({ context, params }) =>
    requireBotObservabilityAccess(context.queryClient, params.agentId),
  component: BotDatasetsPage,
});

function BotDatasetsPage() {
  const { t } = useTranslation("ai-observability-datasets");
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("page.description")}
      title={t("page.title")}
    >
      {() => <ObservationDatasetsBody botId={agentId} />}
    </BotSubpage>
  );
}
