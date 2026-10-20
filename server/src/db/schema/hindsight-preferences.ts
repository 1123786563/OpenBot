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
} from "./enterprise-tenancy";

// Hindsight 05（Issue #382）：通用个人偏好的 OpenBot 权威记录。
//
// 一行 = 本人确认并明确标为通用的一条偏好。Hindsight 只对该行派生的稳定文档身份
// （hindsight_document_id）做命中与排序；Bot 拿到的已确认原文一律从本表重新加载，
// 召回时逐条复核审核状态、启用与遗忘（review_state / enabled / deleted_at），任何
// 一项不符即丢弃该远端命中。同步状态（synced_content_digest / synced_at）只表达
// “上次成功写入远端的内容摘要”，重试队列属 #384。
//
// 归属沿用 MT039 的形状：复合外键全内嵌 tenant_id，一行跨公司引用结构性不可能。
// 标记证据是 marked_generic_at——本人把偏好设为通用这一动作的时间，不因后续编辑
// 改变。
export const genericPersonalPreferences = pgTable(
  "generic_personal_preferences",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    principalId: text("principal_id").notNull(),
    content: text("content").notNull(),
    provenance: text("provenance").notNull(),
    reviewState: text("review_state")
      .$type<"unreviewed" | "confirmed" | "edited">()
      .notNull()
      .default("unreviewed"),
    enabled: boolean("enabled").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** When the person explicitly marked this preference as general; the marking's evidence. */
    markedGenericAt: timestamp("marked_generic_at", { withTimezone: true })
      .notNull(),
    /**
     * The stable document identity this row is indexed under on the Hindsight service. Derived
     * once at confirm and never changed, so an edit replaces the remote document in place
     * (update_mode "replace") instead of leaving a second one behind.
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
      "generic_personal_preference_review_state",
      sql`${table.reviewState} in ('unreviewed', 'confirmed', 'edited')`,
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
    uniqueIndex("generic_personal_preferences_document_idx").on(
      table.tenantId,
      table.hindsightDocumentId,
    ),
    index("generic_personal_preferences_subject_idx").on(
      table.tenantId,
      table.principalId,
    ),
  ],
);
