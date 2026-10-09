import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BotProfile } from "@/components/bot-profile/profile";
import { PageShell } from "@/components/layout/page-shell";
import { agentQueryOptions } from "@/lib/agents/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId")({
  component: BotProfilePage,
});

function BotProfilePage() {
  const { t } = useTranslation("channels");
  const { agentId } = Route.useParams();
  const agent = useQuery(agentQueryOptions(agentId));
  return (
    <PageShell
      backButton={{ label: t("bots.title"), linkProps: { to: "/bots" } }}
      description={t("botProfile.description")}
      title={agent.data?.name ?? t("botProfile.titleFallback")}
    >
      {agent.isPending ? null : agent.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {t("botProfile.unreachable")}
        </p>
      ) : (
        <BotProfile agent={agent.data} />
      )}
    </PageShell>
  );
}
