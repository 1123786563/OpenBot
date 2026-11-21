import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { z } from "zod";
import type {
  backupSchedule,
  CleanupResult,
  CleanupStep,
  intelligenceLocator,
} from "../../personal-saas/closure-cleanup-contract";
import {
  maxSupportSeconds,
  type SupportResource,
} from "../../personal-saas/support-contract";
import { agentProfiles } from "./coworker";

export type ExecutionCutoff = {
  epoch: number;
  reason:
    | "account_disabled"
    | "account_status_unconfirmed"
    | "workspace_paused"
    | "workspace_closed";
  cutoffAt: number;
};

export type AccountStatus = {
  source: "active" | "disabled" | "ambiguous";
  observedAt: number;
  confirmedAt: number | null;
  epoch: number;
  executionCutoffs?: ExecutionCutoff[];
  disablements: { id: string; effectiveAt: number }[];
};

export const personalSaasAccounts = pgTable(
  "personal_saas_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    issuer: text().notNull(),
    subject: text().notNull(),
    email: text().notNull(),
    status: jsonb("account_status").$type<AccountStatus>(),
  },
  (table) => [unique().on(table.issuer, table.subject)],
);

export const personalSaasSessions = pgTable("personal_saas_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => personalSaasAccounts.id, { onDelete: "cascade" }),
  casdoorAccessToken: text("casdoor_access_token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const personalWorkspaces = pgTable("personal_workspaces", {
  id: uuid().primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .unique()
    .references(() => personalSaasAccounts.id),
});

export const personalWorkspaceDefaultBots = pgTable(
  "personal_workspace_default_bots",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => personalWorkspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .unique()
      .references(() => agentProfiles.agentId),
  },
);

export const personalSaasNativeCodes = pgTable(
  "personal_saas_native_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    client: text().notNull(),
    state: text().notNull(),
    challenge: text().notNull(),
    identity: text().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("personal_saas_native_codes_expiry").on(table.expiresAt)],
);

export const personalWorkspaceIntegrationGrants = pgTable(
  "personal_workspace_integration_grants",
  {
    credentialHash: text("credential_hash").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => personalWorkspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => personalWorkspaceDefaultBots.agentId, {
        onDelete: "cascade",
      }),
    action: text().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index().on(table.agentId),
    index().on(table.workspaceId),
    check(
      "personal_workspace_integration_action_check",
      sql`${table.action} = 'assistant.read'`,
    ),
  ],
);

export const personalSupportRequests = pgTable(
  "personal_support_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => personalWorkspaces.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id").notNull(),
    operatorId: uuid("operator_id").notNull(),
    actorSubject: text("actor_subject").notNull(),
    resources: jsonb().$type<SupportResource[]>().notNull(),
    reason: text().notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index().on(table.workspaceId, table.requestedAt),
    check(
      "personal_support_duration_check",
      sql`${table.durationSeconds} BETWEEN 1 AND ${sql.raw(String(maxSupportSeconds))}`,
    ),
  ],
);

export const personalSupportAccesses = pgTable(
  "personal_support_accesses",
  {
    id: uuid().primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => personalSupportRequests.id, { onDelete: "cascade" }),
    actorSubject: text("actor_subject").notNull(),
    resource: jsonb().$type<SupportResource>().notNull(),
    reason: text().notNull(),
    accessedAt: timestamp("accessed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index().on(table.requestId, table.accessedAt)],
);

export const personalWorkspaceSuspensions = pgTable(
  "personal_workspace_suspensions",
  {
    sequence: serial().primaryKey(),
    id: uuid().notNull().defaultRandom().unique(),
    workspaceId: uuid("workspace_id").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => personalSaasAccounts.id),
    action: text({ enum: ["pause", "resume"] }).notNull(),
    operator: text().notNull(),
    reason: text().notNull(),
    displayReason: text("display_reason"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  },
  (table) => [index().on(table.accountId, table.sequence)],
);

export const personalWorkspaceClosures = pgTable(
  "personal_workspace_closures",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => personalSaasAccounts.id),
    // Preserve the operation after online workspace deletion.
    workspaceId: uuid("workspace_id").notNull().unique(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    cutoffDeadline: timestamp("cutoff_deadline", {
      withTimezone: true,
    }).notNull(),
    computerCutoff: text("computer_cutoff", { enum: ["confirmed", "failed"] }),
    workCutoff: text("work_cutoff", { enum: ["confirmed", "failed"] }),
    cleanup: jsonb()
      .$type<Partial<Record<CleanupStep, CleanupResult>>>()
      .notNull()
      .default({}),
    backupSchedule:
      jsonb("backup_schedule").$type<z.output<typeof backupSchedule>>(),
    retiredIntelligence: jsonb("retired_intelligence").$type<
      z.output<typeof intelligenceLocator>[]
    >(),
  },
  (table) => [index().on(table.accountId)],
);

export const personalIntelligenceRuns = pgTable(
  "personal_intelligence_runs",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => personalSaasAccounts.id),
    threadId: text("thread_id").notNull(),
    runId: text("run_id").notNull(),
    agentId: text("agent_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.threadId, table.runId, table.agentId],
    }),
  ],
);
