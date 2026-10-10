/**
 * The C07 history service, per plan §5 (`HistoryService.list(scope, channelId,
 * cursor)`): the authorized, cursor-paginated projection of a personal
 * channel's messages, each item carrying its explicit message/run attribution
 * in a stable order.
 *
 * Authorization is the message domain's same closed pattern, decided INSIDE the
 * transaction from live facts: the channel must be the scope owner's (anything
 * else is the indistinguishable 404) and the bot's read grant must still hold —
 * revocation closes history on the next request. The cursor is the last item id
 * of the previous page (`id < $cursor` over one fixed descending order), the
 * same negotiation the channels list uses; the envelope is the frozen
 * StringCursorPage shape. One fixed page size (PAGE_LIMIT), shared with the
 * conversations domain.
 *
 * The pool is the message domain's own single-writer pool: the rows live in
 * `enterprise_channel_messages` (0063) under the run-writer role's RLS.
 *
 * Statement texts are module constants; values travel only as `$n` parameters.
 */
import { z } from "zod";
import type { Database } from "../../db/client";
import type { Authz, ResourceSnapshot, Scope } from "../contracts";
import { EnterpriseError } from "../errors";
import { withTenant } from "../tenancy/transaction";

const SELECT_HISTORY_CHANNEL = `
  select c.id as "channelId",
         r.id as "botId",
         r.workspace_id as "workspaceId",
         r.status as "botStatus",
         r.revision as revision,
         r.acl_epoch as "aclEpoch",
         t.policy_revision as "policyRevision",
         exists(select 1 from enterprise_resource_grants g
                where g.tenant_id = c.tenant_id and g.resource_id = r.id
                  and g.principal_id = $3 and g.action = 'read') as "readAllowed"
  from enterprise_channels c
  join enterprise_resources r on r.tenant_id = c.tenant_id and r.id = c.bot_resource_id
  join enterprise_tenants t on t.id = c.tenant_id
  where c.tenant_id = $1 and c.id = $2 and c.owner_principal_id = $3`;

const HistoryChannelSchema = z
  .object({
    channelId: z.string(),
    botId: z.string(),
    workspaceId: z.string(),
    botStatus: z.string(),
    revision: z.number().int().positive(),
    aclEpoch: z.number().int().positive(),
    policyRevision: z.string(),
    readAllowed: z.boolean(),
  })
  .strict();

const SELECT_HISTORY_PAGE = `
  select id as "messageId",
         run_id as "runId",
         client_message_id as "clientMessageId",
         created_at as "createdAt"
  from enterprise_channel_messages
  where tenant_id = $1 and channel_id = $2 and owner_principal_id = $3
    and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::text))
  order by created_at desc, id desc
  limit $6`;

/*
 * The order is the submission order (newest first): the message id is a random
 * UUID that carries NO time information, so the sort key is created_at with the
 * id as the deterministic tiebreak — a repeated walk is byte-stable and a page
 * boundary never splits two equal-keyed rows differently.
 */
const HistoryItemSchema = z
  .object({
    messageId: z.string(),
    runId: z.string(),
    clientMessageId: z.string(),
  })
  .strict();

const HistoryPageRowSchema = HistoryItemSchema.extend({
  createdAt: z.date(),
}).strict();

type HistoryPageRow = z.infer<typeof HistoryPageRowSchema>;

export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export type HistoryPage = {
  items: HistoryItem[];
  nextCursor: string | null;
};

/** Cursor binding: (created_at, id) of the last item on the previous page. */
const CURSOR_SEPARATOR = "|";

function encodeHistoryCursor(row: HistoryPageRow): string {
  return `${row.createdAt.toISOString()}${CURSOR_SEPARATOR}${row.messageId}`;
}

function parseHistoryCursor(cursor: string): {
  createdAt: string;
  messageId: string;
} {
  const separator = cursor.lastIndexOf(CURSOR_SEPARATOR);
  if (separator <= 0) {
    throw new EnterpriseError("REQUEST_BODY_INVALID", 400);
  }
  const createdAt = cursor.slice(0, separator);
  const messageId = cursor.slice(separator + CURSOR_SEPARATOR.length);
  if (!messageId || Number.isNaN(Date.parse(createdAt))) {
    throw new EnterpriseError("REQUEST_BODY_INVALID", 400);
  }
  return { createdAt, messageId };
}

export type HistoryService = {
  /** One authorized page; `nextCursor` is null when the walk is complete. */
  list(
    scope: Scope,
    channelId: string,
    cursor: string | null,
  ): Promise<HistoryPage>;
};

export function createHistoryService(
  database: Database,
  authz: Authz,
  limit: number,
): HistoryService {
  return {
    list: (scope, channelId, cursor) =>
      withTenant(database, scope, async (tx) => {
        const rows = await tx.unsafe<Record<string, unknown>[]>(
          SELECT_HISTORY_CHANNEL,
          [scope.tenantId, channelId, scope.principalId],
        );
        const parsed = HistoryChannelSchema.safeParse(rows[0]);
        if (!parsed.success) {
          // Missing row, another member's channel, another tenant's channel:
          // the same closed 404 (spec §6.1) — never a filtered list.
          throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
        }
        const facts = parsed.data;
        const snapshot = (locallyAllowed: boolean): ResourceSnapshot => ({
          id: facts.botId,
          tenantId: scope.tenantId,
          workspaceId: facts.workspaceId,
          kind: "bot",
          revision: facts.revision,
          aclEpoch: facts.aclEpoch,
          policyRevision: facts.policyRevision,
          active: facts.botStatus === "active",
          locallyAllowed,
        });
        if (
          !(await authz.check({
            scope,
            resource: snapshot(facts.readAllowed),
            action: "read",
          }))
        ) {
          // Revoked read closes history with the same indistinguishable 404.
          throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
        }

        const cursorBinding =
          cursor === null ? null : parseHistoryCursor(cursor);
        const page = z
          .array(HistoryPageRowSchema)
          .parse(
            await tx.unsafe<Record<string, unknown>[]>(SELECT_HISTORY_PAGE, [
              scope.tenantId,
              channelId,
              scope.principalId,
              cursorBinding?.createdAt ?? null,
              cursorBinding?.messageId ?? null,
              limit + 1,
            ]),
          );
        const hasMore = page.length > limit;
        const items: HistoryItem[] = hasMore ? page.slice(0, limit) : page;
        return {
          items,
          nextCursor:
            hasMore && items.length > 0
              ? encodeHistoryCursor(page[items.length - 1])
              : null,
        };
      }),
  };
}
