// server/tests/multitenancy/craft-preview-boundary.test.ts
// MOD22（Issue #642，根 #620）：CRAFT 组内 Preview 单一内部边界（src/craft/preview.ts）
// 的委托等价、验收负向钉与源级钉。
//
// 事实源（Issue #642 验收 + MOD22 冻结计划 §1.D，逐条对应 describe）：
//   D1 Preview seam 委托等价：搬迁前后判定行为钉——preview 主机分派 / CSWSH
//      Origin 门 / 票据单次 / 兑换只在入口根 / HMR basePath verbatim，经 seam
//      抽样既有族断言形状同（判定体=http-server.ts 原行迁入，本组直接驱动 seam）。
//   D2 验收②负向：Preview 不借主站 cookie 写平台（真实 origin 的真实 verifyPass
//      经 seam 拒绝只持平台 cookie 的请求，HTTP 与 HMR 两腿）；TLS 不可用=原关闭
//      合同（host 形态无健康 TLS 记录 → admission 关闭 → 认领主机 503 可读原因）。
//   D3 验收③：fetch/HMR/basePath 合同不变——ok 臂 upstream URL 的 verbatim path
//      与 id-only query 钉 + 解析器物理原位钉（seam 零重实现，webapp-proxy.ts 持件）。
//   D4 验收④：端口单一来源源级钉——craft/ 全树仅 preview-ticket.ts 消费
//      portFromEnvironment（#619 事实源），零 process.env.PORT/SERVER_PORT 直读。
//   D5 B 收口钉：craft 路由树零第二网关事实例——routes.ts 无 createSandboxGateway
//      直接构造；runtime.ts 路由装配经 MOD11 handlesFor 取件。
//   D6 C 负向：craft/workshop 无第二运行终态写面——终态写文件集恰=既有清单，
//      且两组零引用 enterprise/runs / runs/public（自有引擎零替换裁决固化）。
//   D7 存量族登记钉：直关族 17 件存在且分层归属不变（native 12 件不入 bun
//      manifest、manifest 5 件在内）——两侧对照运行证据见 reports/mod22-verification/。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生收集
// （native 桶）；seam 只 import 已被 native 族证明可收集的组内件，不触 DB/网络：
// 一切判定经 stub 事实源驱动，真实 origin/resolver 仅走内存路径。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import { loadCraftConfig } from "../../src/craft/config";
import {
  createCraftPreviewFrontDoor,
  type PreviewUpgradeCommit,
} from "../../src/craft/preview";
import {
  createPreviewOrigin,
  PREVIEW_PASS_REFUSAL,
  type PreviewOrigin,
} from "../../src/craft/preview-origin";
import { createPreviewTickets } from "../../src/craft/preview-ticket";
import type {
  PreviewWebappHmrDeps,
  WebappHmrDeps,
  WebappHmrSocketData,
} from "../../src/craft/webapp-proxy";

const hereDir = dirname(fileURLToPath(import.meta.url));
const SESSION_ID = "sess-mod22-boundary";
const USER_ID = "user-mod22-boundary";
/** The dev form's pinned server port (preview-ticket's PORT/SERVER_PORT judgment). */
const DEV_ENV = { PORT: "3221" };

/** A commit probe: records the socket payloads the seam hands to Bun's upgrade. */
function commitProbe(result: boolean) {
  const calls: WebappHmrSocketData[] = [];
  const commit: PreviewUpgradeCommit = (data) => {
    calls.push(data);
    return result;
  };
  return { calls, commit };
}

type StubResolution =
  | { sessionId: string }
  | { refuse: { reason: string; status: 401 | 403 | 404 | 503 } };

/** The origin half of the seam's dispatch, stubbed to one claim/verdict pair. */
function stubOrigin(input: {
  claimed?: boolean;
  resolution?: StubResolution;
  appPath?: string;
  address?: string;
}) {
  const served = { response: new Response("served-by-stub"), calls: 0 };
  const origin = {
    handlesRequest: () => input.claimed ?? true,
    resolvePreviewRequest: () => input.resolution ?? { sessionId: SESSION_ID },
    appPathFor: () => input.appPath ?? "/",
    originFor: () => input.address ?? "http://127.0.0.1:3221/lb",
    handlePreviewRequest: async () => {
      served.calls += 1;
      return served.response;
    },
  } as unknown as PreviewOrigin;
  return { origin, served };
}

/**
 * The preview leg's deps for the REAL resolver (webapp-proxy's
 * resolvePreviewWebappHmrUpgrade): memory-only facts, no DB, no dial.
 */
function previewHmrDeps(over?: {
  verified?: { userId: string } | null;
  session?: { nextjsPort: number | null } | undefined;
  botId?: string | null;
}): PreviewWebappHmrDeps {
  const verified =
    over && "verified" in over ? over.verified! : { userId: USER_ID };
  const session =
    over && "session" in over ? over.session : { nextjsPort: 4100 };
  return {
    config: loadCraftConfig({}),
    store: {
      findSession: async (id: string, owner: string) =>
        id === SESSION_ID && owner === USER_ID ? session : undefined,
    } as never,
    verifyPass: () => verified,
    botIdFor: async () =>
      over?.botId === undefined ? "craft-bot" : over.botId,
    sandboxConnectionFor: () => ({
      baseUrl: "http://10.0.0.8:8080",
      token: "tok",
    }),
  };
}

/** The main-site leg's deps for the REAL resolveWebappHmrUpgrade. */
function webappHmrDeps(over?: {
  session?: { nextjsPort: number | null } | undefined;
}): WebappHmrDeps {
  const session =
    over && "session" in over ? over.session : { nextjsPort: 4100 };
  return {
    config: { ...loadCraftConfig({}), legacyPreviewEnabled: true },
    store: {
      getSession: async (id: string, owner: string) =>
        id === SESSION_ID && owner === USER_ID ? session : undefined,
    } as never,
    botIdFor: async () => "craft-bot",
    sandboxConnectionFor: () => ({
      baseUrl: "http://10.0.0.8:8080",
      token: "tok",
    }),
    // legacyPreviewEnabled: true above short-circuits the generation read, so
    // the gateway is never reached in this suite.
    gateway: {} as never,
  };
}

const upgradeRequest = (url: string, headers?: Record<string, string>) =>
  new Request(url, {
    headers: { upgrade: "websocket", ...headers },
  });

describe("D1 — the seam dispatches the moved judgment, verdict-for-response", () => {
  test("origin absent (craft off) claims nothing", async () => {
    const { calls, commit } = commitProbe(true);
    const frontDoor = createCraftPreviewFrontDoor({
      origin: undefined,
      previewHmr: undefined,
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      new Request("http://127.0.0.1:3221/lb/"),
      new URL("http://127.0.0.1:3221/lb/"),
      commit,
    );
    expect(verdict).toEqual({ claimed: false });
    expect(calls).toHaveLength(0);
  });

  test("a host the origin does not claim falls through", async () => {
    const { origin } = stubOrigin({ claimed: false });
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps(),
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      new Request("https://app.example.com/"),
      new URL("https://app.example.com/"),
      commitProbe(true).commit,
    );
    expect(verdict).toEqual({ claimed: false });
  });

  test("a refused resolution answers the JSON refusal verbatim (status + reason)", async () => {
    const { origin } = stubOrigin({
      resolution: { refuse: { reason: "Unknown preview host.", status: 404 } },
    });
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps(),
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      new Request("https://nope.preview.example.com/"),
      new URL("https://nope.preview.example.com/"),
      commitProbe(true).commit,
    );
    if (!verdict.claimed || !verdict.response) throw new Error("not answered");
    expect(verdict.response.status).toBe(404);
    expect(await verdict.response.json()).toEqual({
      error: "Unknown preview host.",
    });
  });

  test("a resolved session's plain request lands on the preview entry — same Response instance", async () => {
    const { origin, served } = stubOrigin({});
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps(),
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      new Request("http://127.0.0.1:3221/lb/"),
      new URL("http://127.0.0.1:3221/lb/"),
      commitProbe(true).commit,
    );
    if (!verdict.claimed) throw new Error("not claimed");
    expect(verdict.response).toBe(served.response);
    expect(served.calls).toBe(1);
  });

  test("an upgrade on a NON-HMR app path still lands on the HTTP entry (no resolver, no commit)", async () => {
    const { origin, served } = stubOrigin({ appPath: "/" });
    const { calls, commit } = commitProbe(true);
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps(),
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      upgradeRequest("http://127.0.0.1:3221/lb/"),
      new URL("http://127.0.0.1:3221/lb/"),
      commit,
    );
    if (!verdict.claimed) throw new Error("not claimed");
    expect(verdict.response).toBe(served.response);
    expect(calls).toHaveLength(0);
  });

  test("fix-ocr18 #3's defensive half: HMR-path upgrade with preview deps absent falls to the HTTP entry", async () => {
    const { origin, served } = stubOrigin({
      appPath: "/lb/_next/webpack-hmr",
    });
    const { calls, commit } = commitProbe(true);
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: undefined,
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      upgradeRequest("http://127.0.0.1:3221/lb/_next/webpack-hmr"),
      new URL("http://127.0.0.1:3221/lb/_next/webpack-hmr"),
      commit,
    );
    if (!verdict.claimed) throw new Error("not claimed");
    expect(verdict.response).toBe(served.response);
    expect(calls).toHaveLength(0);
  });

  test("CSWSH: a foreign Origin is 403'd BEFORE the resolver runs (fix-ocr28 #1)", async () => {
    const { origin } = stubOrigin({ appPath: "/lb/_next/webpack-hmr" });
    const { calls, commit } = commitProbe(true);
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      // verifyPass throwing proves the gate precedes the resolver entirely.
      previewHmr: {
        ...previewHmrDeps(),
        verifyPass: () => {
          throw new Error("resolver reached before the Origin gate");
        },
      },
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      upgradeRequest("http://127.0.0.1:3221/lb/_next/webpack-hmr", {
        origin: "https://evil.example",
      }),
      new URL("http://127.0.0.1:3221/lb/_next/webpack-hmr"),
      commit,
    );
    if (!verdict.claimed || !verdict.response) throw new Error("not answered");
    expect(verdict.response.status).toBe(403);
    expect(await verdict.response.text()).toBe(
      "Cross-origin WebSocket upgrades are refused.",
    );
    expect(calls).toHaveLength(0);
  });

  test("CSWSH: no Origin header (a non-browser client) keeps the pre-existing behavior", async () => {
    const { origin } = stubOrigin({ appPath: "/lb/_next/webpack-hmr" });
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps({ verified: null }),
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      upgradeRequest("http://127.0.0.1:3221/lb/_next/webpack-hmr"),
      new URL("http://127.0.0.1:3221/lb/_next/webpack-hmr"),
      commitProbe(true).commit,
    );
    // Past the Origin gate, into the resolver: its own 401 shape answers.
    if (!verdict.claimed || !verdict.response) throw new Error("not answered");
    expect(verdict.response.status).toBe(401);
    expect(await verdict.response.text()).toBe(PREVIEW_PASS_REFUSAL);
  });

  test("the session's own Origin passes the gate (normalized both sides)", async () => {
    const { origin } = stubOrigin({ appPath: "/lb/_next/webpack-hmr" });
    const { calls, commit } = commitProbe(true);
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps(),
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      upgradeRequest("http://127.0.0.1:3221/lb/_next/webpack-hmr", {
        origin: "http://127.0.0.1:3221",
      }),
      new URL("http://127.0.0.1:3221/lb/_next/webpack-hmr"),
      commit,
    );
    expect(verdict).toEqual({ claimed: true, response: undefined });
    expect(calls).toHaveLength(1);
  });

  test("a resolver refusal answers its own status/error and never commits", async () => {
    const { origin } = stubOrigin({ appPath: "/lb/_next/webpack-hmr" });
    const { calls, commit } = commitProbe(true);
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      // Verified pass, but the row is gone → the resolver's own 404.
      previewHmr: previewHmrDeps({ session: undefined }),
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      upgradeRequest("http://127.0.0.1:3221/lb/_next/webpack-hmr"),
      new URL("http://127.0.0.1:3221/lb/_next/webpack-hmr"),
      commit,
    );
    if (!verdict.claimed || !verdict.response) throw new Error("not answered");
    expect(verdict.response.status).toBe(404);
    expect(await verdict.response.text()).toBe(
      "This preview session no longer exists.",
    );
    expect(calls).toHaveLength(0);
  });

  test("a committed upgrade carries the verbatim app path and the id-only query upstream", async () => {
    const { origin } = stubOrigin({ appPath: "/lb/_next/webpack-hmr" });
    const { calls, commit } = commitProbe(true);
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps(),
      webappHmr: undefined,
    });
    const url = new URL(
      "http://127.0.0.1:3221/lb/_next/webpack-hmr?id=abc123&junk=1",
    );
    const verdict = await frontDoor.dispatch(
      upgradeRequest(url.toString()),
      url,
      commit,
    );
    expect(verdict).toEqual({ claimed: true, response: undefined });
    expect(calls).toEqual([
      {
        // The dev form's leading label rides the path VERBATIM (the dev server
        // is basePath-mounted under it); the query keeps only `id`.
        upstream: "ws://10.0.0.8:4100/lb/_next/webpack-hmr?id=abc123",
        hmr: true,
      },
    ]);
  });

  test("a refused commit answers 400 with the upgrade sentence", async () => {
    const { origin } = stubOrigin({ appPath: "/lb/_next/webpack-hmr" });
    const { commit } = commitProbe(false);
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps(),
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      upgradeRequest("http://127.0.0.1:3221/lb/_next/webpack-hmr"),
      new URL("http://127.0.0.1:3221/lb/_next/webpack-hmr"),
      commit,
    );
    if (!verdict.claimed || !verdict.response) throw new Error("not answered");
    expect(verdict.response.status).toBe(400);
    expect(await verdict.response.text()).toBe("Expected a WebSocket upgrade.");
  });
});

describe("D1b — the main-site webapp HMR dispatch keeps its own slot's judgment", () => {
  const HMR_URL = `http://app.example.com/api/craft/sessions/${SESSION_ID}/webapp/_next/webpack-hmr`;

  test("webapp deps absent (webapp proxy off) answers nothing", async () => {
    const frontDoor = createCraftPreviewFrontDoor({
      origin: undefined,
      previewHmr: undefined,
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatchWebappHmr(
      upgradeRequest(HMR_URL),
      new URL(HMR_URL),
      async () => ({ id: USER_ID }),
      commitProbe(true).commit,
    );
    expect(verdict).toEqual({ claimed: false });
  });

  test("a non-HMR path answers nothing", async () => {
    const frontDoor = createCraftPreviewFrontDoor({
      origin: undefined,
      previewHmr: undefined,
      webappHmr: webappHmrDeps(),
    });
    const verdict = await frontDoor.dispatchWebappHmr(
      upgradeRequest("http://app.example.com/api/craft/sessions/x"),
      new URL("http://app.example.com/api/craft/sessions/x"),
      async () => ({ id: USER_ID }),
      commitProbe(true).commit,
    );
    expect(verdict).toEqual({ claimed: false });
  });

  test("the HMR path without an upgrade header answers nothing", async () => {
    const frontDoor = createCraftPreviewFrontDoor({
      origin: undefined,
      previewHmr: undefined,
      webappHmr: webappHmrDeps(),
    });
    const verdict = await frontDoor.dispatchWebappHmr(
      new Request(HMR_URL),
      new URL(HMR_URL),
      async () => ({ id: USER_ID }),
      commitProbe(true).commit,
    );
    expect(verdict).toEqual({ claimed: false });
  });

  test("a failed actor resolution is the resolver's 401, before any commit", async () => {
    const { calls, commit } = commitProbe(true);
    const frontDoor = createCraftPreviewFrontDoor({
      origin: undefined,
      previewHmr: undefined,
      webappHmr: webappHmrDeps(),
    });
    const verdict = await frontDoor.dispatchWebappHmr(
      upgradeRequest(HMR_URL),
      new URL(HMR_URL),
      async () => {
        throw new Error("no session");
      },
      commit,
    );
    if (!verdict.claimed || !verdict.response) throw new Error("not answered");
    expect(verdict.response.status).toBe(401);
    expect(await verdict.response.text()).toBe("Sign in first.");
    expect(calls).toHaveLength(0);
  });

  test("the ok leg forwards the main-site mount path verbatim", async () => {
    const { calls, commit } = commitProbe(true);
    const frontDoor = createCraftPreviewFrontDoor({
      origin: undefined,
      previewHmr: undefined,
      webappHmr: webappHmrDeps(),
    });
    const verdict = await frontDoor.dispatchWebappHmr(
      upgradeRequest(HMR_URL),
      new URL(HMR_URL),
      async () => ({ id: USER_ID }),
      commit,
    );
    expect(verdict).toEqual({ claimed: true, response: undefined });
    expect(calls).toEqual([
      {
        upstream: `ws://10.0.0.8:4100/api/craft/sessions/${SESSION_ID}/webapp/_next/webpack-hmr`,
        hmr: true,
      },
    ]);
  });
});

describe("D2 — acceptance ②: a preview host never borrows the platform cookie; TLS down stays closed", () => {
  const devOrigin = () =>
    createPreviewOrigin({
      config: {
        enabled: true,
        webappProxyEnabled: true,
        previewOriginEnabled: true,
        previewOriginTemplate: "",
      },
      previewTickets: createPreviewTickets({ store: {} as never }),
      secret: "mod22-d2-suite-secret",
      env: DEV_ENV,
      servePreview: async () => new Response("served-by-stub"),
    });

  test("the HTTP entry 401s a request carrying only a main-site cookie (no preview pass)", async () => {
    const origin = devOrigin();
    const address = origin.originFor(SESSION_ID); // registers the label
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps(),
      webappHmr: undefined,
    });
    const verdict = await frontDoor.dispatch(
      new Request(address, {
        headers: { cookie: "better-auth.session_token=platform-session" },
      }),
      new URL(address),
      commitProbe(true).commit,
    );
    if (!verdict.claimed || !verdict.response) throw new Error("not answered");
    expect(verdict.response.status).toBe(401);
    expect(await verdict.response.json()).toEqual({
      error: PREVIEW_PASS_REFUSAL,
    });
  });

  test("the HMR upgrade applies the origin's OWN pass judgment — a platform cookie opens nothing", async () => {
    const origin = devOrigin();
    const address = origin.originFor(SESSION_ID);
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: {
        ...previewHmrDeps(),
        // #358 repair's wiring, through the seam: the origin's own verifyPass.
        verifyPass: origin.verifyPass,
      },
      webappHmr: undefined,
    });
    const hmrUrl = `${address}/_next/webpack-hmr`;
    const { calls, commit } = commitProbe(true);
    const verdict = await frontDoor.dispatch(
      upgradeRequest(hmrUrl, {
        cookie: "better-auth.session_token=platform-session",
      }),
      new URL(hmrUrl),
      commit,
    );
    if (!verdict.claimed || !verdict.response) throw new Error("not answered");
    expect(verdict.response.status).toBe(401);
    expect(await verdict.response.text()).toBe(PREVIEW_PASS_REFUSAL);
    expect(calls).toHaveLength(0);
  });

  test("structural pin: the preview dispatch has no platform-actor resolution in it at all", () => {
    const seam = readFileSync(
      join(hereDir, "../../src/craft/preview.ts"),
      "utf8",
    );
    const dispatch = seam.slice(
      seam.indexOf("async dispatch("),
      seam.indexOf("async dispatchWebappHmr("),
    );
    expect(dispatch).not.toContain("resolveActor");
    expect(dispatch).not.toContain("resolveRequestActor");
  });

  test("TLS down on the host form keeps the original closed contract: admission closed, claimed host 503s with the reason", async () => {
    const origin = createPreviewOrigin({
      config: {
        enabled: true,
        webappProxyEnabled: true,
        previewOriginEnabled: true,
        previewOriginTemplate: "https://{session}.preview.example.com",
      },
      previewTickets: createPreviewTickets({ store: {} as never }),
      secret: "mod22-d2-suite-secret",
      // No status file at this path → the renewal gate's verdict is not ok.
      env: {
        ...DEV_ENV,
        OPENBOT_TLS_STATUS_FILE: join(hereDir, "no-such-tls-status.json"),
      },
      servePreview: async () => new Response("served-by-stub"),
    });
    const admission = origin.admission();
    expect(admission.ok).toBe(false);
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps(),
      webappHmr: undefined,
    });
    const url = "https://deadbeef.preview.example.com/";
    const verdict = await frontDoor.dispatch(
      new Request(url),
      new URL(url),
      commitProbe(true).commit,
    );
    if (!verdict.claimed || !verdict.response) throw new Error("not answered");
    expect(verdict.response.status).toBe(503);
    if (admission.ok) throw new Error("unreachable");
    expect(await verdict.response.json()).toEqual({ error: admission.reason });
  });
});

describe("D1c — ticket redemption through the seam: single-use, entry-root only", () => {
  test("the hop redeems once at the entry root, 302s with the D9 cookie, and a second hop 401s", async () => {
    const tickets = createPreviewTickets({
      store: {
        findSession: async (id: string, owner: string) =>
          id === SESSION_ID && owner === USER_ID ? { id } : undefined,
      } as never,
    });
    const origin = createPreviewOrigin({
      config: {
        enabled: true,
        webappProxyEnabled: true,
        previewOriginEnabled: true,
        previewOriginTemplate: "",
      },
      previewTickets: tickets,
      secret: "mod22-d1c-suite-secret",
      env: DEV_ENV,
      servePreview: async () => new Response("served-by-stub"),
    });
    const address = origin.originFor(SESSION_ID);
    const { ticket } = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: new URL(address).host,
    });
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps(),
      webappHmr: undefined,
    });

    const hop = `${address}?ticket=${ticket}`;
    const first = await frontDoor.dispatch(
      new Request(hop),
      new URL(hop),
      commitProbe(true).commit,
    );
    if (!first.claimed || !first.response) throw new Error("not answered");
    expect(first.response.status).toBe(302);
    const cookie = first.response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("openbot_preview_session=");
    // The dev form scopes the pass to the session's own label path (R-9).
    expect(cookie).toContain(`Path=${new URL(address).pathname};`);
    expect(first.response.headers.get("cache-control")).toBe("no-store");

    // The spent ticket's second redemption is the family's refusal sentence.
    const second = await frontDoor.dispatch(
      new Request(hop),
      new URL(hop),
      commitProbe(true).commit,
    );
    if (!second.claimed || !second.response) throw new Error("not answered");
    expect(second.response.status).toBe(401);
    expect(await second.response.json()).toEqual({
      error: "The preview ticket is invalid, expired, or already used.",
    });
  });

  test("a ?ticket= on a NON-entry-root path is an ordinary request: no redemption, no burn", async () => {
    const tickets = createPreviewTickets({
      store: {
        findSession: async (id: string, owner: string) =>
          id === SESSION_ID && owner === USER_ID ? { id } : undefined,
      } as never,
    });
    const origin = createPreviewOrigin({
      config: {
        enabled: true,
        webappProxyEnabled: true,
        previewOriginEnabled: true,
        previewOriginTemplate: "",
      },
      previewTickets: tickets,
      secret: "mod22-d1c-suite-secret",
      env: DEV_ENV,
      servePreview: async () => new Response("served-by-stub"),
    });
    const address = origin.originFor(SESSION_ID);
    const { ticket } = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: new URL(address).host,
    });
    const frontDoor = createCraftPreviewFrontDoor({
      origin,
      previewHmr: previewHmrDeps(),
      webappHmr: undefined,
    });

    // Deep path + ticket, no pass: the cookie gate's 401, NOT the redemption's.
    const deep = `${address}/deep/page?ticket=${ticket}`;
    const deepVerdict = await frontDoor.dispatch(
      new Request(deep),
      new URL(deep),
      commitProbe(true).commit,
    );
    if (!deepVerdict.claimed || !deepVerdict.response) {
      throw new Error("not answered");
    }
    expect(deepVerdict.response.status).toBe(401);
    expect(await deepVerdict.response.json()).toEqual({
      error: PREVIEW_PASS_REFUSAL,
    });

    // And the ticket survived: the entry root still redeems it.
    const hop = `${address}?ticket=${ticket}`;
    const root = await frontDoor.dispatch(
      new Request(hop),
      new URL(hop),
      commitProbe(true).commit,
    );
    if (!root.claimed || !root.response) throw new Error("not answered");
    expect(root.response.status).toBe(302);
  });
});

describe("D3 — acceptance ③: the resolvers stay in webapp-proxy.ts; the seam only delegates", () => {
  test("webapp-proxy.ts still hosts the four resolvers and the frame pump", () => {
    const source = readFileSync(
      join(hereDir, "../../src/craft/webapp-proxy.ts"),
      "utf8",
    );
    expect(source).toContain("export function webappHmrSessionIdFromPath");
    expect(source).toContain("export async function resolveWebappHmrUpgrade");
    expect(source).toContain("export function webappHmrIsAppPath");
    expect(source).toContain(
      "export async function resolvePreviewWebappHmrUpgrade",
    );
    expect(source).toContain("export const webappHmrSocketHandlers");
  });

  test("the seam re-implements none of them (delegation, not a second copy)", () => {
    const seam = readFileSync(
      join(hereDir, "../../src/craft/preview.ts"),
      "utf8",
    );
    expect(seam).not.toContain("export function webappHmrSessionIdFromPath");
    expect(seam).not.toContain("export async function resolveWebappHmrUpgrade");
    expect(seam).not.toContain("webappHmrUpstreamUrl(input");
    expect(seam).toContain('from "./webapp-proxy"');
  });
});

describe("D4 — acceptance ④: one port source across craft/ (#619's portFromEnvironment)", () => {
  const craftDir = join(hereDir, "../../src/craft");
  const craftFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) craftFiles.push(full);
    }
  };
  walk(craftDir);

  test("only preview-ticket.ts consumes the single port source", () => {
    const consumers = craftFiles.filter((file) =>
      readFileSync(file, "utf8").includes("portFromEnvironment"),
    );
    expect(consumers.map((f) => f.split("/").pop())).toEqual([
      "preview-ticket.ts",
    ]);
  });

  test("no craft file reads PORT/SERVER_PORT off process.env directly", () => {
    const offenders = craftFiles.filter((file) =>
      /process\.env\.(PORT|SERVER_PORT)\b|process\.env\[["'`][^\]]*PORT/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("D5 — B: the routes tree constructs no second sandbox gateway", () => {
  test("routes.ts has no direct createSandboxGateway construction", () => {
    const source = readFileSync(
      join(hereDir, "../../src/craft/routes.ts"),
      "utf8",
    );
    expect(source).not.toContain("createSandboxGateway");
    expect(source).toContain("deps.gateway");
  });

  test("the boot assembly takes the routes gateway through the MOD11 binding", () => {
    const runtime = readFileSync(
      join(hereDir, "../../src/assembly/runtime.ts"),
      "utf8",
    );
    expect(runtime).toContain("gateway: craftSandboxPublic.handlesFor({");
  });

  test("the HMR leg and the routes tree take the SAME binding key (one instance)", () => {
    const runtime = readFileSync(
      join(hereDir, "../../src/assembly/runtime.ts"),
      "utf8",
    );
    // The seam's lazy acquisition and the routes dep both name the same
    // scope const — handlesFor's cache then guarantees one gateway.
    expect(runtime).toMatch(
      /hmrGatewayFor: \(\) =>\s*\n\s*craftSandboxPublic\.handlesFor\(\{ scope: craftSandboxExecutionScope\(\) \}\),/,
    );
    expect(runtime).toMatch(
      /gateway: craftSandboxPublic\.handlesFor\(\{\s*\n\s*scope: craftSandboxExecutionScope\(\),\s*\n\s*\}\),/,
    );
  });
});

describe("D6 — C: no second run-terminal write face in craft/ or workshop/", () => {
  const roots = [
    join(hereDir, "../../src/craft"),
    join(hereDir, "../../src/workshop"),
  ];
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) sources.push(full);
    }
  };
  for (const root of roots) walk(root);

  test("the terminal-state write surface is exactly the frozen inventory", () => {
    const TERMINAL =
      /turn\.status\s*=|status:\s*TURN_STATUS_(?:SUCCEEDED|FAILED|CANCELLED)|status:\s*"(?:succeeded|failed|cancelled)"|mark(?:Succeeded|Failed|Cancelled)\(|"workshop\.turn_(?:completed|failed|cancelled)"|status:\s*input\.status/;
    const actual = sources
      .filter((file) => TERMINAL.test(readFileSync(file, "utf8")))
      .map((file) => file.split("server/src/")[1])
      .sort();
    expect(actual).toEqual([
      "craft/message-routes.ts",
      "craft/scheduled-tasks.ts",
      "craft/turn-executor.ts",
      "craft/turn-routes.ts",
      "craft/turn-state.ts",
      "workshop/headless.ts",
      "workshop/metering.ts",
      "workshop/orchestrator.ts",
      "workshop/schedule-executor.ts",
      "workshop/store.ts",
    ]);
  });

  test("neither group references the enterprise runs module (own engines kept, zero replacement)", () => {
    const borrowers = sources.filter((file) =>
      /enterprise\/runs|runs\/public/.test(readFileSync(file, "utf8")),
    );
    expect(borrowers).toEqual([]);
  });
});

describe("D7 — the direct-family inventory and its native/bun split stay frozen", () => {
  const NATIVE_FAMILY = [
    "server/tests/craft-preview-origin.test.ts",
    "server/tests/craft-preview-ticket.test.ts",
    "server/tests/craft-preview-pass.test.ts",
    "server/tests/craft-preview-rejection.test.ts",
    "server/tests/craft-webapp-proxy.test.ts",
    "server/tests/craft-turn-state.test.ts",
    "server/tests/craft-turn-sse-attach.test.ts",
    "server/tests/craft-snapshot.test.ts",
    "server/tests/workshop-orchestrator.test.ts",
    "server/tests/workshop-headless.test.ts",
    "server/tests/craft-sandbox-gateway-scope.test.ts",
    "server/tests/multitenancy/craft-sandbox-public.test.ts",
  ];
  const BUN_FAMILY = [
    "server/tests/craft-webapp-hmr.test.ts",
    "server/tests/craft-preview-socket.test.ts",
    "server/tests/craft-preview-origin-guard.test.ts",
    "server/tests/workshop-preview.test.ts",
    "server/tests/craft-idle-reaper.test.ts",
  ];
  const repoRoot = join(hereDir, "../../..");

  test("all 17 family suites exist", () => {
    for (const file of [...NATIVE_FAMILY, ...BUN_FAMILY]) {
      expect(existsSync(join(repoRoot, file))).toBe(true);
    }
  });

  test("the bun manifest still drives exactly the five manifest pieces of the family", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "tests/config/e2e-bun-suites.json"), "utf8"),
    ) as { groups: { files: string[] }[] };
    const driven = new Set(manifest.groups.flatMap((group) => group.files));
    for (const file of BUN_FAMILY) expect(driven.has(file)).toBe(true);
    for (const file of NATIVE_FAMILY) expect(driven.has(file)).toBe(false);
  });
});
