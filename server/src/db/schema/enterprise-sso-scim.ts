import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { enterpriseTenants } from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT026（Issue #69）：每公司 SSO/SCIM 隔离的存储面。expand-only——三张新表，
// 不修改任何既有表/策略/授权。
//
// 归属纪律（票面验收 2/3/4 的实现面）：
//   - SSO 配置与 SCIM 目录绑定是**公司事实**：一行只属于一家公司，读取与
//     写入全部经公司 pin（app.tenant_id）；文档/凭据列只存引用，秘密永不
//     进配置文档。
//   - SCIM 目录绑定的 connection_key 全局唯一：插件以 bearer token 认证后
//     得到该 key——服务端已验证事实；公司归属只能来自按 key 查出的持久行，
//     绝不来自请求载荷。绑定行还记录本绑定最后一次 SCIM 停用的 principal/
//     epoch（服务端持久事实），供「管理员停用优先于目录恢复」裁决。
//   - 身份绑定意图在创建时钉死归属；回调解析按 state 精确 pin 读持久行，
//     回调参数不能改写公司。
//
// RLS 沿 enterprise-tenancy.ts / enterprise-runtime-config.ts 既有模式最小
// 新增：data 角色租户范围 SELECT（配置解析读取）；operator 角色租户范围
// 读/写；绑定表额外一条连接键臂 SELECT 策略（SCIM 面解析）；意图表
// SELECT/UPDATE 只有 state 臂（按公司不可枚举）。目录角色无任何策略与授权。

/** 一家公司（Tenant）的 SSO 配置文档与版本号；一行 = 一家公司。 */
export const enterpriseSsoConfigs = pgTable(
  "enterprise_sso_configs",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    /** 只存引用（协议/issuer/domain/凭据引用），秘密在凭据库。 */
    document: jsonb("document").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("enterprise_sso_config_revision", sql`${table.revision} > 0`),
    pgPolicy("enterprise_sso_config_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_sso_configs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_sso_config_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_sso_configs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_sso_config_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_sso_configs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_sso_config_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_sso_configs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`enterprise_sso_configs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/**
 * 一家公司的 SCIM 目录绑定；一行 = 一家公司的一个目录连接。
 *
 * connection_key 全局唯一（跨公司冲突在存储层不可能同时存在）。公司归属在
 * 登记时持久化；SCIM 面按 key 解析（连接键臂策略）。last_deprovision_* 是
 * 本绑定最后一次 SCIM 停用的服务端持久事实（两列同空或同非空）。
 */
export const enterpriseScimDirectoryBindings = pgTable(
  "enterprise_scim_directory_bindings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    connectionKey: text("connection_key").notNull(),
    /** 凭据引用（寻址），不是令牌本身。 */
    credentialRef: text("credential_ref").notNull(),
    status: text("status").notNull().default("active"),
    lastDeprovisionPrincipalId: text("last_deprovision_principal_id"),
    lastDeprovisionEpoch: integer("last_deprovision_epoch"),
    createdAt: createdAt(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("enterprise_scim_binding_connection_key").on(
      table.connectionKey,
    ),
    check(
      "enterprise_scim_binding_status",
      sql`${table.status} in ('active','deactivated')`,
    ),
    check(
      "enterprise_scim_binding_deprovision_fact",
      sql`(${table.lastDeprovisionPrincipalId} is null) = (${table.lastDeprovisionEpoch} is null)`,
    ),
    pgPolicy("enterprise_scim_binding_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_scim_directory_bindings.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    /** SCIM 面解析臂：pin 服务端已验证的连接键，公司归属由行携带。 */
    pgPolicy("enterprise_scim_binding_connection_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_scim_directory_bindings.connection_key = nullif(current_setting('app.scim_connection_key', true), '')`,
    }),
    pgPolicy("enterprise_scim_binding_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_scim_directory_bindings.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_scim_binding_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_scim_directory_bindings.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`enterprise_scim_directory_bindings.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/**
 * 一次身份绑定的服务端持久意图；一行 = 一次待回调。
 *
 * 归属（tenant + user + kind）在创建时持久化；回调解析按 state 精确 pin
 * （SELECT/UPDATE 只有 state 臂——按公司不可枚举，归属只来自行）。
 */
export const enterpriseIdentityBindingIntents = pgTable(
  "enterprise_identity_binding_intents",
  {
    /** 不透明 state；服务端生成，不是回调可声明的值。 */
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "enterprise_identity_binding_kind",
      sql`${table.kind} in ('sso','scim')`,
    ),
    check(
      "enterprise_identity_binding_window",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    pgPolicy("enterprise_identity_binding_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_identity_binding_intents.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_identity_binding_state_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_identity_binding_intents.id = nullif(current_setting('app.identity_binding_state', true), '')`,
    }),
    pgPolicy("enterprise_identity_binding_state_consume", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_identity_binding_intents.id = nullif(current_setting('app.identity_binding_state', true), '')`,
      withCheck: sql`enterprise_identity_binding_intents.id = nullif(current_setting('app.identity_binding_state', true), '')`,
    }),
  ],
).enableRLS();
