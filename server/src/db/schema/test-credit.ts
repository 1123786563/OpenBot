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

import type { CoordinationModelCall } from "../../billing/coordination-model-call";

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
    // When the account last finished reconciling after a restore (#108). Until
    // an account has done so, a restore in progress keeps its new charges and
    // grants paused.
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  },
  (table) => [unique().on(table.issuer, table.subject)],
);

/**
 * An application whose steps spend from a person's Billing Account (#111):
 * platform-operated (WeKnora) or independently operated. Nothing reserves
 * under an application before it is approved, and a paused application's
 * path takes no new reservations while its existing ones keep settling
 * (#112 按应用路径暂停).
 */
export const billingApplications = pgTable(
  "billing_applications",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    operator: text({ enum: ["platform", "independent"] }).notNull(),
    // The resource scope the application may be authorized for, as a prefix.
    resourcePrefix: text("resource_prefix").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedBy: text("paused_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "billing_application_approval",
      sql`(${table.approvedAt} is null) = (${table.approvedBy} is null)`,
    ),
    check(
      "billing_application_pause",
      sql`(${table.pausedAt} is null) = (${table.pausedBy} is null)`,
    ),
  ],
);

/**
 * A person's explicit Spending Authorization for an application (#111): which
 * resources, until when, and the most it may spend. A background
 * authorization is bound to one task; revocation stops new reservations.
 */
export const billingSpendingAuthorizations = pgTable(
  "billing_spending_authorizations",
  {
    id: text().primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => billingApplications.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => testCreditAccounts.id, { onDelete: "cascade" }),
    kind: text({ enum: ["online", "background"] }).notNull(),
    taskId: text("task_id"),
    resourcePrefix: text("resource_prefix").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    limitMicrocredits: bigint("limit_microcredits", {
      mode: "bigint",
    }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.accountId, table.id),
    check("billing_authorization_amount", sql`${table.limitMicrocredits} > 0`),
    check(
      "billing_authorization_task",
      sql`(${table.kind} = 'background') = (${table.taskId} is not null)`,
    ),
  ],
);

/**
 * The ledger's restore mode (#108). From a restore from backup until each
 * account has been reconciled and resumed on its own, new charges and
 * entitlement grants stay paused for the accounts still held.
 */
export const billingRestore = pgTable("billing_restore", {
  id: text().primaryKey(),
  restoringSince: timestamp("restoring_since", { withTimezone: true }),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
    parentBudgetId: text("parent_budget_id"),
    childKind: text("child_kind", { enum: ["delegation", "subagent"] }),
    childBotId: text("child_bot_id"),
    // A background task fixes its Credit type when it starts (#107):
    // trial (test) or paid — never both.
    creditType: text("credit_type", { enum: ["test", "paid"] }).notNull(),
    limitMicrocredits: bigint("limit_microcredits", {
      mode: "bigint",
    }).notNull(),
    state: text({ enum: ["active", "paused", "completed"] })
      .notNull()
      .default("active"),
    modelRoute: text("model_route"),
    modelPriceVersion: uuid("model_price_version"),
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
    foreignKey({
      name: "test_credit_budgets_parent_fk",
      columns: [table.accountId, table.parentBudgetId],
      foreignColumns: [table.accountId, table.id],
    }),
    unique("test_credit_budgets_child_key").on(
      table.accountId,
      table.parentBudgetId,
      table.childKind,
      table.childBotId,
    ),
    check(
      "test_credit_budgets_child_binding",
      sql`(${table.parentBudgetId} IS NULL AND ${table.childKind} IS NULL AND ${table.childBotId} IS NULL)
        OR (${table.parentBudgetId} IS NOT NULL AND ${table.parentBudgetId} <> ${table.id}
          AND ${table.childKind} IN ('delegation', 'subagent') AND ${table.childKind} IS NOT NULL
          AND ${table.childBotId} IS NOT NULL)`,
    ),
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
    parentRunId: text("parent_run_id"),
    // The app the step ran for (#107 按应用筛选). Null for a caller that named none.
    applicationId: text("application_id"),
    // The Spending Authorization the reservation was made under and counts
    // against (#111). Null for a first-party step.
    authorizationId: text("authorization_id"),
    resultText: text("result_text"),
    coordinationToolNames: jsonb("coordination_tool_names").$type<string[]>(),
    resultCalls: jsonb("result_calls").$type<CoordinationModelCall[]>(),
    gatewayRequestId: uuid("gateway_request_id").unique(),
    gatewayRequestDigest: text("gateway_request_digest"),
    gatewayEvidenceCheckAt: timestamp("gateway_evidence_check_at", {
      withTimezone: true,
    }),
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
    index("test_credit_operations_gateway_evidence_idx")
      .on(table.gatewayEvidenceCheckAt)
      .where(sql`${table.gatewayEvidenceCheckAt} IS NOT NULL`),
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
    // Scoped by account: a reservation can only count against one of its own
    // account's authorizations.
    foreignKey({
      name: "test_credit_authorization_fk",
      columns: [table.accountId, table.authorizationId],
      foreignColumns: [
        billingSpendingAuthorizations.accountId,
        billingSpendingAuthorizations.id,
      ],
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
    requiredBudgetId: text("required_budget_id"),
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
