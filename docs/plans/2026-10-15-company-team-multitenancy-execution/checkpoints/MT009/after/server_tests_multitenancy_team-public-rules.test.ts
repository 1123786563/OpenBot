// server/tests/multitenancy/team-public-rules.test.ts
// MT009（Issue #52）：团队公共资源动作规则。
//
// 验收事实源（Issue #52 五条，逐条对应 describe；真实 PostgreSQL，全程
// 受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   (1) 团队成员可读取并运行团队公共 Bot；不能修改其配置、不能删除。
//   (2) 团队成员可检索团队公共知识库；不能上传、删除或改变其范围。
//   (3) read 通过不派生 run/write/delete/share/manage（逐动作测试）。
//   (4) 资源依赖（模型、凭据、知识范围）无效时拒绝并给出可解释原因，
//       不静默降级。
//   (5) 非团队成员即使拿到资源 ID 也被拒绝，且响应不泄露其存在性。
//
// 判定语义（与实现一一对应，见 server/src/enterprise/tenancy/
// team-public-rules.ts）：
//   - read 委托 MT008 的策略注册表（默认按租户 policy_revision 解析）——
//     内容读取与管理动作分别判定；
//   - 其余动作走本票的动作规则：团队公共使用路径 = 显式 'workspace'
//     可见性 + 同公司同团队 + 有效成员 + 生效策略版本属团队公共能力集
//     （workspace-v1）；run 仅限 bot 类且全部依赖有效；
//   - 对不可见者（非成员/跨公司/未发布/版本不含团队公共路径）一切动作
//     的拒绝都只有 RESOURCE_NOT_FOUND 一种形状——不泄露存在性；
//   - 对已通过可见性门（因此必然知道资源存在）的成员，管理动作拒绝为
//     TEAM_PUBLIC_ACTION_FORBIDDEN，依赖无效拒绝为 DEPENDENCY_INVALID
//     （指明依赖种类与引用）——可解释且不新增泄露。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
import {
  createTeamResourceActionService,
  decideTeamPublicActionWithoutDependencies,
  TEAM_PUBLIC_ACTION_IDS,
  type TeamResourceAction,
  type TeamResourceActionVerdict,
} from "../../src/enterprise/tenancy/team-public-rules";
import { rejectionOf } from "../support/pg-errors";
import type { FixtureIdentity } from "./support/fixture";
import {
  createTeamPublicRulesFixture,
  type TeamPublicRulesFixture,
} from "./support/team-public-rules";

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
      reason: `MT009 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const itDb = ((name, fn) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 判定形状
// ---------------------------------------------------------------------------

const ALLOW: TeamResourceActionVerdict = Object.freeze({ outcome: "allow" });
const DENY_NOT_FOUND: TeamResourceActionVerdict = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
});

const forbidden = (action: TeamResourceAction): TeamResourceActionVerdict =>
  Object.freeze({
    outcome: "deny",
    code: "TEAM_PUBLIC_ACTION_FORBIDDEN",
    action,
  });

const verdictJson = (verdict: TeamResourceActionVerdict): string =>
  JSON.stringify(verdict);

/**
 * Plain (non-SQLSTATE) business rejections — UNVERIFIED_SCOPE,
 * WORKSPACE_FORBIDDEN, POLICY_REVISION_UNSUPPORTED, ACTION_UNSUPPORTED —
 * surface as bare Errors; assert on their message without the SQLSTATE
 * walk that `rejectionOf` exists for.
 */
async function errorMessageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

/** MT009 prerequisite task migrations, dependency order (brief-pinned). */
const PREREQUISITE_TASKS = ["MT004", "MT008", "MT112", "MT012"] as const;

// ---------------------------------------------------------------------------
// 套件级装配：前置迁移 + MT009 迁移 + 真实 fixture + 常设编排
// ---------------------------------------------------------------------------

let fixture: TeamPublicRulesFixture | undefined;
let dryRunOutcome: RunOutcome | undefined;
let applyOutcome: RunOutcome | undefined;

/** Standing arrangement ids (created once in beforeAll). */
let botA1: string;
let kbA1: string;
let docA1: string;
let privateBotA1: string;
let legacyBotA1: string;
let botA2: string;
let botB1: string;

async function applyTaskMigration(
  url: string,
  taskId: string,
): Promise<RunOutcome> {
  const manifestPath = join(
    tmpdir(),
    `mt009-manifest-${taskId}-${process.pid}-${randomUUID().slice(0, 8)}.json`,
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

beforeAll(async () => {
  const resolved = resolveTestDatabaseTarget(process.env);
  if (!resolved.ok) throw new Error(resolved.reason);
  const url = resolved.target.url;

  // 前置任务迁移（journal 幂等：fresh 库应用、已应用库 up-to-date），
  // 依赖序按 brief：MT004 → MT008 → MT112 → MT012。
  for (const taskId of PREREQUISITE_TASKS) {
    const outcome = await applyTaskMigration(url, taskId);
    if (outcome.kind === "refused") {
      throw new Error(`prerequisite ${taskId} refused: ${outcome.reason}`);
    }
  }

  // MT009：先 dry-run（诚实预览），再 apply。
  dryRunOutcome = await runMigrateTest(["migrate", "MT009"], {
    environment: { TEST_DATABASE_URL: url },
    out: () => {},
  });
  applyOutcome = await applyTaskMigration(url, "MT009");

  fixture = await createTeamPublicRulesFixture();

  // ---- 常设编排 ----------------------------------------------------------
  // company-a 生效版本 = workspace-v1（团队公共路径在该公司可用）；
  // company-b 保持 tenancy-v1（版本门用例的事实源）。
  const companyA = fixture.isolation.ids["company-a"];
  const companyB = fixture.isolation.ids["company-b"];
  await fixture.setTenantPolicyRevision(companyA, "workspace-v1");

  const teamA1 = fixture.teamOf("a1-other", "team-a1");
  const teamA2 = fixture.teamOf("a2-member", "team-a2");
  const teamB1 = fixture.teamOf("b1-member", "team-b1");

  botA1 = await fixture.createResource({
    tenantId: companyA,
    workspaceId: teamA1.workspaceId,
    kind: "bot",
    displayName: "Team A1 public bot",
  });
  kbA1 = await fixture.createResource({
    tenantId: companyA,
    workspaceId: teamA1.workspaceId,
    kind: "knowledge_base",
    displayName: "Team A1 public knowledge base",
  });
  docA1 = await fixture.createResource({
    tenantId: companyA,
    workspaceId: teamA1.workspaceId,
    kind: "document",
    displayName: "Team A1 public document",
  });
  privateBotA1 = await fixture.createResource({
    tenantId: companyA,
    workspaceId: teamA1.workspaceId,
    kind: "bot",
    displayName: "A1 member's private bot",
  });
  legacyBotA1 = await fixture.createResource({
    tenantId: companyA,
    workspaceId: teamA1.workspaceId,
    kind: "bot",
    displayName: "A1 legacy unmarked bot",
  });
  botA2 = await fixture.createResource({
    tenantId: companyA,
    workspaceId: teamA2.workspaceId,
    kind: "bot",
    displayName: "Team A2 public bot",
  });
  botB1 = await fixture.createResource({
    tenantId: companyB,
    workspaceId: teamB1.workspaceId,
    kind: "bot",
    displayName: "Team B1 public bot",
  });

  for (const id of [botA1, kbA1, docA1, botA2, botB1]) {
    const tenantId = id === botB1 ? companyB : companyA;
    await fixture.markVisibility({
      tenantId,
      resourceId: id,
      visibility: "workspace",
    });
  }
  await fixture.markVisibility({
    tenantId: companyA,
    resourceId: privateBotA1,
    visibility: "private",
  });
  // legacyBotA1 保持未标记（NULL）。

  // private/legacy bot 的显式 read 授权（验收 3 的事实源）。
  const a1OtherPrincipal = fixture.teamOf("a1-other", "team-a1").principalId;
  await fixture.addReadGrant({
    tenantId: companyA,
    resourceId: privateBotA1,
    principalId: a1OtherPrincipal,
  });
  await fixture.addReadGrant({
    tenantId: companyA,
    resourceId: legacyBotA1,
    principalId: a1OtherPrincipal,
  });

  // bot-a1 的有效依赖：一个模型 + 一个知识范围（指向团队公共知识库）。
  await fixture.addDependency({
    tenantId: companyA,
    resourceId: botA1,
    kind: "model",
    ref: "model-alpha",
  });
  await fixture.addDependency({
    tenantId: companyA,
    resourceId: botA1,
    kind: "knowledge",
    ref: kbA1,
  });
});

afterAll(async () => {
  await fixture?.dispose();
});

const service = () => createTeamResourceActionService(fixture!.data);

const scopeOf = async (
  identity: FixtureIdentity,
  teamKey: "team-a1" | "team-a2" | "team-b1",
) => {
  const team = fixture!.teamOf(identity, teamKey);
  return fixture!.scopeFor(identity, {
    tenantId: team.tenantId,
    workspaceId: team.workspaceId,
  });
};

// ---------------------------------------------------------------------------
// 迁移注册与 expand-only（票面约束：MT004/MT008/MT112/MT012 惯例）
// ---------------------------------------------------------------------------

describeDb("the MT009 task migration is registered and expand-only", () => {
  itDb("MT009 is a registered task whose plan is deterministic", () => {
    const plan = buildPlan("MT009");
    expect(plan.taskId).toBe("MT009");
    expect(plan.steps.map((step) => step.name)).toEqual([
      "0001_mt009_resource_dependency_table.sql",
      "0002_mt009_dependency_rls_policies.sql",
    ]);
    expect(manifestFor(plan)).toEqual(manifestFor(buildPlan("MT009")));
  });

  itDb(
    "dry-run previews honestly and apply converges (fresh or up-to-date)",
    () => {
      expect(dryRunOutcome).toMatchObject({
        kind: "dry-run",
        taskId: "MT009",
      });
      expect(["applied", "up-to-date"]).toContain(applyOutcome?.kind);
      if (
        dryRunOutcome?.kind === "dry-run" &&
        applyOutcome?.kind === "applied"
      ) {
        expect(dryRunOutcome.pending.map((step) => step.name)).toEqual([
          "0001_mt009_resource_dependency_table.sql",
          "0002_mt009_dependency_rls_policies.sql",
        ]);
      }
    },
  );

  itDb(
    "the plan only appends: one new dependency table with its own RLS, nothing else touched",
    () => {
      const statements = buildPlan("MT009").steps.flatMap(
        (step) => step.statements,
      );
      expect(statements.length).toBeGreaterThan(0);
      const touched = new Set<string>();
      for (const statement of statements) {
        // 逐语句动词锚定：每条语句都是完整字符串，禁令看语句首词，
        // 避免误伤子句（如 FK 的 ON UPDATE no action）。
        expect(statement).not.toMatch(/^\s*DROP\b/i);
        expect(statement).not.toMatch(/^\s*DELETE\b/i);
        expect(statement).not.toMatch(/^\s*UPDATE\b/i);
        expect(statement).not.toMatch(/^\s*TRUNCATE\b/i);
        expect(statement).not.toMatch(
          /^\s*ALTER TABLE "enterprise_resources"/i,
        );
        const created = /^CREATE TABLE "([a-z_]+)"/i.exec(statement);
        if (created) {
          touched.add(created[1]);
          expect(created[1]).toBe("enterprise_resource_dependencies");
          continue;
        }
        const altered = /^ALTER TABLE "([a-z_]+)"/i.exec(statement);
        if (altered) {
          touched.add(altered[1]);
          // 只允许新表自身的 FK 约束追加与 RLS 启用。
          expect(altered[1]).toBe("enterprise_resource_dependencies");
          expect(statement).toMatch(
            /^(ALTER TABLE "enterprise_resource_dependencies" (ADD CONSTRAINT|ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY))/i,
          );
          continue;
        }
        const policy = /^CREATE POLICY "([a-z_]+)" ON "([a-z_]+)"/i.exec(
          statement,
        );
        if (policy) {
          touched.add(policy[2]);
          expect(policy[2]).toBe("enterprise_resource_dependencies");
          continue;
        }
        const revoked = /^REVOKE ALL PRIVILEGES ON TABLE "([a-z_]+)"/i.exec(
          statement,
        );
        if (revoked) {
          touched.add(revoked[1]);
          expect(revoked[1]).toBe("enterprise_resource_dependencies");
          continue;
        }
        const granted =
          /^GRANT (SELECT|INSERT) ON TABLE "([a-z_]+)" TO (.+);?$/i.exec(
            statement,
          );
        if (granted) {
          touched.add(granted[2]);
          expect(granted[2]).toBe("enterprise_resource_dependencies");
          continue;
        }
        throw new Error(
          `MT009 plan statement outside the append shape: ${statement.slice(0, 120)}`,
        );
      }
      // 唯一被触碰的既有对象是 FK 引用目标 enterprise_resources（引用，
      // 不是修改）——断言里它只允许出现在 REFERENCES 子句中。
      expect([...touched].sort()).toEqual(["enterprise_resource_dependencies"]);
      const fk = statements.find((statement) => /REFERENCES/i.test(statement));
      expect(fk).toMatch(
        /REFERENCES "public"\."enterprise_resources"\("tenant_id","id"\) ON DELETE cascade/i,
      );
    },
  );

  itDb(
    "the decision side runs under the restricted data capability role, never a superuser",
    async () => {
      expect(await fixture!.dataCurrentUser()).toBe("ob_ent_data");
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 (1)：团队成员可读取并运行团队公共 Bot；不能修改配置、不能删除
// ---------------------------------------------------------------------------

describeDb(
  "issue #52 criterion 1: members read and run team-public bots; management actions are refused",
  () => {
    itDb(
      "an active team member without any grant reads and runs a team-public bot",
      async () => {
        const scope = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(scope, botA1, "read")).toEqual(
          ALLOW,
        );
        expect(await service().decideAction(scope, botA1, "run")).toEqual(
          ALLOW,
        );
      },
    );

    itDb(
      "the same member is refused config edits, deletion, sharing and management — per action",
      async () => {
        const scope = await scopeOf("a1-other", "team-a1");
        for (const action of [
          "write",
          "delete",
          "share",
          "manage",
          "upload",
        ] as const) {
          expect(await service().decideAction(scope, botA1, action)).toEqual(
            forbidden(action),
          );
        }
      },
    );

    itDb(
      "a suspended team member loses the team-public run path; the seam refuses re-issuing a scope; restoring membership restores the path",
      async () => {
        const before = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(before, botA1, "run")).toEqual(
          ALLOW,
        );

        await fixture!.setTeamMembershipStatus(
          "a1-other",
          "team-a1",
          "suspended",
        );
        try {
          // 停用前合法取证的 scope：事实已变，团队公共路径按当前事实拒绝。
          expect(await service().decideAction(before, botA1, "run")).toEqual(
            DENY_NOT_FOUND,
          );
          expect(await service().decideAction(before, botA1, "read")).toEqual(
            DENY_NOT_FOUND,
          );
          // 停用后新取证被 MT005 seam 直接拒绝（无存在性泄露的同一语义）。
          const refusal = await errorMessageOf(() =>
            scopeOf("a1-other", "team-a1"),
          );
          expect(refusal).toContain("WORKSPACE_FORBIDDEN");
        } finally {
          await fixture!.setTeamMembershipStatus(
            "a1-other",
            "team-a1",
            "active",
          );
        }

        const restored = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(restored, botA1, "run")).toEqual(
          ALLOW,
        );
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 (2)：团队成员可检索团队公共知识库；不能上传、删除或改变其范围
// ---------------------------------------------------------------------------

describeDb(
  "issue #52 criterion 2: members retrieve team-public knowledge bases; uploads and scope changes are refused",
  () => {
    itDb(
      "an active team member without any grant retrieves a team-public knowledge base",
      async () => {
        const scope = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(scope, kbA1, "read")).toEqual(
          ALLOW,
        );
      },
    );

    itDb(
      "upload, deletion, scope change and every other management action are refused — per action; run is not a knowledge-base action",
      async () => {
        const scope = await scopeOf("a1-other", "team-a1");
        for (const action of [
          "upload",
          "delete",
          "manage",
          "write",
          "share",
        ] as const) {
          expect(await service().decideAction(scope, kbA1, action)).toEqual(
            forbidden(action),
          );
        }
        // 知识库没有运行规则：read 放行绝不派生 run（逐动作钉死）。
        expect(await service().decideAction(scope, kbA1, "run")).toEqual(
          forbidden("run"),
        );
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 (3)：read 通过不派生 run/write/delete/share/manage（逐动作测试）
// ---------------------------------------------------------------------------

describeDb(
  "issue #52 criterion 3: a passing read never derives run/write/delete/share/manage",
  () => {
    itDb(
      "a private bot with an explicit read grant: read passes via the grant path and every other action is refused per action",
      async () => {
        const scope = await scopeOf("a1-other", "team-a1");
        expect(
          await service().decideAction(scope, privateBotA1, "read"),
        ).toEqual(ALLOW);
        expect(
          await service().decideAction(scope, privateBotA1, "run"),
        ).toEqual(DENY_NOT_FOUND);
        for (const action of [
          "write",
          "delete",
          "share",
          "manage",
          "upload",
        ] as const) {
          expect(
            await service().decideAction(scope, privateBotA1, action),
          ).toEqual(DENY_NOT_FOUND);
        }
      },
    );

    itDb(
      "a legacy unmarked bot with an explicit read grant behaves identically: read only",
      async () => {
        const scope = await scopeOf("a1-other", "team-a1");
        expect(
          await service().decideAction(scope, legacyBotA1, "read"),
        ).toEqual(ALLOW);
        expect(await service().decideAction(scope, legacyBotA1, "run")).toEqual(
          DENY_NOT_FOUND,
        );
        for (const action of [
          "write",
          "delete",
          "share",
          "manage",
          "upload",
        ] as const) {
          expect(
            await service().decideAction(scope, legacyBotA1, action),
          ).toEqual(DENY_NOT_FOUND);
        }
      },
    );

    itDb(
      "a team-public document: read passes through the team-public path and run is still refused (no kind rule derives run from read)",
      async () => {
        const scope = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(scope, docA1, "read")).toEqual(
          ALLOW,
        );
        expect(await service().decideAction(scope, docA1, "run")).toEqual(
          forbidden("run"),
        );
      },
    );

    itDb(
      "the schema itself refuses individual run grants: the action column admits 'read' only",
      async () => {
        const team = fixture!.teamOf("a1-other", "team-a1");
        const rejection = await rejectionOf(() =>
          fixture!.operator.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('app.tenant_id', ${team.tenantId}, true)`,
            );
            await tx.execute(sql`
              insert into enterprise_resource_grants
                (tenant_id, resource_id, principal_id, action)
              values (${team.tenantId}, ${botA1}, ${team.principalId}, 'run')
            `);
          }),
        );
        expect(rejection.code).toBe("23514");
        expect(rejection.message).toContain("enterprise_grant_action");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 (4)：依赖无效时拒绝并给出可解释原因，不静默降级
// ---------------------------------------------------------------------------

describeDb(
  "issue #52 criterion 4: invalid dependencies refuse the run with an explainable reason",
  () => {
    itDb(
      "a team-public bot whose model and knowledge dependencies are all valid runs",
      async () => {
        const companyA = fixture!.isolation.ids["company-a"];
        const team = fixture!.teamOf("a1-other", "team-a1");
        const bot = await fixture!.createResource({
          tenantId: companyA,
          workspaceId: team.workspaceId,
          kind: "bot",
          displayName: "fully wired bot",
        });
        await fixture!.markVisibility({
          tenantId: companyA,
          resourceId: bot,
          visibility: "workspace",
        });
        await fixture!.addDependency({
          tenantId: companyA,
          resourceId: bot,
          kind: "model",
          ref: "model-ok",
        });
        await fixture!.addDependency({
          tenantId: companyA,
          resourceId: bot,
          kind: "credential",
          ref: "cred-ok",
        });
        await fixture!.addDependency({
          tenantId: companyA,
          resourceId: bot,
          kind: "knowledge",
          ref: kbA1,
        });
        const scope = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(scope, bot, "run")).toEqual(ALLOW);
      },
    );

    itDb(
      "an invalid model dependency refuses the run and names the dependency kind and reference",
      async () => {
        const companyA = fixture!.isolation.ids["company-a"];
        const team = fixture!.teamOf("a1-other", "team-a1");
        const bot = await fixture!.createResource({
          tenantId: companyA,
          workspaceId: team.workspaceId,
          kind: "bot",
          displayName: "bot with broken model",
        });
        await fixture!.markVisibility({
          tenantId: companyA,
          resourceId: bot,
          visibility: "workspace",
        });
        await fixture!.addDependency({
          tenantId: companyA,
          resourceId: bot,
          kind: "model",
          ref: "model-decommissioned",
          status: "invalid",
        });
        const scope = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(scope, bot, "run")).toEqual({
          outcome: "deny",
          code: "DEPENDENCY_INVALID",
          dependencyKind: "model",
          dependencyRef: "model-decommissioned",
        });
      },
    );

    itDb(
      "an invalid credential dependency refuses the run the same explainable way",
      async () => {
        const companyA = fixture!.isolation.ids["company-a"];
        const team = fixture!.teamOf("a1-other", "team-a1");
        const bot = await fixture!.createResource({
          tenantId: companyA,
          workspaceId: team.workspaceId,
          kind: "bot",
          displayName: "bot with broken credential",
        });
        await fixture!.markVisibility({
          tenantId: companyA,
          resourceId: bot,
          visibility: "workspace",
        });
        await fixture!.addDependency({
          tenantId: companyA,
          resourceId: bot,
          kind: "credential",
          ref: "cred-revoked",
          status: "invalid",
        });
        const scope = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(scope, bot, "run")).toEqual({
          outcome: "deny",
          code: "DEPENDENCY_INVALID",
          dependencyKind: "credential",
          dependencyRef: "cred-revoked",
        });
      },
    );

    itDb(
      "a knowledge dependency pointing at a deleted knowledge base refuses the run and names the broken scope",
      async () => {
        const companyA = fixture!.isolation.ids["company-a"];
        const team = fixture!.teamOf("a1-other", "team-a1");
        const deadKb = await fixture!.createResource({
          tenantId: companyA,
          workspaceId: team.workspaceId,
          kind: "knowledge_base",
          displayName: "deleted knowledge base",
        });
        await fixture!.markVisibility({
          tenantId: companyA,
          resourceId: deadKb,
          visibility: "workspace",
        });
        // 软删除（域内唯一的删除形态）：status='deleted'。受限角色没有
        // status 列的 UPDATE 授权（operator 只有 MT008 的 visibility 列），
        // 这里用披露的 setup 替身安排事实；判定侧照旧走受限 data 角色。
        await fixture!.softDeleteResource({
          tenantId: companyA,
          resourceId: deadKb,
        });
        const bot = await fixture!.createResource({
          tenantId: companyA,
          workspaceId: team.workspaceId,
          kind: "bot",
          displayName: "bot with broken knowledge scope",
        });
        await fixture!.markVisibility({
          tenantId: companyA,
          resourceId: bot,
          visibility: "workspace",
        });
        await fixture!.addDependency({
          tenantId: companyA,
          resourceId: bot,
          kind: "knowledge",
          ref: deadKb,
        });
        const scope = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(scope, bot, "run")).toEqual({
          outcome: "deny",
          code: "DEPENDENCY_INVALID",
          dependencyKind: "knowledge",
          dependencyRef: deadKb,
        });
      },
    );

    itDb(
      "a knowledge dependency pointing at a nonexistent reference refuses the run without guessing",
      async () => {
        const companyA = fixture!.isolation.ids["company-a"];
        const team = fixture!.teamOf("a1-other", "team-a1");
        const bot = await fixture!.createResource({
          tenantId: companyA,
          workspaceId: team.workspaceId,
          kind: "bot",
          displayName: "bot with dangling knowledge scope",
        });
        await fixture!.markVisibility({
          tenantId: companyA,
          resourceId: bot,
          visibility: "workspace",
        });
        await fixture!.addDependency({
          tenantId: companyA,
          resourceId: bot,
          kind: "knowledge",
          ref: `${companyA}-kb-never-existed`,
        });
        const scope = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(scope, bot, "run")).toEqual({
          outcome: "deny",
          code: "DEPENDENCY_INVALID",
          dependencyKind: "knowledge",
          dependencyRef: `${companyA}-kb-never-existed`,
        });
      },
    );

    itDb(
      "a bot with no declared dependencies runs (no dependency, nothing to degrade silently)",
      async () => {
        const companyA = fixture!.isolation.ids["company-a"];
        const team = fixture!.teamOf("a1-other", "team-a1");
        const bot = await fixture!.createResource({
          tenantId: companyA,
          workspaceId: team.workspaceId,
          kind: "bot",
          displayName: "dependency-free bot",
        });
        await fixture!.markVisibility({
          tenantId: companyA,
          resourceId: bot,
          visibility: "workspace",
        });
        const scope = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(scope, bot, "run")).toEqual(ALLOW);
      },
    );

    itDb(
      "a bot whose own dependencies are broken is unaffected by another bot's dependency rows",
      async () => {
        const companyA = fixture!.isolation.ids["company-a"];
        const team = fixture!.teamOf("a1-other", "team-a1");
        const broken = await fixture!.createResource({
          tenantId: companyA,
          workspaceId: team.workspaceId,
          kind: "bot",
          displayName: "broken bot",
        });
        const healthy = await fixture!.createResource({
          tenantId: companyA,
          workspaceId: team.workspaceId,
          kind: "bot",
          displayName: "healthy bot",
        });
        for (const bot of [broken, healthy]) {
          await fixture!.markVisibility({
            tenantId: companyA,
            resourceId: bot,
            visibility: "workspace",
          });
        }
        await fixture!.addDependency({
          tenantId: companyA,
          resourceId: broken,
          kind: "model",
          ref: "model-broken",
          status: "invalid",
        });
        await fixture!.addDependency({
          tenantId: companyA,
          resourceId: healthy,
          kind: "model",
          ref: "model-fine",
        });
        const scope = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(scope, healthy, "run")).toEqual(
          ALLOW,
        );
        expect(await service().decideAction(scope, broken, "run")).toEqual({
          outcome: "deny",
          code: "DEPENDENCY_INVALID",
          dependencyKind: "model",
          dependencyRef: "model-broken",
        });
      },
    );

    itDb(
      "an invalid dependency never leaks to a non-member: the refusal stays RESOURCE_NOT_FOUND",
      async () => {
        const companyA = fixture!.isolation.ids["company-a"];
        const team = fixture!.teamOf("a1-other", "team-a1");
        const bot = await fixture!.createResource({
          tenantId: companyA,
          workspaceId: team.workspaceId,
          kind: "bot",
          displayName: "broken bot behind the gate",
        });
        await fixture!.markVisibility({
          tenantId: companyA,
          resourceId: bot,
          visibility: "workspace",
        });
        await fixture!.addDependency({
          tenantId: companyA,
          resourceId: bot,
          kind: "model",
          ref: "model-hidden-broken",
          status: "invalid",
        });
        // a1a2-member 以 team-a2 身份提问：不是该团队成员。
        const outsider = await scopeOf("a1a2-member", "team-a2");
        expect(await service().decideAction(outsider, bot, "run")).toEqual(
          DENY_NOT_FOUND,
        );
      },
    );

    itDb(
      "dependency validity gates run only: management refusals do not consult dependencies",
      async () => {
        const companyA = fixture!.isolation.ids["company-a"];
        const team = fixture!.teamOf("a1-other", "team-a1");
        const bot = await fixture!.createResource({
          tenantId: companyA,
          workspaceId: team.workspaceId,
          kind: "bot",
          displayName: "broken bot, managed anyway",
        });
        await fixture!.markVisibility({
          tenantId: companyA,
          resourceId: bot,
          visibility: "workspace",
        });
        await fixture!.addDependency({
          tenantId: companyA,
          resourceId: bot,
          kind: "model",
          ref: "model-irrelevant",
          status: "invalid",
        });
        const scope = await scopeOf("a1-other", "team-a1");
        expect(await service().decideAction(scope, bot, "delete")).toEqual(
          forbidden("delete"),
        );
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 (5)：非团队成员即使拿到资源 ID 也被拒绝，且响应不泄露存在性
// ---------------------------------------------------------------------------

describeDb(
  "issue #52 criterion 5: non-members are refused with no existence leak",
  () => {
    itDb(
      "a cross-company member holding the resource id is refused on every action, byte-identically to a nonexistent resource",
      async () => {
        const scope = await scopeOf("b1-member", "team-b1");
        const ghost = `${fixture!.isolation.idPrefix}-ghost-${randomUUID().slice(0, 8)}`;
        for (const action of TEAM_PUBLIC_ACTION_IDS) {
          const againstReal = await service().decideAction(
            scope,
            botA1,
            action,
          );
          const againstGhost = await service().decideAction(
            scope,
            ghost,
            action,
          );
          expect(againstReal).toEqual(DENY_NOT_FOUND);
          // 不泄露存在性：对真实资源与对不存在资源的拒绝逐字节相同。
          expect(verdictJson(againstReal)).toBe(verdictJson(againstGhost));
        }
      },
    );

    itDb(
      "a same-company member of another team is refused on run and read, byte-identically to a nonexistent resource",
      async () => {
        const outsider = await scopeOf("a1a2-member", "team-a2");
        const ghost = `${fixture!.isolation.idPrefix}-ghost-${randomUUID().slice(0, 8)}`;
        for (const action of ["read", "run", "delete"] as const) {
          const againstReal = await service().decideAction(
            outsider,
            botA1,
            action,
          );
          const againstGhost = await service().decideAction(
            outsider,
            ghost,
            action,
          );
          expect(againstReal).toEqual(DENY_NOT_FOUND);
          expect(verdictJson(againstReal)).toBe(verdictJson(againstGhost));
        }
      },
    );

    itDb(
      "a company admin without team membership cannot even obtain a scope for the team (the seam refuses before any action)",
      async () => {
        const companyA = fixture!.isolation.ids["company-a"];
        const teamA1 = fixture!.teamOf("a1-other", "team-a1");
        const refusal = await errorMessageOf(() =>
          fixture!.scopeFor("company-admin", {
            tenantId: companyA,
            workspaceId: teamA1.workspaceId,
          }),
        );
        expect(refusal).toContain("WORKSPACE_FORBIDDEN");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 策略版本门：团队公共路径只在含该能力的生效版本下存在
// ---------------------------------------------------------------------------

describeDb(
  "the team-public usage path exists only under a policy version that carries it",
  () => {
    itDb(
      "under tenancy-v1 (company-b default) a team-public bot stays invisible to its own team member: read and run are RESOURCE_NOT_FOUND",
      async () => {
        const scope = await scopeOf("b1-member", "team-b1");
        expect(await service().decideAction(scope, botB1, "read")).toEqual(
          DENY_NOT_FOUND,
        );
        expect(await service().decideAction(scope, botB1, "run")).toEqual(
          DENY_NOT_FOUND,
        );
      },
    );

    itDb(
      "after the tenant resolves workspace-v1 the same member reads and runs the same bot (default resolution, no per-call override)",
      async () => {
        const companyB = fixture!.isolation.ids["company-b"];
        await fixture!.setTenantPolicyRevision(companyB, "workspace-v1");
        try {
          const scope = await scopeOf("b1-member", "team-b1");
          expect(await service().decideAction(scope, botB1, "read")).toEqual(
            ALLOW,
          );
          expect(await service().decideAction(scope, botB1, "run")).toEqual(
            ALLOW,
          );
        } finally {
          await fixture!.setTenantPolicyRevision(companyB, "tenancy-v1");
        }
        const scope = await scopeOf("b1-member", "team-b1");
        expect(await service().decideAction(scope, botB1, "run")).toEqual(
          DENY_NOT_FOUND,
        );
      },
    );

    itDb(
      "an explicit tenancy-v1 override on a workspace-v1 tenant hides the team-public path identically",
      async () => {
        const scope = await scopeOf("a1-other", "team-a1");
        expect(
          await service().decideAction(scope, botA1, "read", {
            policyVersion: "tenancy-v1",
          }),
        ).toEqual(DENY_NOT_FOUND);
        expect(
          await service().decideAction(scope, botA1, "run", {
            policyVersion: "tenancy-v1",
          }),
        ).toEqual(DENY_NOT_FOUND);
      },
    );

    itDb(
      "an unregistered policy version is refused loudly, never guessed (read and run alike)",
      async () => {
        const scope = await scopeOf("a1-other", "team-a1");
        for (const action of ["read", "run"] as const) {
          const refusal = await errorMessageOf(() =>
            service().decideAction(scope, botA1, action, {
              policyVersion: "workspace-v0-does-not-exist",
            }),
          );
          expect(refusal).toContain("POLICY_REVISION_UNSUPPORTED");
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 纯判定矩阵：在伪造事实层面逐条件钉死门规则（与 RLS 解耦的独立防线）
// ---------------------------------------------------------------------------

describeDb(
  "the pure team-public action gate judged on fabricated facts",
  () => {
    /** 合法团队公共事实基线（全部门条件成立，run 待依赖检查）。 */
    const soundFacts = () => ({
      scope: {
        tenantId: "tenant-a",
        workspaceId: "team-a1",
        principalId: "principal-1",
      },
      tenantPolicyRevision: "workspace-v1",
      resource: {
        tenantId: "tenant-a",
        workspaceId: "team-a1",
        kind: "bot",
        visibility: "workspace" as const,
        status: "active" as const,
        revision: 1,
        aclEpoch: 1,
      },
      workspaceMembership: { status: "active" as const },
    });

    itDb(
      "sound team-public facts: run proceeds to the dependency check, management actions are forbidden",
      () => {
        const run = decideTeamPublicActionWithoutDependencies(
          "run",
          soundFacts(),
          "workspace-v1",
        );
        expect(run).toEqual({ kind: "requires-dependency-check" });
        expect(
          decideTeamPublicActionWithoutDependencies(
            "delete",
            soundFacts(),
            "workspace-v1",
          ),
        ).toEqual({ kind: "verdict", verdict: forbidden("delete") });
      },
    );

    itDb(
      "cross-tenant facts are denied even though every other gate condition holds (defense line independent of RLS)",
      () => {
        const facts = soundFacts();
        const crossed = {
          ...facts,
          resource: { ...facts.resource, tenantId: "tenant-other" },
        };
        expect(
          decideTeamPublicActionWithoutDependencies(
            "run",
            crossed,
            "workspace-v1",
          ),
        ).toEqual({ kind: "verdict", verdict: DENY_NOT_FOUND });
      },
    );

    itDb(
      "each gate condition is individually necessary: visibility, liveness, team match, revision sanity, membership, capability version",
      () => {
        const base = soundFacts();
        const cases: readonly [string, object][] = [
          [
            "visibility not workspace",
            { resource: { ...base.resource, visibility: null } },
          ],
          [
            "resource deleted",
            { resource: { ...base.resource, status: "deleted" as const } },
          ],
          [
            "team mismatch",
            { resource: { ...base.resource, workspaceId: "team-a2" } },
          ],
          [
            "non-positive revision",
            { resource: { ...base.resource, revision: 0 } },
          ],
          [
            "membership suspended",
            { workspaceMembership: { status: "suspended" as const } },
          ],
          ["membership missing", { workspaceMembership: { status: null } }],
          [
            "tenancy-v1 lacks the capability",
            { tenantPolicyRevision: "tenancy-v1" },
          ],
        ];
        for (const [name, patch] of cases) {
          const facts = { ...base, ...patch } as typeof base;
          expect(
            decideTeamPublicActionWithoutDependencies(
              "run",
              facts,
              facts.tenantPolicyRevision,
            ),
            `gate case must deny: ${name}`,
          ).toEqual({ kind: "verdict", verdict: DENY_NOT_FOUND });
        }
      },
    );

    itDb(
      "run exists only for bot kinds; an unresolvable effective version is refused loudly",
      () => {
        const facts = soundFacts();
        expect(
          decideTeamPublicActionWithoutDependencies(
            "run",
            {
              ...facts,
              resource: { ...facts.resource, kind: "knowledge_base" },
            },
            "workspace-v1",
          ),
        ).toEqual({ kind: "verdict", verdict: forbidden("run") });
        const refusal = (() => {
          try {
            decideTeamPublicActionWithoutDependencies(
              "run",
              soundFacts(),
              "workspace-v0-does-not-exist",
            );
            return "no-refusal";
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        })();
        expect(refusal).toContain("POLICY_REVISION_UNSUPPORTED");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 信任边界与输入卫生
// ---------------------------------------------------------------------------

describeDb("trust boundary and input hygiene", () => {
  itDb("a forged scope is refused on every action path", async () => {
    const forged = {
      tenantId: fixture!.isolation.ids["company-a"],
      workspaceId: fixture!.teamOf("a1-other", "team-a1").workspaceId,
      principalId: fixture!.teamOf("a1-other", "team-a1").principalId,
      actorId: fixture!.isolation.ids["user-a1-other"],
      memberEpoch: 1,
      aclEpoch: 1,
      entrypoint: "web",
    } as never;
    for (const action of ["read", "run", "delete"] as const) {
      const refusal = await errorMessageOf(() =>
        service().decideAction(forged, botA1, action),
      );
      expect(refusal).toContain("UNVERIFIED_SCOPE");
    }
  });

  itDb(
    "an unknown action id is refused loudly, never mapped to a deny",
    async () => {
      const scope = await scopeOf("a1-other", "team-a1");
      const refusal = await errorMessageOf(() =>
        service().decideAction(scope, botA1, "deploy" as never),
      );
      expect(refusal).toContain("ACTION_UNSUPPORTED");
    },
  );

  itDb(
    "read verdicts pass the MT008 policy shape through unchanged (allow and deny alike)",
    async () => {
      const member = await scopeOf("a1-other", "team-a1");
      expect(await service().decideAction(member, botA1, "read")).toEqual({
        outcome: "allow",
      });
      const outsider = await scopeOf("a1a2-member", "team-a2");
      expect(await service().decideAction(outsider, botA1, "read")).toEqual({
        outcome: "deny",
        code: "RESOURCE_NOT_FOUND",
      });
    },
  );
});
