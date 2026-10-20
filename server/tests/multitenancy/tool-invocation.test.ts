// server/tests/multitenancy/tool-invocation.test.ts
// MT032（Issue #75）：工具调用时重新校验当前用户连接与 Bot 授权。
//
// 验收事实源（Issue #75 四条，逐条对应 describe）：
//   (1) 撤销连接或 Bot 授权后，正在进行的会话下一次工具调用被拒绝。
//   (2) 不能用创建者或其他用户的连接完成调用（含公共 Bot 场景）。
//   (3) 校验结果不跨用户/跨范围缓存污染。
//   (4) 拒绝时返回可解释原因，不泄露他人连接是否存在。
//
// 判定事实源：enterprise_bot_ownership（MT016）+ MT017 发布注册行 +
// enterprise_credentials / enterprise_credential_actions（MT027，'use'
// 动作行删除即撤销）+ enterprise_memberships 事实重验（MT006 epoch）。
// 全链路经本票单一判定入口 createToolInvocationService；不可见对象按
// MT011 canonical not-found 处理。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_
// DATABASE_URL）加三个受限角色 URL；缺配置时整套显式 skip（跳过原因
// 写在用例名里，skipped 不计为通过），绝不回退开发库。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
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
  type ToolFixture,
  type ToolIdentity,
  createToolFixture,
} from "./support/tool-invocation";

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
      reason: `MT032 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

describeDb("MT032 / Issue #75 — 工具调用重校验", () => {
  let fixture: ToolFixture;

  const scopeAs = async (
    identity: ToolIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope> =>
    fixture.scopeAs(identity, tenantId, workspaceId);

  const NEXT = (() => {
    let agentN = 0;
    let credN = 0;
    return {
      agentId: () => `mt032-agent-${String((agentN += 1)).padStart(3, "0")}`,
      credentialId: () => `mt032-cred-${String((credN += 1)).padStart(3, "0")}`,
    };
  })();

  beforeAll(async () => {
    fixture = await createToolFixture();
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  // -------------------------------------------------------------------------
  // AC1：撤销连接或 Bot 授权后，下一次工具调用被拒
  // -------------------------------------------------------------------------
  describeDb("AC1 撤销立即生效", () => {
    itDb("撤销连接 'use' 授权后下一次调用被拒（可解释码）", async () => {
      const agentId = NEXT.agentId();
      const credentialId = NEXT.credentialId();
      await fixture.ownership.createBot(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { agentId, displayName: "MT032 自有 Bot", defaultConfig: {} },
      );
      await fixture.seedConnection({
        tenantId: fixture.companyA,
        ownerPrincipalId: fixture.ids["principal-a1-owner"],
        credentialId,
      });
      const before = await fixture.tools.authorizeToolInvocation(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { agentId, toolName: "web.search", credentialId },
      );
      expect(before).toEqual({ outcome: "allow" });
      // 会话仍在进行（同一 scope 继续），撤销后下一次调用被拒。
      await fixture.revokeConnectionUse({
        tenantId: fixture.companyA,
        credentialId,
        principalId: fixture.ids["principal-a1-owner"],
      });
      const after = await fixture.tools.authorizeToolInvocation(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { agentId, toolName: "web.search", credentialId },
      );
      expect(after).toEqual({
        outcome: "deny",
        code: "TOOL_CREDENTIAL_NOT_USABLE",
      });
    });

    itDb("撤销 Bot 发布后下一次调用被拒（团队公共 Bot 门）", async () => {
      const agentId = NEXT.agentId();
      const ownerScope = await scopeAs("a1-owner", fixture.companyA, fixture.teamA1);
      await fixture.ownership.createBot(ownerScope, {
        agentId,
        displayName: "MT032 公共 Bot",
        defaultConfig: {},
      });
      await fixture.publish.publishBot(
        ownerScope,
        agentId,
        fixture.teamAudience(fixture.companyA, fixture.teamA1),
      );
      const userScope = await scopeAs("a1-other", fixture.companyA, fixture.teamA1);
      const before = await fixture.tools.authorizeToolInvocation(userScope, {
        agentId,
        toolName: "kb.search",
      });
      expect(before).toEqual({ outcome: "allow" });
      await fixture.publish.unpublishBot(ownerScope, agentId);
      const after = await fixture.tools.authorizeToolInvocation(userScope, {
        agentId,
        toolName: "kb.search",
      });
      expect(after).toEqual({ outcome: "deny", code: "TOOL_BOT_NOT_USABLE" });
    });
  });

  // -------------------------------------------------------------------------
  // AC2：不能用创建者或其他用户的连接完成调用（含公共 Bot）
  // -------------------------------------------------------------------------
  describeDb("AC2 连接只能是使用者本人的", () => {
    itDb("a1-other 携 a1-owner 的连接调用公共 Bot：canonical not-found", async () => {
      const agentId = NEXT.agentId();
      const credentialId = NEXT.credentialId();
      const ownerScope = await scopeAs("a1-owner", fixture.companyA, fixture.teamA1);
      await fixture.ownership.createBot(ownerScope, {
        agentId,
        displayName: "MT032 公共 Bot",
        defaultConfig: {},
      });
      await fixture.publish.publishBot(
        ownerScope,
        agentId,
        fixture.teamAudience(fixture.companyA, fixture.teamA1),
      );
      await fixture.seedConnection({
        tenantId: fixture.companyA,
        ownerPrincipalId: fixture.ids["principal-a1-owner"],
        credentialId,
      });
      const verdict = await fixture.tools.authorizeToolInvocation(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        { agentId, toolName: "web.search", credentialId },
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });

    itDb("他人连接与不存在连接对外同形（不泄露他人连接是否存在）", async () => {
      const agentId = NEXT.agentId();
      const ownerScope = await scopeAs("a1-owner", fixture.companyA, fixture.teamA1);
      await fixture.ownership.createBot(ownerScope, {
        agentId,
        displayName: "MT032 Bot",
        defaultConfig: {},
      });
      // Bot 门必须放行（团队公共 Bot），用例才真正打到连接门——
      // 他人连接与不存在连接在连接可见性上同形。
      await fixture.publish.publishBot(
        ownerScope,
        agentId,
        fixture.teamAudience(fixture.companyA, fixture.teamA1),
      );
      const othersCredential = NEXT.credentialId();
      await fixture.seedConnection({
        tenantId: fixture.companyA,
        ownerPrincipalId: fixture.ids["principal-a1-owner"],
        credentialId: othersCredential,
      });
      const ghostCredential = NEXT.credentialId();
      const asOther = await scopeAs("a1-other", fixture.companyA, fixture.teamA1);
      const withOthers = await fixture.tools.authorizeToolInvocation(asOther, {
        agentId,
        toolName: "web.search",
        credentialId: othersCredential,
      });
      const withGhost = await fixture.tools.authorizeToolInvocation(asOther, {
        agentId,
        toolName: "web.search",
        credentialId: ghostCredential,
      });
      expect(JSON.stringify(withOthers)).toBe(JSON.stringify(withGhost));
      expect(isCanonicalNotFound(withOthers)).toBe(true);
    });

    itDb("跨公司连接（B 的连接行）对 A 的调用 canonical not-found", async () => {
      const agentId = NEXT.agentId();
      await fixture.ownership.createBot(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { agentId, displayName: "MT032 Bot", defaultConfig: {} },
      );
      const bCredential = NEXT.credentialId();
      await fixture.seedConnection({
        tenantId: fixture.companyB,
        ownerPrincipalId: fixture.ids["principal-b1-member"],
        credentialId: bCredential,
      });
      const verdict = await fixture.tools.authorizeToolInvocation(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { agentId, toolName: "web.search", credentialId: bCredential },
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC3：校验结果不跨用户/跨范围缓存污染
  // -------------------------------------------------------------------------
  describeDb("AC3 无缓存污染", () => {
    itDb("同 (agent, credential) 交错调用：owner allow / 他人 not-found / owner 仍 allow", async () => {
      const agentId = NEXT.agentId();
      const credentialId = NEXT.credentialId();
      const ownerScope = await scopeAs("a1-owner", fixture.companyA, fixture.teamA1);
      await fixture.ownership.createBot(ownerScope, {
        agentId,
        displayName: "MT032 Bot",
        defaultConfig: {},
      });
      await fixture.publish.publishBot(
        ownerScope,
        agentId,
        fixture.teamAudience(fixture.companyA, fixture.teamA1),
      );
      await fixture.seedConnection({
        tenantId: fixture.companyA,
        ownerPrincipalId: fixture.ids["principal-a1-owner"],
        credentialId,
      });
      const call = (scope: PlatformScope) =>
        fixture.tools.authorizeToolInvocation(scope, {
          agentId,
          toolName: "web.search",
          credentialId,
        });
      expect((await call(ownerScope)).outcome).toBe("allow");
      const asOther = await scopeAs("a1-other", fixture.companyA, fixture.teamA1);
      expect(isCanonicalNotFound(await call(asOther))).toBe(true);
      // 他人 deny 不污染本人后续结论（判定零缓存的结构证明）。
      expect((await call(ownerScope)).outcome).toBe("allow");
      expect((await call(ownerScope)).outcome).toBe("allow");
    });

    itDb("跨范围（A2 团队）对 A1 发布 Bot deny；回 A1 仍 allow（无范围串用）", async () => {
      const agentId = NEXT.agentId();
      const ownerScope = await scopeAs("a1-owner", fixture.companyA, fixture.teamA1);
      await fixture.ownership.createBot(ownerScope, {
        agentId,
        displayName: "MT032 Bot",
        defaultConfig: {},
      });
      await fixture.publish.publishBot(
        ownerScope,
        agentId,
        fixture.teamAudience(fixture.companyA, fixture.teamA1),
      );
      const a1a2 = async () =>
        fixture.tools.authorizeToolInvocation(
          await scopeAs("a1a2-member", fixture.companyA, fixture.teamA1),
          { agentId, toolName: "kb.search" },
        );
      const a2 = async () =>
        fixture.tools.authorizeToolInvocation(
          await scopeAs("a1a2-member", fixture.companyA, fixture.teamA2),
          { agentId, toolName: "kb.search" },
        );
      expect((await a1a2()).outcome).toBe("allow");
      const crossScope = await a2();
      // A2 团队对 A1 发布的 Bot：无归属行也无本范围发布行——与 AC4
      // "未发布且非本人"同构的可解释拒绝（deny 码），不是 not-found。
      expect(crossScope).toEqual({
        outcome: "deny",
        code: "TOOL_BOT_NOT_USABLE",
      });
      expect((await a1a2()).outcome).toBe("allow");
    });
  });

  // -------------------------------------------------------------------------
  // AC4：拒绝可解释；不泄露他人连接（同形已在 AC2 钉死）
  // -------------------------------------------------------------------------
  describeDb("AC4 拒绝可解释", () => {
    itDb("本人连接无 use 授权 → 明确码（可见前提下的可解释拒绝）", async () => {
      const agentId = NEXT.agentId();
      const credentialId = NEXT.credentialId();
      await fixture.ownership.createBot(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { agentId, displayName: "MT032 Bot", defaultConfig: {} },
      );
      await fixture.seedConnection({
        tenantId: fixture.companyA,
        ownerPrincipalId: fixture.ids["principal-a1-owner"],
        credentialId,
      });
      await fixture.revokeConnectionUse({
        tenantId: fixture.companyA,
        credentialId,
        principalId: fixture.ids["principal-a1-owner"],
      });
      const verdict = await fixture.tools.authorizeToolInvocation(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { agentId, toolName: "web.search", credentialId },
      );
      expect(verdict).toEqual({
        outcome: "deny",
        code: "TOOL_CREDENTIAL_NOT_USABLE",
      });
    });

    itDb("未发布且非本人的 Bot → 明确码（不与 not-found 混淆）", async () => {
      const agentId = NEXT.agentId();
      await fixture.ownership.createBot(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { agentId, displayName: "MT032 私有 Bot", defaultConfig: {} },
      );
      const verdict = await fixture.tools.authorizeToolInvocation(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        { agentId, toolName: "kb.search" },
      );
      expect(verdict).toEqual({ outcome: "deny", code: "TOOL_BOT_NOT_USABLE" });
    });

    itDb("受限角色全程在场（决策路径不经过超级用户）", async () => {
      const calls = fixture.restrictedCalls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.currentUser).toMatch(/^ob_ent_(data|operator|directory)$/);
      }
    });

    // 撤权用例置于套件末尾：MT006 停用是持久事实，被撤权身份（a1-other）
    // 此后不再被复用（恢复走 MT007 恢复面，本套件无恢复通道）。
    itDb("撤权（MT006 停用）后 scope 死亡：下一次调用无法发起", async () => {
      const staleScope = await scopeAs(
        "a1-other",
        fixture.companyA,
        fixture.teamA1,
      );
      const agentId = NEXT.agentId();
      await fixture.ownership.createBot(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { agentId, displayName: "MT032 Bot", defaultConfig: {} },
      );
      await fixture.publish.publishBot(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        agentId,
        fixture.teamAudience(fixture.companyA, fixture.teamA1),
      );
      expect(
        (
          await fixture.tools.authorizeToolInvocation(staleScope, {
            agentId,
            toolName: "kb.search",
          })
        ).outcome,
      ).toBe("allow");
      // 停用后新 scope 拒发；旧 scope（旧 epoch）下一次调用 not-found。
      await fixture.suspendCompanyMembership(
        fixture.companyA,
        fixture.ids["principal-a1-other"],
      );
      await expect(
        scopeAs("a1-other", fixture.companyA, fixture.teamA1),
      ).rejects.toThrow("TENANT_FORBIDDEN");
      const after = await fixture.tools.authorizeToolInvocation(staleScope, {
        agentId,
        toolName: "kb.search",
      });
      expect(isCanonicalNotFound(after)).toBe(true);
    });
  });
});
