import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { enterpriseBotOwnership } from "./enterprise-bot-ownership";
import { enterprisePluginInstalls } from "./enterprise-plugins";
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * jsonb whose JS value is passed to the driver verbatim (no JSON.stringify).
 *
 * The app database client is Bun SQL. Bun JSON-encodes parameter values for
 * jsonb targets itself; drizzle's default jsonb mapping stringifies first, so
 * a string param arrives as a jsonb SCALAR (double-encoded) and object-shape
 * CHECKs would evaluate false for perfectly valid rows. Values bound through
 * this type are always JS objects, which Bun encodes correctly (MT027/MT029
 * suites' red/green records pin this driver behavior).
 */
const jsonbDocument = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb";
  },
});

// MT034（Issue #77）：共享账号审批——绑定对象、参数摘要与归属，expand-only。
//
// 票面：共享账号的规则、申请与批准都锁定到具体对象、参数摘要与所属公司
// 团队；改了团队或改了参数就不能复用旧批准，跨范围审批无法生效。
//
// 两张表（与 migrate-test 的 MT034 任务一一对应）：
//
//   1. enterprise_shared_use_requests —— 一行 = 一条锁定
//      (tenant, workspace, bot, install) 的审批申请。五条复合外键全部
//      内嵌 tenant_id——跨公司申请行结构性不可能：团队必属本公司
//      （→ enterprise_workspaces）、Bot 归属行必属本公司（→
//      enterprise_bot_ownership 的 (tenant_id, agent_id) 主键）、安装行
//      必属本公司（→ enterprise_plugin_installs）、申请人必是本公司成员
//      （→ enterprise_memberships）、决定人同样（nullable）。提议参数的
//      摘要是服务端规范序列化 sha256（proposed_params_digest，64 位十六
//      进制 CHECK）；受众/理由是闭集；status 闭集且行形 CHECK 强制
//      决定动作配对（approved/declined ⇔ decided_by + decided_at）。
//      data 角色读全部 + 插自己 + 只能撤回本人 pending 行（withdraw 是
//      本行状态闸门）；operator 角色租户范围读 + 改（决定走管理通道，
//      workspace-admin 先例）；data 零 DELETE；directory 零授权。
//
//   2. enterprise_shared_use_approvals —— 批准行是只追加的不可变授予：
//      锁定同一 (tenant, workspace, bot, install) 四元组 + 参数摘要 +
//      批准人 + 溯源申请行（request_id 复合外键）。没有 status 列——
//      授权的「还有效吗」永远是判定服务现读实时事实的结论（成员资格、
//      归属行活性、四元组/摘要逐字匹配），不落在本表任何可变列上；
//      任何角色零 UPDATE/DELETE 授权（改参数 = 新摘要 = 必须重新审批，
//      AC1；换团队 = 四元组不匹配，AC2——都不存在「改行复用」通道）。
//      data 只读（使用判定经受限 data 通道现读）；operator 读 + 插
//      （批准走管理通道）；directory 零授权。
//
// RLS 按同文件既有模式最小新增：两表 data/operator 策略 pin tenant；
// requests 的 data INSERT/UPDATE 追加主体 pin（requested_by = 本人）。
// 配套最小授权由 migrate-test 的 MT034 任务真实执行。
export const enterpriseSharedUseRequests = pgTable(
  "enterprise_shared_use_requests",
  {
    tenantId: text("tenant_id").notNull(),
    /** 服务端 randomUUID（非调用方可声明）。 */
    id: text("id").notNull(),
    /** 申请锁定的团队上下文（复合外键证明属本公司）。 */
    workspaceId: text("workspace_id").notNull(),
    /** 申请锁定的 Bot（复合外键 → 本公司归属行主键）。 */
    agentId: text("agent_id").notNull(),
    /** 申请锁定的安装对象（复合外键证明属本公司）。 */
    installId: text("install_id").notNull(),
    /** 申请人（复合外键证明本公司成员资格）。 */
    requestedBy: text("requested_by").notNull(),
    /** 'owner' | 'people' | 'team'（与部署级 shared-use 词表同源）。 */
    proposedAudience: text("proposed_audience").notNull(),
    proposedOutsideInput: boolean("proposed_outside_input").notNull(),
    /** 提议名单快照：[{kind: 'user'|'group', value}]（非机密）。 */
    proposedMembers: jsonbDocument("proposed_members").notNull(),
    /** 服务端对提议参数的规范序列化 sha256（64 位十六进制）。 */
    proposedParamsDigest: text("proposed_params_digest").notNull(),
    /** 'publish' | 'trigger' | 'grant' | 'refused_call'（闭集）。 */
    reason: text("reason").notNull(),
    /** 'pending' | 'approved' | 'declined' | 'withdrawn' | 'superseded'。 */
    status: text("status").notNull().default("pending"),
    /** 决定人/决定时间（行形 CHECK 与 approved/declined 强制配对）。 */
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [
        enterpriseBotOwnership.tenantId,
        enterpriseBotOwnership.agentId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.installId],
      foreignColumns: [
        enterprisePluginInstalls.tenantId,
        enterprisePluginInstalls.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.requestedBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.decidedBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_shared_use_request_audience",
      sql`${table.proposedAudience} in ('owner', 'people', 'team')`,
    ),
    check(
      "enterprise_shared_use_request_reason",
      sql`${table.reason} in ('publish', 'trigger', 'grant', 'refused_call')`,
    ),
    check(
      "enterprise_shared_use_request_status",
      sql`${table.status} in ('pending', 'approved', 'declined', 'withdrawn', 'superseded')`,
    ),
    check(
      "enterprise_shared_use_request_digest_shape",
      sql`${table.proposedParamsDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "enterprise_shared_use_request_members_shape",
      sql`jsonb_typeof(${table.proposedMembers}) = 'array'`,
    ),
    check(
      "enterprise_shared_use_request_decision_shape",
      sql`(${table.status} in ('approved', 'declined')) = (${table.decidedBy} is not null and ${table.decidedAt} is not null)`,
    ),
    index("enterprise_shared_use_request_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    index("enterprise_shared_use_request_object_idx").on(
      table.tenantId,
      table.agentId,
      table.installId,
      table.workspaceId,
    ),
    pgPolicy("enterprise_shared_use_request_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_shared_use_request_data_insert", {
      for: "insert",
      to: "ob_ent_data",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.requestedBy} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_shared_use_request_data_withdraw", {
      for: "update",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.requestedBy} = nullif(current_setting('app.principal_id', true), '') and ${table.status} = 'pending'`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.requestedBy} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_shared_use_request_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_shared_use_request_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterpriseSharedUseApprovals = pgTable(
  "enterprise_shared_use_approvals",
  {
    tenantId: text("tenant_id").notNull(),
    /** 服务端 randomUUID（非调用方可声明）。 */
    id: text("id").notNull(),
    /** 批准锁定的团队上下文（复合外键证明属本公司）。 */
    workspaceId: text("workspace_id").notNull(),
    /** 批准锁定的 Bot（复合外键 → 本公司归属行主键）。 */
    agentId: text("agent_id").notNull(),
    /** 批准锁定的安装对象（复合外键证明属本公司）。 */
    installId: text("install_id").notNull(),
    /** 溯源申请行（复合外键；批准只能从一条本公司 pending 申请产生）。 */
    requestId: text("request_id").notNull(),
    /** 锁定的参数摘要（与申请行的提议摘要逐字一致）。 */
    paramsDigest: text("params_digest").notNull(),
    /** 'owner' | 'people' | 'team'。 */
    audience: text("audience").notNull(),
    outsideInput: boolean("outside_input").notNull(),
    /** 批准时锁定的名单快照（非机密）。 */
    members: jsonbDocument("members").notNull(),
    /** 批准人（复合外键证明本公司成员资格）。 */
    approvedBy: text("approved_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [
        enterpriseBotOwnership.tenantId,
        enterpriseBotOwnership.agentId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.installId],
      foreignColumns: [
        enterprisePluginInstalls.tenantId,
        enterprisePluginInstalls.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.requestId],
      foreignColumns: [
        enterpriseSharedUseRequests.tenantId,
        enterpriseSharedUseRequests.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.approvedBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_shared_use_approval_audience",
      sql`${table.audience} in ('owner', 'people', 'team')`,
    ),
    check(
      "enterprise_shared_use_approval_digest_shape",
      sql`${table.paramsDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "enterprise_shared_use_approval_members_shape",
      sql`jsonb_typeof(${table.members}) = 'array'`,
    ),
    index("enterprise_shared_use_approval_object_idx").on(
      table.tenantId,
      table.agentId,
      table.installId,
      table.workspaceId,
      table.paramsDigest,
    ),
    pgPolicy("enterprise_shared_use_approval_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_shared_use_approval_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_shared_use_approval_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();
