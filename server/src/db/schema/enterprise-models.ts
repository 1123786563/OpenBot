/**
 * Enterprise model domain: versioned routes, model grants, budget accounts/reservations/bindings,
 * per-logical-call attempts, usage entries and the model-call ledger. Plan 03 §4.1 (models
 * domain).
 *
 * An alias resolves to exactly one approved route revision at run creation; the run then pins the
 * route id. `is_default_for_alias` selects the fallback for NEW resolutions only — the partial
 * unique index keeps one default active version per (tenant, alias), and existing runs keep their
 * original route. Budget non-negativity for reservations (including allocated ≤ held) is the
 * budget_reservation_nonnegative CHECK in the custom RLS migration; account counters carry their
 * own non-negativity CHECK here.
 *
 * Import cycles with ./enterprise-runs (model attempts/calls reference runs, attempts and steps;
 * delegations reference routes) are safe: every cross-file reference lives inside the lazy extras
 * callback, which Drizzle evaluates at introspection time, not at module load.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { enterpriseResources } from "./enterprise-authz";
import {
  enterpriseRunAttempts,
  enterpriseRunSteps,
  enterpriseRuns,
} from "./enterprise-runs";
import { enterpriseMemberships } from "./enterprise-tenancy";

const stamp = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const counter = (name: string) => bigint(name, { mode: "bigint" });

export const enterpriseModelRoutes = pgTable(
  "enterprise_model_routes",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    alias: text("alias").notNull(),
    revision: counter("revision").notNull(),
    resourceId: text("resource_id").notNull(),
    /* The upstream target is operator-owned; callers can never rewrite it. */
    targetRef: text("target_ref").notNull(),
    priceRevision: counter("price_revision").notNull(),
    currency: text("currency").notNull(),
    inputUnitMicros: counter("input_unit_micros").notNull(),
    outputUnitMicros: counter("output_unit_micros").notNull(),
    perRequestMicros: counter("per_request_micros").notNull(),
    maxInputTokens: counter("max_input_tokens").notNull(),
    maxOutputTokens: counter("max_output_tokens").notNull(),
    maxRequestBytes: counter("max_request_bytes").notNull(),
    protocolProfile: text("protocol_profile").notNull(),
    usageProfile: text("usage_profile").notNull(),
    isDefaultForAlias: boolean("is_default_for_alias").notNull().default(false),
    status: text("status").notNull().default("active"),
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.resourceId],
      foreignColumns: [enterpriseResources.tenantId, enterpriseResources.id],
    }),
    uniqueIndex("enterprise_route_revision").on(
      t.tenantId,
      t.alias,
      t.revision,
    ),
    /*
     * One default ACTIVE version per (tenant, alias): enforced by the partial unique index in the
     * custom RLS migration, not by this column alone.
     */
    check("enterprise_route_status", sql`${t.status} in ('active','disabled')`),
  ],
);

export const enterpriseModelGrants = pgTable(
  "enterprise_model_grants",
  {
    tenantId: text("tenant_id").notNull(),
    routeId: text("route_id").notNull(),
    principalId: text("principal_id").notNull(),
    revision: counter("revision").notNull(),
    status: text("status").notNull().default("active"),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.routeId, t.principalId] }),
    foreignKey({
      columns: [t.tenantId, t.routeId],
      foreignColumns: [
        enterpriseModelRoutes.tenantId,
        enterpriseModelRoutes.id,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    check(
      "enterprise_model_grant_status",
      sql`${t.status} in ('active','revoked')`,
    ),
  ],
);

export const enterpriseBudgetAccounts = pgTable(
  "enterprise_budget_accounts",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    /* Polymorphic scope reference — no FK by design (workspace/expert/principal/tenant). */
    scopeRef: text("scope_ref").notNull(),
    periodId: text("period_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    currency: text("currency").notNull(),
    limitMicros: counter("limit_micros").notNull(),
    spentMicros: counter("spent_micros").notNull().default(sql`0`),
    heldMicros: counter("held_micros").notNull().default(sql`0`),
    overageMicros: counter("overage_micros").notNull().default(sql`0`),
    status: text("status").notNull().default("active"),
    revision: counter("revision").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex("enterprise_budget_account_period").on(
      t.tenantId,
      t.scopeKind,
      t.scopeRef,
      t.periodId,
      t.currency,
    ),
    check(
      "enterprise_account_scope",
      sql`${t.scopeKind} in ('tenant','workspace','expert','principal')`,
    ),
    check("enterprise_account_status", sql`${t.status} in ('active','frozen')`),
    /* Real overspend may exceed the limit; admission refuses new calls, the ledger keeps truth. */
    check(
      "enterprise_account_nonnegative",
      sql`${t.spentMicros} >= 0 and ${t.heldMicros} >= 0 and ${t.overageMicros} >= 0`,
    ),
  ],
);

export const enterpriseBudgetReservations = pgTable(
  "enterprise_budget_reservations",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    /*
     * Deferred composite FK to enterprise_runs (tenant_id, id) lives in the custom RLS migration:
     * run and reservation commit in one transaction and the cycle settles at commit.
     */
    runId: text("run_id").notNull(),
    capMicros: counter("cap_micros").notNull(),
    spentMicros: counter("spent_micros").notNull().default(sql`0`),
    heldMicros: counter("held_micros").notNull().default(sql`0`),
    allocatedMicros: counter("allocated_micros").notNull().default(sql`0`),
    overageMicros: counter("overage_micros").notNull().default(sql`0`),
    currency: text("currency").notNull(),
    periodId: text("period_id").notNull(),
    status: text("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex("enterprise_reservation_run").on(t.tenantId, t.runId),
    check(
      "enterprise_reservation_status",
      sql`${t.status} in ('open','closed','reconciliation')`,
    ),
  ],
);

export const enterpriseBudgetBindings = pgTable(
  "enterprise_budget_bindings",
  {
    tenantId: text("tenant_id").notNull(),
    reservationId: text("reservation_id").notNull(),
    accountId: text("account_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.reservationId, t.accountId] }),
    foreignKey({
      columns: [t.tenantId, t.reservationId],
      foreignColumns: [
        enterpriseBudgetReservations.tenantId,
        enterpriseBudgetReservations.id,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [
        enterpriseBudgetAccounts.tenantId,
        enterpriseBudgetAccounts.id,
      ],
    }),
  ],
);

export const enterpriseModelAttempts = pgTable(
  "enterprise_model_attempts",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    /* One possibly-billable upstream request; network replays never change it. */
    logicalCallId: text("logical_call_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    routeId: text("route_id").notNull(),
    priceRevision: counter("price_revision").notNull(),
    reservationId: text("reservation_id").notNull(),
    capMicros: counter("cap_micros").notNull(),
    status: text("status").notNull(),
    chargedMicros: counter("charged_micros"),
    usageSource: text("usage_source"),
    responseDigest: text("response_digest"),
    responseRef: text("response_ref"),
    providerRequestId: text("provider_request_id"),
    /* A definite upstream failure that may still bill stays usage-unknown, never un-billed. */
    usageStatus: text("usage_status").notNull().default("pending"),
    leaseId: text("lease_id").notNull(),
    fencingToken: counter("fencing_token").notNull(),
    receiptRevision: counter("receipt_revision").notNull(),
    createdAt: stamp(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.runId, t.attemptId],
      foreignColumns: [
        enterpriseRunAttempts.tenantId,
        enterpriseRunAttempts.runId,
        enterpriseRunAttempts.id,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.reservationId],
      foreignColumns: [
        enterpriseBudgetReservations.tenantId,
        enterpriseBudgetReservations.id,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.routeId],
      foreignColumns: [
        enterpriseModelRoutes.tenantId,
        enterpriseModelRoutes.id,
      ],
    }),
    /* 1:1 with enterprise_model_calls in the MVP: a fallback creates a NEW logical call. */
    foreignKey({
      columns: [t.tenantId, t.runId, t.logicalCallId],
      foreignColumns: [
        enterpriseModelCalls.tenantId,
        enterpriseModelCalls.runId,
        enterpriseModelCalls.logicalCallId,
      ],
    }),
    uniqueIndex("enterprise_model_attempt_call").on(
      t.tenantId,
      t.runId,
      t.logicalCallId,
    ),
    check(
      "enterprise_model_attempt_status",
      sql`${t.status} in ('reserved','submitted','succeeded','failed','unknown')`,
    ),
    check(
      "enterprise_model_attempt_usage",
      sql`${t.usageStatus} in ('pending','confirmed','unknown')`,
    ),
  ],
);

export const enterpriseUsageEntries = pgTable(
  "enterprise_usage_entries",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    modelAttemptId: text("model_attempt_id").notNull(),
    revision: counter("revision").notNull(),
    inputTokens: counter("input_tokens"),
    outputTokens: counter("output_tokens"),
    costMicros: counter("cost_micros").notNull(),
    kind: text("kind").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.modelAttemptId],
      foreignColumns: [
        enterpriseModelAttempts.tenantId,
        enterpriseModelAttempts.id,
      ],
    }),
    uniqueIndex("enterprise_usage_revision").on(
      t.tenantId,
      t.modelAttemptId,
      t.revision,
    ),
    check("enterprise_usage_kind", sql`${t.kind} in ('charge','adjustment')`),
  ],
);

export const enterpriseModelCalls = pgTable(
  "enterprise_model_calls",
  {
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    logicalCallId: text("logical_call_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    stepId: text("step_id").notNull(),
    callOrdinal: counter("call_ordinal").notNull(),
    routeId: text("route_id").notNull(),
    status: text("status").notNull(),
    /* Created BEFORE the capability request; never depends on a not-yet-existing upstream reply. */
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.runId, t.logicalCallId] }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.runId, t.attemptId],
      foreignColumns: [
        enterpriseRunAttempts.tenantId,
        enterpriseRunAttempts.runId,
        enterpriseRunAttempts.id,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.runId, t.stepId],
      foreignColumns: [
        enterpriseRunSteps.tenantId,
        enterpriseRunSteps.runId,
        enterpriseRunSteps.id,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.routeId],
      foreignColumns: [
        enterpriseModelRoutes.tenantId,
        enterpriseModelRoutes.id,
      ],
    }),
    uniqueIndex("enterprise_call_ordinal").on(
      t.tenantId,
      t.runId,
      t.stepId,
      t.callOrdinal,
    ),
    check(
      "enterprise_model_call_status",
      sql`${t.status} in ('allocated','submitted','settled','unknown')`,
    ),
  ],
);
