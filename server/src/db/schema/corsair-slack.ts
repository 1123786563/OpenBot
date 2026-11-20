import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Automatically writable PostgreSQL views from migration 0094.
const time = (name: string) => timestamp(name, { withTimezone: true });
const owner = () => ({
  workspaceId: text("workspace_id").notNull(),
  registration: text("registration").notNull(),
  personId: text("person_id").notNull(),
});

export const slackPilotStates = pgTable("corsair_slack_oauth_states", {
  ...owner(),
  stateHash: text("state_hash").notNull(),
  expiresAt: time("expires_at").notNull(),
});

export const slackPilotConnections = pgTable("corsair_slack_connections", {
  ...owner(),
  storageKind: text("openbot_kind").default("slack-personal").notNull(),
  id: text("id").default(sql`gen_random_uuid()::text`).notNull(),
  subjectScope: text("subject_scope").notNull(),
  userId: text("user_id").notNull(),
  label: text("label").notNull(),
  credential: text("credential").notNull(),
  expiresAt: time("expires_at").notNull(),
  revision: uuid("revision").notNull(),
  verificationRequiredAt: time("verification_required_at"),
});

export const slackPilotDefaults = pgTable("corsair_slack_defaults", {
  ...owner(),
  storageKind: text("openbot_kind").default("slack-personal").notNull(),
  connectionId: text("connection_id").notNull(),
});

export const slackSharedInstallations = pgTable("corsair_slack_installations", {
  workspaceId: text("workspace_id").notNull(),
  id: text("id").default(sql`gen_random_uuid()::text`).notNull(),
  appId: text("app_id").notNull(),
  teamId: text("team_id").notNull(),
  botId: text("bot_id").notNull(),
  botUserId: text("bot_user_id").notNull(),
  channelIds: text("channel_ids").array().notNull(),
});

export { corsairSharedAccess as slackSharedBotAccess } from "./corsair-storage";
