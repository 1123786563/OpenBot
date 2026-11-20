import { createFileRoute } from "@tanstack/react-router";
import { BotApprovalRules } from "@/components/approvals/bot-rules";
import { GovernanceSurface } from "@/components/astryx-pilot/governance";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { BotDetailSurface } from "@/components/bot-profile/detail-surface";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/approvals")({
  component: ApprovalRulesPage,
});

function ApprovalRulesPage() {
  const { agentId } = Route.useParams();
  return (
    <BotDetailSurface>
      <BotSubpage
        agentId={agentId}
        description="Choose which actions this Bot can take without your approval."
        title="Approval rules"
      >
        {(agent) => (
          <GovernanceSurface>
            <BotApprovalRules agentId={agent.id} />
          </GovernanceSurface>
        )}
      </BotSubpage>
    </BotDetailSurface>
  );
}
