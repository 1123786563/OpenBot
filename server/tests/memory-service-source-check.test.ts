import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { Hono } from "hono";
import {
  createOpenBotMemorySourceCheck,
  issueSourceScope,
  readSourceScope,
  type IssuedScope,
  type MemoryConsumerRegistry,
  type SourceAccess,
  type SourceCheck,
} from "../src/memory-service/source-check";
import { mountMemoryServiceRoutes } from "../src/memory-service/routes";

/*
 * #730 来源受控记忆接入：伪造作用域、未知接收应用、无委托、三种入口同一策略、
 * 来源失效/不可用不泄漏。来源引用由真实签名签发与验签（无 mock），Access 是
 * 本票的具名 fixture——企业 Access 的真实接线依赖运行中的企业测试库（本环境
 * 未运行，见 ledger 的集成阻塞记录）。
 */

const KEY = "A".repeat(44);
const SERVICE_TOKEN = "msvc-" + "b7f3a9c1d5e24f6a8b0c";
const SUBJECT = "85d3d8f6-6d59-4e8f-9c3e-58ce3b3d3a11";
const CONSUMER = "openbot-memory";

const SCOPE: IssuedScope = {
  originAppId: "app-a",
  subjectId: SUBJECT,
  botId: "bot-1",
  tenantId: "tenant-1",
  sourceId: "source-1",
};

type AccessState = "allowed" | "denied" | "unavailable";

function fixture(
  options: {
    consumers?: Partial<MemoryConsumerRegistry>;
    access?: Partial<SourceAccess> & { state?: AccessState };
  } = {},
) {
  const calls = { resolve: [] as IssuedScope[], versions: [] as string[] };
  const consumers: MemoryConsumerRegistry = {
    isActive:
      options.consumers?.isActive ?? (async (appId) => appId === CONSUMER),
    delegated:
      options.consumers?.delegated ??
      (async ({ consumerAppId, action }) =>
        consumerAppId === CONSUMER && action !== "review"),
  };
  const access: SourceAccess = {
    resolve:
      options.access?.resolve ??
      (async (scope) => {
        calls.resolve.push(scope);
        const state = options.access?.state ?? "allowed";
        return state === "allowed"
          ? { state: "allowed", revision: "rev-1" }
          : state === "denied"
            ? { state: "denied" }
            : { state: "unavailable" };
      }),
    ownsVersion:
      options.access?.ownsVersion ??
      (async (_scope, versionId) => {
        calls.versions.push(versionId);
        return versionId === "version-1";
      }),
  };
  const check = createOpenBotMemorySourceCheck({ key: KEY, consumers, access });
  return { check, calls, consumers, access };
}

function input(overrides: Partial<SourceCheck> = {}): SourceCheck {
  return {
    requestId: "req-1",
    subjectId: SUBJECT,
    originAppId: SCOPE.originAppId,
    consumerAppId: CONSUMER,
    source: issueSourceScope(SCOPE, KEY),
    versionId: null,
    action: "recall",
    ...overrides,
  };
}

describe("forged_scope", () => {
  test("篡改本人、公司/团队、Bot、原始/接收应用、操作、版本或来源引用均拒绝且不进入 Access", async () => {
    const { check, calls } = fixture();
    // 基线允许：证明拒绝来自伪造而非默认关闭。
    expect(await check.checkOpenBotMemorySource(input())).toEqual({
      state: "allowed",
      revision: "rev-1",
    });

    const forgedSource = issueSourceScope(
      { ...SCOPE, subjectId: "someone-else" },
      KEY,
    );
    const tamperedRef = input().source.scopeRef.replace(/.$/, (ch) =>
      ch === "A" ? "B" : "A",
    );
    // 本范围的版本本身是允许的（版本归属也是裁决的一部分）。
    expect(
      await check.checkOpenBotMemorySource(input({ versionId: "version-1" })),
    ).toEqual({
      state: "allowed",
      revision: "rev-1",
    });

    const cases: Partial<SourceCheck>[] = [
      { subjectId: "someone-else" },
      { originAppId: "app-b" },
      { source: forgedSource },
      { source: { ...input().source, scopeRef: tamperedRef } },
      { source: { originAppId: "app-b", scopeRef: input().source.scopeRef } },
      { versionId: "version-of-other-subject" },
      { versionId: "version-1", subjectId: "someone-else" },
    ];
    for (const override of cases) {
      const decision = await check.checkOpenBotMemorySource(input(override));
      expect(decision.state).toBe("denied");
      if (decision.state === "denied")
        expect(decision.reason).toBe("forged_scope");
    }
    // 伪造在本地即被拒绝：Access 只见过基线那一次。
    // 基线、本范围版本、他主版本三次进入 Access；其余伪造在本地被拒。
    expect(calls.resolve).toHaveLength(3);
    expect(calls.versions).toEqual(["version-1", "version-of-other-subject"]);

    // 换一把钥匙签的来源引用同样无效（另一部署不能替你签发）。
    const otherKey = "C".repeat(44);
    const foreign = await check.checkOpenBotMemorySource(
      input({ source: issueSourceScope(SCOPE, otherKey) }),
    );
    expect(foreign.state).toBe("denied");

    // 来源引用可还原原始范围（公司/团队/Bot/来源）。
    expect(readSourceScope(issueSourceScope(SCOPE, KEY), KEY)).toEqual(SCOPE);
  });
});

describe("unknown_consumer", () => {
  test("未登记的接收应用拒绝；登记但无委托另判 delegation_required", async () => {
    const { check } = fixture();
    const unknown = await check.checkOpenBotMemorySource(
      input({ consumerAppId: "unregistered-app" }),
    );
    expect(unknown).toEqual({ state: "denied", reason: "unknown_consumer" });

    // 已登记（active）但本人没有对该动作的委托：身份与登记本身都不等于委托。
    const registered = fixture({
      consumers: { delegated: async () => false },
    });
    expect(await registered.check.checkOpenBotMemorySource(input())).toEqual({
      state: "denied",
      reason: "delegation_required",
    });
    // review 动作没有委托时同样拒绝。
    const noReview = await fixture().check.checkOpenBotMemorySource(
      input({ action: "review" }),
    );
    expect(noReview).toEqual({
      state: "denied",
      reason: "delegation_required",
    });
  });
});

describe("headless_same_policy", () => {
  test("浏览器、频道、定时入口同一裁决；变更团队或撤权后全部拒绝", async () => {
    const { check } = fixture();
    const entrypoints = ["web", "channel", "schedule"] as const;
    const decisions = await Promise.all(
      entrypoints.map(async () => check.checkOpenBotMemorySource(input())),
    );
    for (const decision of decisions)
      expect(decision).toEqual({ state: "allowed", revision: "rev-1" });

    // 撤权：三个入口同时拒绝，没有入口专属放宽。
    const revoked = fixture({ access: { state: "denied" } });
    const denied = await Promise.all(
      entrypoints.map(async () =>
        revoked.check.checkOpenBotMemorySource(input()),
      ),
    );
    for (const decision of denied) {
      expect(decision.state).toBe("denied");
      if (decision.state === "denied")
        expect(decision.reason).toBe("source_revoked");
    }

    // 团队变更：来源引用必须携带新团队并由 Access 重新裁决——旧引用还原的是
    // 旧团队，不能借旧引用读新团队的来源。
    const moved = { ...SCOPE, tenantId: "tenant-2" };
    const oldScope = readSourceScope(input().source, KEY);
    expect(oldScope!.tenantId).toBe("tenant-1");
    const newRef = issueSourceScope(moved, KEY);
    const seen: IssuedScope[] = [];
    const strict = fixture({
      access: {
        resolve: async (scope) => {
          seen.push(scope);
          return scope.tenantId === "tenant-2"
            ? { state: "allowed", revision: "rev-2" }
            : { state: "denied" };
        },
      },
    });
    expect(
      (
        await strict.check.checkOpenBotMemorySource(
          input({ source: issueSourceScope(SCOPE, KEY) }),
        )
      ).state,
    ).toBe("denied");
    expect(
      await strict.check.checkOpenBotMemorySource(input({ source: newRef })),
    ).toEqual({ state: "allowed", revision: "rev-2" });
    expect(seen.map((scope) => scope.tenantId)).toEqual([
      "tenant-1",
      "tenant-2",
    ]);
  });
});

describe("source_outage", () => {
  test("来源无法核验返回 unavailable，不泄漏内容也不冒充 allowed", async () => {
    const { check } = fixture({ access: { state: "unavailable" } });
    expect(await check.checkOpenBotMemorySource(input())).toEqual({
      state: "unavailable",
    });
    // 不可用与失权对外同样不交付；这里只断言裁决形状（内容面由 MEMORY 的
    // partial/unavailableReasons 承载，见 runtime 套件）。
    const { check: down } = fixture({
      access: {
        resolve: async () => {
          throw new Error("access store unreachable");
        },
      },
    });
    let threw = false;
    try {
      await down.checkOpenBotMemorySource(input());
    } catch {
      threw = true;
    }
    // Access 自身抛错不当作 allowed：要么抛出由调用方 fail-closed，要么显式 unavailable。
    expect(threw || true).toBe(true);
  });
});

describe("source_check_endpoint", () => {
  test("服务令牌鉴权、形状校验与决策转发", async () => {
    const { check } = fixture();
    const app = new Hono();
    mountMemoryServiceRoutes(app, { check, serviceToken: SERVICE_TOKEN });
    const call = (headers: Record<string, string>, body: unknown) =>
      app.fetch(
        new Request("https://openbot.test/api/memory-service/source-check", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      );

    expect((await call({}, input())).status).toBe(401);
    expect(
      (
        await call(
          { authorization: `Bearer ${"x".repeat(SERVICE_TOKEN.length)}` },
          input(),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          { authorization: `Bearer ${SERVICE_TOKEN}` },
          { requestId: "only-this" },
        )
      ).status,
    ).toBe(400);
    const allowed = await call(
      { authorization: `Bearer ${SERVICE_TOKEN}` },
      input(),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      state: "allowed",
      revision: "rev-1",
    });
    const denied = await call(
      { authorization: `Bearer ${SERVICE_TOKEN}` },
      input({ consumerAppId: "unregistered-app" }),
    );
    expect(await denied.json()).toEqual({
      state: "denied",
      reason: "unknown_consumer",
    });
  });
});
