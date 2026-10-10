/**
 * The conversations service, per the conversations-subsystem spec §3.5: the domain answers the
 * routes make — the authorized-bot list and the personal channel's create/list/detail/archive —
 * over the store's single-writer transactions.
 *
 * Request shapes are the frozen shared schemas (CreateChannelSchema): a body that is not exactly
 * the request contract — including any thread/channel/principal/scope/token field the client has
 * no business sending — is one stable 400, before the store is ever reached. Identity never
 * crosses this boundary from the client: every method takes the Scope the middleware issued, and
 * the store derives tenant/principal/owner from it alone.
 */

import {
  CreateChannelSchema,
  type PersonalConversation,
} from "../../../../shared/enterprise/mobile-schemas";
import type { Database } from "../../db/client";
import type { Scope } from "../contracts";
import { EnterpriseError } from "../errors";
import {
  type BotPage,
  type ChannelPage,
  createConversationsStore,
} from "./store";

/** One fixed page size; the cursor negotiation itself is the frozen envelope, nothing more. */
export const PAGE_LIMIT = 50;

export type ConversationsService = {
  listBots(scope: Scope, cursor: string | null): Promise<BotPage>;
  createChannel(scope: Scope, body: unknown): Promise<PersonalConversation>;
  listChannels(scope: Scope, cursor: string | null): Promise<ChannelPage>;
  getChannel(scope: Scope, channelId: string): Promise<PersonalConversation>;
  archiveChannel(
    scope: Scope,
    channelId: string,
  ): Promise<PersonalConversation>;
};

export function createConversationsService(
  database: Database,
): ConversationsService {
  const store = createConversationsStore(database);
  return {
    listBots: (scope, cursor) =>
      store.listAuthorizedBots(scope, cursor, PAGE_LIMIT),

    createChannel: async (scope, body) => {
      const parsed = CreateChannelSchema.safeParse(body);
      if (!parsed.success) {
        /* The spec §3.3 leaves the shape-refusal code open; the status and envelope are the
         * contract, and this one stable code covers every strict-schema refusal. */
        throw new EnterpriseError("REQUEST_BODY_INVALID", 400);
      }
      return store.createChannel(scope, parsed.data);
    },

    listChannels: (scope, cursor) =>
      store.listOwnerChannels(scope, cursor, PAGE_LIMIT),

    getChannel: async (scope, channelId) => {
      const conversation = await store.getOwnerChannel(scope, channelId);
      if (conversation === null) {
        /* Missing row, another member's channel, another tenant's channel: one code, no
         * distinction, nothing of the channel's in the answer (spec §6.1). */
        throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
      }
      return conversation;
    },

    archiveChannel: async (scope, channelId) => {
      const conversation = await store.archiveOwnerChannel(scope, channelId);
      if (conversation === null) {
        /* Archiving someone else's channel changes nothing and says nothing: the same 404. */
        throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
      }
      return conversation;
    },
  };
}
