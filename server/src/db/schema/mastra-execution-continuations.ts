import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/*
 * ME05 (#477): the durable continuation ledger for suspended executions.
 *
 * A row is the recovery evidence ONE pending operation waits on: the scope
 * and run identity it was suspended under, the exact tool call and argument
 * digest the model proposed, the engine fingerprint the snapshot was written
 * with, an opaque reference into restricted storage, a CAS revision, a claim
 * state with expiry, and the terminal outcome. Nothing here ever carries
 * provider keys, capability plaintext, functions or AbortSignals — the
 * snapshot itself lives in tenant-restricted engine storage and is reachable
 * only through `snapshot_ref`.
 *
 * `mastra_execution_receipts` is the receipt-evidence ledger the recovery
 * rules key on: an operation recorded as started (outcome unknown) must
 * never be auto-replayed, and one recorded as executed must be reused.
 */

/** Control-plane continuation ledger. Runtime identities receive no grants on this table. */
export const mastraExecutionContinuations = pgTable(
  "mastra_execution_continuations",
  {
    continuationId: text("continuation_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    actorId: text("actor_id").notNull(),
    botId: text("bot_id").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    generation: integer("generation").notNull(),
    executionKey: text("execution_key").notNull(),
    threadId: text("thread_id"),
    /** What waits: an approval, a user answer, or a frontend tool result. */
    kind: text("kind")
      .$type<"approval" | "question" | "frontend_tool">()
      .notNull(),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    /** Stable across retries/recovery of one engine call (see tools.ts). */
    operationId: text("operation_id").notNull(),
    argsDigest: text("args_digest").notNull(),
    packageFingerprint: text("package_fingerprint").notNull(),
    /** Opaque pointer into restricted engine storage; never a payload. */
    snapshotRef: text("snapshot_ref").notNull(),
    /**
     * waiting → claimed → finished. The claim carries an HMAC-bound token
     * (only its hash is stored), an expiry, and the decision id that won it.
     */
    status: text("status")
      .$type<"waiting" | "claimed" | "finished">()
      .notNull()
      .default("waiting"),
    revision: integer("revision").notNull().default(1),
    claimTokenHash: text("claim_token_hash"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    decisionId: text("decision_id"),
    outcome: text("outcome").$type<"resumed" | "declined" | "failed_unknown">(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One PENDING continuation per (run, tool call): a replayed save converges
    // on the same row instead of minting a second recovery identity. The
    // index is PARTIAL (finished rows excluded) — a finished row is history,
    // not a hold, and must never block a new suspension of the same call
    // (the store's loadPendingRow applies the same predicate).
    uniqueIndex("mastra_continuations_run_call_idx")
      .on(table.runId, table.toolCallId)
      .where(sql`${table.status} <> 'finished'`),
    index("mastra_continuations_scope_status_idx").on(
      table.tenantId,
      table.workspaceId,
      table.status,
    ),
    index("mastra_continuations_operation_idx").on(table.operationId),
    check(
      "mastra_continuations_kind_check",
      sql`${table.kind} IN ('approval', 'question', 'frontend_tool')`,
    ),
    check(
      "mastra_continuations_status_check",
      sql`${table.status} IN ('waiting', 'claimed', 'finished')`,
    ),
    check(
      "mastra_continuations_outcome_check",
      sql`${table.outcome} IN ('resumed', 'declined', 'failed_unknown')`,
    ),
  ],
);

/** Control-plane receipt ledger. Runtime identities receive no grants on this table. */
export const mastraExecutionReceipts = pgTable(
  "mastra_execution_receipts",
  {
    receiptId: text("receipt_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    operationId: text("operation_id").notNull(),
    runId: text("run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    argsDigest: text("args_digest").notNull(),
    /**
     * `unknown` is recorded the moment an operation starts (the effect may
     * land); `executed` upgrades it once the result is confirmed. Recovery
     * reads this column — unknown is never replayed.
     */
    status: text("status").$type<"unknown" | "executed">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mastra_receipts_operation_idx").on(
      table.runId,
      table.toolCallId,
      table.operationId,
    ),
    // The store's reads (findReceiptRow, recordOperationExecuted) filter on
    // (tenant_id, operation_id); the run_id-leading unique index above cannot
    // serve those predicates, and receipts grow with every external effect.
    index("mastra_receipts_tenant_operation_idx").on(
      table.tenantId,
      table.operationId,
    ),
    check(
      "mastra_receipts_status_check",
      sql`${table.status} IN ('unknown', 'executed')`,
    ),
  ],
);
