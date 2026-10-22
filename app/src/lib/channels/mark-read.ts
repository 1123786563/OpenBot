import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { markChannelReadMutationOptions } from "./mutations";
import { scopedChannelListQueryOptions } from "./queries";

/**
 * Opening a conversation marks it read; a Bot replying while it is open marks it read again. Used by
 * every screen that shows one conversation, one Bot or several.
 *
 * Read off the roster the sidebar renders, since the socket keeps its lastMessageAt live: it is the
 * one honest source for "has something new been said". Keyed on primitives, deliberately: the
 * optimistic patch changes the row OBJECT without changing these values, so an object dependency
 * would re-fire on its own write — and with lastMessageAt ahead of this browser's clock, loop.
 */
export function useMarkOpenChannelRead(channelId: string) {
  const queryClient = useQueryClient();
  // The read-marker rides the scope the screen holds (MT087): the roster it reads and the write
  // it fires both carry the selection pair, and the optimistic patch lands in this scope's entry.
  const scope = useScopedCache();
  const markRead = useMutation(
    markChannelReadMutationOptions(queryClient, scope),
  );
  const roster = useInfiniteQuery(
    scopedChannelListQueryOptions(queryClient, scope),
  );
  const summary = roster.data?.find((row) => row.id === channelId);
  const unseen = summary !== undefined && hasUnseenActivity(summary);
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (unseen) markReadMutate(channelId);
  }, [channelId, unseen, markReadMutate]);
}
