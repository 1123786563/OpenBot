// server/src/kb/db/ownership-schema.ts
// MT036（Issue #79）：知识库跨库归属的 KB 侧镜像状态表。
//
// 主库与 KB 库是两个独立数据库，不假装跨库外键：归属的一致性由「调用时
// 授权（主库权威）+ 同步版本令牌逐次比对」保证。本表是 KB 侧必须镜像的
// 归属快照（knowledge_base_ownership_states）：一行 = 一个知识库的归属与
// 同步版本。主库注册（enterprise_resources kind='knowledge'）是权威侧；
// 镜像行缺失、租户/团队不符或 sync_version 落后（归属迁移或版本推进后未
// 同步）都会在受限查询入口被拒绝——缺失或不一致时拒绝而不是放行。
//
// expand-only：不改 knowledge_bases 既有列；迁移经 drizzle-kb journal
// （0001_*）由运行时迁移器（src/kb/db/migrate.ts）幂等应用。

import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { knowledgeBases } from "./schema";

export const knowledgeBaseOwnershipStates = pgTable(
  "knowledge_base_ownership_states",
  {
    /** KB 库内容行的主键引用（同一行只有一个归属镜像）。 */
    knowledgeBaseId: varchar("knowledge_base_id", { length: 36 })
      .primaryKey()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    workspaceId: varchar("workspace_id", { length: 64 }).notNull(),
    /** 主库 kbSyncVersionOf(registration) 的逐字镜像（落后即拒绝）。 */
    syncVersion: text("sync_version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 镜像行完整性兜底：归属列与版本令牌都不允许空/占位值。
    check(
      "kb_ownership_state_shape",
      sql`${table.tenantId} <> '' and ${table.workspaceId} <> '' and ${table.syncVersion} <> ''`,
    ),
    index("idx_kb_ownership_states_tenant_ws").on(
      table.tenantId,
      table.workspaceId,
    ),
  ],
);
