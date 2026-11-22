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
    // Set while the upstream identity (Casdoor) has the account disabled:
    // new paid orders pause, payments that land anyway refund in full, and
    // in-flight refunds and settlements continue (#103).
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
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

export const testCreditOutcomes = [
  "completed",
  "partial",
  "cancelled",
  "zero_cost",
  "platform_failure",
] as const;

export const testCreditBudgets = pgTable(
  "test_credit_budgets",
  {
    accountId: uuid("account_id").notNull(),
    id: text().notNull(),
    // A background task fixes its Credit type when it starts (#107):
    // trial (test) or paid — never both.
    creditType: text("credit_type", { enum: ["test", "paid"] }).notNull(),
    limitMicrocredits: bigint("limit_microcredits", {
      mode: "bigint",
    }).notNull(),
    state: text({ enum: ["active", "paused", "completed"] })
      .notNull()
      .default("active"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "test_credit_budgets_pk",
      columns: [table.accountId, table.id],
    }),
    foreignKey({
      name: "test_credit_budgets_account_fk",
      columns: [table.accountId],
      foreignColumns: [testCreditAccounts.id],
    }),
    check(
      "test_credit_budget_credit_type",
      sql`${sql.identifier(table.creditType.name)} IN ('test', 'paid')`,
    ),
    check(
      "test_credit_budget_state",
      sql`${sql.identifier(table.state.name)} IN ('active', 'paused', 'completed')`,
    ),
    check(
      "test_credit_budget_limit_positive",
      sql`${sql.identifier(table.limitMicrocredits.name)} > 0`,
    ),
  ],
);

export const testCreditOperations = pgTable(
  "test_credit_operations",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => testCreditAccounts.id),
    id: text().notNull(),
    permit: uuid().notNull().defaultRandom(),
    priceVersion: uuid("price_version").notNull(),
    route: jsonb().$type<ReleasedBifrostRoute>().notNull(),
    reserved: bigint({ mode: "bigint" }).notNull(),
    // The paid-source share of this reservation's hold and charge; the rest
    // belongs to Test Credit enrollments. Both stay 0 for trial-only holds.
    paidHoldMicrocredits: bigint("paid_hold_microcredits", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    paidChargeMicrocredits: bigint("paid_charge_microcredits", {
      mode: "bigint",
    }),
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
    budgetId: text("budget_id"),
    stepId: text("step_id"),
    // The app the step ran for (#107 按应用筛选). Null for a caller that named none.
    applicationId: text("application_id"),
    resultText: text("result_text"),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.id] }),
    index("test_credit_operations_budget_idx").on(
      table.accountId,
      table.budgetId,
      table.state,
    ),
    index("test_credit_operations_due_cutoff_idx")
      .on(table.dispatchedAt, table.accountId, table.id)
      .where(sql`${table.state} = 'pending' AND ${table.cutoffHold} IS NULL`),
    foreignKey({
      name: "test_credit_budget_fk",
      columns: [table.accountId, table.budgetId],
      foreignColumns: [testCreditBudgets.accountId, testCreditBudgets.id],
    }),
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

// A step that stopped for want of credits or budget room (#107 安全续做点).
// Nothing is held or dispatched for it, so the same operation resumes there
// once the person confirms a budget. The row outlives the reservation, so a
// replay of the runner's own request resolves to the same budget.
export const testCreditResumePoints = pgTable(
  "test_credit_resume_points",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => testCreditAccounts.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    applicationId: text("application_id"),
    reason: text({
      enum: ["insufficient_credits", "execution_limit"],
    }).notNull(),
    // The budget the person confirmed for this step, once they have.
    budgetId: text("budget_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.operationId] }),
    foreignKey({
      name: "test_credit_resume_point_budget_fk",
      columns: [table.accountId, table.budgetId],
      foreignColumns: [testCreditBudgets.accountId, testCreditBudgets.id],
    }).onDelete("cascade"),
    check(
      "test_credit_resume_point_confirmation",
      sql`(${table.budgetId} is null) = (${table.confirmedAt} is null)`,
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

export const lagoUsageEvents = pgTable(
  "lago_usage_events",
  {
    eventId: text("event_id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => testCreditAccounts.id),
    operationId: text("operation_id").notNull(),
    resource: text().notNull(),
    inputTokens: bigint("input_tokens", { mode: "bigint" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "bigint" }).notNull(),
    amountMicrocredits: bigint("amount_microcredits", {
      mode: "bigint",
    }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    state: text({ enum: ["pending", "accepted", "paused"] })
      .notNull()
      .default("pending"),
    failure: text(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.accountId, table.operationId),
    index("lago_usage_events_pending_idx").on(table.state, table.createdAt),
    check(
      "lago_usage_events_amounts",
      sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.amountMicrocredits} >= 0`,
    ),
  ],
);

// A pilot-wide provider-cost ceiling per route path (#106). Reservations on a
// capped path must atomically acquire a share of the ceiling at the route's
// maximum charge; the share stays held while the provider result is unknown.
export const pilotProviderCostLimits = pgTable(
  "pilot_provider_cost_limits",
  {
    path: text().primaryKey(),
    limitMicrocredits: bigint("limit_microcredits", {
      mode: "bigint",
    }).notNull(),
    updatedBy: text().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "pilot_provider_cost_limits_nonnegative",
      sql`${table.limitMicrocredits} >= 0`,
    ),
  ],
);

// Every ceiling change is append-only so the operator and both values stay
// auditable without replaying the current row.
export const pilotProviderCostLimitEvents = pgTable(
  "pilot_provider_cost_limit_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    path: text().notNull(),
    fromLimitMicrocredits: bigint("from_limit_microcredits", {
      mode: "bigint",
    }),
    toLimitMicrocredits: bigint("to_limit_microcredits", {
      mode: "bigint",
    }).notNull(),
    by: text().notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const providerCostHoldStates = [
  "held",
  "verified",
  "booked",
  "released",
] as const;

export const pilotProviderCostHolds = pgTable(
  "pilot_provider_cost_holds",
  {
    path: text().notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => testCreditAccounts.id),
    operationId: text("operation_id").notNull(),
    boundMicrocredits: bigint("bound_microcredits", {
      mode: "bigint",
    }).notNull(),
    // Actual cost once verified; the bound stays booked while unknown.
    costMicrocredits: bigint("cost_microcredits", { mode: "bigint" }),
    state: text({ enum: providerCostHoldStates }).notNull().default("held"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      columns: [table.path, table.accountId, table.operationId],
    }),
    check(
      "pilot_provider_cost_holds_amounts",
      sql`${table.boundMicrocredits} >= 0 AND (${table.costMicrocredits} IS NULL OR ${table.costMicrocredits} >= 0)`,
    ),
  ],
);
