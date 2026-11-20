import {
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

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
