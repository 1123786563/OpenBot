// server/tests/multitenancy/workshop-scope.test.ts
// MT057（Issue #100）：Workshop 会话、执行、产物与沙箱实例关联的作用域。
//
// 验收事实源（Issue #100 四条，逐条对应 describe；真实 PostgreSQL，全程
// 受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：会话与执行记录固定归属；跨范围访问返回不可见语义。
//   验收 2：沙箱实例只与同范围会话关联；回收后不复用给其他范围而不清理。
//   验收 3：原匿名公开入口改为要求有效身份与受众（与 MT058 一致）。
//   验收 4：调度与实例关联的一致性有测试覆盖。
//
// 证据可复现（票面 AC）——本套件即复现命令：
//   set +x; source /tmp/mt28-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/workshop-scope.test.ts

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  createWorkshopTenancyFixture,
  type WorkshopTenancyFixture,
} from "./support/workshop-tenancy";

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
      reason: `MT057 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
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
  throw new Error("expected the call to throw");
};

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let fixture: WorkshopTenancyFixture;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createWorkshopTenancyFixture();
});

afterAll(async () => {
  if (fixture) await fixture.dispose();
});

// ---------------------------------------------------------------------------
// 验收 1：会话与执行记录固定归属；跨范围访问不可见
// ---------------------------------------------------------------------------

describeDb("MT057 AC1 sessions and executions stay inside the scope", () => {
  itDb("the owner reads their session, turns and single turns", async () => {
    const arrangement = await fixture.ensurePinnedSession({
      owner: "a1-member",
      team: "team-a1",
    });
    const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
    const turn = await fixture.workshop.enqueueTurn({
      sessionId: arrangement.sessionId,
      prompt: "mt057 turn",
    });
    await fixture.workshop.markRunning(turn.id);
    const session = await fixture.workshopScopes.readSession(ownerScope, {
      channelId: arrangement.channelId,
    });
    expect(session.outcome).toBe("allow");
    const turns = await fixture.workshopScopes.listTurns(ownerScope, {
      channelId: arrangement.channelId,
    });
    expect(turns.outcome).toBe("allow");
    if (turns.outcome !== "allow") return;
    expect(turns.turns.map((row) => row.id)).toContain(turn.id);
    const single = await fixture.workshopScopes.readTurn(ownerScope, {
      turnId: turn.id,
    });
    expect(single.outcome).toBe("allow");
    if (single.outcome === "allow") {
      expect(single.sessionScope.channelId).toBe(arrangement.channelId);
    }
  });

  itDb(
    "a cross-team caller (same company) gets the invisible semantics everywhere",
    async () => {
      const arrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      const turn = await fixture.workshop.enqueueTurn({
        sessionId: arrangement.sessionId,
        prompt: "mt057 secret turn",
      });
      const intruder = await fixture.scopeAs("a2-member", "team-a2");
      const session = await fixture.workshopScopes.readSession(intruder, {
        channelId: arrangement.channelId,
      });
      expect(isCanonicalNotFound(session)).toBe(true);
      const turns = await fixture.workshopScopes.listTurns(intruder, {
        channelId: arrangement.channelId,
      });
      expect(isCanonicalNotFound(turns)).toBe(true);
      const single = await fixture.workshopScopes.readTurn(intruder, {
        turnId: turn.id,
      });
      expect(isCanonicalNotFound(single)).toBe(true);
    },
  );

  itDb(
    "a cross-company caller is refused identically (existence hidden)",
    async () => {
      const arrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      const foreigner = await fixture.scopeAs("b1-member", "team-b1");
      const session = await fixture.workshopScopes.readSession(foreigner, {
        channelId: arrangement.channelId,
      });
      expect(isCanonicalNotFound(session)).toBe(true);
    },
  );

  itDb(
    "pinning another member's session is refused invisibly; replay is idempotent",
    async () => {
      const arrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      const intruder = await fixture.scopeAs("a1-other", "team-a1");
      // 同团队他人：会话行的属主守卫先行（他人会话 = canonical not-found，
      // 与不存在不可区分）。
      const pin = await fixture.workshopScopes.pinWorkshopSession(intruder, {
        channelId: arrangement.channelId,
      });
      expect(isCanonicalNotFound(pin)).toBe(true);
      // 本人重放：幂等 existing。
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const replay = await fixture.workshopScopes.pinWorkshopSession(
        ownerScope,
        { channelId: arrangement.channelId },
      );
      expect("status" in replay && replay.status).toBe("existing");
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 2：沙箱实例只与同范围会话关联；回收后不跨范围复用而不清理
// ---------------------------------------------------------------------------

describeDb("MT057 AC2 sandbox instances bind and recycle per scope", () => {
  itDb("the owner binds a same-scope instance to their session", async () => {
    const arrangement = await fixture.ensurePinnedSession({
      owner: "a1-member",
      team: "team-a1",
    });
    const instanceId = await fixture.ensureSandboxInstance({
      botId: arrangement.botId,
      owner: "a1-member",
    });
    const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
    const bound = await fixture.workshopScopes.bindSandboxInstance(ownerScope, {
      channelId: arrangement.channelId,
      instanceId,
    });
    expect("status" in bound && bound.status).toBe("bound");
  });

  itDb(
    "an instance of another bot never binds (execution faces must match)",
    async () => {
      const arrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      const otherArrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      const foreignBotInstance = await fixture.ensureSandboxInstance({
        botId: otherArrangement.botId,
        owner: "a1-member",
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const bound = await fixture.workshopScopes.bindSandboxInstance(
        ownerScope,
        {
          channelId: arrangement.channelId,
          instanceId: foreignBotInstance,
        },
      );
      expect(isCanonicalNotFound(bound)).toBe(true);
    },
  );

  itDb(
    "a recycled instance is NOT rebindable to another scope without cleanup",
    async () => {
      const ownerArrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      const instanceId = await fixture.ensureSandboxInstance({
        botId: ownerArrangement.botId,
        owner: "a1-member",
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const bound = await fixture.workshopScopes.bindSandboxInstance(
        ownerScope,
        {
          channelId: ownerArrangement.channelId,
          instanceId,
        },
      );
      expect("status" in bound && bound.status).toBe("bound");
      // 属主回收：物理端口恰好被调用一次，绑定行翻 recycled。
      const recycled = await fixture.workshopScopes.recycleSandboxInstance(
        ownerScope,
        { instanceId },
      );
      expect(recycled.outcome).toBe("allow");
      expect(fixture.recycleCalls.length).toBe(1);
      expect(fixture.recycleCalls[0]?.instanceId).toBe(instanceId);
      // 跨范围重绑：不清不换——响亮拒绝，且物理端口零新调用。入侵者的
      // 会话挂在同一 Bot 上（形状全对），拒绝发生在绑定行三元组处。
      const intruderArrangement = await fixture.ensurePinnedSession({
        owner: "a2-member",
        team: "team-a2",
        botId: ownerArrangement.botId,
      });
      const intruderScope = await fixture.scopeAs("a2-member", "team-a2");
      const rebind = await thrownMessage(() =>
        fixture.workshopScopes.bindSandboxInstance(intruderScope, {
          channelId: intruderArrangement.channelId,
          instanceId,
        }),
      );
      expect(rebind).toBe("WORKSHOP_SANDBOX_BINDING_MISMATCH");
      expect(fixture.recycleCalls.length).toBe(1);
    },
  );

  itDb(
    "a cross-scope recycle request is invisible and touches no port",
    async () => {
      const arrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      const instanceId = await fixture.ensureSandboxInstance({
        botId: arrangement.botId,
        owner: "a1-member",
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      await fixture.workshopScopes.bindSandboxInstance(ownerScope, {
        channelId: arrangement.channelId,
        instanceId,
      });
      const intruder = await fixture.scopeAs("a2-member", "team-a2");
      const portCallsBefore = fixture.recycleCalls.length;
      const recycled = await fixture.workshopScopes.recycleSandboxInstance(
        intruder,
        { instanceId },
      );
      expect(isCanonicalNotFound(recycled)).toBe(true);
      expect(fixture.recycleCalls.length).toBe(portCallsBefore);
      // 属主的绑定原样（status 仍 bound）。
      const view = await fixture.workshopScopes.readSandboxBinding(ownerScope, {
        instanceId,
      });
      expect(view.outcome).toBe("allow");
      if (view.outcome === "allow") expect(view.binding.status).toBe("bound");
    },
  );

  itDb(
    "the same scope may rebind after recycle (cleanup already happened)",
    async () => {
      const arrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      const instanceId = await fixture.ensureSandboxInstance({
        botId: arrangement.botId,
        owner: "a1-member",
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      await fixture.workshopScopes.bindSandboxInstance(ownerScope, {
        channelId: arrangement.channelId,
        instanceId,
      });
      await fixture.workshopScopes.recycleSandboxInstance(ownerScope, {
        instanceId,
      });
      const rebound = await fixture.workshopScopes.bindSandboxInstance(
        ownerScope,
        { channelId: arrangement.channelId, instanceId },
      );
      expect("status" in rebound && rebound.status).toBe("bound");
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 3：匿名公开入口要求有效身份与受众（与 MT058 一致）
// ---------------------------------------------------------------------------

describeDb("MT057 AC3 the anonymous public entry requires identity", () => {
  itDb(
    "share resolution has no bearer-only entrance: a forged scope dies on the trusted check",
    async () => {
      const arrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      // 结构面：resolveWorkshopShareAccess 的第一行是 assertTrustedScope——
      // 匿名调用（没有受信 Scope）在类型面没有入口；手造同形 scope 是
      // 最接近的攻击面，被 WeakSet 信任检查拒绝（MT005 纪律）。
      const forged = {
        tenantId: "forged",
        workspaceId: "forged",
        principalId: "forged",
        actorId: "forged",
        memberEpoch: 0,
        aclEpoch: 0,
        entrypoint: "web",
      } as never;
      await expect(
        thrownMessage(() =>
          fixture.workshopScopes.resolveWorkshopShareAccess(forged, {
            token: "anything",
            channelId: arrangement.channelId,
          }),
        ),
      ).resolves.toBe("UNVERIFIED_SCOPE");
    },
  );

  itDb(
    "a valid identity with an audience-bound grant resolves through the MT058 port",
    async () => {
      const arrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const issued = await fixture.shareTokens.issueWorkshopShare(ownerScope, {
        channelId: arrangement.channelId,
        audience: "same-team",
        shareAction: "preview",
        expiresInDays: 1,
      });
      expect(issued.outcome).toBe("allow");
      if (issued.outcome !== "allow") return;
      // 同团队成员（有效身份 + 受众命中）经企业面解析放行。
      const teammate = await fixture.scopeAs("a1-other", "team-a1");
      const resolved = await fixture.workshopScopes.resolveWorkshopShareAccess(
        teammate,
        {
          token: issued.token,
          channelId: arrangement.channelId,
        },
      );
      expect(resolved.outcome).toBe("allow");
      if (resolved.outcome === "allow") {
        expect(resolved.channelId).toBe(arrangement.channelId);
        expect(resolved.via).toBe("same-team");
      }
    },
  );

  itDb(
    "a legacy anonymous bearer token never resolves on the enterprise face",
    async () => {
      const arrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      const legacyToken = await fixture.seedLegacyAnonymousShare({
        channelId: arrangement.channelId,
        createdBy: "a1-member",
      });
      // 解析只读 MT058 授权表——旧承载段没有行，永远 deny（不泄露会话
      // 存在性；与 B14 的 uniform miss 同形）。
      const teammate = await fixture.scopeAs("a1-other", "team-a1");
      const resolved = await fixture.workshopScopes.resolveWorkshopShareAccess(
        teammate,
        {
          token: legacyToken,
          channelId: arrangement.channelId,
        },
      );
      expect(isCanonicalNotFound(resolved)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 4：调度与实例关联的一致性
// ---------------------------------------------------------------------------

describeDb("MT057 AC4 schedules and bindings stay consistent", () => {
  itDb(
    "schedules are reachable only through the owning session's scope",
    async () => {
      const arrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      await fixture.workshop.createSchedule({
        id: `mt28-sch-${arrangement.sessionId.slice(-8)}`,
        sessionId: arrangement.sessionId,
        createdBy: fixture.userIdOf("a1-member"),
        prompt: "mt057 scheduled ask",
        rrule: "FREQ=DAILY;BYHOUR=9",
        timezone: "UTC",
        preapproved: { paths: [], tools: [], maxTurnsPerRun: 1 },
        nextRunAt: new Date(Date.now() + 3_600_000),
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const listed = await fixture.workshopScopes.listSchedules(ownerScope, {
        channelId: arrangement.channelId,
      });
      expect(listed.outcome).toBe("allow");
      if (listed.outcome !== "allow") return;
      expect(listed.schedules.length).toBeGreaterThan(0);
      expect(listed.schedules[0]?.prompt).toBe("mt057 scheduled ask");
      // 跨范围：不可见。
      const intruder = await fixture.scopeAs("a2-member", "team-a2");
      const intrudedListed = await fixture.workshopScopes.listSchedules(
        intruder,
        { channelId: arrangement.channelId },
      );
      expect(isCanonicalNotFound(intrudedListed)).toBe(true);
    },
  );

  itDb(
    "the binding's triple equals the session association's triple (consistency)",
    async () => {
      const arrangement = await fixture.ensurePinnedSession({
        owner: "a1-member",
        team: "team-a1",
      });
      const instanceId = await fixture.ensureSandboxInstance({
        botId: arrangement.botId,
        owner: "a1-member",
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      await fixture.workshopScopes.bindSandboxInstance(ownerScope, {
        channelId: arrangement.channelId,
        instanceId,
      });
      const view = await fixture.workshopScopes.readSandboxBinding(ownerScope, {
        instanceId,
      });
      expect(view.outcome).toBe("allow");
      if (view.outcome !== "allow") return;
      // 一致性：绑定三元组 = 会话协会行三元组 = 请求 scope（AC4）。
      expect(view.binding.tenantId).toBe(ownerScope.tenantId);
      expect(view.binding.workspaceId).toBe(ownerScope.workspaceId);
      expect(view.binding.principalId).toBe(ownerScope.principalId);
      expect(view.binding.sessionId).toBe(arrangement.sessionId);
      // 跨范围读绑定：不可见（一致性的另一面——他人读不到绑定事实）。
      const intruder = await fixture.scopeAs("b1-member", "team-b1");
      const intruderView = await fixture.workshopScopes.readSandboxBinding(
        intruder,
        { instanceId },
      );
      expect(isCanonicalNotFound(intruderView)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 撤销：公司级停用（置尾避免污染后续场景的成员资格）
// ---------------------------------------------------------------------------

describeDb("MT057 revocation folds a suspended member's entrances", () => {
  itDb("suspension makes sessions invisible and lists loud", async () => {
    const arrangement = await fixture.ensurePinnedSession({
      owner: "a1-member",
      team: "team-a1",
    });
    const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
    await fixture.suspendCompany("a1-member", "company-a");
    const read = await fixture.workshopScopes.readSession(ownerScope, {
      channelId: arrangement.channelId,
    });
    expect(isCanonicalNotFound(read)).toBe(true);
    await expect(
      thrownMessage(() =>
        fixture.workshopScopes.listSessions(ownerScope, { limit: 10 }),
      ),
    ).resolves.toBe("SCOPE_REVOKED");
  });
});
