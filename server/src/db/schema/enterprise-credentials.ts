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
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * jsonb whose JS value is passed to the driver verbatim (no JSON.stringify).
 *
 * The app database client is Bun SQL. Bun JSON-encodes parameter values for
 * jsonb targets itself; drizzle's default jsonb mapping stringifies first, so
 * a string param arrives as a jsonb SCALAR (double-encoded) and object-shape
 * CHECKs (`? 'label'`) would evaluate false for perfectly valid rows. Values
 * bound through this type are always JS objects, which Bun encodes correctly
 * (observed and pinned by the MT027 suite's red/green record).
 */
const jsonbDocument = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb";
  },
});

// MT027（Issue #70）：连接凭据与站点登录的真实归属存储，expand-only。
//
// 票面：凭据与站点登录存储归属、明文读取授权、脱敏展示、相关表 RLS；
// 可用不等于可读明文。
//
// 三张表（与 migrate-test 的 MT027 任务一一对应）：
//
//   1. enterprise_credentials —— 一行 = 一个连接凭据或站点登录的真实归属。
//      classification 是显式的归属分类（personal/team/company），行形 CHECK
//      强制三态互斥自洽：personal ⇔ owner_principal_id（复合外键证明属主是
//      本公司成员）、team ⇔ workspace_id（复合外键证明团队属于本公司）、
//      company 两者皆空。envelope 只存密封密文（生产由 credentials.ts 的
//      AES-GCM envelope 供给），明文永不入库。target/display 是非机密寻址
//      与展示元数据——脱敏视图就从这两个字段构成。
//
//   2. enterprise_credential_actions —— 动作授权事实。action 是闭集
//      ('use','disclose')：'use' 授权业务使用（allow 分支独占携带密封材料），
//      'disclose' 独立授权明文读取——两行互不蕴含，被授权使用不等于可读
//      明文。granted_by 复合外键证明授权人也是本公司成员。撤销 = 删除行
//      （MT010 先例：无可达中间态，立即失效）。
//
//   3. enterprise_credential_audit —— 明文披露审计，append-only。detail 只含
//      非机密事实快照（kind/classification/target）。无 credential 外键
//      （MT069 审计先例：审计不随对象消亡）。data 角色只写不读（成员不能
//      互相侦察），operator 只读，任何角色无 UPDATE/DELETE。
//
// RLS 按同文件既有模式最小新增（data 租户范围读 + 本人动作行读 + 审计写入，
// operator 租户范围读写），配套最小授权由 migrate-test 的 MT027 任务真实执行。
export const enterpriseCredentials = pgTable(
  "enterprise_credentials",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    /** 'connection'（连接凭据）或 'site-login'（站点登录）。 */
    kind: text("kind").notNull(),
    /** 显式归属分类：'personal' | 'team' | 'company'。 */
    classification: text("classification").notNull(),
    /** 团队凭据的所属团队（personal/company 为 NULL；行形 CHECK 强制）。 */
    workspaceId: text("workspace_id"),
    /** 个人凭据的属主（team/company 为 NULL；行形 CHECK 强制）。 */
    ownerPrincipalId: text("owner_principal_id"),
    /** 非机密寻址元数据：站点登录 = origin，连接凭据 = provider。 */
    target: text("target").notNull(),
    /** 非机密展示元数据，闭形 { label }。 */
    display: jsonbDocument("display").notNull(),
    /** 密封密文（生产 = credentials.ts 的 AES-GCM envelope）；明文永不入库。 */
    envelope: text("envelope").notNull(),
    /** 'active' | 'revoked'（撤销后对所有人生效，含属主）。 */
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
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
      columns: [table.tenantId, table.ownerPrincipalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_credential_kind",
      sql`${table.kind} in ('connection', 'site-login')`,
    ),
    check(
      "enterprise_credential_classification",
      sql`${table.classification} in ('personal', 'team', 'company')`,
    ),
    check(
      "enterprise_credential_status",
      sql`${table.status} in ('active', 'revoked')`,
    ),
    // 行形：三态互斥且列配对自洽——team ⇔ workspace、personal ⇔ 属主、
    // company 两者皆空（跨公司归属行另由复合外键结构性不可能）。
    check(
      "enterprise_credential_row_shape",
      sql`(${table.classification} = 'team') = (${table.workspaceId} is not null) and (${table.classification} = 'personal') = (${table.ownerPrincipalId} is not null)`,
    ),
    // 展示元数据闭形：只有 label 一个键（脱敏视图的形状由存储形状兜底）。
    check(
      "enterprise_credential_display_shape",
      sql`${table.display} ? 'label' and not ${table.display} ?| array['envelope','plaintext','secret','value','password','token']`,
    ),
    index("enterprise_credential_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    pgPolicy("enterprise_credential_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterpriseCredentialActions = pgTable(
  "enterprise_credential_actions",
  {
    tenantId: text("tenant_id").notNull(),
    credentialId: text("credential_id").notNull(),
    /** 被授权的公司成员（复合外键证明本公司成员资格）。 */
    principalId: text("principal_id").notNull(),
    /** 闭集动作：'use'（业务使用）| 'disclose'（明文读取，独立授权）。 */
    action: text("action").notNull(),
    /** 授权人（复合外键证明本公司成员资格）。 */
    grantedBy: text("granted_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.credentialId,
        table.principalId,
        table.action,
      ],
    }),
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
      columns: [table.tenantId, table.grantedBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_credential_action_kind",
      sql`${table.action} in ('use', 'disclose')`,
    ),
    pgPolicy("enterprise_credential_action_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_action_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_action_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_action_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterpriseCredentialAudit = pgTable(
  "enterprise_credential_audit",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    /** 无外键（MT069 审计先例）：审计不随凭据行消亡。 */
    credentialId: text("credential_id").notNull(),
    /** 发起明文读取的主体。 */
    principalId: text("principal_id").notNull(),
    /** 闭集：目前只有明文披露一种被审计动作。 */
    action: text("action").notNull().default("plaintext.disclosed"),
    /** 非机密事实快照（kind/classification/target），绝不携带 envelope。 */
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
      "enterprise_credential_audit_action",
      sql`${table.action} = 'plaintext.disclosed'`,
    ),
    index("enterprise_credential_audit_tenant_time_idx").on(
      table.tenantId,
      table.occurredAt,
    ),
    pgPolicy("enterprise_credential_audit_data_insert", {
      for: "insert",
      to: "ob_ent_data",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_credential_audit_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();
