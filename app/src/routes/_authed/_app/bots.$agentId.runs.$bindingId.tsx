import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ObservabilityPlaceholder } from "@/components/ai-observability/placeholder";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

/**
 * Placeholder for the run-detail chain (#19): the `$bindingId` segment is claimed so the run
 * list can link here before detail rendering exists.
 */
export const Route = createFileRoute(
  "/_authed/_app/bots/$agentId/runs/$bindingId",
)({
  component: RunDetailPage,
});

function RunDetailPage() {
  const { t } = useTranslation("ai-observability-runs");
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("placeholder.description")}
      title={t("placeholder.title")}
    >
      {() => <ObservabilityPlaceholder namespace="ai-observability-runs" />}
    </BotSubpage>
  );
}
