import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Text } from "@astryxdesign/core/Text";
import { IconBolt, IconChevronRight, IconShare } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type MouseEventHandler, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { NewBotAction } from "@/components/astryx-pilot/bot-actions";

import {
  attentionSummary,
  waitingOnYou,
} from "@/components/bot-profile/attention";
import { PageEmpty, PageSection } from "@/components/layout/page-shell";
import { NeedsYouBoard } from "@/components/needs-you/board";
import { DoneTasks, useNeedsYou } from "@/components/needs-you/needs-you";
import { Button } from "@/components/ui/button";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { groupRoster } from "@/lib/agents/roster";
import { shownSubtitle } from "@/lib/agents/subtitle";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Every Bot the person can reach, in the one place they are listed: what needs the person first,
 * then pinned, then their own, then the ones shared with them, and the ones they hid folded away at
 * the end.
 *
 * Needs you is where the sidebar's badge leads, so it holds everything behind that number in one
 * card: the Bots with a question, an approval or a stalled hand-off (answered on the Bot's page),
 * the tasks started from check-ins, and what every Bot's check-ins found, each row naming its Bot.
 *
 * This replaces three screens (Bots, Agents and Team Bots) that listed the same Bots three ways.
 */
export function BotRoster({
  onNewBotClick,
}: {
  onNewBotClick?: MouseEventHandler<HTMLElement>;
}) {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const attention = useQuery(botAttentionQueryOptions());
  const list = useNeedsYou();
  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));

  if (agents.isPending) return null;
  // Only when nothing ever loaded: a failed background refetch keeps the roster it had.
  if (agents.data === undefined) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        Couldn't load your Bots. Reload the page.
      </p>
    );
  }
  // Every Bot stays in its own section; what it waits on is on the board above, by name.
  const { pinned, yours, shared } = groupRoster(agents.data);
  const yoursPinned = pinned.some((agent) => agent.mine);

  return (
    <>
      {/*
       * What waits on the person, each thing under the Bot it came from and decided where it is.
       * A Bot waiting on them stays in its own section below too, with its badge.
       */}
      <NeedsYouBoard />
      {pinned.length ? (
        <PageSection title="Pinned">
          <RosterRows agents={pinned} byId={byId} />
        </PageSection>
      ) : null}
      <PageSection title="Yours">
        {yours.length ? (
          <RosterRows agents={yours} byId={byId} />
        ) : (
          <PageEmpty
            action={
              yoursPinned ? undefined : <NewBotAction onClick={onNewBotClick} />
            }
            icon={IconBolt}
            title={yoursPinned ? "All pinned" : "No Bots yet"}
          >
            {yoursPinned
              ? "Your Bots are all pinned above."
              : "Bots you create show up here."}
          </PageEmpty>
        )}
      </PageSection>
      {shared.length > 0 || !personal ? (
        <PageSection
          title={personal ? "Included with OpenBot" : "Shared with you"}
        >
          {shared.length ? (
            <RosterRows agents={shared} byId={byId} />
          ) : (
            <PageEmpty icon={IconShare} title="Nothing shared yet">
              Bots somebody shares with you show up here.
            </PageEmpty>
          )}
        </PageSection>
      ) : null}
      <DoneTasks done={list.done} />
      {hidden.data?.length ? (
        <HiddenSection agents={hidden.data} byId={byId} personal={personal} />
      ) : null}
    </>
  );
}

/**
 * The Bots this person hid, folded until asked for: a way back for somebody who hid something, not
 * a fourth list everybody reads past. A Bot's page is where Unhide lives. The personal edition has
 * nobody else with a list, so it doesn't say only theirs changed.
 */
function HiddenSection({
  agents,
  byId,
  personal,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
  personal: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PageSection
      action={
        <Button onClick={() => setOpen(!open)} size="sm" variant="ghost">
          {open ? "Hide" : "Show"}
        </Button>
      }
      description={`${agents.length} ${agents.length === 1 ? "Bot" : "Bots"} you hid.${personal ? "" : " Only your list changes."}`}
      title="Hidden"
    >
      {open ? <RosterRows agents={agents} byId={byId} /> : null}
    </PageSection>
  );
}

function RosterRows({
  agents,
  byId,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
}) {
  return (
    <Card className="astryx-bot-rows mt-2" padding={4}>
      {agents.map((agent) => (
        <RosterRow agent={agent} key={agent.id} state={byId.get(agent.id)} />
      ))}
    </Card>
  );
}

/**
 * One Bot, opening its page. The count is everything from it that waits on the person, its
 * check-in items and tasks included, so a Bot whose items are listed under Needs you still says so
 * wherever it sits.
 */
function RosterRow({
  agent,
  state,
}: {
  agent: AgentProfile;
  state: BotAttention | undefined;
}) {
  const summary = state
    ? [state.paused ? "Paused" : "", attentionSummary(state)]
        .filter(Boolean)
        .join(" · ")
    : "";
  const waiting = state ? waitingOnYou(state) : 0;
  return (
    <Link
      className="astryx-bot-row"
      params={{ agentId: agent.id }}
      to="/bots/$agentId"
    >
      <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={32} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Text weight="semibold">{agent.name}</Text>
        <Text color="secondary" size="sm">
          {summary || shownSubtitle(agent.title)}
        </Text>
      </div>
      {waiting > 0 ? <Badge label={waiting} /> : null}
      <IconChevronRight aria-hidden className="size-4 shrink-0" />
    </Link>
  );
}
