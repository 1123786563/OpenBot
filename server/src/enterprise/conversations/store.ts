/**
 * The conversations store — the single writer of `enterprise_channels`, per the
 * conversations-subsystem spec §4.2/§5. Every read and write runs inside one `withTenant`
 * transaction (epoch/role re-check included) on the data-plane pool; no bare pool query exists in
 * this domain.
 *
 * Authorization is decided by the Authz engine on same-transaction grant reads (spec §2/§6.2): a
 * bot is visible with an explicit 'read' grant and runnable with an explicit 'run' grant — a
 * tenant_admin or a deployment admin never skips the grant, and the two grants never imply each
 * other. The bot list keeps the §6.3 single-statement batch join; the creation path reads the
 * bot's live facts (grant matches per action, revision, ACL epoch, tenant policy revision) in one
 * statement and hands them to `authz.check`, so the run decision is governed by the tenant's
 * policy revision exactly like every other enterprise decision. Revocation therefore lands on the
 * next transaction: no positive decision is ever cached (the scope middleware rebuilds the scope
 * per request, `withTenant` re-checks the epoch, and the grant rows are read live in the same
 * statement).
 *
 * The pool this module opens is the conversations' own data-plane connection: the deployment
 * config names it with ENTERPRISE_DATA_DATABASE_URL (validated by the enterprise config before
 * boot); the isolated enterprise test environment never carries deployment names, so there the
 * sibling TEST variable — the same one bootstrap.test.ts already requires — names the restricted
 * data login. The URL is read once per mount; the pool itself connects lazily.
 *
 * Statement texts are module constants; values travel only as `$n` parameters. Rows are parsed
 * with strict Zod schemas inside the transaction — never `as`-cast; a shape that does not match is
 * a closed AUTHORIZATION_STATE_INVALID, not a best-effort answer.
 */
import { z } from "zod";
import type { PersonalConversation } from "../../../../shared/enterprise/mobile-schemas";
import type { Database } from "../../db/client";
import type { Authz, ResourceSnapshot, Scope } from "../contracts";
import { EnterpriseError } from "../errors";
import {
  lockExclusive,
  lockKey,
  lockShared,
  withTenant,
} from "../tenancy/transaction";

/** The data-plane URL for the conversations pool, per the module header. */
export function conversationsDatabaseUrl(
  env: Record<string, string | undefined>,
): string {
  const url =
    env.ENTERPRISE_DATA_DATABASE_URL?.trim() ||
    env.ENTERPRISE_TEST_DATA_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "the conversations store needs ENTERPRISE_DATA_DATABASE_URL (deployment) or ENTERPRISE_TEST_DATA_DATABASE_URL (isolated test environment)",
    );
  }
  return url;
}

/*
 * A read-granted active bot, for the list: the grant existence is part of the same statement, so
 * the answer is one authorized page and never a list that a second pass then filters.
 */
const SELECT_BOTS = `
  select r.id as id,
         r.workspace_id as "workspaceId",
         r.kind as kind
  from enterprise_resources r
  where r.tenant_id = $1 and r.kind = 'bot' and r.status = 'active'
    and exists(select 1 from enterprise_resource_grants g
               where g.tenant_id = r.tenant_id and g.resource_id = r.id
                 and g.principal_id = $2 and g.action = 'read')
    and ($3::text is null or r.id > $3)
  order by r.id
  limit $4`;

const BotRowSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    kind: z.string(),
  })
  .strict();

export type AuthorizedBot = z.infer<typeof BotRowSchema>;

/*
 * The bot facts creation needs: the row itself (same tenant, kind bot) plus the per-action grant
 * facts and the engine's snapshot fields — revision, ACL epoch and the tenant's policy revision —
 * in the same statement, on the readAuthorizedResource pattern (authz/repository.ts:31-45). No
 * read grant is the same closed 404 as a missing or deleted resource; a read grant without a run
 * grant is a visible bot that refuses creation (spec §6.2).
 */
const SELECT_CHANNEL_BOT = `
  select r.id as id,
         r.workspace_id as "workspaceId",
         r.status as status,
         r.revision as revision,
         r.acl_epoch as "aclEpoch",
         t.policy_revision as "policyRevision",
         exists(select 1 from enterprise_resource_grants g
                where g.tenant_id = r.tenant_id and g.resource_id = r.id
                  and g.principal_id = $3 and g.action = 'read') as "readAllowed",
         exists(select 1 from enterprise_resource_grants g
                where g.tenant_id = r.tenant_id and g.resource_id = r.id
                  and g.principal_id = $3 and g.action = 'run') as "runAllowed"
  from enterprise_resources r
  join enterprise_tenants t on t.id = r.tenant_id
  where r.tenant_id = $1 and r.id = $2 and r.kind = 'bot'`;

const BotFactsSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    status: z.enum(["active", "deleted"]),
    revision: z.number().int().positive(),
    aclEpoch: z.number().int().positive(),
    policyRevision: z.string(),
    readAllowed: z.boolean(),
    runAllowed: z.boolean(),
  })
  .strict();

/*
 * Channel rows as the owner-scoped statements return them. Every channel statement filters on
 * tenant AND owner — a non-owner's channel is the same missing row as no channel (spec §6.1's
 * indistinguishable 404), and the RLS policy independently pins the tenant.
 */
const SELECT_EXISTING_CHANNEL = `
  select id, bot_resource_id as "botId", thread_id as "threadId", status
  from enterprise_channels
  where tenant_id = $1 and owner_principal_id = $2 and client_request_id = $3`;

const INSERT_CHANNEL = `
  insert into enterprise_channels
    (tenant_id, id, owner_principal_id, bot_resource_id, thread_id, client_request_id)
  values ($1, $2, $3, $4, $5, $6)
  returning id, bot_resource_id as "botId", thread_id as "threadId", status`;

const SELECT_CHANNELS_PAGE = `
  select id, bot_resource_id as "botId", thread_id as "threadId", status
  from enterprise_channels
  where tenant_id = $1 and owner_principal_id = $2
    and ($3::text is null or id < $3)
  order by id desc
  limit $4`;

const SELECT_CHANNEL_BY_ID = `
  select id, bot_resource_id as "botId", thread_id as "threadId", status
  from enterprise_channels
  where tenant_id = $1 and owner_principal_id = $2 and id = $3`;

/*
 * The status flip is idempotent by construction: `coalesce` freezes archived_at at the FIRST
 * archive, so a repeated archive rewrites neither it nor any identity field (spec §6/N6).
 */
const ARCHIVE_CHANNEL = `
  update enterprise_channels
  set status = 'archived', archived_at = coalesce(archived_at, now())
  where tenant_id = $1 and id = $2 and owner_principal_id = $3
  returning id, bot_resource_id as "botId", thread_id as "threadId", status`;

const ChannelRowSchema = z
  .object({
    id: z.string(),
    botId: z.string(),
    threadId: z.string(),
    status: z.enum(["active", "archived"]),
  })
  .strict();

type ChannelRow = z.infer<typeof ChannelRowSchema>;

function conversationOf(row: ChannelRow): PersonalConversation {
  return {
    channelId: row.id,
    botId: row.botId,
    threadId: row.threadId,
    mode: "single",
    status: row.status,
  };
}

function parseChannelRow(
  row: Record<string, unknown> | undefined,
): ChannelRow | null {
  if (row === undefined) {
    return null;
  }
  const parsed = ChannelRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new EnterpriseError("AUTHORIZATION_STATE_INVALID", 503);
  }
  return parsed.data;
}

export type CreateChannelInput = { botId: string; clientRequestId: string };

export type ChannelPage = {
  items: PersonalConversation[];
  nextCursor: string | null;
};

export type BotPage = {
  items: AuthorizedBot[];
  nextCursor: string | null;
};

export type ConversationsStore = {
  /** The read-granted active bots of the selected tenant, one statement (spec §6.3). */
  listAuthorizedBots(
    scope: Scope,
    cursor: string | null,
    limit: number,
  ): Promise<BotPage>;
  /**
   * The §5 linearized creation: the idempotency lock serializes the same key, a hit reads back
   * (same bot) or conflicts (different bot), and only a miss validates the grants and inserts.
   */
  createChannel(
    scope: Scope,
    input: CreateChannelInput,
  ): Promise<PersonalConversation>;
  listOwnerChannels(
    scope: Scope,
    cursor: string | null,
    limit: number,
  ): Promise<ChannelPage>;
  getOwnerChannel(
    scope: Scope,
    channelId: string,
  ): Promise<PersonalConversation | null>;
  archiveOwnerChannel(
    scope: Scope,
    channelId: string,
  ): Promise<PersonalConversation | null>;
};

export function createConversationsStore(
  database: Database,
  authz: Authz,
): ConversationsStore {
  return {
    listAuthorizedBots: (scope, cursor, limit) =>
      withTenant(database, scope, async (tx) => {
        const rows = await tx.unsafe<Record<string, unknown>[]>(SELECT_BOTS, [
          scope.tenantId,
          scope.principalId,
          cursor,
          limit + 1,
        ]);
        const bots = z.array(BotRowSchema).parse(rows);
        const hasMore = bots.length > limit;
        const page = hasMore ? bots.slice(0, limit) : bots;
        return {
          items: page,
          nextCursor: hasMore ? page[page.length - 1].id : null,
        };
      }),

    createChannel: (scope, input) =>
      withTenant(database, scope, async (tx) => {
        // The idempotency linearization point (spec §5 step 2): concurrent creates of the same
        // key serialize here, before the uniqueness probe.
        await lockExclusive(
          tx,
          lockKey(
            "channel-create",
            scope.tenantId,
            scope.principalId,
            input.clientRequestId,
          ),
        );

        const existing = parseChannelRow(
          await tx
            .unsafe<Record<string, unknown>[]>(SELECT_EXISTING_CHANNEL, [
              scope.tenantId,
              scope.principalId,
              input.clientRequestId,
            ])
            .then((rows) => rows[0]),
        );
        if (existing !== null) {
          // Same key, same bot: the original conversation, read back (spec §5 step 3).
          if (existing.botId !== input.botId) {
            throw new EnterpriseError("SUBMISSION_CONFLICT", 409);
          }
          return conversationOf(existing);
        }

        // A miss: the bot's live facts, under the resource's shared lock (the same lock the
        // resource reader takes), so an in-flight revocation finishes first.
        await lockShared(tx, lockKey("resource", scope.tenantId, input.botId));
        const factRows = await tx.unsafe<Record<string, unknown>[]>(
          SELECT_CHANNEL_BOT,
          [scope.tenantId, input.botId, scope.principalId],
        );
        const fact = BotFactsSchema.safeParse(factRows[0]);
        if (!fact.success) {
          throw new EnterpriseError("AUTHORIZATION_STATE_INVALID", 503);
        }
        /*
         * The engine decides, on these live facts (spec §2/§6.2): `locallyAllowed` is the
         * per-action grant match, so read and run are judged as the two independent grants they
         * are, under the tenant's own policy revision — tenancy-v1 keeps refusing run, and the
         * conversations-v1 switch is the tenant's explicit, lock-guarded decision.
         */
        const snapshot = (locallyAllowed: boolean): ResourceSnapshot => ({
          id: fact.data.id,
          tenantId: scope.tenantId,
          workspaceId: fact.data.workspaceId,
          kind: "bot",
          revision: fact.data.revision,
          aclEpoch: fact.data.aclEpoch,
          policyRevision: fact.data.policyRevision,
          active: fact.data.status === "active",
          locallyAllowed,
        });
        if (
          !(await authz.check({
            scope,
            resource: snapshot(fact.data.readAllowed),
            action: "read",
          }))
        ) {
          // No read grant, a deleted row or a non-bot id: the same closed 404 (spec §3.3).
          throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
        }
        if (
          !(await authz.check({
            scope,
            resource: snapshot(fact.data.runAllowed),
            action: "run",
          }))
        ) {
          // Visible but not runnable: §6.2's recommended refusal (TENANT_FORBIDDEN, no new code).
          throw new EnterpriseError("TENANT_FORBIDDEN", 403);
        }

        // The INSERT's COMMIT is the linearization point; the unique constraint is the second
        // line of defense if a concurrent path ever slipped past the lock.
        const inserted = await tx.unsafe<Record<string, unknown>[]>(
          INSERT_CHANNEL,
          [
            scope.tenantId,
            crypto.randomUUID(),
            scope.principalId,
            input.botId,
            crypto.randomUUID(),
            input.clientRequestId,
          ],
        );
        const row = parseChannelRow(inserted[0]);
        if (row === null) {
          throw new EnterpriseError("AUTHORIZATION_STATE_INVALID", 503);
        }
        return conversationOf(row);
      }),

    listOwnerChannels: (scope, cursor, limit) =>
      withTenant(database, scope, async (tx) => {
        const rows = await tx.unsafe<Record<string, unknown>[]>(
          SELECT_CHANNELS_PAGE,
          [scope.tenantId, scope.principalId, cursor, limit + 1],
        );
        const channels = z.array(ChannelRowSchema).parse(rows);
        const hasMore = channels.length > limit;
        const page = hasMore ? channels.slice(0, limit) : channels;
        return {
          items: page.map(conversationOf),
          nextCursor: hasMore ? page[page.length - 1].id : null,
        };
      }),

    getOwnerChannel: (scope, channelId) =>
      withTenant(database, scope, async (tx) => {
        const rows = await tx.unsafe<Record<string, unknown>[]>(
          SELECT_CHANNEL_BY_ID,
          [scope.tenantId, scope.principalId, channelId],
        );
        const row = parseChannelRow(rows[0]);
        return row === null ? null : conversationOf(row);
      }),

    archiveOwnerChannel: (scope, channelId) =>
      withTenant(database, scope, async (tx) => {
        // Archive and (C07's) message submission take the same channel-exclusive lock, so an
        // archive can never interleave with a submission against one channel (spec §5).
        await lockExclusive(tx, lockKey("channel", scope.tenantId, channelId));
        const rows = await tx.unsafe<Record<string, unknown>[]>(
          ARCHIVE_CHANNEL,
          [scope.tenantId, channelId, scope.principalId],
        );
        const row = parseChannelRow(rows[0]);
        return row === null ? null : conversationOf(row);
      }),
  };
}
