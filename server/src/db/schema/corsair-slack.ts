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

const owner = () => ({
  workspaceId: text("workspace_id").notNull(),
  registration: text("registration").notNull(),
  personId: text("person_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const slackPilotStates = pgTable("slack_pilot_states", {
  ...owner(),
  stateHash: text("state_hash").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const slackPilotConnections = pgTable(
  "slack_pilot_connections",
  {
    ...owner(),
    id: uuid("id").defaultRandom().primaryKey(),
    subjectScope: text("subject_scope").notNull(),
    userId: text("user_id").notNull(),
    label: text("label").notNull(),
    credential: text("credential").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revision: uuid("revision").notNull(),
    verificationRequiredAt: timestamp("verification_required_at", {
      withTimezone: true,
    }),
  },
  (t) => [
    unique("slack_pilot_stable_subject").on(
      t.workspaceId,
      t.registration,
      t.personId,
      t.subjectScope,
      t.userId,
    ),
    unique("slack_pilot_connection_owner").on(
      t.workspaceId,
      t.registration,
      t.personId,
      t.id,
    ),
  ],
);

export const slackPilotDefaults = pgTable(
  "slack_pilot_defaults",
  {
    ...owner(),
    connectionId: uuid("connection_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.registration, t.personId] }),
    foreignKey({
      name: "slack_pilot_default_owner",
      columns: [t.workspaceId, t.registration, t.personId, t.connectionId],
      foreignColumns: [
        slackPilotConnections.workspaceId,
        slackPilotConnections.registration,
        slackPilotConnections.personId,
        slackPilotConnections.id,
      ],
    }).onDelete("cascade"),
  ],
);

export const slackPilotGrants = pgTable(
  "slack_pilot_grants",
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
