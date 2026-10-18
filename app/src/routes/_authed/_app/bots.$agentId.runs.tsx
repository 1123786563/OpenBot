import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { ObservabilityPlaceholder } from "@/components/ai-observability/placeholder";

/**
 * Placeholder for the run-list chain (#18): claims the URL, says honestly that the store is not
 * wired up yet, and is replaced — not extended — when real runs land.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/runs")({
  component: RunsPage,
});

function RunsPage() {
  const { t } = useTranslation("ai-observability-runs");
  const { agentId } = Route.useParams();
  return (
    <BotSubpage agentId={agentId} title={t("placeholder.title")}>
      <ObservabilityPlaceholder namespace="ai-observability-runs" />
    </BotSubpage>
  );
}
