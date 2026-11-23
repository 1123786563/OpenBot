import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { SharedUseApproval } from "../../plugins/shared-use";
import { agents, users } from "./core";
import { jsonb } from "./json";
import { responsibilities, responsibilityRuns } from "./responsibilities";

const time = (name: string) => timestamp(name, { withTimezone: true });
const timestamps = () => ({
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
});
const id = () => text("id").primaryKey().default(sql`gen_random_uuid()::text`);
const scope = () => ({
  workspaceId: text("workspace_id"),
  registration: text("registration"),
});
const person = () =>
  text("person_id").references(() => users.id, { onDelete: "cascade" });

export const corsairIntegrations = pgTable("corsair_integrations", {
  id: id(),
  ...timestamps(),
  name: text("name").notNull(),
  config: jsonb("config").notNull().default({}),
  dek: text("dek"),
});

export const corsairAccounts = pgTable(
  "corsair_accounts",
  {
    id: id(),
    ...timestamps(),
    tenantId: text("tenant_id").notNull(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => corsairIntegrations.id),
    config: jsonb("config").notNull().default({}),
    dek: text("dek"),
    ...scope(),
    kind: text("openbot_kind").$type<
      "github-personal" | "slack-personal" | "slack-shared" | "registration"
    >(),
    personId: person(),
    subjectScope: text("subject_scope"),
    userId: text("external_user_id"),
    label: text("label"),
    credential: text("credential"),
    revision: uuid("revision").defaultRandom(),
    expiresAt: time("expires_at"),
    verificationRequiredAt: time("verification_required_at"),
    sharedWorkspaceId: text("shared_workspace_id"),
    appId: text("app_id"),
    teamId: text("team_id"),
    botId: text("bot_id"),
    botUserId: text("bot_user_id"),
    channelIds: text("channel_ids").array(),
  },
  (t) => [
    unique("corsair_account_personal_subject").on(
      t.kind,
      t.workspaceId,
      t.registration,
      t.personId,
      t.subjectScope,
      t.userId,
    ),
    unique("corsair_account_owner").on(
      t.kind,
      t.workspaceId,
      t.registration,
      t.personId,
      t.id,
    ),
    unique("corsair_account_shared_workspace").on(t.sharedWorkspaceId),
    unique("corsair_account_id_kind").on(t.id, t.kind),
    index("corsair_accounts_tenant_integration_idx").on(
      t.tenantId,
      t.integrationId,
    ),
    check(
      "corsair_accounts_openbot_shape",
      sql`
    case ${t.kind}
      when 'github-personal' then ${t.subjectScope} = '' and ${t.subjectScope} is not null
        and ${t.personId} is not null and ${t.workspaceId} is not null and ${t.registration} is not null
        and ${t.userId} is not null and ${t.label} is not null and ${t.credential} is not null
        and ${t.revision} is not null and ${t.expiresAt} is not null
      when 'slack-personal' then ${t.subjectScope} is not null and ${t.subjectScope} <> ''
        and ${t.personId} is not null and ${t.workspaceId} is not null and ${t.registration} is not null
        and ${t.userId} is not null and ${t.label} is not null and ${t.credential} is not null
        and ${t.revision} is not null and ${t.expiresAt} is not null
      when 'slack-shared' then ${t.sharedWorkspaceId} is not null and ${t.appId} is not null
        and ${t.teamId} is not null and ${t.botId} is not null and ${t.botUserId} is not null
        and cardinality(${t.channelIds}) > 0 and ${t.channelIds} is not null
      when 'registration' then ${t.workspaceId} is not null and ${t.registration} is not null
      else ${t.kind} is null
    end`,
    ),
  ],
);

export const corsairEntities = pgTable(
  "corsair_entities",
  {
    id: id(),
    ...timestamps(),
    accountId: text("account_id")
      .notNull()
      .references(() => corsairAccounts.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull(),
    entityType: text("entity_type").notNull(),
    version: text("version").notNull(),
    data: jsonb("data").notNull().default({}),
    ...scope(),
    installationId: text("installation_id"),
    repositoryId: text("repository_id"),
    nodeId: text("node_id"),
    name: text("name"),
    goalId: text("goal_id").references(() => responsibilities.id, {
      onDelete: "cascade",
    }),
    connectionId: uuid("connection_id"),
    connectionRevision: uuid("connection_revision"),
    repositoryNodeId: text("repository_node_id"),
    eventTypes: text("event_types").array(),
    disabledAt: time("disabled_at"),
  },
  (t) => [
    unique("corsair_entities_account_type_entity").on(
      t.accountId,
      t.entityType,
      t.entityId,
    ),
    unique("corsair_entities_repository_scope").on(
      t.workspaceId,
      t.registration,
      t.entityId,
      t.entityType,
    ),
    index("corsair_entities_source_idx").on(
      t.workspaceId,
      t.registration,
      t.installationId,
      t.repositoryId,
    ),
    index("corsair_entities_goal_idx").on(t.goalId),
  ],
);

export const corsairEvents = pgTable(
  "corsair_events",
  {
    id: id(),
    ...timestamps(),
    accountId: text("account_id")
      .notNull()
      .references(() => corsairAccounts.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "processing" | "completed" | "failed">(),
    ...scope(),
    deliveryId: text("delivery_id"),
    bodyHash: text("body_hash"),
    installationId: text("installation_id"),
    repositoryId: text("repository_id"),
    pilotDispatch: boolean("pilot_dispatch"),
    occurredAt: time("occurred_at"),
    disposition: text("disposition").$type<
      "planned" | "observed" | "unenrolled" | "review"
    >(),
    fanoutAt: time("fanout_at"),
  },
  (t) => [
    unique("corsair_events_delivery").on(
      t.workspaceId,
      t.registration,
      t.deliveryId,
    ),
    unique("corsair_events_body").on(t.workspaceId, t.registration, t.bodyHash),
    index("corsair_events_account_type_created_idx").on(
      t.accountId,
      t.eventType,
      t.createdAt,
    ),
    index("corsair_events_pending_idx")
      .on(t.workspaceId, t.registration, t.createdAt)
      .where(sql`${t.deliveryId} is not null and ${t.fanoutAt} is null`),
    check(
      "corsair_events_status",
      sql`${t.status} in ('pending', 'processing', 'completed', 'failed')`,
    ),
    check(
      "corsair_events_delivery_shape",
      sql`${t.deliveryId} is null or (
    ${t.workspaceId} is not null and ${t.registration} is not null and ${t.bodyHash} is not null and ${t.pilotDispatch} is not null
  )`,
    ),
  ],
);

export const corsairPermissions = pgTable(
  "corsair_permissions",
  {
    id: id(),
    ...timestamps(),
    token: text("token").notNull(),
    plugin: text("plugin").notNull(),
    endpoint: text("endpoint").notNull(),
    args: text("args").notNull(),
    tenantId: text("tenant_id").notNull().default("default"),
    status: text("status").notNull().default("pending"),
    expiresAt: text("expires_at").notNull(),
    error: text("error"),
  },
  (t) => [
    check(
      "corsair_permissions_status",
      sql`${t.status} in ('pending', 'approved', 'executing', 'completed', 'denied', 'expired', 'failed')`,
    ),
    index("corsair_permissions_token_idx").on(t.token),
  ],
);

export const corsairOauthStates = pgTable(
  "corsair_oauth_states",
  {
    stateHash: text("state_hash").notNull(),
    provider: text("provider").$type<"github" | "slack">().notNull(),
    workspaceId: text("workspace_id").notNull(),
    registration: text("registration").notNull(),
    personId: person().notNull(),
    verifier: text("verifier"),
    expiresAt: time("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.stateHash] }),
    check(
      "corsair_oauth_states_provider",
      sql`(${t.provider} = 'github' and ${t.verifier} is not null) or (${t.provider} = 'slack' and ${t.verifier} is null)`,
    ),
  ],
);

export const corsairAccountDefaults = pgTable(
  "corsair_account_defaults",
  {
    kind: text("openbot_kind")
      .$type<"github-personal" | "slack-personal">()
      .notNull(),
    workspaceId: text("workspace_id").notNull(),
    registration: text("registration").notNull(),
    personId: person().notNull(),
    githubUserId: text("github_user_id"),
    githubSubjectScope: text("github_subject_scope"),
    connectionId: text("connection_id"),
  },
  (t) => [
    primaryKey({
      columns: [t.kind, t.workspaceId, t.personId, t.registration],
    }),
    foreignKey({
      name: "corsair_defaults_github_subject_fk",
      columns: [
        t.kind,
        t.workspaceId,
        t.registration,
        t.personId,
        t.githubSubjectScope,
        t.githubUserId,
      ],
      foreignColumns: [
        corsairAccounts.kind,
        corsairAccounts.workspaceId,
        corsairAccounts.registration,
        corsairAccounts.personId,
        corsairAccounts.subjectScope,
        corsairAccounts.userId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "corsair_defaults_account_owner_fk",
      columns: [
        t.kind,
        t.workspaceId,
        t.registration,
        t.personId,
        t.connectionId,
      ],
      foreignColumns: [
        corsairAccounts.kind,
        corsairAccounts.workspaceId,
        corsairAccounts.registration,
        corsairAccounts.personId,
        corsairAccounts.id,
      ],
    }).onDelete("cascade"),
    check(
      "corsair_defaults_shape",
      sql`(${t.kind} = 'github-personal' and ${t.githubUserId} is not null and ${t.githubSubjectScope} is not null and ${t.githubSubjectScope} = '' and ${t.connectionId} is null) or
    (${t.kind} = 'slack-personal' and ${t.githubUserId} is null and ${t.githubSubjectScope} is null and ${t.connectionId} is not null)`,
    ),
  ],
);

export const corsairSharedAccess = pgTable(
  "corsair_shared_access",
  {
    installationId: text("installation_id").notNull(),
    kind: text("openbot_kind").notNull().default("slack-shared"),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    granted: boolean("granted").notNull().default(false),
    approval: jsonb("approval").$type<SharedUseApproval>(),
  },
  (t) => [
    primaryKey({ columns: [t.installationId, t.botId] }),
    foreignKey({
      name: "corsair_shared_access_account_fk",
      columns: [t.installationId, t.kind],
      foreignColumns: [corsairAccounts.id, corsairAccounts.kind],
    }).onDelete("cascade"),
    check("corsair_shared_access_kind", sql`${t.kind} = 'slack-shared'`),
  ],
);

export const corsairEventDispatches = pgTable(
  "corsair_event_dispatches",
  {
    receiptId: text("receipt_id")
      .notNull()
      .references(() => corsairEvents.id, { onDelete: "cascade" }),
    triggerId: text("trigger_id").notNull(),
    outcome: text("outcome")
      .$type<
        "pending" | "retry" | "queued" | "denied" | "ineligible" | "review"
      >()
      .notNull(),
    nextAttemptAt: time("next_attempt_at").defaultNow().notNull(),
    runId: text("run_id").references(() => responsibilityRuns.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    primaryKey({ columns: [t.receiptId, t.triggerId] }),
    unique().on(t.runId),
    index("corsair_event_dispatches_pending_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.outcome} in ('pending', 'retry')`),
  ],
);
