// server/tests/multitenancy/streams.test.ts
// MT025（Issue #68）：事件流订阅授权与外部线程映射归属。
//
// 验收事实源（Issue #68 四条，逐条对应 describe）：
//   (1) 订阅时校验权限；订阅后被撤权则停止推送并关闭连接。
//   (2) 事件正文不包含订阅者无权访问的内容（含错误与状态事件）。
//   (3) 外部线程 ID 携带归属但仍需授权；用另一公司的线程 ID 无法
//       读取或续订。
//   (4) 切换公司/团队后旧范围订阅被取消，不产生跨范围推送。
//
// 判定事实源：enterprise_resources kind='event-subscription'（订阅）+
// kind='thread-mapping'（映射）+ enterprise_memberships /
// workspace_memberships 的事实重验（MT006 epoch）。全链路经本票单一
// 判定入口 createStreamSubscriptionService；不可见对象按 MT011
// canonical not-found 处理。
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
} from "../../../tests/support/bun-test-compat";
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
  type StreamFixture,
  type StreamIdentity,
  createStreamFixture,
} from "./support/streams";

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
      reason: `MT025 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

let threadCounter = 0;
const nextThread = () =>
  `mt025-thread-${String((threadCounter += 1)).padStart(3, "0")}`;

describeDb("MT025 / Issue #68 — 事件流订阅与线程映射归属", () => {
  let fixture: StreamFixture;

  const scopeAs = async (
    identity: StreamIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

  /** 为 identity 建（自家）会话并开订阅，返回订阅 id。 */
  const openOnOwnThread = async (
    identity: StreamIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<{ subscriptionId: string; threadId: string }> => {
    const threadId = nextThread();
    await fixture.seedConversation({
      tenantId,
      workspaceId,
      principalId: fixture.ids[`principal-${identity}`],
      threadId,
    });
    const opened = await fixture.streams.openSubscription(
      await scopeAs(identity, tenantId, workspaceId),
      { threadId },
    );
    expect(opened.outcome).toBe("allow");
    return {
      subscriptionId: (opened as { subscriptionId: string }).subscriptionId,
      threadId,
    };
  };

  beforeAll(async () => {
    fixture = await createStreamFixture();
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  // -------------------------------------------------------------------------
  // AC1：订阅时校验权限；撤权后停止推送并关闭
  // -------------------------------------------------------------------------
  describeDb("AC1 订阅权限与撤权停推", () => {
    itDb("对他人/不存在的会话开订阅：canonical not-found", async () => {
      const threadId = nextThread();
      await fixture.seedConversation({
        tenantId: fixture.companyA,
        workspaceId: fixture.teamA1,
        principalId: fixture.ids["principal-a1-owner"],
        threadId,
      });
      const fromOther = await fixture.streams.openSubscription(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        { threadId },
      );
      expect(isCanonicalNotFound(fromOther)).toBe(true);
      const ghost = await fixture.streams.openSubscription(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { threadId: "mt025-thread-ghost" },
      );
      expect(isCanonicalNotFound(ghost)).toBe(true);
    });

    itDb("对自家会话开订阅 allow；正常推送 delivered", async () => {
      const { subscriptionId } = await openOnOwnThread(
        "a1-owner",
        fixture.companyA,
        fixture.teamA1,
      );
      const pushed = await fixture.streams.pushEvent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        subscriptionId,
        { type: "message", status: "ok", message: "hello" },
      );
      expect(pushed).toEqual({
        outcome: "delivered",
        body: { type: "message", status: "ok", message: "hello" },
      });
    });
  });

  // -------------------------------------------------------------------------
  // AC2：事件正文不含无权内容（含错误与状态事件）
  // -------------------------------------------------------------------------
  describeDb("AC2 事件正文白名单闭形", () => {
    itDb(
      "正文只有 type/status/message 三键（错误与状态事件同形）",
      async () => {
        const { subscriptionId } = await openOnOwnThread(
          "a1-owner",
          fixture.companyA,
          fixture.teamA1,
        );
        const scope = await scopeAs(
          "a1-owner",
          fixture.companyA,
          fixture.teamA1,
        );
        const errorEvent = await fixture.streams.pushEvent(
          scope,
          subscriptionId,
          {
            type: "error",
            status: "failed",
            message: "工具调用失败",
          },
        );
        expect(errorEvent).toEqual({
          outcome: "delivered",
          body: { type: "error", status: "failed", message: "工具调用失败" },
        });
        expect(
          Object.keys((errorEvent as { body: object }).body).sort(),
        ).toEqual(["message", "status", "type"]);
        const statusEvent = await fixture.streams.pushEvent(
          scope,
          subscriptionId,
          {
            type: "status",
            status: "ok",
            message: "运行中",
          },
        );
        expect(
          Object.keys((statusEvent as { body: object }).body).sort(),
        ).toEqual(["message", "status", "type"]);
      },
    );

    itDb("构造面无法夹带：非法正文（含多余字段语义）被响亮拒绝", async () => {
      const { subscriptionId } = await openOnOwnThread(
        "a1-owner",
        fixture.companyA,
        fixture.teamA1,
      );
      await expect(
        fixture.streams.pushEvent(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          subscriptionId,
          {
            type: "message",
            status: "ok",
            message: "x",
            // @ts-expect-error 构造面夹带测试：白名单外的字段。
            secretThreadRef: `${fixture.companyB}/thread-x`,
          } as never,
        ),
      ).rejects.toThrow("STREAM_EVENT_BODY_INVALID");
    });

    itDb(
      "订阅行事实不含无权内容：displayName 只承载自家 threadId",
      async () => {
        const { subscriptionId, threadId } = await openOnOwnThread(
          "a1-owner",
          fixture.companyA,
          fixture.teamA1,
        );
        const rows = await fixture.readStreamRowsAsData(fixture.companyA);
        const row = rows.find((candidate) => candidate.id === subscriptionId);
        expect(row?.displayName).toBe(threadId);
        expect(row?.workspaceId).toBe(fixture.teamA1);
        expect(row?.displayName.startsWith("mt025-thread")).toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  // AC3：外部线程 ID 归属；另一公司的串无法读取/续订
  // -------------------------------------------------------------------------
  describeDb("AC3 外部线程映射归属", () => {
    const externalId = "slack-c123";

    itDb("A、B 两家各自绑定同一外部串：互为独立行", async () => {
      const threadA = nextThread();
      const threadB = nextThread();
      await fixture.seedConversation({
        tenantId: fixture.companyA,
        workspaceId: fixture.teamA1,
        principalId: fixture.ids["principal-a1-owner"],
        threadId: threadA,
      });
      await fixture.seedConversation({
        tenantId: fixture.companyB,
        workspaceId: fixture.teamB1,
        principalId: fixture.ids["principal-b1-member"],
        threadId: threadB,
      });
      const boundA = await fixture.streams.bindExternalThread(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        { externalId, threadId: threadA },
      );
      expect(boundA.outcome).toBe("allow");
      const boundB = await fixture.streams.bindExternalThread(
        await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
        { externalId, threadId: threadB },
      );
      expect(boundB.outcome).toBe("allow");
    });

    itDb(
      "A 公司按外部串读到自己的 thread；B 公司读到自己的（各不相见）",
      async () => {
        const fromA = await fixture.streams.readThreadByExternal(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          externalId,
        );
        expect(fromA.outcome).toBe("allow");
        const fromB = await fixture.streams.readThreadByExternal(
          await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
          externalId,
        );
        expect(fromB.outcome).toBe("allow");
        expect((fromA as { threadId: string }).threadId).not.toBe(
          (fromB as { threadId: string }).threadId,
        );
      },
    );

    itDb(
      "未绑定的外部串：canonical not-found（不泄露别家是否绑定）",
      async () => {
        const verdict = await fixture.streams.readThreadByExternal(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          "slack-not-bound-anywhere",
        );
        expect(isCanonicalNotFound(verdict)).toBe(true);
      },
    );

    itDb(
      "续订同读取同门：另一公司的串无法续订他家的（各家只续自家）",
      async () => {
        const renewA = await fixture.streams.renewSubscriptionByExternal(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          externalId,
        );
        expect(renewA.outcome).toBe("allow");
        const renewGhost = await fixture.streams.renewSubscriptionByExternal(
          await scopeAs("a2-member", fixture.companyA, fixture.teamA2),
          externalId,
        );
        // A2 团队不在映射归属范围内：canonical not-found。
        expect(isCanonicalNotFound(renewGhost)).toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  // AC4：切换公司/团队后旧范围订阅被取消
  // -------------------------------------------------------------------------
  describeDb("AC4 切换范围取消旧订阅", () => {
    itDb("同 principal 在另一团队开新订阅：旧团队订阅被取消", async () => {
      const a1Thread = nextThread();
      await fixture.seedConversation({
        tenantId: fixture.companyA,
        workspaceId: fixture.teamA1,
        principalId: fixture.ids["principal-a1a2-member"],
        threadId: a1Thread,
      });
      const first = await fixture.streams.openSubscription(
        await scopeAs("a1a2-member", fixture.companyA, fixture.teamA1),
        { threadId: a1Thread },
      );
      expect(first.outcome).toBe("allow");
      const firstId = (first as { subscriptionId: string }).subscriptionId;

      // 同一 principal 切到 A2 团队开新订阅（切换范围）。
      const a2Thread = nextThread();
      await fixture.seedConversation({
        tenantId: fixture.companyA,
        workspaceId: fixture.teamA2,
        principalId: fixture.ids["principal-a1a2-member"],
        threadId: a2Thread,
      });
      const second = await fixture.streams.openSubscription(
        await scopeAs("a1a2-member", fixture.companyA, fixture.teamA2),
        { threadId: a2Thread },
      );
      expect(second.outcome).toBe("allow");

      // 旧范围订阅已被取消（visibility → 'private'），新订阅活跃。
      const rows = await fixture.readStreamRowsAsData(fixture.companyA);
      expect(rows.find((row) => row.id === firstId)?.visibility).toBe(
        "private",
      );
      const secondId = (second as { subscriptionId: string }).subscriptionId;
      expect(rows.find((row) => row.id === secondId)?.visibility).toBe(null);
      expect(rows.find((row) => row.id === secondId)?.workspaceId).toBe(
        fixture.teamA2,
      );
    });

    itDb(
      "取消后的旧订阅不产生跨范围推送（同 workspace 推送也 not-found）",
      async () => {
        const a1Thread = nextThread();
        await fixture.seedConversation({
          tenantId: fixture.companyA,
          workspaceId: fixture.teamA1,
          principalId: fixture.ids["principal-a1a2-member"],
          threadId: a1Thread,
        });
        const first = await fixture.streams.openSubscription(
          await scopeAs("a1a2-member", fixture.companyA, fixture.teamA1),
          { threadId: a1Thread },
        );
        const firstId = (first as { subscriptionId: string }).subscriptionId;
        // 切到 A2 开一条（驱动收旧），再回 A1 推旧订阅。
        const a2Thread = nextThread();
        await fixture.seedConversation({
          tenantId: fixture.companyA,
          workspaceId: fixture.teamA2,
          principalId: fixture.ids["principal-a1a2-member"],
          threadId: a2Thread,
        });
        await fixture.streams.openSubscription(
          await scopeAs("a1a2-member", fixture.companyA, fixture.teamA2),
          { threadId: a2Thread },
        );
        const pushed = await fixture.streams.pushEvent(
          await scopeAs("a1a2-member", fixture.companyA, fixture.teamA1),
          firstId,
          { type: "message", status: "ok", message: "after switch" },
        );
        expect(isCanonicalNotFound(pushed)).toBe(true);
      },
    );

    itDb(
      "同 workspace 的既有订阅不收（收旧只针对其他 workspace）",
      async () => {
        const first = await openOnOwnThread(
          "a1-owner",
          fixture.companyA,
          fixture.teamA1,
        );
        await openOnOwnThread("a1-owner", fixture.companyA, fixture.teamA1);
        const rows = await fixture.readStreamRowsAsData(fixture.companyA);
        expect(
          rows.find((row) => row.id === first.subscriptionId)?.visibility,
        ).toBe(null);
      },
    );

    itDb("显式取消后推送 not-found；未取消的订阅仍 delivered", async () => {
      const first = await openOnOwnThread(
        "a1-owner",
        fixture.companyA,
        fixture.teamA1,
      );
      const second = await openOnOwnThread(
        "a1-owner",
        fixture.companyA,
        fixture.teamA1,
      );
      const cancelled = await fixture.streams.cancelSubscription(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        first.subscriptionId,
      );
      expect(cancelled.outcome).toBe("allow");
      const pushed = await fixture.streams.pushEvent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        first.subscriptionId,
        { type: "message", status: "ok", message: "after cancel" },
      );
      expect(isCanonicalNotFound(pushed)).toBe(true);
      const stillLive = await fixture.streams.pushEvent(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        second.subscriptionId,
        { type: "message", status: "ok", message: "still live" },
      );
      expect(stillLive.outcome).toBe("delivered");
    });
  });

  // -------------------------------------------------------------------------
  // 撤权用例置于套件末尾：MT006 停用是持久事实（恢复走 MT007 恢复面，
  // 本套件无恢复通道），被撤权身份不再被后续用例复用。
  itDb("撤权后推送：closed（停止推送并关闭连接）", async () => {
    const { subscriptionId } = await openOnOwnThread(
      "a1-other",
      fixture.companyA,
      fixture.teamA1,
    );
    // 撤权前签发的 scope（旧 memberEpoch）——已建立的订阅连接持有
    // 的正是这个事实快照。
    const staleScope = await scopeAs(
      "a1-other",
      fixture.companyA,
      fixture.teamA1,
    );
    await fixture.suspendCompanyMembership(
      fixture.companyA,
      fixture.ids["principal-a1-other"],
    );
    // 新签发面立即死亡（scope resolver 拒发）。
    await expect(
      scopeAs("a1-other", fixture.companyA, fixture.teamA1),
    ).rejects.toThrow("TENANT_FORBIDDEN");
    // 旧 scope 的下一次推送：订阅者事实重验失败 → 停止推送并关闭。
    const pushed = await fixture.streams.pushEvent(staleScope, subscriptionId, {
      type: "message",
      status: "ok",
      message: "late",
    });
    expect(pushed).toEqual({ outcome: "closed" });
  });

  itDb(
    "撤权者的订阅经他人（同团队 active）推送：不 delivered（订阅是个人事实）",
    async () => {
      // a1-other 已被上一用例撤权（持久事实）：本用例改用 a1-owner
      // （此后无复用）驱动同一结论。
      const { subscriptionId } = await openOnOwnThread(
        "a1-owner",
        fixture.companyA,
        fixture.teamA1,
      );
      await fixture.suspendCompanyMembership(
        fixture.companyA,
        fixture.ids["principal-a1-owner"],
      );
      const admin = await fixture.streams.pushEvent(
        await scopeAs("company-admin", fixture.companyA, fixture.teamA1),
        subscriptionId,
        { type: "status", status: "ok", message: "sweep" },
      );
      expect(admin.outcome).not.toBe("delivered");
    },
  );

  itDb("受限角色全程在场（决策路径不经过超级用户）", async () => {
    const calls = fixture.restrictedCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.currentUser).toMatch(/^ob_ent_(data|operator|directory)$/);
    }
  });
});
