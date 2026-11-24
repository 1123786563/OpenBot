import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ConversationSurface } from "@/components/channels/conversation-surface";
import { GroupChat } from "@/components/channels/group-chat";
import { GroupPeopleButton } from "@/components/channels/group-people";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";
import { groupQueryOptions } from "@/lib/groups";

/** A conversation with several Bots. The channel is an ordinary channel with more than one Bot. */
export const Route = createFileRoute("/_authed/_app/group/$channelId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  const historyEntry = useLocation({
    select: (location) => location.state.__TSR_key,
  });
  const channel = useQuery(channelQueryOptions(channelId));
  const group = useQuery(groupQueryOptions(channelId));
  const visibleChannel = group.data ? channel.data : undefined;
  useMarkOpenChannelRead(channelId);
  return (
    <ConversationSurface>
      <div
        className="sticky top-0 flex min-h-12 flex-row items-center gap-1.5 border-b border-border px-3 py-2"
        data-slot="conversation-header"
      >
        <SidebarToggle />
        <ChannelAvatar
          participantIds={visibleChannel?.agentIds ?? []}
          size={22}
        />
        <h1 className="min-w-0 truncate text-sm tracking-tight">
          {visibleChannel?.name ?? "Group conversation"}
        </h1>
        <GroupPeopleButton channelId={channelId} />
      </div>
      {(visibleChannel?.agentIds ?? []).map((agentId) => (
        <BotPausedBanner agentId={agentId} key={agentId} />
      ))}
      {/* Remounted per channel so one group's transcript never flashes in another. */}
      <GroupChat
        channelId={channelId}
        historyEntry={historyEntry}
        key={channelId}
      />
    </ConversationSurface>
  );
}
