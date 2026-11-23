import { HStack } from "@astryxdesign/core/HStack";
import { useQuery } from "@tanstack/react-query";
import { useParams, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { AttentionNotifier } from "@/components/bot-profile/attention";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { UpdateBanner } from "@/components/layout/update-banner";
import { SidebarInset, useSidebar } from "@/components/ui/sidebar";
import { chooseBot } from "@/lib/agents/chosen-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelQueryOptions } from "@/lib/channels/queries";
import { searchText } from "@/lib/search-text";
import { AstryxNavigationToggle } from "./navigation-toggle";
import { AstryxBrand, astryxScope } from "./theme";

export function AstryxWebShell({ children }: { children: ReactNode }) {
  return (
    <SidebarShell
      className="astryx-web-shell h-svh overflow-hidden"
      name="astryx-app"
      pageToggle={false}
      width="280px"
    >
      <AstryxWebFrame>{children}</AstryxWebFrame>
    </SidebarShell>
  );
}

function AstryxWebFrame({ children }: { children: ReactNode }) {
  useRememberActiveBot();
  const navId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const { isMobile, open } = useSidebar();

  return (
    <>
      <AttentionNotifier />
      <AppSidebar navId={navId} returnFocus={trigger} variant="sidebar" />
      <SidebarInset
        className="min-h-0 min-w-0 overflow-hidden"
        id="main-content"
        tabIndex={-1}
      >
        <HStack
          {...astryxScope}
          as="header"
          align="center"
          gap={2}
          paddingInline={3}
          minHeight="var(--spacing-12)"
          style={{
            ...astryxScope.style,
            flexShrink: 0,
            borderBlockEnd: "thin solid var(--color-border)",
          }}
        >
          <AstryxNavigationToggle navId={navId} trigger={trigger} />
          {isMobile || !open ? <AstryxBrand /> : null}
        </HStack>
        <UpdateBanner />
        <SelfHostBanner />
        {children}
      </SidebarInset>
    </>
  );
}

/** Goals and Activity keep the last accessible Bot opened directly or in a one-to-one conversation. */
function useRememberActiveBot() {
  const { agentId, channelId } = useParams({ strict: false });
  const addressed = useRouterState({
    select: ({ location }) =>
      location.pathname === "/channel/new" || location.pathname === "/bot"
        ? searchText(location.search.agent)
        : undefined,
  });
  const { data: user } = useQuery(currentUserQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  const { data: channel } = useQuery({
    ...channelQueryOptions(channelId ?? ""),
    enabled: Boolean(channelId),
  });
  const activeBotId =
    channel?.agentIds.length === 1
      ? channel.agentIds[0]
      : (agentId ?? addressed);
  const userId = user?.id;
  useEffect(() => {
    if (userId && activeBotId && agents?.some(({ id }) => id === activeBotId)) {
      chooseBot(userId, activeBotId);
    }
  }, [userId, activeBotId, agents]);
}
