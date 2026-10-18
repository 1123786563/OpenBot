// server/tests/multitenancy/membership-model.test.ts
// MT004（Issue #47）：企业团队成员关系数据模型（expand-only）。
//
// 验收事实源（Issue #47 四条，逐条对应）：
//   (1) 同一 (公司, 团队, 主体) 只有一条成员关系；重复插入被数据库拒绝；
//   (2) 团队不属于该公司、或主体不是该公司成员时插入被拒绝（复合关联生效）；
//   (3) 状态支持 active/suspended；版本号为正整数且单调递增（由应用写入
//       路径 read-then-increase 保证，数据库 CHECK 兜底正整数）。已知并发
//       局限（复审 F2）：read-then-increase 非原子，并发写者可读到同一
//       current epoch 并写出重复值，串行化/重试责任归应用写入路径
//       （MT005 消费契约将接管）；
//   (4) 迁移可 dry-run 预览并在专用测试库重放；旧数据不因新增表而改变行为。
//
// 环境契约：只认显式 TEST_DATABASE_URL（回环 + openbot_enterprise_* 命名，
// 复用 MT003 工具的同一个解析 seam）；缺配置或缺基础企业 schema 时响亮
// 失败——绝不回退开发库，绝不把 skipped 记为通过。迁移经 MT003 工具
// （migrate-test.ts）真实执行，本文件不自己 CREATE TABLE。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../../src/db/schema";
import { users } from "../../src/db/schema/core";
import { rejectionOf } from "../support/pg-errors";

// ---------------------------------------------------------------------------
// 环境：仅显式 TEST_DATABASE_URL；拒绝发生在任何连接之前
// ---------------------------------------------------------------------------

const resolved = resolveTestDatabaseTarget(process.env);
if (!resolved.ok) {
  throw new Error(
    `MT004 membership-model tests refuse to run: ${resolved.reason}`,
  );
}
const TEST_URL = resolved.target.url;

/** 基础企业表必须已存在（enterprise-test-db.ts migrate 的产物）；缺了就拒绝。 */
async function assertBaseSchemaPresent(database: Database): Promise<void> {
  const result = (await database.execute(sql`
    select to_regclass('public.enterprise_workspaces') as workspaces,
           to_regclass('public.enterprise_memberships') as memberships,
           to_regclass('public.enterprise_tenants') as tenants,
           to_regclass('public.enterprise_principals') as principals
  `)) as unknown as Record<string, unknown>[];
  const row = result[0];
  const missing = Object.entries(row ?? {})
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  if (!row || missing.length > 0) {
    throw new Error(
      `MT004_MEMBERSHIP_MODEL_BASE_SCHEMA_MISSING: missing ${missing.join(", ")}; ` +
        "run `bun server/scripts/enterprise-test-db.ts migrate` against the dedicated " +
        "openbot_enterprise_* test database first — development databases are never a fallback",
    );
  }
}

// ---------------------------------------------------------------------------
// 共享夹具：两家公司、三个团队、三名成员（全部走真实 schema 与真实约束）
// ---------------------------------------------------------------------------

const fixture = {
  prefix: `mt004-${randomUUID().slice(0, 8)}`,
  tenantA: "",
  tenantB: "",
  workspaceA1: "",
  workspaceA2: "",
  workspaceB1: "",
  principalAMember: "",
  principalA2Member: "",
  principalBMember: "",
  userAMember: "",
  userA2Member: "",
  userBMember: "",
};

let database: Database;
let rawClient: ReturnType<typeof import("postgres")["default"]>;
/** 受限角色专用连接：SET ROLE/set_config 只作用本会话，不污染其它测试。 */
let rlsClient: ReturnType<typeof import("postgres")["default"]>;

/** 迁移前基线：既有表清单与既有表策略数（expand-only 的对照面）。 */
let baselineTables: string[];
let baselinePolicies: Record<string, number>;
let freshDryRun: RunOutcome;
let applyOutcome: RunOutcome;

async function setupFixture(): Promise<void> {
  fixture.tenantA = `${fixture.prefix}-company-a`;
  fixture.tenantB = `${fixture.prefix}-company-b`;
  fixture.workspaceA1 = `${fixture.prefix}-team-a1`;
  fixture.workspaceA2 = `${fixture.prefix}-team-a2`;
  fixture.workspaceB1 = `${fixture.prefix}-team-b1`;
  fixture.userAMember = `${fixture.prefix}-user-a`;
  fixture.userA2Member = `${fixture.prefix}-user-a2`;
  fixture.userBMember = `${fixture.prefix}-user-b`;
  fixture.principalAMember = `${fixture.prefix}-principal-a`;
  fixture.principalA2Member = `${fixture.prefix}-principal-a2`;
  fixture.principalBMember = `${fixture.prefix}-principal-b`;

  await database.insert(users).values([
    {
      id: fixture.userAMember,
      email: `${fixture.userAMember}@example.invalid`,
      name: "MT004 A",
    },
    {
      id: fixture.userA2Member,
      email: `${fixture.userA2Member}@example.invalid`,
      name: "MT004 A2",
    },
    {
      id: fixture.userBMember,
      email: `${fixture.userBMember}@example.invalid`,
      name: "MT004 B",
    },
  ]);
  await database.insert(enterprisePrincipals).values([
    { id: fixture.principalAMember, userId: fixture.userAMember },
    { id: fixture.principalA2Member, userId: fixture.userA2Member },
    { id: fixture.principalBMember, userId: fixture.userBMember },
  ]);
  await database.insert(enterpriseTenants).values([
    { id: fixture.tenantA, name: "MT004 Company A" },
    { id: fixture.tenantB, name: "MT004 Company B" },
  ]);
  await database.insert(enterpriseWorkspaces).values([
    { tenantId: fixture.tenantA, id: fixture.workspaceA1, name: "Team A1" },
    { tenantId: fixture.tenantA, id: fixture.workspaceA2, name: "Team A2" },
    { tenantId: fixture.tenantB, id: fixture.workspaceB1, name: "Team B1" },
  ]);
  await database.insert(enterpriseMemberships).values([
    {
      tenantId: fixture.tenantA,
      principalId: fixture.principalAMember,
      role: "member",
    },
    {
      tenantId: fixture.tenantA,
      principalId: fixture.principalA2Member,
      role: "member",
    },
    {
      tenantId: fixture.tenantB,
      principalId: fixture.principalBMember,
      role: "member",
    },
  ]);
}

beforeAll(async () => {
  const postgres = (await import("postgres")).default;
  rawClient = postgres(TEST_URL, { max: 1, onnotice: () => {} });
  rlsClient = postgres(TEST_URL, { max: 1, onnotice: () => {} });
  database = createDatabase(TEST_URL, { max: 2 });
  await assertBaseSchemaPresent(database);

  // 迁移前基线与 dry-run 预览（证据在验收 (4) 用例中逐条断言）。
  const tableRows = (await rawClient`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`) as Array<{
    table_name: string;
  }>;
  baselineTables = tableRows.map((row) => row.table_name);
  const policyRows = (await rawClient`
    select tablename, count(*)::int as n from pg_policies
    where schemaname = 'public' group by tablename`) as Array<{
    tablename: string;
    n: number;
  }>;
  baselinePolicies = Object.fromEntries(
    policyRows.map((row) => [row.tablename, Number(row.n)]),
  );
  freshDryRun = await runMigrateTest(["migrate", "MT004"], {
    environment: { TEST_DATABASE_URL: TEST_URL },
    out: () => {},
  });

  const manifestPath = `/tmp/mt004-manifest-${randomUUID()}.json`;
  const manifest = manifestFor(buildPlan("MT004"));
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    applyOutcome = await runMigrateTest(
      ["migrate", "MT004", "--apply", "--manifest", manifestPath],
      { environment: { TEST_DATABASE_URL: TEST_URL }, out: () => {} },
    );
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(manifestPath, { force: true });
  }

  await setupFixture();
});

afterAll(async () => {
  // 只清理本夹具前缀的行（子表 → 父表）；绝不触碰他人数据。
  await database
    .delete(enterpriseWorkspaceMemberships)
    .where(like(enterpriseWorkspaceMemberships.tenantId, `${fixture.prefix}%`));
  await database
    .delete(enterpriseMemberships)
    .where(like(enterpriseMemberships.tenantId, `${fixture.prefix}%`));
  await database
    .delete(enterpriseWorkspaces)
    .where(like(enterpriseWorkspaces.tenantId, `${fixture.prefix}%`));
  await database
    .delete(enterpriseTenants)
    .where(like(enterpriseTenants.id, `${fixture.prefix}%`));
  await database
    .delete(enterprisePrincipals)
    .where(like(enterprisePrincipals.id, `${fixture.prefix}%`));
  await database.delete(users).where(like(users.id, `${fixture.prefix}%`));
  await database.$client.close();
  await rawClient.end();
  await rlsClient.unsafe("reset role").catch(() => {});
  await rlsClient.end();
});

/** 应用写入路径的事实源：读当前 epoch，写 current + 1（单调递增）。 */
async function nextEpoch(
  tenantId: string,
  workspaceId: string,
  principalId: string,
): Promise<number> {
  const rows = (await database
    .select({ epoch: enterpriseWorkspaceMemberships.epoch })
    .from(enterpriseWorkspaceMemberships)
    .where(
      sql`${enterpriseWorkspaceMemberships.tenantId} = ${tenantId}
        and ${enterpriseWorkspaceMemberships.workspaceId} = ${workspaceId}
        and ${enterpriseWorkspaceMemberships.principalId} = ${principalId}`,
    )) as unknown as { epoch: number }[];
  const current = rows[0]?.epoch ?? 0;
  return current + 1;
}

async function membershipRows(
  where: {
    tenantId: string;
    workspaceId: string;
    principalId: string;
  },
  columns: { status?: boolean; epoch?: boolean },
): Promise<Array<Record<string, unknown>>> {
  const selection = {
    tenantId: enterpriseWorkspaceMemberships.tenantId,
    workspaceId: enterpriseWorkspaceMemberships.workspaceId,
    principalId: enterpriseWorkspaceMemberships.principalId,
    ...(columns.status
      ? { status: enterpriseWorkspaceMemberships.status }
      : {}),
    ...(columns.epoch ? { epoch: enterpriseWorkspaceMemberships.epoch } : {}),
  };
  return (await database
    .select(selection)
    .from(enterpriseWorkspaceMemberships)
    .where(
      sql`${enterpriseWorkspaceMemberships.tenantId} = ${where.tenantId}
        and ${enterpriseWorkspaceMemberships.workspaceId} = ${where.workspaceId}
        and ${enterpriseWorkspaceMemberships.principalId} = ${where.principalId}`,
    )) as unknown as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 验收 (4)：迁移经 MT003 工具 dry-run 预览 + 专用测试库重放；expand-only
// ---------------------------------------------------------------------------

describe("issue #47 criterion 4: migration previews dry-run and replays via the MT003 tool", () => {
  test("MT004 is a registered task whose plan is deterministic", () => {
    const plan = buildPlan("MT004");
    expect(plan.taskId).toBe("MT004");
    expect(plan.steps.map((step) => step.name)).toEqual([
      "0001_mt004_create_table.sql",
      "0002_mt004_rls_policies.sql",
    ]);
    expect(manifestFor(plan)).toEqual(manifestFor(buildPlan("MT004")));
  });

  test("dry-run previews the pending statement plan before anything is applied", () => {
    expect(freshDryRun).toMatchObject({ kind: "dry-run", taskId: "MT004" });
    if (freshDryRun.kind !== "dry-run") return;
    if (applyOutcome.kind === "applied") {
      // 全新库：dry-run 在 apply 之前运行，必须预告全部步骤与建表语句。
      expect(freshDryRun.pending.map((step) => step.name)).toEqual([
        "0001_mt004_create_table.sql",
        "0002_mt004_rls_policies.sql",
      ]);
      const createStep = freshDryRun.pending[0];
      expect(
        createStep.statements.some((statement) =>
          statement.includes('CREATE TABLE "enterprise_workspace_memberships"'),
        ),
      ).toBe(true);
    } else {
      // 重放过的库：journal 已记录全部步骤，dry-run 如实报告 0 待应用。
      expect(applyOutcome.kind).toBe("up-to-date");
      expect(freshDryRun.pending).toHaveLength(0);
    }
  });

  test("apply materializes the table in the dedicated test database and replays as up-to-date", async () => {
    expect(["applied", "up-to-date"]).toContain(applyOutcome.kind);

    const table = await rawClient`
      select to_regclass('public.enterprise_workspace_memberships') as t`;
    expect(String(table[0]?.t)).toBe("enterprise_workspace_memberships");

    const manifestPath = `/tmp/mt004-manifest-${randomUUID()}.json`;
    const manifest = manifestFor(buildPlan("MT004"));
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    try {
      const replay = await runMigrateTest(
        ["migrate", "MT004", "--apply", "--manifest", manifestPath],
        { environment: { TEST_DATABASE_URL: TEST_URL }, out: () => {} },
      );
      expect(replay).toMatchObject({ kind: "up-to-date" });
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(manifestPath, { force: true });
    }
  });

  test("fresh apply forces row level security on the new table (0056 hardening pattern; review F1)", async () => {
    // 0056 对全部 7 张既有企业表除 ENABLE 外还 FORCE（0056:137-143）；
    // 新表必须沿用同一硬化模式，否则表属主查询会绕过 RLS。
    const rows = (await rawClient`
      select relrowsecurity, relforcerowsecurity
      from pg_class
      where relname = 'enterprise_workspace_memberships'`) as Array<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  test("the migration is expand-only: exactly one new table, no existing table or policy changed", async () => {
    const tableRows = (await rawClient`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`) as Array<{
      table_name: string;
    }>;
    const currentTables = tableRows.map((row) => row.table_name);
    // MT003 工具的 mt_task_migration_journal 是工具自有表（非业务表），
    // 已在基线之后由 apply/dry-run 链路创建；除它与新表外不得有任何差异。
    const expectedTables = new Set(baselineTables);
    expectedTables.add("enterprise_workspace_memberships");
    expectedTables.add("mt_task_migration_journal");
    expect(currentTables).toEqual([...expectedTables].sort());

    const policyRows = (await rawClient`
      select tablename, count(*)::int as n from pg_policies
      where schemaname = 'public' group by tablename`) as Array<{
      tablename: string;
      n: number;
    }>;
    for (const row of policyRows) {
      if (row.tablename === "enterprise_workspace_memberships") continue;
      expect(Number(row.n)).toBe(baselinePolicies[row.tablename] ?? 0);
    }

    // 既有表读写行为不变：老的公司成员关系仍可插入与读回。
    const inserted = await database
      .insert(enterpriseMemberships)
      .values({
        tenantId: fixture.tenantA,
        principalId: fixture.principalAMember,
        role: "auditor",
      })
      .onConflictDoNothing()
      .returning({ status: enterpriseMemberships.status });
    expect(inserted.length).toBeLessThanOrEqual(1);
    const readBack = await database
      .select({ status: enterpriseMemberships.status })
      .from(enterpriseMemberships)
      .where(
        sql`${enterpriseMemberships.tenantId} = ${fixture.tenantA}
          and ${enterpriseMemberships.principalId} = ${fixture.principalAMember}`,
      );
    expect(readBack.length).toBe(1);
    expect(readBack[0]?.status).toBe("active");
    await database.execute(sql`
      delete from enterprise_memberships
      where tenant_id = ${fixture.tenantA}
        and principal_id = ${fixture.principalAMember}
        and role = 'auditor'`);
  });
});

// ---------------------------------------------------------------------------
// 验收 (1)：同一 (公司, 团队, 主体) 唯一；重复插入被数据库拒绝
// ---------------------------------------------------------------------------

describe("issue #47 criterion 1: one membership per (tenant, workspace, principal)", () => {
  test("the first membership row inserts and reads back with defaults", async () => {
    const inserted = await database
      .insert(enterpriseWorkspaceMemberships)
      .values({
        tenantId: fixture.tenantA,
        workspaceId: fixture.workspaceA1,
        principalId: fixture.principalAMember,
      })
      .returning({
        status: enterpriseWorkspaceMemberships.status,
        epoch: enterpriseWorkspaceMemberships.epoch,
      });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.status).toBe("active");
    expect(inserted[0]?.epoch).toBe(1);
  });

  test("a duplicate (tenant, workspace, principal) insert is rejected by the database", async () => {
    const rejection = await rejectionOf(() =>
      database.insert(enterpriseWorkspaceMemberships).values({
        tenantId: fixture.tenantA,
        workspaceId: fixture.workspaceA1,
        principalId: fixture.principalAMember,
      }),
    );
    expect(rejection.code).toBe("23505");
    expect(rejection.message).toContain("enterprise_workspace_memberships");
  });
});

// ---------------------------------------------------------------------------
// 验收 (2)：复合关联同时证明 workspace 属 tenant、principal 是该 tenant 成员
// ---------------------------------------------------------------------------

describe("issue #47 criterion 2: composite foreign keys prove both containment facts", () => {
  test("a workspace from another company cannot be joined to this company's member", async () => {
    const rejection = await rejectionOf(() =>
      database.insert(enterpriseWorkspaceMemberships).values({
        tenantId: fixture.tenantA,
        workspaceId: fixture.workspaceB1,
        principalId: fixture.principalAMember,
      }),
    );
    // PostgreSQL 错误消息里约束名被截断到 63 字节，因此用未截断前缀区分
    // 是哪条复合外键拒绝：workspace 侧 vs principal 侧。
    expect(rejection.code).toBe("23503");
    expect(rejection.message).toContain("violates foreign key constraint");
    expect(rejection.message).toContain(
      "enterprise_workspace_memberships_tenant_id_workspace_id",
    );
  });

  test("a principal who is not a member of this company is rejected", async () => {
    const rejection = await rejectionOf(() =>
      database.insert(enterpriseWorkspaceMemberships).values({
        tenantId: fixture.tenantA,
        workspaceId: fixture.workspaceA2,
        principalId: fixture.principalBMember,
      }),
    );
    expect(rejection.code).toBe("23503");
    expect(rejection.message).toContain("violates foreign key constraint");
    expect(rejection.message).toContain(
      "enterprise_workspace_memberships_tenant_id_principal_id",
    );
  });

  test("the same principal joins a second team of the same company without conflict", async () => {
    // 多对多合法性：同公司跨团队是允许的（Spec §4.1）。
    const inserted = await database
      .insert(enterpriseWorkspaceMemberships)
      .values({
        tenantId: fixture.tenantA,
        workspaceId: fixture.workspaceA2,
        principalId: fixture.principalAMember,
      })
      .returning({ workspaceId: enterpriseWorkspaceMemberships.workspaceId });
    expect(inserted[0]?.workspaceId).toBe(fixture.workspaceA2);
  });
});

// ---------------------------------------------------------------------------
// 验收 (3)：active/suspended 状态；epoch 正整数且单调递增
// ---------------------------------------------------------------------------

describe("issue #47 criterion 3: status supports active/suspended and epoch is a positive monotonic version", () => {
  test("status accepts exactly active and suspended and nothing else", async () => {
    const suspended = await database
      .insert(enterpriseWorkspaceMemberships)
      .values({
        tenantId: fixture.tenantB,
        workspaceId: fixture.workspaceB1,
        principalId: fixture.principalBMember,
        status: "suspended",
      })
      .returning({ status: enterpriseWorkspaceMemberships.status });
    expect(suspended[0]?.status).toBe("suspended");

    const rejection = await rejectionOf(() =>
      database.insert(enterpriseWorkspaceMemberships).values({
        tenantId: fixture.tenantA,
        workspaceId: fixture.workspaceA1,
        principalId: fixture.principalBMember,
        status: "revoked",
      }),
    );
    expect(rejection.code).toBe("23514");
    expect(rejection.message).toContain("enterprise_workspace_member_status");
  });

  test("epoch must be a positive integer", async () => {
    for (const epoch of [0, -1]) {
      const rejection = await rejectionOf(() =>
        database.insert(enterpriseWorkspaceMemberships).values({
          tenantId: fixture.tenantA,
          workspaceId: fixture.workspaceA1,
          principalId: fixture.principalAMember,
          epoch,
        }),
      );
      expect(rejection.code).toBe("23514");
      expect(rejection.message).toContain("enterprise_workspace_member_epoch");
    }
  });

  test("epoch strictly increases along the application write path (read current, write current + 1)", async () => {
    const key = {
      tenantId: fixture.tenantA,
      workspaceId: fixture.workspaceA1,
      principalId: fixture.principalAMember,
    };
    const observed: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const next = await nextEpoch(
        key.tenantId,
        key.workspaceId,
        key.principalId,
      );
      await database
        .update(enterpriseWorkspaceMemberships)
        .set({ epoch: next })
        .where(
          sql`${enterpriseWorkspaceMemberships.tenantId} = ${key.tenantId}
            and ${enterpriseWorkspaceMemberships.workspaceId} = ${key.workspaceId}
            and ${enterpriseWorkspaceMemberships.principalId} = ${key.principalId}`,
        );
      const rows = await membershipRows(key, { epoch: true });
      observed.push(Number(rows[0]?.epoch));
    }
    expect(observed).toEqual([2, 3, 4]);
    expect(
      observed.every((epoch) => Number.isInteger(epoch) && epoch > 0),
    ).toBe(true);
  });

  test("suspending keeps the row but the stored status flips to suspended", async () => {
    await database
      .update(enterpriseWorkspaceMemberships)
      .set({ status: "suspended" })
      .where(
        sql`${enterpriseWorkspaceMemberships.tenantId} = ${fixture.tenantA}
          and ${enterpriseWorkspaceMemberships.workspaceId} = ${fixture.workspaceA2}
          and ${enterpriseWorkspaceMemberships.principalId} = ${fixture.principalAMember}`,
      );
    const rows = await membershipRows(
      {
        tenantId: fixture.tenantA,
        workspaceId: fixture.workspaceA2,
        principalId: fixture.principalAMember,
      },
      { status: true },
    );
    expect(rows[0]?.status).toBe("suspended");
  });
});

// ---------------------------------------------------------------------------
// 受限角色可用性（brief：新表 RLS 按既有模式最小新增，使受限角色测试可用；
// 不改动其他表策略，全面 RLS 属 MT012）
// ---------------------------------------------------------------------------

describe("restricted capability roles can use the new table through its minimal RLS policies", () => {
  // postgres.js 的 begin 对内层查询错误会独立拒绝（用户 catch 不拦截），
  // 因此受限角色路径全部走会话级 SET ROLE/set_config + 顶层 catch。
  test("operator role can insert with its tenant context and cannot without it", async () => {
    try {
      await rlsClient.unsafe("reset role");
      await rlsClient.unsafe("set role ob_ent_operator");
      await rlsClient.unsafe("select set_config('app.tenant_id', '', false)");

      const denial = await rejectionOf(() =>
        rlsClient.unsafe(
          `insert into enterprise_workspace_memberships
             (tenant_id, workspace_id, principal_id)
           values ('${fixture.tenantA}', '${fixture.workspaceA1}', '${fixture.principalA2Member}')`,
        ),
      );
      // 无租户上下文必须被拒，且拒绝原因是 RLS（而非缺权限）。
      expect(denial.code).toBe("42501");
      expect(denial.message).toContain("row-level security");

      await rlsClient.unsafe(
        `select set_config('app.tenant_id', '${fixture.tenantA}', false)`,
      );
      await rlsClient.unsafe(
        `insert into enterprise_workspace_memberships
           (tenant_id, workspace_id, principal_id)
         values ('${fixture.tenantA}', '${fixture.workspaceA1}', '${fixture.principalA2Member}')`,
      );
      const stored = await rawClient`
        select count(*)::int as n from enterprise_workspace_memberships
        where tenant_id = ${fixture.tenantA}
          and workspace_id = ${fixture.workspaceA1}
          and principal_id = ${fixture.principalA2Member}`;
      expect(Number(stored[0]?.n)).toBe(1);
    } finally {
      await rlsClient.unsafe("reset role").catch(() => {});
      await rlsClient
        .unsafe("select set_config('app.tenant_id', '', false)")
        .catch(() => {});
    }
  });

  test("data role reads only its own memberships inside its tenant context", async () => {
    try {
      await rlsClient.unsafe("reset role");
      await rlsClient.unsafe("set role ob_ent_data");
      await rlsClient.unsafe(
        `select set_config('app.tenant_id', '${fixture.tenantA}', false), ` +
          `set_config('app.principal_id', '${fixture.principalA2Member}', false)`,
      );
      const seen = (await rlsClient.unsafe(
        `select workspace_id, tenant_id from enterprise_workspace_memberships`,
      )) as Array<Record<string, unknown>>;
      // data 角色只看到「自己」在上下文公司内的团队成员关系。
      expect(seen.map((row) => String(row.workspace_id))).toEqual([
        fixture.workspaceA1,
      ]);

      await rlsClient.unsafe(
        `select set_config('app.tenant_id', '${fixture.tenantB}', false)`,
      );
      const crossTenant = (await rlsClient.unsafe(
        `select workspace_id from enterprise_workspace_memberships`,
      )) as Array<Record<string, unknown>>;
      expect(crossTenant).toHaveLength(0);
    } finally {
      await rlsClient.unsafe("reset role").catch(() => {});
      await rlsClient
        .unsafe(
          "select set_config('app.tenant_id', '', false), set_config('app.principal_id', '', false)",
        )
        .catch(() => {});
    }
  });
});
