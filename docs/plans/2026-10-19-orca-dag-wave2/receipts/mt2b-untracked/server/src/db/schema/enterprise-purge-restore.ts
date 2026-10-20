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

/** jsonb verbatim（MT027/MT029 套件钉死的 Bun 驱动行为，见 MT034 注释）。 */
const jsonbDocument = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb";
  },
});

// MT068（Issue #111）：清理、保留与恢复带可核验归属与不可伪造 manifest。
// expand-only。
//
// 票面：purge、retention 与 restore 操作都携带归属与发起权限，并以不可
// 伪造的 manifest 限定范围；不会仅凭 user_id 扫遍所有公司的外部文件或
// 凭据。
//
// 两张表（与 migrate-test 的 MT068 任务一一对应）：
//
//   1. enterprise_purge_manifests —— 一行 = 一份服务端生成的操作清单。
//      operation purge/retention/restore 闭集；归属键 (tenant, workspace?)
//      复合外键内嵌 tenant_id；item_refs 是服务端枚举的范围资源清单
//      （jsonb 数组形状 CHECK）；signature 是服务端密钥对规范序列化的
//      HMAC-SHA256（64 位十六进制 CHECK）；status sealed/executed/failed
//      闭集 + 行形 CHECK；幂等键 (tenant, idempotency_key) 唯一——同键
//      重跑收敛到同一 manifest。data 只读；operator 读 + 写（签名与执行
//      都走受限 operator 通道，客户端不存在任何写入通道）。
//
//   2. enterprise_purge_audit —— 只追加审计行：event sealed/executed/
//      restored/failed 闭集；detail 闭形（对象且禁秘密载体键）；零
//      UPDATE/DELETE（任何角色），operator 只插 + 读。
export const enterprisePurgeManifests = pgTable(
  "enterprise_purge_manifests",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    operation: text("operation").notNull(),
    workspaceId: text("workspace_id"),
    principalId: text("principal_id").notNull(),
    itemRefs: jsonbDocument("item_refs").notNull(),
    signature: text("signature").notNull(),
    status: text("status").notNull().default("sealed"),
    idempotencyKey: text("idempotency_key").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    check(
      "enterprise_purge_manifest_operation",
      sql`${table.operation} in ('purge', 'retention', 'restore')`,
    ),
    check(
      "enterprise_purge_manifest_status",
      sql`${table.status} in ('sealed', 'executed', 'failed')`,
    ),
    check(
      "enterprise_purge_manifest_signature_shape",
      sql`${table.signature} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "enterprise_purge_manifest_items_shape",
      sql`jsonb_typeof(${table.itemRefs}) = 'array'`,
    ),
    check(
      "enterprise_purge_manifest_execution_shape",
      sql`(${table.status} = 'executed') = (${table.executedAt} is not null)`,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    uniqueIndex("enterprise_purge_manifest_idempotency_idx").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("enterprise_purge_manifest_scope_idx").on(
      table.tenantId,
      table.workspaceId,
      table.operation,
    ),
    pgPolicy("enterprise_purge_manifest_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_purge_manifest_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_purge_manifest_operator_write", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_purge_manifest_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
);

export const enterprisePurgeAudit = pgTable(
  "enterprise_purge_audit",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    manifestId: text("manifest_id").notNull(),
    event: text("event").notNull(),
    actorPrincipalId: text("actor_principal_id").notNull(),
    detail: jsonbDocument("detail").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    check(
      "enterprise_purge_audit_event",
      sql`${table.event} in ('sealed', 'executed', 'restored', 'failed')`,
    ),
    check(
      "enterprise_purge_audit_detail_shape",
      sql`jsonb_typeof(${table.detail}) = 'object'`,
    ),
    check(
      "enterprise_purge_audit_no_secret_carriers",
      sql`not (${table.detail} ? 'secret' or ${table.detail} ? 'password' or ${table.detail} ? 'token' or ${table.detail} ? 'apiKey')`,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.manifestId],
      foreignColumns: [
        enterprisePurgeManifests.tenantId,
        enterprisePurgeManifests.id,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.actorPrincipalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    index("enterprise_purge_audit_manifest_idx").on(
      table.tenantId,
      table.manifestId,
    ),
    pgPolicy("enterprise_purge_audit_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_purge_audit_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
);
