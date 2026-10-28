// server/tests/multitenancy/bot-lifecycle.test.ts
// MT019（Issue #62）：Bot 生命周期动作逐项授权（复制/隐藏/重置/删除/模板
// 更新/远端回调）。
//
// 验收事实源（Issue #62 四条，逐条对应 describe；真实 PostgreSQL，全程受限
// ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：每个动作分别测试——公共 Bot 使用者不能编辑/删除；团队管理者
//     按明确管理权限才可以（管理授权 = 归属 owner ∨ 公司 tenant_admin，
//     每事务重验；提权用例放套件末尾，避免污染前序身份矩阵）。
//   验收 2：远端回调（模板更新、外部通知）匹配持久化的归属，不接受回调
//     体里指定的公司/团队（驼峰/下划线归属键一律响亮拒绝）。
//   验收 3：删除 Bot 后其发布、受众、安装回执与相关授权同时失效，不留下
//     可访问的悬挂引用（级联在同一事务内；效果经 MT009/MT016 真实读面断言）。
//   验收 4：撤权后（MT007）生命周期动作同样被拒绝（真实 suspendMembership
//     递增 epoch，已签发 scope 立即失效 = canonical not-found）。

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  BOT_LIFECYCLE_ACTIONS,
  type ScopedBotLifecycleAction,
} from "../../src/enterprise/tenancy/bot-lifecycle";
import {
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  type BotLifecycleFixture,
  type BotLifecycleIdentity,
  createBotLifecycleFixture,
} from "./support/bot-lifecycle";

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
      reason: `MT019 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const canonicalNotFoundJson = serializeNotFoundVerdict(notFoundVerdict());
const isCanonicalNotFound = (value: unknown): boolean =>
  JSON.stringify(value) === canonicalNotFoundJson;

/** 有用户 scope 的五个动作（remote-callback 走独立入口）。 */
const SCOPED_ACTIONS: readonly ScopedBotLifecycleAction[] = [
  "duplicate",
  "hide",
  "reset",
  "delete",
  "template-update",
];

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: BotLifecycleFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
const generatedDirs: string[] = [];
let botCounter = 0;

const nextBot = (tag: string) => {
  botCounter += 1;
  return {
    agentId: `mt019-bot-${String(botCounter).padStart(3, "0")}-${tag}`,
    displayName: `MT019 Bot ${String(botCounter).padStart(3, "0")} ${tag}`,
  };
};

const principalOf = (identity: BotLifecycleIdentity) =>
  fixture.ids[`principal-${identity}`];

const scopeAs = (
  identity: BotLifecycleIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

/** 主库迁移链（依赖序；幂等：applied | up-to-date）。MT019 无新 schema 对象。 */
const MIGRATION_CHAIN = [
  "MT004",
  "MT008",
  "MT112",
  "MT012",
  "MT014",
  "MT010",
  "MT009",
  "MT016",
  "MT034",
] as const;

beforeAll(async () => {
  if (!ENV.ok) return;

  // 迁移链按依赖序经 MT003 工具真实执行（MT017 同款；本票不注册迁移
  // 任务——生命周期语义复用既有表，无新 schema 对象）。
  const resolved = resolveTestDatabaseTarget(process.env);
  if (!resolved.ok) {
    throw new Error(`MT019 migration target refused: ${resolved.reason}`);
  }
  const migrationEnv = { TEST_DATABASE_URL: resolved.target.url };
  const dir = join("/tmp", `mt019-manifests-${randomUUID().slice(0, 8)}`);
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

  fixture = await createBotLifecycleFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];

  // 公司 A 翻到 workspace-v1（团队公共使用语义生效；MT017 同款披露
  // stand-in——判定侧从不使用该通道）。公司 B 保持 tenancy-v1。
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
// 验收 1：每个动作分别测试——使用者不能编辑/删除；管理者按明确权限才可以
// ---------------------------------------------------------------------------

describeDb(
  "MT019 验收 1：公共 Bot 使用者六动作一律拒绝，owner 逐动作放行",
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
        Object.freeze({
          type: "team",
          tenantId: companyA,
          workspaceId: teamA1,
        }),
      );
      expect(verdict.outcome).toBe("allow");
    }, 30000);

    itDb(
      "同团队使用者（非 owner）对已发布 Bot read 放行（可见性门确实通过）",
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

    itDb("使用者五动作 decide 逐项 deny BOT_LIFECYCLE_FORBIDDEN", async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      for (const action of SCOPED_ACTIONS) {
        const verdict = await fixture.lifecycle.decideLifecycleAction(
          scope,
          published.agentId,
          action,
        );
        expect(verdict, action).toEqual({
          outcome: "deny",
          code: "BOT_LIFECYCLE_FORBIDDEN",
        });
      }
    });

    itDb("使用者 execute（编辑/删除路径）同样拒绝且零写入", async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const duplicate = await fixture.lifecycle.executeLifecycleAction(
        scope,
        published.agentId,
        "duplicate",
        { newAgentId: `${published.agentId}-copy` },
      );
      expect(duplicate).toEqual({
        outcome: "deny",
        code: "BOT_LIFECYCLE_FORBIDDEN",
      });
      const deleted = await fixture.lifecycle.executeLifecycleAction(
        scope,
        published.agentId,
        "delete",
      );
      expect(deleted).toEqual({
        outcome: "deny",
        code: "BOT_LIFECYCLE_FORBIDDEN",
      });
      const rows = await fixture.readOwnershipRowsAsData(companyA);
      expect(
        rows.find((row) => row.agentId === published.agentId?.status),
      ).toBe(undefined);
      expect(
        rows.find((row) => row.agentId === published.agentId)?.status,
      ).toBe("active");
    });

    itDb("owner 五动作 decide 逐项 allow（词表闭集六项含回调）", async () => {
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      for (const action of SCOPED_ACTIONS) {
        const verdict = await fixture.lifecycle.decideLifecycleAction(
          scope,
          published.agentId,
          action,
        );
        expect(verdict, action).toEqual({ outcome: "allow" });
      }
      expect(BOT_LIFECYCLE_ACTIONS).toHaveLength(6);
      expect(BOT_LIFECYCLE_ACTIONS).toContain("remote-callback");
    });

    itDb("未知动作运行时响亮拒绝（词表闭集）", async () => {
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      const invalid = "explode" as unknown as ScopedBotLifecycleAction;
      let message = "";
      try {
        await fixture.lifecycle.decideLifecycleAction(
          scope,
          published.agentId,
          invalid,
        );
        throw new Error("expected the call to be rejected, but it succeeded");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("BOT_LIFECYCLE_ACTION_INVALID");
    });

    itDb(
      "跨团队（a2）与跨公司（b1）五动作 = canonical not-found（不泄露存在性）",
      async () => {
        const a2 = await scopeAs("a2-member", companyA, teamA2);
        const b1 = await scopeAs("b1-member", companyB, teamB1);
        for (const action of SCOPED_ACTIONS) {
          expect(
            await fixture.lifecycle.decideLifecycleAction(
              a2,
              published.agentId,
              action,
            ),
            action,
          ).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
          expect(
            await fixture.lifecycle.decideLifecycleAction(
              b1,
              published.agentId,
              action,
            ),
            action,
          ).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
        }
        expect(
          isCanonicalNotFound({ outcome: "deny", code: "RESOURCE_NOT_FOUND" }),
        ).toBe(true);
      },
    );

    itDb(
      "公司管理员无团队席位签不出团队 scope（管理身份不隐式内容访问）",
      async () => {
        let message = "";
        try {
          await scopeAs("company-admin", companyA, teamA1);
          throw new Error("expected the call to be rejected, but it succeeded");
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toBe("WORKSPACE_FORBIDDEN");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 2：远端回调匹配持久化归属，不接受回调体指定的公司/团队
// ---------------------------------------------------------------------------

describeDb("MT019 验收 2：远端回调归属只来自持久化归属行", () => {
  let callbackBot = { agentId: "", displayName: "" };

  beforeAll(async () => {
    if (!ENV.ok) return;
    const scope = await scopeAs("a1-owner", companyA, teamA1);
    callbackBot = nextBot("callback");
    const created = await fixture.ownership.createBot(scope, {
      agentId: callbackBot.agentId,
      displayName: callbackBot.displayName,
      defaultConfig: { model: "gpt-4o", revision: 0 },
    });
    expect(created.outcome).toBe("allow");
  }, 30000);

  itDb("回调体携带 tenantId/workspaceId（驼峰）响亮拒绝", async () => {
    let message = "";
    try {
      await fixture.lifecycle.handleBotRemoteCallback({
        kind: "template-update",
        agentId: callbackBot.agentId,
        payload: {
          tenantId: companyA,
          workspaceId: teamA1,
          model: "gpt-4o-mini",
        },
      });
      throw new Error("expected the call to be rejected, but it succeeded");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
  });

  itDb("回调体携带 tenant_id/workspace_id（下划线）同样拒绝", async () => {
    let message = "";
    try {
      await fixture.lifecycle.handleBotRemoteCallback({
        kind: "template-update",
        agentId: callbackBot.agentId,
        payload: {
          tenant_id: companyB,
          workspace_id: teamB1,
          model: "gpt-4o-mini",
        },
      });
      throw new Error("expected the call to be rejected, but it succeeded");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
  });

  itDb(
    "正常 template-update 回调 allow：效果落在持久化归属（owner 读面验证）",
    async () => {
      const verdict = await fixture.lifecycle.handleBotRemoteCallback({
        kind: "template-update",
        agentId: callbackBot.agentId,
        payload: { model: "gpt-4o-mini", systemPrompt: "remote template" },
      });
      expect(verdict.outcome).toBe("allow");
      if (verdict.outcome !== "allow") throw new Error("unreachable");
      expect(verdict.revision).toBeGreaterThanOrEqual(2);
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      const view = await fixture.ownership.getBot(scope, callbackBot.agentId);
      expect(view.outcome).toBe("allow");
      if (view.outcome !== "allow") throw new Error("unreachable");
      expect(view.bot.defaultConfig).toEqual({
        model: "gpt-4o-mini",
        systemPrompt: "remote template",
      });
    },
  );

  itDb("external-notice 回调 allow 且无状态变化", async () => {
    const before = await fixture.ownership.getBot(
      await scopeAs("a1-owner", companyA, teamA1),
      callbackBot.agentId,
    );
    expect(before.outcome).toBe("allow");
    const verdict = await fixture.lifecycle.handleBotRemoteCallback({
      kind: "external-notice",
      agentId: callbackBot.agentId,
      payload: { event: "usage-report" },
    });
    expect(verdict.outcome).toBe("allow");
    const after = await fixture.ownership.getBot(
      await scopeAs("a1-owner", companyA, teamA1),
      callbackBot.agentId,
    );
    expect(after.outcome).toBe("allow");
    if (after.outcome !== "allow" || before.outcome !== "allow") {
      throw new Error("unreachable");
    }
    expect(after.bot.revision).toBe(before.bot.revision);
  });

  itDb(
    "不存在与已删除 Bot 的回调同形（canonical not-found，不泄露存在性）",
    async () => {
      const missing = await fixture.lifecycle.handleBotRemoteCallback({
        kind: "template-update",
        agentId: "mt019-bot-never-created",
        payload: { model: "x" },
      });
      expect(missing).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
      expect(isCanonicalNotFound(missing)).toBe(true);

      // 已删除 Bot 的回调与不存在同形（终态 Bot 不再接受回调）。
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      const doomed = nextBot("doomed-callback");
      await fixture.ownership.createBot(scope, {
        agentId: doomed.agentId,
        displayName: doomed.displayName,
        defaultConfig: {},
      });
      const deleted = await fixture.lifecycle.executeLifecycleAction(
        scope,
        doomed.agentId,
        "delete",
      );
      expect(deleted.outcome).toBe("allow");
      const after = await fixture.lifecycle.handleBotRemoteCallback({
        kind: "template-update",
        agentId: doomed.agentId,
        payload: { model: "x" },
      });
      expect(JSON.stringify(after)).toBe(JSON.stringify(missing));
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 3：删除级联失效——发布、受众、安装回执与相关授权
// ---------------------------------------------------------------------------

describeDb("MT019 验收 3：删除后发布/受众/回执/授权同时失效", () => {
  let cascadeBot = { agentId: "", displayName: "" };

  beforeAll(async () => {
    if (!ENV.ok) return;
    const scope = await scopeAs("a1-owner", companyA, teamA1);
    cascadeBot = nextBot("cascade");
    const created = await fixture.ownership.createBot(scope, {
      agentId: cascadeBot.agentId,
      displayName: cascadeBot.displayName,
      defaultConfig: { model: "gpt-4o" },
    });
    expect(created.outcome).toBe("allow");
    const publishVerdict = await fixture.publish.publishBot(
      scope,
      cascadeBot.agentId,
      Object.freeze({ type: "team", tenantId: companyA, workspaceId: teamA1 }),
    );
    expect(publishVerdict.outcome).toBe("allow");
    await fixture.seedReadGrant({
      tenantId: companyA,
      resourceId: cascadeBot.agentId,
      principalId: principalOf("a1-member"),
    });
    await fixture.seedSharedUseRows({
      tenantId: companyA,
      workspaceId: teamA1,
      agentId: cascadeBot.agentId,
      requestedBy: principalOf("a1-member"),
      approvedBy: principalOf("a1-owner"),
    });
    await fixture.ownership.setBotPreference(scope, cascadeBot.agentId, {
      tone: "concise",
    });

    // 前置事实：发布可见、授权在场、回执在场。
    const memberScope = await scopeAs("a1-member", companyA, teamA1);
    expect(
      await fixture.actions.decideAction(
        memberScope,
        cascadeBot.agentId,
        "read",
      ),
    ).toEqual({ outcome: "allow" });
    expect(
      await fixture.readGrantCountAsData(
        companyA,
        cascadeBot.agentId,
        principalOf("a1-member"),
      ),
    ).toBe(1);
    const shared = await fixture.readSharedRowsAsData(companyA);
    expect(
      shared.requests.filter((row) => row.agentId === cascadeBot.agentId),
    ).toHaveLength(1);
    expect(
      shared.approvals.filter((row) => row.agentId === cascadeBot.agentId),
    ).toHaveLength(1);

    const verdict = await fixture.lifecycle.executeLifecycleAction(
      scope,
      cascadeBot.agentId,
      "delete",
    );
    expect(verdict.outcome).toBe("allow");
  }, 30000);

  itDb("归属行硬删：行消失，MT016 读面 canonical not-found", async () => {
    const rows = await fixture.readOwnershipRowsAsData(companyA);
    expect(
      rows.find((row) => row.agentId === cascadeBot.agentId),
    ).toBeUndefined();
    const scope = await scopeAs("a1-owner", companyA, teamA1);
    const view = await fixture.ownership.getBot(scope, cascadeBot.agentId);
    expect(view).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
    expect(isCanonicalNotFound(view)).toBe(true);
  });

  itDb("发布/受众失效：MT009 read/run 立即 canonical not-found", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const read = await fixture.actions.decideAction(
      scope,
      cascadeBot.agentId,
      "read",
    );
    expect(read).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
    const run = await fixture.actions.decideAction(
      scope,
      cascadeBot.agentId,
      "run",
    );
    expect(run).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
    const resourceRows = await fixture.readBotResourceRowsAsData(companyA);
    expect(
      resourceRows.find((row) => row.id === cascadeBot.agentId)?.visibility,
    ).toBe(null);
  });

  itDb("相关授权失效：显式 grant 行全部消失", async () => {
    expect(
      await fixture.readGrantCountAsData(
        companyA,
        cascadeBot.agentId,
        principalOf("a1-member"),
      ),
    ).toBe(0);
  });

  itDb("安装/共享使用回执失效：申请与批准行经 FK 级联全部消失", async () => {
    const shared = await fixture.readSharedRowsAsData(companyA);
    expect(
      shared.requests.filter((row) => row.agentId === cascadeBot.agentId),
    ).toHaveLength(0);
    expect(
      shared.approvals.filter((row) => row.agentId === cascadeBot.agentId),
    ).toHaveLength(0);
  });

  itDb(
    "子记录不可访问：偏好读取 canonical not-found（无悬挂引用）",
    async () => {
      const scope = await scopeAs("a1-owner", companyA, teamA1);
      const preference = await fixture.ownership.getBotPreference(
        scope,
        cascadeBot.agentId,
      );
      expect(preference).toEqual({
        outcome: "deny",
        code: "RESOURCE_NOT_FOUND",
      });
    },
  );

  itDb("删除后的生命周期动作与回调一律 canonical not-found", async () => {
    const scope = await scopeAs("a1-owner", companyA, teamA1);
    for (const action of SCOPED_ACTIONS) {
      expect(
        await fixture.lifecycle.decideLifecycleAction(
          scope,
          cascadeBot.agentId,
          action,
        ),
        action,
      ).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
    }
    const callback = await fixture.lifecycle.handleBotRemoteCallback({
      kind: "template-update",
      agentId: cascadeBot.agentId,
      payload: { model: "x" },
    });
    expect(callback).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// 验收 4：撤权后（MT007）生命周期动作同样被拒绝
// ---------------------------------------------------------------------------

describeDb("MT019 验收 4：真实撤权后六动作同样拒绝", () => {
  let revokedBot = { agentId: "", displayName: "" };
  let staleScope: PlatformScope;

  beforeAll(async () => {
    if (!ENV.ok) return;
    // 用 a1a2-member 当被撤权的属主（a1-owner 是其余三个 describe 的属主，
    // 不能被撤权污染身份矩阵）。
    const scope = await scopeAs("a1a2-member", companyA, teamA1);
    revokedBot = nextBot("revoked");
    const created = await fixture.ownership.createBot(scope, {
      agentId: revokedBot.agentId,
      displayName: revokedBot.displayName,
      defaultConfig: { model: "gpt-4o" },
    });
    expect(created.outcome).toBe("allow");
    // 撤权前动作放行（同一 owner、同一动作）。
    expect(
      await fixture.lifecycle.decideLifecycleAction(
        scope,
        revokedBot.agentId,
        "hide",
      ),
    ).toEqual({ outcome: "allow" });
    // 已签发 scope 持有撤权前的 epoch；真实暂停后它必须立即失效。
    staleScope = scope;
    await fixture.suspendCompanyMembership(
      companyA,
      principalOf("a1a2-member"),
    );
  }, 30000);

  itDb("suspend 后五动作（已签发 scope）全部 canonical not-found", async () => {
    for (const action of SCOPED_ACTIONS) {
      expect(
        await fixture.lifecycle.decideLifecycleAction(
          staleScope,
          revokedBot.agentId,
          action,
        ),
        action,
      ).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
    }
  });

  itDb(
    "suspend 后回调面不受影响（归属行仍 active，回调仍按持久归属工作）",
    async () => {
      const verdict = await fixture.lifecycle.handleBotRemoteCallback({
        kind: "external-notice",
        agentId: revokedBot.agentId,
        payload: { event: "health-check" },
      });
      expect(verdict.outcome).toBe("allow");
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 1 收尾（套件末尾执行，避免提权污染前面的身份矩阵）：
// 团队管理者按明确管理权限才可以执行管理动作
// ---------------------------------------------------------------------------

describeDb("MT019 验收 1 收尾：tenant_admin 明确管理权限放行", () => {
  let managedBot = { agentId: "", displayName: "" };

  beforeAll(async () => {
    if (!ENV.ok) return;
    const scope = await scopeAs("a1-owner", companyA, teamA1);
    managedBot = nextBot("managed");
    const created = await fixture.ownership.createBot(scope, {
      agentId: managedBot.agentId,
      displayName: managedBot.displayName,
      defaultConfig: { model: "gpt-4o" },
    });
    expect(created.outcome).toBe("allow");
    const publishVerdict = await fixture.publish.publishBot(
      scope,
      managedBot.agentId,
      Object.freeze({ type: "team", tenantId: companyA, workspaceId: teamA1 }),
    );
    expect(publishVerdict.outcome).toBe("allow");
    // a1-member 由公司管理员提权为 tenant_admin（真实 memberships 行；
    // 安排侧披露 stand-in——MT076 people-lifecycle 是正式提权面）。
    await fixture.promoteToTenantAdmin(companyA, principalOf("a1-member"));
  }, 30000);

  itDb("提权后的团队成员五动作 decide 逐项 allow", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    for (const action of SCOPED_ACTIONS) {
      expect(
        await fixture.lifecycle.decideLifecycleAction(
          scope,
          managedBot.agentId,
          action,
        ),
        action,
      ).toEqual({ outcome: "allow" });
    }
  });

  itDb(
    "hide 执行真实生效：注册行 visibility 回 NULL（团队公共撤下）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const verdict = await fixture.lifecycle.executeLifecycleAction(
        scope,
        managedBot.agentId,
        "hide",
      );
      expect(verdict.outcome).toBe("allow");
      const rows = await fixture.readBotResourceRowsAsData(companyA);
      expect(
        rows.find((row) => row.id === managedBot.agentId)?.visibility,
      ).toBe(null);
    },
  );

  itDb("reset 执行真实生效：defaultConfig 重置为空对象", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const verdict = await fixture.lifecycle.executeLifecycleAction(
      scope,
      managedBot.agentId,
      "reset",
    );
    expect(verdict.outcome).toBe("allow");
    const view = await fixture.ownership.getBot(scope, managedBot.agentId);
    expect(view.outcome).toBe("allow");
    if (view.outcome !== "allow") throw new Error("unreachable");
    expect(view.bot.defaultConfig).toEqual({});
  });

  itDb("template-update 执行真实生效：配置替换 + 拒绝归属键", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const verdict = await fixture.lifecycle.executeLifecycleAction(
      scope,
      managedBot.agentId,
      "template-update",
      { defaultConfig: { model: "claude-fable-5-1", tools: ["search"] } },
    );
    expect(verdict.outcome).toBe("allow");
    let message = "";
    try {
      await fixture.lifecycle.executeLifecycleAction(
        scope,
        managedBot.agentId,
        "template-update",
        { defaultConfig: { tenantId: companyB } },
      );
      throw new Error("expected the call to be rejected, but it succeeded");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
    const view = await fixture.ownership.getBot(scope, managedBot.agentId);
    expect(view.outcome).toBe("allow");
    if (view.outcome !== "allow") throw new Error("unreachable");
    expect(view.bot.defaultConfig).toEqual({
      model: "claude-fable-5-1",
      tools: ["search"],
    });
  });

  itDb("duplicate 执行真实生效：新归属行归属发起者", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const copyId = `${managedBot.agentId}-copy`;
    const verdict = await fixture.lifecycle.executeLifecycleAction(
      scope,
      managedBot.agentId,
      "duplicate",
      { newAgentId: copyId },
    );
    expect(verdict.outcome).toBe("allow");
    if (verdict.outcome !== "allow") throw new Error("unreachable");
    expect(verdict.newAgentId).toBe(copyId);
    const view = await fixture.ownership.getBot(scope, copyId);
    expect(view.outcome).toBe("allow");
    if (view.outcome !== "allow") throw new Error("unreachable");
    expect(view.bot.workspaceId).toBe(teamA1);
  });
});
