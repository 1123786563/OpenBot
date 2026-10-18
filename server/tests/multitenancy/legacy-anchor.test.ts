// server/tests/multitenancy/legacy-anchor.test.ts
// MT112（执行轮 Ticket）：历史部署的「原有公司 + 默认团队」锚点创建。
//
// 验收事实源（MT112-brief.md 四条，逐条对应）：
//   (1) 原有公司与默认团队创建幂等；重复执行不产生重复实体
//       （ON CONFLICT … DO NOTHING，绝不先查后插）；
//   (2) 与既有部署身份及计费 Customer 的映射唯一且可核验
//       （deployment_packages.tenant_id 与 billing_customers 的
//       openbot-deployment-<tenant_id> 派生键；唯一索引 + 派生 CHECK）；
//   (3) 创建过程以 dry-run 预览、以 manifest 执行 apply（MT003 工具原生链路）；
//   (4) 创建后既有单租户行为不变（回归 + expand-only 对照）。
//
// 勘察结论（详见 reports/MT112.md）：
//   - 部署身份实际落点 = deployment_packages.tenant_id（启动时由
//     synchronizeTenantPackage 从租户包 upsert，UNIQUE）；
//   - 计费 Customer 实际落点 = billing_customers.external_id（主键），
//     键值由 deploymentExternalCustomerId(tenantId)（src/billing/service.ts）
//     派生：'openbot-deployment-' || tenantId；
//   - 企业域不存在既有映射表 → MT112 纯追加最小映射表
//     enterprise_deployment_anchors。
//
// 环境契约：只认显式 TEST_DATABASE_URL（回环 + openbot_enterprise_* 命名，
// 复用 MT003 工具的同一个解析 seam）；缺配置或缺基础 schema 时响亮失败——
// 绝不回退开发库，绝不把 skipped 记为通过。迁移与数据创建都经 MT003 工具
// （migrate-test.ts）真实执行，本文件不自建表。夹具用固定 id/created_at，
// 同一测试库跨套件重跑保持稳定；锚点行是交付状态，afterAll 不删除。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { like, sql } from "drizzle-orm";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { createDatabase, type Database } from "../../src/db/client";
import {
  enterpriseDeploymentAnchors,
  enterpriseTenants,
} from "../../src/db/schema";
import { billingCustomers } from "../../src/db/schema/billing";
import { deploymentPackages, users } from "../../src/db/schema/core";
import { rejectionOf } from "../support/pg-errors";

// ---------------------------------------------------------------------------
// 锚点常量：确定性、可重复执行；mt112 前缀保留给测试夹具
// ---------------------------------------------------------------------------

/** 「原有公司」租户 id（迁移写入的固定锚点 id）。 */
const ANCHOR_TENANT_ID = "ent-legacy-original";
/** 「原有公司」名称（Spec §9.2 词汇）。 */
const ANCHOR_TENANT_NAME = "原有公司";
/** 「默认团队」workspace id。 */
const DEFAULT_WORKSPACE_ID = "ent-legacy-default-team";
/** 「默认团队」名称。 */
const DEFAULT_WORKSPACE_NAME = "默认团队";
/** 计费 Customer 键派生规则（deploymentExternalCustomerId 的唯一契约）。 */
const billingKeyOf = (deploymentTenantId: string): string =>
  `openbot-deployment-${deploymentTenantId}`;

/** 夹具部署身份（deployment_packages.tenant_id，固定值保证跨套件重跑稳定）。 */
const FIXTURE_DEPLOYMENT_TENANT_ID = "mt112-deployment-identity";
/** 夹具锚点用户：created_at 固定为纪元值，保证是全库最早用户（锚点成员）。 */
const FIXTURE_ANCHOR_USER_ID = "mt112-anchor-user";
/** 夹具第二个用户：更晚创建，不得被锚定。 */
const FIXTURE_LATER_USER_ID = "mt112-later-user";
/** 验收 (2) 唯一性拒绝用例的冒名租户（固定 id，幂等重建，结束后清理）。 */
const IMPOSTOR_TENANT_ID = "ent-legacy-impostor";

// ---------------------------------------------------------------------------
// 环境：仅显式 TEST_DATABASE_URL；拒绝发生在任何连接之前
// ---------------------------------------------------------------------------

const resolved = resolveTestDatabaseTarget(process.env);
if (!resolved.ok) {
  throw new Error(
    `MT112 legacy-anchor tests refuse to run: ${resolved.reason}`,
  );
}
const TEST_URL = resolved.target.url;

/** 基础表必须已存在（enterprise-test-db.ts migrate 的产物）；缺了就拒绝。 */
async function assertBaseSchemaPresent(database: Database): Promise<void> {
  const result = (await database.execute(sql`
    select to_regclass('public.enterprise_workspaces') as workspaces,
           to_regclass('public.enterprise_memberships') as memberships,
           to_regclass('public.enterprise_tenants') as tenants,
           to_regclass('public.enterprise_principals') as principals,
           to_regclass('public.enterprise_workspace_memberships') as workspace_memberships,
           to_regclass('public.deployment_packages') as deployment_packages,
           to_regclass('public.billing_customers') as billing_customers,
           to_regclass('public.users') as users
  `)) as unknown as Record<string, unknown>[];
  const row = result[0];
  const missing = Object.entries(row ?? {})
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  if (!row || missing.length > 0) {
    throw new Error(
      `MT112_LEGACY_ANCHOR_BASE_SCHEMA_MISSING: missing ${missing.join(", ")}; ` +
        "run `bun server/scripts/enterprise-test-db.ts migrate` against the dedicated " +
        "openbot_enterprise_* test database first — development databases are never a fallback",
    );
  }
}

// ---------------------------------------------------------------------------
// 共享状态与只读探针
// ---------------------------------------------------------------------------

let database: Database;
let rawClient: ReturnType<typeof import("postgres")["default"]>;
/** 受限角色专用连接：SET ROLE/set_config 只作用本会话，不污染其它测试。 */
let rlsClient: ReturnType<typeof import("postgres")["default"]>;

/** 迁移前基线：既有表清单与既有表策略数（expand-only 的对照面）。 */
let baselineTables: string[];
let baselinePolicies: Record<string, number>;
/** 种子夹具之后、apply 之前的业务行快照（criterion 4 的对照面）。 */
let seededLegacyCounts: Record<string, number>;
let freshDryRun: RunOutcome;
let applyOutcome: RunOutcome;
let plan: ReturnType<typeof buildPlan>;

/** 按迁移的同一确定性规则计算「锚点用户」：全库最早用户（created_at, id）。 */
async function expectedAnchorUserId(): Promise<string | null> {
  const rows = (await rawClient`
    select "id" from "users"
    order by "created_at" asc, "id" asc
    limit 1`) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** 锚点成员的确定性 principal id（与迁移 SQL 同一派生规则）。 */
const anchorPrincipalIdOf = (userId: string): string =>
  `entp-legacy-anchor-${userId}`;

async function anchorMappingRows(): Promise<
  Array<{
    tenant_id: string;
    deployment_tenant_id: string;
    billing_external_customer_id: string;
  }>
> {
  return (await rawClient`
    select "tenant_id", "deployment_tenant_id", "billing_external_customer_id"
    from "enterprise_deployment_anchors"`) as Array<{
    tenant_id: string;
    deployment_tenant_id: string;
    billing_external_customer_id: string;
  }>;
}

async function anchorTenantRows(): Promise<Array<Record<string, unknown>>> {
  return (await rawClient`
    select "id", "name", "status", "policy_revision"
    from "enterprise_tenants" where "id" = ${ANCHOR_TENANT_ID}`) as Array<
    Record<string, unknown>
  >;
}

async function anchorWorkspaceRows(): Promise<Array<Record<string, unknown>>> {
  return (await rawClient`
    select "tenant_id", "id", "name"
    from "enterprise_workspaces"
    where "tenant_id" = ${ANCHOR_TENANT_ID} and "id" = ${DEFAULT_WORKSPACE_ID}`) as Array<
    Record<string, unknown>
  >;
}

/** 表名只来自本文件内的字面量常量，不携带外部输入。 */
async function countOf(tableName: string): Promise<number> {
  const rows = (await rawClient.unsafe(
    `select count(*)::int as n from "${tableName}"`,
  )) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

async function tableNames(): Promise<string[]> {
  const rows = (await rawClient`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`) as Array<{
    table_name: string;
  }>;
  return rows.map((row) => row.table_name);
}

async function policyCounts(): Promise<Record<string, number>> {
  const rows = (await rawClient`
    select tablename, count(*)::int as n from pg_policies
    where schemaname = 'public' group by tablename`) as Array<{
    tablename: string;
    n: number;
  }>;
  return Object.fromEntries(rows.map((row) => [row.tablename, Number(row.n)]));
}

/** 把任务的某一步骤的语句按原样重放（幂等性的数据级证据）。 */
async function replayStepStatements(stepName: string): Promise<void> {
  const step = plan.steps.find((candidate) => candidate.name === stepName);
  if (!step) throw new Error(`plan step ${stepName} missing`);
  for (const statement of step.statements) {
    await rawClient.unsafe(statement);
  }
}

/** 生成 manifest 到临时目录并返回其路径（真实 generate 产物，非手写）。 */
async function generateManifest(): Promise<{
  dir: string;
  manifestPath: string;
}> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mt112-manifest-"));
  const generated = await runMigrateTest(["generate", "MT112", "--out", dir], {
    environment: { TEST_DATABASE_URL: TEST_URL },
    out: () => {},
  });
  expect(generated.kind).toBe("generated");
  return { dir, manifestPath: join(dir, "MT112", "manifest.json") };
}

async function setupFixture(): Promise<void> {
  // 固定 id/created_at：跨套件重跑稳定；冲突时保持原行（幂等夹具）。
  await database
    .insert(users)
    .values([
      {
        id: FIXTURE_ANCHOR_USER_ID,
        email: `${FIXTURE_ANCHOR_USER_ID}@example.invalid`,
        name: "MT112 Anchor",
        createdAt: new Date("1970-01-01T00:00:00.000Z"),
      },
      {
        id: FIXTURE_LATER_USER_ID,
        email: `${FIXTURE_LATER_USER_ID}@example.invalid`,
        name: "MT112 Later",
        createdAt: new Date("2000-01-01T00:00:00.000Z"),
      },
    ])
    .onConflictDoNothing();
  // 夹具部署身份：deployment_packages（与 synchronizeTenantPackage 同形状）。
  await database
    .insert(deploymentPackages)
    .values({
      tenantId: FIXTURE_DEPLOYMENT_TENANT_ID,
      sourcePath: "/test/mt112/tenant-package",
      checksum: "mt112-fixture-checksum",
    })
    .onConflictDoUpdate({
      target: deploymentPackages.tenantId,
      set: { loadedAt: new Date() },
    });
  // 夹具计费 Customer 投影行（billing_customers.external_id 主键）。
  await database
    .insert(billingCustomers)
    .values({
      externalId: billingKeyOf(FIXTURE_DEPLOYMENT_TENANT_ID),
      name: `OpenBot deployment ${billingKeyOf(FIXTURE_DEPLOYMENT_TENANT_ID)}`,
    })
    .onConflictDoNothing();
}

beforeAll(async () => {
  const postgres = (await import("postgres")).default;
  rawClient = postgres(TEST_URL, { max: 1, onnotice: () => {} });
  rlsClient = postgres(TEST_URL, { max: 1, onnotice: () => {} });
  database = createDatabase(TEST_URL, { max: 2 });
  await assertBaseSchemaPresent(database);

  // 迁移前基线（expand-only 对照面）。
  baselineTables = await tableNames();
  baselinePolicies = await policyCounts();

  await setupFixture();

  // 快照放在种子之后、apply 之前：apply 前后对照才隔离出迁移自身的影响。
  seededLegacyCounts = {
    users: await countOf("users"),
    billing_customers: await countOf("billing_customers"),
    deployment_packages: await countOf("deployment_packages"),
    billing_subscriptions: await countOf("billing_subscriptions"),
    enterprise_tenants: await countOf("enterprise_tenants"),
    enterprise_workspaces: await countOf("enterprise_workspaces"),
    enterprise_principals: await countOf("enterprise_principals"),
    enterprise_memberships: await countOf("enterprise_memberships"),
    enterprise_workspace_memberships: await countOf(
      "enterprise_workspace_memberships",
    ),
  };

  plan = buildPlan("MT112");
  freshDryRun = await runMigrateTest(["migrate", "MT112"], {
    environment: { TEST_DATABASE_URL: TEST_URL },
    out: () => {},
  });

  const { dir, manifestPath } = await generateManifest();
  try {
    applyOutcome = await runMigrateTest(
      ["migrate", "MT112", "--apply", "--manifest", manifestPath],
      { environment: { TEST_DATABASE_URL: TEST_URL }, out: () => {} },
    );
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  }
});

afterAll(async () => {
  // 只清理验收用例引入的冒名实体；锚点固定 id 的行是交付状态，跨重跑保留。
  await database
    .delete(enterpriseDeploymentAnchors)
    .where(
      like(enterpriseDeploymentAnchors.tenantId, `${IMPOSTOR_TENANT_ID}%`),
    );
  await database
    .delete(enterpriseTenants)
    .where(like(enterpriseTenants.id, `${IMPOSTOR_TENANT_ID}%`));
  await database.$client.close();
  await rawClient.end();
  await rlsClient.unsafe("reset role").catch(() => {});
  await rlsClient.end();
});

// ---------------------------------------------------------------------------
// 验收 (1)：原有公司与默认团队创建幂等；重复执行不产生重复实体
// ---------------------------------------------------------------------------

describe("MT112 criterion 1: legacy company and default team creation is idempotent", () => {
  test("the anchor tenant row exists exactly once with the fixed identity", async () => {
    const rows = await anchorTenantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(ANCHOR_TENANT_NAME);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.policy_revision).toBe("tenancy-v1");
  });

  test("the default team workspace row exists exactly once under the anchor tenant", async () => {
    const rows = await anchorWorkspaceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(ANCHOR_TENANT_ID);
    expect(rows[0]?.name).toBe(DEFAULT_WORKSPACE_NAME);
  });

  test("replaying the anchor-row steps verbatim inserts no duplicate entities", async () => {
    await replayStepStatements("0003_mt112_legacy_anchor_rows.sql");
    await replayStepStatements("0004_mt112_anchor_mapping_row.sql");
    expect(await anchorTenantRows()).toHaveLength(1);
    expect(await anchorWorkspaceRows()).toHaveLength(1);
    expect(await anchorMappingRows()).toHaveLength(1);
  });

  test("a conflicting tenant insert resolves to no-op and keeps the original row", async () => {
    await rawClient.unsafe(
      'INSERT INTO "enterprise_tenants" ("id", "name") VALUES ($1, $2) ON CONFLICT ("id") DO NOTHING',
      [ANCHOR_TENANT_ID, "原有公司冒名"],
    );
    const rows = await anchorTenantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(ANCHOR_TENANT_NAME);
  });

  test("the anchor member is the earliest user exactly once with no second anchor", async () => {
    const anchorUser = await expectedAnchorUserId();
    expect(anchorUser).toBe(FIXTURE_ANCHOR_USER_ID);
    const principalId = anchorPrincipalIdOf(anchorUser ?? "");
    const principals = (await rawClient`
      select "id", "user_id", "status" from "enterprise_principals"
      where "user_id" = ${anchorUser}`) as Array<Record<string, unknown>>;
    expect(principals).toHaveLength(1);
    expect(principals[0]?.id).toBe(principalId);
    expect(principals[0]?.status).toBe("active");
    const memberships = (await rawClient`
      select "role", "status" from "enterprise_memberships"
      where "tenant_id" = ${ANCHOR_TENANT_ID} and "principal_id" = ${principalId}`) as Array<
      Record<string, unknown>
    >;
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("tenant_admin");
    expect(memberships[0]?.status).toBe("active");
    const laterAnchors = (await rawClient`
      select count(*)::int as n from "enterprise_principals"
      where "user_id" = ${FIXTURE_LATER_USER_ID}`) as Array<{ n: number }>;
    expect(Number(laterAnchors[0]?.n)).toBe(0);
  });

  test("the anchor member holds the default-team workspace membership exactly once", async () => {
    const anchorUser = await expectedAnchorUserId();
    const principalId = anchorPrincipalIdOf(anchorUser ?? "");
    const rows = (await rawClient`
      select "tenant_id", "workspace_id", "principal_id", "status", "epoch"
      from "enterprise_workspace_memberships"
      where "tenant_id" = ${ANCHOR_TENANT_ID}
        and "workspace_id" = ${DEFAULT_WORKSPACE_ID}
        and "principal_id" = ${principalId}`) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(Number(rows[0]?.epoch)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 验收 (2)：与既有部署身份及计费 Customer 的映射唯一且可核验
// ---------------------------------------------------------------------------

describe("MT112 criterion 2: the mapping to deployment identity and billing customer is unique and verifiable", () => {
  test("exactly one anchor row maps the tenant to the persisted deployment identity", async () => {
    const rows = await anchorMappingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(ANCHOR_TENANT_ID);
    expect(rows[0]?.deployment_tenant_id).toBe(FIXTURE_DEPLOYMENT_TENANT_ID);
    expect(rows[0]?.billing_external_customer_id).toBe(
      billingKeyOf(FIXTURE_DEPLOYMENT_TENANT_ID),
    );
  });

  test("the mapping is verifiable against deployment_packages and billing_customers by join", async () => {
    const joins = (await rawClient`
      select
        (select count(*)::int from "enterprise_deployment_anchors" a
          join "deployment_packages" dp
            on dp."tenant_id" = a."deployment_tenant_id") as identity_hits,
        (select count(*)::int from "enterprise_deployment_anchors" a
          join "billing_customers" bc
            on bc."external_id" = a."billing_external_customer_id") as billing_hits
    `) as Array<{ identity_hits: number; billing_hits: number }>;
    expect(Number(joins[0]?.identity_hits)).toBe(1);
    expect(Number(joins[0]?.billing_hits)).toBe(1);
  });

  test("a second tenant claiming the same deployment identity is rejected by the unique index", async () => {
    await rawClient.unsafe(
      'INSERT INTO "enterprise_tenants" ("id", "name") VALUES ($1, $2) ON CONFLICT ("id") DO NOTHING',
      [IMPOSTOR_TENANT_ID, "冒名公司"],
    );
    const rejection = await rejectionOf(() =>
      rawClient.unsafe(
        `INSERT INTO "enterprise_deployment_anchors" ("tenant_id", "deployment_tenant_id", "billing_external_customer_id") ` +
          `SELECT 'ent-legacy-impostor', a."deployment_tenant_id", a."billing_external_customer_id" ` +
          `FROM "enterprise_deployment_anchors" a`,
      ),
    );
    expect(rejection.code).toBe("23505");
    expect(rejection.message).toContain(
      "enterprise_deployment_anchor_identity",
    );
  });

  test("a billing customer key that does not follow the derivation is rejected by the check", async () => {
    const rejection = await rejectionOf(() =>
      rawClient.unsafe(
        `INSERT INTO "enterprise_deployment_anchors" ("tenant_id", "deployment_tenant_id", "billing_external_customer_id") ` +
          `VALUES ('ent-legacy-impostor', 'mt112-other-identity', 'openbot-deployment-someone-else')`,
      ),
    );
    expect(rejection.code).toBe("23514");
    expect(rejection.message).toContain(
      "enterprise_deployment_anchor_billing_derivation",
    );
  });

  test("the unique indexes and the derivation check really exist in the catalog", async () => {
    const indexes = (await rawClient`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'enterprise_deployment_anchors'
      order by indexname`) as Array<{ indexname: string }>;
    const names = indexes.map((row) => row.indexname);
    expect(names).toContain("enterprise_deployment_anchors_pkey");
    expect(names).toContain("enterprise_deployment_anchor_identity");
    expect(names).toContain("enterprise_deployment_anchor_billing_customer");
    const checks = (await rawClient`
      select conname from pg_constraint
      where conrelid = 'enterprise_deployment_anchors'::regclass and contype = 'c'
      order by conname`) as Array<{ conname: string }>;
    expect(checks.map((row) => row.conname)).toContain(
      "enterprise_deployment_anchor_billing_derivation",
    );
  });

  test("the restricted operator role reads the anchor only inside its tenant context and can never write", async () => {
    await rlsClient.unsafe("set role ob_ent_operator");
    const unscoped = (await rlsClient`
      select count(*)::int as n from "enterprise_deployment_anchors"`) as Array<{
      n: number;
    }>;
    expect(Number(unscoped[0]?.n)).toBe(0);
    const scoped = await rlsClient.begin(async (tx) => {
      await tx.unsafe(
        `select set_config('app.tenant_id', '${ANCHOR_TENANT_ID}', true)`,
      );
      return (await tx`select count(*)::int as n from "enterprise_deployment_anchors"`) as Array<{
        n: number;
      }>;
    });
    expect(Number(scoped[0]?.n)).toBe(1);
    const denial = await rejectionOf(() =>
      rlsClient.unsafe(
        `INSERT INTO "enterprise_deployment_anchors" ("tenant_id", "deployment_tenant_id", "billing_external_customer_id") ` +
          `VALUES ('ent-legacy-impostor', 'mt112-denied-identity', 'openbot-deployment-mt112-denied-identity')`,
      ),
    );
    expect(denial.code).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
// 验收 (3)：dry-run 预览 + manifest 执行 apply（MT003 工具原生链路）
// ---------------------------------------------------------------------------

describe("MT112 criterion 3: creation previews as dry-run and applies via manifest through the MT003 tool", () => {
  test("MT112 is a registered task whose plan is deterministic", () => {
    expect(plan.taskId).toBe("MT112");
    expect(plan.steps.map((step) => step.name)).toEqual([
      "0001_mt112_anchor_mapping_table.sql",
      "0002_mt112_anchor_rls_policies.sql",
      "0003_mt112_legacy_anchor_rows.sql",
      "0004_mt112_anchor_mapping_row.sql",
    ]);
    expect(manifestFor(plan)).toEqual(manifestFor(buildPlan("MT112")));
    expect(manifestFor(plan).taskId).toBe("MT112");
  });

  test("dry-run previews the pending statement plan before anything is applied", () => {
    expect(freshDryRun).toMatchObject({ kind: "dry-run", taskId: "MT112" });
    if (freshDryRun.kind !== "dry-run") return;
    if (applyOutcome.kind === "applied") {
      // 全新库：dry-run 在 apply 之前运行，必须预告全部步骤与建表语句。
      expect(freshDryRun.pending.map((step) => step.name)).toEqual([
        "0001_mt112_anchor_mapping_table.sql",
        "0002_mt112_anchor_rls_policies.sql",
        "0003_mt112_legacy_anchor_rows.sql",
        "0004_mt112_anchor_mapping_row.sql",
      ]);
      const createStep = freshDryRun.pending[0];
      expect(
        createStep.statements.some((statement) =>
          statement.includes('CREATE TABLE "enterprise_deployment_anchors"'),
        ),
      ).toBe(true);
      const dataStep = freshDryRun.pending[2];
      expect(
        dataStep.statements.some((statement) =>
          statement.includes("ON CONFLICT"),
        ),
      ).toBe(true);
    } else {
      // 重放过的库：journal 已记录全部步骤，dry-run 如实报告 0 待应用。
      expect(applyOutcome.kind).toBe("up-to-date");
      expect(freshDryRun.pending).toHaveLength(0);
    }
  });

  test("apply converges via the manifest gate and replays as up-to-date", async () => {
    expect(["applied", "up-to-date"]).toContain(applyOutcome.kind);
    const table = await rawClient`
      select to_regclass('public.enterprise_deployment_anchors') as t`;
    expect(String(table[0]?.t)).toBe("enterprise_deployment_anchors");

    const journal = (await rawClient`
      select number, name, statement_digest from "mt_task_migration_journal"
      where task_id = 'MT112' order by number`) as Array<{
      number: number;
      name: string;
      statement_digest: string;
    }>;
    expect(journal.map((row) => Number(row.number))).toEqual([1, 2, 3, 4]);
    expect(journal.map((row) => row.name)).toEqual([
      "0001_mt112_anchor_mapping_table.sql",
      "0002_mt112_anchor_rls_policies.sql",
      "0003_mt112_legacy_anchor_rows.sql",
      "0004_mt112_anchor_mapping_row.sql",
    ]);
    for (let index = 0; index < 4; index += 1) {
      expect(journal[index]?.statement_digest).toBe(
        plan.steps[index]?.statementDigest,
      );
    }

    const { dir, manifestPath } = await generateManifest();
    try {
      const replay = await runMigrateTest(
        ["migrate", "MT112", "--apply", "--manifest", manifestPath],
        { environment: { TEST_DATABASE_URL: TEST_URL }, out: () => {} },
      );
      expect(replay.kind).toBe("up-to-date");
      if (replay.kind === "up-to-date") {
        expect(replay.appliedCount).toBe(4);
      }
      const againDryRun = await runMigrateTest(["migrate", "MT112"], {
        environment: { TEST_DATABASE_URL: TEST_URL },
        out: () => {},
      });
      expect(againDryRun).toMatchObject({ kind: "dry-run", taskId: "MT112" });
      if (againDryRun.kind === "dry-run") {
        expect(againDryRun.pending).toHaveLength(0);
      }
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a manifest that drifted from the plan is refused before any database effect", async () => {
    const drifted = {
      ...manifestFor(buildPlan("MT112")),
      planDigest: "0".repeat(64),
    };
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "mt112-drift-"));
    const manifestPath = join(dir, "drifted-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(drifted, null, 2)}\n`);
    try {
      const refused = await runMigrateTest(
        ["migrate", "MT112", "--apply", "--manifest", manifestPath],
        { environment: { TEST_DATABASE_URL: TEST_URL }, out: () => {} },
      );
      expect(refused).toMatchObject({ kind: "refused", stage: "manifest" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 验收 (4)：创建后既有单租户行为不变（expand-only 回归）
// ---------------------------------------------------------------------------

describe("MT112 criterion 4: existing single-tenant behavior is unchanged", () => {
  test("the migration is expand-only: only the anchor table (plus the tool journal) may be new and nothing disappears", async () => {
    const afterTables = await tableNames();
    const newTables = afterTables.filter(
      (name) => !baselineTables.includes(name),
    );
    // 允许出现的新表只有本任务的映射表与 MT003 工具自有 journal。
    const allowed = new Set([
      "enterprise_deployment_anchors",
      "mt_task_migration_journal",
    ]);
    for (const name of newTables) {
      expect(allowed.has(name)).toBe(true);
    }
    expect(afterTables).toContain("enterprise_deployment_anchors");
    for (const name of baselineTables) {
      expect(afterTables).toContain(name);
    }
  });

  test("the anchor creation touched no legacy business rows", async () => {
    expect({
      users: await countOf("users"),
      billing_customers: await countOf("billing_customers"),
      deployment_packages: await countOf("deployment_packages"),
      billing_subscriptions: await countOf("billing_subscriptions"),
    }).toEqual({
      users: seededLegacyCounts.users,
      billing_customers: seededLegacyCounts.billing_customers,
      deployment_packages: seededLegacyCounts.deployment_packages,
      billing_subscriptions: seededLegacyCounts.billing_subscriptions,
    });
  });

  test("fixture users keep their identity and timestamps after the migration", async () => {
    const rows = (await rawClient`
      select "id", "email", "name", "created_at"
      from "users" where "id" in (${FIXTURE_ANCHOR_USER_ID}, ${FIXTURE_LATER_USER_ID})
      order by "id"`) as Array<{
      id: string;
      email: string;
      name: string;
      created_at: Date;
    }>;
    expect(rows).toHaveLength(2);
    const anchor = rows.find((row) => row.id === FIXTURE_ANCHOR_USER_ID);
    const later = rows.find((row) => row.id === FIXTURE_LATER_USER_ID);
    expect(anchor?.email).toBe(`${FIXTURE_ANCHOR_USER_ID}@example.invalid`);
    expect(anchor?.name).toBe("MT112 Anchor");
    expect(anchor?.created_at?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(later?.email).toBe(`${FIXTURE_LATER_USER_ID}@example.invalid`);
    expect(later?.name).toBe("MT112 Later");
  });

  test("the billing customer projection row is untouched by the anchor creation", async () => {
    const rows = (await rawClient`
      select "name", "last_synced_at" from "billing_customers"
      where "external_id" = ${billingKeyOf(FIXTURE_DEPLOYMENT_TENANT_ID)}`) as Array<{
      name: string;
      last_synced_at: Date;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(
      `OpenBot deployment ${billingKeyOf(FIXTURE_DEPLOYMENT_TENANT_ID)}`,
    );
  });

  test("existing enterprise tables keep exactly the policies they had before", async () => {
    const afterPolicies = await policyCounts();
    for (const [tablename, count] of Object.entries(baselinePolicies)) {
      expect(afterPolicies[tablename]).toBe(count);
    }
    // 唯一允许的新策略承载者是本任务的新表（工具 journal 无策略）。
    // 全新库：新增策略承载者恰为锚点表；重放库：锚点表已在基线内，
    // 因此不允许出现任何其它新策略承载者。
    const newPolicyTables = Object.keys(afterPolicies).filter(
      (tablename) => baselinePolicies[tablename] === undefined,
    );
    if (applyOutcome.kind === "applied") {
      expect(newPolicyTables.sort()).toEqual(["enterprise_deployment_anchors"]);
    } else {
      expect(applyOutcome.kind).toBe("up-to-date");
      expect(newPolicyTables).toEqual([]);
    }
    expect(afterPolicies.enterprise_deployment_anchors).toBe(1);
  });
});
