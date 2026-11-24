import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
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
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BotSubpage
        agentId={agentId}
        description="Open a goal to edit what this Bot should do, change when it runs, or see past results."
        headingRef={heading}
        title="Goals"
      >
        {(agent) => (
          <BotResponsibilities
            agentId={agent.id}
            pageHeading={heading}
            searchable
          />
        )}
      </BotSubpage>
    </AstryxSurface>
  );
}
