import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ReleasedBifrostRoute } from "../../admin/bifrost-catalog";

export const testCreditAccounts = pgTable(
  "test_credit_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    issuer: text().notNull(),
    subject: text().notNull(),
  },
  (table) => [unique().on(table.issuer, table.subject)],
);

export const testCreditBatches = pgTable(
  "test_credit_batches",
  {
    id: uuid().primaryKey(),
    amount: bigint({ mode: "bigint" }).notNull(),
  },
  (table) => [check("test_credit_batch_positive", sql`${table.amount} > 0`)],
);

export const testCreditIssuanceBudgets = pgTable(
  "test_credit_issuance_budgets",
  {
    id: text().primaryKey(),
    total: bigint({ mode: "bigint" }).notNull(),
    issued: bigint({ mode: "bigint" }).notNull().default(sql`0`),
  },
  (table) => [
    check("test_credit_issuance_budget_total", sql`${table.total} >= 0`),
    check(
      "test_credit_issuance_budget_issued",
      sql`${table.issued} >= 0 AND ${table.issued} <= ${table.total}`,
    ),
  ],
);

export const testCreditIssuances = pgTable(
  "test_credit_issuances",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => testCreditAccounts.id),
    budgetId: text("budget_id")
      .notNull()
      .references(() => testCreditIssuanceBudgets.id),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => testCreditBatches.id),
    amount: bigint({ mode: "bigint" }).notNull(),
    state: text({ enum: ["pending", "issued"] as const }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
  },
  (table) => [
    check("test_credit_issuance_amount_positive", sql`${table.amount} > 0`),
    check(
      "test_credit_issuance_state",
      sql`(${table.state} = 'pending' AND ${table.issuedAt} IS NULL) OR (${table.state} = 'issued' AND ${table.issuedAt} IS NOT NULL)`,
    ),
  ],
);

export const testCreditEnrollments = pgTable(
  "test_credit_enrollments",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => testCreditAccounts.id),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => testCreditBatches.id),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.batchId] })],
);

export const testCreditExternalAuthorizations = pgTable(
  "test_credit_external_authorizations",
  {
    id: uuid().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => testCreditAccounts.id),
    application: text({ enum: ["weknora"] }).notNull(),
    resourceId: text("resource_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxMicrocredits: bigint("max_microcredits", { mode: "bigint" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.accountId, table.id),
    check(
      "test_credit_external_authorization_amount",
      sql`${table.maxMicrocredits} > 0`,
    ),
  ],
);

export const testCreditOutcomes = [
  "completed",
  "partial",
  "cancelled",
  "zero_cost",
  "platform_failure",
] as const;

export const testCreditOperations = pgTable(
  "test_credit_operations",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => testCreditAccounts.id),
    id: text().notNull(),
    permit: uuid().notNull().defaultRandom(),
    externalAuthorizationId: uuid("external_authorization_id"),
    externalAccountEpoch: bigint("external_account_epoch", { mode: "number" }),
    priceVersion: uuid("price_version").notNull(),
    route: jsonb().$type<ReleasedBifrostRoute>().notNull(),
    reserved: bigint({ mode: "bigint" }).notNull(),
    charged: bigint({ mode: "bigint" }),
    state: text({
      enum: ["reserved", "pending", "settled", "released"],
    }).notNull(),
    inputTokens: bigint("input_tokens", { mode: "bigint" }),
    outputTokens: bigint("output_tokens", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rerunOfOperationId: text("rerun_of_operation_id"),
    cutoffHold: bigint("cutoff_hold", { mode: "bigint" }),
    eligibleEvidenceId: text("eligible_evidence_id"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.id] }),
    foreignKey({
      name: "test_credit_operation_external_authorization_fk",
      columns: [table.accountId, table.externalAuthorizationId],
      foreignColumns: [
        testCreditExternalAuthorizations.accountId,
        testCreditExternalAuthorizations.id,
      ],
    }),
    check(
      "test_credit_operation_external_binding",
      sql`(${table.externalAuthorizationId} IS NULL) = (${table.externalAccountEpoch} IS NULL)`,
    ),
    index("test_credit_operations_external_authorization_idx")
      .on(table.accountId, table.externalAuthorizationId)
      .where(sql`${table.externalAuthorizationId} IS NOT NULL`),
    index("test_credit_operations_due_cutoff_idx")
      .on(table.dispatchedAt, table.accountId, table.id)
      .where(sql`${table.state} = 'pending' AND ${table.cutoffHold} IS NULL`),
    foreignKey({
      name: "test_credit_rerun_original_fk",
      columns: [table.accountId, table.rerunOfOperationId],
      foreignColumns: [table.accountId, table.id],
    }),
    check(
      "test_credit_cutoff_hold_amount",
      sql`${table.cutoffHold} BETWEEN 0 AND ${table.reserved}`,
    ),
    check(
      "test_credit_rerun_distinct",
      sql`${table.rerunOfOperationId} <> ${table.id}`,
    ),
    check(
      "test_credit_operation_amounts",
      sql`
    ${table.reserved} >= 0 AND
    (${table.charged} IS NULL OR ${table.charged} BETWEEN 0 AND ${table.reserved})
  `,
    ),
    check(
      "test_credit_operation_state",
      sql`
    ((${table.state} = 'released' OR (${table.state} = 'reserved' AND ${table.dispatchedAt} IS NULL))
      AND ${table.charged} IS NULL AND ${table.inputTokens} IS NULL AND ${table.outputTokens} IS NULL)
    OR (${table.state} = 'pending' AND ${table.dispatchedAt} IS NOT NULL
      AND ${table.charged} IS NULL AND ${table.inputTokens} IS NULL AND ${table.outputTokens} IS NULL)
    OR (${table.state} = 'settled' AND ${table.dispatchedAt} IS NOT NULL
      AND ${table.charged} IS NOT NULL AND ${table.inputTokens} IS NOT NULL AND ${table.outputTokens} IS NOT NULL
      AND ${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0)
  `,
    ),
  ],
);

export const testCreditEvidence = pgTable(
  "test_credit_evidence",
  {
    accountId: uuid("account_id").notNull(),
    operationId: text("operation_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    outcome: text({ enum: testCreditOutcomes }).notNull(),
    inputTokens: bigint("input_tokens", { mode: "bigint" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "bigint" }).notNull(),
    cost: numeric({ mode: "bigint" }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.operationId, table.evidenceId],
    }),
    foreignKey({
      name: "test_credit_evidence_operation_fk",
      columns: [table.accountId, table.operationId],
      foreignColumns: [testCreditOperations.accountId, testCreditOperations.id],
    }),
    check(
      "test_credit_evidence_amounts",
      sql`
      ${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.cost} >= 0
      AND (${table.outcome} <> 'zero_cost' OR ${table.cost} = 0)
    `,
    ),
  ],
);
