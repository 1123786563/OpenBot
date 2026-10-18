import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { requireBotObservabilityAccess } from "@/lib/observability/route-guard";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/datasets")({
  beforeLoad: ({ context, params }) =>
    requireBotObservabilityAccess(context.queryClient, params.agentId),
  component: BotDatasetsPage,
});

/*
 * Placeholder frame: the dataset review/version screens (T21) replace the body. Until Opik is
 * configured the honest content is the disabled state, not an empty list.
 */
function BotDatasetsPage() {
  const { t } = useTranslation("obs-datasets");
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("states.disabled.description")}
      title={t("title")}
    >
      {() => (
        <p className="mt-6 text-muted-foreground text-sm">
          {t("states.disabled.title")}
        </p>
      )}
    </BotSubpage>
  );
}
