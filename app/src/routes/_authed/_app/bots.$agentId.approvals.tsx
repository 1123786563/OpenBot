import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BotApprovalRules } from "@/components/approvals/bot-rules";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/approvals")({
  component: ApprovalRulesPage,
});

function ApprovalRulesPage() {
  const { t } = useTranslation("agents");
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("pages.approvals.description")}
      title={t("pages.approvals.title")}
    >
      {(agent) => <BotApprovalRules agentId={agent.id} />}
    </BotSubpage>
  );
}
