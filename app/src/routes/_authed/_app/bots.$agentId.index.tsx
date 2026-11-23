import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
  const unavailable = botDetailsUnavailable(agent.error);
  const toRoster = () => void navigate({ to: "/bots" });
  return (
    <BotDetailSurface>
      <PageShell
        backButton={{ label: "Bots", linkProps: { to: "/bots" } }}
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
                  onDeleted={toRoster}
                  onDuplicated={(copyId) =>
                    void navigate({
                      params: { agentId: copyId },
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
