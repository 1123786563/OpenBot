import { createFileRoute } from "@tanstack/react-router";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";

export const Route = createFileRoute(
  "/_authed/_app/bots/$agentId/responsibilities",
)({
  component: ResponsibilitiesPage,
});

function ResponsibilitiesPage() {
  const { agentId } = Route.useParams();
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BotSubpage
        agentId={agentId}
        description="Review this Bot’s ongoing goals, what triggered each run, and its results."
        title={"Responsibilities"}
      >
        {(agent) => <BotResponsibilities agentId={agent.id} />}
      </BotSubpage>
    </AstryxSurface>
  );
}
