// server/tests/multitenancy/rls-core.test.ts
// MT012（Issue #55）：核心租户域表的 RLS 与受限业务角色兜底。
//
// 验收事实源（Issue #55 四条，逐条对应 describe）：
//   (1) 受限角色下跨公司 SELECT/UPDATE/DELETE 与跨公司外键关联被数据库
//       拒绝（行不可见 / 0 行受影响 / 23503 / 42501，全部在真实受限
//       PostgreSQL 上验证）。
//   (2) 团队公共、个人所有权与显式分享的数据库策略与应用层规则一致：
//       同一用例两侧对照——数据库侧（受限 data 角色事务内、经真实 RLS
//       过滤的事实上计算的判定谓词）与应用侧（resource-policy 注册表的
//       tenancy-v1 / workspace-v1 判定 + 生产 reader 路径）逐例一致；
//       tenancy-v1 永远不比数据库侧更宽。
//   (3) 事务结束后上下文被清除；连接复用不带上一次范围（提交/回滚均清
//       除 + MT012 交付的会话级上下文清理函数兜底）。
//   (4) 应用不使用可绕过 RLS 的角色作为普通数据访问入口；平台级机器读
//       权限（ob_ent_identity_operator）单独登记且不可用于普通业务接口。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（skipped 不计为通过），绝不
// 回退开发库。前置迁移（MT004/MT112/MT008）与 MT0012 迁移（既有表
// ENABLE/FORCE RLS 再断言 + 会话级上下文清理函数）都经 MT003 工具
// （migrate-test.ts）真实执行，本文件不自己 DDL。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { createDatabase } from "../../src/db/client";
import {
  createResourcePolicyService,
  createShippedResourcePolicyRegistry,
  TENANCY_V1_POLICY_ID,
  WORKSPACE_V1_POLICY_ID,
} from "../../src/enterprise/tenancy/resource-policy";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  ROLE_DATABASE_VARIABLES,
} from "../support/enterprise-database";
import { rejectionOf } from "../support/pg-errors";
import type { FixtureIdentity } from "./support/fixture";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
} from "./support/resource-policy";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT012 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseRuntimeDatabaseUrlFrom("directory", process.env);
    enterpriseRuntimeDatabaseUrlFrom("data", process.env);
    enterpriseRuntimeDatabaseUrlFrom("operator", process.env);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

/** MT012 的核心租户域表（全部带 tenant 维度或有自有范围策略）。 */
const CORE_TENANT_TABLES = [
  "enterprise_tenants",
  "enterprise_principals",
  "enterprise_memberships",
  "enterprise_workspaces",
  "enterprise_resources",
  "enterprise_resource_grants",
  "enterprise_security_events",
  "enterprise_workspace_memberships",
  "enterprise_deployment_anchors",
] as const;

/** 业务事务可能写入上下文的全部 app.* 键（策略与清理函数的公共清单）。 */
const CONTEXT_KEYS = [
  "app.tenant_id",
  "app.principal_id",
  "app.user_id",
  "app.workspace_id",
  "app.operation_id",
  "app.resource_id",
  "app.operator_principal_id",
] as const;

// ---------------------------------------------------------------------------
// 判定形状（与应用层 deny 的唯一对外形状一致）
// ---------------------------------------------------------------------------

type Verdict =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny"; readonly code: "RESOURCE_NOT_FOUND" };

const ALLOW: Verdict = Object.freeze({ outcome: "allow" });
const DENY_NOT_FOUND: Verdict = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
});

// ---------------------------------------------------------------------------
// 套件级装配：前置迁移 + MT012 迁移 + 真实 fixture
// ---------------------------------------------------------------------------

let fixture: ResourcePolicyFixture | undefined;
let dryRunOutcome: RunOutcome | undefined;
let applyOutcome: RunOutcome | undefined;
/** MT012 apply 前后必须逐字节一致的目录快照（expand-only 运行时证据）。 */
let policiesBefore = "";
let policiesAfter = "";
let grantsBefore = "";
let grantsAfter = "";

async function applyTaskMigration(
  url: string,
  taskId: string,
): Promise<RunOutcome> {
  const manifestPath = join(
    tmpdir(),
    `mt012-manifest-${taskId}-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifestFor(buildPlan(taskId)), null, 2)}\n`,
  );
  try {
    return await runMigrateTest(
      ["migrate", taskId, "--apply", "--manifest", manifestPath],
      { environment: { TEST_DATABASE_URL: url }, out: () => {} },
    );
  } finally {
    await rm(manifestPath, { force: true });
  }
}

/** 目录快照（策略计数 + 受限角色表级授权面）。只读目录，不触业务行。 */
async function catalogSnapshot(url: string): Promise<{
  policies: string;
  grants: string;
}> {
  const catalog = createDatabase(url, { max: 1 });
  try {
    const policies = (await catalog.execute(sql`
      select tablename, count(*)::int as policies
      from pg_policies
      where schemaname = 'public'
      group by tablename
      order by tablename
    `)) as unknown as Record<string, unknown>[];
    const grants = (await catalog.execute(sql`
      select grantee, table_name,
        string_agg(privilege_type, ',' order by privilege_type) as privileges
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name like 'enterprise_%'
        and grantee like 'ob_ent%'
      group by grantee, table_name
      order by grantee, table_name
    `)) as unknown as Record<string, unknown>[];
    return {
      policies: JSON.stringify(policies),
      grants: JSON.stringify(grants),
    };
  } finally {
    await catalog.$client.close();
  }
}

beforeAll(async () => {
  const resolved = resolveTestDatabaseTarget(process.env);
  if (!resolved.ok) throw new Error(resolved.reason);
  const url = resolved.target.url;

  // 前置任务迁移（journal 幂等：fresh 库应用、已应用库 up-to-date）。
  for (const taskId of ["MT004", "MT112", "MT008"] as const) {
    const outcome = await applyTaskMigration(url, taskId);
    if (outcome.kind === "refused") {
      throw new Error(`prerequisite ${taskId} refused: ${outcome.reason}`);
    }
  }

  // MT012：先 dry-run（诚实预览）+ apply 前目录快照，再 apply。
  dryRunOutcome = await runMigrateTest(["migrate", "MT012"], {
    environment: { TEST_DATABASE_URL: url },
    out: () => {},
  });
  const before = await catalogSnapshot(url);
  policiesBefore = before.policies;
  grantsBefore = before.grants;
  applyOutcome = await applyTaskMigration(url, "MT012");
  const after = await catalogSnapshot(url);
  policiesAfter = after.policies;
  grantsAfter = after.grants;

  fixture = await createResourcePolicyFixture();
});

afterAll(async () => {
  await fixture?.dispose();
});

// ---------------------------------------------------------------------------
// MT012 迁移注册与 expand-only（票面约束：MT004/MT008/MT112 惯例）
// ---------------------------------------------------------------------------

describeDb("the MT012 task migration is registered and expand-only", () => {
  itDb("MT012 is a registered task whose plan is deterministic", () => {
    const plan = buildPlan("MT012");
    expect(plan.taskId).toBe("MT012");
    expect(plan.steps.map((step) => step.name)).toEqual([
      "0001_mt012_core_rls_enable.sql",
      "0002_mt012_context_reset_function.sql",
    ]);
    expect(manifestFor(plan)).toEqual(manifestFor(buildPlan("MT012")));
  });

  itDb(
    "dry-run previews honestly and apply converges (fresh or up-to-date)",
    () => {
      expect(dryRunOutcome).toMatchObject({
        kind: "dry-run",
        taskId: "MT012",
      });
      expect(["applied", "up-to-date"]).toContain(applyOutcome?.kind);
      if (
        dryRunOutcome?.kind === "dry-run" &&
        applyOutcome?.kind === "applied"
      ) {
        expect(dryRunOutcome.pending.map((step) => step.name)).toEqual([
          "0001_mt012_core_rls_enable.sql",
          "0002_mt012_context_reset_function.sql",
        ]);
      }
    },
  );

  itDb(
    "the plan only appends: RLS re-assertions plus one new function, nothing else",
    () => {
      const statements = buildPlan("MT012").steps.flatMap(
        (step) => step.statements,
      );
      expect(statements.length).toBeGreaterThan(0);
      const rlsTables = new Set<string>();
      for (const statement of statements) {
        expect(statement).not.toMatch(/\bDROP\b/i);
        expect(statement).not.toMatch(/\bINSERT INTO\b/i);
        expect(statement).not.toMatch(/\bDELETE FROM\b/i);
        expect(statement).not.toMatch(/\bCREATE POLICY\b/i);
        expect(statement).not.toMatch(/\bDROP POLICY\b/i);
        // REVOKE 只允许出现在新函数上（收窄函数默认的 PUBLIC EXECUTE，
        // 不是剥夺任何既有对象授权）。
        if (/\bREVOKE\b/i.test(statement)) {
          expect(statement).toMatch(/^REVOKE EXECUTE ON FUNCTION/i);
        }
        // GRANT 只允许给新函数授予 EXECUTE。
        if (/\bGRANT\b/i.test(statement)) {
          expect(statement).toMatch(/^GRANT EXECUTE ON FUNCTION/i);
        }
        const rls =
          /^ALTER TABLE "([a-z_]+)" (ENABLE|FORCE) ROW LEVEL SECURITY;?$/.exec(
            statement,
          );
        if (rls) {
          rlsTables.add(rls[1]);
          continue;
        }
        expect(statement).toMatch(
          /^(CREATE OR REPLACE FUNCTION|REVOKE EXECUTE ON FUNCTION|GRANT EXECUTE ON FUNCTION)/i,
        );
      }
      expect([...rlsTables].sort()).toEqual([...CORE_TENANT_TABLES].sort());
    },
  );

  itDb(
    "existing policies and restricted-role table grants are byte-identical before and after apply",
    () => {
      // expand-only 的运行时证据：MT012 不新增/删除/改写任何既有策略或
      // 既有表级授权面（缺配置跳过时无从谈起；此处必须真实比对）。
      expect(policiesAfter).toBe(policiesBefore);
      expect(grantsAfter).toBe(grantsBefore);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 (1)：受限角色下跨公司 SELECT/UPDATE/DELETE 与跨公司外键关联被拒
// ---------------------------------------------------------------------------

describeDb(
  "issue #55 criterion 1: cross-company access is denied by the database under restricted roles",
  () => {
    itDb(
      "cross-company SELECT sees nothing on every core tenant table (operator role)",
      async () => {
        const companyB = fixture!.isolation.ids["company-b"];
        for (const table of CORE_TENANT_TABLES) {
          if (table === "enterprise_principals") continue; // 全局表：自有范围策略（见下一用例）
          // tenants 的公司维度列是 id，其余表是 tenant_id。
          const column = table === "enterprise_tenants" ? "id" : "tenant_id";
          const rows = await fixture!.isolation.queryRestricted(
            "operator",
            { tenantId: fixture!.isolation.ids["company-a"] },
            `select count(*)::int as n from ${table} where ${column} = $1`,
            [companyB],
          );
          expect(Number(rows[0]?.n), table).toBe(0);
        }
      },
    );

    itDb(
      "cross-company SELECT sees nothing under the data role either (including self-scoped tables)",
      async () => {
        const a = fixture!.isolation.ids["company-a"];
        const b = fixture!.isolation.ids["company-b"];
        const context = {
          tenantId: a,
          principalId: fixture!.isolation.ids["principal-a1-member"],
        };
        for (const table of [
          "enterprise_tenants",
          "enterprise_memberships",
          "enterprise_workspaces",
          "enterprise_resources",
          "enterprise_resource_grants",
          "enterprise_workspace_memberships",
        ]) {
          const column = table === "enterprise_tenants" ? "id" : "tenant_id";
          const rows = await fixture!.isolation.queryRestricted(
            "data",
            context,
            `select count(*)::int as n from ${table} where ${column} = $1`,
            [b],
          );
          expect(Number(rows[0]?.n), table).toBe(0);
        }
        // 全局表（principals）按自有范围策略隔离：B 公司成员的 principal 行
        // 对 A 公司事务不可见。
        const principals = await fixture!.isolation.queryRestricted(
          "data",
          context,
          "select count(*)::int as n from enterprise_principals where id = $1",
          [fixture!.isolation.ids["principal-b1-member"]],
        );
        expect(Number(principals[0]?.n)).toBe(0);
      },
    );

    itDb(
      "cross-company UPDATE touches nothing and the row survives",
      async () => {
        const a = fixture!.isolation.ids["company-a"];
        const b = fixture!.isolation.ids["company-b"];
        const bPrincipal = fixture!.isolation.ids["principal-b1-member"];
        const updated = await fixture!.isolation.queryRestricted(
          "operator",
          { tenantId: a },
          "update enterprise_memberships set status = 'suspended' where tenant_id = $1 and principal_id = $2 returning principal_id",
          [b, bPrincipal],
        );
        expect(updated).toEqual([]);
        const resources = await fixture!.isolation.queryRestricted(
          "operator",
          { tenantId: a },
          "update enterprise_resources set acl_epoch = acl_epoch + 1 where tenant_id = $1 returning id",
          [b],
        );
        expect(resources).toEqual([]);
        // 存活证明也走受限读（operator 在 B 上下文里可见自己的行）。
        const survivor = await fixture!.isolation.queryRestricted(
          "operator",
          { tenantId: b },
          "select status from enterprise_memberships where tenant_id = $1 and principal_id = $2",
          [b, bPrincipal],
        );
        expect(survivor[0]?.status).toBe("active");
      },
    );

    itDb(
      "cross-company DELETE removes nothing and the row survives; the data role cannot delete at all",
      async () => {
        const a = fixture!.isolation.ids["company-a"];
        const b = fixture!.isolation.ids["company-b"];
        const bPrincipal = fixture!.isolation.ids["principal-b1-member"];
        const deleted = await fixture!.isolation.queryRestricted(
          "operator",
          { tenantId: a },
          "delete from enterprise_resource_grants where tenant_id = $1 and principal_id = $2 returning resource_id",
          [b, bPrincipal],
        );
        expect(deleted).toEqual([]);
        const survivor = await fixture!.isolation.queryRestricted(
          "operator",
          { tenantId: b },
          "select count(*)::int as n from enterprise_resource_grants where tenant_id = $1 and principal_id = $2",
          [b, bPrincipal],
        );
        expect(Number(survivor[0]?.n)).toBeGreaterThan(0);
        const rejection = await rejectionOf(() =>
          fixture!.isolation.queryRestricted(
            "data",
            {
              tenantId: a,
              principalId: fixture!.isolation.ids["principal-a1-member"],
            },
            "delete from enterprise_resource_grants where tenant_id = $1 returning resource_id",
            [b],
          ),
        );
        expect(rejection.code).toBe("42501");
      },
    );

    itDb(
      "cross-company foreign-key associations are rejected by the database (23503)",
      async () => {
        const a = fixture!.isolation.ids["company-a"];
        const teamB1 = fixture!.isolation.ids["team-b1"];
        const resourceB1 = fixture!.isolation.ids["resource-b1"];
        const aPrincipal = fixture!.isolation.ids["principal-a1-member"];

        // (tenant A, team of company B) 复合 FK 不存在该配对 → 23503。
        const membershipInsert = await rejectionOf(() =>
          fixture!.isolation.queryRestricted(
            "operator",
            { tenantId: a },
            "insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) values ($1, $2, $3)",
            [a, teamB1, aPrincipal],
          ),
        );
        expect(membershipInsert.code).toBe("23503");

        // (tenant A, resource of company B) 同样不存在配对 → 23503。
        const grantInsert = await rejectionOf(() =>
          fixture!.isolation.queryRestricted(
            "operator",
            { tenantId: a },
            "insert into enterprise_resource_grants (tenant_id, resource_id, principal_id) values ($1, $2, $3)",
            [a, resourceB1, aPrincipal],
          ),
        );
        expect(grantInsert.code).toBe("23503");

        // 反向（B 上下文引用 A 的团队）同样拒绝。
        const b = fixture!.isolation.ids["company-b"];
        const teamA1 = fixture!.isolation.ids["team-a1"];
        const bPrincipal = fixture!.isolation.ids["principal-b1-member"];
        const reverse = await rejectionOf(() =>
          fixture!.isolation.queryRestricted(
            "operator",
            { tenantId: b },
            "insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) values ($1, $2, $3)",
            [b, teamA1, bPrincipal],
          ),
        );
        expect(reverse.code).toBe("23503");
      },
    );

    itDb(
      "re-pointing ownership columns needs privileges the restricted roles do not hold",
      async () => {
        const a = fixture!.isolation.ids["company-a"];
        const teamB1 = fixture!.isolation.ids["team-b1"];
        const resourceA1 = fixture!.isolation.ids["resource-a1"];
        const b = fixture!.isolation.ids["company-b"];
        const membershipRepoint = await rejectionOf(() =>
          fixture!.isolation.queryRestricted(
            "operator",
            { tenantId: a },
            "update enterprise_workspace_memberships set workspace_id = $1 where tenant_id = $2 returning principal_id",
            [teamB1, a],
          ),
        );
        expect(membershipRepoint.code).toBe("42501");
        const resourceRepoint = await rejectionOf(() =>
          fixture!.isolation.queryRestricted(
            "operator",
            { tenantId: a },
            "update enterprise_resources set tenant_id = $1 where id = $2 returning id",
            [b, resourceA1],
          ),
        );
        expect(resourceRepoint.code).toBe("42501");
      },
    );

    itDb(
      "the data and directory roles cannot write tenant rows at all",
      async () => {
        const a = fixture!.isolation.ids["company-a"];
        const teamA1 = fixture!.isolation.ids["team-a1"];
        const principal = fixture!.isolation.ids["principal-a1-member"];
        const context = { tenantId: a, principalId: principal };
        for (const [statement, values] of [
          [
            "insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name) values ($1, $2, $3, 'document', 'x')",
            [a, `mt012-forbidden-${principal.slice(-8)}`, teamA1],
          ],
          [
            "update enterprise_resources set display_name = 'x' where tenant_id = $1 returning id",
            [a],
          ],
          [
            "delete from enterprise_resource_grants where tenant_id = $1 returning resource_id",
            [a],
          ],
        ] as const) {
          const rejection = await rejectionOf(() =>
            fixture!.isolation.queryRestricted("data", context, statement, [
              ...values,
            ]),
          );
          expect(rejection.code).toBe("42501");
        }
        const directoryWrite = await rejectionOf(() =>
          fixture!.isolation.queryRestricted(
            "directory",
            context,
            "update enterprise_memberships set status = 'suspended' where tenant_id = $1 returning principal_id",
            [a],
          ),
        );
        expect(directoryWrite.code).toBe("42501");
      },
    );

    itDb(
      "cross-company denial does not leak existence (same shape as nonexistent)",
      async () => {
        const context = {
          tenantId: fixture!.isolation.ids["company-a"],
          principalId: fixture!.isolation.ids["principal-a1-member"],
        };
        const foreign = await fixture!.isolation.queryRestricted(
          "data",
          context,
          "select id from enterprise_resources where id = $1",
          [fixture!.isolation.ids["resource-b1"]],
        );
        const nonexistent = await fixture!.isolation.queryRestricted(
          "data",
          context,
          "select id from enterprise_resources where id = $1",
          ["mt012-no-such-resource"],
        );
        expect(foreign).toEqual([]);
        expect(nonexistent).toEqual([]);
        expect(JSON.stringify(foreign)).toBe(JSON.stringify(nonexistent));
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 (2)：数据库策略与应用层规则一致（同一用例两侧对照）
// ---------------------------------------------------------------------------

/**
 * 数据库侧判定：受限 data 角色事务内、经真实 RLS 过滤的行与事实上直接
 * 计算「应用规则等价谓词」——显式分享（own grant）或团队公共（visibility
 * = 'workspace' + 资源所属团队的有效成员资格）+ 同团队 + 活跃资源。
 * 行不可见（跨公司/无上下文）与谓词为假都折叠为同一个 deny 形状。
 */
async function dbSideRead(
  identity: FixtureIdentity,
  teamKey: "team-a1" | "team-a2" | "team-b1",
  resourceId: string,
): Promise<Verdict> {
  const team = fixture!.teamOf(identity, teamKey);
  const rows = await fixture!.isolation.queryRestricted(
    "data",
    {
      tenantId: team.tenantId,
      principalId: team.principalId,
      workspaceId: team.workspaceId,
    },
    `select
       (r.status = 'active'
         and (exists (select 1 from enterprise_resource_grants g
                      where g.tenant_id = r.tenant_id
                        and g.resource_id = r.id
                        and g.principal_id = $2)
              or (r.visibility = 'workspace'
                  and exists (select 1 from enterprise_workspace_memberships wm
                              where wm.tenant_id = r.tenant_id
                                and wm.workspace_id = r.workspace_id
                                and wm.principal_id = $2
                                and wm.status = 'active')))) as readable
     from enterprise_resources r
     where r.tenant_id = $1 and r.workspace_id = $3 and r.id = $4`,
    [team.tenantId, team.principalId, team.workspaceId, resourceId],
  );
  if (rows[0]?.readable !== true) return DENY_NOT_FOUND;
  return ALLOW;
}

/** 应用侧判定（resource-policy 注册表，两个已发布版本）。 */
async function appSideRead(
  identity: FixtureIdentity,
  teamKey: "team-a1" | "team-a2" | "team-b1",
  resourceId: string,
): Promise<{ tenancyV1: Verdict; workspaceV1: Verdict; readerStatus: number }> {
  const team = fixture!.teamOf(identity, teamKey);
  const scope = await fixture!.scopeFor(identity, {
    tenantId: team.tenantId,
    workspaceId: team.workspaceId,
  });
  const service = createResourcePolicyService(
    fixture!.data,
    createShippedResourcePolicyRegistry(),
  );
  const tenancyV1 = (await service.decide(scope, resourceId, {
    policyVersion: TENANCY_V1_POLICY_ID,
  })) as Verdict;
  const workspaceV1 = (await service.decide(scope, resourceId, {
    policyVersion: WORKSPACE_V1_POLICY_ID,
  })) as Verdict;
  const response = await fixture!.isolation.requestAs(identity, {
    method: "GET",
    path: `/resources/${encodeURIComponent(resourceId)}`,
    tenantId: team.tenantId,
    workspaceId: team.workspaceId,
  });
  return { tenancyV1, workspaceV1, readerStatus: response.status };
}

/**
 * 两侧对照一致性：数据库侧判定 == workspace-v1（已发布的超集版本）
 * 逐例相等；tenancy-v1 只能更窄（allow ⟹ 数据库侧 allow）；生产 reader
 * 路径跟 tenancy-v1 语义（200 仅当显式授权路径成立）。
 */
async function expectSidesAgree(
  identity: FixtureIdentity,
  teamKey: "team-a1" | "team-a2" | "team-b1",
  resourceId: string,
  expectations: { readerStatus: number },
): Promise<void> {
  const db = await dbSideRead(identity, teamKey, resourceId);
  const app = await appSideRead(identity, teamKey, resourceId);
  expect(db).toEqual(app.workspaceV1);
  if (app.tenancyV1.outcome === "allow") {
    expect(db).toEqual(ALLOW);
  }
  expect(app.readerStatus).toBe(expectations.readerStatus);
}

describeDb(
  "issue #55 criterion 2: database policies agree with application rules for the same use case",
  () => {
    itDb("explicit sharing allows the grantee on both sides", async () => {
      await expectSidesAgree(
        "a1-member",
        "team-a1",
        fixture!.isolation.ids["resource-a1"],
        {
          readerStatus: 200,
        },
      );
    });

    itDb(
      "personal ownership (own resource via own grant) allows on both sides",
      async () => {
        await expectSidesAgree(
          "a1-other",
          "team-a1",
          fixture!.isolation.ids["resource-a1-other"],
          { readerStatus: 200 },
        );
      },
    );

    itDb(
      "team-public resources allow an active member without a grant under workspace-v1 (db side agrees)",
      async () => {
        const tenantId = fixture!.isolation.ids["company-a"];
        const resourceId = fixture!.isolation.ids["resource-a1"];
        await fixture!.markVisibility({
          tenantId,
          resourceId,
          visibility: "workspace",
        });
        try {
          await expectSidesAgree("a1-other", "team-a1", resourceId, {
            readerStatus: 404,
          });
        } finally {
          await fixture!.markVisibility({
            tenantId,
            resourceId,
            visibility: null,
          });
        }
      },
    );

    itDb(
      "team-public stays hidden from another team of the same company on both sides",
      async () => {
        const tenantId = fixture!.isolation.ids["company-a"];
        const resourceId = fixture!.isolation.ids["resource-a1"];
        await fixture!.markVisibility({
          tenantId,
          resourceId,
          visibility: "workspace",
        });
        try {
          await expectSidesAgree("a2-member", "team-a2", resourceId, {
            readerStatus: 404,
          });
        } finally {
          await fixture!.markVisibility({
            tenantId,
            resourceId,
            visibility: null,
          });
        }
      },
    );

    itDb(
      "a suspended member loses the team-public path on both sides and regains it after restoration",
      async () => {
        const tenantId = fixture!.isolation.ids["company-a"];
        const resourceId = fixture!.isolation.ids["resource-a1"];
        const team = fixture!.teamOf("a1-other", "team-a1");
        // 应用侧 scope 在成员仍活跃时签发（停用后签发被资格门拒绝）；判定
        // 必须按判定时刻的当前事实重算——这正是两侧对照要钉的性质。
        const scope = await fixture!.scopeFor("a1-other", {
          tenantId: team.tenantId,
          workspaceId: team.workspaceId,
        });
        const service = createResourcePolicyService(
          fixture!.data,
          createShippedResourcePolicyRegistry(),
        );
        await fixture!.markVisibility({
          tenantId,
          resourceId,
          visibility: "workspace",
        });
        try {
          await fixture!.setTeamMembershipStatus(
            "a1-other",
            "team-a1",
            "suspended",
          );
          try {
            expect(await dbSideRead("a1-other", "team-a1", resourceId)).toEqual(
              DENY_NOT_FOUND,
            );
            // 应用侧：注册表版本同样拒绝（停用成员失去团队公共路径）。
            expect(
              await service.decide(scope, resourceId, {
                policyVersion: WORKSPACE_V1_POLICY_ID,
              }),
            ).toEqual(DENY_NOT_FOUND);
            // reader 的资格门先于资源存在性拒绝对外 403（不泄露资源存在性）。
            const response = await fixture!.isolation.requestAs("a1-other", {
              method: "GET",
              path: `/resources/${encodeURIComponent(resourceId)}`,
              tenantId: team.tenantId,
              workspaceId: team.workspaceId,
            });
            expect(response.status).toBe(403);
          } finally {
            await fixture!.setTeamMembershipStatus(
              "a1-other",
              "team-a1",
              "active",
            );
          }
          await expectSidesAgree("a1-other", "team-a1", resourceId, {
            readerStatus: 404,
          });
        } finally {
          await fixture!.markVisibility({
            tenantId,
            resourceId,
            visibility: null,
          });
        }
      },
    );

    itDb(
      "private marking never widens: non-owner denied on both sides, grantee still allowed",
      async () => {
        const tenantId = fixture!.isolation.ids["company-a"];
        const resourceId = fixture!.isolation.ids["resource-a1"];
        await fixture!.markVisibility({
          tenantId,
          resourceId,
          visibility: "private",
        });
        try {
          await expectSidesAgree("a1-other", "team-a1", resourceId, {
            readerStatus: 404,
          });
          await expectSidesAgree("a1-member", "team-a1", resourceId, {
            readerStatus: 200,
          });
        } finally {
          await fixture!.markVisibility({
            tenantId,
            resourceId,
            visibility: null,
          });
        }
      },
    );

    itDb(
      "unmarked resources stay grant-only on both sides (no automatic widening)",
      async () => {
        await expectSidesAgree(
          "a1-other",
          "team-a1",
          fixture!.isolation.ids["resource-a1"],
          {
            readerStatus: 404,
          },
        );
      },
    );

    itDb(
      "cross-company resources are invisible on the db side and denied on the app side, same shape as nonexistent",
      async () => {
        const resourceId = fixture!.isolation.ids["resource-a1"];
        // 数据库侧：B 公司上下文里 A 公司资源行不可见（与不存在的 id 同形）。
        const foreignRows = await fixture!.isolation.queryRestricted(
          "data",
          {
            tenantId: fixture!.isolation.ids["company-b"],
            principalId: fixture!.isolation.ids["principal-b1-member"],
            workspaceId: fixture!.isolation.ids["team-b1"],
          },
          "select id from enterprise_resources where id = $1",
          [resourceId],
        );
        const nonexistentRows = await fixture!.isolation.queryRestricted(
          "data",
          {
            tenantId: fixture!.isolation.ids["company-b"],
            principalId: fixture!.isolation.ids["principal-b1-member"],
            workspaceId: fixture!.isolation.ids["team-b1"],
          },
          "select id from enterprise_resources where id = $1",
          ["mt012-no-such-resource"],
        );
        expect(foreignRows).toEqual([]);
        expect(JSON.stringify(foreignRows)).toBe(
          JSON.stringify(nonexistentRows),
        );
        expect(await dbSideRead("b1-member", "team-b1", resourceId)).toEqual(
          DENY_NOT_FOUND,
        );
        const app = await appSideRead("b1-member", "team-b1", resourceId);
        expect(app.tenancyV1).toEqual(DENY_NOT_FOUND);
        expect(app.workspaceV1).toEqual(DENY_NOT_FOUND);
        expect(app.readerStatus).toBe(404);
      },
    );

    itDb(
      "a multi-company identity is allowed from their own company scope and denied from the other, on both sides",
      async () => {
        const resourceB1 = fixture!.isolation.ids["resource-b1"];
        await expectSidesAgree("multi-company", "team-b1", resourceB1, {
          readerStatus: 200,
        });
        const db = await dbSideRead("multi-company", "team-a1", resourceB1);
        expect(db).toEqual(DENY_NOT_FOUND);
        const app = await appSideRead("multi-company", "team-a1", resourceB1);
        expect(app.tenancyV1).toEqual(DENY_NOT_FOUND);
        expect(app.workspaceV1).toEqual(DENY_NOT_FOUND);
        expect(app.readerStatus).toBe(404);
      },
    );

    itDb(
      "explicit-sharing facts are visible only to the grantee under the data role",
      async () => {
        const context = {
          tenantId: fixture!.isolation.ids["company-a"],
          principalId: fixture!.isolation.ids["principal-a1-member"],
        };
        const own = await fixture!.isolation.queryRestricted(
          "data",
          context,
          "select resource_id from enterprise_resource_grants order by resource_id",
          [],
        );
        // a1-member 只持有 resource-a1 的 read 授权（fixture 事实）。
        expect(own.map((row) => row.resource_id)).toEqual([
          fixture!.isolation.ids["resource-a1"],
        ]);
        const others = await fixture!.isolation.queryRestricted(
          "data",
          context,
          "select count(*)::int as n from enterprise_resource_grants where principal_id <> $1",
          [context.principalId],
        );
        expect(Number(others[0]?.n)).toBe(0);
      },
    );

    itDb(
      "workspace-membership facts are own-principal only under the data role",
      async () => {
        for (const [identity, expectedCount] of [
          ["a1-member", 1],
          ["a1a2-member", 2],
        ] as const) {
          const principalId = fixture!.isolation.ids[`principal-${identity}`];
          const rows = await fixture!.isolation.queryRestricted(
            "data",
            {
              tenantId: fixture!.isolation.ids["company-a"],
              principalId,
            },
            "select count(*)::int as n from enterprise_workspace_memberships",
            [],
          );
          expect(Number(rows[0]?.n), identity).toBe(expectedCount);
        }
        // 他人的团队成员事实一行都不可见（谓词故意写"全部"，RLS 只放行自己）。
        const others = await fixture!.isolation.queryRestricted(
          "data",
          {
            tenantId: fixture!.isolation.ids["company-a"],
            principalId: fixture!.isolation.ids["principal-a1-member"],
          },
          "select count(*)::int as n from enterprise_workspace_memberships where principal_id <> $1",
          [fixture!.isolation.ids["principal-a1-member"]],
        );
        expect(Number(others[0]?.n)).toBe(0);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 (3)：事务结束后上下文被清除；连接复用不带上一次范围
// ---------------------------------------------------------------------------

describeDb(
  "issue #55 criterion 3: business context is cleared after transactions and pooled reuse carries no scope",
  () => {
    itDb(
      "after commit, the same pooled backend has every context key cleared and sees no rows (all three roles)",
      async () => {
        const companyA = fixture!.isolation.ids["company-a"];
        const companyB = fixture!.isolation.ids["company-b"];
        const contexts = {
          directory: {
            tenantId: companyA,
            principalId: fixture!.isolation.ids["principal-a1-member"],
          },
          data: {
            tenantId: companyA,
            principalId: fixture!.isolation.ids["principal-a1-member"],
            workspaceId: fixture!.isolation.ids["team-a1"],
          },
          operator: { tenantId: companyB },
        } as const;
        for (const role of ["directory", "data", "operator"] as const) {
          const context = contexts[role];
          // 带上下文的事务真实看到行（正控：上下文确实生效过）。
          const scoped = await fixture!.isolation.queryRestricted(
            role,
            context,
            "select count(*)::int as n from enterprise_memberships where tenant_id = $1",
            [context.tenantId],
          );
          expect(Number(scoped[0]?.n), role).toBeGreaterThan(0);
          // 同一连接复用（每角色池 max:1）：两次调用返回同一 backend PID。
          const pidA = await fixture!.isolation.queryRestricted(
            role,
            undefined,
            "select pg_backend_pid() as pid",
            [],
          );
          const pidB = await fixture!.isolation.queryRestricted(
            role,
            undefined,
            "select pg_backend_pid() as pid",
            [],
          );
          expect(pidB[0]?.pid, role).toBe(pidA[0]?.pid);
          // 无上下文事务：全部 app.* 键为空，受限表 0 行。
          const keys = CONTEXT_KEYS.map(
            (key) => `nullif(current_setting('${key}', true), '')`,
          ).join(" || '|' || ");
          const leak = await fixture!.isolation.queryRestricted(
            role,
            undefined,
            `select coalesce(${keys}, '') as context_keys`,
            [],
          );
          expect(leak[0]?.context_keys ?? "", role).toBe("");
          const rows = await fixture!.isolation.queryRestricted(
            role,
            undefined,
            "select count(*)::int as n from enterprise_memberships",
            [],
          );
          expect(Number(rows[0]?.n), role).toBe(0);
        }
      },
    );

    itDb(
      "after rollback with a live scope in place, the next transaction on the same connection is clean",
      async () => {
        const companyB = fixture!.isolation.ids["company-b"];
        await expect(
          fixture!.isolation.queryRestricted(
            "operator",
            { tenantId: companyB },
            "select 1 / 0 as boom",
            [],
          ),
        ).rejects.toThrow();
        const leak = await fixture!.isolation.queryRestricted(
          "operator",
          undefined,
          "select coalesce(nullif(current_setting('app.tenant_id', true), ''), '') as tenant_id, (select count(*)::int from enterprise_memberships) as member_rows",
          [],
        );
        expect(leak[0]?.tenant_id ?? "").toBe("");
        expect(Number(leak[0]?.member_rows)).toBe(0);
      },
    );

    itDb(
      "the MT012 context-reset function scrubs session-level leftovers (the pooled-connection fallback)",
      async () => {
        const companyB = fixture!.isolation.ids["company-b"];
        // 直接连接（非 fixture 事务封装）才能制造会话级残留——模拟应用层
        // 错误地写了 session 级上下文后，池回收前的兜底清理。
        for (const role of ["data", "operator"] as const) {
          const connection = createDatabase(
            enterpriseRuntimeDatabaseUrlFrom(role, process.env),
            { max: 1 },
          );
          try {
            await connection.execute(
              sql`select set_config('app.tenant_id', ${companyB}, false)`,
            );
            const leaked = (await connection.execute(
              sql`select (select count(*)::int from enterprise_resources) as resource_rows`,
            )) as unknown as Record<string, unknown>[];
            expect(Number(leaked[0]?.resource_rows), role).toBe(1);
            await connection.execute(
              sql`select public.ob_ent_reset_business_context()`,
            );
            const keys = CONTEXT_KEYS.map(
              (key) => `nullif(current_setting('${key}', true), '')`,
            ).join(" || '|' || ");
            const after = (await connection.execute(
              sql`select coalesce(${sql.raw(keys)}, '') as context_keys, (select count(*)::int from enterprise_resources) as resource_rows`,
            )) as unknown as Record<string, unknown>[];
            expect(after[0]?.context_keys ?? "", role).toBe("");
            expect(Number(after[0]?.resource_rows), role).toBe(0);
          } finally {
            await connection.$client.close();
          }
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 (4)：不用可绕过 RLS 的角色做普通数据访问；机器读权限单独登记
// ---------------------------------------------------------------------------

describeDb(
  "issue #55 criterion 4: no RLS-bypassing role serves normal data access; the platform machine-read role is registered separately and unusable for business interfaces",
  () => {
    itDb(
      "every role the application is configured with is a restricted, non-bypassing capability",
      async () => {
        const expectedCapabilities = {
          directory: "ob_ent_directory",
          data: "ob_ent_data",
          operator: "ob_ent_operator",
        } as const;
        const loginNames = Object.values(
          fixture!.isolation.restrictedRoles,
        ).map((entry) => entry.login);
        const expectedRoleNames = [
          ...Object.values(expectedCapabilities),
          ...loginNames,
          "ob_ent_identity_operator",
        ];
        const rows = await fixture!.isolation.queryRestricted(
          "data",
          undefined,
          "select rolname, rolsuper, rolbypassrls from pg_roles where rolname in (" +
            expectedRoleNames.map((_, index) => `$${index + 1}`).join(", ") +
            ") order by rolname",
          expectedRoleNames,
        );
        expect(rows.length).toBe(expectedRoleNames.length);
        for (const row of rows) {
          expect(row.rolsuper, String(row.rolname)).toBe(false);
          expect(row.rolbypassrls, String(row.rolname)).toBe(false);
        }
        for (const role of Object.keys(expectedCapabilities) as Array<
          keyof typeof expectedCapabilities
        >) {
          expect(fixture!.isolation.restrictedRoles[role].capability).toBe(
            expectedCapabilities[role],
          );
        }
      },
    );

    itDb(
      "every core tenant table has RLS enabled and forced (owner cannot bypass either)",
      async () => {
        const placeholders = CORE_TENANT_TABLES.map(
          (_, index) => `$${index + 1}`,
        ).join(", ");
        const rows = await fixture!.isolation.queryRestricted(
          "data",
          undefined,
          `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in (${placeholders}) order by c.relname`,
          [...CORE_TENANT_TABLES],
        );
        expect(rows.map((row) => row.relname)).toEqual(
          [...CORE_TENANT_TABLES].sort(),
        );
        for (const row of rows) {
          expect(row.relrowsecurity, String(row.relname)).toBe(true);
          expect(row.relforcerowsecurity, String(row.relname)).toBe(true);
        }
      },
    );

    itDb(
      "ob_ent_identity_operator exists, cannot log in, and holds zero privileges on every core tenant table",
      async () => {
        const identity = await fixture!.isolation.queryRestricted(
          "data",
          undefined,
          "select rolcanlogin from pg_roles where rolname = 'ob_ent_identity_operator'",
          [],
        );
        expect(identity.length).toBe(1);
        expect(identity[0]?.rolcanlogin).toBe(false);
        for (const table of CORE_TENANT_TABLES) {
          const privileges = await fixture!.isolation.queryRestricted(
            "data",
            undefined,
            "select has_table_privilege('ob_ent_identity_operator', $1, 'SELECT') as can_select, has_table_privilege('ob_ent_identity_operator', $1, 'INSERT') as can_insert, has_table_privilege('ob_ent_identity_operator', $1, 'UPDATE') as can_update, has_table_privilege('ob_ent_identity_operator', $1, 'DELETE') as can_delete",
            [table],
          );
          expect(privileges[0]?.can_select, table).toBe(false);
          expect(privileges[0]?.can_insert, table).toBe(false);
          expect(privileges[0]?.can_update, table).toBe(false);
          expect(privileges[0]?.can_delete, table).toBe(false);
        }
        // 也没有业务上下文工具（清理函数不授予机器读角色）。
        const functionPrivilege = await fixture!.isolation.queryRestricted(
          "data",
          undefined,
          "select has_function_privilege('ob_ent_identity_operator', 'public.ob_ent_reset_business_context()', 'EXECUTE') as can_execute",
          [],
        );
        expect(functionPrivilege[0]?.can_execute).toBe(false);
        // 运行时登录 URL 注册表里只有三个业务角色——机器读角色没有普通
        // 业务接口的登录入口（静态事实，与 support 清单单一来源）。
        expect(Object.keys(ROLE_DATABASE_VARIABLES).sort()).toEqual([
          "data",
          "directory",
          "operator",
        ]);
      },
    );

    itDb(
      "restricted roles can execute the context-reset function; it stays a business-role tool",
      async () => {
        for (const role of ["directory", "data", "operator"] as const) {
          const rows = await fixture!.isolation.queryRestricted(
            role,
            undefined,
            "select has_function_privilege(current_user, 'public.ob_ent_reset_business_context()', 'EXECUTE') as can_execute",
            [],
          );
          expect(rows[0]?.can_execute, role).toBe(true);
        }
      },
    );

    itDb(
      "the application assembly reaches enterprise data only through the verified restricted-role URLs",
      async () => {
        const source = await Bun.file(
          new URL("../../src/assembly/runtime.ts", import.meta.url),
        ).text();
        // 企业装配的三个 URL 全部来自受限角色配置变量，并逐一经
        // verifyXxxDatabase 能力校验（校验器拒绝 superuser/bypassrls/越权）。
        expect(source).toContain("config.enterpriseDirectoryDatabaseUrl");
        expect(source).toContain("config.enterpriseDataDatabaseUrl");
        expect(source).toContain("config.enterpriseOperatorDatabaseUrl");
        expect(source).toMatch(/verifyDirectoryDatabase\(/);
        expect(source).toMatch(/verifyDataDatabase\(/);
        expect(source).toMatch(/verifyOperatorDatabase\(/);
        // index.ts 中每个 createDatabase 调用点只能使用上述已验证变量或
        // 主应用/租户存储 URL——不允许出现绕过角色校验的企业直连。
        const callSites = [
          ...source.matchAll(/createDatabase\(\s*([A-Za-z0-9_.]+)\s*\)/g),
        ].map((match) => match[1]);
        expect(callSites.length).toBeGreaterThanOrEqual(3);
        const allowed = new Set([
          "config.databaseUrl",
          "directoryUrl",
          "dataUrl",
          "operatorUrl",
        ]);
        for (const site of callSites) {
          expect(allowed.has(site), site).toBe(true);
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 收尾核对：受限角色全程在岗
// ---------------------------------------------------------------------------

describeDb("closing check: restricted roles were in play", () => {
  itDb(
    "every restricted query ran as a capability role, never a superuser",
    async () => {
      for (const role of ["directory", "data", "operator"] as const) {
        const rows = await fixture!.isolation.queryRestricted(
          role,
          undefined,
          "select current_user as current_user, session_user as session_user",
          [],
        );
        expect(rows[0]?.current_user, role).toMatch(
          /^ob_ent_(directory|data|operator)$/,
        );
        expect(rows[0]?.session_user, role).not.toBe(rows[0]?.current_user);
      }
    },
  );
});
