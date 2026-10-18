// server/tests/multitenancy/bot-publish.test.ts
// MT017（Issue #60）：Bot 发布受众与旧 public 语义的显式迁移。
//
// 验收事实源（Issue #60 四条，逐条对应 describe；真实 PostgreSQL，全程受限
// ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：发布为团队公共后，团队成员按 MT009 规则可 read/run；非团队
//     成员不可见（canonical not-found 逐字节，不泄露存在性）。
//   验收 2：取消发布后团队成员立即失去使用权，已运行的会话按既有规则
//     处理且不泄露内容（调用时重验——发布前签发的 scope 取消后同样失效）。
//   验收 3：旧 public 资源在没有显式迁移动作时保持原暴露范围（对照测试
//     ——NULL 注册行 = MT008 冻结的「未标记/遗留」语义；暴露范围只随
//     显式动作变化）。
//   验收 4：发布受众不能设置为跨公司；此类请求被拒绝（响亮拒绝 + 零写入）。
//
// 结构决策（见 checkpoints/MT017/PLAN.md）：发布状态 = enterprise_resources
// 注册行（kind='bot'，visibility='workspace'），与 MT036 知识库注册同构；
// MT009 团队公共动作规则原样适用于已发布 Bot（不复刻判定）；取消发布 =
// visibility 回 NULL；显式迁移复用冻结的 MT008 manifest 入口。无新表/列/
// 授权——既有文件零改动，三个新文件（模块 + 测试 + 夹具）。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  TEAM_PUBLIC_ACTION_IDS,
  type TeamResourceAction,
} from "../../src/enterprise/tenancy/team-public-rules";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  type BotPublishFixture,
  type BotPublishIdentity,
  createBotPublishFixture,
} from "./support/bot-publish";

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
      reason: `MT017 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const itDb = ((name, fn) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 断言形状助手
// ---------------------------------------------------------------------------

const canonicalNotFoundJson = serializeNotFoundVerdict(notFoundVerdict());

const isCanonicalNotFound = (value: unknown): boolean =>
  isResourceNotFoundVerdict(value) &&
  JSON.stringify(value) === canonicalNotFoundJson;

const thrownMessage = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
};

const thrownMessageSync = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
};

/** 团队公共受众（唯一显式词表项；指定范围受众是后续票语义）。 */
const teamAudience = (tenantId: string, workspaceId: string) =>
  Object.freeze({ type: "team" as const, tenantId, workspaceId });

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: BotPublishFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
const generatedDirs: string[] = [];
let botCounter = 0;

/** 确定性的测试 Bot id/displayName 生成（避免用例间相互依赖具体值）。 */
const nextBot = (tag: string) => {
  botCounter += 1;
  return {
    agentId: `mt017-bot-${String(botCounter).padStart(3, "0")}-${tag}`,
    displayName: `MT017 Bot ${String(botCounter).padStart(3, "0")} ${tag}`,
  };
};

const principalOf = (identity: BotPublishIdentity) =>
  fixture.ids[`principal-${identity}`];

const scopeAs = (
  identity: BotPublishIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

/** 主库迁移链（brief 十四任务依赖序；幂等：applied | up-to-date）。 */
const MIGRATION_CHAIN = [
  "MT004",
  "MT008",
  "MT112",
  "MT012",
  "MT014",
  "MT010",
  "MT009",
  "MT077",
  "MT026",
  "MT076",
  "MT069",
  "MT016",
  "MT041",
  "MT027",
] as const;

beforeAll(async () => {
  if (!ENV.ok) return;

  // 迁移链按 brief 依赖序经 MT003 工具真实执行（幂等：fresh 库 applied、
  // 已应用库 up-to-date；MT017 本身不注册迁移任务——发布语义复用 MT008
  // 的 visibility 属性，无新 schema 对象）。
  const resolved = resolveTestDatabaseTarget(process.env);
  if (!resolved.ok) {
    throw new Error(`MT017 migration target refused: ${resolved.reason}`);
  }
  const migrationEnv = { TEST_DATABASE_URL: resolved.target.url };
  const dir = join("/tmp", `mt017-manifests-${randomUUID().slice(0, 8)}`);
  generatedDirs.push(dir);
  for (const task of MIGRATION_CHAIN) {
    const manifestPath = join(dir, `manifest-${task}.json`);
    await Bun.write(
      manifestPath,
      `${JSON.stringify(manifestFor(buildPlan(task)), null, 2)}\n`,
    );
    try {
      const applied: RunOutcome = await runMigrateTest(
        ["migrate", task, "--apply", "--manifest", manifestPath],
        { environment: migrationEnv, out: () => {} },
      );
      if (!["applied", "up-to-date"].includes(applied.kind)) {
        throw new Error(`${task} apply failed: ${JSON.stringify(applied)}`);
      }
    } finally {
      await rm(manifestPath, { force: true });
    }
  }

  fixture = await createBotPublishFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];

  // 公司 A 翻到 workspace-v1（团队公共使用语义生效；MT011/MT036 同款披露
  // stand-in——判定侧从不使用该通道）。公司 B 保持 tenancy-v1：跨公司
  // 不可见性与策略版本无关。
  await fixture.setTenantPolicyRevision(companyA, "workspace-v1");
}, 120000);

afterAll(async () => {
  for (const dir of generatedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  if (fixture) {
    await fixture.dispose();
  }
}, 60000);

// ---------------------------------------------------------------------------
// 验收 1：发布为团队公共后，团队成员按 MT009 规则可 read/run；非成员不可见
// ---------------------------------------------------------------------------

describeDb(
  "MT017 验收 1：发布后成员按 MT009 规则 read/run，非成员不可见",
  () => {
    let published = { agentId: "", displayName: "" };

    beforeAll(async () => {
      if (!ENV.ok) return;
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      published = nextBot("published");
      const created = await fixture.ownership.createBot(scope, {
        agentId: published.agentId,
        displayName: published.displayName,
        defaultConfig: { model: "gpt-4o", systemPrompt: "team helper" },
      });
      expect(created.outcome).toBe("allow");
      const verdict = await fixture.publish.publishBot(
        scope,
        published.agentId,
        teamAudience(companyA, teamA1),
      );
      expect(verdict.outcome).toBe("allow");
    }, 30000);

    itDb(
      "publish allow：publication 回显显式受众（tenant + workspace）与注册版本号",
      async () => {
        // beforeAll 里已发布成功；这里用幂等重发校验回显形状。
        const scope = await scopeAs("a1-owner", companyA, teamA1);
        const verdict = await fixture.publish.publishBot(
          scope,
          published.agentId,
          teamAudience(companyA, teamA1),
        );
        expect(verdict.outcome).toBe("allow");
        if (verdict.outcome !== "allow") throw new Error("unreachable");
        expect(verdict.publication.agentId).toBe(published.agentId);
        expect(verdict.publication.audience.type).toBe("team");
        expect(verdict.publication.audience.tenantId).toBe(companyA);
        expect(verdict.publication.audience.workspaceId).toBe(teamA1);
        expect(verdict.publication.revision).toBeGreaterThanOrEqual(1);
        expect(verdict.publication.aclEpoch).toBeGreaterThanOrEqual(1);
        expect(Object.isFrozen(verdict.publication)).toBe(true);
      },
    );

    itDb(
      "注册行真实落库：受限 data 角色读到 kind='bot' + visibility='workspace' + 归属团队",
      async () => {
        const rows = await fixture.readResourceRowsAsData(companyA);
        const row = rows.find(
          (candidate) => candidate.id === published.agentId,
        );
        expect(row).toBeDefined();
        expect(row?.kind).toBe("bot");
        expect(row?.visibility).toBe("workspace");
        expect(row?.workspaceId).toBe(teamA1);
        expect(row?.status).toBe("active");
      },
    );

    itDb(
      "发布前 delta：同团队无 grant 成员 read deny / run not-found（发布是唯一变化）",
      async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const unowned = nextBot("never-published");
        const ownerScope = await scopeAs("a1-owner", companyA, teamA1);
        await fixture.ownership.createBot(ownerScope, {
          agentId: unowned.agentId,
          displayName: unowned.displayName,
          defaultConfig: { model: "gpt-4o" },
        });
        const read = await fixture.actions.decideAction(
          scope,
          unowned.agentId,
          "read",
        );
        expect(read).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
        const run = await fixture.actions.decideAction(
          scope,
          unowned.agentId,
          "run",
        );
        expect(run.outcome).toBe("deny");
        expect(
          run.outcome === "deny" && run.code === "RESOURCE_NOT_FOUND",
        ).toBe(true);
      },
    );

    itDb(
      "同团队无 grant 成员 read 放行（MT008 判定，无需逐人授权）",
      async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const read = await fixture.actions.decideAction(
          scope,
          published.agentId,
          "read",
        );
        expect(read).toEqual({ outcome: "allow" });
      },
    );

    itDb("同团队无 grant 成员 run 放行（无依赖时）", async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const run = await fixture.actions.decideAction(
        scope,
        published.agentId,
        "run",
      );
      expect(run).toEqual({ outcome: "allow" });
    });

    itDb(
      "MT009 管理动作词表逐动作拒绝（write/upload/delete/share/manage → TEAM_PUBLIC_ACTION_FORBIDDEN）",
      async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const managementActions = TEAM_PUBLIC_ACTION_IDS.filter(
          (action: TeamResourceAction) => action !== "read" && action !== "run",
        );
        expect(managementActions.length).toBeGreaterThanOrEqual(5);
        for (const action of managementActions) {
          const verdict = await fixture.actions.decideAction(
            scope,
            published.agentId,
            action,
          );
          expect(verdict.outcome).toBe("deny");
          expect(
            verdict.outcome === "deny" &&
              verdict.code === "TEAM_PUBLIC_ACTION_FORBIDDEN" &&
              verdict.action === action,
          ).toBe(true);
        }
      },
    );

    itDb(
      "同公司他团队成员（a2）read/run = canonical not-found（逐字节，不泄露存在性）",
      async () => {
        const scope = await scopeAs("a2-member", companyA, teamA2);
        const read = await fixture.actions.decideAction(
          scope,
          published.agentId,
          "read",
        );
        expect(isCanonicalNotFound(read)).toBe(true);
        const run = await fixture.actions.decideAction(
          scope,
          published.agentId,
          "run",
        );
        expect(isCanonicalNotFound(run)).toBe(true);
      },
    );

    itDb(
      "另一家公司成员（b1）read/run = canonical not-found（与不存在 id 逐字节同形）",
      async () => {
        const scope = await scopeAs("b1-member", companyB, teamB1);
        const read = await fixture.actions.decideAction(
          scope,
          published.agentId,
          "read",
        );
        const missing = await fixture.actions.decideAction(
          scope,
          "mt017-never-existed-anywhere",
          "read",
        );
        expect(isCanonicalNotFound(read)).toBe(true);
        expect(JSON.stringify(read)).toBe(JSON.stringify(missing));
        const run = await fixture.actions.decideAction(
          scope,
          published.agentId,
          "run",
        );
        expect(isCanonicalNotFound(run)).toBe(true);
      },
    );

    itDb(
      "company-admin 无团队上下文连 scope 都无法铸造（seam 拒绝，无内容访问）",
      async () => {
        const message = await thrownMessage(() =>
          scopeAs("company-admin", companyA, teamA1),
        );
        expect(message).toBe("WORKSPACE_FORBIDDEN");
      },
    );

    itDb(
      "双团队成员 scope 钉死：a1a2 成员从 team-a2 scope 不可见、从 team-a1 scope 可见",
      async () => {
        const scopeA2 = await scopeAs("a1a2-member", companyA, teamA2);
        const fromA2 = await fixture.actions.decideAction(
          scopeA2,
          published.agentId,
          "read",
        );
        expect(isCanonicalNotFound(fromA2)).toBe(true);
        const scopeA1 = await scopeAs("a1a2-member", companyA, teamA1);
        const fromA1 = await fixture.actions.decideAction(
          scopeA1,
          published.agentId,
          "read",
        );
        expect(fromA1).toEqual({ outcome: "allow" });
      },
    );

    itDb(
      "MT009 依赖规则原样适用：坏依赖 run → DEPENDENCY_INVALID（read 不受影响）",
      async () => {
        await fixture.addDependency({
          tenantId: companyA,
          resourceId: published.agentId,
          kind: "model",
          ref: "mt017-broken-model",
          status: "invalid",
        });
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const run = await fixture.actions.decideAction(
          scope,
          published.agentId,
          "run",
        );
        expect(run).toEqual({
          outcome: "deny",
          code: "DEPENDENCY_INVALID",
          dependencyKind: "model",
          dependencyRef: "mt017-broken-model",
        });
        const read = await fixture.actions.decideAction(
          scope,
          published.agentId,
          "read",
        );
        expect(read).toEqual({ outcome: "allow" });
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 2：取消发布后团队成员立即失去使用权，已运行的会话按既有规则不泄露
// ---------------------------------------------------------------------------

describeDb("MT017 验收 2：取消发布立即失去使用权，已运行会话不泄露", () => {
  let unpublished = { agentId: "", displayName: "" };

  beforeAll(async () => {
    if (!ENV.ok) return;
    const ownerScope = await scopeAs("a1-owner", companyA, teamA1);
    unpublished = nextBot("unpublished");
    await fixture.ownership.createBot(ownerScope, {
      agentId: unpublished.agentId,
      displayName: unpublished.displayName,
      defaultConfig: { model: "gpt-4o", systemPrompt: "to be unpublished" },
    });
    const verdict = await fixture.publish.publishBot(
      ownerScope,
      unpublished.agentId,
      teamAudience(companyA, teamA1),
    );
    expect(verdict.outcome).toBe("allow");
  }, 30000);

  itDb(
    "unpublish allow：注册行 visibility 回 NULL（data 角色探针）",
    async () => {
      const ownerScope = await scopeAs("a1-owner", companyA, teamA1);
      const verdict = await fixture.publish.unpublishBot(
        ownerScope,
        unpublished.agentId,
      );
      expect(verdict).toEqual({ outcome: "allow" });
      const rows = await fixture.readResourceRowsAsData(companyA);
      const row = rows.find(
        (candidate) => candidate.id === unpublished.agentId,
      );
      expect(row).toBeDefined();
      expect(row?.visibility).toBeNull();
    },
  );

  itDb(
    "取消后成员 read/run 立即 canonical not-found（与从未发布 Bot 逐字节同形）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const read = await fixture.actions.decideAction(
        scope,
        unpublished.agentId,
        "read",
      );
      expect(isCanonicalNotFound(read)).toBe(true);
      const run = await fixture.actions.decideAction(
        scope,
        unpublished.agentId,
        "run",
      );
      expect(isCanonicalNotFound(run)).toBe(true);
    },
  );

  itDb(
    "发布前签发的 scope 取消后立即失效（调用时重验，无残留使用权）",
    async () => {
      // 成员 scope 在取消发布**之前**签发（模拟已运行会话的受信上下文）。
      const staleScope = await scopeAs("a1-member", companyA, teamA1);
      const ownerScope = await scopeAs("a1-owner", companyA, teamA1);
      const again = await fixture.publish.publishBot(
        ownerScope,
        unpublished.agentId,
        teamAudience(companyA, teamA1),
      );
      expect(again.outcome).toBe("allow");
      const before = await fixture.actions.decideAction(
        staleScope,
        unpublished.agentId,
        "run",
      );
      expect(before).toEqual({ outcome: "allow" });
      const verdict = await fixture.publish.unpublishBot(
        ownerScope,
        unpublished.agentId,
      );
      expect(verdict).toEqual({ outcome: "allow" });
      // 同一 stale scope、取消之后的下一次判定：立即失效。
      const after = await fixture.actions.decideAction(
        staleScope,
        unpublished.agentId,
        "run",
      );
      expect(isCanonicalNotFound(after)).toBe(true);
      const readAfter = await fixture.actions.decideAction(
        staleScope,
        unpublished.agentId,
        "read",
      );
      expect(isCanonicalNotFound(readAfter)).toBe(true);
    },
  );

  itDb("取消发布幂等：重复取消 allow；从未发布的 Bot 取消 allow", async () => {
    const ownerScope = await scopeAs("a1-owner", companyA, teamA1);
    const repeat = await fixture.publish.unpublishBot(
      ownerScope,
      unpublished.agentId,
    );
    expect(repeat).toEqual({ outcome: "allow" });
    const neverPublished = nextBot("never-published-at-all");
    await fixture.ownership.createBot(ownerScope, {
      agentId: neverPublished.agentId,
      displayName: neverPublished.displayName,
      defaultConfig: { model: "gpt-4o" },
    });
    const verdict = await fixture.publish.unpublishBot(
      ownerScope,
      neverPublished.agentId,
    );
    expect(verdict).toEqual({ outcome: "allow" });
  });

  itDb(
    "显式 grant 与团队公共路径独立：取消后持 grant 成员 read 仍 allow、run 仍不可见",
    async () => {
      const ownerScope = await scopeAs("a1-owner", companyA, teamA1);
      const granted = nextBot("granted-then-unpublished");
      await fixture.ownership.createBot(ownerScope, {
        agentId: granted.agentId,
        displayName: granted.displayName,
        defaultConfig: { model: "gpt-4o" },
      });
      const publish = await fixture.publish.publishBot(
        ownerScope,
        granted.agentId,
        teamAudience(companyA, teamA1),
      );
      expect(publish.outcome).toBe("allow");
      await fixture.addReadGrant({
        tenantId: companyA,
        resourceId: granted.agentId,
        principalId: principalOf("a1-member"),
      });
      const unpublish = await fixture.publish.unpublishBot(
        ownerScope,
        granted.agentId,
      );
      expect(unpublish).toEqual({ outcome: "allow" });
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const read = await fixture.actions.decideAction(
        scope,
        granted.agentId,
        "read",
      );
      expect(read).toEqual({ outcome: "allow" });
      const run = await fixture.actions.decideAction(
        scope,
        granted.agentId,
        "run",
      );
      expect(isCanonicalNotFound(run)).toBe(true);
    },
  );

  itDb(
    "同团队非 owner 发布/取消 = PUBLISH_FORBIDDEN（响亮拒绝；可见性门后不新增信息）",
    async () => {
      const memberScope = await scopeAs("a1-member", companyA, teamA1);
      const publish = await fixture.publish.publishBot(
        memberScope,
        unpublished.agentId,
        teamAudience(companyA, teamA1),
      );
      expect(publish).toEqual({ outcome: "deny", code: "PUBLISH_FORBIDDEN" });
      const unpublish = await fixture.publish.unpublishBot(
        memberScope,
        unpublished.agentId,
      );
      expect(unpublish).toEqual({
        outcome: "deny",
        code: "PUBLISH_FORBIDDEN",
      });
    },
  );

  itDb(
    "非成员/跨公司取消 = canonical not-found（逐字节，不泄露存在性）",
    async () => {
      const otherTeamScope = await scopeAs("a2-member", companyA, teamA2);
      const fromA2 = await fixture.publish.unpublishBot(
        otherTeamScope,
        unpublished.agentId,
      );
      expect(isCanonicalNotFound(fromA2)).toBe(true);
      const crossCompanyScope = await scopeAs("b1-member", companyB, teamB1);
      const fromB1 = await fixture.publish.unpublishBot(
        crossCompanyScope,
        unpublished.agentId,
      );
      expect(isCanonicalNotFound(fromB1)).toBe(true);
      const missing = await fixture.publish.unpublishBot(
        crossCompanyScope,
        "mt017-never-existed-anywhere",
      );
      expect(JSON.stringify(fromB1)).toBe(JSON.stringify(missing));
    },
  );

  itDb(
    "MT016 归属可见性不受发布/取消影响（对照钉死：两表面语义披露）",
    async () => {
      const memberScope = await scopeAs("a1-member", companyA, teamA1);
      // 取消发布后：团队公共使用路径已关闭（前序用例），但归属详情是
      // MT016 已验收语义——同团队成员仍能看到自己团队内的归属对象。
      const detail = await fixture.ownership.getBot(
        memberScope,
        unpublished.agentId,
      );
      expect(detail.outcome).toBe("allow");
      // 非成员两个表面都不可见。
      const otherTeamScope = await scopeAs("a2-member", companyA, teamA2);
      const fromA2 = await fixture.ownership.getBot(
        otherTeamScope,
        unpublished.agentId,
      );
      expect(isCanonicalNotFound(fromA2)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 3：旧 public 资源在没有显式迁移动作时保持原暴露范围（对照测试）
// ---------------------------------------------------------------------------

describeDb("MT017 验收 3：旧 public 保持原暴露范围（对照测试）", () => {
  let legacyPublic = "";
  let legacyGranted = "";

  beforeAll(async () => {
    if (!ENV.ok) return;
    // 旧 public 在企业域的表示：注册行存在但 visibility NULL（MT008 冻结
    // 语义「NULL = 未标记/遗留：行为 = 既有 grant 语义」）。遗留暴露面 =
    // 显式 grant（legacyGranted 上有一行；legacyPublic 无任何 grant）。
    legacyPublic = `mt017-legacy-public-${randomUUID().slice(0, 8)}`;
    legacyGranted = `mt017-legacy-granted-${randomUUID().slice(0, 8)}`;
    await fixture.seedResourceRow({
      tenantId: companyA,
      workspaceId: teamA1,
      id: legacyPublic,
      kind: "bot",
      displayName: "MT017 legacy public bot (no grant)",
    });
    await fixture.seedResourceRow({
      tenantId: companyA,
      workspaceId: teamA1,
      id: legacyGranted,
      kind: "bot",
      displayName: "MT017 legacy public bot (one legacy read grant)",
    });
    await fixture.addReadGrant({
      tenantId: companyA,
      resourceId: legacyGranted,
      principalId: principalOf("a1-member"),
    });
  }, 30000);

  itDb(
    "MT016 createBot 不产生任何注册行：新 Bot 在显式发布前对成员 read/run 不可见",
    async () => {
      const fresh = nextBot("fresh-created");
      const ownerScope = await scopeAs("a1-owner", companyA, teamA1);
      await fixture.ownership.createBot(ownerScope, {
        agentId: fresh.agentId,
        displayName: fresh.displayName,
        defaultConfig: { model: "gpt-4o" },
      });
      const rows = await fixture.readResourceRowsAsData(companyA);
      expect(rows.some((candidate) => candidate.id === fresh.agentId)).toBe(
        false,
      );
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const read = await fixture.actions.decideAction(
        scope,
        fresh.agentId,
        "read",
      );
      expect(read).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
      const run = await fixture.actions.decideAction(
        scope,
        fresh.agentId,
        "run",
      );
      expect(isCanonicalNotFound(run)).toBe(true);
    },
  );

  itDb(
    "旧 public 无显式迁移：无 grant 成员 read/run 不可见（暴露范围绝不自动变宽）",
    async () => {
      // a1-member 无 legacyPublic 的 grant；历史 public 标记不派生团队公共。
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const read = await fixture.actions.decideAction(
        scope,
        legacyPublic,
        "read",
      );
      expect(read).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
      const run = await fixture.actions.decideAction(
        scope,
        legacyPublic,
        "run",
      );
      expect(isCanonicalNotFound(run)).toBe(true);
    },
  );

  itDb(
    "对照面：持遗留 grant 成员 read 保持 allow（原暴露范围逐字保持）、run 不可见",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const read = await fixture.actions.decideAction(
        scope,
        legacyGranted,
        "read",
      );
      expect(read).toEqual({ outcome: "allow" });
      const run = await fixture.actions.decideAction(
        scope,
        legacyGranted,
        "run",
      );
      expect(isCanonicalNotFound(run)).toBe(true);
    },
  );

  itDb(
    "显式迁移（真实 MT008 manifest 入口）后成员 read/run 放行：delta 只来自显式动作",
    async () => {
      const report = await fixture.migrateLegacyToWorkspace(companyA, [
        legacyPublic,
      ]);
      expect(report.migrated).toEqual([legacyPublic]);
      expect(report.updatesExecuted).toBe(1);
      expect(report.privateKept).toEqual([]);
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const read = await fixture.actions.decideAction(
        scope,
        legacyPublic,
        "read",
      );
      expect(read).toEqual({ outcome: "allow" });
      const run = await fixture.actions.decideAction(
        scope,
        legacyPublic,
        "run",
      );
      expect(run).toEqual({ outcome: "allow" });
    },
  );

  itDb(
    "显式迁移不跨公司：B 公司成员对已迁移 A 公司 Bot 仍 canonical not-found",
    async () => {
      const scope = await scopeAs("b1-member", companyB, teamB1);
      const read = await fixture.actions.decideAction(
        scope,
        legacyPublic,
        "read",
      );
      expect(isCanonicalNotFound(read)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 4：发布受众不能设置为跨公司；此类请求被拒绝
// ---------------------------------------------------------------------------

describeDb("MT017 验收 4：受众校验与跨公司拒绝", () => {
  let guarded = { agentId: "", displayName: "" };

  beforeAll(async () => {
    if (!ENV.ok) return;
    const scope = await scopeAs("a1-owner", companyA, teamA1);
    guarded = nextBot("guarded");
    await fixture.ownership.createBot(scope, {
      agentId: guarded.agentId,
      displayName: guarded.displayName,
      defaultConfig: { model: "gpt-4o" },
    });
  }, 30000);

  itDb(
    "跨公司受众 deny PUBLISH_AUDIENCE_CROSS_COMPANY + 零写入（无注册行产生）",
    async () => {
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      const verdict = await fixture.publish.publishBot(
        scope,
        guarded.agentId,
        teamAudience(companyB, teamB1),
      );
      expect(verdict).toEqual({
        outcome: "deny",
        code: "PUBLISH_AUDIENCE_CROSS_COMPANY",
      });
      const rows = await fixture.readResourceRowsAsData(companyA);
      expect(rows.some((candidate) => candidate.id === guarded.agentId)).toBe(
        false,
      );
    },
  );

  itDb(
    "同公司跨团队受众 deny PUBLISH_AUDIENCE_NOT_OWNING_TEAM + 零写入",
    async () => {
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      const verdict = await fixture.publish.publishBot(
        scope,
        guarded.agentId,
        teamAudience(companyA, teamA2),
      );
      expect(verdict).toEqual({
        outcome: "deny",
        code: "PUBLISH_AUDIENCE_NOT_OWNING_TEAM",
      });
      const rows = await fixture.readResourceRowsAsData(companyA);
      expect(rows.some((candidate) => candidate.id === guarded.agentId)).toBe(
        false,
      );
    },
  );

  itDb(
    "缺受众 throw PUBLISH_AUDIENCE_REQUIRED（票面：必须选择明确受众）",
    async () => {
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      expect(
        await thrownMessage(() =>
          fixture.publish.publishBot(scope, guarded.agentId, undefined),
        ),
      ).toBe("PUBLISH_AUDIENCE_REQUIRED");
      expect(
        await thrownMessage(() =>
          fixture.publish.publishBot(scope, guarded.agentId, null),
        ),
      ).toBe("PUBLISH_AUDIENCE_REQUIRED");
    },
  );

  itDb(
    "受众形状坏 throw PUBLISH_AUDIENCE_INVALID（非对象/type 缺失/字段缺失/空串）",
    async () => {
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      for (const bad of [
        "team",
        42,
        {},
        { type: 7 },
        { type: "team" },
        { type: "team", tenantId: companyA },
        { type: "team", workspaceId: teamA1 },
        {
          type: "team",
          tenantId: "   ",
          workspaceId: teamA1,
        },
      ]) {
        expect(
          await thrownMessage(() =>
            fixture.publish.publishBot(scope, guarded.agentId, bad as never),
          ),
        ).toBe("PUBLISH_AUDIENCE_INVALID");
      }
      const rows = await fixture.readResourceRowsAsData(companyA);
      expect(rows.some((candidate) => candidate.id === guarded.agentId)).toBe(
        false,
      );
    },
  );

  itDb(
    "type='people' deny PUBLISH_AUDIENCE_UNSUPPORTED（指定范围受众是后续票语义）",
    async () => {
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      const verdict = await fixture.publish.publishBot(scope, guarded.agentId, {
        type: "people",
        tenantId: companyA,
        workspaceId: teamA1,
      } as never);
      expect(verdict).toEqual({
        outcome: "deny",
        code: "PUBLISH_AUDIENCE_UNSUPPORTED",
      });
      const rows = await fixture.readResourceRowsAsData(companyA);
      expect(rows.some((candidate) => candidate.id === guarded.agentId)).toBe(
        false,
      );
    },
  );

  itDb(
    "非成员用合法受众发布他人 Bot = canonical not-found（不泄露归属存在性）",
    async () => {
      const otherTeamScope = await scopeAs("a2-member", companyA, teamA2);
      const fromA2 = await fixture.publish.publishBot(
        otherTeamScope,
        guarded.agentId,
        teamAudience(companyA, teamA2),
      );
      expect(isCanonicalNotFound(fromA2)).toBe(true);
      const crossCompanyScope = await scopeAs("b1-member", companyB, teamB1);
      const fromB1 = await fixture.publish.publishBot(
        crossCompanyScope,
        guarded.agentId,
        teamAudience(companyB, teamB1),
      );
      expect(isCanonicalNotFound(fromB1)).toBe(true);
    },
  );

  itDb(
    "forged scope UNVERIFIED_SCOPE；缺上下文 TENANT_REQUIRED / WORKSPACE_REQUIRED",
    async () => {
      const forged = {
        tenantId: companyA,
        workspaceId: teamA1,
        principalId: principalOf("a1-owner"),
        memberEpoch: 1,
        // 故意不带受信签发标记（assertTrustedScope 拒绝非 seam 产物）。
      } as unknown as PlatformScope;
      expect(
        await thrownMessage(() =>
          fixture.publish.publishBot(
            forged,
            guarded.agentId,
            teamAudience(companyA, teamA1),
          ),
        ),
      ).toBe("UNVERIFIED_SCOPE");
      const realScope = await scopeAs("a1-owner", companyA, teamA1);
      const noTenant = { ...realScope, tenantId: "" } as PlatformScope;
      expect(
        await thrownMessage(() =>
          fixture.publish.publishBot(
            noTenant,
            guarded.agentId,
            teamAudience(companyA, teamA1),
          ),
        ),
      ).toBe("TENANT_REQUIRED");
      const noTeam = { ...realScope, workspaceId: "" } as PlatformScope;
      expect(
        await thrownMessage(() =>
          fixture.publish.unpublishBot(noTeam, guarded.agentId),
        ),
      ).toBe("WORKSPACE_REQUIRED");
    },
  );

  itDb(
    "不变量守卫：注册行 kind 漂移 → BOT_PUBLISH_STATE_CONFLICT（绝不静默改写）",
    async () => {
      const drifted = `mt017-drifted-${randomUUID().slice(0, 8)}`;
      await fixture.seedResourceRow({
        tenantId: companyA,
        workspaceId: teamA1,
        id: drifted,
        kind: "knowledge",
        displayName: "MT017 drifted registration",
      });
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      // 归属行不存在 → 可见性门先拒（canonical not-found），漂移行原样。
      const fromNothing = await fixture.publish.publishBot(
        scope,
        drifted,
        teamAudience(companyA, teamA1),
      );
      expect(isCanonicalNotFound(fromNothing)).toBe(true);
      // 归属行存在 + 注册行漂移 → 响亮冲突，注册行不被改写。
      const owned = nextBot("owned-drifted");
      await fixture.ownership.createBot(scope, {
        agentId: owned.agentId,
        displayName: owned.displayName,
        defaultConfig: { model: "gpt-4o" },
      });
      await fixture.seedResourceRow({
        tenantId: companyA,
        workspaceId: teamA1,
        id: owned.agentId,
        kind: "knowledge",
        displayName: "MT017 drifted registration (owned)",
      });
      expect(
        await thrownMessage(() =>
          fixture.publish.publishBot(
            scope,
            owned.agentId,
            teamAudience(companyA, teamA1),
          ),
        ),
      ).toBe("BOT_PUBLISH_STATE_CONFLICT");
      const rows = await fixture.readResourceRowsAsData(companyA);
      const row = rows.find((candidate) => candidate.id === owned.agentId);
      expect(row?.kind).toBe("knowledge");
      expect(row?.visibility).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// 修复轮（复审 finding 1，关闭 D3 披露的最小缺口）：显式 private 注册行的
// 发布翻转。D3 曾披露该路径仅由 INSERT/UPDATE 结构保证 + 代码审查覆盖，
// 无直接用例——本用例补齐：属主显式发布把 'private' 翻成 'workspace'
// （属主本人动作，与 MT008 清单驱动批量迁移「绝不翻转 private」的第三方
// 语义不同源）；取消发布回 NULL（既定语义：只撤销团队公共事实，绝不重建
// 「个人」标记——「个人」只能由属主重新显式声明，MT010 语义边界）。
// ---------------------------------------------------------------------------

describeDb(
  "MT017 修复轮：owner 显式发布翻转显式 private 注册行；取消发布回 NULL",
  () => {
    itDb(
      "publish 翻 'private'→'workspace' 且成员 read/run 放行；unpublish 回 NULL（不回滚为 private；对照 MT010 个人标记语义边界）",
      async () => {
        const ownerScope = await scopeAs("a1-owner", companyA, teamA1);
        const marked = nextBot("private-marked");
        await fixture.ownership.createBot(ownerScope, {
          agentId: marked.agentId,
          displayName: marked.displayName,
          defaultConfig: { model: "gpt-4o" },
        });
        // MT010 语义边界：「个人」由注册行 visibility='private' 显式标记。
        await fixture.seedResourceRow({
          tenantId: companyA,
          workspaceId: teamA1,
          id: marked.agentId,
          kind: "bot",
          displayName: marked.displayName,
          visibility: "private",
        });
        // 发布前：private 注册行 + 无 grant → 成员不可见（个人标记绝不
        // 派生团队公共；与验收 3 的 NULL 遗留行同一拒绝形状）。
        const memberScope = await scopeAs("a1-member", companyA, teamA1);
        const readBefore = await fixture.actions.decideAction(
          memberScope,
          marked.agentId,
          "read",
        );
        expect(readBefore).toEqual({
          outcome: "deny",
          code: "RESOURCE_NOT_FOUND",
        });
        const runBefore = await fixture.actions.decideAction(
          memberScope,
          marked.agentId,
          "run",
        );
        expect(isCanonicalNotFound(runBefore)).toBe(true);
        // owner 显式发布：'private' → 'workspace'（原行 UPDATE 翻转，
        // 绝非删旧插新；发布回显与既有验收同形）。
        const publish = await fixture.publish.publishBot(
          ownerScope,
          marked.agentId,
          teamAudience(companyA, teamA1),
        );
        expect(publish.outcome).toBe("allow");
        if (publish.outcome !== "allow") throw new Error("unreachable");
        expect(publish.publication.agentId).toBe(marked.agentId);
        expect(publish.publication.audience.workspaceId).toBe(teamA1);
        const flippedRows = (
          await fixture.readResourceRowsAsData(companyA)
        ).filter((candidate) => candidate.id === marked.agentId);
        expect(flippedRows).toHaveLength(1);
        expect(flippedRows[0]?.visibility).toBe("workspace");
        expect(flippedRows[0]?.kind).toBe("bot");
        expect(flippedRows[0]?.status).toBe("active");
        // 团队成员按 MT009 规则获得 read/run（与验收 1 同一使用路径）。
        const readAfter = await fixture.actions.decideAction(
          memberScope,
          marked.agentId,
          "read",
        );
        expect(readAfter).toEqual({ outcome: "allow" });
        const runAfter = await fixture.actions.decideAction(
          memberScope,
          marked.agentId,
          "run",
        );
        expect(runAfter).toEqual({ outcome: "allow" });
        // 取消发布：visibility 回 NULL——断言既定语义：取消发布只撤销
        // 团队公共事实，**不**回滚为 'private'（个人标记只能由属主显式
        // 重新声明，发布/取消发布都不代属主重建「个人」态）。
        const unpublish = await fixture.publish.unpublishBot(
          ownerScope,
          marked.agentId,
        );
        expect(unpublish).toEqual({ outcome: "allow" });
        const revertedRows = await fixture.readResourceRowsAsData(companyA);
        const reverted = revertedRows.find(
          (candidate) => candidate.id === marked.agentId,
        );
        expect(reverted).toBeDefined();
        expect(reverted?.visibility).toBeNull();
        // 成员立即回到不可见（调用时重验，与验收 2 同一语义）。
        const readReverted = await fixture.actions.decideAction(
          memberScope,
          marked.agentId,
          "read",
        );
        expect(isCanonicalNotFound(readReverted)).toBe(true);
        const runReverted = await fixture.actions.decideAction(
          memberScope,
          marked.agentId,
          "run",
        );
        expect(isCanonicalNotFound(runReverted)).toBe(true);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 存储与角色契约：受限角色在 play、判断全程真实 RLS
// ---------------------------------------------------------------------------

describeDb("MT017 存储与角色契约", () => {
  itDb(
    "发布/取消全程受限 operator 角色（current_user = ob_ent_operator）",
    async () => {
      const ownerScope = await scopeAs("a1-owner", companyA, teamA1);
      const bot = nextBot("role-probe");
      await fixture.ownership.createBot(ownerScope, {
        agentId: bot.agentId,
        displayName: bot.displayName,
        defaultConfig: { model: "gpt-4o" },
      });
      const publish = await fixture.publish.publishBot(
        ownerScope,
        bot.agentId,
        teamAudience(companyA, teamA1),
      );
      expect(publish.outcome).toBe("allow");
      const unpublish = await fixture.publish.unpublishBot(
        ownerScope,
        bot.agentId,
      );
      expect(unpublish).toEqual({ outcome: "allow" });
      const calls = fixture.restrictedCalls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.currentUser.startsWith("ob_ent_")).toBe(true);
      }
    },
  );

  itDb("未验证通道装配拒绝（UNVERIFIED_DATABASE_CAPABILITY）", async () => {
    const { createBotPublishService } = await import(
      "../../src/enterprise/tenancy/bot-publish"
    );
    expect(
      await thrownMessageSync(() =>
        createBotPublishService({
          operator: {} as never,
        }),
      ),
    ).toBe("UNVERIFIED_DATABASE_CAPABILITY");
  });
});
