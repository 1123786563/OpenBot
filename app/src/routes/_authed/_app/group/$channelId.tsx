import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { learningEvidencePermission } from "@openbot/shared/direct-chat-learning";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { z } from "zod";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ConversationSurface } from "@/components/channels/conversation-surface";
import { GroupChat } from "@/components/channels/group-chat";
import { GroupPeopleButton } from "@/components/channels/group-people";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { useTranslation } from "@/i18n";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";
import { canKeepCachedRead, client, tryClient } from "@/lib/client";
import { groupQueryOptions } from "@/lib/groups";

/** A conversation with several Bots. The channel is an ordinary channel with more than one Bot. */
export const Route = createFileRoute("/_authed/_app/group/$channelId")({
  component: RouteComponent,
  validateSearch: z.object({ runId: z.string().optional() }),
});

function RouteComponent() {
  const { t } = useTranslation();
  const { channelId } = Route.useParams();
  const { runId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const historyEntry = useLocation({
    select: (location) => location.state.__TSR_key,
  });
  const channel = useQuery(channelQueryOptions(channelId));
  const group = useQuery(groupQueryOptions(channelId));
  const canReadGroup = Boolean(group.data) && canKeepCachedRead(group.error);
  const visibleChannel =
    canReadGroup && canKeepCachedRead(channel.error) ? channel.data : undefined;
  useMarkOpenChannelRead(channelId);
  return (
    <ConversationSurface>
      <Stack
        align="center"
        as="header"
        direction="horizontal"
        gap={2}
        data-slot="conversation-header"
        style={{
          paddingBlock: "var(--spacing-2)",
          paddingInline: "var(--spacing-3)",
        }}
        wrap="wrap"
      >
        <SidebarToggle />
        <ChannelAvatar
          participantIds={visibleChannel?.agentIds ?? []}
          size={22}
        />
        <Heading level={1} size="sm" wordBreak="break-word">
          {visibleChannel?.name ?? t("conversation.group.title")}
        </Heading>
        {canReadGroup && (
          <>
            <GroupLearningPermission channelId={channelId} />
            <GroupPeopleButton
              channelId={channelId}
              onLeave={() => void navigate({ to: "/" })}
            />
          </>
        )}
      </Stack>
      <Divider />
      {(visibleChannel?.agentIds ?? []).map((agentId) => (
        <BotPausedBanner agentId={agentId} key={agentId} />
      ))}
      {/* Remounted per channel so one group's transcript never flashes in another. */}
      <GroupChat
        channelId={channelId}
        historyEntry={historyEntry}
        runId={runId}
        key={channelId}
      />
    </ConversationSurface>
  );
}

function GroupLearningPermission({ channelId }: { channelId: string }) {
  const path = `/api/copilotkit/conversations/${encodeURIComponent(channelId)}/learning-evidence`;
  const queryKey = ["group-learning-permission", channelId];
  const queryClient = useQueryClient();
  const permission = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const response = await tryClient(path, { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Couldn't load Learning permission.");
      return learningEvidencePermission.parse(await response.json());
    },
  });
  const save = useMutation({
    mutationFn: async (allowed: boolean) => {
      await client(path, {
        method: "PUT",
        body: { allowed },
        fallback: "Couldn't save Learning permission.",
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  if (!permission.data) return null;
  return (
    <VStack className="text-xs">
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={permission.data.allowed}
          disabled={save.isPending}
          onChange={(event) => save.mutate(event.currentTarget.checked)}
        />
        Allow Learning from this conversation
      </label>
      {save.error && (
        <Text as="p" role="alert" style={{ color: "var(--color-text-error)" }}>
          {save.error.message}
        </Text>
      )}
    </VStack>
  );
}
