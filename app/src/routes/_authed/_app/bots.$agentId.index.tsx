import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ManageSection } from "@/components/bot-profile/manage";
import { BotProfile } from "@/components/bot-profile/profile";
import { BotSettingsRows } from "@/components/bot-profile/settings-rows";
import { PageShell } from "@/components/layout/page-shell";
import { agentQueryOptions } from "@/lib/agents/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/")({
  component: BotProfilePage,
});

function BotProfilePage() {
  const { t } = useTranslation("agents");
  const { agentId } = Route.useParams();
  const navigate = useNavigate();
  const agent = useQuery(agentQueryOptions(agentId));
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
        <p className="mt-6 text-destructive text-sm" role="alert">
          {t("botSubpage.unreachable")}
        </p>
      ) : (
        <BotProfile
          agent={agent.data}
          manage={
            <ManageSection
              agent={agent.data}
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
