import { IconCode, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChannelChat } from "@/components/channels/channel-chat";
import { WorkshopPanel } from "@/components/channels/workshop-panel";
import { ComputerChatControls } from "@/components/computer/computer-controls";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { onComputerActivity } from "@/lib/copilot/computer-activity";

const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the shared detail pane. */
  watch: z.boolean().optional(),
  /** Opens the Bot's workshop (files, artifacts, the live turn) in the same pane. */
  workshop: z.boolean().optional(),
});

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const HEADING_ENTRANCE_SECONDS = 0.18;
const HEADING_ENTRANCE_OFFSET = "translateY(4px)";

/** Shared detail pane width for the live screen view. */
const _SCREEN_PANEL_WIDTH = 400;

/** The workshop pane is wider: it carries the turn's stream beside the file tree. */
const WORKSHOP_PANEL_WIDTH = 480;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation("channels");
  const { channelId } = Route.useParams();
  const { settings, watch, workshop } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const navigate = Route.useNavigate();
  const isSettingsOpen = settings === true;
  const isWorkshopOpen = workshop === true;
  const prefersReducedMotion = useReducedMotion();
  const isWatching = watch === true;
  /** Channel routing currently supports one coworker. */
  const agentId = channel.data?.agentIds[0];

  useMarkOpenChannelRead(channelId);

  // Browser activity may auto-open the screen once per run unless this run was dismissed.
  const dismissedEpoch = useRef<number | null>(null);
  const runEpoch = useRef<number | null>(null);
  useEffect(() => {
    if (!agentId) return;
    return onComputerActivity((activity) => {
      if (activity.botId !== agentId) return;
      runEpoch.current = activity.epoch;
      if (dismissedEpoch.current === activity.epoch) return;
      navigate({
        search: (previous) =>
          previous.watch === true || previous.settings === true
            ? previous
            : { ...previous, settings: undefined, watch: true },
      });
    });
  }, [agentId, navigate]);

  // Settings, watch, and the workshop share one pane; opening one clears the others' flags.
  const show = (next: "settings" | "watch" | "workshop" | null) => {
    // Dismissal applies only to the current browser-activity run.
    if (next !== "watch" && isWatching)
      dismissedEpoch.current = runEpoch.current;
    return navigate({
      search: (previous) => ({
        ...previous,
        settings: next === "settings" ? true : undefined,
        watch: next === "watch" ? true : undefined,
        workshop: next === "workshop" ? true : undefined,
      }),
    });
  };

  return (
    <DetailPanel
      onClose={() => show(null)}
      open={
        (isSettingsOpen || isWatching || isWorkshopOpen) &&
        agentId !== undefined
      }
      detailWidth={
        isWatching || isWorkshopOpen ? WORKSHOP_PANEL_WIDTH : undefined
      }
      title={
        isWatching
          ? t("channelDetail.computer")
          : isWorkshopOpen
            ? t("channelDetail.workshop")
            : undefined
      }
      detail={
        agentId === undefined ? null : isWatching ? (
          // Manual watch remains active even when there is no current browser action.
          <ComputerViewPanel agentId={agentId} name={channel?.data?.name} />
        ) : isWorkshopOpen ? (
          <WorkshopPanel channelId={channelId} botId={agentId} />
        ) : (
          <AgentProfile agentId={agentId} />
        )
      }
    >
      <div className="flex flex-col">
        <div className="min-h-12 border-b border-border sticky top-0 flex flex-row flex-wrap items-center justify-between px-3 py-2 gap-2">
          {/* Keyed on the displayed name so cold channel loads animate the resolved name, not the id. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <SidebarToggle />
            <motion.div
              animate={{ opacity: 1 }}
              className="shrink-0"
              initial={{ opacity: 0 }}
              key={`avatar:${channel.data?.name ?? channelId}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              <ChannelAvatar
                participantIds={channel.data?.agentIds ?? []}
                size={22}
              />
            </motion.div>
            <motion.span
              animate={
                prefersReducedMotion
                  ? { opacity: 1 }
                  : { opacity: 1, transform: "translateY(0px)" }
              }
              className="min-w-0 text-sm tracking-tight truncate"
              initial={
                prefersReducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, transform: HEADING_ENTRANCE_OFFSET }
              }
              key={`name:${channel.data?.name ?? channelId}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              {channel.data?.name ?? t("channelDetail.channelFallback")}
            </motion.span>
          </div>
          <div className="flex flex-row gap-1.5">
            <ComputerChatControls
              computerId={agentId}
              open={isWatching}
              onOpenChange={(open) => show(open ? "watch" : null)}
            />
            <Button
              aria-label={t("channelDetail.workshop")}
              aria-pressed={isWorkshopOpen}
              className={isWorkshopOpen ? "bg-foreground/5" : undefined}
              disabled={agentId === undefined}
              onClick={() => show(isWorkshopOpen ? null : "workshop")}
              variant="ghost"
              size="icon"
            >
              <IconCode className="size-4.5" />
            </Button>
            <Button
              aria-label={t("channelDetail.coworkerAria")}
              aria-pressed={isSettingsOpen}
              className={isSettingsOpen ? "bg-foreground/5" : undefined}
              disabled={agentId === undefined}
              onClick={() => show(isSettingsOpen ? null : "settings")}
              variant="ghost"
              size="icon"
            >
              <IconSettings className="size-4.5" />
            </Button>
          </div>
        </div>
      </div>
      {agentId && channel.data?.agentIds.length === 1 ? (
        <BotPausedBanner agentId={agentId} />
      ) : null}
      <ChannelBody
        channel={channel.data}
        isPending={channel.isPending}
        hasError={Boolean(channel.error)}
      />
    </DetailPanel>
  );
}

/**
 * A channel with exactly one coworker is its CopilotKit chat. One with several is a group, which
 * redirects to its shared transcript at `/group/$channelId`.
 */
function ChannelBody({
  channel,
  isPending,
  hasError,
}: {
  channel: AgentChannel | undefined;
  isPending: boolean;
  hasError: boolean;
}) {
  const { t } = useTranslation("channels");
  // Nothing while the channel loads: a placeholder inside a local round-trip is a flicker.
  if (isPending) return null;
  if (hasError || !channel) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {t("channelDetail.loadError")}
      </p>
    );
  }

  const runtimeAgentId =
    channel.agentIds.length === 1 ? channel.agentIds[0] : undefined;
  // Two or more Bots is a group conversation, with its own shared transcript. Every link to a
  // channel lands here, so this is the one redirect they all need.
  if (!runtimeAgentId) {
    return (
      <Navigate
        params={{ channelId: channel.id }}
        replace
        to="/group/$channelId"
      />
    );
  }

  // Remount on channel changes so CopilotKit agent/thread state cannot leak between channels.
  return (
    <ChannelChat
      channel={channel}
      key={channel.id}
      runtimeAgentId={runtimeAgentId}
    />
  );
}
