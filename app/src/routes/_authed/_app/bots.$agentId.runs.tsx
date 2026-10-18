import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { requireBotObservabilityAccess } from "@/lib/observability/route-guard";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/runs")({
  beforeLoad: ({ context, params }) =>
    requireBotObservabilityAccess(context.queryClient, params.agentId),
  component: BotRunsPage,
});

/*
 * Placeholder frame: the runs list (T12), detail and step tree (T13/T18) replace the body.
 * Until Opik is configured the honest content is the disabled state, not an empty list.
 */
function BotRunsPage() {
  const { t } = useTranslation("obs-runs");
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
