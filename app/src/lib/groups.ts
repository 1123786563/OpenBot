import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  type ApprovalInboxData,
  approvalsKey,
  carryingOnAfterApproval,
} from "@/lib/approvals";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import { ClientError, canKeepCachedRead, client } from "@/lib/client";
import { queryClient } from "@/query-client";

/** One line of a group conversation: a person's message (`agentId` null) or one Bot's reply. */
export type GroupMessage = {
  id: string;
  channelId: string;
  /** Who sent it, for a person's line; whose run it was, for a Bot's. */
  ownerUserId: string;
  agentId: string | null;
  /** For a Bot's line, the Bot's thread in the group that its run is on. */
  threadId?: string | null;
  text: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "paused";
  createdAt: string;
  /** Why a Bot is waiting or paused. */
  reason?: string;
  /** For an answer relayed from another Bot through `message_bot`: which Bot answered. */
  answeredBy?: string;
  /** A Team Bot asking the person whose turn it was to use their own account. */
  consent?: { botId: string; serverId: string };
};
export type GroupPerson = {
  userId: string;
  email: string;
  name: string | null;
  /** Made the group; the one who may take others out of it. */
  creator: boolean;
};
export type GroupBot = { id: string; name: string };
export type GroupBackgroundRun = {
  id: string;
  agentId: string;
  threadId: string;
  status: "running" | "completed" | "failed";
  waitingForApproval: boolean;
  reason?: string;
  partialReply: string | null;
  externalOutcome:
    | "dispatching"
    | "unknown"
    | "executed"
    | "not_dispatched"
    | null;
};

export type GroupConversation = {
  bots: GroupBot[];
  people: GroupPerson[];
  messages: GroupMessage[];
  backgroundRuns?: GroupBackgroundRun[];
};

export const groupKeys = {
  detail: (channelId: string) => ["groups", channelId] as const,
};

/** How long between reads while a Bot owes an answer, or the server is carrying one on. */
const WORKING_POLL_MS = 1_500;
/** How long between reads while a Bot's line waits on the person, who may not decide for a while. */
const WAITING_POLL_MS = 10_000;

/**
 * How long to wait before the shared transcript is read again, or `false` when nothing will change.
 *
 * It is read while a Bot owes an answer: a line queued or working, a run the server holds, or a turn
 * just sent. It is also read, slowly, while a Bot's line waits on an approval: the server writes
 * that line's reply into it once the approval is decided (`continueWaiting` in
 * server/src/channels/group.ts), and nothing marks the line as working in between. While the server
 * is carrying such a line on, the read goes back to the working pace.
 */
export function groupPollInterval(
  conversation: GroupConversation | null | undefined,
  inbox: ApprovalInboxData | null | undefined,
  now = Date.now(),
): number | false {
  const messages = conversation?.messages ?? [];
  if (
    messages.some(
      (message) => message.status === "running" || message.status === "queued",
    ) ||
    conversation?.backgroundRuns?.some(({ status }) => status === "running") ||
    awaitingFirstReply(messages.at(-1))
  )
    return WORKING_POLL_MS;
  const waiting = messages.filter(
    (message) => message.status === "waiting" && message.threadId,
  );
  if (waiting.length === 0) return false;
  return waiting.some((message) =>
    carryingOnAfterApproval(inbox, message.threadId ?? "", now),
  )
    ? WORKING_POLL_MS
    : WAITING_POLL_MS;
}

/**
 * The shared transcript. Bot turns run on the server with nobody's browser attached, so the page
 * polls while a turn is still owed an answer and stops once every Bot has spoken.
 */
export function groupQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: groupKeys.detail(channelId),
    queryFn: async ({
      client: cache,
      queryKey,
      signal,
    }): Promise<GroupConversation | null> => {
      try {
        const response = await client(
          `/api/groups/${encodeURIComponent(channelId)}`,
          { fallback: "This group conversation could not be loaded.", signal },
        );
        return (await response.json()) as GroupConversation;
      } catch (error) {
        if (error instanceof ClientError && !canKeepCachedRead(error)) {
          // A later temporary failure must not expose the conversation after access is lost.
          cache.setQueryData(queryKey, null);
        }
        throw error;
      }
    },
    retry: (failures, error) => failures < 1 && canKeepCachedRead(error),
    // Judged again on every read, from the approvals the cache holds: the pace follows whether the
    // server is carrying a waiting line on.
    refetchInterval: (query) =>
      groupPollInterval(
        query.state.data,
        queryClient.getQueryData<ApprovalInboxData | null>(approvalsKey),
      ),
  });
}

/**
 * The last line is still a person's: the server has queued it but no Bot has started yet. Bounded,
 * so a turn the server gave up on before any Bot started does not poll for ever.
 */
export function awaitingFirstReply(last: GroupMessage | undefined) {
  return (
    last !== undefined &&
    last.agentId === null &&
    Date.now() - Date.parse(last.createdAt) < 10 * 60_000
  );
}

export function sendGroupMessageMutationOptions(
  queryClient: QueryClient,
  channelId: string,
) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      text: string;
      agentId: string | null;
    }) => {
      await client(`/api/groups/${encodeURIComponent(channelId)}`, {
        method: "POST",
        body: input,
        fallback: "Your message could not be sent to the group.",
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: groupKeys.detail(channelId) }),
  });
}

/** Start a group; the Bots answer in the order given. */
export function createGroupMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      agentIds: string[];
      requestId: string;
    }): Promise<AgentChannel> => {
      const response = await client("/api/groups", {
        method: "POST",
        body: input,
        fallback: "The group could not be started.",
      });
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

/** Add a person who has signed in here to a group this person is in. */
export function addGroupMemberMutationOptions(
  queryClient: QueryClient,
  channelId: string,
) {
  return mutationOptions({
    mutationFn: async (email: string) => {
      await client(`/api/groups/${encodeURIComponent(channelId)}/members`, {
        method: "POST",
        body: { email },
        fallback: "That person could not be added.",
      });
    },
    // So the list of people shows them straight away.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: groupKeys.detail(channelId) }),
  });
}

/** Leave a group, or (its creator) take someone else out of it. */
export function removeGroupMemberMutationOptions(
  queryClient: QueryClient,
  channelId: string,
) {
  return mutationOptions({
    mutationFn: async (userId: string) => {
      await client(
        `/api/groups/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE", fallback: "That person could not be removed." },
      );
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: groupKeys.detail(channelId),
        }),
        queryClient.invalidateQueries({ queryKey: channelKeys.all }),
      ]),
  });
}
