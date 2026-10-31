import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/memory")({
  component: MemoryPage,
});

function MemoryPage() {
  const { t } = useTranslation("agents");
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={t("pages.memory.description")}
      title={t("pages.memory.title")}
    >
      {(agent) => (
        <>
          <p className="mt-6 text-muted-foreground text-sm">
            {t("pages.memory.settingsIntro")}{" "}
            <Link className="underline underline-offset-4" to="/memory">
              {t("pages.memory.settingsLink")}
            </Link>
            {t("pages.memory.settingsOutro")}
          </p>
          <ProactiveResearchSettings agentId={agent.id} />
        </>
      )}
    </BotSubpage>
  );
}
