import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { attachments, workItems } from "../db/schema";
import { type Transaction, workspaceConversations } from "./store";

export const PERSONAL_BOT_WORK = "personal.bot.turn";
export const personalRoutineWork = "personal.automation.routine";
export const personalInboundWork = "personal.automation.inbound";
const automationKinds = [personalRoutineWork, personalInboundWork];
const botKinds = [PERSONAL_BOT_WORK, ...automationKinds];
const decisionKinds = ["approval.resume", "person.response"];
const automationWindowMs = 60_000;

export const workspaceQuotaConfig = z.object({
  bot: z.coerce.number().int().nonnegative().default(4),
  computer: z.coerce.number().int().min(0).max(1).default(1),
  storage: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(64 * 1024 * 1024),
  automation: z.coerce.number().int().nonnegative().default(30),
});
export type WorkspaceQuotaLimits = z.output<typeof workspaceQuotaConfig>;
type Resource = keyof WorkspaceQuotaLimits;

export class WorkspaceQuotaExceeded extends Error {
  constructor(
    readonly resource: Resource,
    readonly used: number,
    readonly limit: number,
  ) {
    super(
      {
        bot: "Your workspace has reached its Bot run limit.",
        computer: "Your workspace has reached its running Computer limit.",
        storage: "Your workspace has reached its attachment storage limit.",
        automation:
          "Your workspace has reached its automation trigger limit. Try again in a minute.",
      }[resource],
    );
  }

  body() {
    return {
      error: "workspace_quota_exceeded",
      resource: this.resource,
      used: this.used,
      limit: this.limit,
      message: this.message,
    };
  }
}

export function workspaceQuotas(limits: WorkspaceQuotaLimits) {
  function lock(tx: Transaction, accountId: string) {
    return tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"personal-workspace-quota:" + accountId}, 0))`,
    );
  }

  async function workUsage(
    tx: Transaction,
    accountId: string,
    resource: "bot" | "automation",
    claimedOnly = false,
  ) {
    const [row] = await tx
      .select({ used: count() })
      .from(workItems)
      .where(
        and(
          resource === "automation"
            ? inArray(workItems.kind, automationKinds)
            : or(
                inArray(workItems.kind, botKinds),
                claimedOnly
                  ? and(
                      inArray(workItems.kind, decisionKinds),
                      sql`${workItems.leaseUntil} > clock_timestamp()`,
                    )
                  : undefined,
              ),
          or(
            eq(workItems.accountId, accountId),
            sql`${workItems.payload}->>'accountId' = ${accountId}`,
          ),
          resource === "automation"
            ? sql`${workItems.createdAt} > clock_timestamp() - ${automationWindowMs} * interval '1 millisecond'`
            : and(
                isNull(workItems.finishedAt),
                or(
                  isNull(workItems.interruption),
                  and(
                    isNotNull(workItems.claimedBy),
                    sql`${workItems.leaseUntil} > clock_timestamp()`,
                  ),
                ),
                claimedOnly ? isNotNull(workItems.claimedBy) : undefined,
              ),
        ),
      );
    return row?.used ?? 0;
  }

  async function storageUsage(
    tx: Transaction,
    accountId: string,
    workspaceId: string,
  ) {
    const scoped = workspaceConversations(tx, { accountId, workspaceId }).as(
      "quota_conversations",
    );
    const [row] = await tx
      .select({
        used: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)`.mapWith(
          Number,
        ),
      })
      .from(attachments)
      .where(
        or(
          eq(attachments.uploadedBy, `personal-workspace:${workspaceId}`),
          inArray(
            attachments.channelId,
            tx.select({ id: scoped.id }).from(scoped),
          ),
        ),
      );
    return row?.used ?? 0;
  }

  function check(resource: Resource, used: number, additional = 1) {
    if (used + additional > limits[resource])
      throw new WorkspaceQuotaExceeded(resource, used, limits[resource]);
  }

  return {
    check,
    async admitBot(tx: Transaction, accountId: string, automated = false) {
      await lock(tx, accountId);
      if (automated)
        check("automation", await workUsage(tx, accountId, "automation"));
      check("bot", await workUsage(tx, accountId, "bot"));
    },
    async mayClaim(tx: Transaction, accountId: string) {
      await lock(tx, accountId);
      return (await workUsage(tx, accountId, "bot", true)) < limits.bot;
    },
    async admitStorage(
      tx: Transaction,
      accountId: string,
      workspaceId: string,
      bytes: number,
    ) {
      await lock(tx, accountId);
      check("storage", await storageUsage(tx, accountId, workspaceId), bytes);
    },
    async usage(
      tx: Transaction,
      accountId: string,
      workspaceId: string,
      computerUsed: number | null,
    ) {
      return {
        bot: { used: await workUsage(tx, accountId, "bot"), limit: limits.bot },
        computer: { used: computerUsed, limit: limits.computer },
        storage: {
          used: await storageUsage(tx, accountId, workspaceId),
          limit: limits.storage,
        },
        automation: {
          used: await workUsage(tx, accountId, "automation"),
          limit: limits.automation,
          windowSeconds: automationWindowMs / 1000,
        },
      };
    },
  };
}
