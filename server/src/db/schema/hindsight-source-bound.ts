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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

// Hindsight 06（Issue #383）：来源受限个人记忆的 OpenBot 权威记录与授权登记。
//
// source_bound_memories 一行 = 本人从团队对话或连接来源确认的一条业务事实，可见性
// 仍然受其形成范围约束（本人确认不改变该限制，CONTEXT.md「来源受限记忆」）。召回
// seam 按当前授权快照选择 bank（团队/来源/Bot 各自的派生 bank），远端命中后逐行
// 复核本表与最新授权——来源停用、成员资格变化、Bot 失去应用权限在**下一次**召回
// 立即排除；撤权发生在命中与加载之间同样被挡住。tombstone 语义与
// generic_personal_preferences 一致（deleted_at + enabled + 内容清空）。
//
// hindsight_memory_grants 登记两项既有租户表没有的授权状态：连接来源是否仍启用、
// Bot 是否仍持有应用权限；团队授权不在登记表里，召回现读
// enterprise_workspace_memberships。归属键复合外键全内嵌 tenant_id。
export const sourceBoundMemories = pgTable(
  "source_bound_memories",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    principalId: text("principal_id").notNull(),
    /** Which restriction carves this memory's bank: the forming team, source, or Bot. */
    restriction: text("restriction")
      .$type<"team" | "source" | "bot">()
      .notNull(),
    workspaceId: text("workspace_id"),
    sourceId: text("source_id"),
    agentId: text("agent_id"),
    content: text("content").notNull(),
    provenance: text("provenance").notNull(),
    reviewState: text("review_state")
      .$type<"unreviewed" | "confirmed" | "edited">()
      .notNull()
      .default("unreviewed"),
    enabled: boolean("enabled").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** When the fact was formed — the provenance evidence a recalled view carries. */
    formedAt: timestamp("formed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * The stable document identity this row is indexed under on the Hindsight service, derived
     * once at confirm (hsb_ prefix) into the RESTRICTED bank — never the user bank, so a
     * source-bound fact can never surface through the general-preference recall.
     */
    hindsightDocumentId: text("hindsight_document_id").notNull(),
    /** sha256 of the content last successfully retained; null means the row awaits its first sync. */
    syncedContentDigest: text("synced_content_digest"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    check(
      "source_bound_memory_restriction",
      sql`${table.restriction} in ('team', 'source', 'bot')`,
    ),
    check(
      "source_bound_memory_review_state",
      sql`${table.reviewState} in ('unreviewed', 'confirmed', 'edited')`,
    ),
    check(
      "source_bound_memory_target_shape",
      sql`((${table.restriction} = 'team') = (${table.workspaceId} is not null)) and ((${table.restriction} = 'source') = (${table.sourceId} is not null)) and ((${table.restriction} = 'bot') = (${table.agentId} is not null))`,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }),
    uniqueIndex("source_bound_memories_document_idx").on(
      table.tenantId,
      table.hindsightDocumentId,
    ),
    index("source_bound_memories_subject_idx").on(
      table.tenantId,
      table.principalId,
    ),
    index("source_bound_memories_restriction_idx").on(
      table.tenantId,
      table.principalId,
      table.restriction,
    ),
  ],
);

/** A revocable authorization in the personal-memory scope: a connected source, or a Bot's app. */
export const hindsightMemoryGrants = pgTable(
  "hindsight_memory_grants",
  {
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    kind: text("kind").$type<"source" | "bot">().notNull(),
    targetId: text("target_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.principalId, table.kind, table.targetId],
    }),
    check("hindsight_memory_grant_kind", sql`${table.kind} in ('source', 'bot')`),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
  ],
);
