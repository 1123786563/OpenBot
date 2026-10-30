import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { PersonalConversation } from "../../../../../shared/enterprise/mobile-schemas";
import { tenantKeys } from "./queries";

/**
 * The tenant member surface's writes, per plan F02 step 6: creating the personal channel and
 * archiving it — the two writes the conversations domain publishes (conversations/routes.ts), and
 * nothing else. Every factory takes the `QueryClient`, the user and the tenant explicitly, and
 * carries the tenant as the request header through `client({ tenantId })`, exactly like the reads.
 *
 * The refresh is scoped to the tenant the write ran under — the channels prefix, plus the one
 * channel's own key — so archiving never refetches a page that is showing another tenant, and a
 * switch during the write is handled by the reads' generation guard on the refetch itself.
 */

function invalidateChannelViews(
  queryClient: QueryClient,
  userId: string,
  tenantId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: tenantKeys.scope(userId, tenantId),
  });
}

/**
 * Create the personal channel with a bot.
 *
 * `clientRequestId` is minted here, once per press: the server linearizes creation on it
 * (conversations/store.ts locks on it and reads back a hit), so a retry of this press carries a
 * new key and a double-press is two intents rather than one accidentally reused.
 */
export function createChannelMutationOptions(
  queryClient: QueryClient,
  userId: string,
  tenantId: string,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
    }): Promise<PersonalConversation> => {
      const response = await client("/api/enterprise/v1/channels", {
        method: "POST",
        body: { botId: variables.botId, clientRequestId: crypto.randomUUID() },
        tenantId,
        fallbackKey: "enterpriseTenant.openChannel",
      });
      return (await response.json()) as PersonalConversation;
    },
    onSuccess: () => invalidateChannelViews(queryClient, userId, tenantId),
  });
}

/** Archive one channel. Idempotent server-side; archived channels accept no further messages. */
export function archiveChannelMutationOptions(
  queryClient: QueryClient,
  userId: string,
  tenantId: string,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
    }): Promise<PersonalConversation> => {
      const response = await client(
        `/api/enterprise/v1/channels/${encodeURIComponent(variables.channelId)}/archive`,
        {
          method: "POST",
          tenantId,
          fallbackKey: "enterpriseTenant.archiveChannel",
        },
      );
      return (await response.json()) as PersonalConversation;
    },
    onSuccess: () => invalidateChannelViews(queryClient, userId, tenantId),
  });
}
