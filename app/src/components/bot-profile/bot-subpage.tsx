import { useQuery, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/layout/page-shell";
import {
  AgentUnavailableError,
  type AgentProfile,
  scopedAgentDetailQueryOptions,
} from "@/lib/agents/queries";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/**
 * The frame of every `/bots/$agentId/<area>` page: back to the Bot by name, then the area.
 *
 * One frame so each area page is only its own rows, and so a Bot the person cannot reach says so in
 * the same words everywhere.
 *
 * Since MT084 (#127) the frame's detail read is bound to the scope the screen holds: keyed under
 * the scope's own cache prefix, carrying the selection pair, and answered by the generation guard —
 * so a residual route into a scope the person has left shows the one unavailable state, never the
 * row the old scope cached.
 */

/**
 * The one unavailable state every `/bots/$agentId` surface answers a 404 with (MT084 AC2).
 *
 * A coworker that never existed and one from a scope this person has left are the SAME state, in
 * the same words, because the server answered them the same way — a distinct sentence, or a
 * distinct status, would tell the reader which it was.
 */
export function BotUnavailableNote() {
  const { t } = useTranslation("agents");
  return (
    <p
      className="mt-6 text-muted-foreground text-sm"
      data-testid="bot-unavailable"
    >
      {t("botSubpage.unavailable")}
    </p>
  );
}

export function BotSubpage({
  agentId,
  title,
  description,
  children,
  width = "prose",
}: {
  agentId: string;
  title: string;
  description: string;
  children: (agent: AgentProfile) => React.ReactNode;
  width?: "prose" | "wide";
}) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const agent = useQuery(
    scopedAgentDetailQueryOptions(queryClient, scope, agentId),
  );
  const agentData = agent.data;
  return (
    <PageShell
      backButton={{
        label: agentData?.name ?? t("botSubpage.titleFallback"),
        linkProps: { params: { agentId }, to: "/bots/$agentId" },
      }}
      description={description}
      title={title}
      width={width}
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
        children(agent.data)
      )}
    </PageShell>
  );
}
