// server/tests/multitenancy/voice-mobile-bff.test.ts
// MT066（Issue #109）：语音、听写与移动聚合接口只返回当前范围。
//
// 验收事实源（Issue #109 四条，逐条对应 describe；真实 PostgreSQL，全程受
// 限 ob_ent_* 角色 + 真实 RLS + 真实用量冻结 + 真实判定门，绝不回退开发
// 库、缺 env 显式 skip）：
//   AC1 语音与听写会话只对本范围授权主体可见；用量记录归属（供 MT070
//      计费）——语音协会行冻结 usage_seconds；听写用量行钉 (用户, 三元
//     组)；一切不可见 = MT011 canonical RESOURCE_NOT_FOUND 逐字节同形。
//   AC2 移动聚合接口的每个子查询都受当前范围限制（逐子查询测试）——
//     readMobileAggregate 的语音/听写/设备三子查询各自跨范围反例钉死。
//   AC3 推送设备绑定到具体用户与范围；解绑或撤权后停止推送——绑定/
//     解绑/判定门；解绑后 authorize 拒绝且根行不动；撤权后同样拒绝。
//   AC4 切换范围后聚合结果立即变化，无跨范围缓存——同账号两三元组连读
//     互斥快照（每次调用新事务，结构性无缓存）。
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
  createVoiceMobileFixture,
  type VoiceMobileFixture,
  type VoiceMobileIdentity,
} from "./support/voice-mobile-bff";

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
      reason: `MT066 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

let fixture: VoiceMobileFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
/**
 * b1-member 的受信 Scope：在 beforeAll（撤权发生前）解析一次并缓存——
 * 撤权用例停用该成员后，AC3 复用同一 Scope 输入验证判定门的活查语义。
 */
let revokedB1Scope: PlatformScope;
const suiteGeneratedDirs: string[] = [];
const randomSuiteToken = () => Math.random().toString(36).slice(2, 10);

/** 共享对象图：每条 = {id, ownerIdentity}。 */
const sessions: Record<string, { id: string; ownerIdentity: string }> = {};
const devices: Record<string, { id: string; ownerIdentity: string }> = {};

const scopeAs = (
  identity: VoiceMobileIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

const seedAndPinSession = async (
  key: string,
  identity: VoiceMobileIdentity,
  tenantId: string,
  workspaceId: string,
  input?: { readonly durationSeconds?: number },
) => {
  const ownerUserId = fixture.ids[`user-${identity}`];
  const sessionId = await fixture.seedVoiceSession({
    ownerUserId,
    durationSeconds: input?.durationSeconds,
  });
  const scope = await scopeAs(identity, tenantId, workspaceId);
  const result = await fixture.service.pinVoiceSessionScope(scope, {
    sessionId,
  });
  if (!("status" in result) || result.status !== "pinned") {
    throw new Error(`pin failed: ${JSON.stringify(result)}`);
  }
  sessions[key] = { id: sessionId, ownerIdentity: identity };
  return sessionId;
};

const seedAndBindDevice = async (
  key: string,
  identity: VoiceMobileIdentity,
  tenantId: string,
  workspaceId: string,
) => {
  const ownerUserId = fixture.ids[`user-${identity}`];
  const deviceId = await fixture.seedPushDevice({ ownerUserId });
  const scope = await scopeAs(identity, tenantId, workspaceId);
  const result = await fixture.service.bindPushDevice(scope, { deviceId });
  if (!("status" in result) || result.status !== "bound") {
    throw new Error(`bind failed: ${JSON.stringify(result)}`);
  }
  devices[key] = { id: deviceId, ownerIdentity: identity };
  return deviceId;
};

beforeAll(async () => {
  if (!ENV.ok) return;

  // MT066 migration through the real MT003 tool: generate → apply → replay
  // is convergent (applied on a fresh database, up-to-date on replay).
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error(
      "MT066 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  const dir = join("/tmp", `mt066-migration-${randomSuiteToken()}`);
  suiteGeneratedDirs.push(dir);
  const generation = await runMigrateTest(["generate", "MT066", "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`MT066 generate failed: ${JSON.stringify(generation)}`);
  }
  const manifestPath = join(dir, "MT066", "manifest.json");
  const applied: RunOutcome = await runMigrateTest(
    ["migrate", "MT066", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT066 apply failed: ${JSON.stringify(applied)}`);
  }
  const replay = await runMigrateTest(
    ["migrate", "MT066", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (replay.kind !== "up-to-date") {
    throw new Error(`MT066 replay not convergent: ${JSON.stringify(replay)}`);
  }

  fixture = await createVoiceMobileFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];

  // Shared graph: sessions/devices per (identity × scope), one foreign
  // teammate session, one multi-company pair.
  await seedAndPinSession("a1", "a1-member", companyA, teamA1, {
    durationSeconds: 90,
  });
  await seedAndPinSession("other", "a1-other", companyA, teamA1);
  await seedAndPinSession("a2", "a1a2-member", companyA, teamA2);
  await seedAndPinSession("b1", "b1-member", companyB, teamB1);
  await seedAndPinSession("multiA", "multi-company", companyA, teamA1);
  await seedAndPinSession("multiB", "multi-company", companyB, teamB1);
  await seedAndBindDevice("devA1", "a1-member", companyA, teamA1);
  await seedAndBindDevice("devB1", "b1-member", companyB, teamB1);
  await seedAndBindDevice("devMultiA", "multi-company", companyA, teamA1);
  // 撤权用例的 Scope 输入：撤权前解析（之后 scopeAs 会活查拒绝）。
  revokedB1Scope = await scopeAs("b1-member", companyB, teamB1);
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
// AC1：语音与听写会话只对本范围授权主体可见；用量记录归属
// ---------------------------------------------------------------------------

describeDb("MT066 AC1：语音会话可见性与用量归属", () => {
  itDb("列表只返回本人、所选团队范围内的会话（同团队他人零泄漏）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const { sessions: listed } = await fixture.service.listVoiceSessions(
      scope,
      {
        limit: 100,
      },
    );
    const ids = listed.map((entry) => entry.ownership.sessionId).sort();
    expect(ids).toEqual([sessions.a1.id]);
    for (const entry of listed) {
      expect(entry.ownership.tenantId).toBe(companyA);
      expect(entry.ownership.workspaceId).toBe(teamA1);
      expect(entry.ownership.principalId).toBe(
        fixture.ids["principal-a1-member"],
      );
    }
    expect(ids).not.toContain(sessions.other.id);
  });

  itDb("读取返回归属与根行；不存在的 id 与跨范围 id 同形", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const read = await fixture.service.readVoiceSession(scope, sessions.a1.id);
    expect(read).toMatchObject({
      outcome: "allow",
      session: { id: sessions.a1.id, durationSeconds: 90 },
    });
    const missing = await fixture.service.readVoiceSession(
      scope,
      "no-such-session",
    );
    expect(isCanonicalNotFound(missing)).toBe(true);
    const foreign = await fixture.service.readVoiceSession(
      scope,
      sessions.b1.id,
    );
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
  });

  itDb(
    "同团队他人/跨团队/跨公司同账号对本人会话 canonical not-found",
    async () => {
      const mateScope = await scopeAs("a1-other", companyA, teamA1);
      expect(
        isCanonicalNotFound(
          await fixture.service.readVoiceSession(mateScope, sessions.a1.id),
        ),
      ).toBe(true);
      const teamScope = await scopeAs("a1a2-member", companyA, teamA2);
      expect(
        isCanonicalNotFound(
          await fixture.service.readVoiceSession(teamScope, sessions.a1.id),
        ),
      ).toBe(true);
      const foreignScope = await scopeAs("multi-company", companyB, teamB1);
      expect(
        isCanonicalNotFound(
          await fixture.service.readVoiceSession(
            foreignScope,
            sessions.multiA.id,
          ),
        ),
      ).toBe(true);
    },
  );

  itDb(
    "用量记录归属：pin 冻结根行 usage_seconds（MT070 计费的输入事实）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const read = await fixture.service.readVoiceSession(
        scope,
        sessions.a1.id,
      );
      if (read.outcome !== "allow") throw new Error("expected allow");
      expect(read.ownership.usageSeconds).toBe(90);
      expect(read.ownership.userId).toBe(fixture.ids["user-a1-member"]);
      expect(read.ownership.tenantId).toBe(companyA);
    },
  );

  itDb("听写用量行钉 (用户, 三元组)：recorded→existing 幂等收敛", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const usageKey = `mt065-dict-${Math.random().toString(36).slice(2, 10)}`;
    const first = await fixture.service.recordDictationUsage(scope, {
      usageKey,
      audioSeconds: 42,
      outputTokens: 120,
    });
    expect(first).toMatchObject({
      status: "recorded",
      usage: { audioSeconds: 42, outputTokens: 120, tenantId: companyA },
    });
    const replay = await fixture.service.recordDictationUsage(scope, {
      usageKey,
      audioSeconds: 42,
      outputTokens: 120,
    });
    expect(replay.status).toBe("existing");
    if (replay.status === "existing" && first.status === "recorded") {
      expect(replay.usage.id).toBe(first.usage.id);
    }
    // 异三元组重放同一 usage_key = MISMATCH 响亮（键被另一范围占用）。
    const otherScope = await scopeAs("multi-company", companyB, teamB1);
    const mismatch = await thrownMessage(() =>
      fixture.service.recordDictationUsage(otherScope, {
        usageKey,
        audioSeconds: 42,
        outputTokens: 120,
      }),
    );
    expect(mismatch).toContain("OPENMUSE_VOICE_MOBILE_SCOPE_MISMATCH");
  });

  itDb("听写用量只对本范围可见；同团队他人零泄漏", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const { usage } = await fixture.service.listDictationUsage(scope, {
      limit: 100,
    });
    expect(usage.length).toBeGreaterThan(0);
    for (const row of usage) {
      expect(row.tenantId).toBe(companyA);
      expect(row.workspaceId).toBe(teamA1);
      expect(row.principalId).toBe(fixture.ids["principal-a1-member"]);
    }
    const mateScope = await scopeAs("a1-other", companyA, teamA1);
    const mate = await fixture.service.listDictationUsage(mateScope, {
      limit: 100,
    });
    expect(mate.usage).toEqual([]);
  });

  itDb("公司级撤权后列表响亮拒绝，对象面折叠为不可见", async () => {
    // 本用例执行 b1-member 的撤权（一次性事实，AC3 复用 revokedB1Scope）。
    await fixture.suspendCompanyMembership(
      companyB,
      fixture.ids["principal-b1-member"],
    );
    const listed = await thrownMessage(() =>
      fixture.service.listVoiceSessions(revokedB1Scope, { limit: 10 }),
    );
    expect(listed).toBe("SCOPE_REVOKED");
    const read = await fixture.service.readVoiceSession(
      revokedB1Scope,
      sessions.b1.id,
    );
    expect(isCanonicalNotFound(read)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2：移动聚合接口的每个子查询都受当前范围限制（逐子查询测试）
// ---------------------------------------------------------------------------

describeDb("MT066 AC2：聚合子查询逐个受范围限制", () => {
  itDb("子查询·语音会话：A 范围只见 A 会话，B 会话结构性不在", async () => {
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    const aggregate = await fixture.service.readMobileAggregate(scopeA);
    expect(aggregate.voiceSessions.map((s) => s.ownership.sessionId)).toEqual([
      sessions.multiA.id,
    ]);
    expect(
      aggregate.voiceSessions.map((s) => s.ownership.sessionId),
    ).not.toContain(sessions.multiB.id);
  });

  itDb("子查询·听写用量：A 范围只含 A 用量行", async () => {
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    await fixture.service.recordDictationUsage(scopeA, {
      usageKey: `mt066-agg-a-${Math.random().toString(36).slice(2, 10)}`,
      audioSeconds: 10,
      outputTokens: 5,
    });
    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    await fixture.service.recordDictationUsage(scopeB, {
      usageKey: `mt066-agg-b-${Math.random().toString(36).slice(2, 10)}`,
      audioSeconds: 20,
      outputTokens: 8,
    });
    const inA = await fixture.service.readMobileAggregate(scopeA);
    for (const row of inA.dictationUsage) {
      expect(row.tenantId).toBe(companyA);
    }
    const inB = await fixture.service.readMobileAggregate(scopeB);
    for (const row of inB.dictationUsage) {
      expect(row.tenantId).toBe(companyB);
    }
    expect(inA.dictationUsage.map((row) => row.id)).not.toEqual(
      inB.dictationUsage.map((row) => row.id),
    );
  });

  itDb("子查询·推送设备：A 范围只见 A 绑定，B 绑定结构性不在", async () => {
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    const aggregate = await fixture.service.readMobileAggregate(scopeA);
    expect(aggregate.pushDevices.map((d) => d.ownership.deviceId)).toEqual([
      devices.devMultiA.id,
    ]);
    expect(
      aggregate.pushDevices.map((d) => d.ownership.deviceId),
    ).not.toContain(devices.devB1.id);
  });
});

// ---------------------------------------------------------------------------
// AC3：推送设备绑定到具体用户与范围；解绑或撤权后停止推送
// ---------------------------------------------------------------------------

describeDb("MT066 AC3：推送设备绑定/解绑/撤权", () => {
  itDb("绑定钉 (用户, 三元组)：重放幂等，异三元组响亮拒绝", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const again = await fixture.service.bindPushDevice(scope, {
      deviceId: devices.devA1.id,
    });
    expect(again).toMatchObject({ status: "existing" });

    // 同一账号另一公司上下文重绑自己的 A 设备 = MISMATCH（绑定不可改写）。
    const otherScope = await scopeAs("multi-company", companyB, teamB1);
    const mismatch = await thrownMessage(() =>
      fixture.service.bindPushDevice(otherScope, {
        deviceId: devices.devMultiA.id,
      }),
    );
    expect(mismatch).toContain("OPENMUSE_VOICE_MOBILE_SCOPE_MISMATCH");
  });

  itDb("解绑后判定门拒绝，根行不动（设备注册事实归既有 store）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const unbound = await fixture.service.unbindPushDevice(scope, {
      deviceId: devices.devA1.id,
    });
    expect(unbound).toMatchObject({ status: "unbound" });
    expect(await fixture.deviceLive(devices.devA1.id)).toBe(true);

    const denied = await fixture.service.authorizePushDevice(scope, {
      deviceId: devices.devA1.id,
    });
    expect(isCanonicalNotFound(denied)).toBe(true);
    // 重复解绑 = 防御性同形 not-found。
    const again = await fixture.service.unbindPushDevice(scope, {
      deviceId: devices.devA1.id,
    });
    expect(isCanonicalNotFound(again)).toBe(true);
  });

  itDb("撤权后判定门拒绝（停止推送）；他人设备不可见", async () => {
    // b1-member 已在 AC1 用例中被停用；复用撤权前解析的同一 Scope 输入
    // 验证判定门的活查语义。
    const denied = await fixture.service.authorizePushDevice(revokedB1Scope, {
      deviceId: devices.devB1.id,
    });
    expect(isCanonicalNotFound(denied)).toBe(true);

    // 无撤权他人：同团队他人对本人设备不可见。
    const mateScope = await scopeAs("a1-other", companyA, teamA1);
    const mate = await fixture.service.authorizePushDevice(mateScope, {
      deviceId: devices.devMultiA.id,
    });
    expect(isCanonicalNotFound(mate)).toBe(true);
  });

  itDb("有权范围 allow 携带设备事实（enabled/platform 投影）", async () => {
    const scope = await scopeAs("multi-company", companyA, teamA1);
    const allow = await fixture.service.authorizePushDevice(scope, {
      deviceId: devices.devMultiA.id,
    });
    expect(allow).toMatchObject({
      outcome: "allow",
      device: { id: devices.devMultiA.id, platform: "ios", enabled: true },
    });
  });
});

// ---------------------------------------------------------------------------
// AC4：切换范围后聚合结果立即变化，无跨范围缓存
// ---------------------------------------------------------------------------

describeDb("MT066 AC4：切换范围立即生效", () => {
  itDb(
    "同账号 A→B→A 连读互斥快照（每次调用新事务，结构性无缓存）",
    async () => {
      const scopeA = await scopeAs("multi-company", companyA, teamA1);
      const scopeB = await scopeAs("multi-company", companyB, teamB1);

      const inA1 = await fixture.service.readMobileAggregate(scopeA);
      expect(inA1.voiceSessions.map((s) => s.ownership.sessionId)).toEqual([
        sessions.multiA.id,
      ]);

      const inB = await fixture.service.readMobileAggregate(scopeB);
      expect(inB.voiceSessions.map((s) => s.ownership.sessionId)).toEqual([
        sessions.multiB.id,
      ]);
      expect(inB.voiceSessions.map((s) => s.ownership.sessionId)).not.toContain(
        sessions.multiA.id,
      );

      const inA2 = await fixture.service.readMobileAggregate(scopeA);
      expect(inA2.voiceSessions.map((s) => s.ownership.sessionId)).toEqual([
        sessions.multiA.id,
      ]);
      expect(
        inA2.voiceSessions.map((s) => s.ownership.sessionId),
      ).not.toContain(sessions.multiB.id);
    },
  );

  itDb(
    "切到 B 后立即在 B 记一笔听写用量，A 快照不含它（活查语义）",
    async () => {
      const scopeA = await scopeAs("multi-company", companyA, teamA1);
      const scopeB = await scopeAs("multi-company", companyB, teamB1);
      const before = await fixture.service.readMobileAggregate(scopeA);
      const freshKey = `mt066-switch-${Math.random().toString(36).slice(2, 10)}`;
      await fixture.service.recordDictationUsage(scopeB, {
        usageKey: freshKey,
        audioSeconds: 7,
        outputTokens: 3,
      });
      const after = await fixture.service.readMobileAggregate(scopeA);
      expect(after.dictationUsage.length).toBe(before.dictationUsage.length);
      expect(after.dictationUsage.map((row) => row.usageKey)).not.toContain(
        freshKey,
      );
      const inB = await fixture.service.readMobileAggregate(scopeB);
      expect(inB.dictationUsage.map((row) => row.usageKey)).toContain(freshKey);
    },
  );
});
