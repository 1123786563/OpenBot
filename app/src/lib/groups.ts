import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import { client, tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/** The selection pair a scoped call rides, spread into the client options (MT087). */
type ScopePair = { tenantId?: string; workspaceId?: string };

/**
 * The scope the writes here submit under (MT087 / Issue #130, AC2): an open scope's selection
 * rides the request, and a pending one submits nothing.
 */
function scopePair(scope: ScopedCache | undefined): ScopePair | undefined {
  return scope !== undefined && scope.status === "open"
    ? (scope.selection ?? {})
    : undefined;
}

/** One line of a group conversation: a person's message (`agentId` null) or one Bot's reply. */
export type GroupMessage = {
  id: string;
  channelId: string;
  /** Who sent it, for a person's line; whose run it was, for a Bot's. */
  ownerUserId: string;
  agentId: string | null;
  text: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  createdAt: string;
  /** Why a waiting Bot is waiting, when it is. */
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
export type GroupConversation = {
  bots: GroupBot[];
  people: GroupPerson[];
  messages: GroupMessage[];
};

export const groupKeys = {
  detail: (channelId: string) => ["groups", channelId] as const,
};

/**
 * The shared transcript. Bot turns run on the server with nobody's browser attached, so the page
 * polls while a turn is still owed an answer and stops once every Bot has spoken.
 */
export function groupQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: groupKeys.detail(channelId),
    queryFn: async (): Promise<GroupConversation> => {
      const response = await client(
        `/api/groups/${encodeURIComponent(channelId)}`,
        { fallbackKey: "groups.load" },
      );
      return (await response.json()) as GroupConversation;
    },
    refetchInterval: (query) =>
      query.state.data?.messages.some(
        (message) =>
          message.status === "running" || message.status === "queued",
      ) || awaitingFirstReply(query.state.data)
        ? 1_500
        : false,
  });
}

/**
 * The refusal a scoped group read raises when the server answers that this group is not this
 * person's to see under the scope they hold — one typed state, the same words for a group that
 * never existed (MT087 AC3).
 */
export class GroupUnavailableError extends Error {
  constructor() {
    super("That group is not available under the scope you hold.");
    this.name = "GroupUnavailableError";
  }
}

/**
 * The shared transcript, bound to the scope the screen holds (MT087 / Issue #130, AC1): keyed under
 * the scope's own cache prefix (MT083), carrying the selection pair, answered through the
 * generation guard, and polling exactly as the unscoped read does — the scope changes where the
 * entry lives and what the request carries, not how a running turn is followed.
 */
export function scopedGroupQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  channelId: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...groupKeys.detail(channelId)]
        : [...groupKeys.detail(channelId), ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<GroupConversation>(() => {})
        : async ({ signal }): Promise<GroupConversation> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient(
                `/api/groups/${encodeURIComponent(channelId)}`,
                {
                  signal,
                  fallbackKey: "groups.load",
                  ...(open.selection ?? {}),
                },
              );
              if (!response.ok) {
                if (response.status === 404) throw new GroupUnavailableError();
                throw new Error("That group could not be read.");
              }
              return (await response.json()) as GroupConversation;
            }),
    refetchInterval: (query) =>
      query.state.data?.messages.some(
        (message) =>
          message.status === "running" || message.status === "queued",
      ) || awaitingFirstReply(query.state.data)
        ? 1_500
        : false,
  });
}

/**
 * The last line is still a person's: the server has queued it but no Bot has started yet. Bounded,
 * so a turn the server gave up on before any Bot started does not poll for ever.
 */
function awaitingFirstReply(data: GroupConversation | undefined) {
  const last = data?.messages.at(-1);
  return (
    last !== undefined &&
    last.agentId === null &&
    Date.now() - Date.parse(last.createdAt) < 10 * 60_000
  );
}

export function sendGroupMessageMutationOptions(
  queryClient: QueryClient,
  channelId: string,
  scope?: ScopedCache,
) {
  const settle = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: groupKeys.detail(channelId),
      }),
      ...(scope !== undefined && scope.status === "open"
        ? [
            queryClient.invalidateQueries({
              queryKey: [...scope.prefix, ...groupKeys.detail(channelId)],
            }),
          ]
        : []),
    ]);
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      text: string;
      agentId: string | null;
    }) => {
      await client(`/api/groups/${encodeURIComponent(channelId)}`, {
        method: "POST",
        body: input,
        fallbackKey: "groups.send",
        ...(scopePair(scope) ?? {}),
      });
    },
    onSettled: settle,
  });
}

/** Start a group; the Bots answer in the order given. Carries the scope in force (MT087). */
export function createGroupMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (agentIds: string[]): Promise<AgentChannel> => {
      const response = await client("/api/groups", {
        method: "POST",
        body: { agentIds },
        fallbackKey: "groups.start",
        ...(scopePair(scope) ?? {}),
      });
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: channelKeys.all }),
        ...(scope !== undefined && scope.status === "open"
          ? [
              queryClient.invalidateQueries({
                queryKey: [...scope.prefix, ...channelKeys.all],
              }),
            ]
          : []),
      ]),
  });
}

/** Add a person who has signed in here to a group this person is in. Carries the scope (MT087). */
export function addGroupMemberMutationOptions(
  queryClient: QueryClient,
  channelId: string,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (email: string) => {
      await client(`/api/groups/${encodeURIComponent(channelId)}/members`, {
        method: "POST",
        body: { email },
        fallbackKey: "groups.addPerson",
        ...(scopePair(scope) ?? {}),
      });
    },
    // So the list of people shows them straight away.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: groupKeys.detail(channelId),
        }),
        ...(scope !== undefined && scope.status === "open"
          ? [
              queryClient.invalidateQueries({
                queryKey: [...scope.prefix, ...groupKeys.detail(channelId)],
              }),
            ]
          : []),
      ]),
  });
}

/** Leave a group, or (its creator) take someone else out of it. Carries the scope (MT087). */
export function removeGroupMemberMutationOptions(
  queryClient: QueryClient,
  channelId: string,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (userId: string) => {
      await client(
        `/api/groups/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`,
        {
          method: "DELETE",
          fallbackKey: "groups.removePerson",
          ...(scopePair(scope) ?? {}),
        },
      );
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: groupKeys.detail(channelId),
        }),
        queryClient.invalidateQueries({ queryKey: channelKeys.all }),
        ...(scope !== undefined && scope.status === "open"
          ? [
              queryClient.invalidateQueries({
                queryKey: [...scope.prefix, ...groupKeys.detail(channelId)],
              }),
              queryClient.invalidateQueries({
                queryKey: [...scope.prefix, ...channelKeys.all],
              }),
            ]
          : []),
      ]),
  });
}
