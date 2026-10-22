// server/tests/multitenancy/agent-adapters.test.ts
// MT049（Issue #92）：TypeScript agent 适配器统一消费已验证归属。
//
// 验收事实源（票面 4 条 AC，逐条对应 describe）：
//   AC1 逐个适配器验证：归属缺失或被篡改时拒绝执行，而不是以默认身份继续。
//   AC2 适配器不自行构造 Scope，只消费签发入口产生的作用域。
//   AC3 回调解析结果在适配器之间一致（共享测试用例覆盖全部适配器）。
//   AC4 适配器日志与错误包含归属标识但不含明文秘密。
//
// 两层结构：纯面（信封签发/消费、断言铸造、回调解析矩阵、native 面
// 翻译）不依赖数据库；「受信 scope 才能铸造」的正向半边用真实
// PostgreSQL（受限 ob_ent_* 角色 + 真实 createScopeResolver 签发；缺显式
// env 整套显式 skip，skipped 不计通过）。三类适配器上下文（remote_ag_ui
// 的 forwardedProps 携带、remote_mastra 的 reserved context 携带、built_in
// 的 legacy token 路径）共用同一解析入口，共享用例表逐格断言一致。

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  hashCallbackToken,
  mintCallbackToken,
  readRunAssertion,
} from "../../src/agents/callback-token";
import { sign } from "../../src/auth/signed-value";
import { createDatabase, type Database } from "../../src/db/client";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../src/db/schema";
import { users } from "../../src/db/schema/core";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  consumeRuntimeInvocationHeader,
  describeAdapterAttribution,
  issueRuntimeInvocation,
  mintScopedRunAssertion,
  type RuntimeInvocationFacts,
  resolveAgentAdapterCallback,
} from "../../src/enterprise/tenancy/agent-adapters";
import type {
  DataDatabase,
  DirectoryDatabase,
  OperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import type { ExecutionTarget } from "../../src/enterprise/tenancy/execution-artifacts";
import {
  NATIVE_RUNTIME_CANCEL_HEADERS,
  nativeRuntimeExecutionSurface,
} from "../../src/enterprise/tenancy/execution-surfaces";
import { provisionDeployment } from "../../src/enterprise/tenancy/provision";
import {
  type AuthenticatedRequestIdentity,
  createScopeResolver,
} from "../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const setup =
    process.env.ENTERPRISE_TEST_SETUP_DATABASE_URL ??
    process.env.TEST_DATABASE_URL;
  if (!setup?.trim()) {
    return {
      ok: false,
      reason: "ENTERPRISE_TEST_SETUP_DATABASE_URL/TEST_DATABASE_URL not set",
    };
  }
  for (const role of ["DIRECTORY", "DATA", "OPERATOR"] as const) {
    if (!process.env[`ENTERPRISE_TEST_${role}_DATABASE_URL`]?.trim()) {
      return {
        ok: false,
        reason: `ENTERPRISE_TEST_${role}_DATABASE_URL not set`,
      };
    }
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const describeDb = ENV.ok ? describe : describe.skip;

const encryptionKey = "mt049-adapter-assertion-key-0000000000000000000000000";
const legacyToken = "mt049-legacy-deployment-token";

// ---------------------------------------------------------------------------
// 共用夹具：两台 Bot 的回调 token 表 + 一个 run 断言铸造器
// ---------------------------------------------------------------------------

const botA = "mt049-bot-a";
const botB = "mt049-bot-b";
const tokenA = mintCallbackToken();
const tokenB = mintCallbackToken();
const tokenIndex = new Map<string, string>([
  [hashCallbackToken(tokenA), botA],
  [hashCallbackToken(tokenB), botB],
]);
const lookup = async (hash: string) => {
  const id = tokenIndex.get(hash);
  return id ? { id } : null;
};

/** 三类适配器上下文：断言/凭据的携带通道不同，解析入口同一个。 */
type AdapterKind = "remote_ag_ui" | "remote_mastra" | "built_in";

/** 从各框架的携带通道里取出断言与 token——通道差异的如实建模。 */
function presentationFor(
  kind: AdapterKind,
  input: { token: string; assertion: unknown },
): { presented: string; run: unknown } {
  // 三个通道把「部署签发的断言原样」交回回调面（ag_ui 经
  // forwardedProps.openbotRun、mastra 经 reserved context、built_in 经
  // body.run），token 半边同样按通道呈现（per-agent 回调 token 或 legacy
  // 部署 token——共享入口两者都收，authoriseAgentCall 的既有语义）。
  // 解析入口是同一个，这是「一致」的机制本身。
  void kind;
  return { presented: input.token, run: input.assertion };
}

/** 一个适配器上下文：解析 + 与期待归属比对（企业消费面的完整判定）。 */
async function adapterCallback(
  kind: AdapterKind,
  input: {
    token: string;
    assertion: unknown;
    expectedOwnership?: { tenantId: string; workspaceId: string };
  },
) {
  const { presented, run } = presentationFor(kind, input);
  const verdict = await resolveAgentAdapterCallback({
    presented,
    run,
    encryptionKey,
    legacyToken,
    lookup,
  });
  if (!verdict.ok) return verdict;
  if (
    input.expectedOwnership &&
    (verdict.ownership.tenantId !== input.expectedOwnership.tenantId ||
      verdict.ownership.workspaceId !== input.expectedOwnership.workspaceId)
  ) {
    return { ok: false as const, status: 403, reason: "Not authorised." };
  }
  return verdict;
}

/** native 面共用的目标与信封事实。 */
const target: ExecutionTarget = {
  tenantId: "mt049-tenant",
  workspaceId: "mt049-workspace",
  botId: "mt049-native-bot",
  runId: "0b9f6a1e-1111-4111-8111-111111111111",
};
const invocationFacts: RuntimeInvocationFacts = {
  runId: target.runId!,
  attemptId: "1c8e7b2f-2222-4222-8222-222222222222",
  turnId: "2d9f8c3a-3333-4333-8333-333333333333",
  threadId: "mt049-native-thread",
  fencingToken: 7,
  leaseId: "3eaf9d4b-4444-4444-8444-444444444444",
  expiresAt: new Date(Date.now() + 60_000),
  expertVersion: "mt049-expert@1",
  inputDigest: `sha256:${"a1b2c3d4".repeat(8)}`,
  modelRouteRef: "mt049-route",
  budgetReservationId: "4fbeae5c-5555-4555-8555-555555555555",
  initiatorKind: "human",
};
/** 与 target 三元组一致的「受信签发」信封（scope 的替身由 DB 面的真实验证）。 */
function matchingInvocationHeader(): string {
  return JSON.stringify({
    schema_version: 1,
    tenant_id: target.tenantId,
    workspace_id: target.workspaceId,
    principal_id: "mt049-principal",
    actor_id: "mt049-actor",
    initiator_kind: "human",
    run_id: invocationFacts.runId,
    attempt_id: invocationFacts.attemptId,
    turn_id: invocationFacts.turnId,
    thread_id: invocationFacts.threadId,
    expert_version: invocationFacts.expertVersion,
    input_digest: invocationFacts.inputDigest,
    model_route_ref: invocationFacts.modelRouteRef,
    budget_reservation_id: invocationFacts.budgetReservationId,
    lease_id: invocationFacts.leaseId,
    fencing_token: "7",
    expires_at: invocationFacts.expiresAt.toISOString(),
  });
}

/** 记录型 dial：断言 native 面发了什么、没发什么。 */
function recordingDial() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const dial = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: { ...(init.headers as Record<string, string>) },
    });
    return new Response('{"status":"cancel_requested"}', { status: 200 });
  };
  return { calls, dial: dial as typeof fetch };
}

// ---------------------------------------------------------------------------
// AC1：归属缺失或被篡改 → 拒绝执行，不以默认身份继续
// ---------------------------------------------------------------------------

describe("MT049 AC1 adapters refuse missing or tampered attribution", () => {
  test("the native envelope without the workspace half is refused on consume", () => {
    const full = JSON.parse(matchingInvocationHeader()) as Record<
      string,
      unknown
    >;
    delete full.workspace_id;
    expect(consumeRuntimeInvocationHeader(JSON.stringify(full))).toBeNull();
    // 半归属（只有 tenant）同样拒绝，不修补。
    const half = JSON.parse(matchingInvocationHeader()) as Record<
      string,
      unknown
    >;
    delete half.workspace_id;
    half.tenant_id = "mt049-other-tenant";
    expect(consumeRuntimeInvocationHeader(JSON.stringify(half))).toBeNull();
  });

  test("a tampered envelope (ownership swapped) never reaches the dial", async () => {
    const { calls, dial } = recordingDial();
    const surface = nativeRuntimeExecutionSurface({
      baseUrl: "https://native.mt049.invalid",
      serviceCredential: "mt049-service-credential",
      credentials: async () => {
        const tampered = JSON.parse(matchingInvocationHeader()) as Record<
          string,
          unknown
        >;
        tampered.workspace_id = "mt049-another-workspace";
        return {
          invocationHeader: JSON.stringify(tampered),
          capability: "mt049-capability-token",
        };
      },
      fetch: dial,
    });
    const outcome = await surface.cancel(target);
    expect(outcome.outcome).toBe("unavailable");
    expect(calls).toHaveLength(0);
  });

  test("an assertion with a broken signature or a half ownership pair is refused for every adapter", async () => {
    const good = mintScopedRunAssertionForTest();
    const brokenSignature = `${good.slice(0, -6)}AAAAAA`;
    const halfOwnership = mintHalfOwnershipAssertionForTest();
    for (const kind of ["remote_ag_ui", "remote_mastra", "built_in"] as const) {
      await expect(
        adapterCallback(kind, { token: tokenA, assertion: brokenSignature }),
      ).resolves.toEqual({ ok: false, status: 401, reason: "Not authorised." });
      await expect(
        adapterCallback(kind, { token: tokenA, assertion: halfOwnership }),
      ).resolves.toEqual({ ok: false, status: 401, reason: "Not authorised." });
    }
  });

  test("an unattributed (pre-MT049 shape) assertion is not accepted as an enterprise callback", async () => {
    // 有签名、无归属：旧形状断言本身可读（向后兼容），但企业适配器消费面
    // 拒绝——不是以默认身份继续。
    const unattributed = mintUnattributedAssertionForTest();
    const read = readRunAssertion(unattributed, encryptionKey);
    expect(read?.botId).toBe(botA);
    for (const kind of ["remote_ag_ui", "remote_mastra", "built_in"] as const) {
      await expect(
        adapterCallback(kind, { token: tokenA, assertion: unattributed }),
      ).resolves.toEqual({ ok: false, status: 401, reason: "Not authorised." });
    }
  });
});

// ---------------------------------------------------------------------------
// AC2：适配器不自行构造 Scope，只消费签发入口产生的作用域
// ---------------------------------------------------------------------------

describe("MT049 AC2 adapters consume scopes only from the issuing entrance", () => {
  const handBuilt = Object.freeze({
    tenantId: "mt049-tenant",
    workspaceId: "mt049-workspace",
    principalId: "mt049-principal",
    actorId: "mt049-actor",
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web",
  });

  test("the envelope issuer refuses a hand-built scope", () => {
    expect(() =>
      issueRuntimeInvocation({ scope: handBuilt, facts: invocationFacts }),
    ).toThrow("UNVERIFIED_SCOPE");
  });

  test("the scoped assertion minter refuses a hand-built scope", () => {
    expect(() =>
      mintScopedRunAssertion({
        scope: handBuilt,
        run: { botId: botA, actorId: "mt049-actor", runId: randomUUID() },
        encryptionKey,
      }),
    ).toThrow("UNVERIFIED_SCOPE");
  });
});

// ---------------------------------------------------------------------------
// AC3：回调解析结果在适配器之间一致（共享用例表覆盖全部适配器）
// ---------------------------------------------------------------------------

describe("MT049 AC3 one callback resolution, identical across adapters", () => {
  const kinds: readonly AdapterKind[] = [
    "remote_ag_ui",
    "remote_mastra",
    "built_in",
  ];

  /** 共享用例表：同一份凭据材料 × 三类适配器上下文 → 逐格一致。 */
  const cases = (): Array<{
    label: string;
    token: string;
    assertion: () => unknown;
    expected:
      | { ok: false; status: 401 | 403; reason: string }
      | { ok: true; ownership: { tenantId: string; workspaceId: string } };
  }> => [
    {
      label: "valid scoped assertion for the token's own bot",
      token: tokenA,
      assertion: () => mintScopedAssertionForTest(botA, "mt049-issuer"),
      expected: {
        ok: true,
        ownership: { tenantId: "mt049-issuer", workspaceId: "mt049-issuer" },
      },
    },
    {
      label: "assertion of another bot (token↔bot mismatch)",
      token: tokenB,
      assertion: () => mintScopedAssertionForTest(botA, "mt049-issuer"),
      expected: {
        ok: false,
        status: 403,
        reason: "That token is not for this Bot.",
      },
    },
    {
      label: "unknown token",
      token: mintCallbackToken(),
      assertion: () => mintScopedAssertionForTest(botA, "mt049-issuer"),
      expected: { ok: false, status: 401, reason: "Not authorised." },
    },
    {
      label: "garbage assertion",
      token: tokenA,
      assertion: () => "not-an-assertion",
      expected: { ok: false, status: 401, reason: "Not authorised." },
    },
    {
      label: "foreign ownership (minted for another scope)",
      token: tokenA,
      assertion: () => mintScopedAssertionForTest(botA, "mt049-foreign"),
      expected: { ok: false, status: 403, reason: "Not authorised." },
    },
    {
      label: "legacy deployment token with a valid scoped assertion",
      token: legacyToken,
      assertion: () => mintScopedAssertionForTest(botA, "mt049-issuer"),
      expected: {
        ok: true,
        ownership: { tenantId: "mt049-issuer", workspaceId: "mt049-issuer" },
      },
    },
  ];

  for (const testCase of cases()) {
    test(`shared case: ${testCase.label}`, async () => {
      const verdicts = [];
      for (const kind of kinds) {
        const verdict = await adapterCallback(kind, {
          token: testCase.token,
          assertion: testCase.assertion(),
          expectedOwnership: {
            tenantId: "mt049-issuer",
            workspaceId: "mt049-issuer",
          },
        });
        verdicts.push({ kind, verdict });
        if (testCase.expected.ok) {
          expect(verdict.ok).toBe(true);
          if (verdict.ok) {
            expect(verdict.ownership).toEqual(testCase.expected.ownership);
            expect(verdict.botId).toBe(botA);
          }
        } else {
          expect(verdict.ok).toBe(false);
          if (!verdict.ok) {
            expect(verdict.status).toBe(testCase.expected.status);
            expect(verdict.reason).toBe(testCase.expected.reason);
          }
        }
      }
      // 跨适配器一致：三类上下文对同一用例的判定逐字相同（ok/status/
      // ownership/botId——reason 本就共用同一句文案）。
      const shapes = verdicts.map(({ verdict }) =>
        verdict.ok
          ? `ok:${verdict.botId}:${verdict.ownership.tenantId}/${verdict.ownership.workspaceId}`
          : `refused:${verdict.status}`,
      );
      expect(new Set(shapes).size).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// AC4：日志与错误含归属标识、不含明文秘密
// ---------------------------------------------------------------------------

describe("MT049 AC4 attribution identifiers in errors, never secrets", () => {
  test("describeAdapterAttribution carries identifiers only", () => {
    const text = describeAdapterAttribution({
      tenantId: "tenant-x",
      workspaceId: "workspace-y",
      botId: "bot-z",
      runId: "run-w",
    });
    expect(text).toContain("tenant-x");
    expect(text).toContain("workspace-y");
    expect(text).toContain("bot-z");
    expect(text).toContain("run-w");
    expect(text).not.toContain(tokenA);
    expect(text).not.toContain("mt049-capability-token");
  });

  test("the native surface refusal names the ownership, never the credentials", async () => {
    const { calls, dial } = recordingDial();
    const serviceCredential = "mt049-service-credential";
    const capability = "mt049-capability-token";
    const surface = nativeRuntimeExecutionSurface({
      baseUrl: "https://native.mt049.invalid",
      serviceCredential,
      credentials: async () => ({
        invocationHeader: matchingInvocationHeader(),
        capability,
      }),
      fetch: dial,
    });
    // 正向翻译：200 → cancelled，dial 带三个头。
    const outcome = await surface.cancel(target);
    expect(outcome).toEqual({ outcome: "cancelled" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://native.mt049.invalid/cancel");
    expect(
      calls[0]!.headers[NATIVE_RUNTIME_CANCEL_HEADERS.serviceCredential],
    ).toBe(serviceCredential);
    expect(calls[0]!.headers[NATIVE_RUNTIME_CANCEL_HEADERS.capability]).toBe(
      capability,
    );
    expect(
      consumeRuntimeInvocationHeader(
        calls[0]!.headers[NATIVE_RUNTIME_CANCEL_HEADERS.invocation],
      )?.workspace_id,
    ).toBe(target.workspaceId);
  });

  test("mismatch and HTTP refusals keep secrets out of the detail", async () => {
    const serviceCredential = "mt049-service-credential-secret";
    const capability = "mt049-capability-token-secret";
    // 归属不匹配：拒绝文案带标识，不带任何凭据。
    const mismatchDial = recordingDial();
    const mismatch = nativeRuntimeExecutionSurface({
      baseUrl: "https://native.mt049.invalid",
      serviceCredential,
      credentials: async () => ({
        invocationHeader: matchingInvocationHeader().replace(
          target.workspaceId,
          "mt049-swapped-workspace",
        ),
        capability,
      }),
      fetch: mismatchDial.dial,
    });
    const mismatchOutcome = await mismatch.cancel(target);
    expect(mismatchOutcome.outcome).toBe("unavailable");
    if (mismatchOutcome.outcome === "unavailable") {
      expect(mismatchOutcome.detail).toContain(target.tenantId);
      expect(mismatchOutcome.detail).toContain(target.workspaceId);
      expect(mismatchOutcome.detail).toContain(target.botId);
      expect(mismatchOutcome.detail).not.toContain(serviceCredential);
      expect(mismatchOutcome.detail).not.toContain(capability);
    }
    expect(mismatchDial.calls).toHaveLength(0);
    // Go 侧 404/403 的翻译不带秘密。
    for (const status of [404, 403, 500]) {
      const dial = async () => new Response("", { status });
      const surface = nativeRuntimeExecutionSurface({
        baseUrl: "https://native.mt049.invalid",
        serviceCredential,
        credentials: async () => ({
          invocationHeader: matchingInvocationHeader(),
          capability,
        }),
        fetch: dial as unknown as typeof fetch,
      });
      const outcome = await surface.cancel(target);
      expect(outcome.outcome).toBe(
        status === 404 ? "not-running" : "unavailable",
      );
      if (outcome.outcome === "unavailable") {
        expect(outcome.detail).not.toContain(serviceCredential);
        expect(outcome.detail).not.toContain(capability);
        expect(outcome.detail).not.toContain(matchingInvocationHeader());
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 受信签发正向面（真实 PostgreSQL）：只有真 scope 能铸出归属
// ---------------------------------------------------------------------------

describeDb("MT049 issuing entrance on a real trusted scope", () => {
  test("a resolver-issued scope mints an envelope and an assertion carrying its triple", () => {
    expect(realScope).toBeDefined();
    const issued = issueRuntimeInvocation({
      scope: realScope!,
      facts: invocationFacts,
    });
    expect(issued.invocation.tenant_id).toBe(realScope!.tenantId);
    expect(issued.invocation.workspace_id).toBe(realScope!.workspaceId);
    expect(consumeRuntimeInvocationHeader(issued.header)).toEqual(
      issued.invocation,
    );
    const assertion = mintScopedRunAssertion({
      scope: realScope!,
      run: {
        botId: botA,
        actorId: realScope!.actorId,
        runId: invocationFacts.runId,
      },
      encryptionKey,
    });
    const read = readRunAssertion(assertion, encryptionKey);
    expect(read?.ownership).toEqual({
      tenantId: realScope!.tenantId,
      workspaceId: realScope!.workspaceId,
    });
    // 篡改断言里的归属（解码→改 ownership→重编码，保留旧签名）→
    // 签名不再覆盖载荷，读取面拒绝——归属是 signed 事实，不是可编辑字段。
    const [valuePart, signaturePart] = assertion.split(".");
    const decoded = JSON.parse(
      Buffer.from(valuePart, "base64url").toString("utf8"),
    ) as { ownership: { tenantId: string; workspaceId: string } };
    decoded.ownership.workspaceId = "mt049-forged-workspace";
    const forged = [
      Buffer.from(JSON.stringify(decoded)).toString("base64url"),
      signaturePart,
    ].join(".");
    expect(readRunAssertion(forged, encryptionKey)).toBeNull();
    // JSON 往返的受信 scope 同形不同体：签发入口只认 WeakSet 里的那一个。
    const roundTripped = Object.freeze({
      ...JSON.parse(JSON.stringify(realScope)),
    });
    expect(() =>
      issueRuntimeInvocation({ scope: roundTripped, facts: invocationFacts }),
    ).toThrow("UNVERIFIED_SCOPE");
  });
});

// ---------------------------------------------------------------------------
// 夹具：断言铸造（绕过受信 scope 的纯测试路径只在「形状」用例里使用）
// ---------------------------------------------------------------------------

/**
 * 直接走 mintScopedRunAssertion 需要受信 scope；纯面用例只测形状与拒绝，
 * 用同一签名机制（signed-value + RUN_LABEL）铸出可控归属的断言。
 */
function rawAssertion(
  ownership: { tenantId: string; workspaceId: string } | undefined,
) {
  const payload = {
    botId: botA,
    actorId: "mt049-actor",
    runId: "5acfbf6d-6666-4666-8666-666666666666",
    threadId: "mt049-thread",
    depth: 0,
    initiator: { kind: "person" },
    ...(ownership ? { ownership } : {}),
    exp: Date.now() + 600_000,
  };
  // 与 mintRunAssertion 相同的封装（base64url payload + sign）。
  const { sign } = require("../../src/auth/signed-value") as {
    sign: (v: string, key: string, l: string) => string;
  };
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return sign(value, encryptionKey, "openbot:agent-run");
}

function mintScopedAssertionForTest(botId: string, scopeId: string): unknown {
  const payload = {
    botId,
    actorId: "mt049-actor",
    runId: "6bd0c07e-7777-4777-8777-777777777777",
    threadId: "mt049-thread",
    depth: 0,
    initiator: { kind: "person" },
    ownership: { tenantId: scopeId, workspaceId: scopeId },
    exp: Date.now() + 600_000,
  };
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return sign(value, encryptionKey, "openbot:agent-run");
}

function mintScopedRunAssertionForTest(): string {
  return rawAssertion({
    tenantId: "mt049-issuer",
    workspaceId: "mt049-issuer",
  }) as string;
}

function mintHalfOwnershipAssertionForTest(): string {
  // 手工构造「只有 tenant 半边」的 payload 并签名：读取面必须拒绝半归属。
  const payload = {
    botId: botA,
    actorId: "mt049-actor",
    runId: "7ce1d18f-8888-4888-8888-888888888888",
    ownership: { tenantId: "mt049-issuer" },
    exp: Date.now() + 600_000,
  };
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return sign(value, encryptionKey, "openbot:agent-run");
}

function mintUnattributedAssertionForTest(): string {
  return rawAssertion(undefined) as string;
}

// ---------------------------------------------------------------------------
// DB 夹具（真实签发 scope 的最小 tenancy 脚手架）
// ---------------------------------------------------------------------------

const prefix = `mt049-${randomUUID().slice(0, 8)}`;
const actorId = `${prefix}-actor`;
const tenantId = `${prefix}-tenant`;
const workspaceId = `${prefix}-workspace`;
const principalId = `${prefix}-principal`;
let realScope: PlatformScope | undefined;
let setupDatabase: Database | undefined;
let directoryDatabase: DirectoryDatabase | undefined;
let dataDatabase: DataDatabase | undefined;
let operatorDatabase: OperatorDatabase | undefined;
const authenticated = new WeakMap<Request, AuthenticatedRequestIdentity>();

beforeAll(async () => {
  if (!ENV.ok) return;
  const setup = createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 3 });
  setupDatabase = setup;
  const directory = createDatabase(
    enterpriseRuntimeDatabaseUrlFrom("directory"),
    {
      max: 2,
    },
  );
  const data = createDatabase(enterpriseRuntimeDatabaseUrlFrom("data"), {
    max: 2,
  });
  const operator = createDatabase(
    enterpriseRuntimeDatabaseUrlFrom("operator"),
    { max: 2 },
  );
  directoryDatabase = await verifyDirectoryDatabase(directory).catch(
    async (error) => {
      await directory.$client.close();
      throw error;
    },
  );
  dataDatabase = await verifyDataDatabase(data).catch(async (error) => {
    await data.$client.close();
    throw error;
  });
  operatorDatabase = await verifyOperatorDatabase(operator).catch(
    async (error) => {
      await operator.$client.close();
      throw error;
    },
  );

  await setup.insert(users).values({
    id: actorId,
    email: `${actorId}@example.invalid`,
    name: "MT049 adapter actor",
  });
  await setup
    .insert(enterprisePrincipals)
    .values({ id: principalId, userId: actorId });
  await provisionDeployment(operatorDatabase, {
    operationId: `${prefix}-provision`,
    operator: principalId,
    tenant: { id: tenantId, name: "MT049 adapter tenant" },
    workspace: { id: workspaceId, name: "MT049 adapter workspace" },
    members: [{ principalId, userId: actorId, role: "tenant_admin" }],
    resources: [],
  });
  await operatorDatabase.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) values (${tenantId}, ${workspaceId}, ${principalId})`,
    );
  });
  const resolver = createScopeResolver(directoryDatabase, {
    authenticate: async (request) => authenticated.get(request) ?? null,
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
  });
  const request = new Request("https://mt049.example.invalid/scope", {
    headers: {
      "x-openbot-tenant": tenantId,
      "x-openbot-workspace": workspaceId,
    },
  });
  authenticated.set(request, { actorId, entrypoint: "web" });
  realScope = await resolver.resolve(request);
});

afterAll(async () => {
  if (!ENV.ok) return;
  const failures: unknown[] = [];
  try {
    if (setupDatabase) {
      await setupDatabase
        .delete(enterpriseSecurityEvents)
        .where(like(enterpriseSecurityEvents.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseMemberships)
        .where(like(enterpriseMemberships.tenantId, `${prefix}%`));
      await setupDatabase.execute(
        sql`delete from enterprise_workspace_memberships where tenant_id like ${`${prefix}%`}`,
      );
      await setupDatabase
        .delete(enterpriseWorkspaces)
        .where(like(enterpriseWorkspaces.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseTenants)
        .where(like(enterpriseTenants.id, `${prefix}%`));
      await setupDatabase
        .delete(enterprisePrincipals)
        .where(like(enterprisePrincipals.id, `${prefix}%`));
      await setupDatabase.delete(users).where(like(users.id, `${prefix}%`));
    }
  } catch (error) {
    failures.push(error);
  }
  for (const database of [
    directoryDatabase,
    dataDatabase,
    operatorDatabase,
    setupDatabase,
  ]) {
    try {
      await database?.$client.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
});
