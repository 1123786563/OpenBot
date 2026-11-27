import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import {
  IconBook,
  IconBrain,
  IconLogout,
  IconMessageCirclePlus,
  IconMessages,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { useRef, useState } from "react";
import { useTranslation } from "@/i18n";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { ChannelAvatar } from "@/components/channels/avatar";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { BrandName } from "@/components/edition/brand-name";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useOffersMemory } from "@/lib/deployment/queries";
import { useSignOutOffered } from "@/lib/auth/sign-out-offered";
import { untitledLine } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { isNavigationLink, useNavigationItems } from "@/lib/navigation";
import { relativeTimeShort } from "@/lib/relative-time";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { BotsNavBadge } from "../bot-profile/attention";
import { BrowserNavItem } from "../browser/browser-nav-item";
import { navigationRender } from "../edition/team-features-dialog";
import { OpenBotVersion } from "../layout/openbot-version";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Channel } from "./channel";
import { ChannelPagination } from "./channel-pagination";
import { useSignOut } from "./use-sign-out";

const userMenuItemClassName = "gap-2 px-2 py-1.5";

function UserAvatar() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const initials =
    currentUser?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ?? currentUser?.email.slice(0, 2).toUpperCase();

  return (
    <HStack
      align="center"
      justify="center"
      className="size-8 shrink-0 overflow-hidden rounded-full bg-muted-foreground/10 text-xs"
    >
      {initials}
    </HStack>
  );
}

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

/**
 * The roster, narrowed to what the person typed.
 *
 * Matches the channel's name, its summary, its opening and the last message, because those are the
 * things the row can actually show — searching against something invisible returns results a person
 * cannot account for. The opening and the last message are included because one of them is what the
 * second line draws until the conversation has been named. Message history beyond that line is not
 * here to search: it lives in the thread store, and reaching for it is a server endpoint rather than
 * a filter.
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
export function matchingChannels(
  channels: ChannelSummary[] | undefined,
  query: string,
): ChannelSummary[] {
  if (!channels) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter((channel) =>
    [channel.name, channel.summary, channel.opening, channel.lastMessage].some(
      (field) => field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Pinned channels first, everything else after, newest activity first within each group.
 *
 * The mirror of a server rule, not the rule itself: the roster query orders pinned-first and its
 * cursor carries the pin, so a pinned channel arrives on page one however long ago it was last
 * spoken in. Sorting here as well is for what happens between refetches — the socket patches a pin
 * onto a loaded row without moving it, and re-sorts a page by recency alone — which is the same
 * reason `byRecency` in use-channel-events.ts mirrors the recency rule. A stable partition, so the
 * recency order inside each group is whatever arrived.
 */
export function pinnedFirst(channels: ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/**
 * Whether a Bot has said something this member has not had on screen yet.
 *
 * A Bot's message, and only a Bot's: your own message carries a null agent id and reading your own
 * words needs no marker. ISO-8601 strings compare correctly as strings, which is the same bet the
 * server's recency sort already makes.
 */
export function hasUnseenActivity(channel: ChannelSummary): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null) {
    return false;
  }
  return (
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/** Unseen activity somewhere you are not looking. The open channel never shows the dot. */
export function isUnread(
  channel: ChannelSummary,
  openChannelId: string | undefined,
): boolean {
  return channel.id !== openChannelId && hasUnseenActivity(channel);
}

/**
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor.
 */
function ChannelRow({
  channel,
  animateOrder,
  emphasis,
}: {
  channel: ChannelSummary;
  animateOrder: boolean;
  emphasis: MessageListEmphasis;
}) {
  const shouldReduceMotion = useReducedMotion();
  // Subscribes this row to the interface language, so choosing another one redraws its time in place.
  useTranslation();
  // Whether this row is unread, as a boolean, for the same reason `Channel` computes `isOpen`
  // that way: navigating re-renders the rows whose answer changed, not the whole roster.
  const unread = useParams({
    strict: false,
    select: (params) =>
      isUnread(channel, (params as { channelId?: string }).channelId),
  });
  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      initial={{
        opacity: 0,
        transform: shouldReduceMotion ? "none" : "translateY(-8px)",
      }}
      exit={{ opacity: 0 }}
      layout={animateOrder && !shouldReduceMotion ? "position" : false}
      transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
      <Channel
        emphasis={emphasis}
        channelId={channel.id}
        participantIds={channel.agentIds}
        name={channel.name}
        summary={channel.summary ?? undefined}
        untitled={untitledLine(channel)}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTimeShort(channel.lastMessageAt)
            : undefined
        }
        pinned={channel.pinned}
        canRename={channel.canRename ?? false}
        unread={unread}
        // A turn running, or work the conversation waits on between turns: a hop, a routine.
        busy={(channel.busy ?? false) || (channel.work?.length ?? 0) > 0}
      />
    </motion.div>
  );
}

export function AppSidebar({
  navId,
  returnFocus,
  desktopToggle,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  desktopToggle?: React.ReactNode;
  navId?: string;
  returnFocus?: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const emphasis = useMessageListEmphasis();
  const channels = useInfiniteQuery(channelListQueryOptions());
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();
  const [search, setSearch] = useState("");
  const scrollRoot = useRef<HTMLDivElement>(null);
  const searching = search.trim().length > 0;
  const visibleChannels = pinnedFirst(matchingChannels(channels.data, search));
  /*
   * FILTERING DOES NOT ANIMATE. Rows exit and relayout on every keystroke otherwise, which is a
   * list thrashing under somebody who is still typing — and the moving target is the very thing
   * they are trying to read. Order animation is for a channel that was just spoken in, which is
   * occasional; this is not.
   */
  const animateOrder =
    !searching && (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;
  const { isMobile } = useSidebar();
  const pane = useRouterState({
    select: ({ location: { pathname } }) => {
      if (pathname.startsWith("/bots/") && pathname !== "/bots/") return "bots";
      if (
        pathname === "/" ||
        pathname === "/bot" ||
        pathname.startsWith("/channel/") ||
        pathname.startsWith("/group/") ||
        pathname.startsWith("/start/")
      )
        return "chats";
      return null;
    },
  });

  return (
    <>
      {!isMobile ? (
        <WorkspaceNavigation inChat={pane === "chats"}>
          {pane ? desktopToggle : null}
        </WorkspaceNavigation>
      ) : null}
      {isMobile || pane ? (
        <Sidebar
          variant="inset"
          {...(navId
            ? {
                ...astryxScope,
                className: "astryx-web-nav",
                id: isMobile ? undefined : navId,
                mobileNavigation: {
                  title: t("nav.navigation", "Navigation"),
                  popup: {
                    ...astryxScope,
                    className: "astryx-web-nav",
                    id: navId,
                    finalFocus: returnFocus,
                  },
                },
              }
            : {})}
          {...props}
        >
          {isMobile ? <WorkspaceNavigation inChat={pane === "chats"} /> : null}
          {pane === "bots" ? (
            <BotRosterPane />
          ) : pane === "chats" ? (
            <>
              <SidebarHeader className="px-2 pb-1 pt-2">
                <HStack align="center" justify="between" gap={2}>
                  <Heading level={5} accessibilityLevel={2}>
                    {t("nav.conversations", "Conversations")}
                  </Heading>
                  <Button
                    aria-label={t("nav.newConversation", "New conversation")}
                    size="icon"
                    variant="ghost"
                    render={(props) => <Link {...props} to="/channel/new" />}
                  >
                    <IconMessageCirclePlus />
                  </Button>
                </HStack>
              </SidebarHeader>
              <SidebarContent ref={scrollRoot} className="scroll-fade-b">
                <SidebarGroup className="gap-px">
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <InputGroup className="bg-background text-sm rounded-lg h-9">
                        <InputGroupInput
                          aria-label={t(
                            "nav.searchConversations",
                            "Search conversations",
                          )}
                          onChange={(event) => setSearch(event.target.value)}
                          placeholder={t("nav.search", "Search…")}
                          value={search}
                        />
                        <InputGroupAddon>
                          <IconSearch />
                        </InputGroupAddon>
                      </InputGroup>
                    </SidebarMenuItem>
                    {/*
                     * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has
                     * used yet needs telling how to start. A roster that simply does not match what is in
                     * the box has to say so and quote it back — told "you don't have channels yet" while
                     * holding a typo, a person reads their conversations as gone.
                     */}
                    {searching && visibleChannels.length === 0 ? (
                      <SidebarMenuItem className="py-4">
                        <Empty className="min-h-0">
                          <EmptyHeader>
                            <EmptyTitle>
                              {channels.hasNextPage
                                ? t(
                                    "nav.empty.loadedSearch",
                                    "No loaded conversations match your search",
                                  )
                                : t(
                                    "nav.empty.search",
                                    "No conversations match your search",
                                  )}
                            </EmptyTitle>
                            <EmptyDescription className="text-pretty">
                              {channels.hasNextPage
                                ? t(
                                    "nav.empty.loadOlder",
                                    "Load older conversations to search more of your history.",
                                  )
                                : t(
                                    "nav.empty.noMatch",
                                    "No conversation has “{search}” in its name or latest message.",
                                    { search: search.trim() },
                                  )}
                            </EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      </SidebarMenuItem>
                    ) : null}
                    {!searching && channels.data?.length === 0 ? (
                      <SidebarMenuItem className="py-4">
                        <Empty className="min-h-0">
                          <EmptyHeader>
                            <EmptyTitle>
                              {t("nav.empty.title", "No conversations yet")}
                            </EmptyTitle>
                            <EmptyDescription className="text-pretty">
                              {t(
                                "nav.empty.description",
                                "Start a conversation with a Bot and it shows up here.",
                              )}
                            </EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      </SidebarMenuItem>
                    ) : null}
                    <AnimatePresence initial={false}>
                      {visibleChannels.map((channel) => (
                        <ChannelRow
                          emphasis={emphasis}
                          key={channel.id}
                          animateOrder={animateOrder}
                          channel={channel}
                        />
                      ))}
                    </AnimatePresence>
                    <ChannelPagination
                      query={channels}
                      scrollRoot={scrollRoot}
                      searching={searching}
                    />
                  </SidebarMenu>
                </SidebarGroup>
              </SidebarContent>
            </>
          ) : null}
          <SidebarRail />
        </Sidebar>
      ) : null}
    </>
  );
}

function BotRosterPane() {
  const { t } = useTranslation();
  const { data: agents } = useQuery(agentListQueryOptions());
  const [search, setSearch] = useState("");
  const needle = search.trim().toLocaleLowerCase();
  return (
    <>
      <SidebarHeader className="px-2 pb-1 pt-2">
        <HStack align="center" justify="between" gap={2}>
          <Heading level={5} accessibilityLevel={2}>
            {t("nav.bots", "Bots")}
          </Heading>
          <Button
            aria-label={t("nav.newBot", "New Bot")}
            size="icon"
            variant="ghost"
            render={(props) => (
              <Link {...props} to="/bots" search={{ new: true }} />
            )}
          >
            <IconPlus />
          </Button>
        </HStack>
        <InputGroup className="h-9 rounded-lg bg-background">
          <InputGroupInput
            aria-label={t("nav.searchBots", "Search Bots")}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("nav.search", "Search…")}
            value={search}
          />
          <InputGroupAddon>
            <IconSearch />
          </InputGroupAddon>
        </InputGroup>
      </SidebarHeader>
      <SidebarContent className="px-2">
        <SidebarMenu>
          {agents
            ?.filter((agent) => agent.name.toLocaleLowerCase().includes(needle))
            .map((agent) => (
              <SidebarMenuItem key={agent.id}>
                <SidebarMenuButton
                  className="h-10"
                  render={(props) => (
                    <Link
                      {...props}
                      to="/bots/$agentId"
                      params={{ agentId: agent.id }}
                      activeProps={{ "data-active": true }}
                    />
                  )}
                >
                  <ChannelAvatar participantIds={[agent.id]} size={22} />
                  <Text type="label" maxLines={1}>
                    {agent.name}
                  </Text>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
        </SidebarMenu>
      </SidebarContent>
    </>
  );
}

function WorkspaceNavigation({
  inChat,
  children,
}: {
  inChat: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const offersMemory = useOffersMemory();
  const navigation = useNavigationItems();
  const signOut = useSignOut();
  const signOutOffered = useSignOutOffered();
  const { setOpenMobile } = useSidebar();
  return (
    <VStack
      as="aside"
      className="astryx-workspace-nav px-2 py-3"
      gap={2}
      padding={2}
    >
      <Link
        to="/"
        aria-label={appConfig.brand.productName}
        className="astryx-workspace-brand"
      >
        <OpenBotLogo className="size-8" />
      </Link>
      <nav
        className="astryx-workspace-links"
        aria-label={t("nav.workspace", "Workspace")}
      >
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={inChat}
              render={(props) => (
                <Link {...props} to="/" activeOptions={{ exact: true }} />
              )}
            >
              <IconMessages aria-hidden />
              <Text type="label" color="inherit">
                {t("nav.chats", "Chats")}
              </Text>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {navigation
            .filter(isNavigationLink)
            .filter((item) => item.section === "primary")
            .map((item) =>
              item.id === "capabilities"
                ? {
                    ...item,
                    to: "/capabilities/skills" as const,
                    icon: IconBook,
                  }
                : item,
            )
            .map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  render={(props) => (
                    <Link
                      {...props}
                      to={item.to}
                      search={item.search}
                      activeProps={{ "data-active": true }}
                    />
                  )}
                >
                  <item.icon aria-hidden="true" />
                  <Text type="label" color="inherit">
                    {item.id === "connections"
                      ? t("nav.apps", "Apps")
                      : item.id === "capabilities"
                        ? t("nav.skills", "Skills")
                        : t(item.messageId, item.label)}
                  </Text>
                  {/* What waits on you across every Bot; Bots lists them first. */}
                  {item.id === "bots" ? <BotsNavBadge /> : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          {offersMemory ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                render={(props) => (
                  <Link
                    {...props}
                    to="/capabilities/memory"
                    activeProps={{ "data-active": true }}
                  />
                )}
              >
                <IconBrain aria-hidden />
                <Text type="label" color="inherit">
                  {t("nav.memory", "Memory")}
                </Text>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          {/* Your own browser, with the Recorder in it. Drawn only where OpenBot can run one for you. */}
          <BrowserNavItem />
        </SidebarMenu>
      </nav>
      {children}
      <SidebarFooter className="astryx-account">
        <SidebarMenu className="gap-px">
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={
                  currentUser?.name ||
                  currentUser?.email ||
                  t("nav.account", "Account")
                }
                render={
                  <SidebarMenuButton className="hover:bg-foreground/5 h-10" />
                }
              >
                <UserAvatar />
                <Text type="label" className="astryx-account-name" maxLines={1}>
                  {currentUser?.name || currentUser?.email}
                </Text>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="p-1.5"
                side="top"
                sideOffset={8}
              >
                {navigation
                  .filter((item) => item.section === "account")
                  .map((item) => (
                    <DropdownMenuItem
                      className={userMenuItemClassName}
                      key={item.id}
                      nativeButton={item.kind === "dialog"}
                      // A link closes a narrow window's sheet as it is followed; a dialog has to
                      // close it itself, or the sheet waits behind the dialog.
                      render={navigationRender(
                        item,
                        item.kind === "dialog"
                          ? { onClick: () => setOpenMobile(false) }
                          : {},
                      )}
                    >
                      <item.icon />
                      <BrandName>{t(item.messageId, item.label)}</BrandName>
                    </DropdownMenuItem>
                  ))}
                {signOutOffered ? (
                  <DropdownMenuItem
                    className={userMenuItemClassName}
                    disabled={signOut.pending}
                    onClick={signOut.run}
                    variant="destructive"
                  >
                    <IconLogout />
                    {t("nav.signOut", "Sign out")}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
        <OpenBotVersion className="text-center text-xs text-muted-foreground" />
      </SidebarFooter>
    </VStack>
  );
}
