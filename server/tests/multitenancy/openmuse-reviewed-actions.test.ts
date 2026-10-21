// server/tests/multitenancy/openmuse-reviewed-actions.test.ts
// MT064（Issue #107）：OpenMuse 审阅动作提案与回执的归属。
//
// 验收事实源（Issue #107 四条，逐条对应 describe；真实 PostgreSQL，全程受
// 限 ob_ent_* 角色 + 真实 RLS + 真实 §6 决策服务 + 真实 MT078 审计写入，
// 绝不回退开发库、缺 env 显式 skip）：
//   AC1 提案与回执按归属授权；跨范围访问返回不可见语义——协会行三元组
//     （租户臂 RLS + 应用层第二道防线）先于一切提案/回执读取；回执继承
//     action 归属；一切不可见 = MT011 canonical RESOURCE_NOT_FOUND 逐字节
//     同形。
//   AC2 确认与取消只对有权限的主体生效，且状态变化留审计——协会门先于
//     委托真实 decide/cancel；每次生效决策写一条 business 域审计事件。
//   AC3 既有精确动作提案/确认/取消行为回归通过——本套件零改动既有
//     reviewed-actions 面；回归本体 = 既有套件（见报告验证表）。
//   AC4 撤权后待处理提案不可继续操作——suspendMembership 后 scoped 决策
//     折叠为不可见，根行保持 awaiting_review，executor 零拨号。
//
// 结构（新文件；迁移经真实 MT003 工具 generate→apply→replay 收敛钉死）。

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
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  createOpenMuseReviewedActionsFixture,
  type OpenMuseReviewedActionsFixture,
  type OpenMuseReviewedIdentity,
} from "./support/openmuse-reviewed-actions";

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
      reason: `MT064 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: OpenMuseReviewedActionsFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
const suiteGeneratedDirs: string[] = [];
const randomSuiteToken = () => Math.random().toString(36).slice(2, 10);

/** 共享提案图：每条 = {id, ownerIdentity}。 */
const actions: Record<string, { id: string; ownerIdentity: string }> = {};

const scopeAs = (
  identity: OpenMuseReviewedIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

const proposeAndPin = async (
  key: string,
  identity: OpenMuseReviewedIdentity,
  tenantId: string,
  workspaceId: string,
) => {
  const ownerUserId = fixture.ids[`user-${identity}`];
  const actionId = await fixture.proposeFor(ownerUserId);
  const scope = await scopeAs(identity, tenantId, workspaceId);
  const result = await fixture.service.pinReviewedActionScope(scope, {
    actionId,
  });
  if (!("status" in result) || result.status !== "pinned") {
    throw new Error(`pin failed: ${JSON.stringify(result)}`);
  }
  actions[key] = { id: actionId, ownerIdentity: identity };
  return actionId;
};

beforeAll(async () => {
  if (!ENV.ok) return;

  // MT064 migration through the real MT003 tool: generate → apply → replay
  // is convergent (applied on a fresh database, up-to-date on replay).
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error(
      "MT064 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  const dir = join("/tmp", `mt064-migration-${randomSuiteToken()}`);
  suiteGeneratedDirs.push(dir);
  const generation = await runMigrateTest(["generate", "MT064", "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`MT064 generate failed: ${JSON.stringify(generation)}`);
  }
  const manifestPath = join(dir, "MT064", "manifest.json");
  const applied: RunOutcome = await runMigrateTest(
    ["migrate", "MT064", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT064 apply failed: ${JSON.stringify(applied)}`);
  }
  const replay = await runMigrateTest(
    ["migrate", "MT064", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (replay.kind !== "up-to-date") {
    throw new Error(`MT064 replay not convergent: ${JSON.stringify(replay)}`);
  }

  fixture = await createOpenMuseReviewedActionsFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];

  // Shared proposal graph: one per (identity × scope) the ACs read, one
  // foreign teammate proposal, one multi-company pair.
  await proposeAndPin("a1", "a1-member", companyA, teamA1);
  await proposeAndPin("a1second", "a1-member", companyA, teamA1);
  await proposeAndPin("other", "a1-other", companyA, teamA1);
  await proposeAndPin("a2", "a1a2-member", companyA, teamA2);
  await proposeAndPin("b1", "b1-member", companyB, teamB1);
  await proposeAndPin("multiA", "multi-company", companyA, teamA1);
  await proposeAndPin("multiB", "multi-company", companyB, teamB1);
}, 120_000);

afterAll(async () => {
  for (const dir of suiteGeneratedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  if (fixture) {
    await fixture.dispose();
  }
}, 60_000);

// ---------------------------------------------------------------------------
// AC1：提案与回执按归属授权；跨范围访问返回不可见语义
// ---------------------------------------------------------------------------

describeDb("MT064 AC1：范围化提案/回执", () => {
  itDb("列表只返回本人、所选团队范围内的提案（同团队他人零泄漏）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const { actions: listed } = await fixture.service.listReviewedActions(
      scope,
      { limit: 100 },
    );
    const ids = listed.map((entry) => entry.ownership.actionId).sort();
    expect(ids).toEqual([actions.a1.id, actions.a1second.id].sort());
    for (const entry of listed) {
      expect(entry.ownership.tenantId).toBe(companyA);
      expect(entry.ownership.workspaceId).toBe(teamA1);
      expect(entry.ownership.principalId).toBe(
        fixture.ids["principal-a1-member"],
      );
      expect(entry.ownership.userId).toBe(fixture.ids["user-a1-member"]);
    }
    // 同团队另一人的提案从不出现在别人的列表里。
    expect(ids).not.toContain(actions.other.id);
  });

  itDb("跨团队上下文不可见：A2 列表不含 A1 的提案，读取零触达", async () => {
    const scopeA2 = await scopeAs("a1a2-member", companyA, teamA2);
    const { actions: listed } = await fixture.service.listReviewedActions(
      scopeA2,
      { limit: 100 },
    );
    expect(listed.map((entry) => entry.ownership.actionId)).toEqual([
      actions.a2.id,
    ]);

    const read = await fixture.service.readReviewedAction(
      scopeA2,
      actions.a1.id,
    );
    expect(isCanonicalNotFound(read)).toBe(true);
  });

  itDb(
    "跨公司同账号：B 公司上下文对 A 公司提案 canonical not-found",
    async () => {
      const scopeB = await scopeAs("multi-company", companyB, teamB1);
      const read = await fixture.service.readReviewedAction(
        scopeB,
        actions.multiA.id,
      );
      expect(isCanonicalNotFound(read)).toBe(true);
      // B 上下文只看到 B 的提案。
      const { actions: listed } = await fixture.service.listReviewedActions(
        scopeB,
        { limit: 100 },
      );
      expect(listed.map((entry) => entry.ownership.actionId)).toEqual([
        actions.multiB.id,
      ]);
    },
  );

  itDb("读取返回归属与根行；不存在的 id 与跨范围 id 同形", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const read = await fixture.service.readReviewedAction(scope, actions.a1.id);
    expect(read).toMatchObject({
      outcome: "allow",
      action: { id: actions.a1.id, status: "awaiting_review" },
    });
    const missing = await fixture.service.readReviewedAction(
      scope,
      "no-such-action",
    );
    expect(isCanonicalNotFound(missing)).toBe(true);
    const foreign = await fixture.service.readReviewedAction(
      scope,
      actions.b1.id,
    );
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
  });

  itDb("同团队他人对本人提案 canonical not-found（个人权限半边）", async () => {
    const scope = await scopeAs("a1-other", companyA, teamA1);
    const read = await fixture.service.readReviewedAction(scope, actions.a1.id);
    expect(isCanonicalNotFound(read)).toBe(true);
  });

  itDb(
    "回执按归属授权：门后回执继承 action 归属；未执行提案无回执同形",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      // 先走一次真实 approve，产生 §6 attempt（回执本体）。
      const decided = await fixture.service.scopedDecide(
        scope,
        actions.a1second.id,
        "approve",
      );
      expect(decided).toMatchObject({ outcome: "allow" });
      const receipt = await fixture.service.readReviewedReceipt(
        scope,
        actions.a1second.id,
      );
      expect(receipt).toMatchObject({ outcome: "allow" });
      if (receipt.outcome === "allow") {
        expect(receipt.receipt.attemptId.length).toBeGreaterThan(0);
        expect(receipt.receipt.providerRef).toContain("fake-");
      }
      // 未决提案（无 attempt）与外来提案同形 not-found。
      const none = await fixture.service.readReviewedReceipt(
        scope,
        actions.a1.id,
      );
      expect(isCanonicalNotFound(none)).toBe(true);
      const foreignScope = await scopeAs("b1-member", companyB, teamB1);
      const foreign = await fixture.service.readReviewedReceipt(
        foreignScope,
        actions.a1second.id,
      );
      expect(JSON.stringify(foreign)).toBe(JSON.stringify(none));
    },
  );

  itDb("公司级撤权后列表响亮拒绝，对象面折叠为不可见", async () => {
    // 独立被撤权人：b1-member 在 B 公司被停用。
    const scope = await scopeAs("b1-member", companyB, teamB1);
    await fixture.suspendCompanyMembership(
      companyB,
      fixture.ids["principal-b1-member"],
    );
    const listed = await thrownMessage(() =>
      fixture.service.listReviewedActions(scope, { limit: 10 }),
    );
    expect(listed).toBe("SCOPE_REVOKED");
    const read = await fixture.service.readReviewedAction(scope, actions.b1.id);
    expect(isCanonicalNotFound(read)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2：确认与取消只对有权限的主体生效，且状态变化留审计
// ---------------------------------------------------------------------------

describeDb("MT064 AC2：范围化确认/取消 + 审计", () => {
  itDb(
    "scopedDecide 走真实 decide：approve 后根行落 succeeded，审计写入",
    async () => {
      const owner = fixture.ids["user-a1-member"];
      const actionId = await fixture.proposeFor(owner);
      const scope = await scopeAs("a1-member", companyA, teamA1);
      await fixture.service.pinReviewedActionScope(scope, { actionId });

      const before = fixture.executorDials();
      const decided = await fixture.service.scopedDecide(
        scope,
        actionId,
        "approve",
      );
      expect(decided).toMatchObject({
        outcome: "allow",
        action: { status: "succeeded" },
      });
      if (decided.outcome === "allow") {
        expect(decided.auditEventId).toBeTruthy();
      }
      expect(fixture.executorDials()).toBe(before + 1);
      expect(await fixture.actionStatus(actionId)).toBe("succeeded");

      // 状态变化留审计：business 域、事件类型、actor、target、payload 全对。
      const events = await fixture.auditEventsFor(companyA, actionId);
      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({
        domain: "business",
        eventType: "openmuse.reviewed_action.decided",
        actorId: owner,
      });
      expect(events[0].payload).toMatchObject({
        actionKind: "mail",
        status: "succeeded",
      });
    },
  );

  itDb("scopedCancel 走真实 cancel：根行落 cancelled，审计写入", async () => {
    const owner = fixture.ids["user-a1-member"];
    const actionId = await fixture.proposeFor(owner);
    const scope = await scopeAs("a1-member", companyA, teamA1);
    await fixture.service.pinReviewedActionScope(scope, { actionId });

    const cancelled = await fixture.service.scopedCancel(scope, actionId);
    expect(cancelled).toMatchObject({
      outcome: "allow",
      action: { status: "cancelled" },
    });
    expect(await fixture.actionStatus(actionId)).toBe("cancelled");
    const events = await fixture.auditEventsFor(companyA, actionId);
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("openmuse.reviewed_action.cancelled");
  });

  itDb("deny 决策也留审计（状态变化本身即是审计事实）", async () => {
    const owner = fixture.ids["user-a1-member"];
    const actionId = await fixture.proposeFor(owner);
    const scope = await scopeAs("a1-member", companyA, teamA1);
    await fixture.service.pinReviewedActionScope(scope, { actionId });

    const decided = await fixture.service.scopedDecide(scope, actionId, "deny");
    expect(decided).toMatchObject({
      outcome: "allow",
      action: { status: "denied" },
    });
    const events = await fixture.auditEventsFor(companyA, actionId);
    expect(events.length).toBe(1);
    expect(events[0].payload).toMatchObject({ status: "denied" });
  });

  itDb(
    "无权主体决策零生效：同团队他人/跨范围 = canonical not-found",
    async () => {
      const owner = fixture.ids["user-a1-other"];
      const actionId = await fixture.proposeFor(owner);
      const pinScope = await scopeAs("a1-other", companyA, teamA1);
      await fixture.service.pinReviewedActionScope(pinScope, { actionId });

      // 同团队他人：读不到也决不了，根行零副作用。
      const mateScope = await scopeAs("a1-member", companyA, teamA1);
      const mateDecide = await fixture.service.scopedDecide(
        mateScope,
        actionId,
        "approve",
      );
      expect(isCanonicalNotFound(mateDecide)).toBe(true);
      // 跨公司同账号同理。
      const foreignScope = await scopeAs("multi-company", companyB, teamB1);
      const foreignDecide = await fixture.service.scopedDecide(
        foreignScope,
        actionId,
        "approve",
      );
      expect(isCanonicalNotFound(foreignDecide)).toBe(true);
      expect(await fixture.actionStatus(actionId)).toBe("awaiting_review");
      // 本人上下文仍可决（权限主体生效半边）。
      const own = await fixture.service.scopedDecide(
        pinScope,
        actionId,
        "deny",
      );
      expect(own).toMatchObject({ outcome: "allow" });
    },
  );
});

// ---------------------------------------------------------------------------
// AC3：既有精确动作行为回归（本套件零改动既有面；回归本体在既有套件）
// ---------------------------------------------------------------------------

describeDb("MT064 AC3：既有行为不回退（同一权威上的烟雾回归）", () => {
  itDb("propose → decide(approve) 的 §6 语义在真实服务上不变", async () => {
    const owner = fixture.ids["user-a1-member"];
    const actionId = await fixture.proposeFor(owner);
    const scope = await scopeAs("a1-member", companyA, teamA1);
    await fixture.service.pinReviewedActionScope(scope, { actionId });

    // 直接走既有服务（非 scoped 面）：行为与 scoped 面一致。
    const direct = await fixture.reviewed.decide(owner, actionId, "approve");
    expect(direct?.status).toBe("succeeded");
    // 已终态再决：同形重答，不二次执行。
    const again = await fixture.reviewed.decide(owner, actionId, "approve");
    expect(again?.status).toBe("succeeded");
    // scoped 面对终态提案重读：允许（读取面），决策幂等。
    const read = await fixture.service.readReviewedAction(scope, actionId);
    expect(read).toMatchObject({
      outcome: "allow",
      action: { status: "succeeded" },
    });
  });
});

// ---------------------------------------------------------------------------
// AC4：撤权后待处理提案不可继续操作
// ---------------------------------------------------------------------------

describeDb("MT064 AC4：撤权后待处理提案不可继续操作", () => {
  itDb(
    "公司撤权后 scopedDecide/scopedCancel 折叠不可见，根行不动零拨号",
    async () => {
      const owner = fixture.ids["user-multi-company"];
      const actionId = await fixture.proposeFor(owner);
      const scopeA = await scopeAs("multi-company", companyA, teamA1);
      await fixture.service.pinReviewedActionScope(scopeA, { actionId });
      expect(await fixture.actionStatus(actionId)).toBe("awaiting_review");

      const before = fixture.executorDials();
      await fixture.suspendCompanyMembership(
        companyA,
        fixture.ids["principal-multi-company"],
      );

      const decide = await fixture.service.scopedDecide(
        scopeA,
        actionId,
        "approve",
      );
      expect(isCanonicalNotFound(decide)).toBe(true);
      const cancel = await fixture.service.scopedCancel(scopeA, actionId);
      expect(isCanonicalNotFound(cancel)).toBe(true);

      // 待处理提案零副作用：状态不变、零拨号、零审计事件。
      expect(await fixture.actionStatus(actionId)).toBe("awaiting_review");
      expect(fixture.executorDials()).toBe(before);
      const events = await fixture.auditEventsFor(companyA, actionId);
      expect(events.length).toBe(0);

      // 另一公司的有效上下文不受影响（撤权是公司级事实）。
      const scopeB = await scopeAs("multi-company", companyB, teamB1);
      const { actions: listed } = await fixture.service.listReviewedActions(
        scopeB,
        { limit: 100 },
      );
      expect(listed.map((entry) => entry.ownership.actionId)).toEqual([
        actions.multiB.id,
      ]);
    },
  );

  itDb("团队上下文失效后对象面同样不可见（团队级撤销半边）", async () => {
    const owner = fixture.ids["user-a1a2-member"];
    const actionId = await fixture.proposeFor(owner);
    const scopeA2 = await scopeAs("a1a2-member", companyA, teamA2);
    await fixture.service.pinReviewedActionScope(scopeA2, { actionId });

    // A1 上下文（本人另一团队）对 A2 钉住的提案不可见、不可决。
    const scopeA1 = await scopeAs("a1a2-member", companyA, teamA1);
    const decide = await fixture.service.scopedDecide(
      scopeA1,
      actionId,
      "approve",
    );
    expect(isCanonicalNotFound(decide)).toBe(true);
    expect(await fixture.actionStatus(actionId)).toBe("awaiting_review");
  });
});
