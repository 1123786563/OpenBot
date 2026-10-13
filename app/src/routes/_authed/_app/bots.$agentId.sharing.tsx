import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SharingSections } from "@/components/bot-profile/sharing";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/sharing")({
  component: SharingPage,
});

function SharingPage() {
  const { t } = useTranslation("agents");
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("pages.sharing.description")}
      title={t("pages.sharing.title")}
    >
      {(agent) => <SharingSections agent={agent} />}
    </BotSubpage>
  );
}
