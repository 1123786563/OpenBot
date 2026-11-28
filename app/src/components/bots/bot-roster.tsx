import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { HStack } from "@astryxdesign/core/HStack";
import { LinkProvider } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import {
  IconChevronRight,
  IconListSearch,
  IconShare,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { type MouseEvent, useLayoutEffect, useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  waitingOnYou,
} from "@/components/bot-profile/attention";
import { PageEmpty, PageSection } from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
import { NeedsYouBoard } from "@/components/needs-you/board";
import { DoneTasks, useNeedsYou } from "@/components/needs-you/needs-you";
import { Button, buttonVariants } from "@/components/ui/button";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { groupRoster } from "@/lib/agents/roster";
import { shownSubtitle } from "@/lib/agents/subtitle";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { ClientError, canKeepCachedRead } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";

let lastOpenedBot:
  | {
      historyEntry: string;
      historyIndex: number;
      href: string;
      hidden: boolean;
      search: string;
    }
  | undefined;

export function previousBotRoster(agentId: string, historyIndex: number) {
  const previous = lastOpenedBot;
  if (
    previous?.href === `/bots/${encodeURIComponent(agentId)}` &&
    previous.historyIndex + 1 === historyIndex
  ) {
    return { search: previous.search };
  }
}

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
  search: query,
  onSearchChange,
  focusAfterRetry,
}: {
  search?: string;
  onSearchChange?: (query: string) => void;
  focusAfterRetry?: () => HTMLElement | null;
} = {}) {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const [localSearch, setLocalSearch] = useState("");
  const search = query ?? localSearch;
  const setSearch = onSearchChange ?? setLocalSearch;
  const searchBox = useRef<HTMLInputElement>(null);
  const directory = useRef<HTMLElement>(null);
  const historyEntry = useLocation({
    select: (location) => location.state.__TSR_key,
  });
  const historyIndex = useLocation({
    select: (location) => location.state.__TSR_index,
  });
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const attention = useQuery(botAttentionQueryOptions());
  const list = useNeedsYou();
  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));
  const denied =
    agents.error instanceof ClientError &&
    (agents.error.status === 401 || agents.error.status === 403);
  const loaded =
    canKeepCachedRead(agents.error) &&
    agents.data !== undefined &&
    (!agents.error || agents.data.length > 0);
  const restoreHidden = Boolean(
    lastOpenedBot?.hidden && lastOpenedBot.historyEntry === historyEntry,
  );

  useLayoutEffect(() => {
    if (
      !loaded ||
      !lastOpenedBot ||
      lastOpenedBot.historyEntry !== historyEntry ||
      (restoreHidden && hidden.isPending)
    )
      return;
    const target = Array.from(
      directory.current?.querySelectorAll("a[href]") ?? [],
    ).find((link) => link.getAttribute("href") === lastOpenedBot?.href);
    lastOpenedBot = undefined;
    if (document.activeElement === document.body) {
      if (target instanceof HTMLElement) target.focus();
      else searchBox.current?.focus();
    }
  }, [hidden.isPending, historyEntry, loaded, restoreHidden]);

  function rememberBot(event: MouseEvent<HTMLElement>) {
    if (
      !historyEntry ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const href =
      event.target instanceof Element
        ? event.target.closest("a[href]")?.getAttribute("href")
        : undefined;
    if (href?.startsWith("/bots/")) {
      lastOpenedBot = {
        historyEntry,
        historyIndex,
        search,
        href,
        hidden:
          hidden.data?.some(
            ({ id }) => href === `/bots/${encodeURIComponent(id)}`,
          ) ?? false,
      };
    }
  }

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
  if (!loaded || agents.data === undefined) {
    return denied ? (
      <Banner
        status="error"
        role="alert"
        title="You can’t view Bots in this workspace"
        description="Ask a workspace administrator for access."
        endContent={
          <Link
            className={buttonVariants({
              className: "min-h-11",
              variant: "outline",
            })}
            to="/"
          >
            Back to workspace
          </Link>
        }
      />
    ) : (
      <ReadError
        focusAfterRetry={focusAfterRetry}
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
  const matches = ({ name, title }: AgentProfile) =>
    [name, title].some((text) => text.toLocaleLowerCase().includes(term));
  const visible = agents.data.filter(matches);
  const hiddenBots = agents.error || hidden.error ? [] : (hidden.data ?? []);
  const hiddenMatches = hiddenBots.filter(matches);
  const matchCount = visible.length + hiddenMatches.length;
  const hiddenPending = !agents.error && hidden.isPending;
  const noMatches = Boolean(term) && matchCount === 0 && !hiddenPending;
  const { pinned, yours, shared } = groupRoster(visible);

  return (
    <>
      {/*
       * What waits on the person, each thing under the Bot it came from and decided where it is.
       * A Bot waiting on them stays in its own section below too, with its badge.
       */}
      {agents.error ? (
        <ReadError
          description="Showing the last loaded Bots. Refresh to update the list."
          focusAfterRetry={focusAfterRetry}
          message="Couldn’t refresh Bots"
          retry={agents.refetch}
          retryBelow
          retrying={agents.isFetching}
        />
      ) : (
        <NeedsYouBoard />
      )}
      <section
        aria-label="Bot directory"
        ref={directory}
        onClickCapture={rememberBot}
      >
        {agents.data.length > 1 || hiddenBots.length || search ? (
          <VStack gap={2}>
            <TextInput
              hasClear
              label="Search Bots"
              onChange={setSearch}
              onEnter={() =>
                directory.current
                  ?.querySelector<HTMLAnchorElement>('a[href^="/bots/"]')
                  ?.focus()
              }
              onKeyDown={(event) => {
                if (event.key === "Escape" && search) {
                  event.preventDefault();
                  setSearch("");
                }
              }}
              ref={searchBox}
              placeholder="Name or role"
              size="lg"
              type="search"
              controlClassName="[&_input]:min-h-11 [&_button]:min-h-11 [&_button]:min-w-11"
              controlStyle={{
                minBlockSize: "var(--spacing-11)",
                paddingInlineStart: "var(--spacing-3)",
              }}
              value={search}
            />
            <p
              className={
                noMatches ? "sr-only" : "text-muted-foreground text-sm"
              }
              role="status"
            >
              {term && hiddenPending
                ? "Searching hidden Bots…"
                : term
                  ? `${matchCount} matching ${matchCount === 1 ? "Bot" : "Bots"}.`
                  : null}
            </p>
          </VStack>
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
        {noMatches ? (
          <PageEmpty
            icon={IconListSearch}
            title={`No ${agents.error || hidden.error ? "visible " : ""}Bots match “${search.trim()}”.`}
          >
            Try a shorter name or a word from the Bot’s role.
          </PageEmpty>
        ) : !term &&
          agents.data.length === 0 &&
          !hiddenBots.length &&
          !hiddenPending ? (
          <PageEmpty icon={IconShare} title="No Bots available yet">
            Create a Bot to start working with it.
          </PageEmpty>
        ) : null}
        {!term && !agents.error ? <DoneTasks done={list.done} /> : null}
        {!agents.error && hidden.error ? (
          <ReadError
            message="Couldn’t load hidden Bots"
            retry={hidden.refetch}
            retryBelow
            retryLabel="Retry hidden Bots"
            retrying={hidden.isFetching}
            focusAfterRetry={() =>
              searchBox.current ?? focusAfterRetry?.() ?? null
            }
          />
        ) : null}
        {hiddenMatches.length ? (
          <HiddenSection
            agents={hiddenMatches}
            byId={byId}
            filtering={Boolean(term)}
            initiallyOpen={restoreHidden && !term}
            personal={personal}
          />
        ) : null}
      </section>
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
  filtering,
  initiallyOpen,
  personal,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
  filtering: boolean;
  initiallyOpen: boolean;
  personal: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <PageSection
      action={
        filtering ? undefined : (
          <Button
            aria-expanded={open}
            className="min-h-11"
            onClick={() => setOpen(!open)}
            size="sm"
            variant="ghost"
          >
            {open ? "Hide hidden Bots" : "Show hidden Bots"}
          </Button>
        )
      }
      description={
        filtering
          ? "Hidden Bots matching your search."
          : `${agents.length} ${agents.length === 1 ? "Bot" : "Bots"} you hid.${personal ? "" : " Only your list changes."}`
      }
      title="Hidden"
    >
      {open || filtering ? <RosterRows agents={agents} byId={byId} /> : null}
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
