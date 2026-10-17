import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { requireBotObservabilityAccess } from "@/lib/observability/route-guard";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/evaluations")(
  {
    beforeLoad: ({ context, params }) =>
      requireBotObservabilityAccess(context.queryClient, params.agentId),
    component: BotEvaluationsPage,
  },
);

/*
 * Placeholder frame: experiment submission, per-sample results and cancellation (T30) plus the
 * comparison page (T31) replace the body. Until Opik is configured the honest content is the
 * disabled state, not an empty list.
 */
function BotEvaluationsPage() {
  const { t } = useTranslation("obs-evaluations");
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
