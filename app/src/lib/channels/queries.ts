import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/**
 * A channel as the browser sees it.
 *
 * `threadId` is what makes two channels with the same coworker independent conversations, and
 * `active` is false once a linked coworker has been deleted: the transcript stays readable, but
 * nothing more can be said in it.
 */
export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
  /**
   * ISO-8601 when something was last said here, or null for a conversation nobody has used.
   *
   * The conversation screen needs this to tell two silences apart: a new conversation with no
   * history, and one whose history this deployment cannot reach. See `channel-chat.tsx`.
   */
  lastMessageAt: string | null;
};

/** A channel plus what the roster renders about it. */
export type ChannelSummary = AgentChannel & {
  /** A few words about the conversation, or null. The roster falls back to `name`. */
  summary: string | null;
  lastMessage: string | null;
  lastMessageAgentId: string | null;
  /** ISO-8601. Ordering falls back to this, so a channel just created sorts to the top. */
  createdAt: string;
  /** Whether this member pinned the channel. Pinned channels sort first in the roster. */
  pinned: boolean;
  /** ISO-8601 when this member last had the channel open, or null for never. The caller's, only. */
  lastReadAt: string | null;
  /**
   * Whether a turn is running in this channel right now.
   *
   * Socket-only and transient: the server never persists it and the roster query never returns it,
   * so it is undefined until a busy event arrives and is dropped whenever the roster is refetched.
   * A headless turn — a handoff hop, a relay — sets it, which is how the roster shows work the
   * browser never streamed.
   */
  busy?: boolean;
};

export const channelKeys = {
  all: ["channels"] as const,
  list: () => ["channels", "list"] as const,
  detail: (channelId: string) => ["channels", "detail", channelId] as const,
};

/** One page of channels, and where the next one starts. */
export type ChannelPage = {
  channels: ChannelSummary[];
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// The scoped half (MT087 / Issue #130): the conversation pages read and write through here
// ---------------------------------------------------------------------------

/**
 * The refusal a scoped channel read raises when the server answers that this conversation is not
 * this person's to see under the scope they hold.
 *
 * A 404 is the server's canonical no-leak answer — the same status whether the conversation never
 * existed or belongs to a scope this person has left — so the client maps it to this one typed
 * refusal and the route answers it with ONE unavailable state, never a sentence that would tell
 * the reader which of the two it was (MT087 AC3).
 */
export class ChannelUnavailableError extends Error {
  constructor() {
    super("That conversation is not available under the scope you hold.");
    this.name = "ChannelUnavailableError";
  }
}

/** The sentence a malformed-but-ok answer falls back to, a failed read rather than a missing one. */
const DETAIL_FALLBACK = "That conversation could not be read.";

/**
 * The roster's channels, bound to the scope the screen holds (MT087 / Issue #130, AC1).
 *
 * Paged exactly as the unscoped read: the scope changes WHERE an entry lives (under the scope's
 * own cache prefix, MT083) and WHAT the request carries (the selection pair), not how the roster
 * pages. A switch drops the old scope's pages wholesale and the new scope's first page answers —
 * list, counts and cursors all reflect the scope in force, never a mix.
 */
export function scopedChannelListQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return infiniteQueryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...channelKeys.list()]
        : [...channelKeys.list(), ":scope-pending"],
    enabled: open !== null,
    initialPageParam: "",
    queryFn:
      open === null
        ? () => new Promise<ChannelPage>(() => {})
        : async ({ pageParam, signal }): Promise<ChannelPage> => {
            const suffix = pageParam
              ? `?cursor=${encodeURIComponent(pageParam as string)}`
              : "";
            return guarded(queryClient, open.userId, async () => {
              const response = await tryClient(`/api/channels${suffix}`, {
                signal,
                fallbackKey: "channels.load",
                ...(open.selection ?? {}),
              });
              if (!response.ok) {
                throw new Error("Channels could not be read.");
              }
              return (await response.json()) as ChannelPage;
            });
          },
    getNextPageParam: (page: ChannelPage) => page.nextCursor ?? undefined,
    select: (data): ChannelSummary[] =>
      data.pages.flatMap((page) => page.channels),
  });
}

/**
 * The conversation detail, bound to the scope the screen holds (MT087 / Issue #130, AC1): keyed
 * under the scope's own prefix, carrying the pair, guarded by the generation, and answering a 404
 * with the one typed unavailable state.
 */
export function scopedChannelDetailQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  channelId: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...channelKeys.detail(channelId)]
        : [...channelKeys.detail(channelId), ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<AgentChannel>(() => {})
        : async ({ signal }): Promise<AgentChannel> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient(
                `/api/channels/${encodeURIComponent(channelId)}`,
                {
                  signal,
                  fallbackKey: "channels.loadOne",
                  ...(open.selection ?? {}),
                },
              );
              if (!response.ok) {
                if (response.status === 404)
                  throw new ChannelUnavailableError();
                throw new Error(DETAIL_FALLBACK);
              }
              const body = (await response.json().catch(() => null)) as {
                channel?: AgentChannel;
              } | null;
              if (
                body === null ||
                typeof body !== "object" ||
                body.channel === null ||
                typeof body.channel !== "object"
              ) {
                throw new Error(DETAIL_FALLBACK);
              }
              return body.channel;
            }),
  });
}
