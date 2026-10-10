import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";
import { jsonb } from "./json";

const scoped = (table: string) =>
  sql`${sql.raw(table)}.tenant_id = nullif(current_setting('app.tenant_id', true), '')`;

export const enterpriseConversations = pgTable(
  "enterprise_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    threadId: text("thread_id").notNull(),
    title: text("title"),
    storageBackend: text("storage_backend")
      .$type<"platform" | "intelligence">()
      .notNull()
      .default("platform"),
    lastSeq: integer("last_seq").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("enterprise_conversations_tenant_thread").on(
      table.tenantId,
      table.threadId,
    ),
    index("enterprise_conversations_owner_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_conversations_backend_check",
      sql`${table.storageBackend} in ('platform', 'intelligence')`,
    ),
    check("enterprise_conversations_seq_check", sql`${table.lastSeq} >= 0`),
    pgPolicy("enterprise_conversations_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: scoped("enterprise_conversations"),
      withCheck: scoped("enterprise_conversations"),
    }),
  ],
).enableRLS();

export const enterpriseMessages = pgTable(
  "enterprise_messages",
  {
    id: uuid("id").notNull().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    threadId: text("thread_id").notNull(),
    seq: integer("seq").notNull(),
    clientMessageKey: text("client_message_key").notNull(),
    digest: text("digest").notNull(),
    role: text("role").notNull().default("user"),
    content: text("content").notNull(),
    attachments: jsonb("attachments").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    uniqueIndex("enterprise_messages_thread_seq").on(
      table.tenantId,
      table.threadId,
      table.seq,
    ),
    uniqueIndex("enterprise_messages_client_key").on(
      table.tenantId,
      table.threadId,
      table.clientMessageKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.threadId],
      foreignColumns: [
        enterpriseConversations.tenantId,
        enterpriseConversations.threadId,
      ],
    }).onDelete("cascade"),
    check("enterprise_messages_seq_check", sql`${table.seq} > 0`),
    check(
      "enterprise_messages_role_check",
      sql`${table.role} in ('user', 'assistant', 'tool')`,
    ),
    pgPolicy("enterprise_messages_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: scoped("enterprise_messages"),
      withCheck: scoped("enterprise_messages"),
    }),
  ],
).enableRLS();

export const enterpriseMessageParts = pgTable(
  "enterprise_message_parts",
  {
    tenantId: text("tenant_id").notNull(),
    messageId: uuid("message_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").notNull(),
    attachmentId: uuid("attachment_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.messageId, table.ordinal] }),
    foreignKey({
      columns: [table.tenantId, table.messageId],
      foreignColumns: [enterpriseMessages.tenantId, enterpriseMessages.id],
    }).onDelete("cascade"),
    check("enterprise_message_parts_ordinal_check", sql`${table.ordinal} >= 0`),
    check(
      "enterprise_message_parts_kind_check",
      sql`${table.kind} in ('text', 'attachment')`,
    ),
    pgPolicy("enterprise_message_parts_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: scoped("enterprise_message_parts"),
      withCheck: scoped("enterprise_message_parts"),
    }),
  ],
).enableRLS();
