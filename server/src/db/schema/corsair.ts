import { sql } from "drizzle-orm";
import {
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";

// These are automatically writable PostgreSQL views from migration 0094.
// Drizzle's pgView API only supports reads. drizzle-kit tracks their base tables.
const time = (name: string) => timestamp(name, { withTimezone: true });
const scope = () => ({
  workspaceId: text("workspace_id").notNull(),
  registration: text("registration").notNull(),
});
const owner = () => ({ ...scope(), personId: text("person_id").notNull() });

export const githubPilotStates = pgTable("corsair_github_oauth_states", {
  ...owner(),
  stateHash: text("state_hash").notNull(),
  verifier: text("verifier").notNull(),
  expiresAt: time("expires_at").notNull(),
});

export const githubPilotConnections = pgTable("corsair_github_connections", {
  ...owner(),
  id: text("id").default(sql`gen_random_uuid()::text`).notNull(),
  storageKind: text("openbot_kind").default("github-personal").notNull(),
  subjectScope: text("subject_scope").default("").notNull(),
  githubUserId: text("github_user_id").notNull(),
  login: text("login").notNull(),
  credential: text("credential").notNull(),
  revision: uuid("revision").defaultRandom().notNull(),
  expiresAt: time("expires_at").notNull(),
});

export const githubPilotDefaults = pgTable("corsair_github_defaults", {
  ...owner(),
  storageKind: text("openbot_kind").default("github-personal").notNull(),
  githubUserId: text("github_user_id").notNull(),
});

export const githubPilotRepositories = pgTable("corsair_github_repositories", {
  ...scope(),
  repositoryId: text("repository_id").notNull(),
  entityType: text("entity_type")
    .default("openbot.github.repository")
    .notNull(),
  installationId: text("installation_id").notNull(),
  nodeId: text("node_id").notNull(),
  name: text("name").notNull(),
});

export const githubPilotEventReceipts = pgTable(
  "corsair_github_event_receipts",
  {
    ...scope(),
    id: text("id").default(sql`gen_random_uuid()::text`).notNull(),
    deliveryId: text("delivery_id").notNull(),
    bodyHash: text("body_hash").notNull(),
    eventType: text("event_type").notNull(),
    installationId: text("installation_id"),
    repositoryId: text("repository_id"),
    pilotDispatch: boolean("pilot_dispatch").notNull(),
    occurredAt: time("occurred_at"),
    payload: jsonb("payload").notNull(),
    receivedAt: time("received_at").defaultNow().notNull(),
    disposition: text("disposition").$type<
      "planned" | "observed" | "unenrolled" | "review"
    >(),
    fanoutAt: time("fanout_at"),
  },
);

export const githubPilotEventTriggers = pgTable(
  "corsair_github_event_triggers",
  {
    ...scope(),
    id: text("id").default(sql`gen_random_uuid()::text`).notNull(),
    goalId: text("goal_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    connectionRevision: uuid("connection_revision").notNull(),
    installationId: text("installation_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    repositoryNodeId: text("repository_node_id").notNull(),
    eventTypes: text("event_types").array().notNull(),
    createdAt: time("created_at").defaultNow().notNull(),
    disabledAt: time("disabled_at"),
  },
);

export { corsairEventDispatches as githubPilotEventOutcomes } from "./corsair-storage";

/*
 * An app-level connection from the integration catalog. One row per workspace per catalog app,
 * recorded when a person presses Connect; the app's own credentials are a later, separate step.
 */
export const corsairIntegrationConnections = pgTable(
  "corsair_integration_connections",
  {
    workspaceId: text("workspace_id").notNull(),
    integrationId: text("integration_id").notNull(),
    personId: text("person_id").notNull(),
    connectedAt: time("connected_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.integrationId] }),
  ],
);
