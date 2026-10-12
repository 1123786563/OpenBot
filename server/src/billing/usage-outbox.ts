import { and, asc, eq, or } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  type UsageOutboxDeliveryStatus,
  type UsageOutboxSource,
  usageOutbox,
} from "../db/schema/usage-outbox";

export type UsageOutboxInput = {
  eventId: string;
  source: UsageOutboxSource;
  externalCustomerId: string;
  transactionId: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  client: string;
  occurredAt: Date;
};

export type UsageOutboxRecord = typeof usageOutbox.$inferSelect;

export type UsageOutbox = {
  record(input: UsageOutboxInput): Promise<{ inserted: boolean }>;
  pending(limit: number): Promise<readonly UsageOutboxRecord[]>;
  markLagoDelivered(eventId: string): Promise<void>;
  markCreditsDelivered(eventId: string): Promise<void>;
  recordDeliveryFailure(
    eventId: string,
    target: "lago" | "credits",
    failureCode: string,
  ): Promise<void>;
};

export class UsageOutboxConflictError extends Error {
  constructor(eventId: string) {
    super(`Usage event ${eventId} conflicts with previously recorded facts`);
    this.name = "UsageOutboxConflictError";
  }
}

export class UsageOutboxRecordNotFoundError extends Error {
  constructor(eventId: string) {
    super(`Usage event ${eventId} was not found in the outbox`);
    this.name = "UsageOutboxRecordNotFoundError";
  }
}

const immutableFields = [
  "eventId",
  "source",
  "externalCustomerId",
  "transactionId",
  "inputTokens",
  "outputTokens",
  "model",
  "client",
  "occurredAt",
] as const;

function sameImmutableFacts(
  record: UsageOutboxRecord,
  input: UsageOutboxInput,
) {
  return immutableFields.every((field) => {
    const recorded = record[field];
    const incoming = input[field];
    if (recorded instanceof Date && incoming instanceof Date) {
      return recorded.getTime() === incoming.getTime();
    }
    return recorded === incoming;
  });
}

function assertPositiveLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Usage outbox limit must be a positive safe integer");
  }
}

export function createUsageOutbox(database: Database): UsageOutbox {
  async function markDelivered(eventId: string, target: "lago" | "credits") {
    const rows =
      target === "lago"
        ? await database
            .update(usageOutbox)
            .set({
              lagoStatus: "delivered" satisfies UsageOutboxDeliveryStatus,
              lagoLastErrorCode: null,
              updatedAt: new Date(),
            })
            .where(eq(usageOutbox.eventId, eventId))
            .returning({ eventId: usageOutbox.eventId })
        : await database
            .update(usageOutbox)
            .set({
              creditsStatus: "delivered" satisfies UsageOutboxDeliveryStatus,
              creditsLastErrorCode: null,
              updatedAt: new Date(),
            })
            .where(eq(usageOutbox.eventId, eventId))
            .returning({ eventId: usageOutbox.eventId });

    if (rows.length === 0) {
      throw new UsageOutboxRecordNotFoundError(eventId);
    }
  }

  async function recordDeliveryFailure(
    eventId: string,
    target: "lago" | "credits",
    failureCode: string,
  ) {
    const rows = await database
      .update(usageOutbox)
      .set(
        target === "lago"
          ? {
              lagoLastErrorCode: failureCode,
              updatedAt: new Date(),
            }
          : {
              creditsLastErrorCode: failureCode,
              updatedAt: new Date(),
            },
      )
      .where(
        and(
          eq(usageOutbox.eventId, eventId),
          eq(
            target === "lago"
              ? usageOutbox.lagoStatus
              : usageOutbox.creditsStatus,
            "pending",
          ),
        ),
      )
      .returning({ eventId: usageOutbox.eventId });

    if (rows.length === 0) {
      const [record] = await database
        .select({ eventId: usageOutbox.eventId })
        .from(usageOutbox)
        .where(eq(usageOutbox.eventId, eventId))
        .limit(1);
      if (!record) {
        throw new UsageOutboxRecordNotFoundError(eventId);
      }
    }
  }

  return {
    async record(input) {
      const inserted = await database
        .insert(usageOutbox)
        .values(input)
        .onConflictDoNothing({ target: usageOutbox.eventId })
        .returning({ eventId: usageOutbox.eventId });

      if (inserted.length > 0) {
        return { inserted: true };
      }

      const [record] = await database
        .select()
        .from(usageOutbox)
        .where(eq(usageOutbox.eventId, input.eventId))
        .limit(1);

      if (!record || !sameImmutableFacts(record, input)) {
        throw new UsageOutboxConflictError(input.eventId);
      }
      return { inserted: false };
    },

    async pending(limit) {
      assertPositiveLimit(limit);
      return database
        .select()
        .from(usageOutbox)
        .where(
          or(
            eq(usageOutbox.lagoStatus, "pending"),
            eq(usageOutbox.creditsStatus, "pending"),
          ),
        )
        .orderBy(asc(usageOutbox.updatedAt), asc(usageOutbox.eventId))
        .limit(limit);
    },

    markLagoDelivered(eventId) {
      return markDelivered(eventId, "lago");
    },

    markCreditsDelivered(eventId) {
      return markDelivered(eventId, "credits");
    },

    recordDeliveryFailure,
  };
}
