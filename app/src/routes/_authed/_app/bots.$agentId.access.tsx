import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AccessSections } from "@/components/bot-profile/access";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/access")({
  component: AccessPage,
});

function AccessPage() {
  const { t } = useTranslation("agents");
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("pages.access.description")}
      title={t("pages.access.title")}
    >
      {(agent) => <AccessSections agent={agent} />}
    </BotSubpage>
  );
}
