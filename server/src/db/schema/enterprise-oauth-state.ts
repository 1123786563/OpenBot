import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// MT028（Issue #71）：OAuth 回调按服务端持久 state 固定归属，expand-only。
//
// 票面：发起 OAuth 时服务端保存发起公司、团队、用户与目标连接；回调只按这
// 份持久状态绑定结果，与回调时客户端选择无关；state 缺失、过期、重复使用
// 或跨范围复用时拒绝并记录安全事件；回调失败不产生半成品连接，重试必须用
// 新 state；回调响应与日志零 token 明文。
//
// 一行 = 一次连接 OAuth 发起流程。与 MT026 的身份绑定 intent 同一机制族
// （服务端生成不透明 state、持久行决定归属、一次性消费），本表是其连接凭据
// 版，多出三件事：
//
//   1. 归属是完整三元组：tenant_id + workspace_id + principal_id，三条复合
//      外键全部内嵌 tenant_id——团队必须属本公司、发起人必须是本公司成员，
//      跨公司归属行在结构上不可能存在。
//   2. purpose（闭集，对齐 MT027 凭据 kind）+ target（非机密寻址）固定
//      「连接目的」：回调绑定哪条连接由发起行决定，与回调期选择无关。
//   3. verifier 持久保存发起时生成的 PKCE verifier（服务端生成，绝不来自
//      回调）——持久行是流程秘密材料的唯一事实源；它只经 allow 分支的
//      binding 离开本模块，任何事件、拒绝消息与日志都不携带。
//
// 生命周期由行形 CHECK 强制：pending ⇔ 无时间戳；consumed ⇔ 只有
// consumed_at；failed ⇔ failed_at（+ 闭集 failed_reason）。一次性消费的
// UPDATE 只认 `status='pending' 且未过期` 的原子臂——重复使用读作
// REPLAYED；fail 后 consume 再遇同样 REPLAYED（重试必须新 state）。
//
// RLS 按同文件既有模式最小新增（operator INSERT 走 tenant 臂；SELECT 与
// UPDATE 只走 state 臂 app.oauth_state——受限角色无法按公司枚举流程，与
// MT026 intent 同形）；data/directory 零策略零授权：绑定流程不进入任何
// 业务读面。配套最小授权由 migrate-test 的 MT028 任务真实执行。
export const enterpriseOAuthStates = pgTable(
  "enterprise_oauth_states",
  {
    /** 不透明 state 值；服务端生成，回调携带它，但归属永远由本行决定。 */
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    /** 发起时的团队（复合外键证明团队属本公司）。 */
    workspaceId: text("workspace_id").notNull(),
    /** 发起人（复合外键证明本公司成员资格）。 */
    principalId: text("principal_id").notNull(),
    /** 连接目的闭集：'connection' | 'site-login'（对齐 MT027 凭据 kind）。 */
    purpose: text("purpose").notNull(),
    /** 非机密寻址：本次连接指向的连接目标（provider / server 标识）。 */
    target: text("target").notNull(),
    /** 发起时生成的 PKCE verifier（≥43 字符）；只经 allow binding 离开本模块。 */
    verifier: text("verifier").notNull(),
    /** 'pending' | 'consumed' | 'failed'（行形 CHECK 强制三态互斥自洽）。 */
    status: text("status").notNull().default("pending"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    /** 闭集：'vendor-refused' | 'record-failed' | 'abandoned'。 */
    failedReason: text("failed_reason"),
  },
  (table) => [
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
      "enterprise_oauth_state_purpose",
      sql`${table.purpose} in ('connection', 'site-login')`,
    ),
    check(
      "enterprise_oauth_state_target",
      sql`char_length(${table.target}) between 1 and 512`,
    ),
    check(
      "enterprise_oauth_state_verifier",
      sql`char_length(${table.verifier}) >= 43`,
    ),
    check(
      "enterprise_oauth_state_status",
      sql`${table.status} in ('pending', 'consumed', 'failed')`,
    ),
    check(
      "enterprise_oauth_state_window",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "enterprise_oauth_state_failed_reason",
      sql`(${table.failedReason} is null) = (${table.failedAt} is null) and (${table.failedReason} is null or ${table.failedReason} in ('vendor-refused', 'record-failed', 'abandoned'))`,
    ),
    // 行形：三态互斥且时间戳配对自洽——pending 无任何终态时间戳、consumed
    // 恰有 consumed_at 且无 failed_at、failed 恰有 failed_at（消费后失败
    // 的行保留 consumed_at：它确实被消费过一次，审计事实不随失败消失）。
    check(
      "enterprise_oauth_state_row_shape",
      sql`(${table.status} = 'pending') = (${table.consumedAt} is null and ${table.failedAt} is null) and (${table.status} = 'consumed') = (${table.consumedAt} is not null and ${table.failedAt} is null) and (${table.status} = 'failed') = (${table.failedAt} is not null)`,
    ),
    index("enterprise_oauth_state_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    pgPolicy("enterprise_oauth_state_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_oauth_state_state_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.id} = nullif(current_setting('app.oauth_state', true), '')`,
    }),
    pgPolicy("enterprise_oauth_state_state_consume", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.id} = nullif(current_setting('app.oauth_state', true), '')`,
      withCheck: sql`${table.id} = nullif(current_setting('app.oauth_state', true), '')`,
    }),
  ],
).enableRLS();
