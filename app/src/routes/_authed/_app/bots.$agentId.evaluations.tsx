import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ObservabilityPlaceholder } from "@/components/ai-observability/placeholder";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

/**
 * Placeholder for the dataset (#27) and experiment (#36) chains: one page covering both, as the
 * route convention in `lib/i18n/index.ts` records.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/evaluations")(
  {
    component: EvaluationsPage,
  },
);

function EvaluationsPage() {
  const { t } = useTranslation("ai-observability-evaluations");
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("placeholder.description")}
      title={t("placeholder.title")}
    >
      {() => (
        <ObservabilityPlaceholder namespace="ai-observability-evaluations" />
      )}
    </BotSubpage>
  );
}
