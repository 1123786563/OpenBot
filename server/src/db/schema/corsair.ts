import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { jsonb } from "./json";
import { responsibilities, responsibilityRuns } from "./responsibilities";

export const githubPilotStates = pgTable("github_pilot_states", {
  stateHash: text("state_hash").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  personId: text("person_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  registration: text("registration").notNull(),
  verifier: text("verifier").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const githubPilotConnections = pgTable(
  "github_pilot_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    personId: text("person_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    registration: text("registration").notNull(),
    githubUserId: text("github_user_id").notNull(),
    login: text("login").notNull(),
    credential: text("credential").notNull(),
    revision: uuid("revision").defaultRandom().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique().on(t.workspaceId, t.personId, t.registration, t.githubUserId),
  ],
);

export const githubPilotDefaults = pgTable(
  "github_pilot_defaults",
  {
    workspaceId: text("workspace_id").notNull(),
    personId: text("person_id").notNull(),
    registration: text("registration").notNull(),
    githubUserId: text("github_user_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.personId, t.registration] }),
    foreignKey({
      name: "github_pilot_defaults_connection_fk",
      columns: [t.workspaceId, t.personId, t.registration, t.githubUserId],
      foreignColumns: [
        githubPilotConnections.workspaceId,
        githubPilotConnections.personId,
        githubPilotConnections.registration,
        githubPilotConnections.githubUserId,
      ],
    }).onDelete("cascade"),
  ],
);

export const githubPilotRepositories = pgTable(
  "github_pilot_repositories",
  {
    workspaceId: text("workspace_id").notNull(),
    registration: text("registration").notNull(),
    repositoryId: text("repository_id").notNull(),
    installationId: text("installation_id").notNull(),
    nodeId: text("node_id").notNull(),
    name: text("name").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.registration, t.repositoryId] }),
  ],
);

export const githubPilotGrants = pgTable(
  "github_pilot_grants",
  {
    workspaceId: text("workspace_id").notNull(),
    registration: text("registration").notNull(),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolRef: text("tool_ref").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.workspaceId, t.registration, t.botId, t.toolRef],
    }),
  ],
);

export const githubPilotEventReceipts = pgTable(
  "github_pilot_event_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    registration: text("registration").notNull(),
    deliveryId: text("delivery_id").notNull(),
    bodyHash: text("body_hash").notNull(),
    eventType: text("event_type").notNull(),
    installationId: text("installation_id"),
    repositoryId: text("repository_id"),
    pilotDispatch: boolean("pilot_dispatch").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    disposition: text("disposition").$type<
      "planned" | "observed" | "unenrolled" | "review"
    >(),
    fanoutAt: timestamp("fanout_at", { withTimezone: true }),
  },
  (t) => [
    unique().on(t.workspaceId, t.registration, t.deliveryId),
    unique().on(t.workspaceId, t.registration, t.bodyHash),
    index("github_pilot_receipts_pending_idx")
      .on(t.workspaceId, t.registration, t.receivedAt)
      .where(sql`${t.fanoutAt} is null`),
  ],
);

export const githubPilotEventTriggers = pgTable(
  "github_pilot_event_triggers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    registration: text("registration").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => responsibilities.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    connectionRevision: uuid("connection_revision").notNull(),
    installationId: text("installation_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    repositoryNodeId: text("repository_node_id").notNull(),
    eventTypes: text("event_types").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (t) => [
    index("github_pilot_event_triggers_source_idx").on(
      t.workspaceId,
      t.registration,
      t.installationId,
      t.repositoryId,
    ),
    index("github_pilot_event_triggers_goal_idx").on(t.goalId),
  ],
);

export const githubPilotEventOutcomes = pgTable(
  "github_pilot_event_outcomes",
  {
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => githubPilotEventReceipts.id, { onDelete: "cascade" }),
    triggerId: uuid("trigger_id").notNull(),
    outcome: text("outcome")
      .$type<
        "pending" | "retry" | "queued" | "denied" | "ineligible" | "review"
      >()
      .notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    runId: text("run_id").references(() => responsibilityRuns.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    primaryKey({ columns: [t.receiptId, t.triggerId] }),
    unique().on(t.runId),
    index("github_pilot_event_outcomes_pending_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.outcome} in ('pending', 'retry')`),
  ],
);
