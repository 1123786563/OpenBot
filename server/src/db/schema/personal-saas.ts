import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agentProfiles } from "./coworker";

export const personalSaasAccounts = pgTable(
  "personal_saas_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    issuer: text().notNull(),
    subject: text().notNull(),
    email: text().notNull(),
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
