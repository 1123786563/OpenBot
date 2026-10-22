import {
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { enterpriseMemberships, enterpriseTenants } from "./enterprise-tenancy";

// Hindsight 14（Issue #392）：暂停学习与暂停使用，两个状态分离保存。
//
// 一行 = 一个 (tenant, principal) 的两盏开关：learning_paused_at / usage_paused_at 各自
// 为 null（未暂停）或暂停生效时刻。分离保存是本票的第一条验收：恢复任一控制只把对应
// 时刻清空，不触碰另一盏开关，也不产生任何确认候选或授权扩大的副作用。
//
// 语义边界（CONTEXT.md「个人记忆」/ 父 Spec #376 规则 6）：
//   - 暂停学习挡的是"自动提出候选"——候选生成 seam（派生判断提案）入口拒绝；本人明确
//     操作的确认、审核、更正、遗忘不受影响；
//   - 暂停使用挡的是"已确认内容的召回"——三个召回 seam（通用偏好/来源受限/派生判断）
//     入口先于任何远端调用直接答空，因此 Hindsight 宕机时的 SQL 降级路径同被覆盖
//     （降级入口只有经 seam 抛出不可用才会走到）；不删除任何记录；
//   - 两盏开关只作用于各自 seam，互不代劳。
export const hindsightPauseControls = pgTable(
  "hindsight_pause_controls",
  {
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    /** Non-null = learning paused since this instant; null = learning active. */
    learningPausedAt: timestamp("learning_paused_at", { withTimezone: true }),
    /** Non-null = usage paused since this instant; null = usage active. */
    usagePausedAt: timestamp("usage_paused_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.principalId] }),
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
