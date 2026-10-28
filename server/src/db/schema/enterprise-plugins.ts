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
  uniqueIndex,
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
 * Same rationale as enterprise-credentials.ts: Bun SQL JSON-encodes jsonb
 * params itself, so drizzle's default mapping would double-encode strings and
 * object-shape CHECKs (`? 'summary'`) would misjudge valid rows.
 */
const jsonbDocument = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb";
  },
});

// MT031（Issue #74）：插件目录与安装归属——目录只读，安装不全局。
//
// 票面：MCP/Composio/OpenConnector 等插件的公共目录可全局只读浏览，但安装、
// 配置与连接都归属发起的公司/团队；另一公司看不到也调用不到这些安装。
//
// 三张表（与 migrate-test 的 MT031 任务一一对应）：
//
//   1. enterprise_plugin_catalog —— 公共目录条目，全局共享：**没有 tenant_id
//      列**（存储形状层面就不归属任何公司），对受限业务角色只读（data/
//      operator 仅 SELECT，零写策略零写授权；策展是部署级行为，走装配面，
//      不在本票业务通道内）。metadata 闭形 CHECK：只允许 'summary' 这类
//      非机密描述键，秘密载体键（envelope/plaintext/secret/token/...）与
//      公司私有面（config）在存储层被拒——目录从结构上不含公司私有配置。
//
//   2. enterprise_plugin_installs —— 一行 = 一次安装，固定公司与团队：
//      tenant_id 与 workspace_id 双 NOT NULL，复合外键 (tenant_id, workspace_id)
//      → enterprise_workspaces 证明团队属于本公司、(tenant_id, installed_by)
//      → enterprise_memberships 证明安装人是本公司成员——跨公司安装行结构上
//      不可能（23503 兜底）。config 闭形 CHECK 拒绝秘密载体键：秘密只能走
//      指定的 sealed 通道（envelope，生产由 credentials.ts 的 AES-GCM envelope
//      供给），明文永不入库。status ∈ ('active','disabled')：停用是状态闸门。
//
//   3. enterprise_plugin_connections —— 一行 = 安装上的一条连接绑定
//      （Composio connected account / OpenConnector connection alias 的
//      归属面）。复合外键 (tenant_id, install_id) → installs：连接随安装
//      级联消亡（卸载只影响本范围），且证明连接与安装同公司；vendor_ref
//      是非机密供应商侧别名。bound_by 复合外键证明绑定人是本公司成员。
//
// RLS 按同文件既有模式最小新增：目录全局读（USING true）+ 安装/连接租户臂；
// 目录零写授权（只读面），安装 operator 全管、连接 operator 无 UPDATE
// （解绑 = 删行，MT010 先例），directory 三表零授权。
export const enterprisePluginCatalog = pgTable(
  "enterprise_plugin_catalog",
  {
    /** 部署级目录条目 id（稳定 slug）。 */
    id: text("id").primaryKey(),
    /** 闭集：'mcp' | 'composio' | 'open-connector'。 */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    vendor: text("vendor").notNull(),
    /** 闭集：'first-party'（策展）| 'custom'（管理员按 URL 添加）。 */
    source: text("source").notNull(),
    /** 非机密公共元数据，闭形 { summary }；秘密载体键存储层被拒。 */
    metadata: jsonbDocument("metadata").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "enterprise_plugin_catalog_kind",
      sql`${table.kind} in ('mcp', 'composio', 'open-connector')`,
    ),
    check(
      "enterprise_plugin_catalog_source",
      sql`${table.source} in ('first-party', 'custom')`,
    ),
    // 目录闭形：只有 summary 一个键；任何秘密载体键与公司私有面（config）
    // 都在存储层被拒——目录从结构上不含公司私有配置。
    check(
      "enterprise_plugin_catalog_metadata_shape",
      sql`${table.metadata} ? 'summary' and not ${table.metadata} ?| array['envelope','plaintext','secret','value','password','token','config','apiKey','api_key','secretRef','encryptedValue','encrypted_value']`,
    ),
    pgPolicy("enterprise_plugin_catalog_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`true`,
    }),
    pgPolicy("enterprise_plugin_catalog_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`true`,
    }),
  ],
).enableRLS();

export const enterprisePluginInstalls = pgTable(
  "enterprise_plugin_installs",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    /** 安装的目录条目（全局共享引用；目录删除被 FK 挡住直至无安装）。 */
    catalogId: text("catalog_id").notNull(),
    /** 安装归属的团队（NOT NULL：安装固定公司与团队）。 */
    workspaceId: text("workspace_id").notNull(),
    /** 发起安装的公司成员（复合外键证明本公司成员资格）。 */
    installedBy: text("installed_by").notNull(),
    /** 非机密安装配置，闭形（秘密载体键存储层被拒）。 */
    config: jsonbDocument("config").notNull(),
    /** 密封密文（可选：无秘密的安装为 NULL）；明文永不入库。 */
    envelope: text("envelope"),
    /** 'active' | 'disabled'（停用是本行状态闸门）。 */
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    // Authority PKG02 (`server/scripts/multitenancy/migrate-test.ts`): the (tenant, workspace, id)
    // scope-unique index that the package-market `enterprise_package_link_connector_fk`
    // points at. The authoritative DDL has always carried it; 0163 restored this table
    // without it and the typed mirror never declared it, so migration 0210 (issue-358 F1)
    // creates it on the chain and this declaration keeps the mirror in step.
    uniqueIndex("enterprise_plugin_install_scope_id_uq").on(
      table.tenantId,
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.installedBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.catalogId],
      foreignColumns: [enterprisePluginCatalog.id],
    }),
    check(
      "enterprise_plugin_install_status",
      sql`${table.status} in ('active', 'disabled')`,
    ),
    // 配置闭形：秘密载体键拒绝——秘密只能走 envelope 密封通道。
    check(
      "enterprise_plugin_install_config_shape",
      sql`not ${table.config} ?| array['envelope','plaintext','secret','value','password','token','config','apiKey','api_key','secretRef','encryptedValue','encrypted_value']`,
    ),
    index("enterprise_plugin_install_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    index("enterprise_plugin_install_catalog_idx").on(table.catalogId),
    pgPolicy("enterprise_plugin_install_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_plugin_install_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_plugin_install_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_plugin_install_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_plugin_install_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterprisePluginConnections = pgTable(
  "enterprise_plugin_connections",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    /** 所属安装（复合外键：同公司 + 随安装级联消亡）。 */
    installId: text("install_id").notNull(),
    /** 绑定连接的公司成员（复合外键证明本公司成员资格）。 */
    boundBy: text("bound_by").notNull(),
    /** 非机密供应商侧别名（Composio account id / OpenConnector alias）。 */
    vendorRef: text("vendor_ref").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.installId],
      foreignColumns: [
        enterprisePluginInstalls.tenantId,
        enterprisePluginInstalls.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.boundBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_plugin_connection_vendor_ref",
      sql`char_length(${table.vendorRef}) between 1 and 512`,
    ),
    index("enterprise_plugin_connection_install_idx").on(
      table.tenantId,
      table.installId,
    ),
    pgPolicy("enterprise_plugin_connection_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_plugin_connection_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_plugin_connection_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_plugin_connection_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();
