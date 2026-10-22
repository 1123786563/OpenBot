import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BotUnavailableNote } from "@/components/bot-profile/bot-subpage";
import { ManageSection } from "@/components/bot-profile/manage";
import { BotProfile } from "@/components/bot-profile/profile";
import { BotSettingsRows } from "@/components/bot-profile/settings-rows";
import { PageShell } from "@/components/layout/page-shell";
import {
  AgentUnavailableError,
  scopedAgentDetailQueryOptions,
} from "@/lib/agents/queries";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/")({
  component: BotProfilePage,
});

function BotProfilePage() {
  const { t } = useTranslation("agents");
  const { agentId } = Route.useParams();
  const navigate = useNavigate();
  // The detail read is bound to the scope this screen holds (MT084): keyed under the scope's own
  // cache prefix, carrying the selection pair, and refused if its answer outlives a switch.
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const agent = useQuery(
    scopedAgentDetailQueryOptions(queryClient, scope, agentId),
  );
  const toRoster = () => void navigate({ to: "/bots" });
  return (
    <PageShell
      backButton={{
        label: t("pages.profile.back"),
        linkProps: { to: "/bots" },
      }}
      description={t("pages.profile.description")}
      title={agent.data?.name ?? t("botSubpage.titleFallback")}
    >
      {agent.isPending ? null : agent.error ? (
        agent.error instanceof AgentUnavailableError ? (
          <BotUnavailableNote />
        ) : (
          <p className="mt-6 text-destructive text-sm" role="alert">
            {t("botSubpage.unreachable")}
          </p>
        )
      ) : (
        <BotProfile
          agent={agent.data}
          manage={
            <ManageSection
              agent={agent.data}
              scope={scope}
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
          settings={<BotSettingsRows agent={agent.data} />}
        />
      )}
    </PageShell>
  );
}
