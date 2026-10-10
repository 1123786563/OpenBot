/**
 * Enterprise run ledger: threads, the immutable approved release projection, run grants, runs,
 * attempts, commands, steps, capabilities and delegations. Plan 03 §4.1 (runs domain).
 *
 * Every tenant table keys by a composite whose first column is the tenant; no foreign key in this
 * ledger resolves by a bare id, so a cross-tenant reference is rejected by the database (23503),
 * never by application code alone. Money, revisions, sequence numbers, fences and counters are
 * bigint columns that travel as decimal strings at the API boundary — never as JS numbers.
 *
 * The Run↔reservation creation cycle is deliberately NOT expressed here: those two composite
 * foreign keys are DEFERRABLE INITIALLY DEFERRED and belong to the custom RLS migration
 * (enterprise_runs_rls), where a single transaction commits the run and its reservation together.
 * `budget_reservation_id` is still NOT NULL — the cycle settles at commit, not by optionality.
 *
 * Import cycles between this file and ./enterprise-models (delegations → routes; model
 * attempts/calls → runs/attempts/steps) are safe: every cross-file reference lives inside the
 * lazy extras callback, which Drizzle evaluates at introspection time, not at module load.
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
import { enterpriseModelRoutes } from "./enterprise-models";
import {
  enterpriseMemberships,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

const stamp = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const counter = (name: string) => bigint(name, { mode: "bigint" });

export const enterpriseThreads = pgTable(
  "enterprise_threads",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    ownerPrincipalId: text("owner_principal_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.ownerPrincipalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }),
    check(
      "enterprise_thread_status",
      sql`${t.status} in ('active','archived')`,
    ),
  ],
);

export const enterpriseRunReleases = pgTable(
  "enterprise_run_releases",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    resourceId: text("resource_id").notNull(),
    versionDigest: text("version_digest").notNull(),
    runtimeCompatibility: text("runtime_compatibility").notNull(),
    expertVersion: text("expert_version").notNull(),
    /* Non-null per the §4.1 contract (no "?" marker) and the §4.4 CLI union: an approved release
     * always names its resolved route reference and its tool manifest digest (a zero-tool release
     * carries the empty manifest's digest, never NULL). */
    modelRouteRef: text("model_route_ref").notNull(),
    inputLimitBytes: counter("input_limit_bytes").notNull(),
    maxModelCalls: counter("max_model_calls").notNull(),
    maxRunMicros: counter("max_run_micros").notNull(),
    currency: text("currency").notNull(),
    toolManifestDigest: text("tool_manifest_digest").notNull(),
    toolCount: counter("tool_count").notNull(),
    status: text("status").notNull().default("published"),
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.resourceId],
      foreignColumns: [enterpriseResources.tenantId, enterpriseResources.id],
    }),
    check(
      "enterprise_release_status",
      sql`${t.status} in ('published','disabled')`,
    ),
  ],
);

export const enterpriseRunGrants = pgTable(
  "enterprise_run_grants",
  {
    tenantId: text("tenant_id").notNull(),
    releaseId: text("release_id").notNull(),
    principalId: text("principal_id").notNull(),
    action: text("action").notNull(),
    revision: counter("revision").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.releaseId, t.principalId, t.action] }),
    foreignKey({
      columns: [t.tenantId, t.releaseId],
      foreignColumns: [
        enterpriseRunReleases.tenantId,
        enterpriseRunReleases.id,
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
      "enterprise_run_grant_action",
      sql`${t.action} in ('start','cancel_own','resume_own')`,
    ),
  ],
);

export const enterpriseRuns = pgTable(
  "enterprise_runs",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    ownerPrincipalId: text("owner_principal_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    threadId: text("thread_id").notNull(),
    releaseId: text("release_id").notNull(),
    initiatorKind: text("initiator_kind").notNull(),
    delegationRef: text("delegation_ref"),
    requestKey: text("request_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    inputText: text("input_text").notNull(),
    modelRouteRef: text("model_route_ref").notNull(),
    modelGrantRevision: counter("model_grant_revision").notNull(),
    releaseDigest: text("release_digest").notNull(),
    policyRevision: text("policy_revision").notNull(),
    /*
     * Deferred composite FK to enterprise_budget_reservations (tenant_id, id) lives in the custom
     * RLS migration; NOT NULL here so the cycle cannot be dodged by nullability.
     */
    budgetReservationId: text("budget_reservation_id").notNull(),
    status: text("status").notNull(),
    revision: counter("revision").notNull(),
    latestSeq: counter("latest_seq").notNull(),
    currentAttemptId: text("current_attempt_id"),
    currentTurnId: text("current_turn_id"),
    currentFence: counter("current_fence").notNull(),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    waitDeadline: timestamp("wait_deadline", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    pendingApprovalRef: text("pending_approval_ref"),
    checkpointId: text("checkpoint_id"),
    reasonCode: text("reason_code"),
    reconciliationRequired: boolean("reconciliation_required")
      .notNull()
      .default(false),
    inputRevision: counter("input_revision").notNull().default(sql`0`),
    eventLowWatermark: counter("event_low_watermark").notNull().default(sql`0`),
    createdAt: stamp(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.ownerPrincipalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.threadId],
      foreignColumns: [enterpriseThreads.tenantId, enterpriseThreads.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.releaseId],
      foreignColumns: [
        enterpriseRunReleases.tenantId,
        enterpriseRunReleases.id,
      ],
    }),
    uniqueIndex("enterprise_run_request_key").on(
      t.tenantId,
      t.ownerPrincipalId,
      t.requestKey,
    ),
    check(
      "enterprise_run_status",
      sql`${t.status} in ('queued','running','waiting_input','waiting_approval',
        'suspended','cancel_requested','succeeded','failed','cancelled','expired')`,
    ),
    check(
      "enterprise_run_initiator",
      sql`${t.initiatorKind} in ('user','schedule')`,
    ),
  ],
);

export const enterpriseRunAttempts = pgTable(
  "enterprise_run_attempts",
  {
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    id: text("id").notNull(),
    turnId: text("turn_id").notNull(),
    attemptNo: counter("attempt_no").notNull(),
    leaseId: text("lease_id").notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    serviceId: text("service_id").notNull(),
    fencingToken: counter("fencing_token").notNull(),
    status: text("status").notNull(),
    contextDigest: text("context_digest").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    exitedAt: timestamp("exited_at", { withTimezone: true }),
    exitReceiptRef: text("exit_receipt_ref"),
    /* Seal and admission lock share this attempt; counters start at zero. */
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    effectsRevision: counter("effects_revision").notNull().default(sql`0`),
    modelCallsCount: counter("model_calls_count").notNull().default(sql`0`),
    lastSourceOrdinal: counter("last_source_ordinal").notNull().default(sql`0`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.runId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }),
    uniqueIndex("enterprise_attempt_turn").on(t.tenantId, t.runId, t.turnId),
    check(
      "enterprise_attempt_status",
      sql`${t.status} in ('allocated','active','exited','lost')`,
    ),
    check("enterprise_attempt_fence", sql`${t.fencingToken} > 0`),
  ],
);

export const enterpriseRunCommands = pgTable(
  "enterprise_run_commands",
  {
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    commandId: text("command_id").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    kind: text("kind").notNull(),
    resultRevision: counter("result_revision").notNull(),
    resultStatus: text("result_status").notNull(),
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.runId, t.commandId] }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }),
    check(
      "enterprise_command_kind",
      sql`${t.kind} in ('cancel','input','resume')`,
    ),
  ],
);

export const enterpriseRunSteps = pgTable(
  "enterprise_run_steps",
  {
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    id: text("id").notNull(),
    attemptId: text("attempt_id").notNull(),
    stepNo: counter("step_no").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    nextCallOrdinal: counter("next_call_ordinal").notNull(),
    resultRef: text("result_ref"),
    revision: counter("revision").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.runId, t.id] }),
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
    uniqueIndex("enterprise_step_no").on(
      t.tenantId,
      t.runId,
      t.attemptId,
      t.stepNo,
    ),
    check("enterprise_step_kind", sql`${t.kind} in ('model','tool','wait')`),
    check(
      "enterprise_step_status",
      sql`${t.status} in ('allocated','submitted','committed','unknown')`,
    ),
  ],
);

export const enterpriseCapabilities = pgTable(
  "enterprise_capabilities",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    /* Only the hash lands in the database; the capability secret never does. */
    tokenHash: text("token_hash").notNull(),
    serviceId: text("service_id").notNull(),
    audience: text("audience").notNull(),
    envelopeDigest: text("envelope_digest").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    leaseId: text("lease_id").notNull(),
    fencingToken: counter("fencing_token").notNull(),
    logicalCallId: text("logical_call_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: stamp(),
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
    check(
      "enterprise_capability_audience",
      sql`${t.audience} in ('runtime','model','control')`,
    ),
    /*
     * A model-audience capability must bind the logical call it authorises; runtime and control
     * capabilities must not smuggle model access in through the same column.
     */
    check(
      "enterprise_capability_model_call",
      sql`${t.audience} <> 'model' or ${t.logicalCallId} is not null`,
    ),
  ],
);

export const enterpriseRunDelegations = pgTable(
  "enterprise_run_delegations",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    principalId: text("principal_id").notNull(),
    releaseId: text("release_id").notNull(),
    routeId: text("route_id").notNull(),
    maxRunMicros: counter("max_run_micros").notNull(),
    maxRuns: counter("max_runs").notNull(),
    usedRuns: counter("used_runs").notNull().default(sql`0`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revision: counter("revision").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.releaseId],
      foreignColumns: [
        enterpriseRunReleases.tenantId,
        enterpriseRunReleases.id,
      ],
    }),
    foreignKey({
      columns: [t.tenantId, t.routeId],
      foreignColumns: [
        enterpriseModelRoutes.tenantId,
        enterpriseModelRoutes.id,
      ],
    }),
  ],
);
