import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { ReachingYou } from "@/components/delivery/reaching-you";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/reach")({
  component: ReachPage,
});

function ReachPage() {
  const { t } = useTranslation("agents");
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("pages.reach.description")}
      title={t("pages.reach.title")}
    >
      {(agent) => <ReachingYou agentId={agent.id} />}
    </BotSubpage>
  );
}
