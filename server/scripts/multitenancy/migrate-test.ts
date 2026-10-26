// server/scripts/multitenancy/migrate-test.ts
// MT003（Issue #46）：按任务生成迁移的安全迁移工具（dry-run/apply + manifest）。
//
// 这是多租户整改的「按任务迁移」执行工具，仅供测试数据库使用：
//
//   - 命令面收敛为两个：`generate`（把任务迁移物化为带编号的 SQL 文件与
//     manifest）和 `migrate`（默认 dry-run 展示计划；`--apply --manifest`
//     才执行）。未知命令、未知 task id、未知旗标一律在参数阶段拒绝。
//   - task id 来自本文件内的显式枚举注册表（TASKS）。本 Ticket 只交付
//     工具与自检任务 MT000，不编写任何业务迁移；后续 Ticket 在注册表
//     中追加自己的任务条目。
//   - 数据库配置只读 TEST_DATABASE_URL：缺失、非回环主机、非
//     openbot_enterprise_* 命名、非法协议/URL 一律带理由拒绝，绝不回退
//     DATABASE_URL、不加载 .env、没有隐式默认。拒绝发生在任何连接/文件
//     副作用之前。URL 解析复用 server/scripts/runtime-test-environment.ts
//     的 seam（只读 TEST_DATABASE_URL），命名/回环校验遵循
//     server/tests/support/enterprise-database.ts 的模式。
//   - 编号规则：每个任务的步骤编号从 0001 起严格递增且连续；文件名固定
//     为 `NNNN_<taskid小写>_<slug>.sql`（不含时间戳，确定性）。计划、
//     测试库 journal、已生成文件三处都会检测重复编号与断号。
//   - apply 门禁：`--apply` 必须携带 manifest 文件，且其 taskId、步骤
//     名、编号与语句 digest 与当前计划完全一致，否则拒绝。每个步骤在
//     自己的事务内执行并写 journal（mt_task_migration_journal，
//     工具自有表），中断可安全重放。
//
// 用法（显式环境，建议 --no-env-file 避免 Bun 自动读取 .env）：
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/openbot_enterprise_mt003_test \
//     bun --no-env-file server/scripts/multitenancy/migrate-test.ts migrate MT000
//   ... migrate-test.ts migrate MT000 --apply --manifest <manifest.json>
//   ... migrate-test.ts generate MT000 --out <dir>
//

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { runtimeTestEnvironment } from "../runtime-test-environment";

// ---------------------------------------------------------------------------
// 任务注册表（显式枚举；本 Ticket 不编写业务迁移）
// ---------------------------------------------------------------------------

export interface TaskMigrationStep {
  /** 固定 slug，参与确定性文件名 NNNN_<taskid>_<slug>.sql；同任务内唯一。 */
  readonly slug: string;
  /** 人类可读的影响说明，dry-run 摘要逐条展示。 */
  readonly impact: string;
  /** 本步骤涉及的数据库对象（表/模式名），仅用于影响摘要。 */
  readonly objects: readonly string[];
  /** 逐条执行的 SQL 语句；顺序即执行顺序。 */
  readonly statements: readonly string[];
}

export interface TaskMigrationSpec {
  readonly id: string;
  readonly description: string;
  readonly steps: readonly TaskMigrationStep[];
}

/**
 * 工具自检任务：只用工具自己的临时表证明 generate/编号/dry-run/manifest/
 * apply/重放链路可用。它不是业务迁移，结束后不残留业务外对象
 * （只剩 journal 表）。真实 apply 测试只允许打到本任务专属测试库。
 */
const SELF_CHECK_TASK: TaskMigrationSpec = {
  id: "MT000",
  description:
    "迁移工具自检（非业务迁移）：创建/校验/删除工具自有临时表，证明链路可用。",
  steps: [
    {
      slug: "selfcheck_table",
      impact:
        "创建工具自检临时表 mt_tool_selfcheck 并写入一行标记（工具自有，非业务表）。",
      objects: ["mt_tool_selfcheck"],
      statements: [
        "CREATE TABLE mt_tool_selfcheck (id integer PRIMARY KEY, note text NOT NULL);",
        "INSERT INTO mt_tool_selfcheck (id, note) VALUES (1, 'multitenancy migrate-test self-check');",
      ],
    },
    {
      slug: "selfcheck_assert",
      impact: "DO 块校验自检行存在，证明步骤顺序与事务边界真实生效。",
      objects: ["mt_tool_selfcheck"],
      statements: [
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM mt_tool_selfcheck) THEN RAISE EXCEPTION 'mt_tool_selfcheck row missing: step ordering broken'; END IF; END $$;",
      ],
    },
    {
      slug: "selfcheck_drop",
      impact: "删除自检临时表；任务结束时测试库不残留业务外对象。",
      objects: ["mt_tool_selfcheck"],
      statements: ["DROP TABLE mt_tool_selfcheck;"],
    },
  ],
};

/**
 * MT004（Issue #47）：企业团队成员关系表。expand-only——纯新增
 * enterprise_workspace_memberships（唯一 (tenant, workspace, principal)、
 * 复合外键同时证明 workspace 属 tenant 与 principal 是该 tenant 成员、
 * active/suspended 状态、正整数 epoch）与按既有模式的最小 RLS 策略；
 * 不修改任何既有表/策略/角色授权。
 *
 * 已知并发局限（复审 F2）：epoch 的 read-then-increase 非原子——并发
 * 写者可读到同一 current epoch 并写出重复值；串行化/重试责任归应用写入
 * 路径（MT005 消费契约将接管）。
 */
const WORKSPACE_MEMBERSHIP_TASK: TaskMigrationSpec = {
  id: "MT004",
  description:
    "MT004（Issue #47）：新增企业团队成员关系表 enterprise_workspace_memberships（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "create_table",
      impact:
        "新增 enterprise_workspace_memberships 表：复合主键 (tenant_id, workspace_id, principal_id) 即唯一成员关系；principal 侧唯一索引；status/epoch CHECK；两条复合外键分别指向 enterprise_workspaces 与 enterprise_memberships（同时证明 workspace 属该公司、principal 是该公司成员）。不修改任何既有表。",
      objects: ["enterprise_workspace_memberships"],
      statements: [
        'CREATE TABLE "enterprise_workspace_memberships" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'active' NOT NULL,\n" +
          '\t"epoch" integer DEFAULT 1 NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_workspace_memberships_tenant_id_workspace_id_principal_id_pk" PRIMARY KEY("tenant_id","workspace_id","principal_id"),\n' +
          '\tCONSTRAINT "enterprise_workspace_member_status" CHECK ("enterprise_workspace_memberships"."status" in (\'active\',\'suspended\')),\n' +
          '\tCONSTRAINT "enterprise_workspace_member_epoch" CHECK ("enterprise_workspace_memberships"."epoch" > 0)\n' +
          ");",
        'ALTER TABLE "enterprise_workspace_memberships" ADD CONSTRAINT "enterprise_workspace_memberships_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workspace_memberships" ADD CONSTRAINT "enterprise_workspace_memberships_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE UNIQUE INDEX "enterprise_workspace_membership_principal_tenant" ON "enterprise_workspace_memberships" USING btree ("principal_id","tenant_id","workspace_id");',
      ],
    },
    {
      slug: "rls_policies",
      impact:
        "仅对新表：REVOKE PUBLIC、启用 RLS、按既有模式新增 5 条最小策略（directory self-read / data read / operator read+insert+update）及配套最小 GRANT（SELECT、operator INSERT、operator UPDATE(status, epoch)）；不改动任何既有表策略或既有授权。",
      objects: ["enterprise_workspace_memberships"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_workspace_memberships" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_workspace_memberships" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_workspace_memberships" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_workspace_membership_self_read" ON "enterprise_workspace_memberships"\n' +
          "  FOR SELECT TO ob_ent_directory\n" +
          "  USING (EXISTS (\n" +
          '    SELECT 1 FROM "enterprise_principals" p\n' +
          '    WHERE p."id" = "enterprise_workspace_memberships"."principal_id"\n' +
          "      AND p.\"user_id\" = nullif(current_setting('app.user_id', true), '')\n" +
          "  ));",
        'CREATE POLICY "enterprise_workspace_membership_data_read" ON "enterprise_workspace_memberships"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_workspace_memberships\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_workspace_memberships\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
        'CREATE POLICY "enterprise_workspace_membership_operator_read" ON "enterprise_workspace_memberships"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_workspace_memberships\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_workspace_membership_operator_insert" ON "enterprise_workspace_memberships"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_workspace_memberships\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_workspace_membership_operator_update" ON "enterprise_workspace_memberships"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_workspace_memberships\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_workspace_memberships\".\"principal_id\" = nullif(current_setting('app.operator_principal_id', true), ''))\n" +
          "  WITH CHECK (\"enterprise_workspace_memberships\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_workspace_memberships\".\"principal_id\" = nullif(current_setting('app.operator_principal_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_workspace_memberships" TO ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_workspace_memberships" TO ob_ent_operator;',
        'GRANT UPDATE ("status", "epoch") ON TABLE "enterprise_workspace_memberships" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT112（执行轮 Ticket）：历史部署的「原有公司 + 默认团队」锚点创建。
 * 与 MT004 的纯 DDL 不同，本任务含数据创建（幂等写入锚点实体）。
 *
 * expand-only：不修改任何既有表/策略/角色授权；新表与数据行全部纯追加。
 * 勘察结论（详见 reports/MT112.md）：部署身份 = deployment_packages.tenant_id
 * （启动时由 synchronizeTenantPackage 持久化，UNIQUE）；计费 Customer 键 =
 * deploymentExternalCustomerId(tenantId) = 'openbot-deployment-' || tenantId
 * （src/billing/service.ts 唯一定义点）。企业域既有表中无部署映射表，
 * 故新增最小映射表 enterprise_deployment_anchors（tenant 主键 + 部署身份/
 * 计费键两个方向唯一索引 + 派生 CHECK），映射两侧都可 JOIN 核验。
 *
 * 幂等策略（绝不先查后插）：锚点实体全部用确定性固定 id +
 * ON CONFLICT … DO NOTHING；重复 apply（或步骤原样重放）不产生重复实体。
 * 成员锚点 = 全库最早用户（ORDER BY created_at, id LIMIT 1，确定性规则）
 * 的 tenant_admin 成员资格 + 默认团队 workspace 成员资格；无用户时插入
 * 0 行（无成员可锚定，不臆造用户）。部署身份锚点取 loaded_at 最早的
 * deployment_packages 行（历史部署的原始身份；brand 迁移可能留下多行）。
 * 已知边界（诚实披露）：DEPLOYMENT_ID 环境变量覆盖部署身份时，迁移侧
 * 只能看到持久化身份（deployment_packages.tenant_id），派生键以持久化
 * 身份为准；生产执行不在本 Ticket 范围。
 */
const LEGACY_ANCHOR_TASK: TaskMigrationSpec = {
  id: "MT112",
  description:
    "MT112（执行轮）：历史部署「原有公司 + 默认团队」锚点——expand-only 新增映射表 enterprise_deployment_anchors，并幂等写入锚点数据（原有公司租户行、默认团队 workspace 行、最早用户的成员锚点、与部署身份及计费 Customer 的唯一映射）",
  steps: [
    {
      slug: "anchor_mapping_table",
      impact:
        "新增 enterprise_deployment_anchors 表：tenant_id 主键（FK → enterprise_tenants，cascade）；deployment_tenant_id 与 billing_external_customer_id 两个方向唯一索引；派生 CHECK 保证计费键 = 'openbot-deployment-' || 部署身份。不修改任何既有表。",
      objects: ["enterprise_deployment_anchors"],
      statements: [
        'CREATE TABLE "enterprise_deployment_anchors" (\n' +
          '\t"tenant_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"deployment_tenant_id" text NOT NULL,\n' +
          '\t"billing_external_customer_id" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_deployment_anchors_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action\n' +
          ");",
        'CREATE UNIQUE INDEX "enterprise_deployment_anchor_identity" ON "enterprise_deployment_anchors" USING btree ("deployment_tenant_id");',
        'CREATE UNIQUE INDEX "enterprise_deployment_anchor_billing_customer" ON "enterprise_deployment_anchors" USING btree ("billing_external_customer_id");',
        'ALTER TABLE "enterprise_deployment_anchors" ADD CONSTRAINT "enterprise_deployment_anchor_billing_derivation" CHECK ("billing_external_customer_id" = \'openbot-deployment-\' || "deployment_tenant_id");',
      ],
    },
    {
      slug: "anchor_rls_policies",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增 1 条 operator 租户范围 SELECT 策略及配套 GRANT。不授予任何受限角色 INSERT/UPDATE——锚点行只能由本迁移写入。不改动任何既有表策略或既有授权。",
      objects: ["enterprise_deployment_anchors"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_deployment_anchors" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_deployment_anchors" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_deployment_anchors" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_deployment_anchor_operator_read" ON "enterprise_deployment_anchors"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_deployment_anchors\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_deployment_anchors" TO ob_ent_operator;',
      ],
    },
    {
      slug: "legacy_anchor_rows",
      impact:
        "幂等写入「原有公司」租户行（ent-legacy-original）、「默认团队」workspace 行（ent-legacy-default-team）与成员锚点（全库最早用户：tenant_admin 成员资格 + 默认团队 workspace 成员资格）。全部 ON CONFLICT DO NOTHING，重复执行零重复；无用户时成员锚点插入 0 行。",
      objects: [
        "enterprise_tenants",
        "enterprise_workspaces",
        "enterprise_principals",
        "enterprise_memberships",
        "enterprise_workspace_memberships",
        "users",
      ],
      statements: [
        'INSERT INTO "enterprise_tenants" ("id", "name") VALUES (\'ent-legacy-original\', \'原有公司\') ON CONFLICT ("id") DO NOTHING;',
        'INSERT INTO "enterprise_workspaces" ("tenant_id", "id", "name") VALUES (\'ent-legacy-original\', \'ent-legacy-default-team\', \'默认团队\') ON CONFLICT ("tenant_id", "id") DO NOTHING;',
        'INSERT INTO "enterprise_principals" ("id", "user_id")\n' +
          '\tSELECT \'entp-legacy-anchor-\' || anchor_user."id", anchor_user."id"\n' +
          '\tFROM (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1) AS anchor_user\n' +
          '\tON CONFLICT ("id") DO NOTHING;',
        'INSERT INTO "enterprise_memberships" ("tenant_id", "principal_id", "role")\n' +
          "\tSELECT 'ent-legacy-original', \"enterprise_principals\".\"id\", 'tenant_admin'\n" +
          '\tFROM "enterprise_principals"\n' +
          '\tWHERE "enterprise_principals"."id" = \'entp-legacy-anchor-\' || (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1)\n' +
          '\tON CONFLICT ("tenant_id", "principal_id") DO NOTHING;',
        'INSERT INTO "enterprise_workspace_memberships" ("tenant_id", "workspace_id", "principal_id")\n' +
          "\tSELECT 'ent-legacy-original', 'ent-legacy-default-team', \"enterprise_principals\".\"id\"\n" +
          '\tFROM "enterprise_principals"\n' +
          '\tWHERE "enterprise_principals"."id" = \'entp-legacy-anchor-\' || (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1)\n' +
          '\tON CONFLICT ("tenant_id", "workspace_id", "principal_id") DO NOTHING;',
      ],
    },
    {
      slug: "anchor_mapping_row",
      impact:
        "幂等写入锚点映射行：原有公司租户 ↔ loaded_at 最早的 deployment_packages 身份（历史部署的原始身份）↔ 派生计费 Customer 键。tenant 主键冲突即 no-op；两个方向唯一索引拒绝第二个租户认领同一部署身份或计费 Customer。",
      objects: ["enterprise_deployment_anchors", "deployment_packages"],
      statements: [
        'INSERT INTO "enterprise_deployment_anchors" ("tenant_id", "deployment_tenant_id", "billing_external_customer_id")\n' +
          "\tSELECT 'ent-legacy-original', pkg.\"tenant_id\", 'openbot-deployment-' || pkg.\"tenant_id\"\n" +
          '\tFROM (SELECT "tenant_id" FROM "deployment_packages" ORDER BY "loaded_at" ASC, "tenant_id" ASC LIMIT 1) AS pkg\n' +
          '\tON CONFLICT ("tenant_id") DO NOTHING;',
      ],
    },
  ],
};

/**
 * MT114（Issue #157）：主库子记录回填第一批的批次进度表。
 * expand-only——仅新增 enterprise_backfill_batches（一行 = 一个批次 × 一个
 * 子记录类别的进度与游标），不修改任何既有表/策略/授权。进度行由回填
 * 工具在 setup/属主通道与数据写入同一事务内推进（游标+计数同事务提交，
 * 崩溃后从游标续跑；ON CONFLICT 幂等写入保证重放零重复），受限角色只有
 * 租户无关的只读（进度是部署级迁移事实，不含租户业务数据）。本表就是
 * 票面「可中断续跑且不重复写入」与「进度与计数校验报告」的持久半边，
 * 后续批次（MT115/MT116）与跨库一致性校验（MT117）按同一表继续记。
 */
const CHILD_BACKFILL_PROGRESS_TASK: TaskMigrationSpec = {
  id: "MT114",
  description:
    "MT114（Issue #157）：子记录回填批次进度表 enterprise_backfill_batches——expand-only 新增（batch_id+kind 主键、running/completed 相位、last_cursor 游标、五路计数、resumes 次数），受限 operator 只读，无 INSERT/UPDATE 授权（进度只由回填工具的事务推进）。",
  steps: [
    {
      slug: "child_backfill_progress_table",
      impact:
        "新增 enterprise_backfill_batches 表：PK(batch_id, kind)；phase CHECK(running|completed)；计数列非负 CHECK；updated_at。不修改任何既有表。",
      objects: ["enterprise_backfill_batches"],
      statements: [
        'CREATE TABLE "enterprise_backfill_batches" (\n' +
          '\t"batch_id" text NOT NULL,\n' +
          '\t"kind" text NOT NULL,\n' +
          "\t\"phase\" text DEFAULT 'running' NOT NULL,\n" +
          '\t"last_cursor" text,\n' +
          '\t"scanned" integer DEFAULT 0 NOT NULL,\n' +
          '\t"applied" integer DEFAULT 0 NOT NULL,\n' +
          '\t"skipped_existing" integer DEFAULT 0 NOT NULL,\n' +
          '\t"mismatch_reported" integer DEFAULT 0 NOT NULL,\n' +
          '\t"quarantined" integer DEFAULT 0 NOT NULL,\n' +
          '\t"written_rows" integer DEFAULT 0 NOT NULL,\n' +
          '\t"resumes" integer DEFAULT 0 NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_backfill_batches_batch_id_kind_pk" PRIMARY KEY("batch_id","kind"),\n' +
          '\tCONSTRAINT "enterprise_backfill_batch_phase" CHECK ("enterprise_backfill_batches"."phase" in (\'running\', \'completed\')),\n' +
          '\tCONSTRAINT "enterprise_backfill_batch_counts" CHECK ("enterprise_backfill_batches"."scanned" >= 0 and "enterprise_backfill_batches"."applied" >= 0 and "enterprise_backfill_batches"."skipped_existing" >= 0 and "enterprise_backfill_batches"."mismatch_reported" >= 0 and "enterprise_backfill_batches"."quarantined" >= 0 and "enterprise_backfill_batches"."written_rows" >= 0 and "enterprise_backfill_batches"."resumes" >= 0)\n' +
          ");",
      ],
    },
    {
      slug: "child_backfill_progress_rls",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、operator 全表只读策略与 GRANT SELECT。不授予任何受限角色 INSERT/UPDATE/DELETE——进度只由回填工具的事务推进。",
      objects: ["enterprise_backfill_batches"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_backfill_batches" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_backfill_batches" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_backfill_batches" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_backfill_batch_operator_read" ON "enterprise_backfill_batches"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (true);",
        'GRANT SELECT ON TABLE "enterprise_backfill_batches" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT008（Issue #51）：资源可见性属性。expand-only——仅在既有表
 * enterprise_resources 上追加可空列 visibility（NULL=未标记/遗留，
 * 'private'=个人，'workspace'=团队公共；CHECK 兑底取值域）并给受限
 * operator 角色补该列的列级 UPDATE 授权。既有 UPDATE 行策略
 * enterprise_resource_operator_update（app.tenant_id + app.resource_id
 * 匹配行）不变；不修改任何既有列/约束/策略/授权。策略版本注册表与
 * 判定入口在 server/src/enterprise/tenancy/resource-policy.ts；
 * 遗留→团队公共的显式迁移入口在 resource-visibility.ts（只按显式清单
 * 执行，无清单/空清单零写入）。
 */
const RESOURCE_VISIBILITY_TASK: TaskMigrationSpec = {
  id: "MT008",
  description:
    "MT008（Issue #51）：enterprise_resources 追加可空列 visibility（expand-only，不改任何既有对象/策略）+ operator 列级 UPDATE 授权。",
  steps: [
    {
      slug: "resource_visibility_column",
      impact:
        "仅为既有表 enterprise_resources 追加可空列 visibility 与取值域 CHECK（NULL/'private'/'workspace'）。既有行全部落 NULL（未标记=遗留行为不变）。不修改任何既有列/约束/策略/授权。",
      objects: ["enterprise_resources"],
      statements: [
        'ALTER TABLE "enterprise_resources" ADD COLUMN "visibility" text;',
        'ALTER TABLE "enterprise_resources" ADD CONSTRAINT "enterprise_resource_visibility" CHECK ("visibility" is null or "visibility" in (\'private\', \'workspace\'));',
      ],
    },
    {
      slug: "visibility_operator_grant",
      impact:
        "给受限 operator 角色补 visibility 列的列级 UPDATE 授权（配合既有 operator UPDATE 行策略：app.tenant_id + app.resource_id 匹配行）。不授予其它任何权限，不改任何策略。",
      objects: ["enterprise_resources"],
      statements: [
        'GRANT UPDATE ("visibility") ON TABLE "enterprise_resources" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT012（Issue #55）：核心租户域表的 RLS 兜底与上下文清理。expand-only
 * ——两件事，不 DROP/不改动任何既有对象：
 *
 *   1. 对全部核心租户域表（0056 基线七表 + MT004 workspace membership +
 *      MT112 deployment anchor）再断言 ENABLE + FORCE ROW LEVEL SECURITY。
 *      幂等重断言：已启用的库上为 no-op，但把「核心表必须需 RLS」固化为
 *      本任务的可重放清单（FORCE 对表主同样生效——主应用连接即使拥有
 *      表也无法绕过策略）。
 *   2. 新增会话级业务上下文清理函数 ob_ent_reset_business_context()
 *      （把策略消费的全部 app.* 键写回空串）并只授予三个受限业务角色
 *      EXECUTE：业务事务用事务本地 set_config（提交/回滚自动清除），
 *      本函数是连接池回收前对意外会话级残留的兜底清理工具。REVOKE
 *      EXECUTE ... FROM PUBLIC 只收窄函数的默认 PUBLIC 执行权（新对象
 *      自身的默认值），不剥夺任何既有授权。
 */
const CORE_RLS_TASK: TaskMigrationSpec = {
  id: "MT012",
  description:
    "MT012（Issue #55）：核心租户域表 RLS 再断言（ENABLE+FORCE）+ 会话级上下文清理函数（expand-only，不改任何既有对象/策略/授权）。",
  steps: [
    {
      slug: "core_rls_enable",
      impact:
        "对九张核心租户域表（tenants/principals/memberships/workspaces/resources/grants/security_events/workspace_memberships/deployment_anchors）幂等再断言 ENABLE + FORCE ROW LEVEL SECURITY。不新增/删除/改写任何策略或授权。",
      objects: [
        "enterprise_tenants",
        "enterprise_principals",
        "enterprise_memberships",
        "enterprise_workspaces",
        "enterprise_resources",
        "enterprise_resource_grants",
        "enterprise_security_events",
        "enterprise_workspace_memberships",
        "enterprise_deployment_anchors",
      ],
      statements: [
        'ALTER TABLE "enterprise_tenants" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_tenants" FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_principals" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_principals" FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_memberships" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_memberships" FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_workspaces" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_workspaces" FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_resources" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_resources" FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_resource_grants" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_resource_grants" FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_security_events" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_security_events" FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_workspace_memberships" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_workspace_memberships" FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_deployment_anchors" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_deployment_anchors" FORCE ROW LEVEL SECURITY;',
      ],
    },
    {
      slug: "context_reset_function",
      impact:
        "新增函数 ob_ent_reset_business_context()：把策略消费的七个 app.* 上下文键会话级写回空串（池回收前的兜底清理）。REVOKE EXECUTE FROM PUBLIC 只收窄新函数的默认 PUBLIC 执行权；EXECUTE 只授予三个受限业务角色（不授予平台机器读角色 ob_ent_identity_operator）。",
      objects: ["ob_ent_reset_business_context"],
      statements: [
        "CREATE OR REPLACE FUNCTION \"public\".\"ob_ent_reset_business_context\"() RETURNS void LANGUAGE sql AS $func$ SELECT set_config('app.tenant_id', '', false), set_config('app.principal_id', '', false), set_config('app.user_id', '', false), set_config('app.workspace_id', '', false), set_config('app.operation_id', '', false), set_config('app.resource_id', '', false), set_config('app.operator_principal_id', '', false) $func$;",
        'REVOKE EXECUTE ON FUNCTION "public"."ob_ent_reset_business_context"() FROM PUBLIC;',
        'GRANT EXECUTE ON FUNCTION "public"."ob_ent_reset_business_context"() TO ob_ent_directory, ob_ent_data, ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT014（Issue #57）：公司运行配置装配的存储面。expand-only——两张新表
 * （企业运行配置 + 团队覆盖）与按既有模式的最小 RLS；不修改任何既有
 * 表/策略/角色授权。文档列只存引用，凭据值永不进配置文档；读取路径经
 * 受限 data 角色 + 事务本地租户上下文（解析服务在 runtime-config.ts）。
 */
const RUNTIME_CONFIG_TASK: TaskMigrationSpec = {
  id: "MT014",
  description:
    "MT014（Issue #57）：公司运行配置装配——新增 enterprise_runtime_configs 与 enterprise_runtime_config_overrides（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "runtime_config_tables",
      impact:
        "新增两张表：enterprise_runtime_configs（一行 = 一家公司的运行配置文档 + 版本号，FK → enterprise_tenants cascade）与 enterprise_runtime_config_overrides（一行 = 一个团队对公司配置的收窄覆盖 + 版本号，复合 FK → enterprise_workspaces）。文档列为 jsonb 且只存引用。不修改任何既有表。",
      objects: [
        "enterprise_runtime_configs",
        "enterprise_runtime_config_overrides",
      ],
      statements: [
        'CREATE TABLE "enterprise_runtime_configs" (\n' +
          '\t"tenant_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"document" jsonb NOT NULL,\n' +
          '\t"revision" integer DEFAULT 1 NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_runtime_config_revision" CHECK ("enterprise_runtime_configs"."revision" > 0)\n' +
          ");",
        'ALTER TABLE "enterprise_runtime_configs" ADD CONSTRAINT "enterprise_runtime_configs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'CREATE TABLE "enterprise_runtime_config_overrides" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"document" jsonb NOT NULL,\n' +
          '\t"revision" integer DEFAULT 1 NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_runtime_config_overrides_tenant_id_workspace_id_pk" PRIMARY KEY("tenant_id","workspace_id"),\n' +
          '\tCONSTRAINT "enterprise_runtime_config_override_revision" CHECK ("enterprise_runtime_config_overrides"."revision" > 0)\n' +
          ");",
        'ALTER TABLE "enterprise_runtime_config_overrides" ADD CONSTRAINT "enterprise_runtime_config_overrides_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "runtime_config_rls",
      impact:
        "仅对两张新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 角色租户范围 SELECT；operator 角色租户范围读 + INSERT/UPDATE，override 的 UPDATE 另要求 workspace 上下文）及配套最小 GRANT；不改动任何既有表策略或既有授权。目录角色无任何策略与授权（配置不是逐主体目录数据）。",
      objects: [
        "enterprise_runtime_configs",
        "enterprise_runtime_config_overrides",
      ],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_runtime_configs" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_runtime_configs" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_runtime_configs" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_runtime_config_data_read" ON "enterprise_runtime_configs"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_runtime_configs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_runtime_config_operator_read" ON "enterprise_runtime_configs"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_runtime_configs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_runtime_config_operator_insert" ON "enterprise_runtime_configs"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_runtime_configs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_runtime_config_operator_update" ON "enterprise_runtime_configs"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_runtime_configs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))\n" +
          "  WITH CHECK (\"enterprise_runtime_configs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_runtime_configs" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_runtime_configs" TO ob_ent_operator;',
        'GRANT UPDATE ("document", "revision", "updated_at") ON TABLE "enterprise_runtime_configs" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_runtime_config_overrides" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_runtime_config_overrides" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_runtime_config_overrides" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_runtime_config_override_data_read" ON "enterprise_runtime_config_overrides"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_runtime_config_overrides\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_runtime_config_override_operator_read" ON "enterprise_runtime_config_overrides"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_runtime_config_overrides\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_runtime_config_override_operator_insert" ON "enterprise_runtime_config_overrides"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_runtime_config_overrides\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_runtime_config_override_operator_update" ON "enterprise_runtime_config_overrides"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_runtime_config_overrides\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_runtime_config_overrides\".\"workspace_id\" = nullif(current_setting('app.workspace_id', true), ''))\n" +
          "  WITH CHECK (\"enterprise_runtime_config_overrides\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_runtime_config_overrides\".\"workspace_id\" = nullif(current_setting('app.workspace_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_runtime_config_overrides" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_runtime_config_overrides" TO ob_ent_operator;',
        'GRANT UPDATE ("document", "revision", "updated_at") ON TABLE "enterprise_runtime_config_overrides" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT009（Issue #52）：团队公共资源依赖表。expand-only——仅新增
 * enterprise_resource_dependencies（资源 → 声明依赖的引用行：模型/凭据/
 * 知识范围；CHECK 兑底取值域与非空引用；复合外键指向 enterprise_resources，
 * 资源删除时依赖行级联）与按既有模式的最小 RLS 策略与授权（data 只读、
 * operator 读+插，无 UPDATE/DELETE——依赖失效以新状态行/软删除表达）。
 * 不修改任何既有表/策略/角色授权。动作规则模块在
 * server/src/enterprise/tenancy/team-public-rules.ts：run 动作要求全部
 * 依赖有效（status='active'，知识范围引用还必须在同租户内存活着）。
 */
const RESOURCE_DEPENDENCY_TASK: TaskMigrationSpec = {
  id: "MT009",
  description:
    "MT009（Issue #52）：新增企业资源依赖表 enterprise_resource_dependencies（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "resource_dependency_table",
      impact:
        "新增 enterprise_resource_dependencies 表：复合主键 (tenant_id, resource_id, dependency_kind, dependency_ref)；dependency_kind 限 model/credential/knowledge，status 限 active/invalid，dependency_ref 非空；复合外键指向 enterprise_resources(tenant_id, id) ON DELETE cascade。不修改任何既有表。",
      objects: ["enterprise_resource_dependencies"],
      statements: [
        'CREATE TABLE "enterprise_resource_dependencies" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"resource_id" text NOT NULL,\n' +
          '	"dependency_kind" text NOT NULL,\n' +
          '	"dependency_ref" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'active' NOT NULL,\n" +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_resource_dependencies_tenant_id_resource_id_dependency_kind_dependency_ref_pk" PRIMARY KEY("tenant_id","resource_id","dependency_kind","dependency_ref"),\n' +
          "	CONSTRAINT \"enterprise_resource_dependency_kind\" CHECK (\"enterprise_resource_dependencies\".\"dependency_kind\" in ('model','credential','knowledge')),\n" +
          '	CONSTRAINT "enterprise_resource_dependency_status" CHECK ("enterprise_resource_dependencies"."status" in (\'active\',\'invalid\')),\n' +
          '	CONSTRAINT "enterprise_resource_dependency_ref_present" CHECK ("enterprise_resource_dependencies"."dependency_ref" <> \'\')\n' +
          ");",
        'ALTER TABLE "enterprise_resource_dependencies" ADD CONSTRAINT "enterprise_resource_dependencies_tenant_id_resource_id_enterprise_resources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."enterprise_resources"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "dependency_rls_policies",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增 3 条最小策略（data 租户范围读 / operator 租户范围读+插）及配套最小 GRANT（SELECT 给 data+operator，INSERT 给 operator；不授予 UPDATE/DELETE）。不改动任何既有表策略或既有授权。",
      objects: ["enterprise_resource_dependencies"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_resource_dependencies" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_resource_dependencies" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_resource_dependencies" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_resource_dependency_data_read" ON "enterprise_resource_dependencies"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_resource_dependencies\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_resource_dependency_operator_read" ON "enterprise_resource_dependencies"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_resource_dependencies\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_resource_dependency_operator_insert" ON "enterprise_resource_dependencies"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_resource_dependencies\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_resource_dependencies" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_resource_dependencies" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT010（Issue #53）：个人资源的显式分享事实表。expand-only——纯新增
 * enterprise_resource_shares（复合主键 = (tenant, resource, audience, action)，
 * action 只允许 'read'；expires_at 必须晚于 created_at；三条复合外键内嵌
 * tenant_id，分别证明资源属于该公司、受众与分享人是该公司的有效成员——
 * 跨公司分享行在结构上不可能存在）与按既有模式的最小 RLS 策略；
 * 不修改任何既有表/策略/角色授权。
 *
 * 分享语义：撤销 = 删除行（无可达中间态，立即失效）；有效期由判定入口按
 * 数据库时钟 now() 现场核对。服务层入口在
 * server/src/enterprise/tenancy/personal-share-rules.ts。
 */
const PERSONAL_SHARE_TASK: TaskMigrationSpec = {
  id: "MT010",
  description:
    "MT010（Issue #53）：新增个人资源显式分享表 enterprise_resource_shares（expand-only，仅新增表与最小 RLS，不改既有对象）",
  steps: [
    {
      slug: "create_table",
      impact:
        "新增 enterprise_resource_shares 表：复合主键 (tenant_id, resource_id, principal_id, action)；action CHECK 只允许 'read'（被分享方永远拿不到管理动作）；validity CHECK 要求 expires_at > created_at；三条复合外键分别指向 enterprise_resources 与 enterprise_memberships（受众、分享人各一条，内嵌 tenant_id——跨公司分享行结构上不可能）。不修改任何既有表。",
      objects: ["enterprise_resource_shares"],
      statements: [
        'CREATE TABLE "enterprise_resource_shares" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"resource_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          "\t\"action\" text DEFAULT 'read' NOT NULL,\n" +
          '\t"expires_at" timestamp with time zone NOT NULL,\n' +
          '\t"granted_by" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_resource_shares_tenant_id_resource_id_principal_id_action_pk" PRIMARY KEY("tenant_id","resource_id","principal_id","action"),\n' +
          '\tCONSTRAINT "enterprise_share_action" CHECK ("enterprise_resource_shares"."action" = \'read\'),\n' +
          '\tCONSTRAINT "enterprise_share_validity" CHECK ("enterprise_resource_shares"."expires_at" > "enterprise_resource_shares"."created_at")\n' +
          ");",
        'ALTER TABLE "enterprise_resource_shares" ADD CONSTRAINT "enterprise_resource_shares_tenant_id_resource_id_enterprise_resources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."enterprise_resources"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_resource_shares" ADD CONSTRAINT "enterprise_resource_shares_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_resource_shares" ADD CONSTRAINT "enterprise_resource_shares_tenant_id_granted_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "share_rls_policies",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增 4 条最小策略（data 只读本人行 / operator 租户范围 SELECT+INSERT+DELETE，DELETE 要求行内 granted_by = 操作者）及配套最小 GRANT；无 UPDATE 授权（撤销 = DELETE，分享行永不部分改写）。不改动任何既有表策略或既有授权。",
      objects: ["enterprise_resource_shares"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_resource_shares" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_resource_shares" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_resource_shares" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_share_data_read" ON "enterprise_resource_shares"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_resource_shares\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_resource_shares\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
        'CREATE POLICY "enterprise_share_operator_read" ON "enterprise_resource_shares"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_resource_shares\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_share_operator_insert" ON "enterprise_resource_shares"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_resource_shares\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_share_operator_delete" ON "enterprise_resource_shares"\n' +
          "  FOR DELETE TO ob_ent_operator\n" +
          "  USING (\"enterprise_resource_shares\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_resource_shares\".\"resource_id\" = nullif(current_setting('app.resource_id', true), '')\n" +
          "    AND \"enterprise_resource_shares\".\"granted_by\" = nullif(current_setting('app.operator_principal_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_resource_shares" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_resource_shares" TO ob_ent_operator;',
        'GRANT DELETE ON TABLE "enterprise_resource_shares" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT077（Issue #120）：网络策略、能力开关、模型路由与模板按归属保存的存储面。
 * expand-only——三张新表，不修改任何既有表/策略/授权。公司治理策略
 * （enterprise_governance_policies，一行 = 一家公司）、团队收窄覆盖
 * （enterprise_governance_overrides，一行 = 一个团队）与平台模板的
 * 范围安装副本（enterprise_template_installs，一行 = 一个
 * (公司, 团队, 模板)；平台模板目录本身是进程内深冻结封闭清单，不落库、
 * 不可回写）。文档列为 jsonb，只存开关/引用/客户内容副本，凭据值不进文档。
 */
const GOVERNANCE_POLICY_TASK: TaskMigrationSpec = {
  id: "MT077",
  description:
    "MT077（Issue #120）：新增 enterprise_governance_policies、enterprise_governance_overrides 与 enterprise_template_installs（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "governance_policy_tables",
      impact:
        "新增三张表：enterprise_governance_policies（一行 = 一家公司的治理策略文档 + 版本号，FK → enterprise_tenants cascade）、enterprise_governance_overrides（一行 = 一个团队对公司策略的收窄覆盖 + 版本号，复合 FK → enterprise_workspaces）与 enterprise_template_installs（一行 = 一个团队对平台模板的安装副本 + 目录版本/安装版本号，复合 FK → enterprise_workspaces）。不修改任何既有表。",
      objects: [
        "enterprise_governance_policies",
        "enterprise_governance_overrides",
        "enterprise_template_installs",
      ],
      statements: [
        'CREATE TABLE "enterprise_governance_policies" (\n' +
          '\t"tenant_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"document" jsonb NOT NULL,\n' +
          '\t"revision" integer DEFAULT 1 NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_governance_policy_revision" CHECK ("enterprise_governance_policies"."revision" > 0)\n' +
          ");",
        'ALTER TABLE "enterprise_governance_policies" ADD CONSTRAINT "enterprise_governance_policies_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'CREATE TABLE "enterprise_governance_overrides" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"document" jsonb NOT NULL,\n' +
          '\t"revision" integer DEFAULT 1 NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_governance_overrides_tenant_id_workspace_id_pk" PRIMARY KEY("tenant_id","workspace_id"),\n' +
          '\tCONSTRAINT "enterprise_governance_override_revision" CHECK ("enterprise_governance_overrides"."revision" > 0)\n' +
          ");",
        'ALTER TABLE "enterprise_governance_overrides" ADD CONSTRAINT "enterprise_governance_overrides_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'CREATE TABLE "enterprise_template_installs" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"template_ref" text NOT NULL,\n' +
          '\t"source_revision" integer NOT NULL,\n' +
          '\t"document" jsonb NOT NULL,\n' +
          '\t"revision" integer DEFAULT 1 NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_template_installs_tenant_id_workspace_id_template_ref_pk" PRIMARY KEY("tenant_id","workspace_id","template_ref"),\n' +
          '\tCONSTRAINT "enterprise_template_install_source_revision" CHECK ("enterprise_template_installs"."source_revision" > 0),\n' +
          '\tCONSTRAINT "enterprise_template_install_revision" CHECK ("enterprise_template_installs"."revision" > 0)\n' +
          ");",
        'ALTER TABLE "enterprise_template_installs" ADD CONSTRAINT "enterprise_template_installs_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "governance_policy_rls",
      impact:
        "仅对三张新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 角色租户范围 SELECT；operator 角色租户范围读 + INSERT/UPDATE，override 与 install 的 UPDATE 另要求 workspace 上下文）及配套最小 GRANT；不改动任何既有表策略或既有授权。目录角色无任何策略与授权（策略/安装不是逐主体目录数据）。",
      objects: [
        "enterprise_governance_policies",
        "enterprise_governance_overrides",
        "enterprise_template_installs",
      ],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_governance_policies" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_governance_policies" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_governance_policies" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_governance_policy_data_read" ON "enterprise_governance_policies"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_governance_policies\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_governance_policy_operator_read" ON "enterprise_governance_policies"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_governance_policies\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_governance_policy_operator_insert" ON "enterprise_governance_policies"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_governance_policies\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_governance_policy_operator_update" ON "enterprise_governance_policies"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_governance_policies\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))\n" +
          "  WITH CHECK (\"enterprise_governance_policies\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_governance_policies" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_governance_policies" TO ob_ent_operator;',
        'GRANT UPDATE ("document", "revision", "updated_at") ON TABLE "enterprise_governance_policies" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_governance_overrides" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_governance_overrides" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_governance_overrides" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_governance_override_data_read" ON "enterprise_governance_overrides"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_governance_overrides\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_governance_override_operator_read" ON "enterprise_governance_overrides"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_governance_overrides\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_governance_override_operator_insert" ON "enterprise_governance_overrides"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_governance_overrides\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_governance_override_operator_update" ON "enterprise_governance_overrides"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_governance_overrides\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_governance_overrides\".\"workspace_id\" = nullif(current_setting('app.workspace_id', true), ''))\n" +
          "  WITH CHECK (\"enterprise_governance_overrides\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_governance_overrides\".\"workspace_id\" = nullif(current_setting('app.workspace_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_governance_overrides" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_governance_overrides" TO ob_ent_operator;',
        'GRANT UPDATE ("document", "revision", "updated_at") ON TABLE "enterprise_governance_overrides" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_template_installs" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_template_installs" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_template_installs" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_template_install_data_read" ON "enterprise_template_installs"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_template_installs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_template_install_operator_read" ON "enterprise_template_installs"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_template_installs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_template_install_operator_insert" ON "enterprise_template_installs"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_template_installs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_template_install_operator_update" ON "enterprise_template_installs"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_template_installs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_template_installs\".\"workspace_id\" = nullif(current_setting('app.workspace_id', true), ''))\n" +
          "  WITH CHECK (\"enterprise_template_installs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_template_installs\".\"workspace_id\" = nullif(current_setting('app.workspace_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_template_installs" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_template_installs" TO ob_ent_operator;',
        'GRANT UPDATE ("document", "revision", "source_revision", "updated_at") ON TABLE "enterprise_template_installs" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT026（Issue #69）：每公司 SSO/SCIM 隔离的存储面。expand-only——三张新表，
 * 不修改任何既有表/策略/授权：
 *
 *   - enterprise_sso_configs：一行 = 一家公司的 SSO 配置文档（只存引用：
 *     协议/issuer/domain/凭据引用，秘密永不进配置文档）+ 修订号。
 *   - enterprise_scim_directory_bindings：一行 = 一家公司的 SCIM 目录绑定。
 *     connection_key 全局唯一（目录侧稳定标识；插件以 bearer 认证后得到的
 *     服务端已验证事实——公司归属只能来自按 key 查出的持久行）。绑定行还
 *     记录本绑定最后一次 SCIM 停用的 principal/epoch（服务端持久事实），
 *     供「管理员停用优先于目录恢复」裁决，不依赖回调参数。
 *   - enterprise_identity_binding_intents：一行 = 一次身份绑定的服务端持久
 *     意图（不透明 state 主键 + 创建时钉死的公司/用户归属 + 过期/消费时间）。
 *     回调归属只能来自按 state 查出的持久行，回调参数不能改写公司。
 *
 * RLS 沿既有模式最小新增：data 角色租户范围 SELECT（配置）；operator 角色
 * 租户范围读/写；绑定表额外一条连接键臂 SELECT 策略（SCIM 面解析：pin
 * app.scim_connection_key，服务端已验证事实）；意图表 SELECT/UPDATE 按量
 * state pin（app.identity_binding_state）。目录角色无任何策略与授权。
 */
const SSO_SCIM_ISOLATION_TASK: TaskMigrationSpec = {
  id: "MT026",
  description:
    "MT026（Issue #69）：每公司 SSO/SCIM 隔离——新增 enterprise_sso_configs、enterprise_scim_directory_bindings、enterprise_identity_binding_intents（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "sso_scim_tables",
      impact:
        "新增三张表：enterprise_sso_configs（一行 = 一家公司 SSO 配置文档 + 修订号，FK → enterprise_tenants cascade）；enterprise_scim_directory_bindings（一行 = 一家公司 SCIM 目录绑定，connection_key 全局唯一，含最后一次 SCIM 停用事实列）；enterprise_identity_binding_intents（一行 = 一次身份绑定意图，state 主键 + 过期/消费时间）。不修改任何既有表。",
      objects: [
        "enterprise_sso_configs",
        "enterprise_scim_directory_bindings",
        "enterprise_identity_binding_intents",
      ],
      statements: [
        'CREATE TABLE "enterprise_sso_configs" (\n' +
          '\t"tenant_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"document" jsonb NOT NULL,\n' +
          '\t"revision" integer DEFAULT 1 NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_sso_config_revision" CHECK ("enterprise_sso_configs"."revision" > 0)\n' +
          ");",
        'ALTER TABLE "enterprise_sso_configs" ADD CONSTRAINT "enterprise_sso_configs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'CREATE TABLE "enterprise_scim_directory_bindings" (\n' +
          '\t"id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"connection_key" text NOT NULL,\n' +
          '\t"credential_ref" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'active' NOT NULL,\n" +
          '\t"last_deprovision_principal_id" text,\n' +
          '\t"last_deprovision_epoch" integer,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"deactivated_at" timestamp with time zone,\n' +
          '\tCONSTRAINT "enterprise_scim_binding_status" CHECK ("enterprise_scim_directory_bindings"."status" in (\'active\',\'deactivated\')),\n' +
          '\tCONSTRAINT "enterprise_scim_binding_deprovision_fact" CHECK (("last_deprovision_principal_id" is null) = ("last_deprovision_epoch" is null))\n' +
          ");",
        'ALTER TABLE "enterprise_scim_directory_bindings" ADD CONSTRAINT "enterprise_scim_binding_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'CREATE UNIQUE INDEX "enterprise_scim_binding_connection_key" ON "enterprise_scim_directory_bindings" ("connection_key");',
        'CREATE TABLE "enterprise_identity_binding_intents" (\n' +
          '\t"id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"kind" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"expires_at" timestamp with time zone NOT NULL,\n' +
          '\t"consumed_at" timestamp with time zone,\n' +
          '\tCONSTRAINT "enterprise_identity_binding_kind" CHECK ("enterprise_identity_binding_intents"."kind" in (\'sso\',\'scim\')),\n' +
          '\tCONSTRAINT "enterprise_identity_binding_window" CHECK ("enterprise_identity_binding_intents"."expires_at" > "enterprise_identity_binding_intents"."created_at")\n' +
          ");",
        'ALTER TABLE "enterprise_identity_binding_intents" ADD CONSTRAINT "enterprise_identity_binding_intents_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_identity_binding_intents" ADD CONSTRAINT "enterprise_identity_binding_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "sso_scim_rls",
      impact:
        "仅对三张新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（sso_configs：data/operator 租户范围 SELECT + operator 租户范围 INSERT/UPDATE；bindings：operator 租户范围读/写 + 连接键臂 SELECT（pin app.scim_connection_key，SCIM 面解析）；intents：operator 租户范围 INSERT + state 臂 SELECT/UPDATE（pin app.identity_binding_state））及配套最小 GRANT；不改动任何既有表策略或既有授权。目录角色无任何策略与授权。",
      objects: [
        "enterprise_sso_configs",
        "enterprise_scim_directory_bindings",
        "enterprise_identity_binding_intents",
      ],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_sso_configs" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_sso_configs" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_sso_configs" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_sso_config_data_read" ON "enterprise_sso_configs"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_sso_configs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_sso_config_operator_read" ON "enterprise_sso_configs"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_sso_configs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_sso_config_operator_insert" ON "enterprise_sso_configs"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_sso_configs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_sso_config_operator_update" ON "enterprise_sso_configs"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_sso_configs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))\n" +
          "  WITH CHECK (\"enterprise_sso_configs\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_sso_configs" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_sso_configs" TO ob_ent_operator;',
        'GRANT UPDATE ("document", "revision", "updated_at") ON TABLE "enterprise_sso_configs" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_scim_directory_bindings" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_scim_directory_bindings" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_scim_directory_bindings" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_scim_binding_operator_read" ON "enterprise_scim_directory_bindings"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_scim_directory_bindings\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_scim_binding_connection_read" ON "enterprise_scim_directory_bindings"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_scim_directory_bindings\".\"connection_key\" = nullif(current_setting('app.scim_connection_key', true), ''));",
        'CREATE POLICY "enterprise_scim_binding_operator_insert" ON "enterprise_scim_directory_bindings"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_scim_directory_bindings\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_scim_binding_operator_update" ON "enterprise_scim_directory_bindings"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_scim_directory_bindings\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))\n" +
          "  WITH CHECK (\"enterprise_scim_directory_bindings\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_scim_directory_bindings" TO ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_scim_directory_bindings" TO ob_ent_operator;',
        'GRANT UPDATE ("credential_ref", "status", "last_deprovision_principal_id", "last_deprovision_epoch", "deactivated_at") ON TABLE "enterprise_scim_directory_bindings" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_identity_binding_intents" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_identity_binding_intents" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_identity_binding_intents" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_identity_binding_operator_insert" ON "enterprise_identity_binding_intents"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_identity_binding_intents\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_identity_binding_state_read" ON "enterprise_identity_binding_intents"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_identity_binding_intents\".\"id\" = nullif(current_setting('app.identity_binding_state', true), ''));",
        'CREATE POLICY "enterprise_identity_binding_state_consume" ON "enterprise_identity_binding_intents"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_identity_binding_intents\".\"id\" = nullif(current_setting('app.identity_binding_state', true), ''))\n" +
          "  WITH CHECK (\"enterprise_identity_binding_intents\".\"id\" = nullif(current_setting('app.identity_binding_state', true), ''));",
        'GRANT INSERT ON TABLE "enterprise_identity_binding_intents" TO ob_ent_operator;',
        'GRANT SELECT ON TABLE "enterprise_identity_binding_intents" TO ob_ent_operator;',
        'GRANT UPDATE ("consumed_at") ON TABLE "enterprise_identity_binding_intents" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT076（Issue #119）：人员管理动作（提升、降级、离职）的存储面授权。
 * expand-only——仅给受限 operator 角色补 enterprise_memberships.role 列的
 * 列级 UPDATE 授权。既有 UPDATE 行策略 enterprise_membership_operator_update
 * （app.tenant_id + app.operator_principal_id 匹配行）不变；不修改任何既有
 * 列/约束/策略/授权。背景：0056 基线只授予 ("status","epoch") 列（MT007
 * 停用/恢复面）；角色变更（MT076 提升/降级）是第一个需要写 role 列的已验
 * 证票据，按 MT008 列级授权先例补齐——不放宽任何行策略，RLS 仍按上下文
 * 收紧行范围。
 */
const PEOPLE_LIFECYCLE_TASK: TaskMigrationSpec = {
  id: "MT076",
  description:
    "MT076（Issue #119）：人员提升/降级/离职——enterprise_memberships.role 列的 operator 列级 UPDATE 授权（expand-only，不改任何既有对象/策略/授权）。",
  steps: [
    {
      slug: "membership_role_operator_grant",
      impact:
        "给受限 operator 角色补 enterprise_memberships.role 列的列级 UPDATE 授权（配合既有 operator UPDATE 行策略：app.tenant_id + app.operator_principal_id 匹配行）。不授予其它任何权限，不改任何策略。",
      objects: ["enterprise_memberships"],
      statements: [
        'GRANT UPDATE ("role") ON TABLE "enterprise_memberships" TO ob_ent_operator;',
      ],
    },
  ],
};

/** 显式枚举的任务 allowlist；未列出的 task id 一律拒绝。 */
/**
 * MT069（Issue #112）：公司计费 Customer 映射与公司/个人账户类型（expand-only）。
 * 新增三张账务域表（跟随 billing 域访问模型，与 billing_customers/credit_grants/
 * credit_ledger/credit_reservations 一致：owner 通道、无 RLS；受限 ob_ent_* 角色
 * 零授权 = 结构隔离）：
 *   - billing_customer_mappings：公司↔计费 Customer 唯一映射（tenant 主键 +
 *     customer 唯一索引，两方向唯一；写入一次后不变）。
 *   - billing_credit_accounts：积分账户注册（显式 account_type company/personal +
 *     隔离态 quarantined；行形状 CHECK 强制分类列的配对；account_key 派生 CHECK
 *     自证稳定标识 + partial UNIQUE）。
 *   - billing_account_audit：映射与账户操作审计。
 * 不修改任何既有表；金额尺度/精度约束（×100 整数、used≤total）不在本任务触达范围。
 */
const PAYER_ACCOUNT_TASK: TaskMigrationSpec = {
  id: "MT069",
  description:
    "MT069（Issue #112）：公司计费 Customer 映射与公司/个人账户类型（expand-only，仅新增三张账务域表，不改既有对象）。",
  steps: [
    {
      slug: "payer_accounts_tables",
      impact:
        "新增 billing_customer_mappings（公司↔Customer 唯一映射，两方向唯一）、billing_credit_accounts（显式 company/personal 账户类型 + 隔离态，行形状/派生键 CHECK、customer 与 account_key 双唯一）、billing_account_audit（映射与账户操作审计）及索引。不修改任何既有表。",
      objects: [
        "billing_customer_mappings",
        "billing_credit_accounts",
        "billing_account_audit",
      ],
      statements: [
        'CREATE TABLE "billing_customer_mappings" (\n' +
          '\t"tenant_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"external_customer_id" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "billing_customer_mappings_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "billing_customer_mappings_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action\n' +
          ");",
        'CREATE UNIQUE INDEX "billing_customer_mappings_customer_unique" ON "billing_customer_mappings" ("external_customer_id");',
        'CREATE TABLE "billing_credit_accounts" (\n' +
          '\t"id" text PRIMARY KEY NOT NULL,\n' +
          '\t"external_customer_id" text NOT NULL,\n' +
          '\t"account_type" text,\n' +
          '\t"status" text NOT NULL,\n' +
          '\t"tenant_id" text,\n' +
          '\t"owner_user_id" text,\n' +
          '\t"account_key" text,\n' +
          '\t"quarantine_reason" text,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "billing_credit_accounts_type" CHECK ("billing_credit_accounts"."account_type" in (\'company\',\'personal\')),\n' +
          '\tCONSTRAINT "billing_credit_accounts_status" CHECK ("billing_credit_accounts"."status" in (\'active\',\'quarantined\')),\n' +
          '\tCONSTRAINT "billing_credit_accounts_row_shape" CHECK (("billing_credit_accounts"."status" = \'quarantined\' AND "billing_credit_accounts"."account_type" is null AND "billing_credit_accounts"."tenant_id" is null AND "billing_credit_accounts"."owner_user_id" is null AND "billing_credit_accounts"."account_key" is null) OR ("billing_credit_accounts"."status" = \'active\' AND "billing_credit_accounts"."account_type" = \'company\' AND "billing_credit_accounts"."tenant_id" is not null AND "billing_credit_accounts"."owner_user_id" is null AND "billing_credit_accounts"."account_key" is not null) OR ("billing_credit_accounts"."status" = \'active\' AND "billing_credit_accounts"."account_type" = \'personal\' AND "billing_credit_accounts"."owner_user_id" is not null AND "billing_credit_accounts"."tenant_id" is null AND "billing_credit_accounts"."account_key" is not null)),\n' +
          '\tCONSTRAINT "billing_credit_accounts_quarantine_reason" CHECK (("billing_credit_accounts"."status" = \'quarantined\') = ("billing_credit_accounts"."quarantine_reason" is not null)),\n' +
          '\tCONSTRAINT "billing_credit_accounts_key_derivation" CHECK ("billing_credit_accounts"."account_key" = CASE "billing_credit_accounts"."account_type" WHEN \'company\' THEN \'company:\' || "billing_credit_accounts"."tenant_id" WHEN \'personal\' THEN \'personal:\' || "billing_credit_accounts"."owner_user_id" ELSE null END),\n' +
          '\tCONSTRAINT "billing_credit_accounts_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "billing_credit_accounts_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "billing_credit_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action\n' +
          ");",
        'CREATE UNIQUE INDEX "billing_credit_accounts_customer_unique" ON "billing_credit_accounts" ("external_customer_id");',
        'CREATE UNIQUE INDEX "billing_credit_accounts_key_unique" ON "billing_credit_accounts" ("account_key") WHERE "billing_credit_accounts"."account_key" is not null;',
        'CREATE TABLE "billing_account_audit" (\n' +
          '\t"id" text PRIMARY KEY NOT NULL,\n' +
          '\t"action" text NOT NULL,\n' +
          '\t"actor" text NOT NULL,\n' +
          '\t"tenant_id" text,\n' +
          '\t"external_customer_id" text,\n' +
          '\t"account_id" text,\n' +
          '\t"detail" jsonb,\n' +
          '\t"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          "\tCONSTRAINT \"billing_account_audit_action\" CHECK (\"billing_account_audit\".\"action\" in ('customer_mapping.bound','credit_account.registered','credit_account.quarantined')),\n" +
          '\tCONSTRAINT "billing_account_audit_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action\n' +
          ");",
        'CREATE INDEX "billing_account_audit_tenant_time_idx" ON "billing_account_audit" ("tenant_id","occurred_at");',
        'CREATE INDEX "billing_account_audit_customer_time_idx" ON "billing_account_audit" ("external_customer_id","occurred_at");',
      ],
    },
  ],
};

/**
 * MT016（Issue #59）：Bot 归属固定的存储面。expand-only——两张新表与按
 * 既有模式的最小 RLS；不修改任何既有表/策略/角色授权。
 *
 *   1. enterprise_bot_ownership：一行 = 一个 Bot 在一家公司一个团队内的归
 *      属（复合主键 (tenant_id, agent_id)；FK → enterprise_workspaces 与
 *      enterprise_memberships 均 cascade）。默认配置文档（default_config
 *      jsonb）就在归属行内——配置与 Bot 结构上不可分离（brief 验收 4）。
 *      agent_id 上另有全局唯一索引：旧工作台 agents 表是 Bot 业务对象的
 *      唯一权威存储且主键全局（Spec §4.2），两家公司不得认领同一底层
 *      Bot——冲突在 INSERT 处由约束本身拒绝（服务层 BOT_ID_UNAVAILABLE），
 *      同公司重复与跨公司占用对外同一代码，不泄露占用发生在哪家；约束是
 *      唯一不需要 RLS 豁免的跨公司检查点。
 *   2. enterprise_bot_preferences：一行 = 一个主体对一个 Bot 的偏好文档；
 *      复合外键钉到归属行 (tenant_id, agent_id) 与公司成员关系
 *      (tenant_id, principal_id)，均 cascade——Spec §4.2「根对象的子记录
 *      包含 tenant_id 并通过复合关联保持公司一致」的逐字实现：偏好行无法
 *      在 Bot 之外的公司存在；归属硬删除时偏好行经级联同时消失（级联不
 *      经过逐行 RLS——PostgreSQL 语义）。
 *
 * RLS 沿既有模式：REVOKE PUBLIC + 四能力角色 → ENABLE + FORCE → data 角
 * 色租户范围 SELECT（偏好表另加 restrictive 主体自读，与
 * enterprise_resource_grants 的 self-read 同款）→ operator 角色租户范围
 * 读 + 写（偏好写另钉主体上下文）。归属表的 UPDATE/DELETE 不钉 workspace
 * 上下文：账号清理/删除清单是公司作用域动作（验收 5），团队级编辑门在
 * 服务层判定（bots-ownership.ts）。目录角色无任何策略与授权。
 */
const BOT_OWNERSHIP_TASK: TaskMigrationSpec = {
  id: "MT016",
  description:
    "MT016（Issue #59）：Bot 归属固定——新增 enterprise_bot_ownership 与 enterprise_bot_preferences（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "bot_ownership_tables",
      impact:
        "新增两张表：enterprise_bot_ownership（一行 = 一个 Bot 的公司/团队归属 + owner + 状态/版本号 + 默认配置文档；复合主键 (tenant_id, agent_id)；agent_id 全局唯一索引——Bot 业务对象的唯一权威存储主键全局，两家公司不得认领同一底层 Bot；FK → enterprise_workspaces 与 enterprise_memberships 均 cascade）与 enterprise_bot_preferences（一行 = 一个主体对一个 Bot 的偏好；复合主键；复合 FK 钉到归属行与公司成员关系，均 cascade）。文档列为 jsonb；文档必须为 JSON object 的校验在服务层写入前完成（与 MT014 同款：jsonb 文档列不设存储层类型检查）。不修改任何既有表。",
      objects: ["enterprise_bot_ownership", "enterprise_bot_preferences"],
      statements: [
        'CREATE TABLE "enterprise_bot_ownership" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"agent_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"owner_principal_id" text NOT NULL,\n' +
          '\t"display_name" text NOT NULL,\n' +
          '\t"default_config" jsonb NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'active' NOT NULL,\n" +
          '\t"revision" integer DEFAULT 1 NOT NULL,\n' +
          '\t"acl_epoch" integer DEFAULT 1 NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_bot_ownership_tenant_id_agent_id_pk" PRIMARY KEY("tenant_id","agent_id"),\n' +
          '\tCONSTRAINT "enterprise_bot_ownership_status" CHECK ("enterprise_bot_ownership"."status" in (\'active\',\'deleted\')),\n' +
          '\tCONSTRAINT "enterprise_bot_ownership_versions" CHECK ("enterprise_bot_ownership"."revision" > 0 and "enterprise_bot_ownership"."acl_epoch" > 0)\n' +
          ");",
        'CREATE UNIQUE INDEX "enterprise_bot_ownership_agent_id_global_uq" ON "enterprise_bot_ownership" USING btree ("agent_id");',
        'ALTER TABLE "enterprise_bot_ownership" ADD CONSTRAINT "enterprise_bot_ownership_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_bot_ownership" ADD CONSTRAINT "enterprise_bot_ownership_tenant_id_owner_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","owner_principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE TABLE "enterprise_bot_preferences" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"agent_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"preferences" jsonb NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_bot_preferences_tenant_id_agent_id_principal_id_pk" PRIMARY KEY("tenant_id","agent_id","principal_id")\n' +
          ");",
        'ALTER TABLE "enterprise_bot_preferences" ADD CONSTRAINT "enterprise_bot_preferences_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."enterprise_bot_ownership"("tenant_id","agent_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_bot_preferences" ADD CONSTRAINT "enterprise_bot_preferences_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "bot_ownership_rls",
      impact:
        "仅对两张新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 角色租户范围 SELECT，偏好表另加 restrictive 主体自读；operator 角色租户范围读 + 写，偏好写另钉主体上下文）及配套最小 GRANT；不改动任何既有表策略或既有授权。目录角色无任何策略与授权（Bot 内容不是逐主体目录数据）。",
      objects: ["enterprise_bot_ownership", "enterprise_bot_preferences"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_bot_ownership" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_bot_ownership" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_bot_ownership" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_bot_ownership_data_read" ON "enterprise_bot_ownership"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_bot_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_bot_ownership_operator_read" ON "enterprise_bot_ownership"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_bot_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_bot_ownership_operator_insert" ON "enterprise_bot_ownership"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_bot_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_bot_ownership_operator_update" ON "enterprise_bot_ownership"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_bot_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))\n" +
          "  WITH CHECK (\"enterprise_bot_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_bot_ownership_operator_delete" ON "enterprise_bot_ownership"\n' +
          "  FOR DELETE TO ob_ent_operator\n" +
          "  USING (\"enterprise_bot_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_bot_ownership" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_bot_ownership" TO ob_ent_operator;',
        'GRANT UPDATE ("display_name", "default_config", "status", "revision", "acl_epoch", "updated_at") ON TABLE "enterprise_bot_ownership" TO ob_ent_operator;',
        'GRANT DELETE ON TABLE "enterprise_bot_ownership" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_bot_preferences" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_bot_preferences" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_bot_preferences" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_bot_preference_data_tenant_read" ON "enterprise_bot_preferences"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_bot_preferences\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_bot_preference_data_self_read" ON "enterprise_bot_preferences"\n' +
          "  AS RESTRICTIVE\n" +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_bot_preferences\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
        'CREATE POLICY "enterprise_bot_preference_operator_read" ON "enterprise_bot_preferences"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_bot_preferences\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_bot_preferences\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
        'CREATE POLICY "enterprise_bot_preference_operator_insert" ON "enterprise_bot_preferences"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_bot_preferences\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_bot_preferences\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
        'CREATE POLICY "enterprise_bot_preference_operator_update" ON "enterprise_bot_preferences"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_bot_preferences\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_bot_preferences\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''))\n" +
          "  WITH CHECK (\"enterprise_bot_preferences\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_bot_preferences\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
        'CREATE POLICY "enterprise_bot_preference_operator_delete" ON "enterprise_bot_preferences"\n' +
          "  FOR DELETE TO ob_ent_operator\n" +
          "  USING (\"enterprise_bot_preferences\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_bot_preferences\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_bot_preferences" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_bot_preferences" TO ob_ent_operator;',
        'GRANT UPDATE ("preferences", "updated_at") ON TABLE "enterprise_bot_preferences" TO ob_ent_operator;',
        'GRANT DELETE ON TABLE "enterprise_bot_preferences" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT041（Issue #84）：任务、运行、触发与租约的原始归属与配置版本快照。
 * 新增三张归属域表（expand-only，零既有表改动；归属经「受约束关联」
 * (kind, object_id) → job_ownership）：
 *   - job_ownership：创建时归属 pin（公司+团队+发起主体，复合外键同时证
 *     明 workspace 属于该公司、principal 是该公司成员）；只授 INSERT+SELECT，
 *     不授任何角色 UPDATE/DELETE——归属不可改写是 DB 结构。
 *   - job_config_snapshots：执行依据快照（creation 每 job 一行 partial
 *     UNIQUE + execution 追加；append-only，无 UPDATE 授权）。
 *   - job_leases：归属内租约（复合 FK → job_ownership + workspace；行形状
 *     CHECK 强制 claim/lease 成对；仅本表授 operator 列级 UPDATE——服务
 *     UPDATE 面只触七个状态列：claimed_by_kind/claimed_by/lease_until/
 *     attempts/finished_at/last_error/updated_at；身份列与 created_at 永不
 *     可改）。三表 RLS 均 ENABLE + FORCE（表主同样不可绕过策略）。
 * 不修改任何既有表；RLS 沿既有模式（data 租户臂 SELECT、operator 租户臂
 * 读+写），不授 ob_ent_directory / ob_ent_identity_operator 任何权限。
 */
const JOB_OWNERSHIP_TASK: TaskMigrationSpec = {
  id: "MT041",
  description:
    "MT041（Issue #84）：任务、运行、触发与租约的原始归属与配置版本快照（expand-only，三张新表，零既有表改动）。",
  steps: [
    {
      slug: "job_ownership_tables",
      impact:
        "新增 job_ownership（创建时归属 pin，复合外键证明公司一致性与成员资格，仅 INSERT+SELECT）、job_config_snapshots（执行依据快照，append-only）、job_leases（归属内租约，行形状 CHECK）及索引。不修改任何既有表。",
      objects: ["job_ownership", "job_config_snapshots", "job_leases"],
      statements: [
        'CREATE TABLE "job_ownership" (\n' +
          '\t"kind" text NOT NULL,\n' +
          '\t"object_id" text NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          "\tCONSTRAINT \"job_ownership_kind\" CHECK (\"job_ownership\".\"kind\" in ('task','run','trigger')),\n" +
          '\tCONSTRAINT "job_ownership_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "job_ownership_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "job_ownership_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "job_ownership_principal_id_enterprise_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."enterprise_principals"("id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tPRIMARY KEY ("kind","object_id")\n' +
          ");",
        'CREATE INDEX "job_ownership_scope_created_idx" ON "job_ownership" ("tenant_id","workspace_id","principal_id","created_at");',
        'CREATE TABLE "job_config_snapshots" (\n' +
          '\t"id" text PRIMARY KEY NOT NULL,\n' +
          '\t"kind" text NOT NULL,\n' +
          '\t"object_id" text NOT NULL,\n' +
          '\t"purpose" text NOT NULL,\n' +
          '\t"company_revision" integer NOT NULL,\n' +
          '\t"override_revision" integer,\n' +
          '\t"basis_digest" text NOT NULL,\n' +
          '\t"captured_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "job_config_snapshots_purpose" CHECK ("job_config_snapshots"."purpose" in (\'creation\',\'execution\')),\n' +
          '\tCONSTRAINT "job_config_snapshots_company_revision" CHECK ("job_config_snapshots"."company_revision" > 0),\n' +
          '\tCONSTRAINT "job_config_snapshots_override_revision" CHECK ("job_config_snapshots"."override_revision" is null or "job_config_snapshots"."override_revision" > 0),\n' +
          '\tCONSTRAINT "job_config_snapshots_kind_object_id_job_ownership_kind_object_id_fk" FOREIGN KEY ("kind","object_id") REFERENCES "public"."job_ownership"("kind","object_id") ON DELETE cascade ON UPDATE no action\n' +
          ");",
        'CREATE UNIQUE INDEX "job_config_snapshots_creation_unique" ON "job_config_snapshots" ("kind","object_id") WHERE "job_config_snapshots"."purpose" = \'creation\';',
        'CREATE INDEX "job_config_snapshots_history_idx" ON "job_config_snapshots" ("kind","object_id","captured_at");',
        'CREATE TABLE "job_leases" (\n' +
          '\t"kind" text NOT NULL,\n' +
          '\t"object_id" text NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"claimed_by_kind" text,\n' +
          '\t"claimed_by" text,\n' +
          '\t"lease_until" timestamp with time zone,\n' +
          '\t"attempts" integer DEFAULT 0 NOT NULL,\n' +
          '\t"finished_at" timestamp with time zone,\n' +
          '\t"last_error" text,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "job_leases_claimed_by_kind" CHECK ("job_leases"."claimed_by_kind" is null or "job_leases"."claimed_by_kind" in (\'worker\',\'principal\')),\n' +
          '\tCONSTRAINT "job_leases_claimed_row_shape" CHECK (("job_leases"."claimed_by_kind" is null and "job_leases"."claimed_by" is null and "job_leases"."lease_until" is null) or ("job_leases"."claimed_by_kind" is not null and "job_leases"."claimed_by" is not null and "job_leases"."lease_until" is not null)),\n' +
          '\tCONSTRAINT "job_leases_attempts_non_negative" CHECK ("job_leases"."attempts" >= 0),\n' +
          '\tCONSTRAINT "job_leases_kind_object_id_job_ownership_kind_object_id_fk" FOREIGN KEY ("kind","object_id") REFERENCES "public"."job_ownership"("kind","object_id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "job_leases_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tPRIMARY KEY ("kind","object_id")\n' +
          ");",
      ],
    },
    {
      slug: "job_ownership_rls",
      impact:
        "仅对三张新表：REVOKE PUBLIC、启用并 FORCE RLS（表主同样受策略约束，与全部既有新表一致）、按既有模式新增最小策略（data 角色租户范围 SELECT；operator 角色租户范围读 + INSERT，job_leases 另授列级 UPDATE——仅服务实际写入的七个状态列，沿 MT076/MT008 列级先例；快照表策略经 join 到归属行取租户）及配套最小 GRANT。归属与快照表不授任何角色 UPDATE/DELETE（不可变结构）。不改动任何既有表策略或既有授权。",
      objects: ["job_ownership", "job_config_snapshots", "job_leases"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "job_ownership" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "job_ownership" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "job_ownership" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "job_ownership_data_read" ON "job_ownership" AS PERMISSIVE FOR SELECT TO ob_ent_data\n' +
          "  USING (\"job_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))",
        'CREATE POLICY "job_ownership_operator_read" ON "job_ownership" AS PERMISSIVE FOR SELECT TO ob_ent_operator\n' +
          "  USING (\"job_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))",
        'CREATE POLICY "job_ownership_operator_insert" ON "job_ownership" AS PERMISSIVE FOR INSERT TO ob_ent_operator\n' +
          "  WITH CHECK (\"job_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))",
        'GRANT SELECT ON TABLE "job_ownership" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "job_ownership" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "job_config_snapshots" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "job_config_snapshots" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "job_config_snapshots" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "job_config_snapshots_data_read" ON "job_config_snapshots" AS PERMISSIVE FOR SELECT TO ob_ent_data\n' +
          "  USING (exists (select 1 from job_ownership where job_ownership.kind = job_config_snapshots.kind and job_ownership.object_id = job_config_snapshots.object_id and job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')))",
        'CREATE POLICY "job_config_snapshots_operator_read" ON "job_config_snapshots" AS PERMISSIVE FOR SELECT TO ob_ent_operator\n' +
          "  USING (exists (select 1 from job_ownership where job_ownership.kind = job_config_snapshots.kind and job_ownership.object_id = job_config_snapshots.object_id and job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')))",
        'CREATE POLICY "job_config_snapshots_operator_insert" ON "job_config_snapshots" AS PERMISSIVE FOR INSERT TO ob_ent_operator\n' +
          "  WITH CHECK (exists (select 1 from job_ownership where job_ownership.kind = job_config_snapshots.kind and job_ownership.object_id = job_config_snapshots.object_id and job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')))",
        'GRANT SELECT ON TABLE "job_config_snapshots" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "job_config_snapshots" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "job_leases" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "job_leases" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "job_leases" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "job_leases_data_read" ON "job_leases" AS PERMISSIVE FOR SELECT TO ob_ent_data\n' +
          "  USING (\"job_leases\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))",
        'CREATE POLICY "job_leases_operator_read" ON "job_leases" AS PERMISSIVE FOR SELECT TO ob_ent_operator\n' +
          "  USING (\"job_leases\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))",
        'CREATE POLICY "job_leases_operator_insert" ON "job_leases" AS PERMISSIVE FOR INSERT TO ob_ent_operator\n' +
          "  WITH CHECK (\"job_leases\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))",
        'CREATE POLICY "job_leases_operator_update" ON "job_leases" AS PERMISSIVE FOR UPDATE TO ob_ent_operator\n' +
          "  USING (\"job_leases\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))\n" +
          "  WITH CHECK (\"job_leases\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''))",
        'GRANT SELECT ON TABLE "job_leases" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "job_leases" TO ob_ent_operator;',
        'GRANT UPDATE ("attempts", "claimed_by", "claimed_by_kind", "finished_at", "last_error", "lease_until", "updated_at") ON TABLE "job_leases" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT027（Issue #70）：连接凭据与站点登录的真实归属存储。expand-only——三张新表
 * （enterprise_credentials / enterprise_credential_actions /
 * enterprise_credential_audit）+ FORCE RLS + 最小授权，不改任何既有对象。
 */
const CREDENTIAL_OWNERSHIP_TASK: TaskMigrationSpec = {
  id: "MT027",
  description:
    "MT027（Issue #70）：新增 enterprise_credentials、enterprise_credential_actions 与 enterprise_credential_audit（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "credential_ownership_tables",
      impact:
        "新增三张凭据归属表：enterprise_credentials（显式 classification + 行形 CHECK + 复合外键内嵌 tenant_id，明文永不入库只存密封 envelope）、enterprise_credential_actions（闭集动作行 'use'/'disclose'，复合外键证明归属公司与成员资格）、enterprise_credential_audit（append-only 披露审计，无 credential 外键）。不修改任何既有表。",
      objects: [
        "enterprise_credentials",
        "enterprise_credential_actions",
        "enterprise_credential_audit",
      ],
      statements: [
        'CREATE TABLE "enterprise_credentials" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"kind" text NOT NULL,\n' +
          '\t"classification" text NOT NULL,\n' +
          '\t"workspace_id" text,\n' +
          '\t"owner_principal_id" text,\n' +
          '\t"target" text NOT NULL,\n' +
          '\t"display" jsonb NOT NULL,\n' +
          '\t"envelope" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'active' NOT NULL,\n" +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_credentials_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          '\tCONSTRAINT "enterprise_credential_kind" CHECK ("enterprise_credentials"."kind" in (\'connection\',\'site-login\')),\n' +
          "\tCONSTRAINT \"enterprise_credential_classification\" CHECK (\"enterprise_credentials\".\"classification\" in ('personal','team','company')),\n" +
          '\tCONSTRAINT "enterprise_credential_status" CHECK ("enterprise_credentials"."status" in (\'active\',\'revoked\')),\n' +
          '\tCONSTRAINT "enterprise_credential_row_shape" CHECK (("enterprise_credentials"."classification" = \'team\') = ("enterprise_credentials"."workspace_id" is not null) and ("enterprise_credentials"."classification" = \'personal\') = ("enterprise_credentials"."owner_principal_id" is not null)),\n' +
          "\tCONSTRAINT \"enterprise_credential_display_shape\" CHECK (\"enterprise_credentials\".\"display\" ? 'label' and not \"enterprise_credentials\".\"display\" ?| array['envelope','plaintext','secret','value','password','token'])\n" +
          ");",
        'ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credentials_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credentials_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credentials_tenant_id_owner_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","owner_principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_credential_tenant_created_idx" ON "enterprise_credentials" ("tenant_id","created_at","id");',
        'CREATE TABLE "enterprise_credential_actions" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"credential_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"action" text NOT NULL,\n' +
          '\t"granted_by" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_credential_actions_tenant_id_credential_id_principal_id_action_pk" PRIMARY KEY("tenant_id","credential_id","principal_id","action"),\n' +
          '\tCONSTRAINT "enterprise_credential_action_kind" CHECK ("enterprise_credential_actions"."action" in (\'use\',\'disclose\'))\n' +
          ");",
        'ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_actions_tenant_id_credential_id_enterprise_credentials_tenant_id_id_fk" FOREIGN KEY ("tenant_id","credential_id") REFERENCES "public"."enterprise_credentials"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_actions_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_actions_tenant_id_granted_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE TABLE "enterprise_credential_audit" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"credential_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          "\t\"action\" text DEFAULT 'plaintext.disclosed' NOT NULL,\n" +
          '\t"detail" jsonb NOT NULL,\n' +
          '\t"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_credential_audit_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          '\tCONSTRAINT "enterprise_credential_audit_action" CHECK ("enterprise_credential_audit"."action" = \'plaintext.disclosed\'),\n' +
          '\tCONSTRAINT "enterprise_credential_audit_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action\n' +
          ");",
        'CREATE INDEX "enterprise_credential_audit_tenant_time_idx" ON "enterprise_credential_audit" ("tenant_id","occurred_at");',
      ],
    },
    {
      slug: "credential_rls_policies",
      impact:
        "三张新表的 FORCE RLS 与最小授权：data 角色租户范围读凭据/本人动作行 + 审计只写；operator 角色租户范围读写凭据/管理动作行 + 审计只读；directory 角色零授权；审计对任何角色无 UPDATE/DELETE（append-only）。",
      objects: [
        "enterprise_credentials",
        "enterprise_credential_actions",
        "enterprise_credential_audit",
      ],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_credentials" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_credentials" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_credentials" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_credential_data_read" ON "enterprise_credentials"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_credentials"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_operator_read" ON "enterprise_credentials"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_credentials"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_operator_insert" ON "enterprise_credentials"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_credentials"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_operator_update" ON "enterprise_credentials"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_credentials"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_credentials"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_credentials" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT, UPDATE ON TABLE "enterprise_credentials" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_credential_actions" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_credential_actions" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_credential_actions" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_credential_action_data_read" ON "enterprise_credential_actions"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_credential_actions"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_credential_actions"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_action_operator_read" ON "enterprise_credential_actions"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_credential_actions"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_action_operator_insert" ON "enterprise_credential_actions"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_credential_actions"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_action_operator_delete" ON "enterprise_credential_actions"\n  FOR DELETE TO ob_ent_operator\n  USING ("enterprise_credential_actions"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_credential_actions" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT, DELETE ON TABLE "enterprise_credential_actions" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_credential_audit" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_credential_audit" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_credential_audit" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_credential_audit_data_insert" ON "enterprise_credential_audit"\n  FOR INSERT TO ob_ent_data\n  WITH CHECK ("enterprise_credential_audit"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_audit_operator_read" ON "enterprise_credential_audit"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_credential_audit"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT INSERT ON TABLE "enterprise_credential_audit" TO ob_ent_data;',
        'GRANT SELECT ON TABLE "enterprise_credential_audit" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT028（Issue #71）：OAuth 回调按服务端持久 state 固定归属。expand-only——
 * 仅新增 enterprise_oauth_states（一行 = 一次连接 OAuth 发起流程：不透明
 * state 值 + 归属三元组 tenant/workspace/principal 三条复合外键内嵌
 * tenant_id + 闭集 purpose/target 连接目的 + 服务端生成的 PKCE verifier +
 * pending/consumed/failed 行形 CHECK 生命周期）与按既有模式的最小 RLS
 * （operator INSERT 走 tenant 臂；SELECT/UPDATE 只走 state 臂
 * app.oauth_state，无法按公司枚举流程；data/directory 零策略零授权）。
 * 不修改任何既有表/策略/角色授权。
 */
const OAUTH_STATE_TASK: TaskMigrationSpec = {
  id: "MT028",
  description:
    "MT028（Issue #71）：新增 enterprise_oauth_states（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "oauth_state_table",
      impact:
        "新增 enterprise_oauth_states 表：不透明 state 主键；tenant/workspace/principal 三条复合外键全部内嵌 tenant_id（团队必属本公司、发起人必是本公司成员，跨公司归属行结构上不可能）；purpose 闭集 CHECK（'connection'/'site-login'）、target 1..512、verifier ≥43 字符；expires_at > created_at 窗口 CHECK；failed_reason 闭集且与 failed_at 配对；status 三态行形 CHECK（pending/consumed/failed 与时间戳互斥自洽，消费后失败的行保留 consumed_at）。不修改任何既有表。",
      objects: ["enterprise_oauth_states"],
      statements: [
        'CREATE TABLE "enterprise_oauth_states" (\n' +
          '\t"id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"purpose" text NOT NULL,\n' +
          '\t"target" text NOT NULL,\n' +
          '\t"verifier" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'pending' NOT NULL,\n" +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"expires_at" timestamp with time zone NOT NULL,\n' +
          '\t"consumed_at" timestamp with time zone,\n' +
          '\t"failed_at" timestamp with time zone,\n' +
          '\t"failed_reason" text,\n' +
          '\tCONSTRAINT "enterprise_oauth_state_purpose" CHECK ("enterprise_oauth_states"."purpose" in (\'connection\',\'site-login\')),\n' +
          '\tCONSTRAINT "enterprise_oauth_state_target" CHECK (char_length("enterprise_oauth_states"."target") between 1 and 512),\n' +
          '\tCONSTRAINT "enterprise_oauth_state_verifier" CHECK (char_length("enterprise_oauth_states"."verifier") >= 43),\n' +
          "\tCONSTRAINT \"enterprise_oauth_state_status\" CHECK (\"enterprise_oauth_states\".\"status\" in ('pending','consumed','failed')),\n" +
          '\tCONSTRAINT "enterprise_oauth_state_window" CHECK ("enterprise_oauth_states"."expires_at" > "enterprise_oauth_states"."created_at"),\n' +
          '\tCONSTRAINT "enterprise_oauth_state_failed_reason" CHECK (("enterprise_oauth_states"."failed_reason" is null) = ("enterprise_oauth_states"."failed_at" is null) and ("enterprise_oauth_states"."failed_reason" is null or "enterprise_oauth_states"."failed_reason" in (\'vendor-refused\',\'record-failed\',\'abandoned\'))),\n' +
          '\tCONSTRAINT "enterprise_oauth_state_row_shape" CHECK (("enterprise_oauth_states"."status" = \'pending\') = ("enterprise_oauth_states"."consumed_at" is null and "enterprise_oauth_states"."failed_at" is null) and ("enterprise_oauth_states"."status" = \'consumed\') = ("enterprise_oauth_states"."consumed_at" is not null and "enterprise_oauth_states"."failed_at" is null) and ("enterprise_oauth_states"."status" = \'failed\') = ("enterprise_oauth_states"."failed_at" is not null))\n' +
          ");",
        'ALTER TABLE "enterprise_oauth_states" ADD CONSTRAINT "enterprise_oauth_states_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_oauth_states" ADD CONSTRAINT "enterprise_oauth_states_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_oauth_states" ADD CONSTRAINT "enterprise_oauth_states_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_oauth_state_tenant_created_idx" ON "enterprise_oauth_states" ("tenant_id","created_at","id");',
      ],
    },
    {
      slug: "oauth_state_rls_policies",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增 3 条最小策略（operator INSERT 走 tenant 臂；SELECT 与 UPDATE 只走 state 臂 app.oauth_state——受限角色无法按公司枚举流程，与 MT026 intent 同形）及配套最小授权（SELECT/INSERT/UPDATE 只给 ob_ent_operator；data/directory 零授权）。不改动任何既有表策略或既有授权。",
      objects: ["enterprise_oauth_states"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_oauth_states" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_oauth_states" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_oauth_states" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_oauth_state_operator_insert" ON "enterprise_oauth_states"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_oauth_states\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_oauth_state_state_read" ON "enterprise_oauth_states"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_oauth_states\".\"id\" = nullif(current_setting('app.oauth_state', true), ''));",
        'CREATE POLICY "enterprise_oauth_state_state_consume" ON "enterprise_oauth_states"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_oauth_states\".\"id\" = nullif(current_setting('app.oauth_state', true), ''))\n" +
          "  WITH CHECK (\"enterprise_oauth_states\".\"id\" = nullif(current_setting('app.oauth_state', true), ''));",
        'GRANT SELECT, INSERT, UPDATE ON TABLE "enterprise_oauth_states" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT070（Issue #113）：公司调用归属与同一余额的原子预扣（expand-only）。
 * 新增一张账务域归属表（跟随 MT069 同款 billing 域访问模型：owner 通道、
 * 无 RLS；不授任何角色授权 = 结构隔离，套件以 has_table_privilege 反证钉死）：
 *   - billing_call_attributions：每次公司工作台预扣的归属行（预扣 1:1）。
 *     reservation_id 主键 FK → credit_reservations(cascade)；(tenant_id,
 *     workspace_id) 复合 FK → enterprise_workspaces（证明 workspace 属该公司）、
 *     (tenant_id, principal_id) 复合 FK → enterprise_memberships（证明 principal
 *     是该公司成员）——伪造归属行结构上不可能存在（MT010 三复合外键同款纪律）；
 *     bot_ref/call_key 非空串 CHECK；(tenant_id, call_key) 唯一索引：一个稳定
 *     调用标识在公司内至多一条预扣归属（幂等键唯一之外的第二道重复预扣闸）。
 * 不修改任何既有表；预扣上界/幂等语义仍在 credits-writer（零改动）。
 */
const COMPANY_CALL_ATTRIBUTION_TASK: TaskMigrationSpec = {
  id: "MT070",
  description:
    "MT070（Issue #113）：公司调用归属——新增 billing_call_attributions（expand-only，仅新增一张账务域归属表，不改既有对象）。",
  steps: [
    {
      slug: "company_call_attributions",
      impact:
        "新增 billing_call_attributions 表：预扣 1:1 归属行（公司/团队/使用人/Bot 授权/稳定调用标识）。复合外键证明 workspace 属公司、principal 是公司成员；(tenant_id, call_key) 唯一索引兌底重复预扣防护。不修改任何既有表。",
      objects: ["billing_call_attributions"],
      statements: [
        'CREATE TABLE "billing_call_attributions" (\n' +
          '\t"reservation_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"bot_ref" text NOT NULL,\n' +
          '\t"call_key" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "billing_call_attributions_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "billing_call_attributions_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "billing_call_attributions_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "billing_call_attributions_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "billing_call_attribution_refs_present" CHECK ("billing_call_attributions"."bot_ref" <> \'\' AND "billing_call_attributions"."call_key" <> \'\')\n' +
          ");",
        'CREATE UNIQUE INDEX "billing_call_attributions_tenant_call_key_unique" ON "billing_call_attributions" ("tenant_id","call_key");',
        'CREATE INDEX "billing_call_attributions_tenant_idx" ON "billing_call_attributions" ("tenant_id");',
      ],
    },
  ],
};

/**
 * MT031（Issue #74）：插件目录与安装归属（expand-only）。三张新表：
 *   - enterprise_plugin_catalog：公共目录，全局共享——没有 tenant_id 列，
 *     对受限业务角色只读（仅 SELECT 策略/授权，零写面）；metadata 闭形
 *     CHECK 拒绝秘密载体键与公司私有面（目录从结构上不含公司私有配置）。
 *   - enterprise_plugin_installs：安装固定公司与团队（tenant_id +
 *     workspace_id 双 NOT NULL，复合外键内嵌 tenant_id，跨公司安装行结构性
 *     不可能）；config 闭形 CHECK 拒绝秘密载体键，秘密只走 envelope 密封
 *     通道；status ∈ ('active','disabled')。
 *   - enterprise_plugin_connections：安装上的连接绑定，复合外键
 *     (tenant_id, install_id) 随安装级联消亡，bound_by 复合外键证明本公司
 *     成员；vendor_ref 非机密别名。
 * 不修改任何既有表/策略/角色授权。
 */
const PLUGIN_CATALOG_TASK: TaskMigrationSpec = {
  id: "MT031",
  description:
    "MT031（Issue #74）：新增 enterprise_plugin_catalog、enterprise_plugin_installs 与 enterprise_plugin_connections（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "plugin_tables",
      impact:
        "新增三张插件归属表：enterprise_plugin_catalog（全局只读目录，无 tenant 列，metadata 闭形 CHECK）、enterprise_plugin_installs（安装固定公司与团队，复合外键内嵌 tenant_id，config 闭形 CHECK）、enterprise_plugin_connections（安装上的连接绑定，随安装级联消亡）。不修改任何既有表。",
      objects: [
        "enterprise_plugin_catalog",
        "enterprise_plugin_installs",
        "enterprise_plugin_connections",
      ],
      statements: [
        'CREATE TABLE "enterprise_plugin_catalog" (\n' +
          '\t"id" text PRIMARY KEY NOT NULL,\n' +
          '\t"kind" text NOT NULL,\n' +
          '\t"title" text NOT NULL,\n' +
          '\t"vendor" text NOT NULL,\n' +
          '\t"source" text NOT NULL,\n' +
          '\t"metadata" jsonb NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          "\tCONSTRAINT \"enterprise_plugin_catalog_kind\" CHECK (\"enterprise_plugin_catalog\".\"kind\" in ('mcp','composio','open-connector')),\n" +
          '\tCONSTRAINT "enterprise_plugin_catalog_source" CHECK ("enterprise_plugin_catalog"."source" in (\'first-party\',\'custom\')),\n' +
          "\tCONSTRAINT \"enterprise_plugin_catalog_metadata_shape\" CHECK (\"enterprise_plugin_catalog\".\"metadata\" ? 'summary' and not \"enterprise_plugin_catalog\".\"metadata\" ?| array['envelope','plaintext','secret','value','password','token','config','apiKey','api_key','secretRef','encryptedValue','encrypted_value'])\n" +
          ");",
        'CREATE TABLE "enterprise_plugin_installs" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"catalog_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"installed_by" text NOT NULL,\n' +
          '\t"config" jsonb NOT NULL,\n' +
          '\t"envelope" text,\n' +
          "\t\"status\" text DEFAULT 'active' NOT NULL,\n" +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_plugin_installs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          '\tCONSTRAINT "enterprise_plugin_install_status" CHECK ("enterprise_plugin_installs"."status" in (\'active\',\'disabled\')),\n' +
          "\tCONSTRAINT \"enterprise_plugin_install_config_shape\" CHECK (not \"enterprise_plugin_installs\".\"config\" ?| array['envelope','plaintext','secret','value','password','token','config','apiKey','api_key','secretRef','encryptedValue','encrypted_value'])\n" +
          ");",
        'ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_tenant_id_installed_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","installed_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_catalog_id_enterprise_plugin_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."enterprise_plugin_catalog"("id") ON DELETE no action ON UPDATE no action;',
        'CREATE INDEX "enterprise_plugin_install_tenant_created_idx" ON "enterprise_plugin_installs" ("tenant_id","created_at","id");',
        'CREATE INDEX "enterprise_plugin_install_catalog_idx" ON "enterprise_plugin_installs" ("catalog_id");',
        'CREATE TABLE "enterprise_plugin_connections" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"install_id" text NOT NULL,\n' +
          '\t"bound_by" text NOT NULL,\n' +
          '\t"vendor_ref" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_plugin_connections_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          '\tCONSTRAINT "enterprise_plugin_connection_vendor_ref" CHECK (char_length("enterprise_plugin_connections"."vendor_ref") between 1 and 512)\n' +
          ");",
        'ALTER TABLE "enterprise_plugin_connections" ADD CONSTRAINT "enterprise_plugin_connections_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_plugin_connections" ADD CONSTRAINT "enterprise_plugin_connections_tenant_id_install_id_enterprise_plugin_installs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","install_id") REFERENCES "public"."enterprise_plugin_installs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_plugin_connections" ADD CONSTRAINT "enterprise_plugin_connections_tenant_id_bound_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","bound_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_plugin_connection_install_idx" ON "enterprise_plugin_connections" ("tenant_id","install_id");',
      ],
    },
    {
      slug: "plugin_rls_policies",
      impact:
        "三张新表的 FORCE RLS 与最小授权：目录对 data/operator 全局只读（仅 SELECT，零写策略零写授权）、安装/连接租户臂（data 仅 SELECT；operator 安装全管、连接无 UPDATE——解绑 = 删行）；directory 三表零授权。",
      objects: [
        "enterprise_plugin_catalog",
        "enterprise_plugin_installs",
        "enterprise_plugin_connections",
      ],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_plugin_catalog" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_plugin_catalog" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_plugin_catalog" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_plugin_catalog_data_read" ON "enterprise_plugin_catalog"\n  FOR SELECT TO ob_ent_data\n  USING (true);',
        'CREATE POLICY "enterprise_plugin_catalog_operator_read" ON "enterprise_plugin_catalog"\n  FOR SELECT TO ob_ent_operator\n  USING (true);',
        'GRANT SELECT ON TABLE "enterprise_plugin_catalog" TO ob_ent_data, ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_plugin_installs" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_plugin_installs" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_plugin_installs" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_plugin_install_data_read" ON "enterprise_plugin_installs"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_plugin_install_operator_read" ON "enterprise_plugin_installs"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_plugin_install_operator_insert" ON "enterprise_plugin_installs"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_plugin_install_operator_update" ON "enterprise_plugin_installs"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_plugin_install_operator_delete" ON "enterprise_plugin_installs"\n  FOR DELETE TO ob_ent_operator\n  USING ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_plugin_installs" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT, UPDATE, DELETE ON TABLE "enterprise_plugin_installs" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_plugin_connections" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_plugin_connections" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_plugin_connections" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_plugin_connection_data_read" ON "enterprise_plugin_connections"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_plugin_connections"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_plugin_connection_operator_read" ON "enterprise_plugin_connections"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_plugin_connections"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_plugin_connection_operator_insert" ON "enterprise_plugin_connections"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_plugin_connections"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_plugin_connection_operator_delete" ON "enterprise_plugin_connections"\n  FOR DELETE TO ob_ent_operator\n  USING ("enterprise_plugin_connections"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_plugin_connections" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT, DELETE ON TABLE "enterprise_plugin_connections" TO ob_ent_operator;',
      ],
    },
  ],
};

const PACKAGE_INSTALL_TASK: TaskMigrationSpec = {
  id: "PKG02",
  description:
    "PKG02（Issue #461）：新增插件包范围安装存储（installs/revisions/plans/resource links/changes，expand-only，最小 RLS 与追加写授权；为 MT031 连接器安装表补范围唯一索引）。",
  steps: [
    {
      slug: "package_tables",
      impact:
        "新增五张包安装表：install（范围+包唯一、正数 generation/revision、tombstone status）、revision（不可变版本/digest/闭形 config）、plan（actor/principal/操作/输入摘要/10 分钟过期/消费与结果）、resource link（种类互斥 CHECK，连接器复合外键指向 MT031 install 表）、change（追加回执 + 非空幂等键部分唯一）。并为 enterprise_plugin_installs 补 (tenant_id, workspace_id, id) 唯一索引（资源链接复合外键所需）。不改既有表列/策略。",
      objects: [
        "enterprise_package_installs",
        "enterprise_package_revisions",
        "enterprise_package_plans",
        "enterprise_package_resource_links",
        "enterprise_package_changes",
        "enterprise_plugin_installs",
      ],
      statements: [
        'CREATE TABLE "enterprise_package_installs" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"package_key" text NOT NULL,\n' +
          '\t"current_version" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'enabled' NOT NULL,\n" +
          '\t"generation" integer DEFAULT 1 NOT NULL,\n' +
          '\t"revision" integer DEFAULT 1 NOT NULL,\n' +
          '\t"installed_by" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_package_installs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          "\tCONSTRAINT \"enterprise_package_install_status\" CHECK (\"enterprise_package_installs\".\"status\" in ('enabled','disabled','uninstalled')),\n" +
          '\tCONSTRAINT "enterprise_package_install_counters" CHECK ("enterprise_package_installs"."generation" > 0 and "enterprise_package_installs"."revision" > 0),\n' +
          '\tCONSTRAINT "enterprise_package_install_package_key" CHECK (char_length("enterprise_package_installs"."package_key") between 3 and 129 and "enterprise_package_installs"."package_key" like \'%/%\')\n' +
          ");",
        'ALTER TABLE "enterprise_package_installs" ADD CONSTRAINT "enterprise_package_installs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_installs" ADD CONSTRAINT "enterprise_package_installs_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_installs" ADD CONSTRAINT "enterprise_package_installs_tenant_id_installed_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","installed_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE UNIQUE INDEX "enterprise_package_install_scope_key_uq" ON "enterprise_package_installs" ("tenant_id","workspace_id","package_key");',
        'CREATE INDEX "enterprise_package_install_workspace_idx" ON "enterprise_package_installs" ("tenant_id","workspace_id","package_key");',
        'CREATE UNIQUE INDEX "enterprise_plugin_install_scope_id_uq" ON "enterprise_plugin_installs" ("tenant_id","workspace_id","id");',
        'CREATE TABLE "enterprise_package_revisions" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"install_id" text NOT NULL,\n' +
          '\t"revision" integer NOT NULL,\n' +
          '\t"release_version" text NOT NULL,\n' +
          '\t"artifact_digest" text NOT NULL,\n' +
          '\t"config" jsonb NOT NULL,\n' +
          '\t"created_by" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_package_revisions_tenant_id_install_id_revision_pk" PRIMARY KEY("tenant_id","install_id","revision"),\n' +
          '\tCONSTRAINT "enterprise_package_revision_positive" CHECK ("enterprise_package_revisions"."revision" > 0),\n' +
          '\tCONSTRAINT "enterprise_package_revision_digest" CHECK ("enterprise_package_revisions"."artifact_digest" ~ \'^[0-9a-f]{64}$\'),\n' +
          "\tCONSTRAINT \"enterprise_package_revision_config_shape\" CHECK (jsonb_typeof(\"enterprise_package_revisions\".\"config\") = 'object' and not \"enterprise_package_revisions\".\"config\" ?| array['envelope','plaintext','secret','password','token','apiKey','api_key','secretRef','encryptedValue','encrypted_value'])\n" +
          ");",
        'ALTER TABLE "enterprise_package_revisions" ADD CONSTRAINT "enterprise_package_revisions_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_revisions" ADD CONSTRAINT "enterprise_package_revisions_tenant_id_install_id_enterprise_package_installs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","install_id") REFERENCES "public"."enterprise_package_installs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_revisions" ADD CONSTRAINT "enterprise_package_revisions_tenant_id_created_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_package_revision_install_idx" ON "enterprise_package_revisions" ("tenant_id","install_id","revision");',
        'CREATE TABLE "enterprise_package_plans" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"actor_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"operation" text NOT NULL,\n' +
          '\t"package_key" text NOT NULL,\n' +
          '\t"version" text NOT NULL,\n' +
          '\t"artifact_digest" text NOT NULL,\n' +
          '\t"expected_revision" integer,\n' +
          '\t"canonical_input" jsonb NOT NULL,\n' +
          '\t"input_digest" text NOT NULL,\n' +
          '\t"preview" jsonb NOT NULL,\n' +
          '\t"expires_at" timestamp with time zone NOT NULL,\n' +
          '\t"consumed_at" timestamp with time zone,\n' +
          '\t"result" jsonb,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_package_plans_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          "\tCONSTRAINT \"enterprise_package_plan_operation\" CHECK (\"enterprise_package_plans\".\"operation\" in ('install','upgrade','rollback')),\n" +
          '\tCONSTRAINT "enterprise_package_plan_expected_revision" CHECK ("enterprise_package_plans"."expected_revision" is null or "enterprise_package_plans"."expected_revision" > 0),\n' +
          '\tCONSTRAINT "enterprise_package_plan_actor_shape" CHECK (char_length("enterprise_package_plans"."actor_id") between 1 and 128 and char_length("enterprise_package_plans"."principal_id") between 1 and 128),\n' +
          '\tCONSTRAINT "enterprise_package_plan_digests" CHECK ("enterprise_package_plans"."artifact_digest" ~ \'^[0-9a-f]{64}$\' and "enterprise_package_plans"."input_digest" ~ \'^[0-9a-f]{64}$\')\n' +
          ");",
        'ALTER TABLE "enterprise_package_plans" ADD CONSTRAINT "enterprise_package_plans_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_plans" ADD CONSTRAINT "enterprise_package_plans_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_plans" ADD CONSTRAINT "enterprise_package_plans_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_package_plan_expiry_idx" ON "enterprise_package_plans" ("tenant_id","expires_at");',
        'CREATE TABLE "enterprise_package_resource_links" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"install_id" text NOT NULL,\n' +
          '\t"revision" integer NOT NULL,\n' +
          '\t"resource_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"kind" text NOT NULL,\n' +
          '\t"existing_skill_id" text,\n' +
          '\t"connector_install_id" text,\n' +
          '\t"expert_template_ref" text,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_package_link_pk" PRIMARY KEY("tenant_id","install_id","revision","resource_id"),\n' +
          "\tCONSTRAINT \"enterprise_package_link_kind\" CHECK (\"enterprise_package_resource_links\".\"kind\" in ('skill','expertTemplate','managedConnector')),\n" +
          '\tCONSTRAINT "enterprise_package_link_reference_shape" CHECK (("enterprise_package_resource_links"."kind" = \'skill\' and "enterprise_package_resource_links"."existing_skill_id" is null and "enterprise_package_resource_links"."connector_install_id" is null and "enterprise_package_resource_links"."expert_template_ref" is null) or ("enterprise_package_resource_links"."kind" = \'managedConnector\' and "enterprise_package_resource_links"."existing_skill_id" is null and "enterprise_package_resource_links"."connector_install_id" is not null and "enterprise_package_resource_links"."expert_template_ref" is null) or ("enterprise_package_resource_links"."kind" = \'expertTemplate\' and "enterprise_package_resource_links"."existing_skill_id" is null and "enterprise_package_resource_links"."connector_install_id" is null and "enterprise_package_resource_links"."expert_template_ref" is not null))\n' +
          ");",
        'ALTER TABLE "enterprise_package_resource_links" ADD CONSTRAINT "enterprise_package_link_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_resource_links" ADD CONSTRAINT "enterprise_package_link_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_resource_links" ADD CONSTRAINT "enterprise_package_link_revision_fk" FOREIGN KEY ("tenant_id","install_id","revision") REFERENCES "public"."enterprise_package_revisions"("tenant_id","install_id","revision") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_resource_links" ADD CONSTRAINT "enterprise_package_link_connector_fk" FOREIGN KEY ("tenant_id","workspace_id","connector_install_id") REFERENCES "public"."enterprise_plugin_installs"("tenant_id","workspace_id","id") ON DELETE restrict ON UPDATE no action;',
        'CREATE INDEX "enterprise_package_link_revision_idx" ON "enterprise_package_resource_links" ("tenant_id","install_id","revision");',
        'CREATE TABLE "enterprise_package_changes" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"change_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"install_id" text NOT NULL,\n' +
          '\t"revision" integer NOT NULL,\n' +
          '\t"actor_id" text NOT NULL,\n' +
          '\t"action" text NOT NULL,\n' +
          '\t"diff" jsonb NOT NULL,\n' +
          "\t\"idempotency_key\" text DEFAULT '' NOT NULL,\n" +
          '\t"request_digest" text NOT NULL,\n' +
          '\t"result_json" jsonb NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_package_changes_tenant_id_change_id_pk" PRIMARY KEY("tenant_id","change_id"),\n' +
          "\tCONSTRAINT \"enterprise_package_change_action\" CHECK (\"enterprise_package_changes\".\"action\" in ('install','upgrade','rollback')),\n" +
          '\tCONSTRAINT "enterprise_package_change_key" CHECK (char_length("enterprise_package_changes"."idempotency_key") <= 128 and "enterprise_package_changes"."request_digest" ~ \'^[0-9a-f]{64}$\'),\n' +
          "\tCONSTRAINT \"enterprise_package_change_diff_shape\" CHECK (jsonb_typeof(\"enterprise_package_changes\".\"diff\") = 'object' and not \"enterprise_package_changes\".\"diff\" ?| array['envelope','plaintext','secret','password','token','apiKey','api_key','secretRef','encryptedValue','encrypted_value'])\n" +
          ");",
        'ALTER TABLE "enterprise_package_changes" ADD CONSTRAINT "enterprise_package_changes_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_changes" ADD CONSTRAINT "enterprise_package_changes_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_changes" ADD CONSTRAINT "enterprise_package_changes_tenant_id_install_id_revision_enterprise_package_revisions_tenant_id_install_id_revision_fk" FOREIGN KEY ("tenant_id","install_id","revision") REFERENCES "public"."enterprise_package_revisions"("tenant_id","install_id","revision") ON DELETE cascade ON UPDATE no action;',
        'CREATE UNIQUE INDEX "enterprise_package_change_idempotency_uq" ON "enterprise_package_changes" ("tenant_id","workspace_id","actor_id","idempotency_key") WHERE "idempotency_key" <> \'\';',
        'CREATE INDEX "enterprise_package_change_install_idx" ON "enterprise_package_changes" ("tenant_id","install_id","revision");',
      ],
    },
    {
      slug: "package_rls_policies",
      impact:
        "五张新表的 FORCE RLS 与最小授权：data 角色只读（租户臂 + 团队臂；revision 经 install 团队存在性）；operator 角色 install/plan 可读可写（plan 仅 UPDATE 消费）、revision/link/change 追加写（INSERT+SELECT，无 UPDATE/DELETE）；directory 零授权。",
      objects: [
        "enterprise_package_installs",
        "enterprise_package_revisions",
        "enterprise_package_plans",
        "enterprise_package_resource_links",
        "enterprise_package_changes",
      ],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_package_installs" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_package_installs" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_package_installs" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_package_install_data_read" ON "enterprise_package_installs"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_package_installs"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_package_installs"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_install_operator_read" ON "enterprise_package_installs"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_package_installs"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_install_operator_insert" ON "enterprise_package_installs"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_package_installs"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_install_operator_update" ON "enterprise_package_installs"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_package_installs"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_package_installs"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_package_installs" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT, UPDATE ON TABLE "enterprise_package_installs" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_package_revisions" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_package_revisions" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_package_revisions" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_package_revision_data_read" ON "enterprise_package_revisions"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_package_revisions"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND exists (select 1 from "enterprise_package_installs" i where i."tenant_id" = "enterprise_package_revisions"."tenant_id" and i."id" = "enterprise_package_revisions"."install_id" and i."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\')));',
        'CREATE POLICY "enterprise_package_revision_operator_read" ON "enterprise_package_revisions"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_package_revisions"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_revision_operator_insert" ON "enterprise_package_revisions"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_package_revisions"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_package_revisions" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_package_revisions" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_package_plans" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_package_plans" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_package_plans" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_package_plan_data_read" ON "enterprise_package_plans"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_package_plans"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_package_plans"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_plan_operator_read" ON "enterprise_package_plans"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_package_plans"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_plan_operator_insert" ON "enterprise_package_plans"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_package_plans"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_plan_operator_update" ON "enterprise_package_plans"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_package_plans"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_package_plans"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_package_plans" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT, UPDATE ON TABLE "enterprise_package_plans" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_package_resource_links" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_package_resource_links" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_package_resource_links" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_package_link_data_read" ON "enterprise_package_resource_links"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_package_resource_links"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_package_resource_links"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_link_operator_read" ON "enterprise_package_resource_links"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_package_resource_links"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_link_operator_insert" ON "enterprise_package_resource_links"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_package_resource_links"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_package_resource_links" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_package_resource_links" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_package_changes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_package_changes" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_package_changes" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_package_change_data_read" ON "enterprise_package_changes"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_package_changes"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_package_changes"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_change_operator_read" ON "enterprise_package_changes"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_package_changes"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_change_operator_insert" ON "enterprise_package_changes"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_package_changes"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_package_changes" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_package_changes" TO ob_ent_operator;',
      ],
    },
    {
      slug: "package_hardening",
      impact:
        '加固（追加步骤，不重写已应用的 0001/0002）：删除与主键/唯一索引重复的三个索引；把 revision config、change diff 的秘密载体 CHECK 改为递归检查任意深度的键（旧 CHECK 只看顶层键，嵌套 {"nested":{"token":…}} 可通过）；为 plan 的 canonical_input 新增同样的闭形与递归秘密 CHECK。',
      objects: [
        "enterprise_package_installs",
        "enterprise_package_revisions",
        "enterprise_package_plans",
        "enterprise_package_resource_links",
        "enterprise_package_changes",
      ],
      statements: [
        // The three indexes below duplicate a PK or UNIQUE prefix.
        'DROP INDEX IF EXISTS "enterprise_package_install_workspace_idx";',
        'DROP INDEX IF EXISTS "enterprise_package_revision_install_idx";',
        'DROP INDEX IF EXISTS "enterprise_package_link_revision_idx";',
        'ALTER TABLE "enterprise_package_revisions" DROP CONSTRAINT IF EXISTS "enterprise_package_revision_config_shape";',
        `ALTER TABLE "enterprise_package_revisions" ADD CONSTRAINT "enterprise_package_revision_config_shape" CHECK (jsonb_typeof("enterprise_package_revisions"."config") = 'object' and not jsonb_path_exists("enterprise_package_revisions"."config", '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(envelope|plaintext|secret|password|token|apiKey|api_key|secretRef|encryptedValue|encrypted_value)$")'));`,
        'ALTER TABLE "enterprise_package_plans" DROP CONSTRAINT IF EXISTS "enterprise_package_plan_input_shape";',
        `ALTER TABLE "enterprise_package_plans" ADD CONSTRAINT "enterprise_package_plan_input_shape" CHECK (jsonb_typeof("enterprise_package_plans"."canonical_input") = 'object' and not jsonb_path_exists("enterprise_package_plans"."canonical_input", '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(envelope|plaintext|secret|password|token|apiKey|api_key|secretRef|encryptedValue|encrypted_value)$")'));`,
        'ALTER TABLE "enterprise_package_changes" DROP CONSTRAINT IF EXISTS "enterprise_package_change_diff_shape";',
        `ALTER TABLE "enterprise_package_changes" ADD CONSTRAINT "enterprise_package_change_diff_shape" CHECK (jsonb_typeof("enterprise_package_changes"."diff") = 'object' and not jsonb_path_exists("enterprise_package_changes"."diff", '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(envelope|plaintext|secret|password|token|apiKey|api_key|secretRef|encryptedValue|encrypted_value)$")'));`,
      ],
    },
    {
      slug: "package_hardening_case_insensitive",
      impact:
        'R5-4（OCR round5，追加步骤，不改已入账步骤）：package_hardening 的三个递归秘密载体 CHECK（revision config / plans canonical_input / changes diff）的 like_regex 补 flag "i"——键名大小写变体（"Token"/"API_KEY"/"SecretRef"）此前可穿透 DB 级防线，与 PKG04 强化函数（package_expert_create_function_hardening）属同一漏洞家族。约束名不变，仅 DROP+重建；CHECK 只约束新写入，既有行不受影响。',
      objects: [
        "enterprise_package_revisions",
        "enterprise_package_plans",
        "enterprise_package_changes",
      ],
      statements: [
        'ALTER TABLE "enterprise_package_revisions" DROP CONSTRAINT IF EXISTS "enterprise_package_revision_config_shape";',
        `ALTER TABLE "enterprise_package_revisions" ADD CONSTRAINT "enterprise_package_revision_config_shape" CHECK (jsonb_typeof("enterprise_package_revisions"."config") = 'object' and not jsonb_path_exists("enterprise_package_revisions"."config", '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(envelope|plaintext|secret|password|token|apiKey|api_key|secretRef|encryptedValue|encrypted_value)$" flag "i")'));`,
        'ALTER TABLE "enterprise_package_plans" DROP CONSTRAINT IF EXISTS "enterprise_package_plan_input_shape";',
        `ALTER TABLE "enterprise_package_plans" ADD CONSTRAINT "enterprise_package_plan_input_shape" CHECK (jsonb_typeof("enterprise_package_plans"."canonical_input") = 'object' and not jsonb_path_exists("enterprise_package_plans"."canonical_input", '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(envelope|plaintext|secret|password|token|apiKey|api_key|secretRef|encryptedValue|encrypted_value)$" flag "i")'));`,
        'ALTER TABLE "enterprise_package_changes" DROP CONSTRAINT IF EXISTS "enterprise_package_change_diff_shape";',
        `ALTER TABLE "enterprise_package_changes" ADD CONSTRAINT "enterprise_package_change_diff_shape" CHECK (jsonb_typeof("enterprise_package_changes"."diff") = 'object' and not jsonb_path_exists("enterprise_package_changes"."diff", '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(envelope|plaintext|secret|password|token|apiKey|api_key|secretRef|encryptedValue|encrypted_value)$" flag "i")'));`,
      ],
    },
  ],
};

const PACKAGE_GRANT_TASK: TaskMigrationSpec = {
  id: "PKG03",
  description:
    "PKG03（Issue #462）：新增插件包 Bot 授权表 enterprise_package_grants（expand-only，最小 RLS 与授权；为包安装表补范围唯一索引；changes 动作 CHECK 扩到 grant/revoke）。",
  steps: [
    {
      slug: "package_grant_table",
      impact:
        "新增 enterprise_package_grants 表：主键 (tenant_id, install_id, generation, bot_id, resource_id)；resource_kind/tool_ref 两面 CHECK（skill 行 tool_ref 固定空串，connectorTool 行必须非空）；generation 正数 CHECK；复合外键钉 tenants/workspaces/包安装表/MT016 Bot 归属/公司成员关系；活跃授权 (tenant, install, bot, resource, tool_ref) 部分唯一。并为 enterprise_package_installs 补 (tenant_id, workspace_id, id) 唯一索引（授权复合外键所需）。不改既有表列/策略。",
      objects: ["enterprise_package_grants", "enterprise_package_installs"],
      statements: [
        'CREATE UNIQUE INDEX "enterprise_package_install_scope_id_uq" ON "enterprise_package_installs" ("tenant_id","workspace_id","id");',
        'CREATE TABLE "enterprise_package_grants" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"install_id" text NOT NULL,\n' +
          '\t"generation" integer NOT NULL,\n' +
          '\t"bot_id" text NOT NULL,\n' +
          '\t"resource_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          "\t\"resource_kind\" text DEFAULT 'skill' NOT NULL,\n" +
          "\t\"tool_ref\" text DEFAULT '' NOT NULL,\n" +
          '\t"granted_by" text NOT NULL,\n' +
          '\t"granted_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"revoked_at" timestamp with time zone,\n' +
          '\tCONSTRAINT "enterprise_package_grant_pk" PRIMARY KEY("tenant_id","install_id","generation","bot_id","resource_id"),\n' +
          '\tCONSTRAINT "enterprise_package_grant_generation" CHECK ("enterprise_package_grants"."generation" > 0),\n' +
          '\tCONSTRAINT "enterprise_package_grant_tool_ref" CHECK (("enterprise_package_grants"."resource_kind" = \'skill\' and "enterprise_package_grants"."tool_ref" = \'\') or ("enterprise_package_grants"."resource_kind" = \'connectorTool\' and "enterprise_package_grants"."tool_ref" <> \'\')),\n' +
          '\tCONSTRAINT "enterprise_package_grant_ids" CHECK (char_length("enterprise_package_grants"."resource_id") between 1 and 64 and char_length("enterprise_package_grants"."bot_id") between 1 and 256)\n' +
          ");",
        'ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_install_fk" FOREIGN KEY ("tenant_id","workspace_id","install_id") REFERENCES "public"."enterprise_package_installs"("tenant_id","workspace_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_bot_fk" FOREIGN KEY ("tenant_id","bot_id") REFERENCES "public"."enterprise_bot_ownership"("tenant_id","agent_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_granted_by_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE UNIQUE INDEX "enterprise_package_grant_active_uq" ON "enterprise_package_grants" ("tenant_id","install_id","bot_id","resource_id","tool_ref") WHERE "revoked_at" is null;',
      ],
    },
    {
      slug: "package_grant_rls",
      impact:
        "enterprise_package_grants 的 FORCE RLS 与最小授权：data 只读（租户臂 + 团队臂）；operator 租户臂读 + INSERT + UPDATE（撤销写 revoked_at 所需，无 DELETE）；directory 零授权。",
      objects: ["enterprise_package_grants"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_package_grants" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_package_grants" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_package_grants" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_package_grant_data_read" ON "enterprise_package_grants"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_package_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_package_grants"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_grant_operator_read" ON "enterprise_package_grants"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_package_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_grant_operator_insert" ON "enterprise_package_grants"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_package_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_grant_operator_update" ON "enterprise_package_grants"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_package_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_package_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_package_grants" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT, UPDATE ON TABLE "enterprise_package_grants" TO ob_ent_operator;',
      ],
    },
    {
      slug: "package_changes_grant_actions",
      impact:
        "把 enterprise_package_changes 的动作 CHECK 从 ('install','upgrade','rollback') 扩到含 'grant'/'revoke'（授权与撤权回执与领域变更同事务追加；约束只放宽不收紧，expand-only）。",
      objects: ["enterprise_package_changes"],
      statements: [
        'ALTER TABLE "enterprise_package_changes" DROP CONSTRAINT "enterprise_package_change_action";',
        "ALTER TABLE \"enterprise_package_changes\" ADD CONSTRAINT \"enterprise_package_change_action\" CHECK (\"enterprise_package_changes\".\"action\" in ('install','upgrade','rollback','grant','revoke'));",
      ],
    },
    {
      slug: "package_run_pin_table",
      impact:
        "slice B：新增 enterprise_run_package_pins（Run 准入经包运行时模块写入的钉扎表）。主键 (tenant_id, run_id, attempt_generation, install_id)；attempt_generation/revision/grant_revision 正数 CHECK；release_digest 64 位十六进制 CHECK；allowed_resource_ids jsonb 数组（≤256）CHECK；复合外键钉 tenants/workspaces/enterprise_runs/包安装表（复用 PKG03 第 1 步的范围唯一索引）。不可变行：无 UPDATE/DELETE 通道。",
      objects: ["enterprise_run_package_pins", "enterprise_runs"],
      statements: [
        'CREATE TABLE "enterprise_run_package_pins" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"run_id" uuid NOT NULL,\n' +
          '\t"attempt_generation" integer NOT NULL,\n' +
          '\t"install_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"revision" integer NOT NULL,\n' +
          '\t"release_digest" text NOT NULL,\n' +
          '\t"grant_revision" integer NOT NULL,\n' +
          '\t"allowed_resource_ids" jsonb NOT NULL,\n' +
          '\t"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_run_package_pin_pk" PRIMARY KEY("tenant_id","run_id","attempt_generation","install_id"),\n' +
          '\tCONSTRAINT "enterprise_run_package_pin_generation" CHECK ("enterprise_run_package_pins"."attempt_generation" > 0),\n' +
          '\tCONSTRAINT "enterprise_run_package_pin_revision" CHECK ("enterprise_run_package_pins"."revision" > 0 and "enterprise_run_package_pins"."grant_revision" > 0),\n' +
          '\tCONSTRAINT "enterprise_run_package_pin_digest" CHECK ("enterprise_run_package_pins"."release_digest" ~ \'^[0-9a-f]{64}$\'),\n' +
          '\tCONSTRAINT "enterprise_run_package_pin_allowed_shape" CHECK (jsonb_typeof("enterprise_run_package_pins"."allowed_resource_ids") = \'array\' and jsonb_array_length("enterprise_run_package_pins"."allowed_resource_ids") <= 256)\n' +
          ");",
        'ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_install_fk" FOREIGN KEY ("tenant_id","workspace_id","install_id") REFERENCES "public"."enterprise_package_installs"("tenant_id","workspace_id","id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "package_run_pin_rls",
      impact:
        "enterprise_run_package_pins 的 FORCE RLS 与最小授权：data 读租户+团队臂 + 最小 INSERT（租户+团队臂——Run 写事务与 pin 同事务提交，规范 §6/§9）；operator 仅读+INSERT（租户臂，装配与测试通道）；无 UPDATE/DELETE；directory 零授权。",
      objects: ["enterprise_run_package_pins"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_run_package_pins" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_run_package_pins" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_run_package_pins" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_run_package_pin_data_read" ON "enterprise_run_package_pins"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_run_package_pins"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_run_package_pins"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'));',
        'CREATE POLICY "enterprise_run_package_pin_data_insert" ON "enterprise_run_package_pins"\n  FOR INSERT TO ob_ent_data\n  WITH CHECK ("enterprise_run_package_pins"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_run_package_pins"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'));',
        'CREATE POLICY "enterprise_run_package_pin_operator_read" ON "enterprise_run_package_pins"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_run_package_pins"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_run_package_pin_operator_insert" ON "enterprise_run_package_pins"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_run_package_pins"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT, INSERT ON TABLE "enterprise_run_package_pins" TO ob_ent_data;',
        'GRANT SELECT, INSERT ON TABLE "enterprise_run_package_pins" TO ob_ent_operator;',
      ],
    },
    {
      slug: "package_grant_pk_tool_ref",
      impact:
        "R4-2（OCR round4，追加步骤）：把 enterprise_package_grants 的主键从五列 (tenant_id, install_id, generation, bot_id, resource_id) 重建为含 tool_ref 的六列，与活跃唯一索引 (tenant, install, bot, resource, tool_ref) 及其 one-connector-resource-grants-per-tool 语义一致。既有行 tool_ref 全为空串（slice A 只写 skill 行），旧主键唯一 ⇒ 新主键唯一：对存量等价，唯一性只放宽（expand-compatible）。",
      objects: ["enterprise_package_grants"],
      statements: [
        'ALTER TABLE "enterprise_package_grants" DROP CONSTRAINT "enterprise_package_grant_pk";',
        'ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_pk" PRIMARY KEY("tenant_id","install_id","generation","bot_id","resource_id","tool_ref");',
      ],
    },
  ],
};

const PACKAGE_EXPERT_TASK: TaskMigrationSpec = {
  id: "PKG04",
  description:
    "PKG04（Issue #463）：新增插件包专家来源表 enterprise_package_experts 与受限创建函数 openbot_create_package_expert（expand-only：新表+最小 RLS、changes 动作 CHECK 追加 'createExpert'、受控函数授权）。",
  steps: [
    {
      slug: "package_expert_table",
      impact:
        "新增 enterprise_package_experts 表：主键 (tenant_id, agent_id)；revision 正数与列长 CHECK；复合外键钉 tenants/workspaces/包安装表/MT016 Bot 归属/公司成员关系。不修改既有表列/策略。",
      objects: ["enterprise_package_experts"],
      statements: [
        'CREATE TABLE "enterprise_package_experts" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"agent_id" text NOT NULL,\n' +
          '\t"install_id" text NOT NULL,\n' +
          '\t"revision" integer NOT NULL,\n' +
          '\t"resource_id" text NOT NULL,\n' +
          '\t"expert_template_ref" text NOT NULL,\n' +
          '\t"created_by" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_package_expert_pk" PRIMARY KEY("tenant_id","agent_id"),\n' +
          '\tCONSTRAINT "enterprise_package_expert_revision" CHECK ("enterprise_package_experts"."revision" > 0),\n' +
          '\tCONSTRAINT "enterprise_package_expert_ids" CHECK (char_length("enterprise_package_experts"."agent_id") between 1 and 256 and char_length("enterprise_package_experts"."resource_id") between 1 and 64 and char_length("enterprise_package_experts"."expert_template_ref") between 1 and 256)\n' +
          ");",
        'ALTER TABLE "enterprise_package_experts" ADD CONSTRAINT "enterprise_package_expert_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_experts" ADD CONSTRAINT "enterprise_package_expert_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_experts" ADD CONSTRAINT "enterprise_package_expert_install_fk" FOREIGN KEY ("tenant_id","workspace_id","install_id") REFERENCES "public"."enterprise_package_installs"("tenant_id","workspace_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_experts" ADD CONSTRAINT "enterprise_package_expert_bot_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."enterprise_bot_ownership"("tenant_id","agent_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_experts" ADD CONSTRAINT "enterprise_package_expert_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "package_expert_rls",
      impact:
        "enterprise_package_experts 的 FORCE RLS 与最小授权：data 只读（租户+团队臂）；operator 租户臂读 + INSERT；无 UPDATE/DELETE（来源行不可变）；directory 零授权。",
      objects: ["enterprise_package_experts"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_package_experts" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_package_experts" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_package_experts" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_package_expert_data_read" ON "enterprise_package_experts"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_package_experts"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_package_experts"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_expert_operator_read" ON "enterprise_package_experts"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_package_experts"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_expert_operator_insert" ON "enterprise_package_experts"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_package_experts"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_package_experts" TO ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_package_experts" TO ob_ent_operator;',
      ],
    },
    {
      slug: "package_changes_create_expert_action",
      impact:
        "把 enterprise_package_changes 的动作 CHECK 从 ('install','upgrade','rollback','grant','revoke') 扩到含 'createExpert'（专家创建回执与领域变更同事务追加；幂等复用既有 (tenant, workspace, actor, key) 唯一；约束只放宽不收紧，expand-only）。",
      objects: ["enterprise_package_changes"],
      statements: [
        'ALTER TABLE "enterprise_package_changes" DROP CONSTRAINT "enterprise_package_change_action";',
        "ALTER TABLE \"enterprise_package_changes\" ADD CONSTRAINT \"enterprise_package_change_action\" CHECK (\"enterprise_package_changes\".\"action\" in ('install','upgrade','rollback','grant','revoke','createExpert'));",
      ],
    },
    {
      slug: "package_expert_create_function",
      impact:
        "受限创建函数 openbot_create_package_expert：plpgsql、固定 search_path=pg_catalog、全限定表名、无动态 SQL；重验 app.tenant_id/app.workspace_id 与调用参数一致、强制 default_config 为携带 agentType='built_in' 的对象并拒绝 endpoint/auth 类键后才 INSERT enterprise_bot_ownership（内置 active/revision=1/acl_epoch=1）。PUBLIC 零 EXECUTE，仅 ob_ent_operator 获 EXECUTE；不授予任何额外表权限（INVOKER，RLS 照常生效）。",
      objects: ["openbot_create_package_expert"],
      statements: [
        'CREATE FUNCTION "public"."openbot_create_package_expert"("p_tenant_id" text, "p_agent_id" text, "p_workspace_id" text, "p_owner_principal_id" text, "p_display_name" text, "p_default_config" jsonb) RETURNS text\n' +
          "LANGUAGE plpgsql\n" +
          "SET search_path = pg_catalog\n" +
          "AS $function$\n" +
          "BEGIN\n" +
          '  IF "p_tenant_id" IS NULL OR "p_tenant_id" = \'\' OR char_length("p_tenant_id") > 256\n' +
          '     OR "p_agent_id" IS NULL OR "p_agent_id" = \'\' OR char_length("p_agent_id") > 256\n' +
          '     OR "p_workspace_id" IS NULL OR "p_workspace_id" = \'\' OR char_length("p_workspace_id") > 256\n' +
          '     OR "p_owner_principal_id" IS NULL OR "p_owner_principal_id" = \'\' OR char_length("p_owner_principal_id") > 256\n' +
          '     OR "p_display_name" IS NULL OR char_length("p_display_name") NOT BETWEEN 1 AND 256 THEN\n' +
          "    RAISE EXCEPTION 'PKG_EXPERT_INPUT_INVALID';\n" +
          "  END IF;\n" +
          "  IF \"p_tenant_id\" IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')\n" +
          "     OR \"p_workspace_id\" IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '') THEN\n" +
          "    RAISE EXCEPTION 'PKG_EXPERT_CONTEXT_MISMATCH';\n" +
          "  END IF;\n" +
          '  IF "p_default_config" IS NULL OR jsonb_typeof("p_default_config") <> \'object\' THEN\n' +
          "    RAISE EXCEPTION 'PKG_EXPERT_CONFIG_INVALID';\n" +
          "  END IF;\n" +
          "  IF \"p_default_config\" ?| array['endpoint','auth','authorization','apiKey','api_key','remoteAgentId','bearer']\n" +
          "     OR \"p_default_config\" ->> 'agentType' IS DISTINCT FROM 'built_in' THEN\n" +
          "    RAISE EXCEPTION 'PKG_EXPERT_REMOTE_FORBIDDEN';\n" +
          "  END IF;\n" +
          '  INSERT INTO "public"."enterprise_bot_ownership"\n' +
          '    ("tenant_id", "agent_id", "workspace_id", "owner_principal_id", "display_name", "default_config", "status", "revision", "acl_epoch")\n' +
          "  VALUES\n" +
          '    ("p_tenant_id", "p_agent_id", "p_workspace_id", "p_owner_principal_id", "p_display_name", "p_default_config", \'active\', 1, 1);\n' +
          '  RETURN "p_agent_id";\n' +
          "END\n" +
          "$function$;",
        'REVOKE ALL ON FUNCTION "public"."openbot_create_package_expert"(text, text, text, text, text, jsonb) FROM PUBLIC;',
        'GRANT EXECUTE ON FUNCTION "public"."openbot_create_package_expert"(text, text, text, text, text, jsonb) TO ob_ent_operator;',
      ],
    },
    {
      slug: "package_expert_create_function_hardening",
      impact:
        "R4-4（OCR round4，追加步骤，CREATE OR REPLACE 不改已入账步骤）：openbot_create_package_expert 的敏感键防线从顶层 ?|（大小写敏感）强化为递归 + 键名大小写不敏感扫描（对齐 package_hardening 的 $.** keyvalue 递归风格，flag \"i\"）；拒绝键集合并入原 endpoint/auth 列表与秘密载体列表。agentType='built_in' 判定与函数签名、search_path、上下文重验、RLS/授权全部保持不变（OR REPLACE 保留既有 ACL）。",
      objects: ["openbot_create_package_expert"],
      statements: [
        'CREATE OR REPLACE FUNCTION "public"."openbot_create_package_expert"("p_tenant_id" text, "p_agent_id" text, "p_workspace_id" text, "p_owner_principal_id" text, "p_display_name" text, "p_default_config" jsonb) RETURNS text\n' +
          "LANGUAGE plpgsql\n" +
          "SET search_path = pg_catalog\n" +
          "AS $function$\n" +
          "BEGIN\n" +
          '  IF "p_tenant_id" IS NULL OR "p_tenant_id" = \'\' OR char_length("p_tenant_id") > 256\n' +
          '     OR "p_agent_id" IS NULL OR "p_agent_id" = \'\' OR char_length("p_agent_id") > 256\n' +
          '     OR "p_workspace_id" IS NULL OR "p_workspace_id" = \'\' OR char_length("p_workspace_id") > 256\n' +
          '     OR "p_owner_principal_id" IS NULL OR "p_owner_principal_id" = \'\' OR char_length("p_owner_principal_id") > 256\n' +
          '     OR "p_display_name" IS NULL OR char_length("p_display_name") NOT BETWEEN 1 AND 256 THEN\n' +
          "    RAISE EXCEPTION 'PKG_EXPERT_INPUT_INVALID';\n" +
          "  END IF;\n" +
          "  IF \"p_tenant_id\" IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')\n" +
          "     OR \"p_workspace_id\" IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '') THEN\n" +
          "    RAISE EXCEPTION 'PKG_EXPERT_CONTEXT_MISMATCH';\n" +
          "  END IF;\n" +
          '  IF "p_default_config" IS NULL OR jsonb_typeof("p_default_config") <> \'object\' THEN\n' +
          "    RAISE EXCEPTION 'PKG_EXPERT_CONFIG_INVALID';\n" +
          "  END IF;\n" +
          "  IF jsonb_path_exists(\n" +
          '       "p_default_config",\n' +
          '       \'$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(envelope|plaintext|secret|password|token|apiKey|api_key|secretRef|encryptedValue|encrypted_value|endpoint|auth|authorization|remoteAgentId|bearer)$" flag "i")\'\n' +
          "     )\n" +
          "     OR \"p_default_config\" ->> 'agentType' IS DISTINCT FROM 'built_in' THEN\n" +
          "    RAISE EXCEPTION 'PKG_EXPERT_REMOTE_FORBIDDEN';\n" +
          "  END IF;\n" +
          '  INSERT INTO "public"."enterprise_bot_ownership"\n' +
          '    ("tenant_id", "agent_id", "workspace_id", "owner_principal_id", "display_name", "default_config", "status", "revision", "acl_epoch")\n' +
          "  VALUES\n" +
          '    ("p_tenant_id", "p_agent_id", "p_workspace_id", "p_owner_principal_id", "p_display_name", "p_default_config", \'active\', 1, 1);\n' +
          '  RETURN "p_agent_id";\n' +
          "END\n" +
          "$function$;",
      ],
    },
  ],
};

/**
 * PKG05（Issue #464）：受管工具派发。expand-only——新增
 * enterprise_package_dispatches（派发状态机 prepared→dispatched→
 * succeeded/failed/unknown|cancelled，同 attempt+tool_call 唯一）；为
 * enterprise_package_grants 补 connector 工具授权三列（schema_digest/
 * effect/connector_install_id + 复合外键）；为 enterprise_run_package_pins
 * 补 allowed_tool_bindings（钉扎工具集合）与 install_generation。不重写任何
 * 已应用步骤文本，不改任何既有策略/授权。
 */
const PACKAGE_DISPATCH_TASK: TaskMigrationSpec = {
  id: "PKG05",
  description:
    "PKG05（Issue #464）：插件包受管工具派发——dispatch 状态机表、connector 工具授权三列、Run 钉扎工具集合（expand-only，最小 RLS 与授权）。",
  steps: [
    {
      slug: "package_dispatch_table",
      impact:
        "新增 enterprise_package_dispatches：主键 (tenant_id, operation_id)；run/attempt/tool_call_id 唯一（同一 attempt 的重复调用至多派发一次）；state 闭集 CHECK（prepared/dispatched/succeeded/failed/unknown/cancelled）；args_digest 64 位十六进制、effect ∈ read/write、generation 正数 CHECK；复合外键钉 tenants/workspaces/enterprise_runs/包安装表。行只存 id 与摘要：参数正文、token、供应商文本一律不落表。",
      objects: ["enterprise_package_dispatches"],
      statements: [
        'CREATE TABLE "enterprise_package_dispatches" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"operation_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"run_id" uuid NOT NULL,\n' +
          '\t"attempt_generation" integer NOT NULL,\n' +
          '\t"tool_call_id" text NOT NULL,\n' +
          '\t"install_id" text NOT NULL,\n' +
          '\t"revision" integer NOT NULL,\n' +
          '\t"resource_id" text NOT NULL,\n' +
          '\t"tool_ref" text NOT NULL,\n' +
          '\t"connector_install_id" text NOT NULL,\n' +
          '\t"connection_id" text,\n' +
          '\t"connection_generation" integer NOT NULL,\n' +
          '\t"args_digest" text NOT NULL,\n' +
          '\t"effect" text NOT NULL,\n' +
          "\t\"state\" text DEFAULT 'prepared' NOT NULL,\n" +
          '\t"receipt_ref" jsonb,\n' +
          '\t"error_code" text,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"completed_at" timestamp with time zone,\n' +
          '\tCONSTRAINT "enterprise_package_dispatch_pk" PRIMARY KEY("tenant_id","operation_id"),\n' +
          "\tCONSTRAINT \"enterprise_package_dispatch_state\" CHECK (\"enterprise_package_dispatches\".\"state\" in ('prepared','dispatched','succeeded','failed','unknown','cancelled')),\n" +
          '\tCONSTRAINT "enterprise_package_dispatch_counters" CHECK ("enterprise_package_dispatches"."attempt_generation" > 0 and "enterprise_package_dispatches"."revision" > 0 and "enterprise_package_dispatches"."connection_generation" > 0),\n' +
          '\tCONSTRAINT "enterprise_package_dispatch_digest" CHECK ("enterprise_package_dispatches"."args_digest" ~ \'^[0-9a-f]{64}$\'),\n' +
          '\tCONSTRAINT "enterprise_package_dispatch_effect" CHECK ("enterprise_package_dispatches"."effect" in (\'read\',\'write\'))\n' +
          ");",
        'ALTER TABLE "enterprise_package_dispatches" ADD CONSTRAINT "enterprise_package_dispatch_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_dispatches" ADD CONSTRAINT "enterprise_package_dispatch_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_dispatches" ADD CONSTRAINT "enterprise_package_dispatch_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_package_dispatches" ADD CONSTRAINT "enterprise_package_dispatch_install_fk" FOREIGN KEY ("tenant_id","workspace_id","install_id") REFERENCES "public"."enterprise_package_installs"("tenant_id","workspace_id","id") ON DELETE cascade ON UPDATE no action;',
        'CREATE UNIQUE INDEX "enterprise_package_dispatch_call_uq" ON "enterprise_package_dispatches" ("tenant_id","run_id","attempt_generation","tool_call_id");',
        'CREATE INDEX "enterprise_package_dispatch_install_idx" ON "enterprise_package_dispatches" ("tenant_id","workspace_id","install_id");',
      ],
    },
    {
      slug: "package_dispatch_rls",
      impact:
        "enterprise_package_dispatches 的 FORCE RLS 与最小授权：data 读/插/更新（租户臂+团队臂——派发行只在可信 Run 的数据通道事务内写入与推进）；operator 读+插+更新（装配与测试通道）；无 DELETE（派发台账只追加与推进）；directory 零授权。",
      objects: ["enterprise_package_dispatches"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_package_dispatches" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_package_dispatches" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_package_dispatches" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_package_dispatch_data_read" ON "enterprise_package_dispatches"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_package_dispatches"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_package_dispatches"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_dispatch_data_insert" ON "enterprise_package_dispatches"\n  FOR INSERT TO ob_ent_data\n  WITH CHECK ("enterprise_package_dispatches"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_package_dispatches"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_dispatch_data_update" ON "enterprise_package_dispatches"\n  FOR UPDATE TO ob_ent_data\n  USING ("enterprise_package_dispatches"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_package_dispatches"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'))\n  WITH CHECK ("enterprise_package_dispatches"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_package_dispatches"."workspace_id" = nullif(current_setting(\'app.workspace_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_dispatch_operator_read" ON "enterprise_package_dispatches"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_package_dispatches"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_dispatch_operator_insert" ON "enterprise_package_dispatches"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_package_dispatches"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_package_dispatch_operator_update" ON "enterprise_package_dispatches"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_package_dispatches"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_package_dispatches"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT, INSERT, UPDATE ON TABLE "enterprise_package_dispatches" TO ob_ent_data;',
        'GRANT SELECT, INSERT, UPDATE ON TABLE "enterprise_package_dispatches" TO ob_ent_operator;',
      ],
    },
    {
      slug: "package_grant_tool_columns",
      impact:
        "为 enterprise_package_grants 追加 connector 工具授权三列：schema_digest（64 位十六进制，取自钉扎修订清单的已审定工具契约摘要）、effect（read/write）、connector_install_id（复合外键钉 MT031 连接器安装）。新增 CHECK 要求三列只在 connectorTool 行同时出现（skill 行全 NULL）。存量行全部是 skill 行：新列 NULL，CHECK 对存量等价。不改既有列/主键/唯一索引。",
      objects: ["enterprise_package_grants", "enterprise_plugin_installs"],
      statements: [
        'ALTER TABLE "enterprise_package_grants" ADD COLUMN "schema_digest" text;',
        'ALTER TABLE "enterprise_package_grants" ADD COLUMN "effect" text;',
        'ALTER TABLE "enterprise_package_grants" ADD COLUMN "connector_install_id" text;',
        'ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_tool_contract" CHECK (("enterprise_package_grants"."resource_kind" = \'skill\' and "enterprise_package_grants"."schema_digest" is null and "enterprise_package_grants"."effect" is null and "enterprise_package_grants"."connector_install_id" is null) or ("enterprise_package_grants"."resource_kind" = \'connectorTool\' and "enterprise_package_grants"."schema_digest" ~ \'^[0-9a-f]{64}$\' and "enterprise_package_grants"."effect" in (\'read\',\'write\') and "enterprise_package_grants"."connector_install_id" is not null));',
        'ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_connector_fk" FOREIGN KEY ("tenant_id","workspace_id","connector_install_id") REFERENCES "public"."enterprise_plugin_installs"("tenant_id","workspace_id","id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "run_package_pin_tool_bindings",
      impact:
        "为 enterprise_run_package_pins 追加 allowed_tool_bindings（jsonb 数组 ≤256：准入时已授权的受管连接器工具绑定 {resourceId, toolRef, schemaDigest, effect, connectorInstallId}）与 install_generation（准入时的安装 generation，派发时重验）。存量行取默认 '[]'::jsonb / 1：旧钉扎不含工具，工具派发一律拒绝（fail-closed，不吸收新工具）。不改既有列/策略。",
      objects: ["enterprise_run_package_pins"],
      statements: [
        'ALTER TABLE "enterprise_run_package_pins" ADD COLUMN "allowed_tool_bindings" jsonb DEFAULT \'[]\'::jsonb NOT NULL;',
        'ALTER TABLE "enterprise_run_package_pins" ADD COLUMN "install_generation" integer DEFAULT 1 NOT NULL;',
        'ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_tool_bindings_shape" CHECK (jsonb_typeof("enterprise_run_package_pins"."allowed_tool_bindings") = \'array\' and jsonb_array_length("enterprise_run_package_pins"."allowed_tool_bindings") <= 256);',
        'ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_install_generation" CHECK ("enterprise_run_package_pins"."install_generation" > 0);',
      ],
    },
    {
      slug: "plugin_connection_generation",
      impact:
        "为 enterprise_plugin_connections 追加 generation（正数 CHECK，默认 1）：派发行记录解析时的连接代次并在派发 CAS 重验；审批期间换代（重绑/换绑）的旧提案在重验处被拒（A07）。解绑=删行不变。存量行取默认 1（既有绑定未换代）。不改既有列/策略。",
      objects: ["enterprise_plugin_connections"],
      statements: [
        'ALTER TABLE "enterprise_plugin_connections" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;',
        'ALTER TABLE "enterprise_plugin_connections" ADD CONSTRAINT "enterprise_plugin_connection_generation" CHECK ("enterprise_plugin_connections"."generation" > 0);',
      ],
    },
  ],
};

/**
 * PKG07（Issue #466）：停用/卸载/重装。expand-only——只把
 * enterprise_package_changes 的动作 CHECK 从
 * ('install','upgrade','rollback','grant','revoke','createExpert') 扩到含
 * 'disable'/'enable'/'uninstall'（生命周期回执与领域变更同事务追加；幂等复用
 * 既有 (tenant, workspace, actor, key) 唯一）。不新增表、不新增列、不改任何
 * 既有策略/授权；约束只放宽不收紧，既有行不受影响。
 */
const PACKAGE_LIFECYCLE_TASK: TaskMigrationSpec = {
  id: "PKG07",
  description:
    "PKG07（Issue #466）：插件包停用/卸载/重装——changes 动作 CHECK 扩到 disable/enable/uninstall（expand-only：无新表、无新列、无策略变更）。",
  steps: [
    {
      slug: "package_changes_lifecycle_actions",
      impact:
        "把 enterprise_package_changes 的动作 CHECK 从 ('install','upgrade','rollback','grant','revoke','createExpert') 扩到含 'disable'/'enable'/'uninstall'：停用、重新启用（含从卸载 tombstone 重装）各写一条与安装状态变更同事务的回执；安装行本身是 tombstone，不删行，revision/pin/审计与调用证据保留。约束只放宽不收紧。",
      objects: ["enterprise_package_changes"],
      statements: [
        // IF EXISTS: this step only WIDENS a constraint an earlier task owns.
        // The test-side drift reconciler (support/task-drift.ts) sees the
        // un-journaled `ADD CONSTRAINT` below and may already have dropped the
        // constraint as 0163 drift, so the drop must tolerate its absence; the
        // ADD then rebuilds exactly the widened definition in both cases.
        'ALTER TABLE "enterprise_package_changes" DROP CONSTRAINT IF EXISTS "enterprise_package_change_action";',
        "ALTER TABLE \"enterprise_package_changes\" ADD CONSTRAINT \"enterprise_package_change_action\" CHECK (\"enterprise_package_changes\".\"action\" in ('install','upgrade','rollback','grant','revoke','createExpert','disable','enable','uninstall'));",
      ],
    },
  ],
};

/**
 * PKG11（T13-fix-2，Codex FC-02）：派发者进程租约。expand-only——为
 * enterprise_package_dispatches 追加派发者租约两列与形状 CHECK：
 * owner_incarnation（执行 dispatched CAS 的服务实例身份，进程启动时生成的
 * uuid，随 CAS 同事务落库）与 owner_lease_expires_at（租约承诺窗口，崩溃
 * 恢复的证据事实）。两列可空：prepared 行无租约；存量 dispatched 行 owner
 * 为 NULL 或异于当前 incarnation 即视为派发者已死（单写者边界，与 §10
 * release 锁单机语义一致），恢复路径转 unknown/DISPATCH_CRASH，绝不自动
 * 重发。不改既有列/约束/策略/授权。
 */
const PACKAGE_DISPATCH_LEASE_TASK: TaskMigrationSpec = {
  id: "PKG11",
  description:
    "PKG11（T13-fix-2）：插件包派发者进程租约——dispatches 追加 owner_incarnation/owner_lease_expires_at 两列与形状 CHECK（expand-only，恢复路径的证据事实）。",
  steps: [
    {
      slug: "package_dispatch_owner_lease",
      impact:
        "为 enterprise_package_dispatches 追加派发者租约两列：owner_incarnation（执行 dispatched CAS 的进程身份，uuid）与 owner_lease_expires_at（租约承诺窗口）。两列同空同非空（prepared 行与存量行均为 NULL，由恢复路径按孤儿收编转 unknown/DISPATCH_CRASH，绝不自动重发）；incarnation 有长度上限。expand-only，不改既有列/约束/策略。",
      objects: ["enterprise_package_dispatches"],
      statements: [
        'ALTER TABLE "enterprise_package_dispatches" ADD COLUMN "owner_incarnation" text;',
        'ALTER TABLE "enterprise_package_dispatches" ADD COLUMN "owner_lease_expires_at" timestamp with time zone;',
        'ALTER TABLE "enterprise_package_dispatches" ADD CONSTRAINT "enterprise_package_dispatch_owner_lease_shape" CHECK (("owner_incarnation" is null) = ("owner_lease_expires_at" is null) and ("owner_incarnation" is null or char_length("owner_incarnation") between 1 and 64));',
      ],
    },
  ],
};

/**
 * MT042（Issue #85）：平台扫描作用域重建。expand-only——为 MT041 的
 * job_ownership 表追加一条 ob_ent_operator SELECT 策略臂：仅当事务本地上下文
 * app.scan_sweep='on' 时允许跨租户读（平台扫描专用；普通业务事务不设该上
 * 下文，租户臂语义不变，MT041 既有行为零变化）。不改任何既有表/策略/授权；
 * 不新增表、不新增登录角色（七变量 env 约束）。关闭 MT041 D6（「平台扫描
 * 可发现所有公司到期任务」的受控平台读）：跨公司元数据读仅存在于本策略臂
 * 后面，且只被 scan-executor 的机器身份断言后的重建事务设置。
 */
const SCAN_SCOPE_REBUILD_TASK: TaskMigrationSpec = {
  id: "MT042",
  description:
    "MT042（Issue #85）：平台扫描作用域重建——job_ownership 补 operator 扫描臂读策略（app.scan_sweep 上下文门控，expand-only，零既有对象改动）。",
  steps: [
    {
      slug: "job_scan_sweep_policy",
      impact:
        "为 job_ownership 新增一条 ob_ent_operator SELECT 策略臂：仅当事务本地上下文 app.scan_sweep='on' 时允许跨租户读（平台扫描专用）。不改任何既有策略/授权/表；无新表。",
      objects: ["job_ownership"],
      statements: [
        'CREATE POLICY "job_ownership_operator_sweep_read" ON "job_ownership" AS PERMISSIVE FOR SELECT TO ob_ent_operator\n' +
          "  USING (current_setting('app.scan_sweep', true) = 'on');",
      ],
    },
  ],
};

/** MT059 第二步的 RLS 语句（独立常量，保持任务声明可读）。 */
const PERSONAL_BOT_RLS_STATEMENTS = [
  'REVOKE ALL PRIVILEGES ON TABLE "enterprise_personal_bots" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "enterprise_personal_bots" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "enterprise_personal_bots" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "enterprise_personal_bot_data_tenant_read" ON "enterprise_personal_bots"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_personal_bots\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "enterprise_personal_bot_data_self_read" ON "enterprise_personal_bots"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_personal_bots\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_personal_bot_operator_read" ON "enterprise_personal_bots"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"enterprise_personal_bots\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_personal_bots\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_personal_bot_operator_insert" ON "enterprise_personal_bots"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"enterprise_personal_bots\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_personal_bots\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_personal_bot_operator_update" ON "enterprise_personal_bots"\n' +
    "  FOR UPDATE TO ob_ent_operator\n" +
    "  USING (\"enterprise_personal_bots\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_personal_bots\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''))\n" +
    "  WITH CHECK (\"enterprise_personal_bots\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_personal_bots\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_personal_bot_operator_delete" ON "enterprise_personal_bots"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"enterprise_personal_bots\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_personal_bots\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'GRANT SELECT ON TABLE "enterprise_personal_bots" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "enterprise_personal_bots" TO ob_ent_operator;',
  'GRANT UPDATE ("display_name", "template_ref", "template_source_revision", "document", "revision", "updated_at") ON TABLE "enterprise_personal_bots" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "enterprise_personal_bots" TO ob_ent_operator;',
  'REVOKE ALL PRIVILEGES ON TABLE "enterprise_personal_bot_field_ownership" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "enterprise_personal_bot_field_ownership" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "enterprise_personal_bot_field_ownership" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "enterprise_personal_bot_field_data_tenant_read" ON "enterprise_personal_bot_field_ownership"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_personal_bot_field_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "enterprise_personal_bot_field_data_self_read" ON "enterprise_personal_bot_field_ownership"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_personal_bot_field_ownership\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_personal_bot_field_operator_read" ON "enterprise_personal_bot_field_ownership"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"enterprise_personal_bot_field_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_personal_bot_field_ownership\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_personal_bot_field_operator_insert" ON "enterprise_personal_bot_field_ownership"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"enterprise_personal_bot_field_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_personal_bot_field_ownership\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_personal_bot_field_operator_update" ON "enterprise_personal_bot_field_ownership"\n' +
    "  FOR UPDATE TO ob_ent_operator\n" +
    "  USING (\"enterprise_personal_bot_field_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_personal_bot_field_ownership\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''))\n" +
    "  WITH CHECK (\"enterprise_personal_bot_field_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_personal_bot_field_ownership\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_personal_bot_field_operator_delete" ON "enterprise_personal_bot_field_ownership"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"enterprise_personal_bot_field_ownership\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_personal_bot_field_ownership\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'GRANT SELECT ON TABLE "enterprise_personal_bot_field_ownership" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "enterprise_personal_bot_field_ownership" TO ob_ent_operator;',
  'GRANT UPDATE ("managed_by", "updated_at") ON TABLE "enterprise_personal_bot_field_ownership" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "enterprise_personal_bot_field_ownership" TO ob_ent_operator;',
];

/**
 * MT059（Issue #102）：用户私有 OpenMuse Bot 的存储面。expand-only——两张
 * 新表与按既有模式的最小 RLS；不修改任何既有表/策略/角色授权。
 *
 *   1. enterprise_personal_bots：一行 = 一位用户在一个公司一个团队内的私
 *      有 Bot。复合主键 (tenant_id, workspace_id, principal_id) 就是幂等键
 *      本身——票面「幂等键 = (公司, 团队, 用户) 三元组」是数据库结构而非服
 *      务层约定：同一三元组物理上至多一行，重复请求在服务层读回同一行，绝
 *      不产生重复记录。agent_id 服务端生成（专属 pbot- 命名空间 + 全局唯
 *      一索引），不接受客户端指定。document 为扁平字段文档；template_ref
 *      + template_source_revision 同空同非空（CHECK 配对）。复合外键钉到
 *      enterprise_workspaces 与 enterprise_memberships，均 cascade。
 *   2. enterprise_personal_bot_field_ownership：字段级所有权表——一行 = 一
 *      个字段名在一个私有 Bot 上的所有权（managed_by ∈ {'template','user'}
 *      CHECK）。模板管理字段集合与用户字段集合都是显式行，不是命名约定。
 *      复合外键钉到私有 Bot 行与公司成员关系，均 cascade。
 *
 * RLS 沿既有模式：REVOKE PUBLIC + 四能力角色 → ENABLE + FORCE → data 角色
 * 租户范围 SELECT + restrictive 主体自读（私有 Bot 是逐主体事实，与
 * enterprise_bot_preferences 的 self-read 同款）→ operator 角色租户 + 主
 * 体上下文范围读/写。目录角色无任何策略与授权。
 */
const PERSONAL_BOT_TASK: TaskMigrationSpec = {
  id: "MT059",
  description:
    "MT059（Issue #102）：用户私有 OpenMuse Bot——新增 enterprise_personal_bots 与 enterprise_personal_bot_field_ownership（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "personal_bot_tables",
      impact:
        "新增两张表：enterprise_personal_bots（一行 = 一位用户在一个公司一个团队内的私有 Bot；复合主键 (tenant_id, workspace_id, principal_id) 即幂等三元组；agent_id 全局唯一索引；template_ref + template_source_revision 配对可空；document 扁平字段文档；复合 FK → enterprise_workspaces 与 enterprise_memberships 均 cascade）与 enterprise_personal_bot_field_ownership（字段级所有权表：managed_by ∈ {'template','user'} CHECK；复合主键含字段名；复合 FK 钉到私有 Bot 行与公司成员关系，均 cascade）。不修改任何既有表。",
      objects: [
        "enterprise_personal_bots",
        "enterprise_personal_bot_field_ownership",
      ],
      statements: [
        'CREATE TABLE "enterprise_personal_bots" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"agent_id" text NOT NULL,\n' +
          '\t"display_name" text NOT NULL,\n' +
          '\t"template_ref" text,\n' +
          '\t"template_source_revision" integer,\n' +
          '\t"document" jsonb NOT NULL,\n' +
          '\t"revision" integer DEFAULT 1 NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_personal_bots_tenant_id_workspace_id_principal_id_pk" PRIMARY KEY("tenant_id","workspace_id","principal_id"),\n' +
          '\tCONSTRAINT "enterprise_personal_bots_revision" CHECK ("enterprise_personal_bots"."revision" > 0),\n' +
          '\tCONSTRAINT "enterprise_personal_bots_template_pairing" CHECK (("enterprise_personal_bots"."template_ref" IS NULL) = ("enterprise_personal_bots"."template_source_revision" IS NULL)),\n' +
          '\tCONSTRAINT "enterprise_personal_bots_template_source_revision" CHECK ("enterprise_personal_bots"."template_source_revision" IS NULL OR "enterprise_personal_bots"."template_source_revision" > 0)\n' +
          ");",
        'CREATE UNIQUE INDEX "enterprise_personal_bots_agent_id_global_uq" ON "enterprise_personal_bots" USING btree ("agent_id");',
        'ALTER TABLE "enterprise_personal_bots" ADD CONSTRAINT "enterprise_personal_bots_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_personal_bots" ADD CONSTRAINT "enterprise_personal_bots_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE TABLE "enterprise_personal_bot_field_ownership" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"field_name" text NOT NULL,\n' +
          '\t"managed_by" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_personal_bot_field_ownership_tenant_id_workspace_id_principal_id_field_name_pk" PRIMARY KEY("tenant_id","workspace_id","principal_id","field_name")\n' +
          ");",
        'ALTER TABLE "enterprise_personal_bot_field_ownership" ADD CONSTRAINT "enterprise_personal_bot_field_ownership_personal_bot_fk" FOREIGN KEY ("tenant_id","workspace_id","principal_id") REFERENCES "public"."enterprise_personal_bots"("tenant_id","workspace_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_personal_bot_field_ownership" ADD CONSTRAINT "enterprise_personal_bot_field_ownership_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_personal_bot_field_ownership" ADD CONSTRAINT "enterprise_personal_bot_field_ownership_managed_by" CHECK ("enterprise_personal_bot_field_ownership"."managed_by" in (\'template\',\'user\'));',
      ],
    },
    {
      slug: "personal_bot_rls",
      impact:
        "仅对两张新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 角色租户范围 SELECT + restrictive 主体自读；operator 角色租户 + 主体上下文范围读 + 写）及配套最小 GRANT；不改动任何既有表策略或既有授权。目录角色无任何策略与授权（私有 Bot 内容不是目录数据）。",
      objects: [
        "enterprise_personal_bots",
        "enterprise_personal_bot_field_ownership",
      ],
      statements: PERSONAL_BOT_RLS_STATEMENTS,
    },
  ],
};

/**
 * MT029（Issue #72）：凭据取用 lease——固定用途、作用域且可撤销。expand-only
 * ——仅新增两张表，不修改任何既有表/策略/角色授权：
 *
 *   - enterprise_credential_leases：一行 = 一条固定 (凭据, 持有人, 团队上下文,
 *     用途, 有效期) 的可撤销取用授权。id = 服务端生成的不透明 lease 令牌；
 *     三条复合外键全部内嵌 tenant_id（跨公司 lease 行结构性不可能）；
 *     purpose 闭集 CHECK；status 两态 + revoked_at 行形 CHECK；窗口 CHECK
 *     （expires_at > created_at）。data 角色只在 (tenant, principal) 双
 *     pin 下 SELECT/INSERT（持有人只见本人 lease，判定服务经受限 data
 *     通道签发）；operator 角色租户范围 SELECT+UPDATE（撤销走 MT027
 *     revoke 同款管理通道）；data 零 UPDATE/DELETE；directory 零授权。
 *   - enterprise_credential_lease_audit：签发/校验点取用/撤销各恰一行
 *     append-only 审计（issued/validated/revoked 闭集 CHECK）；
 *     lease_id/credential_id 无外键（MT069 先例：审计不随对象消亡）；
 *     detail 闭形 CHECK 禁止秘密载体键。data 只插不读（MT027 审计先例：
 *     成员不能互相侦察）；operator 读+插；任何角色无 UPDATE/DELETE。
 *
 * 判定/管理服务在 server/src/enterprise/tenancy/credential-lease.ts。
 */
const CREDENTIAL_LEASE_TASK: TaskMigrationSpec = {
  id: "MT029",
  description:
    "MT029（Issue #72）：新增 enterprise_credential_leases 与 enterprise_credential_lease_audit（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "credential_lease_tables",
      impact:
        "新增两张凭据 lease 表：enterprise_credential_leases（不透明 lease 令牌主键 + 三条复合外键内嵌 tenant_id——凭据/持有人/团队必属本公司，均 cascade + purpose/status/窗口/行形 CHECK）与 enterprise_credential_lease_audit（append-only 审计，无 lease/凭据外键，action 闭集与 detail 闭形 CHECK）。不修改任何既有表。",
      objects: [
        "enterprise_credential_leases",
        "enterprise_credential_lease_audit",
      ],
      statements: [
        'CREATE TABLE "enterprise_credential_leases" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"credential_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"purpose" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'active' NOT NULL,\n" +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"expires_at" timestamp with time zone NOT NULL,\n' +
          '\t"revoked_at" timestamp with time zone,\n' +
          '\tCONSTRAINT "enterprise_credential_leases_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          "\tCONSTRAINT \"enterprise_credential_lease_purpose\" CHECK (\"enterprise_credential_leases\".\"purpose\" in ('bot-run','connector-call','site-access')),\n" +
          '\tCONSTRAINT "enterprise_credential_lease_status" CHECK ("enterprise_credential_leases"."status" in (\'active\',\'revoked\')),\n' +
          '\tCONSTRAINT "enterprise_credential_lease_window" CHECK ("enterprise_credential_leases"."expires_at" > "enterprise_credential_leases"."created_at"),\n' +
          '\tCONSTRAINT "enterprise_credential_lease_row_shape" CHECK (("enterprise_credential_leases"."status" = \'revoked\') = ("enterprise_credential_leases"."revoked_at" is not null))\n' +
          ");",
        'ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_credential_id_enterprise_credentials_tenant_id_id_fk" FOREIGN KEY ("tenant_id","credential_id") REFERENCES "public"."enterprise_credentials"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_credential_lease_tenant_created_idx" ON "enterprise_credential_leases" ("tenant_id","created_at","id");',
        'CREATE INDEX "enterprise_credential_lease_credential_idx" ON "enterprise_credential_leases" ("tenant_id","credential_id");',
        'CREATE TABLE "enterprise_credential_lease_audit" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"lease_id" text NOT NULL,\n' +
          '\t"credential_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"action" text NOT NULL,\n' +
          '\t"detail" jsonb NOT NULL,\n' +
          '\t"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_credential_lease_audit_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          "\tCONSTRAINT \"enterprise_credential_lease_audit_action\" CHECK (\"enterprise_credential_lease_audit\".\"action\" in ('issued','validated','revoked')),\n" +
          "\tCONSTRAINT \"enterprise_credential_lease_audit_detail_shape\" CHECK (not \"enterprise_credential_lease_audit\".\"detail\" ?| array['envelope','plaintext','secret','value','password','token'])\n" +
          ");",
        'ALTER TABLE "enterprise_credential_lease_audit" ADD CONSTRAINT "enterprise_credential_lease_audit_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_credential_lease_audit_tenant_time_idx" ON "enterprise_credential_lease_audit" ("tenant_id","occurred_at");',
      ],
    },
    {
      slug: "credential_lease_rls_policies",
      impact:
        "两张新表的 FORCE RLS 与最小授权：lease 行 data 角色只在 (tenant, principal) 双 pin 下 SELECT/INSERT、operator 角色租户范围 SELECT+UPDATE（撤销），data 零 UPDATE/DELETE；audit 表 data 只插不读、operator 读+插；任何角色无 UPDATE/DELETE；directory 角色两表零授权。不改动任何既有表策略或既有授权。",
      objects: [
        "enterprise_credential_leases",
        "enterprise_credential_lease_audit",
      ],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_credential_leases" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_credential_leases" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_credential_leases" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_credential_lease_data_read" ON "enterprise_credential_leases"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_credential_leases"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_credential_leases"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_lease_data_insert" ON "enterprise_credential_leases"\n  FOR INSERT TO ob_ent_data\n  WITH CHECK ("enterprise_credential_leases"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_credential_leases"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_lease_operator_read" ON "enterprise_credential_leases"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_credential_leases"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_lease_operator_update" ON "enterprise_credential_leases"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_credential_leases"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_credential_leases"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT, INSERT ON TABLE "enterprise_credential_leases" TO ob_ent_data;',
        'GRANT SELECT, UPDATE ON TABLE "enterprise_credential_leases" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_credential_lease_audit" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_credential_lease_audit" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_credential_lease_audit" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_credential_lease_audit_data_insert" ON "enterprise_credential_lease_audit"\n  FOR INSERT TO ob_ent_data\n  WITH CHECK ("enterprise_credential_lease_audit"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_lease_audit_operator_read" ON "enterprise_credential_lease_audit"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_credential_lease_audit"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_credential_lease_audit_operator_insert" ON "enterprise_credential_lease_audit"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_credential_lease_audit"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT INSERT ON TABLE "enterprise_credential_lease_audit" TO ob_ent_data;',
        'GRANT SELECT, INSERT ON TABLE "enterprise_credential_lease_audit" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT073（Issue #116）：账务可见性——公司财务读取授权（expand-only）。仅新增
 * billing_company_finance_grants（授权事实表）：PK(tenant_id, principal_id)，
 * grantee 与 granted_by 两侧都是复合外键→enterprise_memberships（非成员行
 * 结构上不可能，MT010 granted_by 同款纪律）；撤销=删行（无可达中间态）。
 * 跟随 MT069/MT070 D2 裁决的 billing 域访问模型（owner 通道、无 RLS、受限
 * ob_ent_* 零授权=结构隔离）。不修改任何既有表/策略/角色授权。
 */
const COMPANY_FINANCE_GRANT_TASK: TaskMigrationSpec = {
  id: "MT073",
  description:
    "MT073（Issue #116）：公司财务读取授权——新增 billing_company_finance_grants（expand-only，仅新增一张账务域授权事实表，不改既有对象）。",
  steps: [
    {
      slug: "company_finance_grants",
      impact:
        "新增 billing_company_finance_grants 表：公司财务读取授权事实（tenant+principal 主键，granted_by 记录管理动作）。两条复合外键证明 grantee 与 granted_by 都是该公司成员；撤销=删行。不修改任何既有表。",
      objects: ["billing_company_finance_grants"],
      statements: [
        'CREATE TABLE "billing_company_finance_grants" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"granted_by" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "billing_company_finance_grants_tenant_id_principal_id_pk" PRIMARY KEY("tenant_id","principal_id"),\n' +
          '\tCONSTRAINT "billing_company_finance_grants_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "billing_company_finance_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "billing_company_finance_grants_tenant_id_granted_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action\n' +
          ");",
        'CREATE INDEX "billing_company_finance_grants_tenant_idx" ON "billing_company_finance_grants" ("tenant_id");',
      ],
    },
  ],
};

/**
 * MT060（Issue #103）：OpenMuse 任务/计划/监控根记录的归属域。expand-only——
 * 一张新协会表与按既有模式的最小 RLS + 幂等回填语句；不修改任何既有表/策略/
 * 角色授权。
 *
 *   1. openmuse_task_scopes：一行 = 一个只有 owner_user_id 的旧根记录在一个
 *      (公司, 团队, 主体) 三元组上的归属关联（Spec §4.2「根对象的子记录包
 *      含 tenant_id 并通过复合关联保持公司一致」逐字形状）。task_id 主键
 *      FK → openmuse_tasks(id) cascade；复合外键钉到 enterprise_workspaces
 *      与 enterprise_memberships（同时证明 workspace 属该公司、principal 是
 *      该公司成员）与 users，均 cascade；attribution ∈ {'created','backfill'}
 *      CHECK 区分新路径 pin 与回填来源。
 *   2. RLS 沿 MT059 既有模式 + MT042 扫描臂：REVOKE PUBLIC + 四能力角色 →
 *      ENABLE + FORCE → data 租户臂 + restrictive 主体自读 → operator 租户
 *      +主体上下文读/插/删 → operator app.scan_sweep='on' 跨租户读臂（平
 *      台触发重建专用）。目录角色无任何策略与授权。零 UPDATE 授权——归属
 *      不可改写是结构不是纪律。
 *   3. legacy_task_backfill：幂等回填——只为 owner principal 恰有唯一一条
 *      workspace membership 的旧根行补归属（attribution='backfill'）；零条
 *      或多条保持无行 = 受控隔离（Spec §9.2「无法唯一归属的历史对象进入
 *      受控隔离清单，不按猜测分配」）。执行权在 MT117；本语句是可重放的
 *      幂等本体（NOT EXISTS + ON CONFLICT DO NOTHING），服务面
 *      previewLegacyBackfill 与其逐行可对照（dry-run 预览）。
 */
const OPENMUSE_TASK_SCOPES_RLS_STATEMENTS = [
  'REVOKE ALL PRIVILEGES ON TABLE "openmuse_task_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "openmuse_task_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "openmuse_task_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "openmuse_task_scope_data_tenant_read" ON "openmuse_task_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_task_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "openmuse_task_scope_data_self_read" ON "openmuse_task_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_task_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_task_scope_operator_read" ON "openmuse_task_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"openmuse_task_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_task_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_task_scope_operator_insert" ON "openmuse_task_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"openmuse_task_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_task_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_task_scope_operator_delete" ON "openmuse_task_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"openmuse_task_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_task_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_task_scope_operator_sweep_read" ON "openmuse_task_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (current_setting('app.scan_sweep', true) = 'on');",
  'GRANT SELECT ON TABLE "openmuse_task_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "openmuse_task_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "openmuse_task_scopes" TO ob_ent_operator;',
];

const OPENMUSE_TASK_TENANCY_TASK: TaskMigrationSpec = {
  id: "MT060",
  description:
    "MT060（Issue #103）：OpenMuse 任务/计划/监控归属域——新增 openmuse_task_scopes 协会表（表 + RLS + 幂等回填三步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "task_scope_tables",
      impact:
        "新增 openmuse_task_scopes 表：task_id 主键（FK → openmuse_tasks cascade）；复合外键钉到 enterprise_workspaces、enterprise_memberships 与 users（均 cascade）；attribution ∈ {'created','backfill'} CHECK；范围列表索引。不修改任何既有表。",
      objects: ["openmuse_task_scopes"],
      statements: [
        'CREATE TABLE "openmuse_task_scopes" (\n' +
          '\t"task_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"bot_id" text NOT NULL,\n' +
          "\t\"attribution\" text DEFAULT 'created' NOT NULL,\n" +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "openmuse_task_scopes_attribution" CHECK ("openmuse_task_scopes"."attribution" in (\'created\',\'backfill\'))\n' +
          ");",
        'CREATE INDEX "openmuse_task_scopes_scope_list_idx" ON "openmuse_task_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","task_id");',
        'ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_task_fk" FOREIGN KEY ("task_id") REFERENCES "public"."openmuse_tasks"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "task_scope_rls",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 主体自读；operator 租户+主体上下文读/插/删 + app.scan_sweep 扫描臂）及配套最小 GRANT；零 UPDATE 授权。不改动任何既有表策略或既有授权。目录角色无任何策略与授权。",
      objects: ["openmuse_task_scopes"],
      statements: OPENMUSE_TASK_SCOPES_RLS_STATEMENTS,
    },
    {
      slug: "legacy_task_backfill",
      impact:
        "幂等回填：仅为 owner principal 恰有唯一一条 workspace membership 的旧根行补归属（attribution='backfill'）；零条或多条保持无行 = 受控隔离清单（不按猜测分配）；NOT EXISTS + ON CONFLICT DO NOTHING 保证可重放零重复。执行权在 MT117（生产），本语句是幂等本体。",
      objects: [
        "openmuse_task_scopes",
        "openmuse_tasks",
        "enterprise_principals",
        "enterprise_workspace_memberships",
      ],
      statements: [
        'INSERT INTO "openmuse_task_scopes" ("task_id", "tenant_id", "workspace_id", "principal_id", "user_id", "bot_id", "attribution")\n' +
          'SELECT t."id", unique_membership."tenant_id", unique_membership."workspace_id", p."id", p."user_id", t."bot_id", \'backfill\'\n' +
          'FROM "openmuse_tasks" t\n' +
          'JOIN "enterprise_principals" p ON p."user_id" = t."owner_user_id"\n' +
          "JOIN (\n" +
          '\tSELECT wm."principal_id",\n' +
          '\t\tmin(wm."tenant_id") AS "tenant_id",\n' +
          '\t\tmin(wm."workspace_id") AS "workspace_id",\n' +
          '\t\tcount(*) AS "membership_count"\n' +
          '\tFROM "enterprise_workspace_memberships" wm\n' +
          '\tGROUP BY wm."principal_id"\n' +
          "\tHAVING count(*) = 1\n" +
          ') unique_membership ON unique_membership."principal_id" = p."id"\n' +
          "WHERE NOT EXISTS (\n" +
          '\tSELECT 1 FROM "openmuse_task_scopes" s WHERE s."task_id" = t."id"\n' +
          ")\n" +
          'ON CONFLICT ("task_id") DO NOTHING;',
      ],
    },
  ],
};

const VENDOR_BILLING_INTERACTIONS_STATEMENTS: readonly string[] = [
  'CREATE TABLE "billing_vendor_interactions" (\n' +
    '\t"id" text PRIMARY KEY NOT NULL,\n' +
    '\t"direction" text NOT NULL,\n' +
    '\t"tenant_id" text,\n' +
    '\t"principal_id" text,\n' +
    '\t"external_customer_id" text,\n' +
    '\t"operation" text NOT NULL,\n' +
    '\t"outcome" text NOT NULL,\n' +
    '\t"denial_code" text,\n' +
    '\t"detail" jsonb,\n' +
    '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
    '\tCONSTRAINT "billing_vendor_interactions_direction" CHECK ("billing_vendor_interactions"."direction" in (\'call\',\'callback\')),\n' +
    '\tCONSTRAINT "billing_vendor_interactions_outcome" CHECK ("billing_vendor_interactions"."outcome" in (\'applied\',\'refused\')),\n' +
    '\tCONSTRAINT "billing_vendor_interactions_denial_pair" CHECK (("billing_vendor_interactions"."outcome" = \'applied\' AND "billing_vendor_interactions"."denial_code" IS NULL) OR ("billing_vendor_interactions"."outcome" = \'refused\' AND "billing_vendor_interactions"."denial_code" IS NOT NULL AND "billing_vendor_interactions"."denial_code" <> \'\')),\n' +
    "\tCONSTRAINT \"billing_vendor_interactions_detail_shape\" CHECK (\"billing_vendor_interactions\".\"detail\" IS NULL OR (jsonb_typeof(\"billing_vendor_interactions\".\"detail\") = 'object' AND NOT \"billing_vendor_interactions\".\"detail\" ?| array['envelope','plaintext','secret','value','password','token','apiKey']))\n" +
    ");",
  'CREATE INDEX "billing_vendor_interactions_tenant_time_idx" ON "billing_vendor_interactions" ("tenant_id","created_at");',
  'CREATE INDEX "billing_vendor_interactions_customer_time_idx" ON "billing_vendor_interactions" ("external_customer_id","created_at");',
];

/**
 * MT034（Issue #77）：共享账号审批——绑定对象、参数摘要与归属。expand-only
 * ——仅新增两张表，不修改任何既有表/策略/角色授权：
 *
 *   - enterprise_shared_use_requests：一行 = 一条锁定
 *     (tenant, workspace, bot, install) 的审批申请。五条复合外键全部内嵌
 *     tenant_id（跨公司申请行结构性不可能）；提议参数摘要为服务端规范
 *     序列化 sha256（64 位十六进制 CHECK）；受众/理由/状态闭集 CHECK；
 *     行形 CHECK 强制决定动作配对。data 角色读全部 + 插自己 + 只能撤回
 *     本人 pending 行；operator 角色租户范围读 + 改；data 零 DELETE；
 *     directory 零授权。
 *   - enterprise_shared_use_approvals：批准行是只追加的不可变授予——
 *     锁定同一四元组 + 摘要 + 批准人 + 溯源申请行（request_id 复合外
 *     键）。零 UPDATE/DELETE 授权（改参数 = 重新审批，换团队 = 不复用）；
 *     data 只读；operator 读 + 插；directory 零授权。
 *
 * 判定/管理服务在 server/src/enterprise/tenancy/shared-approvals.ts。
 */
const SHARED_APPROVAL_TASK: TaskMigrationSpec = {
  id: "MT034",
  description:
    "MT034（Issue #77）：新增 enterprise_shared_use_requests 与 enterprise_shared_use_approvals（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "shared_approval_tables",
      impact:
        "新增两张共享账号审批表：enterprise_shared_use_requests（锁定 (tenant, workspace, bot, install) 的申请行，五条复合外键内嵌 tenant_id、摘要/受众/理由/状态闭集 CHECK、行形 CHECK、对象索引）与 enterprise_shared_use_approvals（不可变批准行，同一四元组 + 摘要 + 批准人 + 溯源申请复合外键）。不修改任何既有表。",
      objects: [
        "enterprise_shared_use_requests",
        "enterprise_shared_use_approvals",
      ],
      statements: [
        'CREATE TABLE "enterprise_shared_use_requests" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"agent_id" text NOT NULL,\n' +
          '\t"install_id" text NOT NULL,\n' +
          '\t"requested_by" text NOT NULL,\n' +
          '\t"proposed_audience" text NOT NULL,\n' +
          '\t"proposed_outside_input" boolean NOT NULL,\n' +
          '\t"proposed_members" jsonb NOT NULL,\n' +
          '\t"proposed_params_digest" text NOT NULL,\n' +
          '\t"reason" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'pending' NOT NULL,\n" +
          '\t"decided_by" text,\n' +
          '\t"decided_at" timestamp with time zone,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_shared_use_requests_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          "\tCONSTRAINT \"enterprise_shared_use_request_audience\" CHECK (\"enterprise_shared_use_requests\".\"proposed_audience\" in ('owner','people','team')),\n" +
          "\tCONSTRAINT \"enterprise_shared_use_request_reason\" CHECK (\"enterprise_shared_use_requests\".\"reason\" in ('publish','trigger','grant','refused_call')),\n" +
          "\tCONSTRAINT \"enterprise_shared_use_request_status\" CHECK (\"enterprise_shared_use_requests\".\"status\" in ('pending','approved','declined','withdrawn','superseded')),\n" +
          '\tCONSTRAINT "enterprise_shared_use_request_digest_shape" CHECK ("enterprise_shared_use_requests"."proposed_params_digest" ~ \'^[0-9a-f]{64}$\'),\n' +
          '\tCONSTRAINT "enterprise_shared_use_request_members_shape" CHECK (jsonb_typeof("enterprise_shared_use_requests"."proposed_members") = \'array\'),\n' +
          '\tCONSTRAINT "enterprise_shared_use_request_decision_shape" CHECK (("enterprise_shared_use_requests"."status" in (\'approved\',\'declined\')) = ("enterprise_shared_use_requests"."decided_by" is not null and "enterprise_shared_use_requests"."decided_at" is not null))\n' +
          ");",
        'ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."enterprise_bot_ownership"("tenant_id","agent_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_install_id_enterprise_plugin_installs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","install_id") REFERENCES "public"."enterprise_plugin_installs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_requested_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_decided_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_shared_use_request_tenant_created_idx" ON "enterprise_shared_use_requests" ("tenant_id","created_at","id");',
        'CREATE INDEX "enterprise_shared_use_request_object_idx" ON "enterprise_shared_use_requests" ("tenant_id","agent_id","install_id","workspace_id");',
        'CREATE TABLE "enterprise_shared_use_approvals" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"agent_id" text NOT NULL,\n' +
          '\t"install_id" text NOT NULL,\n' +
          '\t"request_id" text NOT NULL,\n' +
          '\t"params_digest" text NOT NULL,\n' +
          '\t"audience" text NOT NULL,\n' +
          '\t"outside_input" boolean NOT NULL,\n' +
          '\t"members" jsonb NOT NULL,\n' +
          '\t"approved_by" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_shared_use_approvals_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          "\tCONSTRAINT \"enterprise_shared_use_approval_audience\" CHECK (\"enterprise_shared_use_approvals\".\"audience\" in ('owner','people','team')),\n" +
          '\tCONSTRAINT "enterprise_shared_use_approval_digest_shape" CHECK ("enterprise_shared_use_approvals"."params_digest" ~ \'^[0-9a-f]{64}$\'),\n' +
          '\tCONSTRAINT "enterprise_shared_use_approval_members_shape" CHECK (jsonb_typeof("enterprise_shared_use_approvals"."members") = \'array\')\n' +
          ");",
        'ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."enterprise_bot_ownership"("tenant_id","agent_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_install_id_enterprise_plugin_installs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","install_id") REFERENCES "public"."enterprise_plugin_installs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_request_id_enterprise_shared_use_requests_tenant_id_id_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."enterprise_shared_use_requests"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_approved_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_shared_use_approval_object_idx" ON "enterprise_shared_use_approvals" ("tenant_id","agent_id","install_id","workspace_id","params_digest");',
      ],
    },
    {
      slug: "shared_approval_rls_policies",
      impact:
        "两张新表的 FORCE RLS 与最小授权：申请行 data 角色读全部 + 插自己（tenant+requested_by pin）+ 只能撤回本人 pending 行（同一谓词 UPDATE 策略），operator 角色租户范围读 + 改；批准行 data 只读、operator 读 + 插；任何角色零 DELETE，批准行零 UPDATE；directory 角色两表零授权。不改动任何既有表策略或既有授权。",
      objects: [
        "enterprise_shared_use_requests",
        "enterprise_shared_use_approvals",
      ],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_shared_use_requests" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_shared_use_requests" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_shared_use_requests" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_shared_use_request_data_read" ON "enterprise_shared_use_requests"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_shared_use_request_data_insert" ON "enterprise_shared_use_requests"\n  FOR INSERT TO ob_ent_data\n  WITH CHECK ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_shared_use_requests"."requested_by" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_shared_use_request_data_withdraw" ON "enterprise_shared_use_requests"\n  FOR UPDATE TO ob_ent_data\n  USING ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_shared_use_requests"."requested_by" = nullif(current_setting(\'app.principal_id\', true), \'\') AND "enterprise_shared_use_requests"."status" = \'pending\')\n  WITH CHECK ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_shared_use_requests"."requested_by" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_shared_use_request_operator_read" ON "enterprise_shared_use_requests"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_shared_use_request_operator_update" ON "enterprise_shared_use_requests"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT, INSERT, UPDATE ON TABLE "enterprise_shared_use_requests" TO ob_ent_data;',
        'GRANT SELECT, UPDATE ON TABLE "enterprise_shared_use_requests" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_shared_use_approvals" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_shared_use_approvals" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_shared_use_approvals" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_shared_use_approval_data_read" ON "enterprise_shared_use_approvals"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_shared_use_approvals"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_shared_use_approval_operator_read" ON "enterprise_shared_use_approvals"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_shared_use_approvals"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_shared_use_approval_operator_insert" ON "enterprise_shared_use_approvals"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_shared_use_approvals"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_shared_use_approvals" TO ob_ent_data;',
        'GRANT SELECT, INSERT ON TABLE "enterprise_shared_use_approvals" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT074（波次 16 补位）：供应商计费调用面与回调归属锁定的审计面（expand-only）。
 * 新增一张账务域交互审计表（跟随 MT069/MT070/MT073 同款 billing 域访问模型：
 * owner 通道、无 RLS；不授任何角色授权 = 结构隔离，套件以 has_table_privilege
 * 反证钉死）：
 *   - billing_vendor_interactions：一行 = 一次供应商计费交互尝试（call/callback
 *     × applied/refused 都是事实）。无外键（MT069 审计先例：审计不随对象消亡；
 *     且「成员行已删」的拒绝必须可记录——membership 外键会让拒绝本身抛 23503）；
 *     tenant_id 可空（未映射回调不臆造归属）；direction/outcome 闭集 CHECK、
 *     outcome/denial_code 行形配对 CHECK、detail 闭形 CHECK（object 且禁秘密
 *     载体键）。
 * 不修改任何既有表；供应商事件去重/重放防线仍在既有 webhook inbox（零改动）。
 */
/**
 * MT035（Issue #78）：Host Access、签入帮助与危险动作审批的归属。expand-only
 * ——仅新增两张表与最小 RLS，不改任何既有对象（消费 MT034 审批绑定先例）：
 *
 *   - enterprise_host_access_grants：一行 = 一位成员把本机 host 访问授权给
 *     某 Bot。归属键 (tenant, workspace, principal, agent) 复合外键全内嵌
 *     tenant_id（跨公司授权行结构性不可能）；status active/revoked 闭集、
 *     revoked ⇔ revoked_at 行形 CHECK。data 租户 pin 读 + 插自己 + 撤本人
 *     active 行；operator 租户 pin 读 + 改；零 DELETE；directory 零授权。
 *   - enterprise_host_action_approvals：一行 = 一次危险动作（write_file /
 *     run_command 闭集）审批，锁定 (tenant, workspace, principal, agent,
 *     kind, params_digest)；摘要是服务端规范序列化 sha256（64hex CHECK）；
 *     status 闭集 + 决定配对行形 CHECK；审批行锁定归属，执行时在事务内
 *     重读 approved 行并逐字比对执行 scope 四元组与摘要——审批归属与执行
 *     归属一致由读取谓词保证，不存在跨范围复用通道。data 读 + 插自己 +
 *     撤回本人 pending；operator 读 + 决定（pending → 终态）。
 *
 * 判定/管理服务在 server/src/enterprise/tenancy/host-access.ts。
 */
const HOST_ACCESS_TASK: TaskMigrationSpec = {
  id: "MT035",
  description:
    "MT035（Issue #78）：新增 enterprise_host_access_grants 与 enterprise_host_action_approvals（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "host_access_tables",
      impact:
        "新增两张 Host Access 归属表：enterprise_host_access_grants（成员→Bot 的主机访问授权，归属键复合外键内嵌 tenant_id、status/revocation 行形 CHECK）与 enterprise_host_action_approvals（危险动作审批行，锁定归属四元组 + 操作闭集 + 摘要 64hex CHECK + 决定配对行形 CHECK）。不修改任何既有表。",
      objects: [
        "enterprise_host_access_grants",
        "enterprise_host_action_approvals",
      ],
      statements: [
        'CREATE TABLE "enterprise_host_access_grants" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"agent_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"display_name" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'active' NOT NULL,\n" +
          '\t"revoked_at" timestamp with time zone,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_host_access_grants_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          '\tCONSTRAINT "enterprise_host_access_grant_status" CHECK ("enterprise_host_access_grants"."status" in (\'active\',\'revoked\')),\n' +
          '\tCONSTRAINT "enterprise_host_access_grant_revocation_shape" CHECK (("enterprise_host_access_grants"."status" = \'revoked\') = ("enterprise_host_access_grants"."revoked_at" is not null))\n' +
          ");",
        'ALTER TABLE "enterprise_host_access_grants" ADD CONSTRAINT "enterprise_host_access_grants_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_host_access_grants" ADD CONSTRAINT "enterprise_host_access_grants_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_host_access_grants" ADD CONSTRAINT "enterprise_host_access_grants_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."enterprise_bot_ownership"("tenant_id","agent_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_host_access_grants" ADD CONSTRAINT "enterprise_host_access_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_host_access_grant_subject_idx" ON "enterprise_host_access_grants" ("tenant_id","principal_id","status");',
        'CREATE TABLE "enterprise_host_action_approvals" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"agent_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"grant_id" text NOT NULL,\n' +
          '\t"operation_kind" text NOT NULL,\n' +
          '\t"params_digest" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'pending' NOT NULL,\n" +
          '\t"decided_by" text,\n' +
          '\t"decided_at" timestamp with time zone,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_host_action_approvals_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          '\tCONSTRAINT "enterprise_host_action_approval_kind" CHECK ("enterprise_host_action_approvals"."operation_kind" in (\'write_file\',\'run_command\')),\n' +
          "\tCONSTRAINT \"enterprise_host_action_approval_status\" CHECK (\"enterprise_host_action_approvals\".\"status\" in ('pending','approved','declined','withdrawn')),\n" +
          '\tCONSTRAINT "enterprise_host_action_approval_digest_shape" CHECK ("enterprise_host_action_approvals"."params_digest" ~ \'^[0-9a-f]{64}$\'),\n' +
          '\tCONSTRAINT "enterprise_host_action_approval_decision_shape" CHECK (("enterprise_host_action_approvals"."status" in (\'approved\',\'declined\')) = ("enterprise_host_action_approvals"."decided_by" is not null and "enterprise_host_action_approvals"."decided_at" is not null))\n' +
          ");",
        'ALTER TABLE "enterprise_host_action_approvals" ADD CONSTRAINT "enterprise_host_action_approvals_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_host_action_approvals" ADD CONSTRAINT "enterprise_host_action_approvals_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_host_action_approvals" ADD CONSTRAINT "enterprise_host_action_approvals_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."enterprise_bot_ownership"("tenant_id","agent_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_host_action_approvals" ADD CONSTRAINT "enterprise_host_action_approvals_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_host_action_approvals" ADD CONSTRAINT "enterprise_host_action_approvals_tenant_id_grant_id_enterprise_host_access_grants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."enterprise_host_access_grants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_host_action_approval_object_idx" ON "enterprise_host_action_approvals" ("tenant_id","workspace_id","principal_id","agent_id","operation_kind","params_digest");',
      ],
    },
    {
      slug: "host_access_rls_policies",
      impact:
        "两张新表的 FORCE RLS 与最小授权：授权行 data 角色租户 pin 读 + 插自己（tenant+principal pin）+ 撤本人 active 行（同一谓词 UPDATE 策略），operator 租户 pin 读 + 改；审批行 data 读 + 插自己 + 撤回本人 pending，operator 读 + 决定（pending → 终态）；任何角色零 DELETE；directory 零授权。不改动任何既有表策略或授权。",
      objects: [
        "enterprise_host_access_grants",
        "enterprise_host_action_approvals",
      ],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_host_access_grants" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_host_access_grants" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_host_access_grants" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_host_access_grant_data_read" ON "enterprise_host_access_grants"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_host_access_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_host_access_grant_data_insert" ON "enterprise_host_access_grants"\n  FOR INSERT TO ob_ent_data\n  WITH CHECK ("enterprise_host_access_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_host_access_grants"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_host_access_grant_data_revoke" ON "enterprise_host_access_grants"\n  FOR UPDATE TO ob_ent_data\n  USING ("enterprise_host_access_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_host_access_grants"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\') AND "enterprise_host_access_grants"."status" = \'active\')\n  WITH CHECK ("enterprise_host_access_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_host_access_grants"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_host_access_grant_operator_read" ON "enterprise_host_access_grants"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_host_access_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_host_access_grant_operator_update" ON "enterprise_host_access_grants"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_host_access_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_host_access_grants"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT, INSERT, UPDATE ON TABLE "enterprise_host_access_grants" TO ob_ent_data;',
        'GRANT SELECT, UPDATE ON TABLE "enterprise_host_access_grants" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_host_action_approvals" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_host_action_approvals" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_host_action_approvals" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_host_action_approval_data_read" ON "enterprise_host_action_approvals"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_host_action_approvals"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_host_action_approval_data_insert" ON "enterprise_host_action_approvals"\n  FOR INSERT TO ob_ent_data\n  WITH CHECK ("enterprise_host_action_approvals"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_host_action_approvals"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_host_action_approval_data_withdraw" ON "enterprise_host_action_approvals"\n  FOR UPDATE TO ob_ent_data\n  USING ("enterprise_host_action_approvals"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_host_action_approvals"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\') AND "enterprise_host_action_approvals"."status" = \'pending\')\n  WITH CHECK ("enterprise_host_action_approvals"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_host_action_approvals"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_host_action_approval_operator_read" ON "enterprise_host_action_approvals"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_host_action_approvals"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_host_action_approval_operator_decide" ON "enterprise_host_action_approvals"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_host_action_approvals"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_host_action_approvals"."status" = \'pending\')\n  WITH CHECK ("enterprise_host_action_approvals"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT, INSERT, UPDATE ON TABLE "enterprise_host_action_approvals" TO ob_ent_data;',
        'GRANT SELECT, UPDATE ON TABLE "enterprise_host_action_approvals" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT039（Issue #82）：个人业务记忆与来源选择保持个人权限。expand-only——
 * 仅新增一张表与最小 RLS，不改任何既有对象（消费 MT038 文档作用域与
 * MT010 个人资源权限的既有资源/授权表，不假装跨库外键）：
 *
 *   - enterprise_personal_memories：一行 = 一条个人业务记忆，归属键
 *     (tenant, workspace, principal) 复合外键全内嵌 tenant_id（跨公司记忆
 *     行结构性不可能）；source_kind manual/kb/document 闭集 + 行形 CHECK。
 *     data 角色四动作全部 tenant+principal 双 pin（个人记忆连读都只给
 *     本人——同团队他人 RLS 层不可见）；operator 租户 pin 只读；directory
 *     零授权。
 *
 * 判定/管理服务在 server/src/enterprise/tenancy/personal-memory.ts。
 */
const PERSONAL_MEMORY_TASK: TaskMigrationSpec = {
  id: "MT039",
  description:
    "MT039（Issue #82）：新增 enterprise_personal_memories（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "personal_memory_table",
      impact:
        "新增个人业务记忆表：归属键 (tenant, workspace, principal) 复合外键内嵌 tenant_id、检索键与内容、来源闭集与行形 CHECK、主体索引。不修改任何既有表。",
      objects: ["enterprise_personal_memories"],
      statements: [
        'CREATE TABLE "enterprise_personal_memories" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"memory_key" text NOT NULL,\n' +
          '\t"content" text NOT NULL,\n' +
          "\t\"source_kind\" text DEFAULT 'manual' NOT NULL,\n" +
          '\t"source_ref" text,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_personal_memories_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          "\tCONSTRAINT \"enterprise_personal_memory_source_kind\" CHECK (\"enterprise_personal_memories\".\"source_kind\" in ('manual','kb','document')),\n" +
          '\tCONSTRAINT "enterprise_personal_memory_source_shape" CHECK (("enterprise_personal_memories"."source_kind" in (\'kb\',\'document\')) = ("enterprise_personal_memories"."source_ref" is not null))\n' +
          ");",
        'ALTER TABLE "enterprise_personal_memories" ADD CONSTRAINT "enterprise_personal_memories_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_personal_memories" ADD CONSTRAINT "enterprise_personal_memories_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_personal_memories" ADD CONSTRAINT "enterprise_personal_memories_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_personal_memory_subject_idx" ON "enterprise_personal_memories" ("tenant_id","workspace_id","principal_id","memory_key");',
      ],
    },
    {
      slug: "personal_memory_rls_policies",
      impact:
        "新表的 FORCE RLS 与最小授权：data 角色读/插/改/删四动作全部 tenant+principal 双 pin（同团队他人连行都不可见）；operator 租户 pin 只读；零跨主体 UPDATE；directory 零授权。不改动任何既有表策略或授权。",
      objects: ["enterprise_personal_memories"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_personal_memories" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_personal_memories" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_personal_memories" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_personal_memory_data_read" ON "enterprise_personal_memories"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_personal_memories"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_personal_memories"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_personal_memory_data_insert" ON "enterprise_personal_memories"\n  FOR INSERT TO ob_ent_data\n  WITH CHECK ("enterprise_personal_memories"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_personal_memories"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_personal_memory_data_update" ON "enterprise_personal_memories"\n  FOR UPDATE TO ob_ent_data\n  USING ("enterprise_personal_memories"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_personal_memories"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'))\n  WITH CHECK ("enterprise_personal_memories"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_personal_memories"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_personal_memory_data_delete" ON "enterprise_personal_memories"\n  FOR DELETE TO ob_ent_data\n  USING ("enterprise_personal_memories"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_personal_memories"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_personal_memory_operator_read" ON "enterprise_personal_memories"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_personal_memories"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "enterprise_personal_memories" TO ob_ent_data;',
        'GRANT SELECT ON TABLE "enterprise_personal_memories" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT040（Issue #83）：学习容器、研究与演示记录隔离。expand-only——仅新增
 * 两张表与最小 RLS，不改任何既有对象：
 *
 *   - enterprise_learning_containers：一行 = 一次容器分配，归属键
 *     (tenant, workspace) 内嵌 tenant_id；namespace 是服务端从归属派生的
 *     摘要（CHECK 钉死形状 ^mt040-ns-[0-9a-f]{32}$，绝不掺用户输入或凭据
 *     片段）；allocated/released 闭集 + 行形 CHECK；回收后每次分配都是
 *     新行，跨范围复用旧容器结构性不可能。
 *   - enterprise_learning_records：一行 = 一条研究或演示记录（kind 闭集），
 *     归属 (tenant, workspace, principal) + 容器外键内嵌 tenant_id；
 *     data 租户 pin 读 + 插自己；operator 租户 pin 读 + 改（释放通道）；
 *     零 DELETE；directory 零授权。
 *
 * 判定/管理服务在 server/src/enterprise/tenancy/learning-demonstrations.ts。
 */
const LEARNING_DEMONSTRATION_TASK: TaskMigrationSpec = {
  id: "MT040",
  description:
    "MT040（Issue #83）：新增 enterprise_learning_containers 与 enterprise_learning_records（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "learning_tables",
      impact:
        "新增两张学习域归属表：enterprise_learning_containers（容器分配，namespace 服务端派生摘要 + 形状 CHECK、allocated/released 闭集 + 行形 CHECK）与 enterprise_learning_records（研究/演示记录，kind 闭集，归属键复合外键内嵌 tenant_id）。不修改任何既有表。",
      objects: [
        "enterprise_learning_containers",
        "enterprise_learning_records",
      ],
      statements: [
        'CREATE TABLE "enterprise_learning_containers" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"namespace" text NOT NULL,\n' +
          '\t"allocated_by_principal_id" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'allocated' NOT NULL,\n" +
          '\t"released_at" timestamp with time zone,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_learning_containers_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          '\tCONSTRAINT "enterprise_learning_container_status" CHECK ("enterprise_learning_containers"."status" in (\'allocated\',\'released\')),\n' +
          '\tCONSTRAINT "enterprise_learning_container_release_shape" CHECK (("enterprise_learning_containers"."status" = \'released\') = ("enterprise_learning_containers"."released_at" is not null)),\n' +
          '\tCONSTRAINT "enterprise_learning_container_namespace_shape" CHECK ("enterprise_learning_containers"."namespace" ~ \'^mt040-ns-[0-9a-f]{32}$\')\n' +
          ");",
        'ALTER TABLE "enterprise_learning_containers" ADD CONSTRAINT "enterprise_learning_containers_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_learning_containers" ADD CONSTRAINT "enterprise_learning_containers_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_learning_containers" ADD CONSTRAINT "enterprise_learning_containers_tenant_id_allocated_by_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","allocated_by_principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_learning_container_scope_idx" ON "enterprise_learning_containers" ("tenant_id","workspace_id","status");',
        'CREATE TABLE "enterprise_learning_records" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"container_id" text NOT NULL,\n' +
          '\t"kind" text NOT NULL,\n' +
          '\t"title" text NOT NULL,\n' +
          '\t"payload" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_learning_records_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          '\tCONSTRAINT "enterprise_learning_record_kind" CHECK ("enterprise_learning_records"."kind" in (\'research\',\'demonstration\'))\n' +
          ");",
        'ALTER TABLE "enterprise_learning_records" ADD CONSTRAINT "enterprise_learning_records_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_learning_records" ADD CONSTRAINT "enterprise_learning_records_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_learning_records" ADD CONSTRAINT "enterprise_learning_records_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_learning_records" ADD CONSTRAINT "enterprise_learning_records_tenant_id_container_id_enterprise_learning_containers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","container_id") REFERENCES "public"."enterprise_learning_containers"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_learning_record_scope_idx" ON "enterprise_learning_records" ("tenant_id","workspace_id","kind");',
      ],
    },
    {
      slug: "learning_rls_policies",
      impact:
        "两张新表的 FORCE RLS 与最小授权：容器行 data 角色租户 pin 读 + 插自己（tenant+principal pin）、operator 租户 pin 读 + 改（释放通道）；记录行 data 租户 pin 读 + 插自己、operator 租户 pin 读 + 改；任何角色零 DELETE；directory 零授权。不改动任何既有表策略或授权。",
      objects: [
        "enterprise_learning_containers",
        "enterprise_learning_records",
      ],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_learning_containers" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_learning_containers" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_learning_containers" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_learning_container_data_read" ON "enterprise_learning_containers"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_learning_containers"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_learning_container_data_insert" ON "enterprise_learning_containers"\n  FOR INSERT TO ob_ent_data\n  WITH CHECK ("enterprise_learning_containers"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_learning_containers"."allocated_by_principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_learning_container_operator_read" ON "enterprise_learning_containers"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_learning_containers"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_learning_container_operator_update" ON "enterprise_learning_containers"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_learning_containers"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_learning_containers"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT, INSERT ON TABLE "enterprise_learning_containers" TO ob_ent_data;',
        'GRANT SELECT, UPDATE ON TABLE "enterprise_learning_containers" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_learning_records" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_learning_records" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_learning_records" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_learning_record_data_read" ON "enterprise_learning_records"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_learning_records"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_learning_record_data_insert" ON "enterprise_learning_records"\n  FOR INSERT TO ob_ent_data\n  WITH CHECK ("enterprise_learning_records"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\') AND "enterprise_learning_records"."principal_id" = nullif(current_setting(\'app.principal_id\', true), \'\'));',
        'CREATE POLICY "enterprise_learning_record_operator_read" ON "enterprise_learning_records"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_learning_records"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_learning_record_operator_update" ON "enterprise_learning_records"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_learning_records"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_learning_records"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT, INSERT ON TABLE "enterprise_learning_records" TO ob_ent_data;',
        'GRANT SELECT, UPDATE ON TABLE "enterprise_learning_records" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT068（Issue #111）：清理、保留与恢复带可核验归属与不可伪造 manifest。
 * expand-only——仅新增两张表与最小 RLS，不改任何既有对象（消费 MT067
 * 清理域先例与 enterprise_resources 既有状态闭集）：
 *
 *   - enterprise_purge_manifests：一行 = 一份服务端生成的 purge/
 *     retention/restore 清单。归属键内嵌 tenant_id；item_refs 是服务端
 *     枚举的范围资源清单（jsonb 数组形状 CHECK）；signature 是服务端
 *     密钥的 HMAC-SHA256（64hex CHECK）；(tenant, idempotency_key) 唯一
 *     ——同键重跑收敛到同一 manifest。data 只读；operator 读 + 写——
 *     客户端不存在任何 manifest 写入通道（不可伪造的结构性保证）。
 *   - enterprise_purge_audit：只追加审计行（event 闭集 + detail 闭形且
 *     禁秘密载体键 CHECK）；任何角色零 UPDATE/DELETE；operator 只插+读。
 *
 * 判定/管理服务在 server/src/enterprise/tenancy/purge-restore.ts。
 */
const PURGE_RESTORE_TASK: TaskMigrationSpec = {
  id: "MT068",
  description:
    "MT068（Issue #111）：新增 enterprise_purge_manifests 与 enterprise_purge_audit（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "purge_manifest_tables",
      impact:
        "新增两张清理域表：enterprise_purge_manifests（服务端签名清单，operation/status/签名形状/清单形状/行形 CHECK + 幂等键唯一索引）与 enterprise_purge_audit（只追加审计行，event 闭集 + detail 闭形且禁秘密载体键）。不修改任何既有表。",
      objects: ["enterprise_purge_manifests", "enterprise_purge_audit"],
      statements: [
        'CREATE TABLE "enterprise_purge_manifests" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"operation" text NOT NULL,\n' +
          '\t"workspace_id" text,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"item_refs" jsonb NOT NULL,\n' +
          '\t"signature" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'sealed' NOT NULL,\n" +
          '\t"idempotency_key" text NOT NULL,\n' +
          '\t"executed_at" timestamp with time zone,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_purge_manifests_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          "\tCONSTRAINT \"enterprise_purge_manifest_operation\" CHECK (\"enterprise_purge_manifests\".\"operation\" in ('purge','retention','restore')),\n" +
          "\tCONSTRAINT \"enterprise_purge_manifest_status\" CHECK (\"enterprise_purge_manifests\".\"status\" in ('sealed','executed','failed')),\n" +
          '\tCONSTRAINT "enterprise_purge_manifest_signature_shape" CHECK ("enterprise_purge_manifests"."signature" ~ \'^[0-9a-f]{64}$\'),\n' +
          '\tCONSTRAINT "enterprise_purge_manifest_items_shape" CHECK (jsonb_typeof("enterprise_purge_manifests"."item_refs") = \'array\'),\n' +
          '\tCONSTRAINT "enterprise_purge_manifest_execution_shape" CHECK (("enterprise_purge_manifests"."status" = \'executed\') = ("enterprise_purge_manifests"."executed_at" is not null))\n' +
          ");",
        'ALTER TABLE "enterprise_purge_manifests" ADD CONSTRAINT "enterprise_purge_manifests_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_purge_manifests" ADD CONSTRAINT "enterprise_purge_manifests_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_purge_manifests" ADD CONSTRAINT "enterprise_purge_manifests_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE UNIQUE INDEX "enterprise_purge_manifest_idempotency_idx" ON "enterprise_purge_manifests" ("tenant_id","idempotency_key");',
        'CREATE INDEX "enterprise_purge_manifest_scope_idx" ON "enterprise_purge_manifests" ("tenant_id","workspace_id","operation");',
        'CREATE TABLE "enterprise_purge_audit" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"manifest_id" text NOT NULL,\n' +
          '\t"event" text NOT NULL,\n' +
          '\t"actor_principal_id" text NOT NULL,\n' +
          '\t"detail" jsonb NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_purge_audit_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          "\tCONSTRAINT \"enterprise_purge_audit_event\" CHECK (\"enterprise_purge_audit\".\"event\" in ('sealed','executed','restored','failed')),\n" +
          '\tCONSTRAINT "enterprise_purge_audit_detail_shape" CHECK (jsonb_typeof("enterprise_purge_audit"."detail") = \'object\'),\n' +
          '\tCONSTRAINT "enterprise_purge_audit_no_secret_carriers" CHECK (not ("enterprise_purge_audit"."detail" ? \'secret\' or "enterprise_purge_audit"."detail" ? \'password\' or "enterprise_purge_audit"."detail" ? \'token\' or "enterprise_purge_audit"."detail" ? \'apiKey\'))\n' +
          ");",
        'ALTER TABLE "enterprise_purge_audit" ADD CONSTRAINT "enterprise_purge_audit_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_purge_audit" ADD CONSTRAINT "enterprise_purge_audit_tenant_id_manifest_id_enterprise_purge_manifests_tenant_id_id_fk" FOREIGN KEY ("tenant_id","manifest_id") REFERENCES "public"."enterprise_purge_manifests"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_purge_audit" ADD CONSTRAINT "enterprise_purge_audit_tenant_id_actor_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","actor_principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE INDEX "enterprise_purge_audit_manifest_idx" ON "enterprise_purge_audit" ("tenant_id","manifest_id");',
      ],
    },
    {
      slug: "purge_manifest_rls_policies",
      impact:
        "两张新表的 FORCE RLS 与最小授权：manifest 行 data 角色租户 pin 只读、operator 租户 pin 读 + 插 + 改（签名与执行都走受限 operator 通道，客户端无写入通道）；审计行 operator 读 + 插，任何角色零 UPDATE/DELETE。另按 MT067 先例给 enterprise_resources 补列级 UPDATE(status, revision) 授权（走既有 operator UPDATE 行策略）。不改动任何既有表策略或既有授权。",
      objects: ["enterprise_purge_manifests", "enterprise_purge_audit"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_purge_manifests" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_purge_manifests" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_purge_manifests" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_purge_manifest_data_read" ON "enterprise_purge_manifests"\n  FOR SELECT TO ob_ent_data\n  USING ("enterprise_purge_manifests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_purge_manifest_operator_read" ON "enterprise_purge_manifests"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_purge_manifests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_purge_manifest_operator_write" ON "enterprise_purge_manifests"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_purge_manifests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_purge_manifest_operator_update" ON "enterprise_purge_manifests"\n  FOR UPDATE TO ob_ent_operator\n  USING ("enterprise_purge_manifests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'))\n  WITH CHECK ("enterprise_purge_manifests"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT ON TABLE "enterprise_purge_manifests" TO ob_ent_data;',
        'GRANT SELECT, INSERT, UPDATE ON TABLE "enterprise_purge_manifests" TO ob_ent_operator;',
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_purge_audit" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'ALTER TABLE "enterprise_purge_audit" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_purge_audit" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_purge_audit_operator_read" ON "enterprise_purge_audit"\n  FOR SELECT TO ob_ent_operator\n  USING ("enterprise_purge_audit"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'CREATE POLICY "enterprise_purge_audit_operator_insert" ON "enterprise_purge_audit"\n  FOR INSERT TO ob_ent_operator\n  WITH CHECK ("enterprise_purge_audit"."tenant_id" = nullif(current_setting(\'app.tenant_id\', true), \'\'));',
        'GRANT SELECT, INSERT ON TABLE "enterprise_purge_audit" TO ob_ent_operator;',
        // MT067 先例（expand-only 追加授权）：purge/restore 的资源状态翻转
        // 走既有 enterprise_resource_operator_update 行策略（租户 pin +
        // resource_id pin，逐资源作业），本票只补列级 UPDATE(status,
        // revision) 授权；不新增策略、不改任何既有授权。
        'GRANT UPDATE ("status", "revision") ON TABLE "enterprise_resources" TO ob_ent_operator;',
      ],
    },
  ],
};

const VENDOR_BILLING_INTERACTION_TASK: TaskMigrationSpec = {
  id: "MT074",
  description:
    "MT074（波次 16 补位）：供应商计费调用面与回调归属锁定——新增 billing_vendor_interactions 交互审计表（expand-only，仅新增一张账务域审计表，不改既有对象）。",
  steps: [
    {
      slug: "vendor_billing_interactions",
      impact:
        "新增 billing_vendor_interactions 表：每次供应商计费交互尝试一行（方向/公司/主体/客户键/操作/结局/拒绝码/闭形 detail）。无外键（审计不随对象消亡），direction/outcome 闭集、结局/拒绝码行形配对、detail 闭形四组 CHECK；两条查询索引。不修改任何既有表。",
      objects: ["billing_vendor_interactions"],
      statements: VENDOR_BILLING_INTERACTIONS_STATEMENTS,
    },
  ],
};

/**
 * MT067（Issue #110）：退出/清理与全局删除双轨域的存储面授权。expand-only——
 * 仅给受限 operator 角色补 enterprise_workspace_memberships 的 DELETE 行策略
 * 与授权。背景：公司成员数据清理（Track A）要摘除本公司范围内该成员的团队
 * 成员资格行；MT004/MT012 只给了 INSERT/UPDATE(status,epoch)，没有 DELETE。
 * 新策略与同表既有 operator UPDATE 行策略同形（app.tenant_id +
 * app.operator_principal_id 双 pin——清理事务把 operator pin 切到被清理成员
 * 后，只有该成员在本公司的团队行可达）。不修改任何既有表/列/约束/策略/授权。
 *
 * 幂等再断言（MT012 同款纪律）：MT006 的 workspace-scope 测试夹具
 * （tests/multitenancy/support/workspace-scope.ts）在测试库上以夹具侧幂等
 * 预置过同名策略——生产环境由本迁移创建（生产唯一权威写入方），测试库
 * 上遇已存在策略时按条件块跳过创建，GRANT 重复执行为无操作。
 */
const DELETION_SEMANTICS_TASK: TaskMigrationSpec = {
  id: "MT067",
  description:
    "MT067（Issue #110）：公司成员清理——enterprise_workspace_memberships 的 operator DELETE 行策略与授权（expand-only，不改任何既有对象/策略/授权；幂等再断言）。",
  steps: [
    {
      slug: "workspace_membership_cleanup_delete",
      impact:
        "给受限 operator 角色补 enterprise_workspace_memberships 的 DELETE 行策略（app.tenant_id + app.operator_principal_id 双 pin，与同表既有 operator UPDATE 行策略同形；pg_policies 目录已存在同名策略时条件跳过——MT006 测试夹具预置先例）及配套 GRANT DELETE（重复授权为无操作）。不授予其它任何权限，不改任何既有策略。",
      objects: ["enterprise_workspace_memberships"],
      statements: [
        "DO $mt067$\n" +
          "BEGIN\n" +
          "  IF NOT EXISTS (\n" +
          "    SELECT 1 FROM pg_policies\n" +
          "    WHERE schemaname = 'public'\n" +
          "      AND tablename = 'enterprise_workspace_memberships'\n" +
          "      AND policyname = 'enterprise_workspace_membership_operator_delete'\n" +
          "  ) THEN\n" +
          '    CREATE POLICY "enterprise_workspace_membership_operator_delete" ON "enterprise_workspace_memberships"\n' +
          "      FOR DELETE TO ob_ent_operator\n" +
          "      USING (\"enterprise_workspace_memberships\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "        AND \"enterprise_workspace_memberships\".\"principal_id\" = nullif(current_setting('app.operator_principal_id', true), ''));\n" +
          "  END IF;\n" +
          "END\n" +
          "$mt067$;",
        'GRANT DELETE ON TABLE "enterprise_workspace_memberships" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT078（Issue #121）：业务审计与身份审计分域，计费管理需明确授权。
 *
 * expand-only，两张新表，不改任何既有表/策略/角色授权：
 *
 *   1. enterprise_audit_events——租户审计事件的分域存储（business |
 *      identity | platform）。跟随 enterprise_security_events 的受限通道
 *      模型（ob_ent_operator + RLS + FORCE RLS），但读策略只有租户 pin
 *      （审计查询读多行，不是 operation pin 的单行面）；写策略保持
 *      tenant ∧ operation 双 pin。ob_ent_directory / ob_ent_data 零授权。
 *   2. billing_company_manage_grants——公司计费管理授权事实（发放|调整|
 *      退款 位集）。跟随 MT073 公司财务读取授权同款纪律（PK+双侧复合
 *      FK；billing 域 D2 裁决：owner 通道、无 RLS、受限角色零授权）。
 */
const AUDIT_DOMAIN_TASK: TaskMigrationSpec = {
  id: "MT078",
  description:
    "MT078（Issue #121）：审计分域存储与计费管理授权——新增 enterprise_audit_events（受限 operator RLS）与 billing_company_manage_grants（billing 域 owner 通道），expand-only。",
  steps: [
    {
      slug: "audit_domain_events",
      impact:
        "新增 enterprise_audit_events 表：分域审计事件（domain ∈ business|identity|platform 封闭 CHECK）。operator 读策略=租户 pin（跨租户结构性排除），写策略=租户+操作双 pin；FORCE RLS；directory/data 零授权（结构隔离）。",
      objects: ["enterprise_audit_events"],
      statements: [
        'CREATE TABLE "enterprise_audit_events" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"domain" text NOT NULL,\n' +
          '\t"event_type" text NOT NULL,\n' +
          '\t"actor_id" text NOT NULL,\n' +
          '\t"target_id" text,\n' +
          '\t"payload" jsonb NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_audit_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),\n' +
          "\tCONSTRAINT \"enterprise_audit_event_domain\" CHECK (\"enterprise_audit_events\".\"domain\" in ('business','identity','platform')),\n" +
          '\tCONSTRAINT "enterprise_audit_events_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action\n' +
          ");",
        'CREATE INDEX "enterprise_audit_event_tenant_domain_time" ON "enterprise_audit_events" ("tenant_id","domain","created_at");',
        'ALTER TABLE "enterprise_audit_events" ENABLE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_audit_event_operator_read" ON "enterprise_audit_events"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_audit_events\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_audit_event_operator_insert" ON "enterprise_audit_events"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_audit_events\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_audit_events\".\"id\" = nullif(current_setting('app.operation_id', true), ''));",
        'GRANT SELECT, INSERT ON TABLE "enterprise_audit_events" TO ob_ent_operator;',
        'ALTER TABLE "enterprise_audit_events" FORCE ROW LEVEL SECURITY;',
      ],
    },
    {
      slug: "billing_manage_grants",
      impact:
        "新增 billing_company_manage_grants 表：公司计费管理授权事实（发放|调整|退款位集，PK(tenant,principal)，双侧复合 FK 证成员；billing 域 owner 通道、无 RLS、受限角色零授权=结构隔离）。",
      objects: ["billing_company_manage_grants"],
      statements: [
        'CREATE TABLE "billing_company_manage_grants" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"granted_by" text NOT NULL,\n' +
          '\t"actions" integer NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "billing_company_manage_grants_tenant_id_principal_id_pk" PRIMARY KEY("tenant_id","principal_id"),\n' +
          '\tCONSTRAINT "billing_company_manage_actions" CHECK ("billing_company_manage_grants"."actions" between 1 and 7),\n' +
          '\tCONSTRAINT "billing_company_manage_grants_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "billing_company_manage_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action,\n' +
          '\tCONSTRAINT "billing_company_manage_grants_tenant_id_granted_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action\n' +
          ");",
      ],
    },
  ],
};

/**
 * MT061（Issue #104）：OpenMuse 文件/文档/个人工作区域的归属域。expand-only
 * ——两张新协会表与按既有模式的最小 RLS；不修改任何既有表/策略/角色授权。
 *
 *   1. openmuse_file_scopes：一行 = 一个只有 owner_user_id 的文件根记录在
 *      一个 (公司, 团队, 主体) 三元组上的归属关联（Spec §4.2 逐字形状）。
 *      file_id 主键 FK → openmuse_files(id) cascade；复合外键钉到
 *      enterprise_workspaces 与 enterprise_memberships 与 users，均
 *      cascade；attribution ∈ {'created','import'} CHECK 区分本地上传 pin
 *      与外部引用（邮件附件导入）pin。
 *   2. openmuse_document_actions：一行 = 一次 PDF 填写/传输动作的发起归属
 *      （AC2「保存发起归属，执行时校验」的持久面）。(file_id, action_kind)
 *      复合主键（同键重放收敛）；action_kind ∈ {'fill','transfer'} CHECK；
 *      同款复合外键。
 *   3. RLS 沿 MT059/MT060 既有模式 + MT042 扫描臂：REVOKE PUBLIC + 四能力
 *      角色 → ENABLE + FORCE → data 租户臂 + restrictive 主体自读 →
 *      operator 租户 + 主体上下文读/插/删 → operator app.scan_sweep='on'
 *      跨租户读臂（平台触发重建专用）。目录角色无任何策略与授权。零
 *      UPDATE 授权——归属不可改写是结构不是纪律。
 */
const OPENMUSE_FILE_TENANCY_RLS_STATEMENTS: readonly string[] = [
  'REVOKE ALL PRIVILEGES ON TABLE "openmuse_file_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "openmuse_file_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "openmuse_file_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "openmuse_file_scope_data_tenant_read" ON "openmuse_file_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_file_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "openmuse_file_scope_data_self_read" ON "openmuse_file_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_file_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_file_scope_operator_read" ON "openmuse_file_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"openmuse_file_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_file_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_file_scope_operator_insert" ON "openmuse_file_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"openmuse_file_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_file_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_file_scope_operator_delete" ON "openmuse_file_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"openmuse_file_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_file_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_file_scope_operator_sweep_read" ON "openmuse_file_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (current_setting('app.scan_sweep', true) = 'on');",
  'GRANT SELECT ON TABLE "openmuse_file_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "openmuse_file_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "openmuse_file_scopes" TO ob_ent_operator;',
  'REVOKE ALL PRIVILEGES ON TABLE "openmuse_document_actions" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "openmuse_document_actions" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "openmuse_document_actions" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "openmuse_document_action_data_tenant_read" ON "openmuse_document_actions"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_document_actions\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "openmuse_document_action_data_self_read" ON "openmuse_document_actions"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_document_actions\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_document_action_operator_read" ON "openmuse_document_actions"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"openmuse_document_actions\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_document_actions\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_document_action_operator_insert" ON "openmuse_document_actions"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"openmuse_document_actions\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_document_actions\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_document_action_operator_delete" ON "openmuse_document_actions"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"openmuse_document_actions\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_document_actions\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_document_action_operator_sweep_read" ON "openmuse_document_actions"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (current_setting('app.scan_sweep', true) = 'on');",
  'GRANT SELECT ON TABLE "openmuse_document_actions" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "openmuse_document_actions" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "openmuse_document_actions" TO ob_ent_operator;',
];

const OPENMUSE_FILE_TENANCY_TASK: TaskMigrationSpec = {
  id: "MT061",
  description:
    "MT061（Issue #104）：OpenMuse 文件/文档/个人工作区域归属域——新增 openmuse_file_scopes 与 openmuse_document_actions 协会表（表 + RLS 两步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "file_scope_tables",
      impact:
        "新增 openmuse_file_scopes 与 openmuse_document_actions 表：file_id 主键（FK → openmuse_files cascade）/ (file_id, action_kind) 复合主键；复合外键钉到 enterprise_workspaces、enterprise_memberships 与 users（均 cascade）；attribution 与 action_kind CHECK；范围列表索引。不修改任何既有表。",
      objects: ["openmuse_file_scopes", "openmuse_document_actions"],
      statements: [
        'CREATE TABLE "openmuse_file_scopes" (\n' +
          '\t"file_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          "\t\"attribution\" text DEFAULT 'created' NOT NULL,\n" +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "openmuse_file_scopes_attribution" CHECK ("openmuse_file_scopes"."attribution" in (\'created\',\'import\'))\n' +
          ");",
        'CREATE INDEX "openmuse_file_scopes_scope_list_idx" ON "openmuse_file_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","file_id");',
        'ALTER TABLE "openmuse_file_scopes" ADD CONSTRAINT "openmuse_file_scopes_file_fk" FOREIGN KEY ("file_id") REFERENCES "public"."openmuse_files"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_file_scopes" ADD CONSTRAINT "openmuse_file_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_file_scopes" ADD CONSTRAINT "openmuse_file_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_file_scopes" ADD CONSTRAINT "openmuse_file_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
        'CREATE TABLE "openmuse_document_actions" (\n' +
          '\t"file_id" text NOT NULL,\n' +
          '\t"action_kind" text NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "openmuse_document_actions_pk" PRIMARY KEY ("file_id","action_kind"),\n' +
          '\tCONSTRAINT "openmuse_document_actions_kind" CHECK ("openmuse_document_actions"."action_kind" in (\'fill\',\'transfer\'))\n' +
          ");",
        'CREATE INDEX "openmuse_document_actions_scope_list_idx" ON "openmuse_document_actions" USING btree ("tenant_id","workspace_id","principal_id","created_at","file_id");',
        'ALTER TABLE "openmuse_document_actions" ADD CONSTRAINT "openmuse_document_actions_file_fk" FOREIGN KEY ("file_id") REFERENCES "public"."openmuse_files"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_document_actions" ADD CONSTRAINT "openmuse_document_actions_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_document_actions" ADD CONSTRAINT "openmuse_document_actions_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_document_actions" ADD CONSTRAINT "openmuse_document_actions_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "file_scope_rls",
      impact:
        "仅对两张新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 主体自读；operator 租户+主体上下文读/插/删 + app.scan_sweep 扫描臂）及配套最小 GRANT；零 UPDATE 授权。不改动任何既有表策略或既有授权。目录角色无任何策略与授权。",
      objects: ["openmuse_file_scopes", "openmuse_document_actions"],
      statements: OPENMUSE_FILE_TENANCY_RLS_STATEMENTS,
    },
  ],
};

/**
 * MT062（Issue #105）：OpenMuse 个人域（目标/想法/记忆）与财务产物的归属
 * 域。expand-only——一张新协会表与按既有模式的最小 RLS；不修改任何既有
 * 表/策略/角色授权。
 *
 *   1. openmuse_personal_scopes：一行 = 一个个人域根记录（openmuse_goals /
 *      openmuse_ideas / openmuse_memories，或作为财务产物 pin 的
 *      openmuse_files 行 id）在一个 (公司, 团队, 主体) 三元组上的归属关联
 *      （Spec §4.2 逐字形状）。(object_type, object_id) 复合主键：一个对
 *      象至多一条归属；三类根表各自的 text 主键无法跨表外键——根行存在
 *      性与 owner 一致性由服务面 rows 缝核死（诚实披露，见 schema 注释）。
 *      object_type ∈ {'goal','idea','memory','finance_artifact'} CHECK；
 *      attribution ∈ {'created','import'} CHECK。
 *   2. RLS 沿 MT059/MT060 既有模式 + MT042 扫描臂：REVOKE PUBLIC + 四能力
 *      角色 → ENABLE + FORCE → data 租户臂 + restrictive 主体自读（AC1：
 *      同团队他人连行都不可见）→ operator 租户 + 主体上下文读/插/删 →
 *      operator app.scan_sweep='on' 跨租户读臂。目录角色无任何策略与授
 *      权。零 UPDATE 授权——归属不可改写是结构不是纪律。
 */
const OPENMUSE_PERSONAL_TENANCY_RLS_STATEMENTS: readonly string[] = [
  'REVOKE ALL PRIVILEGES ON TABLE "openmuse_personal_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "openmuse_personal_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "openmuse_personal_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "openmuse_personal_scope_data_tenant_read" ON "openmuse_personal_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_personal_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "openmuse_personal_scope_data_self_read" ON "openmuse_personal_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_personal_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_personal_scope_operator_read" ON "openmuse_personal_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"openmuse_personal_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_personal_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_personal_scope_operator_insert" ON "openmuse_personal_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"openmuse_personal_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_personal_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_personal_scope_operator_delete" ON "openmuse_personal_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"openmuse_personal_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_personal_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_personal_scope_operator_sweep_read" ON "openmuse_personal_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (current_setting('app.scan_sweep', true) = 'on');",
  'GRANT SELECT ON TABLE "openmuse_personal_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "openmuse_personal_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "openmuse_personal_scopes" TO ob_ent_operator;',
];

const OPENMUSE_PERSONAL_TENANCY_TASK: TaskMigrationSpec = {
  id: "MT062",
  description:
    "MT062（Issue #105）：OpenMuse 个人域（目标/想法/记忆）与财务产物归属域——新增 openmuse_personal_scopes 协会表（表 + RLS 两步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "personal_scope_tables",
      impact:
        "新增 openmuse_personal_scopes 表：(object_type, object_id) 复合主键；复合外键钉到 enterprise_workspaces、enterprise_memberships 与 users（均 cascade）；object_type 与 attribution CHECK；范围列表索引。不修改任何既有表。",
      objects: ["openmuse_personal_scopes"],
      statements: [
        'CREATE TABLE "openmuse_personal_scopes" (\n' +
          '\t"object_type" text NOT NULL,\n' +
          '\t"object_id" text NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          "\t\"attribution\" text DEFAULT 'created' NOT NULL,\n" +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "openmuse_personal_scopes_pk" PRIMARY KEY ("object_type","object_id"),\n' +
          "\tCONSTRAINT \"openmuse_personal_scopes_object_type\" CHECK (\"openmuse_personal_scopes\".\"object_type\" in ('goal','idea','memory','finance_artifact')),\n" +
          '\tCONSTRAINT "openmuse_personal_scopes_attribution" CHECK ("openmuse_personal_scopes"."attribution" in (\'created\',\'import\'))\n' +
          ");",
        'CREATE INDEX "openmuse_personal_scopes_scope_list_idx" ON "openmuse_personal_scopes" USING btree ("tenant_id","workspace_id","principal_id","object_type","created_at","object_id");',
        'ALTER TABLE "openmuse_personal_scopes" ADD CONSTRAINT "openmuse_personal_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_personal_scopes" ADD CONSTRAINT "openmuse_personal_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_personal_scopes" ADD CONSTRAINT "openmuse_personal_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "personal_scope_rls",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 主体自读；operator 租户+主体上下文读/插/删 + app.scan_sweep 扫描臂）及配套最小 GRANT；零 UPDATE 授权。不改动任何既有表策略或既有授权。目录角色无任何策略与授权。",
      objects: ["openmuse_personal_scopes"],
      statements: OPENMUSE_PERSONAL_TENANCY_RLS_STATEMENTS,
    },
  ],
};

/**
 * MT064（Issue #107）：OpenMuse 审阅动作提案与回执的归属域。expand-only
 * ——一张新协会表与按既有模式的最小 RLS；不修改任何既有表/策略/授权。
 *
 *   1. openmuse_reviewed_action_scopes：一行 = 一条审阅动作提案根记录
 *      （openmuse_reviewed_actions，只有 owner_user_id 的用户级形状）在
 *      一个 (公司, 团队, 主体) 三元组上的归属关联（Spec §4.2 逐字形状）。
 *      action_id 主键 FK → openmuse_reviewed_actions(id) cascade——回执
 *      （attempt 行）经级联继承同一归属；复合外键钉到
 *      enterprise_workspaces、enterprise_memberships 与 users（均
 *      cascade）。无 attribution 列：审阅动作没有外部导入路径。
 *   2. RLS 沿 MT059–MT062 既有模式 + MT042 扫描臂：REVOKE PUBLIC + 四能力
 *      角色 → ENABLE + FORCE → data 租户臂 + restrictive 主体自读 →
 *      operator 租户 + 主体上下文读/插/删 + app.scan_sweep='on' 跨租户读
 *      臂。目录角色无任何策略与授权。零 UPDATE 授权。
 */
const OPENMUSE_REVIEWED_ACTION_TENANCY_RLS_STATEMENTS: readonly string[] = [
  'REVOKE ALL PRIVILEGES ON TABLE "openmuse_reviewed_action_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "openmuse_reviewed_action_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "openmuse_reviewed_action_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "openmuse_reviewed_action_scope_data_tenant_read" ON "openmuse_reviewed_action_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_reviewed_action_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "openmuse_reviewed_action_scope_data_self_read" ON "openmuse_reviewed_action_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_reviewed_action_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_reviewed_action_scope_operator_read" ON "openmuse_reviewed_action_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"openmuse_reviewed_action_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_reviewed_action_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_reviewed_action_scope_operator_insert" ON "openmuse_reviewed_action_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"openmuse_reviewed_action_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_reviewed_action_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_reviewed_action_scope_operator_delete" ON "openmuse_reviewed_action_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"openmuse_reviewed_action_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_reviewed_action_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_reviewed_action_scope_operator_sweep_read" ON "openmuse_reviewed_action_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (current_setting('app.scan_sweep', true) = 'on');",
  'GRANT SELECT ON TABLE "openmuse_reviewed_action_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "openmuse_reviewed_action_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "openmuse_reviewed_action_scopes" TO ob_ent_operator;',
];

const OPENMUSE_REVIEWED_ACTION_TENANCY_TASK: TaskMigrationSpec = {
  id: "MT064",
  description:
    "MT064（Issue #107）：OpenMuse 审阅动作提案与回执归属域——新增 openmuse_reviewed_action_scopes 协会表（表 + RLS 两步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "reviewed_action_scope_tables",
      impact:
        "新增 openmuse_reviewed_action_scopes 表：action_id 主键（FK → openmuse_reviewed_actions cascade）；复合外键钉到 enterprise_workspaces、enterprise_memberships 与 users（均 cascade）；范围列表索引。不修改任何既有表。",
      objects: ["openmuse_reviewed_action_scopes"],
      statements: [
        'CREATE TABLE "openmuse_reviewed_action_scopes" (\n' +
          '\t"action_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL\n' +
          ");",
        'CREATE INDEX "openmuse_reviewed_action_scopes_scope_list_idx" ON "openmuse_reviewed_action_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","action_id");',
        'ALTER TABLE "openmuse_reviewed_action_scopes" ADD CONSTRAINT "openmuse_reviewed_action_scopes_action_fk" FOREIGN KEY ("action_id") REFERENCES "public"."openmuse_reviewed_actions"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_reviewed_action_scopes" ADD CONSTRAINT "openmuse_reviewed_action_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_reviewed_action_scopes" ADD CONSTRAINT "openmuse_reviewed_action_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_reviewed_action_scopes" ADD CONSTRAINT "openmuse_reviewed_action_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "reviewed_action_scope_rls",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 主体自读；operator 租户+主体上下文读/插/删 + app.scan_sweep 扫描臂）及配套最小 GRANT；零 UPDATE 授权。不改动任何既有表策略或既有授权。目录角色无任何策略与授权。",
      objects: ["openmuse_reviewed_action_scopes"],
      statements: OPENMUSE_REVIEWED_ACTION_TENANCY_RLS_STATEMENTS,
    },
  ],
};

/**
 * MT065（Issue #108）：OpenMuse 活动流与通知的归属域。expand-only——两张
 * 新协会表与按既有模式的最小 RLS；不修改任何既有表/策略/授权。
 *
 *   1. openmuse_notification_scopes：一行 = 一条通知根记录
 *      （openmuse_notifications，只有 user_id 的用户级形状）在一个 (公司,
 *      团队, 主体) 三元组上的归属关联。notification_id 主键 FK →
 *      openmuse_notifications(id) cascade。
 *   2. openmuse_delivery_binding_scopes：一行 = 一条通知渠道绑定根记录
 *      （delivery_bindings，四元组用户级形状、无租户列）在一个三元组上的
 *      归属关联（AC4 通知渠道半边；推送设备对应面在 MT066）。binding_id
 *      主键 FK → delivery_bindings(id) cascade。
 *   3. RLS 沿 MT059–MT062 既有模式 + MT042 扫描臂（两表同款）。零
 *      UPDATE 授权。
 */
const OPENMUSE_ACTIVITY_TENANCY_RLS_STATEMENTS: readonly string[] = [
  'REVOKE ALL PRIVILEGES ON TABLE "openmuse_notification_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "openmuse_notification_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "openmuse_notification_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "openmuse_notification_scope_data_tenant_read" ON "openmuse_notification_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_notification_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "openmuse_notification_scope_data_self_read" ON "openmuse_notification_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_notification_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_notification_scope_operator_read" ON "openmuse_notification_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"openmuse_notification_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_notification_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_notification_scope_operator_insert" ON "openmuse_notification_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"openmuse_notification_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_notification_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_notification_scope_operator_delete" ON "openmuse_notification_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"openmuse_notification_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_notification_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_notification_scope_operator_sweep_read" ON "openmuse_notification_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (current_setting('app.scan_sweep', true) = 'on');",
  'GRANT SELECT ON TABLE "openmuse_notification_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "openmuse_notification_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "openmuse_notification_scopes" TO ob_ent_operator;',
  'REVOKE ALL PRIVILEGES ON TABLE "openmuse_delivery_binding_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "openmuse_delivery_binding_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "openmuse_delivery_binding_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "openmuse_delivery_binding_scope_data_tenant_read" ON "openmuse_delivery_binding_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_delivery_binding_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "openmuse_delivery_binding_scope_data_self_read" ON "openmuse_delivery_binding_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"openmuse_delivery_binding_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_delivery_binding_scope_operator_read" ON "openmuse_delivery_binding_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"openmuse_delivery_binding_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_delivery_binding_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_delivery_binding_scope_operator_insert" ON "openmuse_delivery_binding_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"openmuse_delivery_binding_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_delivery_binding_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_delivery_binding_scope_operator_delete" ON "openmuse_delivery_binding_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"openmuse_delivery_binding_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"openmuse_delivery_binding_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "openmuse_delivery_binding_scope_operator_sweep_read" ON "openmuse_delivery_binding_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (current_setting('app.scan_sweep', true) = 'on');",
  'GRANT SELECT ON TABLE "openmuse_delivery_binding_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "openmuse_delivery_binding_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "openmuse_delivery_binding_scopes" TO ob_ent_operator;',
];

const OPENMUSE_ACTIVITY_TENANCY_TASK: TaskMigrationSpec = {
  id: "MT065",
  description:
    "MT065（Issue #108）：OpenMuse 活动流与通知归属域——新增 openmuse_notification_scopes 与 openmuse_delivery_binding_scopes 协会表（表 + RLS 两步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "activity_scope_tables",
      impact:
        "新增 openmuse_notification_scopes 与 openmuse_delivery_binding_scopes 表：notification_id / binding_id 主键（FK → openmuse_notifications / delivery_bindings 均 cascade）；复合外键钉到 enterprise_workspaces、enterprise_memberships 与 users（均 cascade）；范围列表索引。不修改任何既有表。",
      objects: [
        "openmuse_notification_scopes",
        "openmuse_delivery_binding_scopes",
      ],
      statements: [
        'CREATE TABLE "openmuse_notification_scopes" (\n' +
          '\t"notification_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL\n' +
          ");",
        'CREATE INDEX "openmuse_notification_scopes_scope_list_idx" ON "openmuse_notification_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","notification_id");',
        'ALTER TABLE "openmuse_notification_scopes" ADD CONSTRAINT "openmuse_notification_scopes_notification_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."openmuse_notifications"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_notification_scopes" ADD CONSTRAINT "openmuse_notification_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_notification_scopes" ADD CONSTRAINT "openmuse_notification_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_notification_scopes" ADD CONSTRAINT "openmuse_notification_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
        'CREATE TABLE "openmuse_delivery_binding_scopes" (\n' +
          '\t"binding_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL\n' +
          ");",
        'CREATE INDEX "openmuse_delivery_binding_scopes_scope_list_idx" ON "openmuse_delivery_binding_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","binding_id");',
        'ALTER TABLE "openmuse_delivery_binding_scopes" ADD CONSTRAINT "openmuse_delivery_binding_scopes_binding_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."delivery_bindings"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_delivery_binding_scopes" ADD CONSTRAINT "openmuse_delivery_binding_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_delivery_binding_scopes" ADD CONSTRAINT "openmuse_delivery_binding_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "openmuse_delivery_binding_scopes" ADD CONSTRAINT "openmuse_delivery_binding_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "activity_scope_rls",
      impact:
        "仅对两张新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 主体自读；operator 租户+主体上下文读/插/删 + app.scan_sweep 扫描臂）及配套最小 GRANT；零 UPDATE 授权。不改动任何既有表策略或既有授权。目录角色无任何策略与授权。",
      objects: [
        "openmuse_notification_scopes",
        "openmuse_delivery_binding_scopes",
      ],
      statements: OPENMUSE_ACTIVITY_TENANCY_RLS_STATEMENTS,
    },
  ],
};

/**
 * MT066（Issue #109）：语音、听写与移动聚合的归属域。expand-only——三张
 * 新表与按既有模式的最小 RLS；不修改任何既有表/策略/授权。
 *
 *   1. voice_session_scopes：一行 = 一条语音会话根记录（voice_sessions，
 *      用户级形状、无租户列）在一个三元组上的归属关联 + usage_seconds
 *      冻结用量（AC1 语音半边，供 MT070）。session_id 主键 FK →
 *      voice_sessions(id) cascade。
 *   2. dictation_usage_scopes：一行 = 一次听写请求的用量归属记录（听写无
 *      会话根行，本行即持久用量事实；AC1 听写半边）。id 主键服务端生成；
 *      usage_key 唯一（幂等收敛）；audio_seconds/output_tokens 非负
 *      CHECK；无根表外键可钉（诚实披露）。
 *   3. push_device_scopes：一行 = 一台推送设备根记录（push_devices，仅
 *      owner_user_id）在一个三元组上的归属绑定（AC3）。device_id 主键
 *      FK → push_devices(id) cascade。
 *   4. RLS 沿 MT059–MT062 既有模式 + MT042 扫描臂（三表同款）。零
 *      UPDATE 授权。
 */
const OPENMUSE_VOICE_MOBILE_TENANCY_RLS_STATEMENTS: readonly string[] = [
  'REVOKE ALL PRIVILEGES ON TABLE "voice_session_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "voice_session_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "voice_session_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "voice_session_scope_data_tenant_read" ON "voice_session_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"voice_session_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "voice_session_scope_data_self_read" ON "voice_session_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"voice_session_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "voice_session_scope_operator_read" ON "voice_session_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"voice_session_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"voice_session_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "voice_session_scope_operator_insert" ON "voice_session_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"voice_session_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"voice_session_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "voice_session_scope_operator_delete" ON "voice_session_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"voice_session_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"voice_session_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "voice_session_scope_operator_sweep_read" ON "voice_session_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (current_setting('app.scan_sweep', true) = 'on');",
  'GRANT SELECT ON TABLE "voice_session_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "voice_session_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "voice_session_scopes" TO ob_ent_operator;',
  'REVOKE ALL PRIVILEGES ON TABLE "dictation_usage_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "dictation_usage_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "dictation_usage_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "dictation_usage_scope_data_tenant_read" ON "dictation_usage_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"dictation_usage_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "dictation_usage_scope_data_self_read" ON "dictation_usage_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"dictation_usage_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "dictation_usage_scope_operator_read" ON "dictation_usage_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"dictation_usage_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"dictation_usage_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "dictation_usage_scope_operator_insert" ON "dictation_usage_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"dictation_usage_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"dictation_usage_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "dictation_usage_scope_operator_delete" ON "dictation_usage_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"dictation_usage_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"dictation_usage_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "dictation_usage_scope_operator_sweep_read" ON "dictation_usage_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (current_setting('app.scan_sweep', true) = 'on');",
  'GRANT SELECT ON TABLE "dictation_usage_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "dictation_usage_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "dictation_usage_scopes" TO ob_ent_operator;',
  'REVOKE ALL PRIVILEGES ON TABLE "push_device_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "push_device_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "push_device_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "push_device_scope_data_tenant_read" ON "push_device_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"push_device_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "push_device_scope_data_self_read" ON "push_device_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"push_device_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "push_device_scope_operator_read" ON "push_device_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"push_device_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"push_device_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "push_device_scope_operator_insert" ON "push_device_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"push_device_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"push_device_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "push_device_scope_operator_delete" ON "push_device_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"push_device_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"push_device_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "push_device_scope_operator_sweep_read" ON "push_device_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (current_setting('app.scan_sweep', true) = 'on');",
  'GRANT SELECT ON TABLE "push_device_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "push_device_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "push_device_scopes" TO ob_ent_operator;',
];

const OPENMUSE_VOICE_MOBILE_TENANCY_TASK: TaskMigrationSpec = {
  id: "MT066",
  description:
    "MT066（Issue #109）：语音、听写与移动聚合归属域——新增 voice_session_scopes、dictation_usage_scopes 与 push_device_scopes 表（表 + RLS 两步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "voice_mobile_scope_tables",
      impact:
        "新增 voice_session_scopes（session_id 主键 FK → voice_sessions cascade + usage_seconds 冻结用量）、dictation_usage_scopes（id 主键、usage_key 唯一幂等键、audio_seconds/output_tokens 非负 CHECK；听写无根行，本表自持用量事实）与 push_device_scopes（device_id 主键 FK → push_devices cascade）三表；复合外键钉到 enterprise_workspaces、enterprise_memberships 与 users（均 cascade）；范围列表索引。不修改任何既有表。",
      objects: [
        "voice_session_scopes",
        "dictation_usage_scopes",
        "push_device_scopes",
      ],
      statements: [
        'CREATE TABLE "voice_session_scopes" (\n' +
          '\t"session_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"usage_seconds" integer NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "voice_session_scopes_usage_non_negative" CHECK ("voice_session_scopes"."usage_seconds" >= 0)\n' +
          ");",
        'CREATE INDEX "voice_session_scopes_scope_list_idx" ON "voice_session_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","session_id");',
        'ALTER TABLE "voice_session_scopes" ADD CONSTRAINT "voice_session_scopes_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."voice_sessions"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "voice_session_scopes" ADD CONSTRAINT "voice_session_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "voice_session_scopes" ADD CONSTRAINT "voice_session_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "voice_session_scopes" ADD CONSTRAINT "voice_session_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
        'CREATE TABLE "dictation_usage_scopes" (\n' +
          '\t"id" text PRIMARY KEY NOT NULL,\n' +
          '\t"usage_key" text NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"audio_seconds" integer NOT NULL,\n' +
          '\t"output_tokens" integer NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "dictation_usage_scopes_meters_non_negative" CHECK ("dictation_usage_scopes"."audio_seconds" >= 0 and "dictation_usage_scopes"."output_tokens" >= 0)\n' +
          ");",
        'CREATE UNIQUE INDEX "dictation_usage_scopes_usage_key_uq" ON "dictation_usage_scopes" USING btree ("usage_key");',
        'CREATE INDEX "dictation_usage_scopes_scope_list_idx" ON "dictation_usage_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","id");',
        'ALTER TABLE "dictation_usage_scopes" ADD CONSTRAINT "dictation_usage_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "dictation_usage_scopes" ADD CONSTRAINT "dictation_usage_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "dictation_usage_scopes" ADD CONSTRAINT "dictation_usage_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
        'CREATE TABLE "push_device_scopes" (\n' +
          '\t"device_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL\n' +
          ");",
        'CREATE INDEX "push_device_scopes_scope_list_idx" ON "push_device_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","device_id");',
        'ALTER TABLE "push_device_scopes" ADD CONSTRAINT "push_device_scopes_device_fk" FOREIGN KEY ("device_id") REFERENCES "public"."push_devices"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "push_device_scopes" ADD CONSTRAINT "push_device_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "push_device_scopes" ADD CONSTRAINT "push_device_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "push_device_scopes" ADD CONSTRAINT "push_device_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "voice_mobile_scope_rls",
      impact:
        "仅对三张新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 主体自读；operator 租户+主体上下文读/插/删 + app.scan_sweep 扫描臂）及配套最小 GRANT；零 UPDATE 授权。不改动任何既有表策略或既有授权。目录角色无任何策略与授权。",
      objects: [
        "voice_session_scopes",
        "dictation_usage_scopes",
        "push_device_scopes",
      ],
      statements: OPENMUSE_VOICE_MOBILE_TENANCY_RLS_STATEMENTS,
    },
  ],
};

/**
 * MT120（Issue #163）：无法归属外部状态的持久隔离清单。
 *
 * 一张新表 enterprise_quarantine_items（表 + RLS 两步，expand-only）：
 * 扫描幂等 upsert（setup/属主语义）、运维经受限通道查看、处置经受限
 * operator 通道翻状态（审计先行在服务面 quarantine-list.ts）。
 */
const QUARANTINE_LIST_TASK: TaskMigrationSpec = {
  id: "MT120",
  description:
    "MT120（Issue #163）：持久隔离清单——新增 enterprise_quarantine_items（表 + RLS 两步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "quarantine_items_table",
      impact:
        "新增 enterprise_quarantine_items：一行 = 一条无法唯一归属的外部状态隔离条目（确定性 id `<category>:<recordId>`，PK (tenant_id, id)，FK tenant → enterprise_tenants cascade）；category/reason/disposition/status 四闭集 CHECK；处置留痕列（resolved_at/resolved_by/target_tenant_id）。不修改任何既有表。",
      objects: ["enterprise_quarantine_items"],
      statements: [
        'CREATE TABLE "enterprise_quarantine_items" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"id" text NOT NULL,\n' +
          '\t"category" text NOT NULL,\n' +
          '\t"record_id" text NOT NULL,\n' +
          '\t"reason" text NOT NULL,\n' +
          '\t"suggested_disposition" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'open' NOT NULL,\n" +
          '\t"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"resolved_at" timestamp with time zone,\n' +
          '\t"resolved_by" text,\n' +
          '\t"target_tenant_id" text,\n' +
          '\tCONSTRAINT "enterprise_quarantine_items_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE cascade ON UPDATE cascade,\n' +
          '\tCONSTRAINT "enterprise_quarantine_items_pk" PRIMARY KEY ("tenant_id", "id"),\n' +
          "\tCONSTRAINT \"enterprise_quarantine_items_category_closed\" CHECK (\"category\" IN ('root-record', 'external-file')),\n" +
          "\tCONSTRAINT \"enterprise_quarantine_items_reason_closed\" CHECK (\"reason\" IN ('claimed-by-another-tenant', 'owner-principal-missing', 'ambiguous-membership', 'parent-tenant-mismatch', 'parent-association-missing', 'digest-mismatch')),\n" +
          "\tCONSTRAINT \"enterprise_quarantine_items_disposition_closed\" CHECK (\"suggested_disposition\" IN ('assign', 'destroy')),\n" +
          "\tCONSTRAINT \"enterprise_quarantine_items_status_closed\" CHECK (\"status\" IN ('open', 'assigned', 'destroyed', 'cleared-upstream'))\n" +
          ");",
      ],
    },
    {
      slug: "quarantine_items_rls",
      impact:
        "仅对 enterprise_quarantine_items：REVOKE PUBLIC、ENABLE + FORCE RLS、最小策略（data 租户臂 SELECT；operator 租户臂 SELECT/INSERT/UPDATE）及配套最小 GRANT（data 只读；operator 全列 INSERT + 处置列 UPDATE——resolved_* / target_tenant_id / status）。不改动任何既有表策略或既有授权。",
      objects: ["enterprise_quarantine_items"],
      statements: [
        'REVOKE ALL ON TABLE "enterprise_quarantine_items" FROM PUBLIC;',
        'ALTER TABLE "enterprise_quarantine_items" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "enterprise_quarantine_items" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_quarantine_items_data_read" ON "enterprise_quarantine_items" FOR SELECT TO ob_ent_data USING ("tenant_id" = current_setting(\'app.tenant_id\', true));',
        'CREATE POLICY "enterprise_quarantine_items_operator_read" ON "enterprise_quarantine_items" FOR SELECT TO ob_ent_operator USING ("tenant_id" = current_setting(\'app.tenant_id\', true));',
        'CREATE POLICY "enterprise_quarantine_items_operator_insert" ON "enterprise_quarantine_items" FOR INSERT TO ob_ent_operator WITH CHECK ("tenant_id" = current_setting(\'app.tenant_id\', true));',
        'CREATE POLICY "enterprise_quarantine_items_operator_update" ON "enterprise_quarantine_items" FOR UPDATE TO ob_ent_operator USING ("tenant_id" = current_setting(\'app.tenant_id\', true)) WITH CHECK ("tenant_id" = current_setting(\'app.tenant_id\', true));',
        'GRANT SELECT ON TABLE "enterprise_quarantine_items" TO ob_ent_data;',
        'GRANT SELECT, INSERT ON TABLE "enterprise_quarantine_items" TO ob_ent_operator;',
        'GRANT UPDATE ("status", "resolved_at", "resolved_by", "target_tenant_id", "reason", "suggested_disposition", "last_seen_at") ON TABLE "enterprise_quarantine_items" TO ob_ent_operator;',
      ],
    },
  ],
};

/**
 * MT053（Issue #96）：Craft 会话、turn、消息与快照的作用域。expand-only——
 * 一张新协会表与按既有模式的最小 RLS；不修改任何既有表/策略/角色授权。
 *
 *   1. enterprise_craft_scopes：一行 = 一个 craft 会话在一个 (公司, 团队,
 *      主体) 三元组上的归属关联（Spec §4.2 逐字形状；MT060 openmuse_
 *      task_scopes 同型判例）。session_id 主键 FK → craft_sessions(id)
 *      cascade；复合外键钉到 enterprise_workspaces、enterprise_
 *      memberships 与 users，均 cascade。
 *   2. RLS 沿 MT059/MT060 既有模式：REVOKE PUBLIC + 四能力角色 → ENABLE +
 *      FORCE → data 租户臂 + restrictive 主体自读 → operator 租户+主体
 *      上下文读/插/删 + operator workspace 读臂（团队公共面的存在性事实，
 *      无主体 pin）。零 UPDATE 授权——归属不可改写是结构不是纪律。
 */
const CRAFT_SESSION_SCOPES_RLS_STATEMENTS = [
  'REVOKE ALL PRIVILEGES ON TABLE "enterprise_craft_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "enterprise_craft_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "enterprise_craft_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "enterprise_craft_scope_data_tenant_read" ON "enterprise_craft_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_craft_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "enterprise_craft_scope_data_self_read" ON "enterprise_craft_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_craft_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_craft_scope_operator_workspace_read" ON "enterprise_craft_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"enterprise_craft_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_craft_scopes\".\"workspace_id\" = nullif(current_setting('app.workspace_id', true), ''));",
  'CREATE POLICY "enterprise_craft_scope_operator_read" ON "enterprise_craft_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"enterprise_craft_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_craft_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_craft_scope_operator_insert" ON "enterprise_craft_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"enterprise_craft_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_craft_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_craft_scope_operator_delete" ON "enterprise_craft_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"enterprise_craft_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_craft_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'GRANT SELECT ON TABLE "enterprise_craft_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "enterprise_craft_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "enterprise_craft_scopes" TO ob_ent_operator;',
];

const CRAFT_SESSION_SCOPES_TASK: TaskMigrationSpec = {
  id: "MT053",
  description:
    "MT053（Issue #96）：Craft 会话作用域——新增 enterprise_craft_scopes 协会表（表 + RLS 两步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "craft_scope_tables",
      impact:
        "新增 enterprise_craft_scopes 表：session_id 主键（FK → craft_sessions cascade）；复合外键钉到 enterprise_workspaces、enterprise_memberships 与 users（均 cascade）；范围列表索引。不修改任何既有表。",
      objects: ["enterprise_craft_scopes"],
      statements: [
        'CREATE TABLE "enterprise_craft_scopes" (\n' +
          '\t"session_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL\n' +
          ");",
        'CREATE INDEX "enterprise_craft_scopes_scope_list_idx" ON "enterprise_craft_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","session_id");',
        'ALTER TABLE "enterprise_craft_scopes" ADD CONSTRAINT "enterprise_craft_scopes_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."craft_sessions"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_craft_scopes" ADD CONSTRAINT "enterprise_craft_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_craft_scopes" ADD CONSTRAINT "enterprise_craft_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_craft_scopes" ADD CONSTRAINT "enterprise_craft_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "craft_scope_rls",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 主体自读；operator 租户+主体上下文读/插/删 + workspace 读臂）及配套最小 GRANT；零 UPDATE 授权。不改动任何既有表策略或既有授权。目录角色无任何策略与授权。",
      objects: ["enterprise_craft_scopes"],
      statements: CRAFT_SESSION_SCOPES_RLS_STATEMENTS,
    },
  ],
};

/**
 * MT054（Issue #97）：Craft 计划任务、子任务与应用连接的归属。expand-only
 * ——一张新协会表与按既有模式的最小 RLS（+ MT042 扫描臂）；不修改任何
 * 既有表/策略/角色授权。
 *
 *   1. enterprise_craft_schedule_scopes：一行 = 一个 Craft 计划域对象
 *      （kind ∈ {'scheduled_task','subtask','connection'}）在一个
 *      (公司, 团队, 主体) 三元组上的归属关联。(kind, object_id) 复合主键；
 *      subtask ⇔ parent_object_id、connection ⇔ credential_ref 两 CHECK 钉
 *      死；复合外键钉到 enterprise_workspaces、enterprise_memberships 与
 *      users，均 cascade。
 *   2. RLS 沿 MT059/MT060 既有模式 + MT042 扫描臂：operator 在
 *      app.scan_sweep='on' 上下文下的跨租户 SELECT 臂（平台触发重建专用；
 *      普通业务事务永不设置该键，租户臂语义不变）。零 UPDATE 授权。
 */
const CRAFT_SCHEDULE_SCOPES_RLS_STATEMENTS = [
  'REVOKE ALL PRIVILEGES ON TABLE "enterprise_craft_schedule_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "enterprise_craft_schedule_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "enterprise_craft_schedule_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "enterprise_craft_schedule_scope_data_tenant_read" ON "enterprise_craft_schedule_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_craft_schedule_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "enterprise_craft_schedule_scope_data_self_read" ON "enterprise_craft_schedule_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_craft_schedule_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_craft_schedule_scope_operator_read" ON "enterprise_craft_schedule_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"enterprise_craft_schedule_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_craft_schedule_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_craft_schedule_scope_operator_insert" ON "enterprise_craft_schedule_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"enterprise_craft_schedule_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_craft_schedule_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_craft_schedule_scope_operator_delete" ON "enterprise_craft_schedule_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"enterprise_craft_schedule_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_craft_schedule_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_craft_schedule_scope_operator_sweep_read" ON "enterprise_craft_schedule_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (current_setting('app.scan_sweep', true) = 'on');",
  'GRANT SELECT ON TABLE "enterprise_craft_schedule_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "enterprise_craft_schedule_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "enterprise_craft_schedule_scopes" TO ob_ent_operator;',
];

const CRAFT_SCHEDULE_SCOPES_TASK: TaskMigrationSpec = {
  id: "MT054",
  description:
    "MT054（Issue #97）：Craft 计划任务/子任务/应用连接归属——新增 enterprise_craft_schedule_scopes 协会表（表 + RLS 两步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "craft_schedule_scope_tables",
      impact:
        "新增 enterprise_craft_schedule_scopes 表：(kind, object_id) 复合主键（kind 三闭集 CHECK）；subtask ⇔ parent_object_id、connection ⇔ credential_ref 两结构 CHECK；复合外键钉到 enterprise_workspaces、enterprise_memberships 与 users（均 cascade）；范围列表与父引用索引。不修改任何既有表。",
      objects: ["enterprise_craft_schedule_scopes"],
      statements: [
        'CREATE TABLE "enterprise_craft_schedule_scopes" (\n' +
          '\t"kind" text NOT NULL,\n' +
          '\t"object_id" text NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"parent_object_id" text,\n' +
          '\t"credential_ref" text,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          "\tCONSTRAINT \"enterprise_craft_schedule_scopes_kind\" CHECK (\"enterprise_craft_schedule_scopes\".\"kind\" in ('scheduled_task','subtask','connection')),\n" +
          '\tCONSTRAINT "enterprise_craft_schedule_scopes_subtask_parent" CHECK (("enterprise_craft_schedule_scopes"."kind" = \'subtask\') = ("enterprise_craft_schedule_scopes"."parent_object_id" is not null)),\n' +
          '\tCONSTRAINT "enterprise_craft_schedule_scopes_connection_credential" CHECK (("enterprise_craft_schedule_scopes"."kind" = \'connection\') = ("enterprise_craft_schedule_scopes"."credential_ref" is not null)),\n' +
          '\tCONSTRAINT "enterprise_craft_schedule_scopes_parent_plain" CHECK ("enterprise_craft_schedule_scopes"."parent_object_id" is null or "enterprise_craft_schedule_scopes"."parent_object_id" <> \'\'),\n' +
          '\tCONSTRAINT "enterprise_craft_schedule_scopes_credential_plain" CHECK ("enterprise_craft_schedule_scopes"."credential_ref" is null or "enterprise_craft_schedule_scopes"."credential_ref" <> \'\'),\n' +
          '\tCONSTRAINT "enterprise_craft_schedule_scopes_kind_object_id" PRIMARY KEY ("kind","object_id")\n' +
          ");",
        'CREATE INDEX "enterprise_craft_schedule_scopes_scope_list_idx" ON "enterprise_craft_schedule_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","object_id");',
        'CREATE INDEX "enterprise_craft_schedule_scopes_parent_idx" ON "enterprise_craft_schedule_scopes" USING btree ("tenant_id","workspace_id","parent_object_id");',
        'ALTER TABLE "enterprise_craft_schedule_scopes" ADD CONSTRAINT "enterprise_craft_schedule_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_craft_schedule_scopes" ADD CONSTRAINT "enterprise_craft_schedule_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_craft_schedule_scopes" ADD CONSTRAINT "enterprise_craft_schedule_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "craft_schedule_scope_rls",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 主体自读；operator 租户+主体上下文读/插/删 + app.scan_sweep 扫描臂）及配套最小 GRANT；零 UPDATE 授权。不改动任何既有表策略或既有授权。目录角色无任何策略与授权。",
      objects: ["enterprise_craft_schedule_scopes"],
      statements: CRAFT_SCHEDULE_SCOPES_RLS_STATEMENTS,
    },
  ],
};

/**
 * MT055（Issue #98）：产物与对象存储路径按归属隔离。expand-only——一张
 * 新协会表与按既有模式的最小 RLS；不修改任何既有表/策略/角色授权。
 *
 *   1. enterprise_artifact_scopes：一行 = 一个 Workshop 产物行
 *      （workshop_artifacts）在一个 (公司, 团队, 主体) 三元组上的归属
 *      关联（Spec §4.2 逐字形状；MT053 enterprise_craft_scopes 同型
 *      判例）。artifact_id 主键 FK → workshop_artifacts(id) cascade；
 *      session_id 为关联事实列（无 FK——目标列非唯一；一致性由 pin 写
 *      入路径钉死）+ 索引；复合外键钉到 enterprise_workspaces、
 *      enterprise_memberships 与 users，均 cascade。
 *   2. RLS 沿 MT053 既有模式：REVOKE PUBLIC + 四能力角色 → ENABLE +
 *      FORCE → data 租户臂 + restrictive 主体自读 → operator 租户+主体
 *      上下文读/插/删 + workspace 读臂。零 UPDATE 授权。
 */
const ARTIFACT_SCOPES_RLS_STATEMENTS = [
  'REVOKE ALL PRIVILEGES ON TABLE "enterprise_artifact_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "enterprise_artifact_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "enterprise_artifact_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "enterprise_artifact_scope_data_tenant_read" ON "enterprise_artifact_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_artifact_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "enterprise_artifact_scope_data_self_read" ON "enterprise_artifact_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_artifact_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_artifact_scope_operator_workspace_read" ON "enterprise_artifact_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"enterprise_artifact_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_artifact_scopes\".\"workspace_id\" = nullif(current_setting('app.workspace_id', true), ''));",
  'CREATE POLICY "enterprise_artifact_scope_operator_read" ON "enterprise_artifact_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"enterprise_artifact_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_artifact_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_artifact_scope_operator_insert" ON "enterprise_artifact_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"enterprise_artifact_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_artifact_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_artifact_scope_operator_delete" ON "enterprise_artifact_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"enterprise_artifact_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_artifact_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'GRANT SELECT ON TABLE "enterprise_artifact_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "enterprise_artifact_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "enterprise_artifact_scopes" TO ob_ent_operator;',
];

const ARTIFACT_SCOPES_TASK: TaskMigrationSpec = {
  id: "MT055",
  description:
    "MT055（Issue #98）：产物与对象存储路径按归属隔离——新增 enterprise_artifact_scopes 协会表（表 + RLS 两步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "artifact_scope_tables",
      impact:
        "新增 enterprise_artifact_scopes 表：artifact_id 主键（FK → workshop_artifacts cascade）；session_id 关联事实列 + 索引；复合外键钉到 enterprise_workspaces、enterprise_memberships 与 users（均 cascade）；范围列表索引。不修改任何既有表。",
      objects: ["enterprise_artifact_scopes"],
      statements: [
        'CREATE TABLE "enterprise_artifact_scopes" (\n' +
          '\t"artifact_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"session_id" text NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL\n' +
          ");",
        'CREATE INDEX "enterprise_artifact_scopes_scope_list_idx" ON "enterprise_artifact_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","artifact_id");',
        'CREATE INDEX "enterprise_artifact_scopes_session_idx" ON "enterprise_artifact_scopes" USING btree ("session_id");',
        'ALTER TABLE "enterprise_artifact_scopes" ADD CONSTRAINT "enterprise_artifact_scopes_artifact_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."workshop_artifacts"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_artifact_scopes" ADD CONSTRAINT "enterprise_artifact_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_artifact_scopes" ADD CONSTRAINT "enterprise_artifact_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_artifact_scopes" ADD CONSTRAINT "enterprise_artifact_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "artifact_scope_rls",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 主体自读；operator 租户+主体上下文读/插/删 + workspace 读臂）及配套最小 GRANT；零 UPDATE 授权。不改动任何既有表策略或既有授权。目录角色无任何策略与授权。",
      objects: ["enterprise_artifact_scopes"],
      statements: ARTIFACT_SCOPES_RLS_STATEMENTS,
    },
  ],
};

/**
 * MT057（Issue #100）：Workshop 会话、执行、产物与沙箱实例关联的作用域。
 * expand-only——两张新表与按既有模式的最小 RLS；不修改任何既有表/策略/
 * 角色授权。
 *
 *   1. enterprise_workshop_scopes：一行 = 一个 Workshop 会话
 *      （workshop_sessions）在一个 (公司, 团队, 主体) 三元组上的归属
 *      关联（MT053 同型判例）。session_id 主键 FK → workshop_sessions
 *      (id) cascade；channel_id 关联事实列 + 索引；复合外键钉到
 *      enterprise_workspaces、enterprise_memberships 与 users，均
 *      cascade。
 *   2. enterprise_workshop_sandbox_bindings：一行 = 一个沙箱实例
 *      （sandbox_instances）到一个同范围会话的绑定。instance_id 主键
 *      FK → sandbox_instances(id) cascade；status 两态 CHECK（bound/
 *      recycled）+ recycled ⇔ recycled_at 结构 CHECK；operator 列级
 *      UPDATE 只有 (status, recycled_at, updated_at)（0178 列级 GRANT
 *      同纪律——生命周期可变，归属不可变）。
 */
const WORKSHOP_SCOPES_RLS_STATEMENTS = [
  'REVOKE ALL PRIVILEGES ON TABLE "enterprise_workshop_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "enterprise_workshop_scopes" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "enterprise_workshop_scopes" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "enterprise_workshop_scope_data_tenant_read" ON "enterprise_workshop_scopes"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_workshop_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_scope_data_self_read" ON "enterprise_workshop_scopes"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_workshop_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_scope_operator_workspace_read" ON "enterprise_workshop_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"enterprise_workshop_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_scopes\".\"workspace_id\" = nullif(current_setting('app.workspace_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_scope_operator_read" ON "enterprise_workshop_scopes"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"enterprise_workshop_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_scope_operator_insert" ON "enterprise_workshop_scopes"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"enterprise_workshop_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_scope_operator_delete" ON "enterprise_workshop_scopes"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"enterprise_workshop_scopes\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_scopes\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'GRANT SELECT ON TABLE "enterprise_workshop_scopes" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "enterprise_workshop_scopes" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "enterprise_workshop_scopes" TO ob_ent_operator;',
];

const WORKSHOP_SANDBOX_BINDINGS_RLS_STATEMENTS = [
  'REVOKE ALL PRIVILEGES ON TABLE "enterprise_workshop_sandbox_bindings" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "enterprise_workshop_sandbox_bindings" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "enterprise_workshop_sandbox_bindings" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "enterprise_workshop_sandbox_binding_data_tenant_read" ON "enterprise_workshop_sandbox_bindings"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_workshop_sandbox_bindings\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_sandbox_binding_data_self_read" ON "enterprise_workshop_sandbox_bindings"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_workshop_sandbox_bindings\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_sandbox_binding_operator_read" ON "enterprise_workshop_sandbox_bindings"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"enterprise_workshop_sandbox_bindings\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_sandbox_bindings\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_sandbox_binding_operator_insert" ON "enterprise_workshop_sandbox_bindings"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"enterprise_workshop_sandbox_bindings\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_sandbox_bindings\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_sandbox_binding_operator_delete" ON "enterprise_workshop_sandbox_bindings"\n' +
    "  FOR DELETE TO ob_ent_operator\n" +
    "  USING (\"enterprise_workshop_sandbox_bindings\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_sandbox_bindings\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'GRANT SELECT ON TABLE "enterprise_workshop_sandbox_bindings" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "enterprise_workshop_sandbox_bindings" TO ob_ent_operator;',
  'GRANT DELETE ON TABLE "enterprise_workshop_sandbox_bindings" TO ob_ent_operator;',
  'GRANT UPDATE ("status", "recycled_at", "updated_at") ON TABLE "enterprise_workshop_sandbox_bindings" TO ob_ent_operator;',
  'CREATE POLICY "enterprise_workshop_sandbox_binding_operator_update" ON "enterprise_workshop_sandbox_bindings"\n' +
    "  FOR UPDATE TO ob_ent_operator\n" +
    "  USING (\"enterprise_workshop_sandbox_bindings\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_sandbox_bindings\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''))\n" +
    "  WITH CHECK (\"enterprise_workshop_sandbox_bindings\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_sandbox_bindings\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
];

const WORKSHOP_SCOPES_TASK: TaskMigrationSpec = {
  id: "MT057",
  description:
    "MT057（Issue #100）：Workshop 会话/执行/产物/沙箱实例关联作用域——新增 enterprise_workshop_scopes 与 enterprise_workshop_sandbox_bindings 两协会表（表 + RLS 两步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "workshop_scope_tables",
      impact:
        "新增 enterprise_workshop_scopes 表：session_id 主键（FK → workshop_sessions cascade）；channel_id 关联事实列 + 索引；复合外键钉到 enterprise_workspaces、enterprise_memberships 与 users（均 cascade）；范围列表索引。不修改任何既有表。",
      objects: ["enterprise_workshop_scopes"],
      statements: [
        'CREATE TABLE "enterprise_workshop_scopes" (\n' +
          '\t"session_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"channel_id" text NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL\n' +
          ");",
        'CREATE INDEX "enterprise_workshop_scopes_scope_list_idx" ON "enterprise_workshop_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","session_id");',
        'CREATE INDEX "enterprise_workshop_scopes_channel_idx" ON "enterprise_workshop_scopes" USING btree ("channel_id");',
        'ALTER TABLE "enterprise_workshop_scopes" ADD CONSTRAINT "enterprise_workshop_scopes_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workshop_sessions"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workshop_scopes" ADD CONSTRAINT "enterprise_workshop_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workshop_scopes" ADD CONSTRAINT "enterprise_workshop_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workshop_scopes" ADD CONSTRAINT "enterprise_workshop_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "workshop_scope_rls",
      impact:
        "仅对 enterprise_workshop_scopes：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 主体自读；operator 租户+主体上下文读/插/删 + workspace 读臂）及配套最小 GRANT；零 UPDATE 授权。不改动任何既有表策略或既有授权。",
      objects: ["enterprise_workshop_scopes"],
      statements: WORKSHOP_SCOPES_RLS_STATEMENTS,
    },
    {
      slug: "workshop_sandbox_binding_tables",
      impact:
        "新增 enterprise_workshop_sandbox_bindings 表：instance_id 主键（FK → sandbox_instances cascade）；session_id FK → workshop_sessions cascade；status 两态 CHECK + recycled ⇔ recycled_at 结构 CHECK；复合外键钉到 enterprise_workspaces、enterprise_memberships 与 users（均 cascade）；范围与会话索引。不修改任何既有表。",
      objects: ["enterprise_workshop_sandbox_bindings"],
      statements: [
        'CREATE TABLE "enterprise_workshop_sandbox_bindings" (\n' +
          '\t"instance_id" text PRIMARY KEY NOT NULL,\n' +
          '\t"session_id" text NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"user_id" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'bound' NOT NULL,\n" +
          '\t"bound_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\t"recycled_at" timestamp with time zone,\n' +
          '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_workshop_sandbox_bindings_status_check" CHECK ("enterprise_workshop_sandbox_bindings"."status" in (\'bound\',\'recycled\')),\n' +
          '\tCONSTRAINT "enterprise_workshop_sandbox_bindings_recycled_check" CHECK ((("enterprise_workshop_sandbox_bindings"."status" = \'recycled\') = ("enterprise_workshop_sandbox_bindings"."recycled_at" is not null)))\n' +
          ");",
        'CREATE INDEX "enterprise_workshop_sandbox_bindings_scope_idx" ON "enterprise_workshop_sandbox_bindings" USING btree ("tenant_id","workspace_id","principal_id");',
        'CREATE INDEX "enterprise_workshop_sandbox_bindings_session_idx" ON "enterprise_workshop_sandbox_bindings" USING btree ("session_id");',
        'ALTER TABLE "enterprise_workshop_sandbox_bindings" ADD CONSTRAINT "enterprise_workshop_sandbox_bindings_instance_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."sandbox_instances"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workshop_sandbox_bindings" ADD CONSTRAINT "enterprise_workshop_sandbox_bindings_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workshop_sessions"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workshop_sandbox_bindings" ADD CONSTRAINT "enterprise_workshop_sandbox_bindings_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workshop_sandbox_bindings" ADD CONSTRAINT "enterprise_workshop_sandbox_bindings_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workshop_sandbox_bindings" ADD CONSTRAINT "enterprise_workshop_sandbox_bindings_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "workshop_sandbox_binding_rls",
      impact:
        "仅对 enterprise_workshop_sandbox_bindings：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 主体自读；operator 租户+主体上下文读/插/删）及配套最小 GRANT + 列级 UPDATE（status, recycled_at, updated_at——生命周期可变，归属不可变；0178 同纪律）。不改动任何既有表策略或既有授权。",
      objects: ["enterprise_workshop_sandbox_bindings"],
      statements: WORKSHOP_SANDBOX_BINDINGS_RLS_STATEMENTS,
    },
  ],
};

/**
 * MT058（Issue #101）：分享令牌改为有效分享授权。expand-only——一张新表
 * 与按既有模式的最小 RLS；不修改任何既有表/策略/角色授权。
 *
 *   1. enterprise_workshop_share_grants：一行 = 一次有效分享授权
 *      （受众/动作域/有效期/撤销都是行本体）。token_hash UNIQUE（sha256
 *      承载段，B14 纪律）；受众两态 CHECK + cross-team ⇔ audience_
 *      workspace_id 结构 CHECK；复合外键 (tenant_id, audience_workspace_
 *      id) → enterprise_workspaces 把跨公司受众行结构性排除（MT010 同
 *      纪律）；一会话至多一条活链（partial unique index，revoked_at
 *      IS NULL）。
 *   2. RLS：data 租户臂 + restrictive 签发者自读；operator 租户臂读
 *      （解析入口）+ 插入 + 列级 UPDATE (revoked_at, revoked_by)——撤销
 *      不是删除（可审计），归属列零 UPDATE。
 */
const SHARE_GRANTS_RLS_STATEMENTS = [
  'REVOKE ALL PRIVILEGES ON TABLE "enterprise_workshop_share_grants" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
  'ALTER TABLE "enterprise_workshop_share_grants" ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE "enterprise_workshop_share_grants" FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "enterprise_workshop_share_grant_data_tenant_read" ON "enterprise_workshop_share_grants"\n' +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_workshop_share_grants\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_share_grant_data_self_read" ON "enterprise_workshop_share_grants"\n' +
    "  AS RESTRICTIVE\n" +
    "  FOR SELECT TO ob_ent_data\n" +
    "  USING (\"enterprise_workshop_share_grants\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_share_grant_operator_read" ON "enterprise_workshop_share_grants"\n' +
    "  FOR SELECT TO ob_ent_operator\n" +
    "  USING (\"enterprise_workshop_share_grants\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
  'CREATE POLICY "enterprise_workshop_share_grant_operator_insert" ON "enterprise_workshop_share_grants"\n' +
    "  FOR INSERT TO ob_ent_operator\n" +
    "  WITH CHECK (\"enterprise_workshop_share_grants\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_share_grants\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
  'GRANT SELECT ON TABLE "enterprise_workshop_share_grants" TO ob_ent_data, ob_ent_operator;',
  'GRANT INSERT ON TABLE "enterprise_workshop_share_grants" TO ob_ent_operator;',
  'GRANT UPDATE ("revoked_at", "revoked_by") ON TABLE "enterprise_workshop_share_grants" TO ob_ent_operator;',
  'CREATE POLICY "enterprise_workshop_share_grant_operator_update" ON "enterprise_workshop_share_grants"\n' +
    "  FOR UPDATE TO ob_ent_operator\n" +
    "  USING (\"enterprise_workshop_share_grants\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_share_grants\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''))\n" +
    "  WITH CHECK (\"enterprise_workshop_share_grants\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
    "    AND \"enterprise_workshop_share_grants\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
];

const SHARE_GRANTS_TASK: TaskMigrationSpec = {
  id: "MT058",
  description:
    "MT058（Issue #101）：分享令牌改为有效分享授权——新增 enterprise_workshop_share_grants 表（表 + RLS 两步，expand-only，不改既有对象）。",
  steps: [
    {
      slug: "share_grant_tables",
      impact:
        "新增 enterprise_workshop_share_grants 表：id 主键；session_id FK → workshop_sessions cascade；token_hash UNIQUE；受众两态 CHECK + cross-team ⇔ 受众团队列结构 CHECK + 动作域两态 CHECK；复合外键钉 (tenant, owner workspace)、(tenant, audience workspace)（跨公司受众行结构性排除）与 (tenant, principal)；一会话至多一条活链 partial unique index。不修改任何既有表。",
      objects: ["enterprise_workshop_share_grants"],
      statements: [
        'CREATE TABLE "enterprise_workshop_share_grants" (\n' +
          '\t"id" text PRIMARY KEY NOT NULL,\n' +
          '\t"session_id" text NOT NULL,\n' +
          '\t"token_hash" text NOT NULL,\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"owner_workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          '\t"audience" text NOT NULL,\n' +
          '\t"audience_workspace_id" text,\n' +
          '\t"share_action" text NOT NULL,\n' +
          '\t"expires_at" timestamp with time zone,\n' +
          '\t"revoked_at" timestamp with time zone,\n' +
          '\t"revoked_by" text,\n' +
          '\t"created_by" text NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_workshop_share_grants_audience_check" CHECK ("enterprise_workshop_share_grants"."audience" in (\'same-team\',\'cross-team\')),\n' +
          '\tCONSTRAINT "enterprise_workshop_share_grants_share_action_check" CHECK ("enterprise_workshop_share_grants"."share_action" in (\'preview\',\'preview_download\')),\n' +
          '\tCONSTRAINT "enterprise_workshop_share_grants_audience_workspace_check" CHECK ((("enterprise_workshop_share_grants"."audience" = \'cross-team\') = ("enterprise_workshop_share_grants"."audience_workspace_id" is not null)))\n' +
          ");",
        'CREATE UNIQUE INDEX "enterprise_workshop_share_grants_live_session_idx" ON "enterprise_workshop_share_grants" USING btree ("session_id") WHERE ("revoked_at" IS NULL);',
        'CREATE UNIQUE INDEX "enterprise_workshop_share_grants_token_idx" ON "enterprise_workshop_share_grants" USING btree ("token_hash");',
        'CREATE INDEX "enterprise_workshop_share_grants_session_idx" ON "enterprise_workshop_share_grants" USING btree ("session_id");',
        'ALTER TABLE "enterprise_workshop_share_grants" ADD CONSTRAINT "enterprise_workshop_share_grants_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workshop_sessions"("id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workshop_share_grants" ADD CONSTRAINT "enterprise_workshop_share_grants_owner_workspace_fk" FOREIGN KEY ("tenant_id","owner_workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workshop_share_grants" ADD CONSTRAINT "enterprise_workshop_share_grants_audience_workspace_fk" FOREIGN KEY ("tenant_id","audience_workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workshop_share_grants" ADD CONSTRAINT "enterprise_workshop_share_grants_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workshop_share_grants" ADD CONSTRAINT "enterprise_workshop_share_grants_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      ],
    },
    {
      slug: "share_grant_rls",
      impact:
        "仅对新表：REVOKE PUBLIC、启用并 FORCE RLS、按既有模式新增最小策略（data 租户范围 SELECT + restrictive 签发者自读；operator 租户臂读 + 租户+主体上下文插）及配套最小 GRANT + 列级 UPDATE (revoked_at, revoked_by)——撤销不是删除，归属列零 UPDATE。不改动任何既有表策略或既有授权。目录角色无任何策略与授权。",
      objects: ["enterprise_workshop_share_grants"],
      statements: SHARE_GRANTS_RLS_STATEMENTS,
    },
  ],
};

export const TASKS: ReadonlyMap<string, TaskMigrationSpec> = new Map([
  [SELF_CHECK_TASK.id, SELF_CHECK_TASK],
  [WORKSPACE_MEMBERSHIP_TASK.id, WORKSPACE_MEMBERSHIP_TASK],
  [LEGACY_ANCHOR_TASK.id, LEGACY_ANCHOR_TASK],
  [CHILD_BACKFILL_PROGRESS_TASK.id, CHILD_BACKFILL_PROGRESS_TASK],
  [RESOURCE_VISIBILITY_TASK.id, RESOURCE_VISIBILITY_TASK],
  [CORE_RLS_TASK.id, CORE_RLS_TASK],
  [RESOURCE_DEPENDENCY_TASK.id, RESOURCE_DEPENDENCY_TASK],
  [PERSONAL_SHARE_TASK.id, PERSONAL_SHARE_TASK],
  [RUNTIME_CONFIG_TASK.id, RUNTIME_CONFIG_TASK],
  [GOVERNANCE_POLICY_TASK.id, GOVERNANCE_POLICY_TASK],
  [SSO_SCIM_ISOLATION_TASK.id, SSO_SCIM_ISOLATION_TASK],
  [PEOPLE_LIFECYCLE_TASK.id, PEOPLE_LIFECYCLE_TASK],
  [PAYER_ACCOUNT_TASK.id, PAYER_ACCOUNT_TASK],
  [BOT_OWNERSHIP_TASK.id, BOT_OWNERSHIP_TASK],
  [JOB_OWNERSHIP_TASK.id, JOB_OWNERSHIP_TASK],
  [CREDENTIAL_OWNERSHIP_TASK.id, CREDENTIAL_OWNERSHIP_TASK],
  [OAUTH_STATE_TASK.id, OAUTH_STATE_TASK],
  [COMPANY_CALL_ATTRIBUTION_TASK.id, COMPANY_CALL_ATTRIBUTION_TASK],
  [PLUGIN_CATALOG_TASK.id, PLUGIN_CATALOG_TASK],
  [PACKAGE_INSTALL_TASK.id, PACKAGE_INSTALL_TASK],
  [PACKAGE_GRANT_TASK.id, PACKAGE_GRANT_TASK],
  [PACKAGE_EXPERT_TASK.id, PACKAGE_EXPERT_TASK],
  [PACKAGE_DISPATCH_TASK.id, PACKAGE_DISPATCH_TASK],
  [PACKAGE_LIFECYCLE_TASK.id, PACKAGE_LIFECYCLE_TASK],
  [PACKAGE_DISPATCH_LEASE_TASK.id, PACKAGE_DISPATCH_LEASE_TASK],
  [SCAN_SCOPE_REBUILD_TASK.id, SCAN_SCOPE_REBUILD_TASK],
  [PERSONAL_BOT_TASK.id, PERSONAL_BOT_TASK],
  [CREDENTIAL_LEASE_TASK.id, CREDENTIAL_LEASE_TASK],
  [COMPANY_FINANCE_GRANT_TASK.id, COMPANY_FINANCE_GRANT_TASK],
  [OPENMUSE_TASK_TENANCY_TASK.id, OPENMUSE_TASK_TENANCY_TASK],
  [OPENMUSE_FILE_TENANCY_TASK.id, OPENMUSE_FILE_TENANCY_TASK],
  [OPENMUSE_PERSONAL_TENANCY_TASK.id, OPENMUSE_PERSONAL_TENANCY_TASK],
  [
    OPENMUSE_REVIEWED_ACTION_TENANCY_TASK.id,
    OPENMUSE_REVIEWED_ACTION_TENANCY_TASK,
  ],
  [OPENMUSE_ACTIVITY_TENANCY_TASK.id, OPENMUSE_ACTIVITY_TENANCY_TASK],
  [OPENMUSE_VOICE_MOBILE_TENANCY_TASK.id, OPENMUSE_VOICE_MOBILE_TENANCY_TASK],
  [QUARANTINE_LIST_TASK.id, QUARANTINE_LIST_TASK],
  [SHARED_APPROVAL_TASK.id, SHARED_APPROVAL_TASK],
  [DELETION_SEMANTICS_TASK.id, DELETION_SEMANTICS_TASK],
  [HOST_ACCESS_TASK.id, HOST_ACCESS_TASK],
  [PERSONAL_MEMORY_TASK.id, PERSONAL_MEMORY_TASK],
  [LEARNING_DEMONSTRATION_TASK.id, LEARNING_DEMONSTRATION_TASK],
  [PURGE_RESTORE_TASK.id, PURGE_RESTORE_TASK],
  [VENDOR_BILLING_INTERACTION_TASK.id, VENDOR_BILLING_INTERACTION_TASK],
  [AUDIT_DOMAIN_TASK.id, AUDIT_DOMAIN_TASK],
  [CRAFT_SESSION_SCOPES_TASK.id, CRAFT_SESSION_SCOPES_TASK],
  [CRAFT_SCHEDULE_SCOPES_TASK.id, CRAFT_SCHEDULE_SCOPES_TASK],
  [ARTIFACT_SCOPES_TASK.id, ARTIFACT_SCOPES_TASK],
  [WORKSHOP_SCOPES_TASK.id, WORKSHOP_SCOPES_TASK],
  [SHARE_GRANTS_TASK.id, SHARE_GRANTS_TASK],
]);

export const ALLOWED_TASK_IDS: readonly string[] = [...TASKS.keys()].sort();

// ---------------------------------------------------------------------------
// 计划：确定性文件名、编号与 digest
// ---------------------------------------------------------------------------

export const MANIFEST_SCHEMA_VERSION = 1;
const TOOL_NAME = "multitenancy-migrate-test";

export interface PlannedStep {
  /** 1 起严格递增的任务内编号。 */
  readonly number: number;
  /** 确定性文件名：NNNN_<taskid小写>_<slug>.sql。 */
  readonly name: string;
  readonly slug: string;
  readonly impact: string;
  readonly objects: readonly string[];
  readonly statements: readonly string[];
  /** 语句数组的 SHA-256（十六进制），manifest 逐步骤核对。 */
  readonly statementDigest: string;
}

export interface MigrationPlan {
  readonly taskId: string;
  readonly description: string;
  readonly steps: readonly PlannedStep[];
  /** 全部步骤（编号/名称/语句 digest）的 SHA-256，apply 门禁核对。 */
  readonly planDigest: string;
}

export interface MigrationManifestStep {
  readonly number: number;
  readonly name: string;
  readonly statementDigest: string;
  readonly statementCount: number;
}

export interface MigrationManifest {
  readonly schemaVersion: number;
  readonly tool: string;
  readonly taskId: string;
  readonly planDigest: string;
  readonly steps: readonly MigrationManifestStep[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function stepFileName(
  taskId: string,
  number: number,
  slug: string,
): string {
  return `${String(number).padStart(4, "0")}_${taskId.toLowerCase()}_${slug}.sql`;
}

export function buildPlan(taskId: string): MigrationPlan {
  const spec = TASKS.get(taskId);
  if (!spec) {
    throw new Error(
      `unknown task id "${taskId}"; allowed task ids: ${ALLOWED_TASK_IDS.join(", ")}`,
    );
  }
  const steps: PlannedStep[] = spec.steps.map((step, index) => ({
    number: index + 1,
    name: stepFileName(taskId, index + 1, step.slug),
    slug: step.slug,
    impact: step.impact,
    objects: step.objects,
    statements: step.statements,
    statementDigest: sha256(JSON.stringify(step.statements)),
  }));
  const planDigest = sha256(
    JSON.stringify({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      tool: TOOL_NAME,
      taskId,
      steps: steps.map((step) => ({
        number: step.number,
        name: step.name,
        statementDigest: step.statementDigest,
      })),
    }),
  );
  return { taskId, description: spec.description, steps, planDigest };
}

export function manifestFor(plan: MigrationPlan): MigrationManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: TOOL_NAME,
    taskId: plan.taskId,
    planDigest: plan.planDigest,
    steps: plan.steps.map((step) => ({
      number: step.number,
      name: step.name,
      statementDigest: step.statementDigest,
      statementCount: step.statements.length,
    })),
  };
}

// ---------------------------------------------------------------------------
// 编号校验：计划、journal、已生成文件共用同一套规则
// ---------------------------------------------------------------------------

export type NumberingVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 计划内编号必须从 1 起严格递增、连续且文件名唯一：重复编号、断号、
 * 名称重复都是注册表编写错误，必须在任何执行前拒绝。
 */
export function validatePlanNumbering(
  steps: ReadonlyArray<{ number: number; name: string }>,
): NumberingVerdict {
  if (steps.length === 0) {
    return { ok: false, reason: "migration plan has no steps" };
  }
  const seenNames = new Set<string>();
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.number !== index + 1) {
      return {
        ok: false,
        reason:
          step.number <= index
            ? `duplicate or non-increasing migration number ${step.number} at position ${index + 1}`
            : `migration number gap: expected ${index + 1}, found ${step.number}`,
      };
    }
    if (seenNames.has(step.name)) {
      return { ok: false, reason: `duplicate migration name "${step.name}"` };
    }
    seenNames.add(step.name);
  }
  return { ok: true };
}

export type JournalVerdict =
  | { ok: true; appliedCount: number }
  | { ok: false; reason: string };

/**
 * journal 中已应用的编号必须是计划 (1..totalSteps) 的连续前缀：
 * 重复、断号、超出计划长度（计划/journal 漂移）都拒绝执行。
 */
export function validateJournalNumbers(
  appliedNumbers: readonly number[],
  totalSteps: number,
): JournalVerdict {
  const sorted = [...appliedNumbers].sort((left, right) => left - right);
  for (let index = 0; index < sorted.length; index += 1) {
    const number = sorted[index];
    if (number !== index + 1) {
      return {
        ok: false,
        reason:
          number <= index
            ? `journal has duplicate migration number ${number}`
            : `journal migration numbers have a gap: expected ${index + 1}, found ${number}`,
      };
    }
  }
  if (sorted.length > totalSteps) {
    return {
      ok: false,
      reason: `journal records ${sorted.length} applied steps but the plan only has ${totalSteps}; the plan and journal have drifted apart`,
    };
  }
  return { ok: true, appliedCount: sorted.length };
}

export interface JournalEntry {
  readonly number: number;
  readonly statementDigest: string;
}

export type JournalPlanVerdict =
  | { ok: true; appliedCount: number }
  | { ok: false; reason: string };

/**
 * journal 已应用步骤必须与当前计划逐步骤一致：编号是计划前缀（沿用
 * validateJournalNumbers），且每个已记录的 statement_digest 与当前计划
 * 完全一致。任何漂移都拒绝并要求人工审查；工具绝不改写或重放已入账
 * 步骤（不自动修复）。
 */
export function validateJournalAgainstPlan(
  entries: readonly JournalEntry[],
  plan: MigrationPlan,
): JournalPlanVerdict {
  const numbering = validateJournalNumbers(
    entries.map((entry) => entry.number),
    plan.steps.length,
  );
  if (!numbering.ok) {
    return numbering;
  }
  for (const entry of entries) {
    const step = plan.steps[entry.number - 1];
    if (entry.statementDigest !== step.statementDigest) {
      return {
        ok: false,
        reason:
          `journal records ${step.name} with statement digest ${entry.statementDigest.slice(0, 12)}… ` +
          `but the current plan digest is ${step.statementDigest.slice(0, 12)}…; ` +
          "the journal and the current plan have drifted apart — manual review is required; " +
          "the tool never rewrites or replays already-journaled steps",
      };
    }
  }
  return numbering;
}

// ---------------------------------------------------------------------------
// 数据库配置：只读 TEST_DATABASE_URL，生产/缺失/非法一律拒绝
// ---------------------------------------------------------------------------

export interface DatabaseTarget {
  readonly url: string;
  readonly databaseName: string;
  readonly endpoint: string;
}

export type ResolvedDatabase =
  | { ok: true; target: DatabaseTarget }
  | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * 只接受显式的测试库配置：仅读取 TEST_DATABASE_URL（复用
 * runtime-test-environment 的解析 seam），再叠加回环主机与
 * openbot_enterprise_* 命名约束。绝不读取 DATABASE_URL、绝不加载 .env、
 * 绝无隐式回退。任何拒绝都发生在连接之前。
 */
export function resolveTestDatabaseTarget(
  environment: Record<string, string | undefined>,
): ResolvedDatabase {
  const raw = environment.TEST_DATABASE_URL?.trim();
  if (!raw) {
    return {
      ok: false,
      reason:
        "TEST_DATABASE_URL is required and must name the dedicated test database; " +
        "this tool never falls back to DATABASE_URL and never loads .env",
    };
  }
  let databaseUrl: string;
  let databaseName: string;
  try {
    ({ databaseUrl, databaseName } = runtimeTestEnvironment(environment));
  } catch (error) {
    return {
      ok: false,
      reason: `TEST_DATABASE_URL: ${(error as Error).message}`,
    };
  }
  const url = new URL(databaseUrl);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      reason:
        `TEST_DATABASE_URL must point at a loopback test database; host "${url.hostname}" ` +
        "looks like a production or remote target and is refused",
    };
  }
  if (url.hash) {
    return {
      ok: false,
      reason: "TEST_DATABASE_URL must not include a URL fragment",
    };
  }
  if (databaseName.includes("/")) {
    return {
      ok: false,
      reason:
        "TEST_DATABASE_URL must name the database as a single path segment",
    };
  }
  if (!/^openbot_enterprise_/.test(databaseName)) {
    return {
      ok: false,
      reason:
        `TEST_DATABASE_URL must name an openbot_enterprise_* test database, got "${databaseName}"; ` +
        "application or production databases are never migration-tool targets",
    };
  }
  return {
    ok: true,
    target: {
      url: raw,
      databaseName,
      endpoint: `${url.hostname}:${url.port || "5432"}`,
    },
  };
}

// ---------------------------------------------------------------------------
// 参数面：generate/migrate 之外的命令、旗标与未知 task id 一律拒绝
// ---------------------------------------------------------------------------

export type MigrationCommand = "generate" | "migrate";

export interface ParsedArgs {
  readonly command: MigrationCommand;
  readonly taskId: string;
  readonly outDir?: string;
  readonly apply: boolean;
  readonly manifestPath?: string;
}

const USAGE =
  "usage: migrate-test.ts <generate|migrate> <taskId> " +
  "[--out DIR (generate)] | [--apply --manifest FILE (migrate)]";

export function parseArgs(
  argv: readonly string[],
): { ok: true; args: ParsedArgs } | { ok: false; reason: string } {
  const positional: string[] = [];
  let outDir: string | undefined;
  let apply = false;
  let manifestPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--out") {
      outDir = argv[index + 1];
      index += 1;
      if (!outDir || outDir.startsWith("--")) {
        return {
          ok: false,
          reason: `--out requires a directory path\n${USAGE}`,
        };
      }
    } else if (token === "--manifest") {
      manifestPath = argv[index + 1];
      index += 1;
      if (!manifestPath || manifestPath.startsWith("--")) {
        return {
          ok: false,
          reason: `--manifest requires a file path\n${USAGE}`,
        };
      }
    } else if (token === "--apply") {
      apply = true;
    } else if (token.startsWith("--")) {
      return {
        ok: false,
        reason: `unknown flag "${token}"\n${USAGE}`,
      };
    } else {
      positional.push(token);
    }
  }
  if (positional.length < 2) {
    return {
      ok: false,
      reason: `a command and a task id are required\n${USAGE}`,
    };
  }
  if (positional.length > 2) {
    return {
      ok: false,
      reason: `unexpected extra argument "${positional[2]}"\n${USAGE}`,
    };
  }
  const [command, taskId] = positional;
  if (command !== "generate" && command !== "migrate") {
    return {
      ok: false,
      reason: `unknown command "${command}"; only generate and migrate are accepted\n${USAGE}`,
    };
  }
  if (!TASKS.has(taskId)) {
    return {
      ok: false,
      reason: `unknown task id "${taskId}"; allowed task ids: ${ALLOWED_TASK_IDS.join(", ")}`,
    };
  }
  if (command === "generate") {
    if (apply || manifestPath) {
      return {
        ok: false,
        reason: `generate does not accept --apply or --manifest (those gate migrate)\n${USAGE}`,
      };
    }
    return { ok: true, args: { command, taskId, outDir, apply: false } };
  }
  if (outDir) {
    return {
      ok: false,
      reason: `migrate does not accept --out (that is a generate flag)\n${USAGE}`,
    };
  }
  if (apply && !manifestPath) {
    return {
      ok: false,
      reason:
        "--apply requires an explicit --manifest FILE that matches the current plan; " +
        "without --apply the command stays a dry-run",
    };
  }
  if (manifestPath && !apply) {
    return {
      ok: false,
      reason:
        "--manifest requires --apply; without --apply the command stays a dry-run " +
        "and a provided manifest would be silently ignored, so it is refused instead",
    };
  }
  return { ok: true, args: { command, taskId, apply, manifestPath } };
}

// ---------------------------------------------------------------------------
// 运行入口与结果
// ---------------------------------------------------------------------------

export type RefusalStage =
  | "args"
  | "database-config"
  | "numbering"
  | "manifest"
  | "journal"
  | "execution";

export type RunOutcome =
  | { kind: "refused"; stage: RefusalStage; reason: string }
  | {
      kind: "generated";
      taskId: string;
      outDir: string | null;
      written: readonly string[];
      verified: readonly string[];
      manifest: MigrationManifest;
    }
  | {
      kind: "dry-run";
      taskId: string;
      databaseName: string;
      endpoint: string;
      appliedCount: number;
      pending: readonly PlannedStep[];
      manifest: MigrationManifest;
    }
  | {
      kind: "applied";
      taskId: string;
      databaseName: string;
      endpoint: string;
      appliedSteps: readonly PlannedStep[];
    }
  | {
      kind: "up-to-date";
      taskId: string;
      databaseName: string;
      endpoint: string;
      appliedCount: number;
    };

export interface MigrationSql {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  begin<T>(work: (tx: MigrationSql) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export interface ToolFileSystem {
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface MigrateTestDeps {
  readonly environment?: Record<string, string | undefined>;
  readonly connect?: (url: string) => MigrationSql;
  readonly fs?: ToolFileSystem;
  readonly out?: (line: string) => void;
}

const defaultFileSystem: ToolFileSystem = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, content) => writeFile(path, content, "utf8"),
};

const defaultConnect = (url: string): MigrationSql =>
  postgres(url, { max: 1, onnotice: () => {} }) as unknown as MigrationSql;

/**
 * 工具入口：所有拒绝都发生在任何 connect / 文件写副作用之前。
 * 参数与环境校验先行，随后才进入命令分发。
 */
export async function runMigrateTest(
  argv: readonly string[],
  deps: MigrateTestDeps = {},
): Promise<RunOutcome> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return { kind: "refused", stage: "args", reason: parsed.reason };
  }
  const args = parsed.args;
  const resolved = resolveTestDatabaseTarget(deps.environment ?? process.env);
  if (!resolved.ok) {
    return {
      kind: "refused",
      stage: "database-config",
      reason: resolved.reason,
    };
  }
  const target = resolved.target;
  const plan = buildPlan(args.taskId);
  const numbering = validatePlanNumbering(plan.steps);
  if (!numbering.ok) {
    return { kind: "refused", stage: "numbering", reason: numbering.reason };
  }
  if (args.command === "generate") {
    return runGenerate(args, plan, target, deps);
  }
  return runMigrate(args, plan, target, deps);
}

// ---------------------------------------------------------------------------
// 人类可读输出（语句与影响摘要）
// ---------------------------------------------------------------------------

export function renderOutcome(outcome: RunOutcome): string[] {
  if (outcome.kind === "refused") {
    return [`refused (${outcome.stage}): ${outcome.reason}`];
  }
  if (outcome.kind === "generated") {
    const lines = [
      `generated: ${outcome.taskId} → ${outcome.outDir ?? "(stdout)"}`,
    ];
    if (outcome.outDir) {
      for (const file of outcome.written) lines.push(`  wrote ${file}`);
      for (const file of outcome.verified) lines.push(`  verified ${file}`);
    } else {
      for (const file of outcome.verified) lines.push(`  计划文件: ${file}`);
    }
    lines.push("manifest:", JSON.stringify(outcome.manifest));
    return lines;
  }
  if (outcome.kind === "dry-run") {
    const plan = buildPlan(outcome.taskId);
    const lines = [
      "multitenancy migrate-test — dry-run（默认；执行需 --apply --manifest <file>）",
      `task: ${outcome.taskId} — ${plan.description}`,
      `database: ${outcome.databaseName} @ ${outcome.endpoint}`,
      `journal: 已应用 ${outcome.appliedCount}/${plan.steps.length}；待应用 ${outcome.pending.length} 步`,
    ];
    let statements = 0;
    const objects = new Set<string>();
    for (const step of outcome.pending) {
      lines.push(`step ${step.name} — 影响: ${step.impact}`);
      for (const object of step.objects) objects.add(object);
      step.statements.forEach((statement, index) => {
        statements += 1;
        lines.push(`  语句 ${index + 1}: ${statement}`);
      });
    }
    lines.push(
      `summary: 待应用 ${outcome.pending.length} 步 / ${statements} 条语句 / 涉及对象: ${[...objects].join(", ") || "无"}`,
      "manifest:",
      JSON.stringify(outcome.manifest),
    );
    return lines;
  }
  if (outcome.kind === "applied") {
    return [
      `applied: ${outcome.taskId} @ ${outcome.databaseName} (${outcome.endpoint})`,
      `  已执行并记入 journal: ${outcome.appliedSteps
        .map((step) => step.name)
        .join(", ")}`,
    ];
  }
  return [
    `up-to-date: ${outcome.taskId} @ ${outcome.databaseName} (${outcome.endpoint})`,
    `  已应用 ${outcome.appliedCount} 步，无需执行`,
  ];
}

// ---------------------------------------------------------------------------
// journal（工具自有表）与执行
// ---------------------------------------------------------------------------

const JOURNAL_TABLE = "mt_task_migration_journal";

const JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
  task_id text NOT NULL,
  number integer NOT NULL,
  name text NOT NULL,
  statement_digest text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, number)
)`;

/** journal 缺表 = 尚未应用过任何步骤；其它错误照常抛出。 */
async function readJournalEntries(
  connection: MigrationSql,
  taskId: string,
): Promise<JournalEntry[]> {
  let rows: Array<{ number: number; statement_digest: string }>;
  try {
    rows = (await connection.unsafe(
      `SELECT number, statement_digest FROM ${JOURNAL_TABLE} WHERE task_id = $1 ORDER BY number`,
      [taskId],
    )) as Array<{ number: number; statement_digest: string }>;
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") {
      return [];
    }
    throw error;
  }
  return rows.map((row) => ({
    number: Number(row.number),
    statementDigest: String(row.statement_digest),
  }));
}

/** journal 写入用字面量（值全部来自工具自身，不携带用户输入）。 */
function sqlLiteral(value: string | number): string {
  return typeof value === "number"
    ? String(value)
    : `'${value.replaceAll("'", "''")}'`;
}

// ---------------------------------------------------------------------------
// manifest 解析与门禁
// ---------------------------------------------------------------------------

export type ManifestVerdict =
  | { ok: true; manifest: MigrationManifest }
  | { ok: false; reason: string };

export function parseManifestText(text: string): ManifestVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "manifest file is not valid JSON" };
  }
  const candidate = parsed as Partial<MigrationManifest>;
  if (
    candidate.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    candidate.tool !== TOOL_NAME ||
    typeof candidate.taskId !== "string" ||
    typeof candidate.planDigest !== "string" ||
    !Array.isArray(candidate.steps) ||
    candidate.steps.some(
      (step) =>
        typeof step?.number !== "number" ||
        typeof step?.name !== "string" ||
        typeof step?.statementDigest !== "string" ||
        typeof step?.statementCount !== "number",
    )
  ) {
    return {
      ok: false,
      reason: `manifest does not match schema version ${MANIFEST_SCHEMA_VERSION} of ${TOOL_NAME}`,
    };
  }
  return { ok: true, manifest: candidate as MigrationManifest };
}

export function validateManifestAgainstPlan(
  manifest: MigrationManifest,
  plan: MigrationPlan,
): { ok: true } | { ok: false; reason: string } {
  if (manifest.taskId !== plan.taskId) {
    return {
      ok: false,
      reason: `manifest task id "${manifest.taskId}" does not match the requested task "${plan.taskId}"`,
    };
  }
  if (manifest.planDigest !== plan.planDigest) {
    return {
      ok: false,
      reason:
        `manifest plan digest ${manifest.planDigest.slice(0, 12)}… does not match ` +
        `the current plan ${plan.planDigest.slice(0, 12)}…; regenerate the manifest and review the change`,
    };
  }
  if (manifest.steps.length !== plan.steps.length) {
    return {
      ok: false,
      reason: `manifest lists ${manifest.steps.length} steps but the plan has ${plan.steps.length}`,
    };
  }
  for (let index = 0; index < plan.steps.length; index += 1) {
    const expected = plan.steps[index];
    const actual = manifest.steps[index];
    if (
      actual.number !== expected.number ||
      actual.name !== expected.name ||
      actual.statementDigest !== expected.statementDigest
    ) {
      return {
        ok: false,
        reason: `manifest step ${index + 1} does not match plan step ${expected.name}`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

function defaultOut(line: string): void {
  console.log(line);
}

// generate：确定性文件物化（断号/重复/漂移在写入前拒绝）

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

function stepFileContent(step: PlannedStep): string {
  return `-- multitenancy migrate-test\n${step.statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`;
}

async function runGenerate(
  args: ParsedArgs,
  plan: MigrationPlan,
  target: DatabaseTarget,
  deps: MigrateTestDeps,
): Promise<RunOutcome> {
  void target; // 生成不连接数据库；target 仅证明配置已通过校验
  const fs = deps.fs ?? defaultFileSystem;
  const out = deps.out ?? defaultOut;
  const manifest = manifestFor(plan);

  if (!args.outDir) {
    const printed = {
      kind: "generated" as const,
      taskId: plan.taskId,
      outDir: null,
      written: [],
      verified: plan.steps.map((step) => step.name),
      manifest,
    };
    for (const line of renderOutcome(printed)) out(line);
    return printed;
  }

  const taskDir = join(args.outDir, plan.taskId);
  const taskFilePattern = new RegExp(
    `^(\\d{4})_${plan.taskId.toLowerCase()}_.*\\.sql$`,
  );
  let entries: string[] = [];
  try {
    entries = await fs.readdir(taskDir);
  } catch {
    entries = [];
  }
  const existing = entries
    .flatMap((name) => {
      const match = taskFilePattern.exec(name);
      return match ? [{ name, number: Number(match[1]) }] : [];
    })
    .sort((left, right) => left.number - right.number);

  const refuseNumbering = (reason: string): RunOutcome => ({
    kind: "refused",
    stage: "numbering",
    reason: `existing files in ${taskDir}: ${reason}`,
  });

  // 重复编号 / 断号 / 超出计划长度。
  for (let index = 0; index < existing.length; index += 1) {
    const file = existing[index];
    if (file.number !== index + 1) {
      return refuseNumbering(
        file.number <= index
          ? `duplicate migration number ${file.number}`
          : `migration number gap: expected ${String(index + 1).padStart(4, "0")}, found ${String(file.number).padStart(4, "0")}`,
      );
    }
  }
  if (existing.length > plan.steps.length) {
    return refuseNumbering(
      `found ${existing.length} numbered files but the plan only has ${plan.steps.length} steps; the directory and the plan have drifted apart`,
    );
  }

  // 已存在文件必须与计划逐字一致（名称与内容），否则拒绝且不改写。
  const verified: string[] = [];
  for (const file of existing) {
    const step = plan.steps[file.number - 1];
    if (file.name !== step.name) {
      return refuseNumbering(
        `file "${file.name}" does not match plan name "${step.name}" for number ${file.number}`,
      );
    }
    let content: string;
    try {
      content = await fs.readFile(join(taskDir, file.name));
    } catch (error) {
      return refuseNumbering(
        `file "${file.name}" could not be read: ${(error as Error).message}`,
      );
    }
    if (content !== stepFileContent(step)) {
      return refuseNumbering(
        `file "${file.name}" differs from the current plan; review the drift instead of overwriting it`,
      );
    }
    verified.push(file.name);
  }

  await fs.mkdir(taskDir);
  const written: string[] = [];
  for (const step of plan.steps) {
    if (verified.includes(step.name)) continue;
    const path = join(taskDir, step.name);
    await fs.writeFile(path, stepFileContent(step));
    written.push(path);
  }
  const manifestPath = join(taskDir, "manifest.json");
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  let currentManifest: string | undefined;
  try {
    currentManifest = await fs.readFile(manifestPath);
  } catch {
    currentManifest = undefined;
  }
  if (currentManifest !== manifestText) {
    await fs.writeFile(manifestPath, manifestText);
    written.push(manifestPath);
  }

  const outcome = {
    kind: "generated" as const,
    taskId: plan.taskId,
    outDir: taskDir,
    written,
    verified,
    manifest,
  };
  for (const line of renderOutcome(outcome)) out(line);
  return outcome;
}

async function runMigrate(
  args: ParsedArgs,
  plan: MigrationPlan,
  target: DatabaseTarget,
  deps: MigrateTestDeps,
): Promise<RunOutcome> {
  const fs = deps.fs ?? defaultFileSystem;
  const out = deps.out ?? defaultOut;
  const connect = deps.connect ?? defaultConnect;

  // apply 门禁在连接之前：manifest 缺失或不一致时绝无任何数据库副作用。
  if (args.apply && args.manifestPath) {
    let text: string;
    try {
      text = await fs.readFile(args.manifestPath);
    } catch (error) {
      return {
        kind: "refused",
        stage: "manifest",
        reason: `manifest file "${args.manifestPath}" could not be read: ${(error as Error).message}`,
      };
    }
    const parsed = parseManifestText(text);
    if (!parsed.ok) {
      return { kind: "refused", stage: "manifest", reason: parsed.reason };
    }
    const verified = validateManifestAgainstPlan(parsed.manifest, plan);
    if (!verified.ok) {
      return { kind: "refused", stage: "manifest", reason: verified.reason };
    }
  }

  const connection = connect(target.url);
  try {
    const journalEntries = await readJournalEntries(connection, plan.taskId);
    // 编号前缀与逐步骤 digest 都必须与当前计划一致；漂移在 apply 前拒绝，
    // 且不自动修复/重放（人工审查后才可能继续）。
    const journal = validateJournalAgainstPlan(journalEntries, plan);
    if (!journal.ok) {
      return { kind: "refused", stage: "journal", reason: journal.reason };
    }
    const pending = plan.steps.slice(journal.appliedCount);

    if (!args.apply) {
      const dryRun = {
        kind: "dry-run" as const,
        taskId: plan.taskId,
        databaseName: target.databaseName,
        endpoint: target.endpoint,
        appliedCount: journal.appliedCount,
        pending,
        manifest: manifestFor(plan),
      };
      for (const line of renderOutcome(dryRun)) out(line);
      return dryRun;
    }

    if (pending.length === 0) {
      const upToDate = {
        kind: "up-to-date" as const,
        taskId: plan.taskId,
        databaseName: target.databaseName,
        endpoint: target.endpoint,
        appliedCount: journal.appliedCount,
      };
      for (const line of renderOutcome(upToDate)) out(line);
      return upToDate;
    }

    await connection.unsafe(JOURNAL_DDL);
    for (const step of pending) {
      await connection.begin(async (tx) => {
        for (const statement of step.statements) {
          await tx.unsafe(statement);
        }
        await tx.unsafe(
          `INSERT INTO ${JOURNAL_TABLE} (task_id, number, name, statement_digest) ` +
            `VALUES (${sqlLiteral(plan.taskId)}, ${sqlLiteral(step.number)}, ` +
            `${sqlLiteral(step.name)}, ${sqlLiteral(step.statementDigest)})`,
        );
      });
    }
    const applied = {
      kind: "applied" as const,
      taskId: plan.taskId,
      databaseName: target.databaseName,
      endpoint: target.endpoint,
      appliedSteps: pending,
    };
    for (const line of renderOutcome(applied)) out(line);
    return applied;
  } catch (error) {
    return {
      kind: "refused",
      stage: "execution",
      reason: `execution failed: ${(error as Error).message}; already-committed steps stay journaled and a retry resumes from the next step`,
    };
  } finally {
    await connection.end();
  }
}

// ---------------------------------------------------------------------------
// CLI 入口（必须在文件末尾：top-level await 早于后面的 const 初始化会 TDZ）
// 拒绝时非零退出；建议 bun --no-env-file 运行，不读 .env。
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const outcome = await runMigrateTest(process.argv.slice(2), {
    out: () => {},
  });
  if (outcome.kind === "refused") {
    console.error(renderOutcome(outcome)[0]);
    process.exitCode = 1;
  } else {
    for (const line of renderOutcome(outcome)) console.log(line);
  }
}
