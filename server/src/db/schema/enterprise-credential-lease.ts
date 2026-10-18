import { sql } from "drizzle-orm";
import {
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
import { enterpriseCredentials } from "./enterprise-credentials";
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
 * CHECKs (`not detail ?| array[...]`) would evaluate false for perfectly
 * valid rows. Values bound through this type are always JS objects, which Bun
 * encodes correctly (observed and pinned by the MT027 suite's red/green record).
 */
const jsonbDocument = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb";
  },
});

// MT029（Issue #72）：凭据取用 lease——固定用途、作用域且可撤销，expand-only。
//
// 票面：业务执行需要凭据时通过 lease 取用；lease 固定用途、作用域与有效期，
// 可被撤销；个人凭据不会因为团队公共 Bot 而被自动共享给其他使用者。
//
// 两张表（与 migrate-test 的 MT029 任务一一对应）：
//
//   1. enterprise_credential_leases —— 一行 = 一条固定 (凭据, 持有人, 团队
//      上下文, 用途, 有效期) 的可撤销取用授权。id 是服务端生成的不透明
//      lease 令牌（非调用方可声明）。三条复合外键全部内嵌 tenant_id——
//      跨公司 lease 行结构性不可能：凭据必属本公司（→ enterprise_credentials）、
//      持有人必是本公司成员（→ enterprise_memberships）、团队上下文必属
//      本公司（→ enterprise_workspaces）。purpose 是闭集用途（签发时固定，
//      取用时逐字比对）；status 只有两态，撤销 = revoked_at 原子落戳
//      （行形 CHECK 强制配对）；窗口 CHECK 强制 expires_at > created_at。
//
//   2. enterprise_credential_lease_audit —— lease 审计，append-only。每次
//      签发（issued）、每次校验点取用（validated）、每次撤销（revoked）
//      各恰好一行，与操作同一事务写入。lease_id/credential_id 无外键
//      （MT069 先例：审计不随对象消亡——凭据/lease 行被级联删除后审计
//      仍在）。detail 只含非机密事实快照，CHECK 禁止秘密载体键；principal
//      是 lease 持有人（审计主体），不是操作者。data 只插不读（成员不能
//      互相侦察，MT027 审计先例），operator 读+插（撤销留痕经管理通道），
//      任何角色无 UPDATE/DELETE。
//
// RLS 按同文件既有模式最小新增：lease 行 data 侧 SELECT/INSERT 都 pin
// tenant+principal（持有人只见本人 lease；判定服务经受限 data 通道签发），
// operator 侧租户范围 SELECT+UPDATE（撤销走 MT027 revoke 同款管理通道），
// data 零 UPDATE/DELETE（lease 不可被持有人篡改）；audit 表 data INSERT
// + operator SELECT/INSERT。配套最小授权由 migrate-test 的 MT029 任务真实
// 执行；directory 角色两表零授权。
export const enterpriseCredentialLeases = pgTable(
  "enterprise_credential_leases",
  {
    tenantId: text("tenant_id").notNull(),
    /** 不透明 lease 令牌（服务端 randomUUID，非调用方可声明）。 */
    id: text("id").notNull(),
    /** 被取用的凭据（复合外键证明属本公司）。 */
    credentialId: text("credential_id").notNull(),
    /** 持有人（复合外键证明本公司成员资格）。 */
    principalId: text("principal_id").notNull(),
    /** 作用域团队上下文（复合外键证明属本公司）。 */
    workspaceId: text("workspace_id").notNull(),
    /** 签发时固定的用途（闭集；取用时逐字比对）。 */
    purpose: text("purpose").notNull(),
    /** 'active' | 'revoked'（撤销经管理通道原子翻转）。 */
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** 撤销落戳（行形 CHECK：revoked ⇔ revoked_at 非空）。 */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.credentialId],
      foreignColumns: [
        enterpriseCredentials.tenantId,
        enterpriseCredentials.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    check(
      "enterprise_credential_lease_purpose",
      sql`${table.purpose} in ('bot-run', 'connector-call', 'site-access')`,
    ),
    check(
      "enterprise_credential_lease_status",
      sql`${table.status} in ('active', 'revoked')`,
    ),
    check(
      "enterprise_credential_lease_window",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "enterprise_credential_lease_row_shape",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} is not null)`,
    ),
    index("enterprise_credential_lease_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    index("enterprise_credential_lease_credential_idx").on(
      table.tenantId,
      table.credentialId,
    ),
    pgPolicy("enterprise_credential_lease_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_lease_data_insert", {
      for: "insert",
      to: "ob_ent_data",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_lease_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_lease_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterpriseCredentialLeaseAudit = pgTable(
  "enterprise_credential_lease_audit",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    /** 无外键（MT069 审计先例）：审计不随 lease/凭据行消亡。 */
    leaseId: text("lease_id").notNull(),
    credentialId: text("credential_id").notNull(),
    /** 审计主体 = lease 持有人（不是操作者）。 */
    principalId: text("principal_id").notNull(),
    /** 闭集：issued（签发）/ validated（校验点取用）/ revoked（撤销）。 */
    action: text("action").notNull(),
    /** 非机密事实快照，闭形 CHECK 禁止秘密载体键。 */
    detail: jsonbDocument("detail").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    check(
      "enterprise_credential_lease_audit_action",
      sql`${table.action} in ('issued', 'validated', 'revoked')`,
    ),
    check(
      "enterprise_credential_lease_audit_detail_shape",
      sql`not ${table.detail} ?| array['envelope','plaintext','secret','value','password','token']`,
    ),
    index("enterprise_credential_lease_audit_tenant_time_idx").on(
      table.tenantId,
      table.occurredAt,
    ),
    pgPolicy("enterprise_credential_lease_audit_data_insert", {
      for: "insert",
      to: "ob_ent_data",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_lease_audit_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_lease_audit_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();
