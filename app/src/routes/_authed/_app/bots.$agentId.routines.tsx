import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { RoutinesList } from "@/components/routines/routines-list";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/routines")({
  component: RoutinesPage,
});

function RoutinesPage() {
  const { t } = useTranslation("agents");
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("pages.routines.description")}
      title={t("pages.routines.title")}
    >
      {(agent) => <RoutinesList agentId={agent.id} />}
    </BotSubpage>
  );
}
