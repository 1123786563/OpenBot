import { Banner } from "@astryxdesign/core/Banner";
import {
  IconBell,
  IconChevronRight,
  IconDeviceDesktop,
  IconMessage,
  IconPlayerPause,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { BotNeedsYou } from "@/components/needs-you/board";
import { DoneTasks, useNeedsYou } from "@/components/needs-you/needs-you";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import { shownSubtitle } from "@/lib/agents/subtitle";
import {
  setBotNotifyMutationOptions,
  setBotPausedMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type BotNotify,
  botLifecycleQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { computerToolsOffered } from "@/lib/copilot/computer-available";
import { myCapabilitiesQueryOptions } from "@/lib/enterprise/queries";
import {
  requestNotificationPermission,
  useNotificationPermission,
} from "@/lib/notifications/permission";
import { queryClient } from "@/query-client";
import { BotActivityGlance, BotActivityRow } from "./activity";
import { BotPausedBanner } from "./pause-banner";

const NOTIFY_LABEL: Record<BotNotify, string> = {
  all: "Everything",
  needs_input: "Only when it needs me",
  none: "Nothing (badges only)",
};

/**
 * A Bot's own page: what it needs from you, its state for you, what it is doing, the tasks you marked
 * done this week, its settings, and what can be done to it.
 */
export function BotProfile({
  agent,
  settings,
  manage,
}: {
  agent: AgentProfile;
  /** The "Settings for this Bot" card. */
  settings?: React.ReactNode;
  /** Pin, hide, duplicate, reset, delete. */
  manage?: React.ReactNode;
}) {
  const lifecycle = useQuery(botLifecycleQueryOptions(agent.id));
  const { done } = useNeedsYou(agent.id);
  const capabilities = useQuery(myCapabilitiesQueryOptions());
  const computer = computerToolsOffered({
    profile: agent,
    capabilities: capabilities.data?.capabilities,
  });
  const pause = useMutation(setBotPausedMutationOptions(queryClient));
  const notify = useMutation(setBotNotifyMutationOptions(queryClient));
  // The browser's answer, shared with the prompt a conversation offers, so a yes there shows here.
  const permission = useNotificationPermission();

  return (
    <>
      <div className="mt-6 flex items-center gap-3">
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={40} />
        <div className="min-w-0">
          {/* Up to three lines, so a phone shows the whole of a subtitle like the starter's. */}
          {agent.title && (
            <p className="line-clamp-3 text-pretty font-medium">
              {shownSubtitle(agent.title)}
            </p>
          )}
          <p className="line-clamp-2 text-muted-foreground text-sm">
            {agent.roleDescription}
          </p>
        </div>
      </div>
      <div className="mt-4">
        <BotPausedBanner agentId={agent.id} />
        {capabilities.isSuccess && (computer.browser || computer.computer) ? (
          <Link
            className={buttonVariants({ size: "sm", variant: "outline" })}
            search={{ agent: agent.id, watch: true }}
            to="/bot"
          >
            <IconDeviceDesktop />
            Open Computer
          </Link>
        ) : null}
      </div>

      {/* Its questions and approvals, its tasks, and what its check-ins found, in one card. */}
      <BotNeedsYou agentId={agent.id} />

      <PageSection title="For you">
        {/* Whether this Bot's Shared-app calls are being refused right now, with the button that
            asks an administrator. About its present reach, so it lives here, not only where
            publishing happens. */}
        {agent.canManage ? (
          <SharedAppNotice botId={agent.id} reason="publish" />
        ) : null}
        {lifecycle.isPending ? (
          <ReadStatus kind="loading" message="Loading your Bot settings…" />
        ) : lifecycle.error ? (
          <ReadError
            message="Couldn’t load your Bot settings"
            retry={() => lifecycle.refetch()}
            retryBelow
            retrying={lifecycle.isFetching}
          />
        ) : (
          <>
            {pause.isError && (
              <Banner
                description="Use Active to try again."
                role="alert"
                status="error"
                title={
                  pause.variables.paused
                    ? "Couldn’t pause this Bot"
                    : "Couldn’t resume this Bot"
                }
              />
            )}
            {notify.isError && (
              <Banner
                description="Choose your notification preference again."
                role="alert"
                status="error"
                title="Couldn’t save notifications"
              />
            )}
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconPlayerPause />
                </ItemMedia>
                <ItemContent>
                  {/* On means working, the way a responsibility's Active switch reads: titled "Paused",
                    the row showed the word "Paused" beside a switch that was off for a running Bot. */}
                  <ItemTitle>Active</ItemTitle>
                  <ItemDescription>
                    {lifecycle.data.paused
                      ? "Paused. Nothing runs for you until you turn it back on."
                      : "Works on its goals, routines, hand-offs and follow-ups for you."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label="Active"
                    checked={!lifecycle.data.paused}
                    disabled={pause.isPending}
                    onCheckedChange={(active) =>
                      pause.mutate({ agentId: agent.id, paused: !active })
                    }
                  />
                </ItemActions>
              </Item>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBell />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Notifications</ItemTitle>
                  <ItemDescription>
                    {NOTIFY_LABEL[lifecycle.data.notify]}. Sidebar badges always
                    show.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Select
                    disabled={notify.isPending}
                    // The label map, so the closed trigger says "Everything" rather than the raw value.
                    items={NOTIFY_LABEL}
                    onValueChange={(next) => {
                      if (next === lifecycle.data.notify) return;
                      notify.mutate({
                        agentId: agent.id,
                        notify: next as BotNotify,
                      });
                    }}
                    value={lifecycle.data.notify}
                  >
                    <SelectTrigger aria-label="Notifications">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent {...astryxScope}>
                      {(Object.keys(NOTIFY_LABEL) as BotNotify[]).map(
                        (value) => (
                          <SelectItem key={value} value={value}>
                            {NOTIFY_LABEL[value]}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </ItemActions>
              </Item>
              {permission === "default" ? (
                <>
                  <Separator />
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      <IconBell />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>Browser notifications</ItemTitle>
                      <ItemDescription>
                        Off in this browser. Turn them on to hear when a Bot
                        needs you.
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        onClick={() => void requestNotificationPermission()}
                        size="sm"
                        variant="outline"
                      >
                        Turn on
                      </Button>
                    </ItemActions>
                  </Item>
                </>
              ) : null}
              <Separator />
              <Item
                render={<Link to="/channel/new" search={{ agent: agent.id }} />}
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconMessage />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Message {agent.name}</ItemTitle>
                  <ItemDescription>Start a conversation.</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
              <BotActivityRow agentId={agent.id} />
            </PageRows>
          </>
        )}
      </PageSection>

      <BotActivityGlance agentId={agent.id} />
      <DoneTasks done={done} />
      {settings}
      {manage}
    </>
  );
}
