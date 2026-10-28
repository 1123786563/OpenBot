// server/tests/multitenancy/group-membership.test.ts
// MT023（Issue #66）：群聊成员与 Bot 席位的作用域。
//
// 验收事实源（Issue #66 四条，逐条对应 describe）：
//   (1) 跨公司用户或 Bot 无法被加入群；此类请求被拒绝且不泄露对象
//       存在性。
//   (2) 群成员只能访问该群内容，不因此获得其他会话或团队资源权限。
//   (3) 移除成员后其后续读取与事件订阅立即失效。
//   (4) Bot 席位变更经过与 Bot 发布一致的授权判定。
//
// 判定事实源：enterprise_resources kind='group-chat'（群）+
// enterprise_resource_grants action='read'（成员）+ kind='group-bot-seat'
// （席位，visibility 在场标记）+ MT016/MT017 的 Bot 归属与发布行。
// 群成员增删与席位变更全部经本票单一判定入口
// createGroupMembershipService。不可见对象按 MT011 canonical not-found
// 处理，错误与计数不泄露存在性。
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
  type GroupFixture,
  type GroupIdentity,
  createGroupFixture,
} from "./support/group-membership";

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
      reason: `MT023 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const NEXT = (() => {
  let groupN = 0;
  let botN = 0;
  return {
    groupId: () => `mt023-group-${String((groupN += 1)).padStart(3, "0")}`,
    agentId: () => `mt023-agent-${String((botN += 1)).padStart(3, "0")}`,
  };
})();

describeDb("MT023 / Issue #66 — 群聊成员与 Bot 席位的作用域", () => {
  let fixture: GroupFixture;

  const scopeAs = async (
    identity: GroupIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

  beforeAll(async () => {
    fixture = await createGroupFixture();
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  // -------------------------------------------------------------------------
  // AC1：跨公司用户/Bot 无法被加入群；拒绝不泄露存在性
  // -------------------------------------------------------------------------
  describeDb("AC1 跨公司用户或 Bot 无法被加入群", () => {
    let groupId: string;

    beforeAll(async () => {
      groupId = NEXT.groupId();
      const created = await fixture.group.createGroup(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { groupId, title: "MT023 群 A1" },
      );
      expect(created.outcome).toBe("allow");
    });

    itDb(
      "邀请跨公司用户（B 公司 principal）：canonical not-found",
      async () => {
        const verdict = await fixture.group.inviteMember(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          groupId,
          fixture.ids["principal-b1-member"],
        );
        expect(isCanonicalNotFound(verdict)).toBe(true);
      },
    );

    itDb("邀请不存在的 principal：逐字节同形（不泄露存在性）", async () => {
      const verdict = await fixture.group.inviteMember(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        `${fixture.idPrefix}-principal-ghost`,
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });

    itDb("跨公司 Bot 加席：canonical not-found（AC1 的 Bot 面）", async () => {
      const botId = NEXT.agentId();
      const bScope = await scopeAs(
        "b1-member",
        fixture.companyB,
        fixture.teamB1,
      );
      await fixture.ownership.createBot(bScope, {
        agentId: botId,
        displayName: "B 公司 Bot",
        defaultConfig: { model: "x" },
      });
      const published = await fixture.publish.publishBot(
        bScope,
        botId,
        fixture.teamAudience(fixture.companyB, fixture.teamB1),
      );
      expect(published.outcome).toBe("allow");
      const verdict = await fixture.group.addBotSeat(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        botId,
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });

    itDb("同公司同团队成员邀请成功；被邀者可读群", async () => {
      const verdict = await fixture.group.inviteMember(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        fixture.ids["principal-a1-other"],
      );
      expect(verdict.outcome).toBe("allow");
      const read = await fixture.group.readGroup(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        groupId,
      );
      expect(read.outcome).toBe("allow");
    });

    itDb(
      "群本身对跨团队（A2）与跨公司（B）读者 canonical not-found",
      async () => {
        const a2 = await fixture.group.readGroup(
          await scopeAs("a2-member", fixture.companyA, fixture.teamA2),
          groupId,
        );
        expect(isCanonicalNotFound(a2)).toBe(true);
        const b1 = await fixture.group.readGroup(
          await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
          groupId,
        );
        expect(isCanonicalNotFound(b1)).toBe(true);
      },
    );

    itDb("非群成员（同团队）也不能邀请：canonical not-found", async () => {
      // company-admin 在 A1 有成员行但未入群——群内自治，非成员无门。
      const verdict = await fixture.group.inviteMember(
        await scopeAs("company-admin", fixture.companyA, fixture.teamA1),
        groupId,
        fixture.ids["principal-a1-other"],
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC2：群成员只能访问该群内容，不因此获得其他资源权限
  // -------------------------------------------------------------------------
  describeDb("AC2 群成员资格不放大任何其他权限", () => {
    let groupId: string;
    let unrelatedId: string;

    beforeAll(async () => {
      groupId = NEXT.groupId();
      const created = await fixture.group.createGroup(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { groupId, title: "MT023 群 AC2" },
      );
      expect(created.outcome).toBe("allow");
      const invited = await fixture.group.inviteMember(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        fixture.ids["principal-a1-other"],
      );
      expect(invited.outcome).toBe("allow");
      // 无关资源：同团队注册行、零 grant（成员面之外的事实）。
      unrelatedId = `${fixture.idPrefix}-unrelated-kb`;
      await fixture.seedUnrelatedResource({
        tenantId: fixture.companyA,
        workspaceId: fixture.teamA1,
        id: unrelatedId,
        kind: "knowledge_base",
        displayName: "MT023 无关知识库",
      });
    });

    itDb("群成员可读群（成员计数含创建者与被邀者）", async () => {
      const read = await fixture.group.readGroup(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        groupId,
      );
      expect(read).toEqual({
        outcome: "allow",
        groupId,
        title: "MT023 群 AC2",
        workspaceId: fixture.teamA1,
        memberCount: 2,
        seats: [],
      });
    });

    itDb("群成员对无关资源零授权：RLS 探针无其 grant 行", async () => {
      const grants = await fixture.readGrantRowsAsData(
        fixture.companyA,
        unrelatedId,
      );
      expect(grants).toEqual([]);
      // 群本身的 grant 行只有群成员两名——不因入群多出别的行。
      const groupGrants = await fixture.readGrantRowsAsData(
        fixture.companyA,
        groupId,
      );
      expect(groupGrants.sort()).toEqual(
        [
          fixture.ids["principal-a1-owner"],
          fixture.ids["principal-a1-other"],
        ].sort(),
      );
    });

    itDb("未入群的同团队成员读群：canonical not-found", async () => {
      const read = await fixture.group.readGroup(
        await scopeAs("company-admin", fixture.companyA, fixture.teamA1),
        groupId,
      );
      expect(isCanonicalNotFound(read)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC3：移除成员后其后续读取与事件订阅立即失效
  // -------------------------------------------------------------------------
  describeDb("AC3 移除成员立即失效", () => {
    let groupId: string;
    const member = () => fixture.ids["principal-a1-other"];

    beforeAll(async () => {
      groupId = NEXT.groupId();
      const created = await fixture.group.createGroup(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { groupId, title: "MT023 群 AC3" },
      );
      expect(created.outcome).toBe("allow");
      const invited = await fixture.group.inviteMember(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        member(),
      );
      expect(invited.outcome).toBe("allow");
      const read = await fixture.group.readGroup(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        groupId,
      );
      expect(read.outcome).toBe("allow");
    });

    itDb("移除后同一身份的读取立即 canonical not-found（无缓存）", async () => {
      const removed = await fixture.group.removeMember(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        member(),
      );
      expect(removed.outcome).toBe("allow");
      const read = await fixture.group.readGroup(
        (await scopeAs("a1-owner", fixture.companyA, fixture.teamA1)) &&
          (await scopeAs("a1-other", fixture.companyA, fixture.teamA1)),
        groupId,
      );
      expect(isCanonicalNotFound(read)).toBe(true);
      // grant 行已物理消失（RLS 探针）。
      const grants = await fixture.readGrantRowsAsData(
        fixture.companyA,
        groupId,
      );
      expect(grants).toEqual([fixture.ids["principal-a1-owner"]]);
    });

    itDb("移除后其邀请权同样失效（成员自治门）", async () => {
      const verdict = await fixture.group.inviteMember(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        groupId,
        fixture.ids["principal-company-admin"],
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });

    itDb("重新邀请后恢复（同一事实行的可逆生命周期）", async () => {
      const invited = await fixture.group.inviteMember(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        member(),
      );
      expect(invited.outcome).toBe("allow");
      const read = await fixture.group.readGroup(
        (await scopeAs("a1-owner", fixture.companyA, fixture.teamA1)) &&
          (await scopeAs("a1-other", fixture.companyA, fixture.teamA1)),
        groupId,
      );
      expect(read.outcome).toBe("allow");
    });
  });

  // -------------------------------------------------------------------------
  // AC4：Bot 席位变更经过与 Bot 发布一致的授权判定
  // -------------------------------------------------------------------------
  describeDb("AC4 Bot 席位与发布一致授权", () => {
    let groupId: string;
    let botId: string;

    beforeAll(async () => {
      groupId = NEXT.groupId();
      botId = NEXT.agentId();
      const created = await fixture.group.createGroup(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { groupId, title: "MT023 群 AC4" },
      );
      expect(created.outcome).toBe("allow");
      const bot = await fixture.ownership.createBot(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        {
          agentId: botId,
          displayName: "MT023 席位 Bot",
          defaultConfig: { model: "y" },
        },
      );
      expect(bot.outcome).toBe("allow");
    });

    itDb("未发布的 Bot 加席：canonical not-found（发布事实缺失）", async () => {
      const verdict = await fixture.group.addBotSeat(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        botId,
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });

    itDb("发布后 owner 加席 allow；席位出现在群读取面", async () => {
      const published = await fixture.publish.publishBot(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        botId,
        fixture.teamAudience(fixture.companyA, fixture.teamA1),
      );
      expect(published.outcome).toBe("allow");
      const verdict = await fixture.group.addBotSeat(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        botId,
      );
      expect(verdict.outcome).toBe("allow");
      const read = await fixture.group.readGroup(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
      );
      expect(read.outcome).toBe("allow");
      expect((read as { seats: string[] }).seats).toEqual([botId]);
    });

    itDb(
      "非 Bot owner 非 tenant_admin（a1-other）：GROUP_SEAT_FORBIDDEN",
      async () => {
        // a1-other 先入群（席位操作者须是群成员）。
        await fixture.group.inviteMember(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          groupId,
          fixture.ids["principal-a1-other"],
        );
        const verdict = await fixture.group.addBotSeat(
          await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
          groupId,
          botId,
        );
        expect(verdict).toEqual({
          outcome: "deny",
          code: "GROUP_SEAT_FORBIDDEN",
        });
      },
    );

    itDb("公司 tenant_admin 可加席（与发布管理门同形）", async () => {
      // company-admin 入群后行使席位管理（Bot 发布同款 tenant_admin 臂）。
      await fixture.group.inviteMember(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        fixture.ids["principal-company-admin"],
      );
      const verdict = await fixture.group.addBotSeat(
        await scopeAs("company-admin", fixture.companyA, fixture.teamA1),
        groupId,
        botId,
      );
      expect(verdict.outcome).toBe("allow");
    });

    itDb("撤席后席位消失；重复撤席 canonical not-found", async () => {
      const removed = await fixture.group.removeBotSeat(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        botId,
      );
      expect(removed.outcome).toBe("allow");
      const read = await fixture.group.readGroup(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
      );
      expect((read as { seats: string[] }).seats).toEqual([]);
      const again = await fixture.group.removeBotSeat(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        groupId,
        botId,
      );
      expect(isCanonicalNotFound(again)).toBe(true);
    });

    itDb("受限角色全程在场（决策路径不经过超级用户）", async () => {
      const calls = fixture.restrictedCalls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.currentUser).toMatch(/^ob_ent_(data|operator|directory)$/);
      }
    });
  });
});
