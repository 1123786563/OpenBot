// server/tests/multitenancy/craft-sandbox-public.test.ts
// MOD11（Issue #631，根 #620）：CRAFT 沙箱能力公开门面（src/craft/public.ts）的
// 委托等价、绑定合同（同一可信归属 / 范围+代次进缓存寻址键 / 缺范围零请求
// fail-closed / 复位与撤权拒绝）与负向源级钉。
//
// 事实源（Issue #631 验收 + MOD11 Brief §1.A/§1.C，逐条对应 describe）：
//   D1 委托等价：门面句柄 vs 直装配 gateway（#618 原装配形状 executionScopeFor
//      透传）——同一 config/connection/fetch 下四族能力逐字节同 wire（封装后
//      不回归的单元面，验收⑤）；同键两次取件同一实例（一个绑定一个 gateway）。
//   D2 验收①同一服务器可信归属：一个绑定的 file/serve/event/snapshot 四族出站
//      请求携带同一对归属头；句柄同源（同键同一实例）。
//   D3 验收②缓存/登录态隔离：同 Bot 同目录，不同 scope 或不同代次 → 不同的
//      opencode-serve client 与 event bus（缓存=登录态宿主，互不可见）；
//      同 scope 同代次 → 同实例（缓存命中）；缺省代次="1" 与显式 "1" 同键。
//   D4 验收③缺范围零请求+复位/撤权拒绝（现状机制钉）：null 绑定四族全部
//      显示性拒绝、零拨号；撤权后新取件拒绝；restore 的 409/400→false、
//      403→抛错（复位语义原样）；close() 后旧 bus 只回 POD_EVENT_BUS_CLOSED。
//   D5 验收④负向源级钉：门面零头组装面（零 token/归属头字面量）、零默认
//      公司/团队（scope 原样透传不落默认）、装配点（runtime.ts）零 token
//      拼装字面量。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生收集
// （native 桶），不依赖 Bun 运行时、不触真实数据库/沙箱：一切出站请求经注入
// 的 recording fetch 证明；#618 原票验收由原票测试保留（craft-sandbox-gateway-
// scope / craft-session-routes-scope），两侧对照见 reports/mod11-verification/。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import { loadCraftConfig } from "../../src/craft/config";
import { SandboxExecutionScopeUnavailableError } from "../../src/craft/errors";
import { POD_EVENT_BUS_CLOSED } from "../../src/craft/opencode/event-bus";
import { createCraftSandboxPublic } from "../../src/craft/public";
import {
  createSandboxGateway,
  type SandboxGateway,
} from "../../src/craft/sandbox-gateway";

const TENANT = "acme-co";
const WORKSPACE = "team-1";
const OTHER_WORKSPACE = "team-2";
const BOT = "craft";
const GW = "http://gw.test";
const TOKEN = "sandbox-secret";

const scopedConfig = loadCraftConfig({
  OPENBOT_CRAFT_SANDBOX_EXECUTION_TENANT_ID: TENANT,
  OPENBOT_CRAFT_SANDBOX_EXECUTION_WORKSPACE_ID: WORKSPACE,
});
type Recorded = {
  method: string;
  url: string;
  headers: Record<string, string>;
};

/**
 * Records every outbound call and answers the gateway's verbs with the shapes
 * the production callers parse (mirrors craft-sandbox-gateway-scope.test.ts —
 * the same double, so wire comparisons are byte-comparable). Tests never touch
 * a real sandbox.
 */
function recordingFetch() {
  const calls: Recorded[] = [];
  let sseEnd: (() => void) | null = null;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    if (
      method === "GET" &&
      (url.pathname === "/event" || url.pathname === "/events")
    ) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sseEnd = () => controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (method === "GET" && url.pathname === "/file") return Response.json([]);
    if (method === "POST" && url.pathname === "/session")
      return Response.json({ id: "ses_public" });
    if (method === "GET" && url.pathname === "/workspace/snapshot")
      return new Response(new Uint8Array([1, 2, 3]));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl, endSse: () => sseEnd?.() };
}

/** A fetch answering one status for every call (restore/snapshot refusal stubs). */
function statusFetch(status: number) {
  return (async () => new Response(null, { status })) as typeof fetch;
}

/** Resolves once the predicate holds; throws at the deadline so a hang fails loud. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The ownership headers for one stated pair, riding beside token and bot id. */
function expectScopeHeaders(
  headers: Record<string, string>,
  tenant: string,
  workspace: string,
): void {
  expect(headers["x-openbot-tenant-id"]).toBe(tenant);
  expect(headers["x-openbot-workspace-id"]).toBe(workspace);
  expect(headers["x-sandbox-token"]).toBe(TOKEN);
  expect(headers["x-openbot-bot-id"]).toBe(BOT);
}

const connectionFor = () => ({
  botId: BOT,
  baseUrl: GW,
  token: TOKEN,
});

const publicFacade = (fetchImpl?: typeof fetch) =>
  createCraftSandboxPublic({
    config: scopedConfig,
    connectionFor,
    fetchImpl,
  });

/** The pre-MOD11 assembly shape: the boot file's direct gateway construction. */
const controlGateway = (fetchImpl: typeof fetch): SandboxGateway =>
  createSandboxGateway({
    config: scopedConfig,
    connectionFor,
    executionScopeFor: () => ({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
    }),
    fetchImpl,
  });

/** Drives one verb of each capability family through a handle. */
async function driveFourFamilies(handle: SandboxGateway): Promise<void> {
  const files = handle.fileApiFor(BOT);
  expect(files).not.toBe(null);
  if (files) await files.listFiles("dir");
  const client = handle.serveClientFor({ botId: BOT, directory: "dir" });
  expect(client).not.toBe(null);
  if (client) await client.ensureSession(null, { directory: "dir" });
  expect(await handle.snapshotArchiveFor(BOT)).toEqual(
    new Uint8Array([1, 2, 3]),
  );
}

describe("MOD11 D1: the facade delegates — same wire as the pre-MOD11 assembly", () => {
  test("all four families produce byte-identical requests to the direct gateway", async () => {
    const facadeSide = recordingFetch();
    const controlSide = recordingFetch();

    await driveFourFamilies(
      publicFacade(facadeSide.fetchImpl).handlesFor({
        scope: { tenantId: TENANT, workspaceId: WORKSPACE },
      }),
    );
    await driveFourFamilies(controlGateway(controlSide.fetchImpl));

    expect(facadeSide.calls).toEqual(controlSide.calls);
    for (const call of facadeSide.calls)
      expectScopeHeaders(call.headers, TENANT, WORKSPACE);
  });

  test("the event bus rides the binding too — same SSE dial as the control", async () => {
    const facadeSide = recordingFetch();
    const controlSide = recordingFetch();

    const facadeBus = publicFacade(facadeSide.fetchImpl)
      .handlesFor({ scope: { tenantId: TENANT, workspaceId: WORKSPACE } })
      .eventBusFor({ botId: BOT, directory: "dir" });
    const controlBus = controlGateway(controlSide.fetchImpl).eventBusFor({
      botId: BOT,
      directory: "dir",
    });
    expect(facadeBus).not.toBe(null);
    expect(controlBus).not.toBe(null);

    facadeBus?.subscribe("ses_public");
    controlBus?.subscribe("ses_public");
    await waitFor(() => facadeSide.calls.some((call) => call.url === "/event"));
    await waitFor(() =>
      controlSide.calls.some((call) => call.url === "/event"),
    );

    expect(facadeSide.calls).toEqual(controlSide.calls);
    facadeSide.endSse();
    controlSide.endSse();
    facadeBus?.close();
    controlBus?.close();
    await facadeBus?.readerSettled();
    await controlBus?.readerSettled();
  });

  test("one binding, one gateway: re-acquiring the same key returns the same instance", () => {
    const facade = publicFacade();
    const first = facade.handlesFor({
      scope: { tenantId: TENANT, workspaceId: WORKSPACE },
    });
    const second = facade.handlesFor({
      scope: { tenantId: TENANT, workspaceId: WORKSPACE },
      environmentGeneration: "1",
    });
    expect(first).toBe(second);
  });
});

describe("MOD11 D2 (验收①): one binding, one trusted ownership for all four families", () => {
  test("file / serve / event / snapshot all state the same pair on the wire", async () => {
    const { calls, fetchImpl, endSse } = recordingFetch();
    const handle = publicFacade(fetchImpl).handlesFor({
      scope: { tenantId: TENANT, workspaceId: WORKSPACE },
    });

    const files = handle.fileApiFor(BOT);
    expect(files).not.toBe(null);
    if (files) await files.listFiles("dir");

    const client = handle.serveClientFor({ botId: BOT, directory: "dir" });
    expect(client).not.toBe(null);
    if (client) await client.ensureSession(null, { directory: "dir" });

    const bus = handle.eventBusFor({ botId: BOT, directory: "dir" });
    expect(bus).not.toBe(null);
    bus?.subscribe("ses_public");
    await waitFor(() => calls.some((call) => call.url === "/event"));

    expect(await handle.snapshotArchiveFor(BOT)).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    for (const call of calls)
      expectScopeHeaders(call.headers, TENANT, WORKSPACE);
    endSse();
    bus?.close();
    await bus?.readerSettled();
  });
});

describe("MOD11 D3 (验收②): scope and generation are the cache-addressing key", () => {
  test("same Bot and directory, different scope → separate clients and buses, each stating its own pair", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const facade = publicFacade(fetchImpl);

    const scopedHandle = facade.handlesFor({
      scope: { tenantId: TENANT, workspaceId: WORKSPACE },
    });
    const otherHandle = facade.handlesFor({
      scope: { tenantId: TENANT, workspaceId: OTHER_WORKSPACE },
    });
    expect(scopedHandle).not.toBe(otherHandle);

    const scopedClient = scopedHandle.serveClientFor({
      botId: BOT,
      directory: "dir",
    });
    const otherClient = otherHandle.serveClientFor({
      botId: BOT,
      directory: "dir",
    });
    expect(scopedClient).not.toBe(null);
    expect(otherClient).not.toBe(null);
    // The cache (login state's host) is per binding: never the same client.
    expect(scopedClient).not.toBe(otherClient);

    const scopedBus = scopedHandle.eventBusFor({
      botId: BOT,
      directory: "dir",
    });
    const otherBus = otherHandle.eventBusFor({ botId: BOT, directory: "dir" });
    expect(scopedBus).not.toBe(null);
    expect(otherBus).not.toBe(null);
    expect(scopedBus).not.toBe(otherBus);
    scopedBus?.close();
    otherBus?.close();

    // And each client's own dial states its own ownership — no cross-use.
    await scopedClient?.ensureSession(null, { directory: "dir" });
    await otherClient?.ensureSession(null, { directory: "dir" });
    expectScopeHeaders(calls[0]?.headers ?? {}, TENANT, WORKSPACE);
    expectScopeHeaders(calls[1]?.headers ?? {}, TENANT, OTHER_WORKSPACE);
  });

  test("same scope, different generation → separate handles, clients and buses", () => {
    const facade = publicFacade();
    const gen1 = facade.handlesFor({
      scope: { tenantId: TENANT, workspaceId: WORKSPACE },
      environmentGeneration: "1",
    });
    const gen2 = facade.handlesFor({
      scope: { tenantId: TENANT, workspaceId: WORKSPACE },
      environmentGeneration: "2",
    });
    expect(gen1).not.toBe(gen2);
    expect(gen1.serveClientFor({ botId: BOT, directory: "dir" })).not.toBe(
      gen2.serveClientFor({ botId: BOT, directory: "dir" }),
    );
    const bus1 = gen1.eventBusFor({ botId: BOT, directory: "dir" });
    const bus2 = gen2.eventBusFor({ botId: BOT, directory: "dir" });
    expect(bus1).not.toBe(bus2);
    bus1?.close();
    bus2?.close();
  });

  test('the default generation is "1": omitted and explicit "1" share one handle', () => {
    const facade = publicFacade();
    expect(
      facade.handlesFor({
        scope: { tenantId: TENANT, workspaceId: WORKSPACE },
      }),
    ).toBe(
      facade.handlesFor({
        scope: { tenantId: TENANT, workspaceId: WORKSPACE },
        environmentGeneration: "1",
      }),
    );
  });

  test("a null-scope binding is its own key, never a neighbor of a scoped one", () => {
    const facade = publicFacade();
    const scoped = facade.handlesFor({
      scope: { tenantId: TENANT, workspaceId: WORKSPACE },
    });
    const unscoped = facade.handlesFor({ scope: null });
    expect(unscoped).not.toBe(scoped);
    // Same pair re-acquired still dedupes beside the scoped one.
    expect(facade.handlesFor({ scope: null })).toBe(unscoped);
  });
});

describe("MOD11 D4 (验收③): missing scope sends nothing; reset and withdrawal refuse", () => {
  test("a null binding: every family refuses with the displayable error, zero dials", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = publicFacade(fetchImpl).handlesFor({ scope: null });

    const files = handle.fileApiFor(BOT);
    expect(files).not.toBe(null);
    if (files)
      await expect(files.listFiles("dir")).rejects.toThrow(
        SandboxExecutionScopeUnavailableError,
      );

    const client = handle.serveClientFor({ botId: BOT, directory: "dir" });
    expect(client).not.toBe(null);
    if (client)
      await expect(
        client.ensureSession(null, { directory: "dir" }),
      ).rejects.toThrow(SandboxExecutionScopeUnavailableError);

    const bus = handle.eventBusFor({ botId: BOT, directory: "dir" });
    expect(bus).not.toBe(null);
    expect(() => bus?.subscribe("ses_public")).toThrow(
      SandboxExecutionScopeUnavailableError,
    );

    await expect(handle.snapshotArchiveFor(BOT)).rejects.toThrow(
      SandboxExecutionScopeUnavailableError,
    );
    await expect(
      handle.restoreWorkspace(BOT, new Uint8Array([1])),
    ).rejects.toThrow(SandboxExecutionScopeUnavailableError);
    await expect(handle.healthCheck(BOT)).rejects.toThrow(
      SandboxExecutionScopeUnavailableError,
    );
    expect(() => handle.assertExecutionScope()).toThrow(
      SandboxExecutionScopeUnavailableError,
    );

    expect(calls).toHaveLength(0);
  });

  test("withdrawal: once the trusted wiring resolves null, newly acquired handles refuse", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const facade = publicFacade(fetchImpl);

    // Before: the scoped binding dials attributed.
    const files = facade
      .handlesFor({ scope: { tenantId: TENANT, workspaceId: WORKSPACE } })
      .fileApiFor(BOT);
    expect(files).not.toBe(null);
    if (files) await files.listFiles("dir");
    expect(calls).toHaveLength(1);
    expectScopeHeaders(calls[0]?.headers ?? {}, TENANT, WORKSPACE);

    // The wiring's answer flips to null (the deployment lost its pair) — the
    // next acquisition refuses before any dial.
    const withdrawn = facade.handlesFor({ scope: null }).fileApiFor(BOT);
    expect(withdrawn).not.toBe(null);
    if (withdrawn)
      await expect(withdrawn.listFiles("dir")).rejects.toThrow(
        SandboxExecutionScopeUnavailableError,
      );
    expect(calls).toHaveLength(1);
  });

  test("reset refusals ride through the binding unchanged: 409/400 answer false, 403 throws", async () => {
    const facade409 = publicFacade(statusFetch(409));
    expect(
      await facade409
        .handlesFor({ scope: { tenantId: TENANT, workspaceId: WORKSPACE } })
        .restoreWorkspace(BOT, new Uint8Array([1])),
    ).toBe(false);

    const facade400 = publicFacade(statusFetch(400));
    expect(
      await facade400
        .handlesFor({ scope: { tenantId: TENANT, workspaceId: WORKSPACE } })
        .restoreWorkspace(BOT, new Uint8Array([1])),
    ).toBe(false);

    const facade403 = publicFacade(statusFetch(403));
    await expect(
      facade403
        .handlesFor({ scope: { tenantId: TENANT, workspaceId: WORKSPACE } })
        .restoreWorkspace(BOT, new Uint8Array([1])),
    ).rejects.toThrow(/answered 403/);
    await expect(
      facade403
        .handlesFor({ scope: { tenantId: TENANT, workspaceId: WORKSPACE } })
        .snapshotArchiveFor(BOT),
    ).rejects.toThrow(/answered 403/);
  });

  test("close(): every bound gateway's buses close; a held old bus only ever answers closed", async () => {
    const { calls, fetchImpl, endSse } = recordingFetch();
    const facade = publicFacade(fetchImpl);
    const handle = facade.handlesFor({
      scope: { tenantId: TENANT, workspaceId: WORKSPACE },
    });
    const bus = handle.eventBusFor({ botId: BOT, directory: "dir" });
    expect(bus).not.toBe(null);
    bus?.subscribe("ses_public");
    await waitFor(() => calls.some((call) => call.url === "/event"));
    endSse();

    facade.close();
    expect(bus?.isClosed()).toBe(true);
    // The old handle's bus refuses further work the only way a closed bus can.
    const sub = bus?.subscribe("ses_public");
    expect(sub).not.toBe(null);
    if (sub) expect(await sub.queue.shift()).toBe(POD_EVENT_BUS_CLOSED);
    await bus?.readerSettled();
  });
});

describe("MOD11 D5 (验收④): the export adds no header face and no default ownership", () => {
  /** Strips // line comments and block comments so pins read code, not prose. */
  function codeOf(relative: string): string {
    const raw = readFileSync(
      fileURLToPath(new URL(relative, import.meta.url)),
      "utf8",
    );
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  test("public.ts assembles no headers and names no token", () => {
    const source = codeOf("../../src/craft/public.ts");
    for (const banned of [
      "x-sandbox-token",
      "x-openbot-bot-id",
      "x-openbot-tenant-id",
      "x-openbot-workspace-id",
      "EXECUTION_TENANT_HEADER",
      "EXECUTION_WORKSPACE_HEADER",
      "new Headers",
    ]) {
      expect(
        source.includes(banned),
        `public.ts must not contain ${banned}`,
      ).toBe(false);
    }
  });

  test("public.ts defaults no company or team: the binding's scope passes through verbatim", () => {
    const source = codeOf("../../src/craft/public.ts");
    expect(source.includes("executionScopeFor: () => binding.scope")).toBe(
      true,
    );
    // No fallback chain: the binding pair is the one source, null stays null.
    expect(source.includes("config.sandboxExecutionScope")).toBe(false);
    expect(source.includes("?? {")).toBe(false);
  });

  test("the assembly never assembled trust headers — and still does not", () => {
    const runtime = codeOf("../../src/assembly/runtime.ts");
    for (const banned of [
      "x-sandbox-token",
      "x-openbot-bot-id",
      "x-openbot-tenant-id",
      "x-openbot-workspace-id",
      "EXECUTION_TENANT_HEADER",
      "EXECUTION_WORKSPACE_HEADER",
    ]) {
      expect(
        runtime.includes(banned),
        `runtime.ts must not contain ${banned}`,
      ).toBe(false);
    }
    // The one craft-family gateway assembly acquires through the public binding.
    expect(runtime.includes("craftSandboxPublic.handlesFor({")).toBe(true);
  });
});
