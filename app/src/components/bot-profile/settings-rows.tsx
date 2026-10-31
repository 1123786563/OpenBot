import {
  IconBrain,
  IconChecks,
  IconChevronRight,
  IconClock,
  IconDeviceMobile,
  IconPuzzle,
  IconSettings,
  IconTargetArrow,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  accessSummary,
  countLabel,
  reachSummary,
  researchSummary,
  setupSummary,
  sharingSummary,
} from "@/lib/agents/bot-summaries";
import type { AgentProfile } from "@/lib/agents/queries";
import { ruleCoversBot, scopedApprovalInboxOptions } from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deliveryQueryOptions } from "@/lib/delivery";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { teamBotsQueryOptions } from "@/lib/team-bots";
import { connectorCount } from "./access";

type Row = {
  to:
    | "/bots/$agentId/responsibilities"
    | "/bots/$agentId/reach"
    | "/bots/$agentId/memory"
    | "/bots/$agentId/approvals"
    | "/bots/$agentId/routines"
    | "/bots/$agentId/access"
    | "/bots/$agentId/sharing"
    | "/bots/$agentId/setup";
  title: string;
  icon: typeof IconClock;
  summary: string;
};

/**
 * One row per area of this Bot's configuration, each stating its current answer and opening the page
 * that changes it. Sharing is for its owner, administrators, and anyone it is published to.
 */
export function BotSettingsRows({ agent }: { agent: AgentProfile }) {
  const { t } = useTranslation("agents");
  const me = useQuery(currentUserQueryOptions()).data;
  const routines = useQuery(routinesQueryOptions());
  const plugins = useQuery(agentPluginsQueryOptions(agent.id));
  const teamBots = useQuery(teamBotsQueryOptions());
  const published = teamBots.data?.teamBots.find((bot) => bot.id === agent.id);
  // Its owner and administrators change it there; anyone it is published to finds its link there.
  const canShare =
    agent.mine || me?.role === "admin" || published !== undefined;

  const goals = useQuery(responsibilitiesQueryOptions());
  const reach = useQuery(deliveryQueryOptions());
  const research = useQuery(proactiveSettingsQueryOptions());
  // The inbox count rides the scope the screen holds (MOD19 / Issue #639, T1b).
  const cache = useQueryClient();
  const scope = useScopedCache();
  const approvals = useQuery(scopedApprovalInboxOptions(cache, scope));

  const rows: Row[] = [
    {
      to: "/bots/$agentId/responsibilities",
      title: t("botSettings.rows.responsibilities"),
      icon: IconTargetArrow,
      summary: goals.data
        ? countLabel(
            goals.data.filter(
              (goal) => goal.agentId === agent.id && goal.status === "active",
            ).length,
            t("botSettings.count.active"),
            t("botSettings.count.active"),
            t("botSettings.count.noneActive"),
          )
        : "",
    },
    {
      to: "/bots/$agentId/reach",
      title: t("botSettings.rows.reach"),
      icon: IconDeviceMobile,
      summary: reach.data
        ? reachSummary(
            reach.data.bindings
              .filter(
                (binding) => binding.enabled && binding.agentId === agent.id,
              )
              .map((binding) => binding.transport),
          )
        : "",
    },
    {
      to: "/bots/$agentId/memory",
      title: t("botSettings.rows.memory"),
      icon: IconBrain,
      // #732: the memory service owns what this Bot remembers; what stays here is its
      // background-research setting, the one non-memory duty on this page.
      summary: research.data
        ? researchSummary(
            research.data.some(
              (setting) => setting.agentId === agent.id && setting.enabled,
            ),
          )
        : "",
    },
    {
      to: "/bots/$agentId/approvals",
      title: t("botSettings.rows.approvals"),
      icon: IconChecks,
      summary: approvals.data
        ? countLabel(
            approvals.data.rules.filter(
              (rule) =>
                rule.botId !== "*" && ruleCoversBot(rule.botId, agent.id),
            ).length,
            t("botSettings.count.ruleOne"),
            t("botSettings.count.ruleMany"),
            t("botSettings.count.noRules"),
          )
        : "",
    },
    {
      to: "/bots/$agentId/routines",
      title: t("botSettings.rows.routines"),
      icon: IconClock,
      summary: routines.data
        ? countLabel(
            routines.data.routines.filter((row) => row.agentId === agent.id)
              .length,
            t("botSettings.count.routineOne"),
            t("botSettings.count.routineMany"),
            t("botSettings.count.noRoutines"),
          )
        : "",
    },
    {
      to: "/bots/$agentId/access",
      title: t("botSettings.rows.access"),
      icon: IconPuzzle,
      summary: plugins.data
        ? accessSummary(
            plugins.data.skills.length,
            connectorCount(plugins.data),
          )
        : "",
    },
    ...(canShare
      ? [
          {
            to: "/bots/$agentId/sharing" as const,
            title: t("botSettings.rows.sharing"),
            icon: IconUsersGroup,
            summary: teamBots.data
              ? sharingSummary(published, agent.visibility)
              : "",
          },
        ]
      : []),
    {
      to: "/bots/$agentId/setup",
      title: t("botSettings.rows.setup"),
      icon: IconSettings,
      summary: setupSummary(agent),
    },
  ];

  return (
    <PageSection title={t("botSettings.title")}>
      <PageRows>
        {rows.map(({ to, title, icon: Icon, summary }, index) => (
          <Fragment key={to}>
            {index > 0 ? <Separator /> : null}
            <Item
              render={<Link params={{ agentId: agent.id }} to={to} />}
              size="sm"
            >
              <ItemMedia variant="icon">
                <Icon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{title}</ItemTitle>
                <ItemDescription>{summary}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}
