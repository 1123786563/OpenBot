// #410 — 主站 cookie 认证的写接口拒绝 preview Origin（spec craft-preview-origin AC1，
// CP-03 / D-5 落点）。
//
// 威胁模型：生产 preview 是主站的子域（D3/D7）。SameSite 拦不住主站 host 的 cookie 被
// 带进主站请求（同 site），CSP 只是浏览器侧的防线。所以主站的 cookie 认证写接口必须在
// 服务端自己也认一次 Origin：预览页里 LLM 生成的代码 `fetch("https://<主站>/api/craft/sessions",
// {credentials:"include"})` 应当拿到 403，而不是打到会话上。
//
// 判定纪律（与 preview-origin.ts 同一套归一化，绝不第二份）：
// - 只治非安全方法（POST/PUT/PATCH/DELETE）；读面归 CORS + preview pass；
// - 无 Origin（CLI / native / 服务端内部调用）不判——头是浏览器给的，不是凭证；
// - preview 命名空间先判（fail closed，即便它同时出现在受信列表里也不放行）；
// - 其余只放行 Host 同源 + 受信 origins（TRUSTED_ORIGINS + APP_URL，与 CORS 同一份）；
// - dev 形态（空模板，label 在 path 上）的 Origin 头里根本没有 path，与主站自身同形，
//   无法判定——claimsOrigin 明确返回 false，这条已知缺口记录在案，不假装有防护。
//
// 拒绝面不回显、不记录任何 cookie 或 ticket 值。

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import {
  createPreviewOrigin,
  type PreviewOrigin,
  type ServePreview,
  samePreviewOrigin,
} from "../src/craft/preview-origin";
import { createPreviewTickets } from "../src/craft/preview-ticket";
import { createCraftRoutes } from "../src/craft/routes";
import type { CraftStore } from "../src/craft/store";
import {
  CRAFT_WRITE_ORIGIN_REFUSAL,
  createCraftWriteOriginGuard,
} from "../src/craft/write-origin-guard";

const SESSION_ID = "cs-write-origin";
const USER_ID = "u1";
const SECRET = "test-write-origin-secret";
const HOST_TEMPLATE = "https://{session}.preview.example.com";
/** The value the refusal must never echo or log. */
const COOKIE = "openbot.session=super-secret-session-value";

/** A healthy TLS renewal-status record in a throwaway file (#411's fixture
 * shape — the same one craft-preview-rejection.test.ts hands its origins).
 * #411's tlsStatusGate fail-closes host-form origins without a judgeable
 * status file; this suite mints host-form addresses, so hand them a healthy
 * record and keep the TLS gate out of the way of what this file tests. */
const healthyTlsStatusFile = (() => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-tls-status-guard-"));
  const statusFile = join(dir, "renewal-status.json");
  writeFileSync(statusFile, JSON.stringify({ health: "ok", daysLeft: 45 }));
  return statusFile;
})();

const originWith = (
  previewOriginTemplate: string,
  env: Record<string, string | undefined> = {},
): PreviewOrigin =>
  createPreviewOrigin({
    config: {
      enabled: true,
      webappProxyEnabled: true,
      previewOriginEnabled: true,
      previewOriginTemplate,
    },
    previewTickets: createPreviewTickets({
      store: {
        async findSession(sessionId: string, userId: string) {
          return sessionId === SESSION_ID && userId === USER_ID
            ? { id: SESSION_ID, userId: USER_ID }
            : undefined;
        },
      } as unknown as CraftStore,
    }),
    secret: SECRET,
    env: { OPENBOT_TLS_STATUS_FILE: healthyTlsStatusFile, ...env },
    servePreview: (async () =>
      new Response("unproxied", { status: 503 })) as ServePreview,
  });

const previewOrigin = originWith(HOST_TEMPLATE);

type GuardLog = {
  method: string;
  path: string;
  origin: string;
  verdict: string;
};

/** The guard in front of one sentinel route: 200 means "the guard passed it through". */
function guardApp(input: {
  trustedOrigins?: readonly string[];
  isPreviewOrigin?: (origin: string) => boolean;
  log?: (entry: GuardLog) => void;
}) {
  const entries: GuardLog[] = [];
  const app = new Hono();
  app.use(
    "*",
    createCraftWriteOriginGuard({
      trustedOrigins: input.trustedOrigins ?? ["https://app.test"],
      isPreviewOrigin:
        input.isPreviewOrigin ??
        ((origin) => previewOrigin.claimsOrigin(origin)),
      log: (entry) => {
        entries.push(entry);
        input.log?.(entry);
      },
    }),
  );
  app.all("/sessions", (context) => context.json({ ok: true }));
  return { app, entries };
}

/** A credentialed browser-shaped call; `origin: undefined` means "no Origin header". */
function call(
  app: Hono,
  options: {
    method?: string;
    origin?: string;
    url?: string;
  } = {},
) {
  const headers: Record<string, string> = { cookie: COOKIE };
  if (options.origin !== undefined) headers.origin = options.origin;
  return app.request(options.url ?? "https://app.test/sessions", {
    method: options.method ?? "POST",
    headers,
  });
}

/** The host-form address the origin itself mints — the exact Origin a preview page sends. */
const LABEL_ORIGIN = previewOrigin.originFor(SESSION_ID);

describe("写接口 Origin 门: 非安全方法的拒绝面", () => {
  test("AC1 — 带 preview Origin 的 credentialed POST → 403，且是那句可展示的原因", async () => {
    const { app } = guardApp({});
    const response = await call(app, { origin: LABEL_ORIGIN });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(CRAFT_WRITE_ORIGIN_REFUSAL);
  });

  test("preview Origin 的四个非安全方法一律 403", async () => {
    const { app } = guardApp({});
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await call(app, { method, origin: LABEL_ORIGIN });
      expect([method, response.status]).toEqual([method, 403]);
    }
  });

  test("preview 命名空间里的任意深度子域同样 403（通配 fail closed）", async () => {
    const { app } = guardApp({});
    for (const origin of [
      "https://abc.preview.example.com",
      "https://deep.nested.preview.example.com",
      "https://preview.example.com", // 基座本身也在命名空间里
      "http://abc.preview.example.com",
    ]) {
      expect([origin, (await call(app, { origin })).status]).toEqual([
        origin,
        403,
      ]);
    }
  });

  test("其他 Origin → 403（白名单严拒，不只 preview 域）", async () => {
    const { app } = guardApp({});
    for (const origin of [
      "https://evil.test",
      "https://app.test.evil.net", // 后缀伪装
      "https://evil-preview.example.com", // 前缀伪装
      "https://preview.example.com.evil.net",
    ]) {
      expect([origin, (await call(app, { origin })).status]).toEqual([
        origin,
        403,
      ]);
    }
  });

  test("伪造与不透明 Origin（null、垃圾串、带 path 的值）→ 403，且从不抛", async () => {
    const { app } = guardApp({});
    for (const origin of [
      "null",
      "not-an-origin",
      "https://",
      "javascript:alert(1)",
    ]) {
      const response = await call(app, { origin });
      expect([origin, response.status]).toEqual([origin, 403]);
    }
  });

  test("GET/HEAD/OPTIONS 不经本门：读面与 CORS 预检保持原行为", async () => {
    const { app } = guardApp({});
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const response = await call(app, {
        method,
        origin: "https://abc.preview.example.com",
      });
      expect([method, response.status]).toEqual([method, 200]);
    }
  });
});

describe("写接口 Origin 门: 放行面（不误伤）", () => {
  test("主站自身 Origin（受信列表）→ 原行为", async () => {
    const { app } = guardApp({});
    expect((await call(app, { origin: "https://app.test" })).status).toBe(200);
  });

  test("Host 同源 Origin → 原行为（安装/dev 形态下主站直连 server 的那条路）", async () => {
    const { app } = guardApp({ trustedOrigins: [] });
    // 浏览器把 Origin 拼给谁，取决于它访问的地址；Host 同源判定让这条路不依赖配置。
    const response = await app.request("http://127.0.0.1:3001/sessions", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3001", cookie: COOKIE },
    });
    expect(response.status).toBe(200);
  });

  test("无 Origin（internal / native / CLI）→ 原行为", async () => {
    const { app } = guardApp({ trustedOrigins: [] });
    expect((await call(app, {})).status).toBe(200);
  });

  test("尾点与默认端口拼写不改变判定（与 preview-origin 同一归一化）", async () => {
    const { app } = guardApp({ trustedOrigins: ["https://app.test"] });
    // 尾点 FQDN 是同一个预览主机 → 仍然 403。
    expect(
      (await call(app, { origin: "https://abc.preview.example.com." })).status,
    ).toBe(403);
    // :443 拼写的受信主站与无端口拼写同形 → 仍然放行。
    expect((await call(app, { origin: "https://app.test:443" })).status).toBe(
      200,
    );
    // 尾点拼写的受信主站同理。
    expect((await call(app, { origin: "https://app.test." })).status).toBe(200);
  });
});

describe("写接口 Origin 门: 拒绝日志不含凭证", () => {
  test("日志与响应体都不含 cookie / ticket 值", async () => {
    const { app, entries } = guardApp({});
    const response = await call(app, {
      origin: "https://abc.preview.example.com",
      url: "https://app.test/sessions?ticket=opaque-ticket-value",
    });
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain(COOKIE);
    expect(body).not.toContain("opaque-ticket-value");
    expect(body).not.toContain("abc.preview.example.com");
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(COOKIE);
    expect(logged).not.toContain("opaque-ticket-value");
    expect(entries[0]).toMatchObject({
      method: "POST",
      path: "/sessions",
      origin: "https://abc.preview.example.com",
      verdict: "preview",
    });
  });

  test("白名单命中的 verdict 是 untrusted 而不是 preview", async () => {
    const { app, entries } = guardApp({});
    expect((await call(app, { origin: "https://evil.test" })).status).toBe(403);
    expect(entries[0]?.verdict).toBe("untrusted");
  });
});

// #410 把 host 认领与 Origin 归一化抽成了一份判定（claimsPreviewHost /
// normalizedOriginOf）。craft-webapp-hmr 与 craft-preview-origin 这两个套件本来钉着
// 这些行为，但它们此刻跑不起来（见本轮记录里的并行迁移阻塞），所以把回归 pin 直接
// 写在这份能跑的文件的旁边：判定改了必须在这里响。
describe("共享归一化与 host 认领: 重构后的回归 pin", () => {
  const ADDRESS = previewOrigin.originFor(SESSION_ID); // https://<label>.preview.example.com

  test("samePreviewOrigin 只比 scheme://host[:port]：尾点与默认端口同形", () => {
    expect(samePreviewOrigin(ADDRESS, ADDRESS)).toBe(true);
    expect(samePreviewOrigin(ADDRESS.replace(".com", ".com."), ADDRESS)).toBe(
      true,
    );
    expect(
      samePreviewOrigin(
        "https://anything.example.com",
        "https://anything.example.com:443",
      ),
    ).toBe(true);
    expect(samePreviewOrigin("https://other.example.com", ADDRESS)).toBe(false);
  });

  test("samePreviewOrigin 的不透明、不可解析与无 Origin 三种形状", () => {
    expect(samePreviewOrigin("null", ADDRESS)).toBe(false);
    expect(samePreviewOrigin("not-an-origin", ADDRESS)).toBe(false);
    // 无 Origin（非浏览器升级）按既有约定放行。
    expect(samePreviewOrigin(null, ADDRESS)).toBe(true);
  });

  test("dev 形态地址的 path label 不进比较（Origin 头从不带 path）", () => {
    const dev = originWith("", { PORT: "3001" });
    const address = dev.originFor(SESSION_ID); // http://127.0.0.1:3001/<label>
    expect(samePreviewOrigin("http://127.0.0.1:3001", address)).toBe(true);
    expect(samePreviewOrigin("http://127.0.0.1:3002", address)).toBe(false);
  });

  test("handlesRequest 走同一份认领：预览主机认领，主站与被仿主机不认领", () => {
    const host = ADDRESS.slice("https://".length);
    expect(previewOrigin.handlesRequest(new Request(`${ADDRESS}/`))).toBe(true);
    // 尾点 FQDN 是同一个主机（fix-ocr16）。
    expect(previewOrigin.handlesRequest(new Request(`https://${host}./`))).toBe(
      true,
    );
    expect(
      previewOrigin.handlesRequest(new Request("https://app.example.com/")),
    ).toBe(false);
    expect(
      previewOrigin.handlesRequest(
        new Request("https://preview.example.com.evil.net/"),
      ),
    ).toBe(false);
  });

  test("dev 形态仍只认已注册的 path label（fix-ocr3：主站不被接管）", () => {
    const dev = originWith("", { PORT: "3001" });
    const label = dev
      .originFor(SESSION_ID)
      .slice("http://127.0.0.1:3001/".length);
    expect(
      dev.handlesRequest(new Request(`http://127.0.0.1:3001/${label}/x`)),
    ).toBe(true);
    expect(
      dev.handlesRequest(
        new Request("http://127.0.0.1:3001/api/craft/sessions"),
      ),
    ).toBe(false);
    expect(
      dev.resolvePreviewRequest(new Request(`http://127.0.0.1:3001/${label}`)),
    ).toEqual({ sessionId: SESSION_ID });
  });

  test("host 形态未注册的 label 404，绝不回落到主站路由", () => {
    expect(
      previewOrigin.resolvePreviewRequest(
        new Request("https://deadbeef.preview.example.com/"),
      ),
    ).toEqual({ refuse: { status: 404, reason: "Unknown preview host." } });
  });
});

describe("claimsOrigin: preview 命名空间的 Origin 形状（真实 origin 实例）", () => {
  test("host 形态：铸出的地址自身必被认领，主站与被仿主机不认领", () => {
    const address = previewOrigin.originFor(SESSION_ID);
    expect(previewOrigin.claimsOrigin(address)).toBe(true);
    expect(previewOrigin.claimsOrigin("https://app.example.com")).toBe(false);
    expect(previewOrigin.claimsOrigin("https://example.com")).toBe(false);
    expect(previewOrigin.claimsOrigin(null)).toBe(false);
  });

  test("localhost 形态：只认领模板自己端口的子域，不认领主站所在的 apex", () => {
    const origin = originWith("https://{session}.localhost:3221");
    expect(origin.claimsOrigin("https://abc.localhost:3221")).toBe(true);
    expect(origin.claimsOrigin("https://abc.localhost:3222")).toBe(false);
    expect(origin.claimsOrigin("https://localhost:3221")).toBe(false);
    expect(origin.claimsOrigin("https://abc.localhost")).toBe(false);
  });

  test("dev 形态（空模板）：Origin 头里没有 path label，与主站同形 → 一律不认领", () => {
    const origin = originWith("", { PORT: "3001" });
    // 已知缺口，记录在案：dev 形态的隔离靠 host 不同（localhost 登录 vs 127.0.0.1 预览），
    // 而不是靠 Origin 判定；这里必须由主站自身的 Host 同源/受信列表放行。
    expect(origin.claimsOrigin("http://127.0.0.1:3001")).toBe(false);
    expect(origin.claimsOrigin(origin.originFor(SESSION_ID))).toBe(false);
  });

  test("不可解析的值不认领（判定交给门的 unparseable 分支）", () => {
    expect(previewOrigin.claimsOrigin("null")).toBe(false);
    expect(previewOrigin.claimsOrigin("abc.preview.example.com")).toBe(false);
  });
});

// ── 装配层：门跑在 cookie 认证之前，sandbox relay 那一层不受影响 ──────────────

const refusingRequireUser: MiddlewareHandler<{
  Variables: AppVariables;
}> = async (context) => context.json({ error: "unauthorized" }, 401);

describe("createCraftRoutes 装配: 门的注册顺序", () => {
  const assembled = () =>
    createCraftRoutes({
      requireUser: refusingRequireUser,
      deps: {
        config: loadCraftConfig({
          OPENBOT_CRAFT_ENABLED: "true",
          OPENBOT_CRAFT_IDLE_REAPER_ENABLED: "false",
        }),
        db: {} as never,
        redis: null,
        approvals: {} as never,
        botIdFor: async () => "craft-bot",
        llmConfigFor: async () => {
          throw new Error("not reached");
        },
        sandboxConnectionFor: () => null,
        userNameFor: async () => null,
        store: {} as unknown as CraftStore,
        previewWriteTrustedOrigins: ["https://app.test"],
        previewOriginClaimsOrigin: (origin) =>
          previewOrigin.claimsOrigin(origin),
      },
    });

  test("preview Origin 的写请求在 requireUser 之前就被 403（不是 401）", async () => {
    const response = await assembled().request("/sessions", {
      method: "POST",
      headers: { cookie: COOKIE, origin: "https://abc.preview.example.com" },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(CRAFT_WRITE_ORIGIN_REFUSAL);
  });

  test("受信 Origin 仍走原认证判定（401），门不吞掉后续行为", async () => {
    const response = await assembled().request("/sessions", {
      method: "POST",
      headers: { cookie: COOKIE, origin: "https://app.test" },
    });
    expect(response.status).toBe(401);
  });

  test("无 Origin 仍走原认证判定（401）", async () => {
    const response = await assembled().request("/sessions", {
      method: "POST",
      headers: { cookie: COOKIE },
    });
    expect(response.status).toBe(401);
  });

  test("sandbox 的 MCP relay 在门的上一层：外来 Origin 也拿它自己的 not_authorized", async () => {
    const response = await assembled().request("/mcp/server-1", {
      method: "POST",
      headers: { origin: "https://abc.preview.example.com" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_authorized" });
  });
});
