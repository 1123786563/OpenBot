import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { enterpriseRunOutbox } from "../../db/schema/enterprise-runs";
import type { PlatformScope } from "../contracts";
import { createConversationStore } from "../conversations/store";
import type { DataDatabase } from "../tenancy/connections";

type Transaction = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

export type RunOutboxMessage = {
  id: string;
  tenantId: string;
  runId: string;
  eventType: string;
  payload: Record<string, unknown>;
};

export type RunOutboxClaim = {
  claimId: string;
  ownerId: string;
  expiresAt: Date;
  message: RunOutboxMessage;
};

export type ClaimPendingOptions = {
  ownerId: string;
  batchSize: number;
  leaseMilliseconds: number;
};

const DEFAULT_LEASE_MILLISECONDS = 30_000;
const MAX_LEASE_MILLISECONDS = 2_147_483_647;

function validateClaimOptions(options: ClaimPendingOptions): void {
  if (
    !options ||
    typeof options.ownerId !== "string" ||
    !options.ownerId.trim() ||
    options.ownerId.length > 200
  ) {
    throw new TypeError("OUTBOX_OWNER_ID_INVALID");
  }
  if (
    !Number.isSafeInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > 500
  ) {
    throw new RangeError("OUTBOX_BATCH_SIZE_INVALID");
  }
  if (
    !Number.isSafeInteger(options.leaseMilliseconds) ||
    options.leaseMilliseconds < 1 ||
    options.leaseMilliseconds > MAX_LEASE_MILLISECONDS
  ) {
    throw new RangeError("OUTBOX_LEASE_MILLISECONDS_INVALID");
  }
}

function outboxMessage(row: typeof enterpriseRunOutbox.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    runId: row.runId,
    eventType: row.eventType,
    payload: row.payload,
  } satisfies RunOutboxMessage;
}

async function claimPendingInTransaction(
  tx: Transaction,
  scope: PlatformScope,
  options: ClaimPendingOptions,
): Promise<RunOutboxClaim[]> {
  const rows = await tx
    .select()
    .from(enterpriseRunOutbox)
    .where(
      and(
        eq(enterpriseRunOutbox.tenantId, scope.tenantId),
        isNull(enterpriseRunOutbox.deliveredAt),
        or(
          isNull(enterpriseRunOutbox.claimExpiresAt),
          sql`${enterpriseRunOutbox.claimExpiresAt} <= now()`,
        ),
      ),
    )
    .orderBy(asc(enterpriseRunOutbox.createdAt), asc(enterpriseRunOutbox.id))
    .limit(options.batchSize)
    .for("update", { skipLocked: true });

  const claims: RunOutboxClaim[] = [];
  for (const row of rows) {
    const claimId = randomUUID();
    const [claimed] = await tx
      .update(enterpriseRunOutbox)
      .set({
        claimId,
        claimOwnerId: options.ownerId,
        claimExpiresAt: sql`now() + ${options.leaseMilliseconds} * interval '1 millisecond'`,
        deliveryAttempts: sql`${enterpriseRunOutbox.deliveryAttempts} + 1`,
      })
      .where(
        and(
          eq(enterpriseRunOutbox.tenantId, scope.tenantId),
          eq(enterpriseRunOutbox.id, row.id),
          isNull(enterpriseRunOutbox.deliveredAt),
          or(
            isNull(enterpriseRunOutbox.claimExpiresAt),
            sql`${enterpriseRunOutbox.claimExpiresAt} <= now()`,
          ),
        ),
      )
      .returning();
    if (!claimed?.claimExpiresAt) continue;
    claims.push({
      claimId,
      ownerId: options.ownerId,
      expiresAt: claimed.claimExpiresAt,
      message: outboxMessage(claimed),
    });
  }
  return claims;
}

export function createRunOutbox(data: DataDatabase) {
  const store = createConversationStore(data);
  return {
    async claimPending(
      scope: PlatformScope,
      options: ClaimPendingOptions,
    ): Promise<RunOutboxClaim[]> {
      validateClaimOptions(options);
      return store.transaction(scope, (tx) =>
        claimPendingInTransaction(tx, scope, options),
      );
    },

    async acknowledge(
      scope: PlatformScope,
      input: { eventId: string; claimId: string; ownerId: string },
    ): Promise<boolean> {
      if (
        !input ||
        typeof input.eventId !== "string" ||
        !input.eventId.trim() ||
        typeof input.claimId !== "string" ||
        !input.claimId.trim() ||
        typeof input.ownerId !== "string" ||
        !input.ownerId.trim()
      ) {
        throw new TypeError("OUTBOX_ACK_INPUT_INVALID");
      }
      return store.transaction(scope, async (tx) => {
        const [acknowledged] = await tx
          .update(enterpriseRunOutbox)
          .set({ deliveredAt: sql`now()` })
          .where(
            and(
              eq(enterpriseRunOutbox.tenantId, scope.tenantId),
              eq(enterpriseRunOutbox.id, input.eventId),
              eq(enterpriseRunOutbox.claimId, input.claimId),
              eq(enterpriseRunOutbox.claimOwnerId, input.ownerId),
              isNull(enterpriseRunOutbox.deliveredAt),
              sql`${enterpriseRunOutbox.claimExpiresAt} > now()`,
            ),
          )
          .returning({ id: enterpriseRunOutbox.id });
        return Boolean(acknowledged);
      });
    },

    async publishPending(
      scope: PlatformScope,
      publish: (message: RunOutboxMessage) => Promise<void>,
      options: { batchSize?: number; leaseMilliseconds?: number } = {},
    ): Promise<number> {
      const batchSize = options.batchSize ?? 50;
      const claims = await this.claimPending(scope, {
        ownerId: randomUUID(),
        batchSize,
        leaseMilliseconds:
          options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS,
      });
      let acknowledgedCount = 0;
      for (const claim of claims) {
        try {
          await publish(claim.message);
          const acknowledged = await this.acknowledge(scope, {
            eventId: claim.message.id,
            claimId: claim.claimId,
            ownerId: claim.ownerId,
          });
          if (acknowledged) acknowledgedCount += 1;
        } catch {
          // A failed publish remains retryable after its claim lease expires.
        }
      }
      return acknowledgedCount;
    },
  };
}
