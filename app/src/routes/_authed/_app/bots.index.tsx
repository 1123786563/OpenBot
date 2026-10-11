import { IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  needsInput,
} from "@/components/bot-profile/attention";
import { PageEmpty, PageRows, PageShell } from "@/components/layout/page-shell";
import { PageRowsSkeleton } from "@/components/layout/page-skeletons";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";

export const Route = createFileRoute("/_authed/_app/bots/")({
  component: BotsPage,
});

/** Every Bot the person can reach, with what each needs from them, each opening its profile. */
function BotsPage() {
  const { t } = useTranslation("channels");
  const agents = useQuery(agentListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));
  return (
    <PageShell description={t("bots.description")} title={t("bots.title")}>
      {agents.isPending ? (
        <PageRowsSkeleton />
      ) : agents.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {t("bots.loadError")}
        </p>
      ) : agents.data.length === 0 ? (
        <PageEmpty>{t("bots.empty")}</PageEmpty>
      ) : (
        <PageRows className="mt-6">
          {agents.data.map((agent, index) => {
            const state = byId.get(agent.id);
            const summary = state
              ? [state.paused ? t("bots.paused") : "", attentionSummary(state)]
                  .filter(Boolean)
                  .join(" · ")
              : "";
            return (
              <Fragment key={agent.id}>
                {index > 0 ? <Separator /> : null}
                <Item
                  render={
                    <Link params={{ agentId: agent.id }} to="/bots/$agentId" />
                  }
                  size="sm"
                >
                  <ItemMedia>
                    <AbstractAvatar
                      name={agent.name}
                      seed={agent.avatarSeed}
                      size={28}
                    />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{agent.name}</ItemTitle>
                    <ItemDescription>{summary || agent.title}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {state && needsInput(state) > 0 ? (
                      <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums">
                        {needsInput(state)}
                      </span>
                    ) : null}
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageShell>
  );
}
