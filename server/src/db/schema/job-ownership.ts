import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// MT041（Issue #84）：任务、运行、触发与租约的原始归属与配置版本快照。
//
// 三张新表，expand-only——不修改任何既有表/策略/授权。归属经「受约束关
// 联」（Spec §4.2「业务运行、用量、任务、产物及事件：固定记录或受约束关
// 联公司、团队、发起主体及业务对象，关联不得跨公司或跨团队漂移」）：
// 业务对象以 (kind, object_id) 关联到归属行，归属行复合外键同时证明
// workspace 属于该公司、principal 是该公司成员。
//
// 归属是创建时一次写入的事实：迁移只授 operator INSERT+SELECT，不授任何
// 角色 UPDATE/DELETE——归属不可改写是 DB 结构，不只是服务纪律。
//
// RLS 沿 enterprise-tenancy.ts 既有模式：data 角色租户范围 SELECT（列表/
// 详情读取路径），operator 角色租户范围读 + INSERT（pin/认领/快照写入路
// 径）；租约的认领/续约/完结另授 operator UPDATE（仅 job_leases）。

/** 一个业务对象的创建时归属：公司 + 团队 + 发起主体，一次写入永不改写。 */
export const jobOwnership = pgTable(
  "job_ownership",
  {
    /** 封闭词表：task / run / trigger（租约不设 kind——租约只存在于已 pin 的 job 上）。 */
    kind: text("kind").notNull(),
    /** 业务对象 id（任务/运行/触发记录自己的权威主键）。 */
    objectId: text("object_id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id")
      .notNull()
      .references(() => enterprisePrincipals.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.objectId] }),
    // 复合关联同时证明：workspace 属于该公司（Spec §4.1）。
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    // 复合关联同时证明：principal 是该公司的成员（成员资格暂停是状态位，
    // 行不删除，FK 存活；离职删行时归属随删——无主归属不会残留）。
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    index("job_ownership_scope_created_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
    ),
    pgPolicy("job_ownership_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("job_ownership_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("job_ownership_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/** 执行依据快照：append-only 的配置版本事实（creation 每 job 一行 + execution 追加）。 */
export const jobConfigSnapshots = pgTable(
  "job_config_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    kind: text("kind").notNull(),
    objectId: text("object_id").notNull(),
    purpose: text("purpose").notNull(),
    /** 正在生效的公司配置版本标识（enterprise_runtime_configs.revision）。 */
    companyRevision: integer("company_revision").notNull(),
    /** 团队覆盖版本；无覆盖为 null（版本存在性是事实，不用 0 冒充）。 */
    overrideRevision: integer("override_revision"),
    /** 解析后依据文档的确定性 canonical JSON SHA-256（绑定内容，不只是版本号）。 */
    basisDigest: text("basis_digest").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.kind, table.objectId],
      foreignColumns: [jobOwnership.kind, jobOwnership.objectId],
    }).onDelete("cascade"),
    check(
      "job_config_snapshots_purpose",
      sql`${table.purpose} in ('creation', 'execution')`,
    ),
    check(
      "job_config_snapshots_company_revision",
      sql`${table.companyRevision} > 0`,
    ),
    check(
      "job_config_snapshots_override_revision",
      sql`${table.overrideRevision} is null or ${table.overrideRevision} > 0`,
    ),
    // 每个 job 恰好一行 creation 快照；execution 快照按次追加。
    uniqueIndex("job_config_snapshots_creation_unique")
      .on(table.kind, table.objectId)
      .where(sql`${table.purpose} = 'creation'`),
    index("job_config_snapshots_history_idx").on(
      table.kind,
      table.objectId,
      table.capturedAt,
    ),
    pgPolicy("job_config_snapshots_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`exists (select 1 from job_ownership where job_ownership.kind = job_config_snapshots.kind and job_ownership.object_id = job_config_snapshots.object_id and job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), ''))`,
    }),
    pgPolicy("job_config_snapshots_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`exists (select 1 from job_ownership where job_ownership.kind = job_config_snapshots.kind and job_ownership.object_id = job_config_snapshots.object_id and job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), ''))`,
    }),
    pgPolicy("job_config_snapshots_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`exists (select 1 from job_ownership where job_ownership.kind = job_config_snapshots.kind and job_ownership.object_id = job_config_snapshots.object_id and job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), ''))`,
    }),
  ],
).enableRLS();

/**
 * 归属内租约：一个 job 同一时刻至多一个活租约；认领经归属三比（RLS 租户
 * 臂 + workspace 与 pin 逐字相等 + 执行者匹配）。租约行只存在于已 pin 的
 * job 上（复合 FK），tenant/workspace 与归属行一致（复合 FK 到 workspace
 * + 服务层比对）。
 */
export const jobLeases = pgTable(
  "job_leases",
  {
    kind: text("kind").notNull(),
    objectId: text("object_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    /** 执行者身份：worker（平台受限执行身份）或 principal（发起主体本人）。 */
    claimedByKind: text("claimed_by_kind"),
    claimedBy: text("claimed_by"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /** 已被交出去过多少次（含当前）。重认领不是新任务。 */
    attempts: integer("attempts").notNull().default(0),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.objectId] }),
    foreignKey({
      columns: [table.kind, table.objectId],
      foreignColumns: [jobOwnership.kind, jobOwnership.objectId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    check(
      "job_leases_claimed_by_kind",
      sql`${table.claimedByKind} is null or ${table.claimedByKind} in ('worker', 'principal')`,
    ),
    check(
      "job_leases_claimed_row_shape",
      sql`(${table.claimedByKind} is null and ${table.claimedBy} is null and ${table.leaseUntil} is null) or (${table.claimedByKind} is not null and ${table.claimedBy} is not null and ${table.leaseUntil} is not null)`,
    ),
    check("job_leases_attempts_non_negative", sql`${table.attempts} >= 0`),
    pgPolicy("job_leases_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`job_leases.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("job_leases_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`job_leases.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("job_leases_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`job_leases.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("job_leases_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`job_leases.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`job_leases.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();
