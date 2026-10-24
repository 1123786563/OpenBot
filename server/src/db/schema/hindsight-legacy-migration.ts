import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { enterpriseMemberships, enterpriseTenants } from "./enterprise-tenancy";

// Hindsight 16（Issue #394）：历史已确认 OpenBot 记忆迁移的持久状态。
//
// 三张表构成一次可恢复、可对账的迁移：
//
// hindsight_migration_map：old_record_id 全局唯一 → 新主体的确定性映射。新行 id 直接
// 沿用旧 id（个人旧表 id 全局唯一，新表按 (tenant, id) 主键，无碰撞），本表再记下主体
// 类型与 run，使重跑与对账都能按存储层事实回答"这条旧记录去哪了"。重复迁移在
// 存储层折叠：同 old id 再来一次命中本表唯一键，不产生第二条活跃内容。
//
// hindsight_migration_quarantine：受控隔离清单。公司归属不可证明的旧记录（该用户无
// principal、无 active membership、或同时属于多家公司）各记一行；权限形状不可在新域
// 复现的旧记录同样各记一行（bot 行缺 agent id、import 行缺 source id、formed_by 取值
// 在三种映射形状之外、bot 行带 source_ref 收窄——旧侧「形成它的 Bot 仍持有来源应用才
// 可召回」的子句在新域没有承载列）。只存 old id、owner 与原因，不复制任何内容文本；
// 绝不以全局用户 ID 猜测租户，也绝不静默改类放宽可见面。
//
// hindsight_migration_runs：一次迁移的游标与计数。每处理一条旧记录即推进
// cursor_old_id 并刷新计数（持久断点），失败中断后从游标继续，不重复活跃内容。
export const hindsightMigrationMap = pgTable(
  "hindsight_migration_map",
  {
    /** The old personal_memories row's id — globally unique, the migration's unit of work. */
    oldRecordId: text("old_record_id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    /** Which new authority table the record landed in. */
    subjectType: text("subject_type")
      .$type<"preference" | "source_bound">()
      .notNull(),
    /** The new record id — identical to the old id, by design. */
    newRecordId: text("new_record_id").notNull(),
    runId: text("run_id").notNull(),
    migratedAt: timestamp("migrated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "hindsight_migration_map_subject_type",
      sql`${table.subjectType} in ('preference', 'source_bound')`,
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
    index("hindsight_migration_map_tenant_idx").on(
      table.tenantId,
      table.principalId,
    ),
  ],
);

export const hindsightMigrationQuarantine = pgTable(
  "hindsight_migration_quarantine",
  {
    /** One quarantine row per old record: a re-scan refreshes, never duplicates. */
    oldRecordId: text("old_record_id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    /** Why attribution could not be proven — the reason, never the content. */
    reason: text("reason")
      .$type<
        | "no-principal"
        | "no-active-membership"
        | "ambiguous-company"
        | "unmappable-permission-shape"
        | "source-ref-narrowing"
      >()
      .notNull(),
    /** When the row was quarantined; a later re-scan refreshes, never duplicates. */
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    runId: text("run_id").notNull(),
  },
  (table) => [
    check(
      "hindsight_migration_quarantine_reason",
      sql`${table.reason} in ('no-principal', 'no-active-membership', 'ambiguous-company', 'unmappable-permission-shape', 'source-ref-narrowing')`,
    ),
    index("hindsight_migration_quarantine_owner_idx").on(table.ownerUserId),
  ],
);

export const hindsightMigrationRuns = pgTable(
  "hindsight_migration_runs",
  {
    id: text("id").primaryKey(),
    state: text("state")
      .$type<"running" | "succeeded" | "failed">()
      .notNull()
      .default("running"),
    /** The last old_record_id durably processed; resume starts strictly after it. */
    cursorOldId: text("cursor_old_id"),
    /** Progress counters, refreshed as the run advances — the resume's reconciliation base. */
    processed: integer("processed").notNull().default(0),
    migrated: integer("migrated").notNull().default(0),
    skippedPendingReview: integer("skipped_pending_review")
      .notNull()
      .default(0),
    skippedInactive: integer("skipped_inactive").notNull().default(0),
    quarantined: integer("quarantined").notNull().default(0),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "hindsight_migration_run_state",
      sql`${table.state} in ('running', 'succeeded', 'failed')`,
    ),
  ],
);
