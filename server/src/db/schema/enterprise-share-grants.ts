import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import {
  enterpriseMemberships,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";
import { workshopSessions } from "./workshop";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// MT058（Issue #101）：Workshop 分享令牌改为有效分享授权表。expand-only
// ——一张新表，不修改任何既有表/策略/授权（MT053 同型判例）。
//
// enterprise_workshop_share_grants：一行 = 一次有效分享授权。与既有
// workshop_sessions.share_token_hash（B14 匿名承载段）的根本区别：受众、
// 动作域与有效期是行本体的一部分，不再是「持有令牌即任何人」。
//
//   - token_hash 存 sha256(plaintext)（B14 纪律：拖库造不出链接；明文
//     只在签发时存在一次），UNIQUE——解析走 token_hash 索引。
//   - 受众闭集：'same-team'（默认，audience_workspace_id 必空）与
//     'cross-team'（同公司显式跨团队，audience_workspace_id 必填）。
//     复合外键 (tenant_id, audience_workspace_id) → enterprise_workspaces
//     把「跨公司受众行」在数据库层结构性排除（MT010 复合外键同纪律）。
//   - 动作域闭集 share_action ∈ {preview, preview_download}（消费既有
//     WorkshopShareScope 词表——分享的动作面，签发面拒绝闭集外动作）。
//   - 一会话至多一条活链：partial unique index（revoked_at IS NULL）——
//     与既有 workshop_sessions 的单活链约束同语义，替换 = 撤旧 + 插新。
//   - 撤销不是删除（可审计）：operator 列级 UPDATE 只有 (revoked_at,
//     revoked_by)（0178 列级 GRANT 同纪律）；归属列零 UPDATE。
//
// RLS：data 角色租户臂 + restrictive 签发者自读（本人的分享自己管理）；
// operator 租户臂读（解析入口：请求者带身份与租户上下文进入，受众判定
// 在服务层经成员资格现读）+ 插入 + 列级撤销 UPDATE。目录角色无任何策略。

/** 受众闭集（same-team 默认 / cross-team 显式同公司跨团队）。 */
export type WorkshopShareAudienceKind = "same-team" | "cross-team";

/** 动作域闭集（既有 WorkshopShareScope 词表）。 */
export type WorkshopShareActionKind = "preview" | "preview_download";

/** 一次有效分享授权：受众、动作域、有效期与撤销状态都是行本体。 */
export const enterpriseWorkshopShareGrants = pgTable(
  "enterprise_workshop_share_grants",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    tenantId: text("tenant_id").notNull(),
    ownerWorkspaceId: text("owner_workspace_id").notNull(),
    /** 签发者主体（属主管理面：本人分享自己管理）。 */
    principalId: text("principal_id").notNull(),
    audience: text("audience").$type<WorkshopShareAudienceKind>().notNull(),
    /** cross-team 受众团队；same-team 必空（CHECK 钉死）。 */
    audienceWorkspaceId: text("audience_workspace_id"),
    shareAction: text("share_action")
      .$type<WorkshopShareActionKind>()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "enterprise_workshop_share_grants_audience_check",
      sql`${table.audience} IN ('same-team', 'cross-team')`,
    ),
    check(
      "enterprise_workshop_share_grants_share_action_check",
      sql`${table.shareAction} IN ('preview', 'preview_download')`,
    ),
    check(
      "enterprise_workshop_share_grants_audience_workspace_check",
      sql`(${table.audience} = 'cross-team') = (${table.audienceWorkspaceId} IS NOT NULL)`,
    ),
    // 一会话至多一条活链（revoked 行保留审计）。
    uniqueIndex("enterprise_workshop_share_grants_live_session_idx")
      .on(table.sessionId)
      .where(sql`${table.revokedAt} IS NULL`),
    uniqueIndex("enterprise_workshop_share_grants_token_idx").on(
      table.tokenHash,
    ),
    index("enterprise_workshop_share_grants_session_idx").on(table.sessionId),
    foreignKey({
      name: "enterprise_workshop_share_grants_session_fk",
      columns: [table.sessionId],
      foreignColumns: [workshopSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_workshop_share_grants_owner_workspace_fk",
      columns: [table.tenantId, table.ownerWorkspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    // 受众团队钉在同一个公司里（MATCH SIMPLE：audience_workspace_id 为空
    // 时跳过——same-team 无受众列）。
    foreignKey({
      name: "enterprise_workshop_share_grants_audience_workspace_fk",
      columns: [table.tenantId, table.audienceWorkspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_workshop_share_grants_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    pgPolicy("enterprise_workshop_share_grant_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_workshop_share_grants.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_share_grant_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_workshop_share_grants.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_share_grant_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_workshop_share_grants.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_share_grant_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_workshop_share_grants.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_share_grants.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    // 撤销 UPDATE 臂（列级 GRANT 只有 revoked_at/revoked_by——归属列不可
    // 改写是列级授权的结构事实，策略只放行租户+主体上下文内的翻转）。
    pgPolicy("enterprise_workshop_share_grant_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_workshop_share_grants.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_share_grants.principal_id = nullif(current_setting('app.principal_id', true), '')`,
      withCheck: sql`enterprise_workshop_share_grants.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_share_grants.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
  ],
).enableRLS();

export type EnterpriseWorkshopShareGrantRow =
  typeof enterpriseWorkshopShareGrants.$inferSelect;
export type NewEnterpriseWorkshopShareGrantRow =
  typeof enterpriseWorkshopShareGrants.$inferInsert;
