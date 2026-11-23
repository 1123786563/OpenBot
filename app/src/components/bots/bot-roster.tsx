import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { LinkProvider } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { IconChevronRight, IconShare } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  waitingOnYou,
} from "@/components/bot-profile/attention";
import { PageEmpty, PageSection } from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
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
import { ClientError } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";

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
export function BotRoster() {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const [search, setSearch] = useState("");
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const attention = useQuery(botAttentionQueryOptions());
  const list = useNeedsYou();
  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));

  if (agents.isPending) {
    return (
      <section role="status" aria-label="Loading Bots">
        <VStack gap={2}>
          {[1, 2, 3].map((row) => (
            <Skeleton key={row} height="3rem" />
          ))}
        </VStack>
      </section>
    );
  }
  if (agents.data === undefined) {
    const denied =
      agents.error instanceof ClientError && agents.error.status === 403;
    return denied ? (
      <Banner
        status="error"
        role="alert"
        title="You can’t view Bots in this workspace"
        description="Ask a workspace administrator for access."
        endContent={
          <AstryxButton as={Link} href="/" label="Back to workspace" />
        }
      />
    ) : (
      <ReadError
        message="Couldn’t load Bots"
        description="Try loading the list again."
        retry={() => agents.refetch()}
        retryBelow
        retryLabel="Retry"
        retrying={agents.isFetching}
      />
    );
  }
  const term = search.trim().toLocaleLowerCase();
  const visible = agents.data.filter((bot) =>
    [bot.name, bot.title].some((text) =>
      text.toLocaleLowerCase().includes(term),
    ),
  );
  const { pinned, yours, shared } = groupRoster(visible);

  return (
    <>
      {/*
       * What waits on the person, each thing under the Bot it came from and decided where it is.
       * A Bot waiting on them stays in its own section below too, with its badge.
       */}
      <NeedsYouBoard />
      {agents.data.length > 1 ? (
        <section>
          <TextInput
            label="Find a visible Bot"
            onChange={setSearch}
            size="lg"
            controlStyle={{ minBlockSize: "var(--spacing-11, 2.75rem)" }}
            value={search}
          />
        </section>
      ) : null}
      {term && visible.length === 0 ? (
        <p role="status">No Bots match “{search.trim()}”.</p>
      ) : null}
      {pinned.length ? (
        <PageSection title="Pinned">
          <RosterRows agents={pinned} byId={byId} />
        </PageSection>
      ) : null}
      {yours.length > 0 ? (
        <PageSection title="Yours">
          <RosterRows agents={yours} byId={byId} />
        </PageSection>
      ) : null}
      {!term && yours.length === 0 && pinned.some((bot) => bot.mine) ? (
        <p>Your Bots are all pinned above.</p>
      ) : null}
      {shared.length > 0 ? (
        <PageSection
          title={
            personal
              ? `Included with ${appConfig.brand.productName}`
              : "Shared with you"
          }
        >
          <RosterRows agents={shared} byId={byId} />
        </PageSection>
      ) : null}
      {agents.data.length === 0 ? (
        <PageEmpty icon={IconShare} title="No Bots available yet">
          Create a Bot to start working with it.
        </PageEmpty>
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
    <LinkProvider component={Link}>
      <List density="balanced" hasDividers>
        {agents.map((agent) => (
          <RosterRow key={agent.id} agent={agent} state={byId.get(agent.id)} />
        ))}
      </List>
    </LinkProvider>
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
    <ListItem
      href={`/bots/${encodeURIComponent(agent.id)}`}
      label={agent.name}
      description={summary || shownSubtitle(agent.title)}
      startContent={
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={28} />
      }
      endContent={
        <HStack gap={2} vAlign="center">
          {waiting > 0 ? <Badge label={String(waiting)} /> : null}
          <IconChevronRight size="1em" aria-hidden="true" />
        </HStack>
      }
    />
  );
}
