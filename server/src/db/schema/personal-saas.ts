import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agentProfiles } from "./coworker";

export type AccountStatus = {
  source: "active" | "disabled" | "ambiguous";
  observedAt: number;
  confirmedAt: number | null;
  epoch: number;
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
