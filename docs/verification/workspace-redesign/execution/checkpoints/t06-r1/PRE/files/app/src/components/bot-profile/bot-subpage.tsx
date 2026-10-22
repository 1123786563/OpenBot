import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/layout/page-shell";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";

/**
 * The frame of every `/bots/$agentId/<area>` page: back to the Bot by name, then the area.
 *
 * One frame so each area page is only its own rows, and so a Bot the person cannot reach says so in
 * the same words everywhere.
 */
export function BotSubpage({
  agentId,
  title,
  description,
  children,
}: {
  agentId: string;
  title: string;
  description: string;
  children: (agent: AgentProfile) => React.ReactNode;
}) {
  const { t } = useTranslation("agents");
  const agent = useQuery(agentQueryOptions(agentId));
  const agentData = agent.data;
  return (
    <PageShell
      backButton={{
        label: agentData?.name ?? t("botSubpage.titleFallback"),
        linkProps: { params: { agentId }, to: "/bots/$agentId" },
      }}
      description={description}
      title={title}
    >
      {!agentData && !agent.isPending ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {t("botSubpage.unreachable")}
        </p>
      ) : null}
      {agentData ? (
        <>
          {agent.error ? (
            <p className="mt-6 text-destructive text-sm" role="alert">
              {t("botSubpage.unreachable")}
            </p>
          ) : null}
          {children(agentData)}
        </>
      ) : null}
    </PageShell>
  );
}
