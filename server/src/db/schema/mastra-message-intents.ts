import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { attachments } from "./core";
import { enterpriseConversations } from "./enterprise-conversations";
import { enterpriseMemberships, enterpriseTenants } from "./enterprise-tenancy";

const tenantScoped = (table: string) =>
  sql`${sql.raw(table)}.tenant_id = nullif(current_setting('app.tenant_id', true), '')`;

export const mastraMessageIntents = pgTable(
  "mastra_message_intents",
  {
    tenantId: text("tenant_id").notNull(),
    threadId: text("thread_id").notNull(),
    clientMessageKey: text("client_message_key").notNull(),
    messageId: text("message_id").notNull(),
    digest: text("digest").notNull(),
    reservedSeq: integer("reserved_seq").notNull(),
    actorId: text("actor_id").notNull(),
    principalId: text("principal_id").notNull(),
    backendVersion: integer("backend_version").notNull(),
    attachmentIds: jsonb("attachment_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    state: text("state")
      .$type<"pending" | "finalized">()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "mastra_message_intents_pk",
      columns: [table.tenantId, table.threadId, table.clientMessageKey],
    }),
    uniqueIndex("mastra_message_intents_message_id").on(
      table.tenantId,
      table.messageId,
    ),
    uniqueIndex("mastra_message_intents_thread_seq").on(
      table.tenantId,
      table.threadId,
      table.reservedSeq,
    ),
    index("mastra_message_intents_pending_idx").on(
      table.tenantId,
      table.state,
      table.updatedAt,
    ),
    foreignKey({
      name: "mastra_message_intents_conversation_fk",
      columns: [table.tenantId, table.threadId],
      foreignColumns: [
        enterpriseConversations.tenantId,
        enterpriseConversations.threadId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "mastra_message_intents_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "mastra_message_intents_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    check("mastra_message_intents_seq_check", sql`${table.reservedSeq} > 0`),
    check(
      "mastra_message_intents_backend_version_check",
      sql`${table.backendVersion} > 0`,
    ),
    check(
      "mastra_message_intents_state_check",
      sql`${table.state} in ('pending', 'finalized')`,
    ),
    pgPolicy("mastra_message_intents_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: tenantScoped("mastra_message_intents"),
      withCheck: tenantScoped("mastra_message_intents"),
    }),
  ],
).enableRLS();

/** A pending intent holds its staged files against withdrawal and sweeping. */
export const mastraMessageIntentAttachments = pgTable(
  "mastra_message_intent_attachments",
  {
    tenantId: text("tenant_id").notNull(),
    threadId: text("thread_id").notNull(),
    clientMessageKey: text("client_message_key").notNull(),
    attachmentId: uuid("attachment_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "mastra_msg_intent_attachments_pk",
      columns: [
        table.tenantId,
        table.threadId,
        table.clientMessageKey,
        table.attachmentId,
      ],
    }),
    foreignKey({
      name: "mastra_msg_intent_attachments_intent_fk",
      columns: [table.tenantId, table.threadId, table.clientMessageKey],
      foreignColumns: [
        mastraMessageIntents.tenantId,
        mastraMessageIntents.threadId,
        mastraMessageIntents.clientMessageKey,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "mastra_msg_intent_attachments_file_fk",
      columns: [table.attachmentId],
      foreignColumns: [attachments.id],
    }),
    pgPolicy("mastra_message_intent_attachments_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: tenantScoped("mastra_message_intent_attachments"),
      withCheck: tenantScoped("mastra_message_intent_attachments"),
    }),
  ],
).enableRLS();
