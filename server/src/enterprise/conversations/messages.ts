/**
 * The C07 message service, per plan §5 (`MessageService.submit` /
 * `MessageService.findSubmission`) and the conversations-subsystem spec §3.2/§3.3:
 * one `withTenant` transaction persists the user message, the business Run and
 * the startup outbox row — accepted (202) means accepted, never completion.
 *
 * Authorization is decided INSIDE the transaction from live facts (the
 * conversations store discipline): the channel row (tenant + owner scoped — a
 * non-owner's or another tenant's channel is the same closed 404), the bot's
 * read/run grants and the tenant policy revision in one statement. A replay
 * re-runs the same authorization before reading back, so a cache hit can never
 * bypass a revocation (runs/contracts.ts:38-43); same key + same content reads
 * back the same Submission, same key + different content is a 409
 * SUBMISSION_CONFLICT on the normalized content digest.
 *
 * The Run seam: the frozen `RunService.create(scope, key, request)` signature is
 * scope-level and manages its own transactions, so the in-message-transaction
 * creation goes through the injected narrow port (`MessageSeams.createRunInTx`)
 * — fixture-level integration until the 03 volume ships an inTx variant. The
 * port returns the RunView whose run_id this submission binds; the outbox row
 * carries the FROZEN runRequestDigest so the dispatch dedup index
 * (enterprise_outbox_dedup, 0059:431) aligns with the run-side digest.
 *
 * The pool is the message domain's own single-writer pool (ob_ent_run_writer):
 * the run/outbox/budget grants and RLS policies (0060 §5a) live on that role,
 * and the directory reads the transaction needs were added by 0063.
 *
 * Statement texts are module constants; values travel only as `$n` parameters.
 */
import { z } from "zod";
import {
  type Submission,
  SubmissionSchema,
  SubmitMessageSchema,
} from "../../../../shared/enterprise/mobile-schemas";
import type {
  CreateRun,
  RunView,
} from "../../../../shared/enterprise/run-contracts";
import type { Database } from "../../db/client";
import type { Authz, ResourceSnapshot, Scope, Tx } from "../contracts";
import { EnterpriseError } from "../errors";
import { runRequestDigest, sha256 } from "../runs/digest";
import { lockExclusive, lockKey, withTenant } from "../tenancy/transaction";

/*
 * The one Run/预算事务内接缝（fixture 级，见测试文件头声明）：接收消息事务的 Tx，
 * 与用户消息/Outbox 同事务提交业务 Run（03 册 inTx 变体就绪后由装配方换真）。
 */
export type RunCreationSeamInput = {
  scope: Scope;
  /** The route-validated idempotency key — here the clientMessageId. */
  key: string;
  /** The strictly parsed create-run request this message maps to. */
  request: CreateRun;
};

export type MessageSeams = {
  createRunInTx(tx: Tx, input: RunCreationSeamInput): Promise<RunView>;
};

/*
 * The channel + bot facts the submission decision needs, in ONE statement:
 * the channel row is tenant + owner scoped, the bot's per-action grant
 * existence and the engine snapshot fields ride along (the store's
 * SELECT_CHANNEL_BOT pattern, entered from the channel instead of the bot).
 */
const SELECT_MESSAGE_CHANNEL = `
  select c.id as "channelId",
         c.thread_id as "threadId",
         c.status as "channelStatus",
         r.id as "botId",
         r.workspace_id as "workspaceId",
         r.status as "botStatus",
         r.revision as revision,
         r.acl_epoch as "aclEpoch",
         t.policy_revision as "policyRevision",
         exists(select 1 from enterprise_resource_grants g
                where g.tenant_id = c.tenant_id and g.resource_id = r.id
                  and g.principal_id = $3 and g.action = 'read') as "readAllowed",
         exists(select 1 from enterprise_resource_grants g
                where g.tenant_id = c.tenant_id and g.resource_id = r.id
                  and g.principal_id = $3 and g.action = 'run') as "runAllowed"
  from enterprise_channels c
  join enterprise_resources r on r.tenant_id = c.tenant_id and r.id = c.bot_resource_id
  join enterprise_tenants t on t.id = c.tenant_id
  where c.tenant_id = $1 and c.id = $2 and c.owner_principal_id = $3`;

const ChannelFactsSchema = z
  .object({
    channelId: z.string(),
    threadId: z.string(),
    channelStatus: z.string(),
    botId: z.string(),
    workspaceId: z.string(),
    botStatus: z.string(),
    revision: z.number().int().positive(),
    aclEpoch: z.number().int().positive(),
    policyRevision: z.string(),
    readAllowed: z.boolean(),
    runAllowed: z.boolean(),
  })
  .strict();

type ChannelFacts = z.infer<typeof ChannelFactsSchema>;

const SELECT_EXISTING_SUBMISSION = `
  select id as "messageId", run_id as "runId", content_digest as "contentDigest"
  from enterprise_channel_messages
  where tenant_id = $1 and channel_id = $2 and client_message_id = $3`;

const SubmissionRowSchema = z
  .object({
    messageId: z.string(),
    runId: z.string(),
    contentDigest: z.string(),
  })
  .strict();

type SubmissionRow = z.infer<typeof SubmissionRowSchema>;

const INSERT_MESSAGE = `
  insert into enterprise_channel_messages
    (tenant_id, channel_id, id, owner_principal_id, client_message_id, run_id, content_digest)
  values ($1, $2, $3, $4, $5, $6, $7)`;

/*
 * The run ledger's thread row: enterprise_runs.thread_id carries a composite FK
 * into enterprise_threads (0059:160-170), which the conversations domain does
 * not populate when it mints the server-generated threadId. The submission
 * registers the channel's thread idempotently in the SAME transaction, so the
 * business Run can reference it; a replayed registration is a no-op.
 */
const INSERT_RUN_THREAD = `
  insert into enterprise_threads (tenant_id, id, owner_principal_id, workspace_id)
  values ($1, $2, $3, $4)
  on conflict (tenant_id, id) do nothing`;

/*
 * The startup intent: status rides the DEFAULT ('pending'), the dedup index
 * (tenant, run, kind, payload_digest) makes a same-run same-digest replay a
 * no-op, and the payload_digest is the FROZEN runRequestDigest so the dispatch
 * dedup aligns with the run-side digest (0059:219-236/431).
 */
const INSERT_START_OUTBOX = `
  insert into enterprise_run_outbox
    (tenant_id, id, run_id, kind, payload_digest, payload, available_at)
  values ($1, $2, $3, $4, $5, $6, $7)
  on conflict (tenant_id, run_id, kind, payload_digest) do nothing`;

/** The startup-outbox kind: the one intent a personal submission starts. */
const START_OUTBOX_KIND = "workflow_start";

/*
 * The submission-content digest: sha256 over a positional array of the parsed
 * SubmitMessage — the same no-trim, no-Unicode-normalization discipline as the
 * run digests (digest.ts), so "same key, different content" is byte-decided.
 */
export const messageContentDigest = (
  text: string,
  attachmentIds: readonly string[],
): string =>
  sha256(JSON.stringify(["channel-message-v1", text, [...attachmentIds]]));

function parseChannelFacts(
  row: Record<string, unknown> | undefined,
): ChannelFacts | null {
  if (row === undefined) {
    return null;
  }
  const parsed = ChannelFactsSchema.safeParse(row);
  if (!parsed.success) {
    throw new EnterpriseError("AUTHORIZATION_STATE_INVALID", 503);
  }
  return parsed.data;
}

function parseSubmissionRow(
  row: Record<string, unknown> | undefined,
): SubmissionRow | null {
  if (row === undefined) {
    return null;
  }
  const parsed = SubmissionRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new EnterpriseError("AUTHORIZATION_STATE_INVALID", 503);
  }
  return parsed.data;
}

function submissionOf(row: SubmissionRow): Submission {
  const parsed = SubmissionSchema.safeParse({
    messageId: row.messageId,
    runId: row.runId,
    accepted: true,
  });
  if (!parsed.success) {
    throw new EnterpriseError("AUTHORIZATION_STATE_INVALID", 503);
  }
  return parsed.data;
}

export type MessagesService = {
  /**
   * Accepts one message: 202 semantics, the Submission names the persisted
   * message and its business Run. Same key + same content reads back the same
   * answer; same key + different content is a 409.
   */
  submit(scope: Scope, channelId: string, body: unknown): Promise<Submission>;
  /**
   * The offline reconciliation read (`plan.md` L164): answers what was
   * persisted for a clientMessageId and NEVER creates a new business Run.
   */
  findSubmission(
    scope: Scope,
    channelId: string,
    clientMessageId: string,
  ): Promise<Submission>;
};

export function createMessagesService(
  database: Database,
  authz: Authz,
  seams: MessageSeams,
): MessagesService {
  const loadFacts = (
    tx: Tx,
    scope: Scope,
    channelId: string,
  ): Promise<ChannelFacts | null> =>
    tx
      .unsafe<Record<string, unknown>[]>(SELECT_MESSAGE_CHANNEL, [
        scope.tenantId,
        channelId,
        scope.principalId,
      ])
      .then((rows) => parseChannelFacts(rows[0]));

  const snapshotOf =
    (scope: Scope, facts: ChannelFacts) =>
    (locallyAllowed: boolean): ResourceSnapshot => ({
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

  return {
    submit: (scope, channelId, body) =>
      withTenant(database, scope, async (tx) => {
        const parsed = SubmitMessageSchema.safeParse(body);
        if (!parsed.success) {
          /* One stable 400 for every strict-schema refusal (the conversations
           * service's REQUEST_BODY_INVALID convention). */
          throw new EnterpriseError("REQUEST_BODY_INVALID", 400);
        }
        const input = parsed.data;

        // The idempotency linearization point: concurrent submits of the same
        // (channel, clientMessageId) serialize here, before the probe.
        await lockExclusive(
          tx,
          lockKey(
            "channel-message",
            scope.tenantId,
            channelId,
            input.clientMessageId,
          ),
        );

        const facts = await loadFacts(tx, scope, channelId);
        if (facts === null) {
          // Missing row, another member's channel, another tenant's channel:
          // one closed 404, nothing of the channel in the answer (spec §6.1).
          throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
        }
        if (
          !(await authz.check({
            scope,
            resource: snapshotOf(scope, facts)(facts.readAllowed),
            action: "read",
          }))
        ) {
          // The bot lost (or never had) read: the channel's owner keeps the row,
          // but the closed 404 is the same indistinguishable answer (§6.2).
          throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
        }
        if (
          !(await authz.check({
            scope,
            resource: snapshotOf(scope, facts)(facts.runAllowed),
            action: "run",
          }))
        ) {
          // Visible but not runnable: §6.2's recommended refusal.
          throw new EnterpriseError("TENANT_FORBIDDEN", 403);
        }
        if (facts.channelStatus === "archived") {
          throw new EnterpriseError("CHANNEL_ARCHIVED", 409);
        }

        const digest = messageContentDigest(input.text, input.attachmentIds);
        const existing = parseSubmissionRow(
          (
            await tx.unsafe<Record<string, unknown>[]>(
              SELECT_EXISTING_SUBMISSION,
              [scope.tenantId, channelId, input.clientMessageId],
            )
          )[0],
        );
        if (existing !== null) {
          if (existing.contentDigest !== digest) {
            throw new EnterpriseError("SUBMISSION_CONFLICT", 409);
          }
          return submissionOf(existing);
        }

        /*
         * The one create-run request a personal submission maps to: the client
         * contributes ONLY the new user text — thread/workspace come from the
         * server-owned channel and its bot, release/alias are the current
         * personal-channel binding until the model-routing domain takes over.
         */
        const request: CreateRun = {
          thread_id: facts.threadId,
          workspace_id: facts.workspaceId,
          expert_release_id: facts.botId,
          model_alias: "default",
          input: { text: input.text },
        };
        await tx.unsafe(INSERT_RUN_THREAD, [
          scope.tenantId,
          facts.threadId,
          scope.principalId,
          facts.workspaceId,
        ]);

        const run = await seams.createRunInTx(tx, {
          scope,
          key: input.clientMessageId,
          request,
        });

        const messageId = crypto.randomUUID();
        await tx.unsafe(INSERT_MESSAGE, [
          scope.tenantId,
          channelId,
          messageId,
          scope.principalId,
          input.clientMessageId,
          run.run_id,
          digest,
        ]);
        await tx.unsafe(INSERT_START_OUTBOX, [
          scope.tenantId,
          crypto.randomUUID(),
          run.run_id,
          START_OUTBOX_KIND,
          runRequestDigest(request),
          {
            run_id: run.run_id,
            thread_id: facts.threadId,
            message_id: messageId,
            client_message_id: input.clientMessageId,
          },
          new Date(),
        ]);
        return submissionOf({
          messageId,
          runId: run.run_id,
          contentDigest: digest,
        });
      }),

    findSubmission: (scope, channelId, clientMessageId) =>
      withTenant(database, scope, async (tx) => {
        const facts = await loadFacts(tx, scope, channelId);
        if (
          facts === null ||
          !(await authz.check({
            scope,
            resource: snapshotOf(scope, facts)(facts.readAllowed),
            action: "read",
          }))
        ) {
          throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
        }
        const row = parseSubmissionRow(
          (
            await tx.unsafe<Record<string, unknown>[]>(
              SELECT_EXISTING_SUBMISSION,
              [scope.tenantId, channelId, clientMessageId],
            )
          )[0],
        );
        if (row === null) {
          // Unknown key: the same closed 404, and no creation of anything.
          throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
        }
        return submissionOf(row);
      }),
  };
}
