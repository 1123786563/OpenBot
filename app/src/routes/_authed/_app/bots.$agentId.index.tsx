import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
  BotDetailsState,
  botDetailsUnavailable,
} from "@/components/bot-profile/bot-details-state";
import { BotDetailSurface } from "@/components/bot-profile/detail-surface";
import { ManageSection } from "@/components/bot-profile/manage";
import { BotProfile } from "@/components/bot-profile/profile";
import { BotSettingsRows } from "@/components/bot-profile/settings-rows";
import { PageShell } from "@/components/layout/page-shell";
import { agentQueryOptions } from "@/lib/agents/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/")({
  component: BotProfilePage,
});

function BotProfilePage() {
  const { agentId } = Route.useParams();
  const navigate = useNavigate();
  const agent = useQuery(agentQueryOptions(agentId));
  const createdBotId = useLocation({
    select: (location) => location.state.createdBotId,
  });
  const heading = useRef<HTMLHeadingElement>(null);
  const focusedBotId = useRef<string | undefined>(undefined);
  const ready = !agent.isPending;
  useEffect(() => {
    if (createdBotId !== agentId || !ready || focusedBotId.current === agentId)
      return;
    focusedBotId.current = agentId;
    if (document.activeElement === document.body) heading.current?.focus();
  }, [agentId, createdBotId, ready]);
  const unavailable = botDetailsUnavailable(agent.error);
  const toRoster = () => void navigate({ to: "/bots" });
  return (
    <BotDetailSurface>
      <PageShell
        backButton={{ label: "Bots", linkProps: { to: "/bots" } }}
        headingRef={heading}
        // No description: the Bot's own role, under its orb just below, says what this page is about.
        title={unavailable ? "Bot unavailable" : (agent.data?.name ?? "Bot")}
      >
        <BotDetailsState query={agent}>
          {(details) => (
            <BotProfile
              agent={details}
              manage={
                <ManageSection
                  agent={details}
                  key={details.id}
                  onDeleted={toRoster}
                  onDuplicated={(copyId) =>
                    void navigate({
                      params: { agentId: copyId },
                      state: { createdBotId: copyId },
                      to: "/bots/$agentId",
                    })
                  }
                  onHidden={toRoster}
                />
              }
              settings={<BotSettingsRows agent={details} />}
            />
          )}
        </BotDetailsState>
      </PageShell>
    </BotDetailSurface>
  );
}
