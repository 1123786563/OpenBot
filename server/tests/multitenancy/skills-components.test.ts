// server/tests/multitenancy/skills-components.test.ts
// MT033（Issue #76）：技能与组件发布、版本与组件数据函数的作用域。
//
// 验收事实源（Issue #76 四条，逐条对应 describe）：
//   (1) 发布为团队公共的技能对成员可用、不可改；非成员不可见。
//   (2) 组件数据函数以调用者身份校验数据权限，不以组件作者身份放大。
//   (3) 版本升级只影响本范围安装；另一公司的同名组件不受影响。
//   (4) 撤销发布后成员立即失去使用权。
//
// 判定事实源：enterprise_resources（kind='skill'/'component' 发布行，
// visibility='workspace' 即团队公共活跃行，revision=版本，append-only
// 升级 = 软删旧行 + 新版本行）+ enterprise_resource_grants（发布者归属，
// MT024 上传者同款事实面）+ enterprise_memberships / workspace_memberships
// 事实重验（MT006 epoch）+ enterprise_conversations（AC2 会话门按调用者
// 本人 principalId 重验，MT025 订阅门同款）。全链路经本票单一判定入口
// createSkillComponentService；不可见对象按 MT011 canonical not-found 处理。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_
// DATABASE_URL）加三个受限角色 URL；缺配置时整套显式 skip（跳过原因
// 写在用例名里，skipped 不计为通过），绝不回退开发库。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/e2e-compat";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  type SkillFixture,
  type SkillIdentity,
  createSkillFixture,
} from "./support/skills-components";

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
      reason: `MT033 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseTestDatabaseUrlFrom(process.env);
    for (const role of ["directory", "data", "operator"] as const) {
      enterpriseRuntimeDatabaseUrlFrom(role, process.env);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const isCanonicalNotFound = (value: unknown): boolean =>
  JSON.stringify(value) === serializeNotFoundVerdict(notFoundVerdict());

describeDb("MT033 / Issue #76 — 技能与组件发布作用域", () => {
  let fixture: SkillFixture;

  const scopeAs = async (
    identity: SkillIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

  const NEXT = (() => {
    let n = 0;
    return {
      name: (kind: string) =>
        `mt033-${kind}-${String((n += 1)).padStart(3, "0")}`,
    };
  })();

  /** 作者（a1-owner）在 A1 团队发布一个技能，返回名字。 */
  const publishSkillA1 = async (name: string): Promise<void> => {
    const verdict = await fixture.skills.publishSkill(
      await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
      { name },
    );
    expect(verdict).toEqual({ outcome: "allow", name, revision: 1 });
  };

  beforeAll(async () => {
    fixture = await createSkillFixture();
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  // -------------------------------------------------------------------------
  // AC1：团队公共技能成员可用、不可改；非成员不可见
  // -------------------------------------------------------------------------
  describeDb("AC1 团队公共技能可用不可改", () => {
    itDb("作者发布 → 成员可用（读 allow 且带当前版本）", async () => {
      const name = NEXT.name("skill");
      await publishSkillA1(name);
      const read = await fixture.skills.readSkill(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        name,
      );
      expect(read).toEqual({ outcome: "allow", name, revision: 1 });
    });

    itDb("成员改公共技能被拒（可见前提下的只读明确码）", async () => {
      const name = NEXT.name("skill");
      await publishSkillA1(name);
      const verdict = await fixture.skills.modifySkill(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        name,
        { displayName: "被篡改" },
      );
      expect(verdict).toEqual({ outcome: "deny", code: "SKILL_READ_ONLY" });
      // 事实未变：成员仍读到原名原版本。
      const read = await fixture.skills.readSkill(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        name,
      );
      expect(read).toEqual({ outcome: "allow", name, revision: 1 });
    });

    itDb("作者本人改公共技能同样被拒（不可改对作者成立）", async () => {
      const name = NEXT.name("skill");
      await publishSkillA1(name);
      const verdict = await fixture.skills.modifySkill(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        name,
        { displayName: "作者自改" },
      );
      expect(verdict).toEqual({ outcome: "deny", code: "SKILL_READ_ONLY" });
    });

    itDb(
      "非成员不可见：跨团队（A2）与跨公司（B）读 canonical not-found",
      async () => {
        const name = NEXT.name("skill");
        await publishSkillA1(name);
        const fromA2 = await fixture.skills.readSkill(
          await scopeAs("a2-member", fixture.companyA, fixture.teamA2),
          name,
        );
        expect(isCanonicalNotFound(fromA2)).toBe(true);
        const fromB = await fixture.skills.readSkill(
          await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
          name,
        );
        expect(isCanonicalNotFound(fromB)).toBe(true);
        // 未发布过的名字（同团队）与不存在同形。
        const ghost = await fixture.skills.readSkill(
          await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
          NEXT.name("skill"),
        );
        expect(isCanonicalNotFound(ghost)).toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  // AC2：组件数据函数以调用者身份校验，不以作者身份放大
  // -------------------------------------------------------------------------
  describeDb("AC2 组件数据函数调用者身份门", () => {
    itDb("成员携本人会话调用 allow（版本与函数名带出）", async () => {
      const name = NEXT.name("component");
      const published = await fixture.skills.publishComponent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { name },
      );
      expect(published).toEqual({ outcome: "allow", name, revision: 1 });
      const threadId = `mt033-thread-${NEXT.name("x")}`;
      await fixture.seedConversation({
        tenantId: fixture.companyA,
        workspaceId: fixture.teamA1,
        principalId: fixture.ids["principal-a1-other"],
        threadId,
      });
      const verdict = await fixture.skills.invokeComponentFunction(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        { name, functionName: "loadRows", threadId },
      );
      expect(verdict).toEqual({
        outcome: "allow",
        name,
        revision: 1,
        functionName: "loadRows",
      });
    });

    itDb(
      "组件作者携成员的会话调用 canonical not-found（作者身份不放大）",
      async () => {
        const name = NEXT.name("component");
        await fixture.skills.publishComponent(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          { name },
        );
        const threadId = `mt033-thread-${NEXT.name("x")}`;
        await fixture.seedConversation({
          tenantId: fixture.companyA,
          workspaceId: fixture.teamA1,
          principalId: fixture.ids["principal-a1-other"],
          threadId,
        });
        // 作者发起，但会话属于成员——数据权限按调用者（作者）判：不可见。
        const verdict = await fixture.skills.invokeComponentFunction(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          { name, functionName: "loadRows", threadId },
        );
        expect(isCanonicalNotFound(verdict)).toBe(true);
      },
    );

    itDb(
      "成员携他人（作者）会话调用 canonical not-found（同形不泄露）",
      async () => {
        const name = NEXT.name("component");
        await fixture.skills.publishComponent(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          { name },
        );
        const threadId = `mt033-thread-${NEXT.name("x")}`;
        await fixture.seedConversation({
          tenantId: fixture.companyA,
          workspaceId: fixture.teamA1,
          principalId: fixture.ids["principal-a1-owner"],
          threadId,
        });
        const verdict = await fixture.skills.invokeComponentFunction(
          await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
          { name, functionName: "loadRows", threadId },
        );
        expect(isCanonicalNotFound(verdict)).toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  // AC3：版本升级只影响本范围安装；另一公司的同名组件不受影响
  // -------------------------------------------------------------------------
  describeDb("AC3 版本升级范围隔离", () => {
    itDb("A 升 v2 只影响 A：A 读 v2，B 同名组件仍 v1 照常可用", async () => {
      const name = NEXT.name("widget");
      await fixture.skills.publishComponent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { name },
      );
      await fixture.skills.publishComponent(
        await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
        { name },
      );
      const upgraded = await fixture.skills.upgradeComponent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { name, toRevision: 2 },
      );
      expect(upgraded).toEqual({ outcome: "allow", name, revision: 2 });
      const inA = await fixture.skills.invokeComponentFunction(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        { name, functionName: "loadRows" },
      );
      expect(inA).toEqual({
        outcome: "allow",
        name,
        revision: 2,
        functionName: "loadRows",
      });
      const inB = await fixture.skills.invokeComponentFunction(
        await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
        { name, functionName: "loadRows" },
      );
      expect(inB).toEqual({
        outcome: "allow",
        name,
        revision: 1,
        functionName: "loadRows",
      });
    });

    itDb("版本回退明确拒绝；目标版本重放幂等收敛", async () => {
      const name = NEXT.name("widget");
      await fixture.skills.publishComponent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { name },
      );
      await fixture.skills.upgradeComponent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { name, toRevision: 3 },
      );
      const rollback = await fixture.skills.upgradeComponent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { name, toRevision: 2 },
      );
      expect(rollback).toEqual({
        outcome: "deny",
        code: "COMPONENT_VERSION_NOT_MONOTONIC",
      });
      const replay = await fixture.skills.upgradeComponent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { name, toRevision: 3 },
      );
      expect(replay).toEqual({ outcome: "allow", name, revision: 3 });
    });

    itDb("非作者非 admin 的成员升级/撤销被拒（可解释码）", async () => {
      const name = NEXT.name("widget");
      await fixture.skills.publishComponent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { name },
      );
      const upgrade = await fixture.skills.upgradeComponent(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        { name, toRevision: 2 },
      );
      expect(upgrade).toEqual({
        outcome: "deny",
        code: "SKILL_PUBLISH_FORBIDDEN",
      });
      const unpublish = await fixture.skills.unpublish(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        { kind: "component", name },
      );
      expect(unpublish).toEqual({
        outcome: "deny",
        code: "SKILL_PUBLISH_FORBIDDEN",
      });
      // 组件事实未被非授权者触碰：成员仍可用 v1。
      const read = await fixture.skills.invokeComponentFunction(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        { name, functionName: "loadRows" },
      );
      expect(read).toEqual({
        outcome: "allow",
        name,
        revision: 1,
        functionName: "loadRows",
      });
    });
  });

  // -------------------------------------------------------------------------
  // AC4：撤销发布后成员立即失去使用权
  // -------------------------------------------------------------------------
  describeDb("AC4 撤销发布立即失效", () => {
    itDb("撤销技能发布：成员下一次读取 canonical not-found", async () => {
      const name = NEXT.name("skill");
      await publishSkillA1(name);
      const before = await fixture.skills.readSkill(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        name,
      );
      expect(before.outcome).toBe("allow");
      const revoked = await fixture.skills.unpublish(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { kind: "skill", name },
      );
      expect(revoked.outcome).toBe("allow");
      const after = await fixture.skills.readSkill(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        name,
      );
      expect(isCanonicalNotFound(after)).toBe(true);
    });

    itDb("撤销组件发布：成员数据函数调用立即 not-found", async () => {
      const name = NEXT.name("component");
      await fixture.skills.publishComponent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { name },
      );
      const before = await fixture.skills.invokeComponentFunction(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        { name, functionName: "loadRows" },
      );
      expect(before.outcome).toBe("allow");
      await fixture.skills.unpublish(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { kind: "component", name },
      );
      const after = await fixture.skills.invokeComponentFunction(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        { name, functionName: "loadRows" },
      );
      expect(isCanonicalNotFound(after)).toBe(true);
      // 撤销后再撤销（活跃行已无）：canonical not-found（不泄露历史）。
      const again = await fixture.skills.unpublish(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { kind: "component", name },
      );
      expect(isCanonicalNotFound(again)).toBe(true);
    });
  });

  itDb("受限角色全程在场（决策路径不经过超级用户）", async () => {
    const calls = fixture.restrictedCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.currentUser).toMatch(/^ob_ent_(data|operator|directory)$/);
    }
  });
});
