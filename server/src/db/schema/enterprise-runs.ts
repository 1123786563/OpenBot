import type { BaseEvent } from "@ag-ui/client";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { enterpriseConversations } from "./enterprise-conversations";
import { enterpriseTenants, enterpriseWorkspaces } from "./enterprise-tenancy";
import { jsonb } from "./json";

const tenantPolicy = (table: string) =>
  sql`${sql.raw(table)}.tenant_id = nullif(current_setting('app.tenant_id', true), '')`;

export const enterpriseRuns = pgTable(
  "enterprise_runs",
  {
    id: uuid("id").notNull().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    threadId: text("thread_id").notNull(),
    clientMessageKey: text("client_message_key").notNull(),
    expertVersionRef: text("expert_version_ref").notNull(),
    modelRouteRef: text("model_route_ref").notNull(),
    modelRouteMaximumTokens: integer("model_route_maximum_tokens").notNull(),
    status: text("status")
      .$type<
        | "queued"
        | "running"
        | "waiting_approval"
        | "suspended"
        | "succeeded"
        | "failed"
        | "cancelled"
      >()
      .notNull()
      .default("queued"),
    attemptGeneration: integer("attempt_generation").notNull().default(1),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    uniqueIndex("enterprise_runs_event_owner_binding").on(
      table.tenantId,
      table.id,
      table.workspaceId,
      table.principalId,
      table.threadId,
    ),
    uniqueIndex("enterprise_runs_client_message_key").on(
      table.tenantId,
      table.threadId,
      table.clientMessageKey,
    ),
    uniqueIndex("enterprise_runs_one_active_thread")
      .on(table.tenantId, table.threadId)
      .where(
        sql`${table.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
      ),
    index("enterprise_runs_owner_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    check(
      "enterprise_runs_generation_check",
      sql`${table.attemptGeneration} > 0`,
    ),
    check(
      "enterprise_runs_model_route_maximum_tokens_check",
      sql`${table.modelRouteMaximumTokens} > 0`,
    ),
    check(
      "enterprise_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'waiting_approval', 'suspended', 'succeeded', 'failed', 'cancelled')`,
    ),
    pgPolicy("enterprise_runs_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: tenantPolicy("enterprise_runs"),
      withCheck: tenantPolicy("enterprise_runs"),
    }),
  ],
).enableRLS();

export const enterpriseRunAttempts = pgTable(
  "enterprise_run_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    runId: uuid("run_id").notNull(),
    generation: integer("generation").notNull(),
    turnId: uuid("turn_id").notNull().defaultRandom(),
    status: text("status")
      .$type<"active" | "expired" | "completed" | "cancelled">()
      .notNull()
      .default("active"),
    fencingToken: integer("fencing_token").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    requestOwnerToken: uuid("request_owner_token"),
    requestOwnerExpiresAt: timestamp("request_owner_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("enterprise_run_attempts_generation").on(
      table.tenantId,
      table.runId,
      table.generation,
    ),
    uniqueIndex("enterprise_run_attempts_binding").on(
      table.tenantId,
      table.runId,
      table.generation,
      table.id,
    ),
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }).onDelete("cascade"),
    check(
      "enterprise_run_attempts_generation_check",
      sql`${table.generation} > 0 and ${table.fencingToken} > 0`,
    ),
    check(
      "enterprise_run_attempts_request_owner_check",
      sql`(${table.requestOwnerToken} is null and ${table.requestOwnerExpiresAt} is null) or (${table.requestOwnerToken} is not null and ${table.requestOwnerExpiresAt} is not null)`,
    ),
    pgPolicy("enterprise_run_attempts_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: tenantPolicy("enterprise_run_attempts"),
      withCheck: tenantPolicy("enterprise_run_attempts"),
    }),
  ],
).enableRLS();

export const enterpriseModelBudgetReservations = pgTable(
  "enterprise_model_budget_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    runId: uuid("run_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    modelRouteRef: text("model_route_ref").notNull(),
    tokenLimit: integer("token_limit").notNull(),
    isRunCeiling: boolean("is_run_ceiling").notNull().default(false),
    confirmedTokens: integer("confirmed_tokens").notNull().default(0),
    status: text("status")
      .$type<"reserved" | "confirmed" | "released">()
      .notNull()
      .default("reserved"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("enterprise_budget_reservation_idempotency").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    check(
      "enterprise_budget_reservation_tokens_check",
      sql`${table.tokenLimit} > 0 and ${table.confirmedTokens} >= 0 and ${table.confirmedTokens} <= ${table.tokenLimit}`,
    ),
    check(
      "enterprise_budget_reservation_status_check",
      sql`${table.status} in ('reserved', 'confirmed', 'released')`,
    ),
    index("enterprise_budget_reservation_scope_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.status,
    ),
    pgPolicy("enterprise_model_budget_reservations_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: tenantPolicy("enterprise_model_budget_reservations"),
      withCheck: tenantPolicy("enterprise_model_budget_reservations"),
    }),
  ],
).enableRLS();

export const enterpriseModelInvocationCapabilities = pgTable(
  "enterprise_model_invocation_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    runId: uuid("run_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    generation: integer("generation").notNull(),
    modelRouteRef: text("model_route_ref").notNull(),
    modelRequestId: text("model_request_id").notNull(),
    capabilityDigest: text("capability_digest").notNull(),
    capabilityNonce: text("capability_nonce").notNull(),
    maximumTokens: integer("maximum_tokens").notNull(),
    usedTokens: integer("used_tokens").notNull().default(0),
    status: text("status")
      .$type<"reserved" | "consumed" | "confirmed" | "unknown" | "released">()
      .notNull()
      .default("reserved"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("enterprise_model_invocation_request_id").on(
      table.tenantId,
      table.runId,
      table.modelRequestId,
    ),
    uniqueIndex("enterprise_model_invocation_capability_digest").on(
      table.tenantId,
      table.capabilityDigest,
    ),
    foreignKey({
      columns: [table.tenantId, table.runId, table.generation, table.attemptId],
      foreignColumns: [
        enterpriseRunAttempts.tenantId,
        enterpriseRunAttempts.runId,
        enterpriseRunAttempts.generation,
        enterpriseRunAttempts.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    check(
      "enterprise_model_invocation_tokens_check",
      sql`${table.generation} > 0 and ${table.maximumTokens} > 0 and ${table.usedTokens} >= 0 and ${table.usedTokens} <= ${table.maximumTokens}`,
    ),
    check(
      "enterprise_model_invocation_status_check",
      sql`${table.status} in ('reserved', 'consumed', 'confirmed', 'unknown', 'released')`,
    ),
    index("enterprise_model_invocation_run_status_idx").on(
      table.tenantId,
      table.runId,
      table.status,
    ),
    pgPolicy("enterprise_model_invocation_capabilities_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: tenantPolicy("enterprise_model_invocation_capabilities"),
      withCheck: tenantPolicy("enterprise_model_invocation_capabilities"),
    }),
  ],
).enableRLS();

export const enterpriseRunOutbox = pgTable(
  "enterprise_run_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    runId: uuid("run_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    claimId: uuid("claim_id"),
    claimOwnerId: text("claim_owner_id"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }).onDelete("cascade"),
    index("enterprise_run_outbox_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.deliveredAt} is null`),
    check(
      "enterprise_run_outbox_attempts_check",
      sql`${table.deliveryAttempts} >= 0`,
    ),
    check(
      "enterprise_run_outbox_claim_check",
      sql`(${table.claimId} is null and ${table.claimOwnerId} is null and ${table.claimExpiresAt} is null) or (${table.claimId} is not null and ${table.claimOwnerId} is not null and ${table.claimExpiresAt} is not null)`,
    ),
    index("enterprise_run_outbox_claim_idx")
      .on(table.claimExpiresAt, table.createdAt)
      .where(sql`${table.deliveredAt} is null`),
    pgPolicy("enterprise_run_outbox_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: tenantPolicy("enterprise_run_outbox"),
      withCheck: tenantPolicy("enterprise_run_outbox"),
    }),
  ],
).enableRLS();

export const enterpriseRunnerEvents = pgTable(
  "enterprise_runner_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    threadId: text("thread_id").notNull(),
    runId: uuid("run_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    generation: integer("generation").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    eventType: text("event_type").notNull(),
    event: jsonb("event").$type<BaseEvent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("enterprise_runner_events_thread_cursor").on(
      table.tenantId,
      table.threadId,
      table.seq,
    ),
    uniqueIndex("enterprise_runner_events_source_identity").on(
      table.tenantId,
      table.runId,
      table.attemptId,
      table.generation,
      table.sourceEventId,
    ),
    foreignKey({
      name: "enterprise_runner_events_conversations_fk",
      columns: [table.tenantId, table.threadId],
      foreignColumns: [
        enterpriseConversations.tenantId,
        enterpriseConversations.threadId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_runner_events_runs_owner_fk",
      columns: [
        table.tenantId,
        table.runId,
        table.workspaceId,
        table.principalId,
        table.threadId,
      ],
      foreignColumns: [
        enterpriseRuns.tenantId,
        enterpriseRuns.id,
        enterpriseRuns.workspaceId,
        enterpriseRuns.principalId,
        enterpriseRuns.threadId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_runner_events_attempts_fk",
      columns: [table.tenantId, table.runId, table.generation, table.attemptId],
      foreignColumns: [
        enterpriseRunAttempts.tenantId,
        enterpriseRunAttempts.runId,
        enterpriseRunAttempts.generation,
        enterpriseRunAttempts.id,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_runner_events_cursor_check",
      sql`${table.seq} > 0 and ${table.generation} > 0 and ${table.schemaVersion} > 0`,
    ),
    pgPolicy("enterprise_runner_events_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: tenantPolicy("enterprise_runner_events"),
      withCheck: tenantPolicy("enterprise_runner_events"),
    }),
  ],
).enableRLS();

export type EventRow = typeof enterpriseRunnerEvents.$inferSelect;
