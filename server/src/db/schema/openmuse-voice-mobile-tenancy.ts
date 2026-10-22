import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { pushDevices } from "./delivery";
import {
  enterpriseMemberships,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";
import { voiceSessions } from "./voice";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT066（Issue #109）：语音、听写与移动聚合的归属域。expand-only——三张新
// 表与按既有模式的最小 RLS；不修改任何既有表/策略/授权。
//
// voice_session_scopes：一行 = 一条语音会话根记录（voice_sessions，按
// (channel, user) 的用户级形状，无租户列）在一个 (公司, 团队, 主体) 三元
// 组上的归属关联 + 用量事实（AC1「用量记录归属（供 MT070 计费）」的语音
// 半边）。session_id 主键；FK → voice_sessions(id) cascade；
// usage_seconds 在 pin 时从根行 duration_seconds 冻结（根行在结束后不可
// 变，冻结值与根行恒等；计费面读协会行即得归属与用量，不必回读根表）。
//
// dictation_usage_scopes：一行 = 一次听写请求的用量归属记录。听写面
// （POST /api/audio/transcriptions）是无状态单发——没有会话根行，本行就是
// 该请求的持久用量事实（AC1 听写半边；MT070 计费的消费面）。id 服务端生
// 成；usage_key 唯一（调用方幂等键：同一请求重放收敛到一行）；
// audio_seconds/output_tokens 为非负 CHECK。无根表外键可钉（诚实披露：
// 听写无根行，一致性由本表自身承载）。
//
// push_device_scopes：一行 = 一台推送设备根记录（push_devices，仅
// owner_user_id 的用户级形状）在一个三元组上的归属绑定（AC3「推送设备绑
// 定到具体用户与范围；解绑或撤权后停止推送」的持久面；通知渠道绑定的对
// 应面在 MT065）。device_id 主键；FK → push_devices(id) cascade。
//
// RLS 沿 MT059–MT062 既有模式 + MT042 扫描臂（三张表同款）：REVOKE
// PUBLIC + 四能力角色 → ENABLE + FORCE → data 租户臂 SELECT + restrictive
// 主体自读 → operator 租户 + 主体上下文读/插/删 → operator 扫描臂。目录
// 角色无任何策略与授权。零 UPDATE 授权——归属与用量不可改写是结构不是
// 纪律。

/** 一条语音会话在一个三元组上的归属关联与冻结用量；一行 = 一条。 */
export const voiceSessionScopes = pgTable(
  "voice_session_scopes",
  {
    sessionId: text("session_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    /** Pin 时从根行 duration_seconds 冻结的用量秒数（AC1，供 MT070）。 */
    usageSeconds: integer("usage_seconds").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("voice_session_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.sessionId,
    ),
    foreignKey({
      name: "voice_session_scopes_session_fk",
      columns: [table.sessionId],
      foreignColumns: [voiceSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "voice_session_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "voice_session_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "voice_session_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check(
      "voice_session_scopes_usage_non_negative",
      sql`${table.usageSeconds} >= 0`,
    ),
    pgPolicy("voice_session_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`voice_session_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("voice_session_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`voice_session_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("voice_session_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`voice_session_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and voice_session_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("voice_session_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`voice_session_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and voice_session_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("voice_session_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`voice_session_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and voice_session_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("voice_session_scope_operator_sweep_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`current_setting('app.scan_sweep', true) = 'on'`,
    }),
  ],
).enableRLS();

/** 一次听写请求的用量归属记录；一行 = 一次请求（usage_key 幂等收敛）。 */
export const dictationUsageScopes = pgTable(
  "dictation_usage_scopes",
  {
    id: text("id").primaryKey(),
    usageKey: text("usage_key").notNull(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    audioSeconds: integer("audio_seconds").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("dictation_usage_scopes_usage_key_uq").on(table.usageKey),
    index("dictation_usage_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "dictation_usage_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "dictation_usage_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "dictation_usage_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check(
      "dictation_usage_scopes_meters_non_negative",
      sql`${table.audioSeconds} >= 0 and ${table.outputTokens} >= 0`,
    ),
    pgPolicy("dictation_usage_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`dictation_usage_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("dictation_usage_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`dictation_usage_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("dictation_usage_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`dictation_usage_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and dictation_usage_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("dictation_usage_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`dictation_usage_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and dictation_usage_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("dictation_usage_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`dictation_usage_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and dictation_usage_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("dictation_usage_scope_operator_sweep_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`current_setting('app.scan_sweep', true) = 'on'`,
    }),
  ],
).enableRLS();

/** 一台推送设备在一个三元组上的归属绑定；一行 = 一条。 */
export const pushDeviceScopes = pgTable(
  "push_device_scopes",
  {
    deviceId: text("device_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("push_device_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.deviceId,
    ),
    foreignKey({
      name: "push_device_scopes_device_fk",
      columns: [table.deviceId],
      foreignColumns: [pushDevices.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "push_device_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "push_device_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "push_device_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    pgPolicy("push_device_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`push_device_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("push_device_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`push_device_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("push_device_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`push_device_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and push_device_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("push_device_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`push_device_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and push_device_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("push_device_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`push_device_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and push_device_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("push_device_scope_operator_sweep_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`current_setting('app.scan_sweep', true) = 'on'`,
    }),
  ],
).enableRLS();

export type VoiceSessionScopeRow = typeof voiceSessionScopes.$inferSelect;
export type NewVoiceSessionScopeRow = typeof voiceSessionScopes.$inferInsert;
export type DictationUsageScopeRow = typeof dictationUsageScopes.$inferSelect;
export type NewDictationUsageScopeRow =
  typeof dictationUsageScopes.$inferInsert;
export type PushDeviceScopeRow = typeof pushDeviceScopes.$inferSelect;
export type NewPushDeviceScopeRow = typeof pushDeviceScopes.$inferInsert;
