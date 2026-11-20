import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { BotDetailSurface } from "@/components/bot-profile/detail-surface";
import { SetupSections } from "@/components/bot-profile/setup";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/setup")({
  component: SetupPage,
});

function SetupPage() {
  const { agentId } = Route.useParams();
  return (
    <BotDetailSurface>
      <BotSubpage
        agentId={agentId}
        description="Edit this Bot’s profile, visibility, and runtime settings."
        title="Setup"
      >
        {(agent) => <SetupSections agent={agent} />}
      </BotSubpage>
    </BotDetailSurface>
  );
}
