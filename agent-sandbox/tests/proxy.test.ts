import { describe, expect, test, afterAll } from "bun:test";
import { serve } from "bun";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createProxyHandler, tokenMatches } from "../src/proxy";
import { createBotRuntimes } from "../src/bot-runtimes";
import { sandboxEnvFrom } from "../src/env";

// 宿主机没有 /workspace（容器内的挂载点）：用一次性临时目录充当 volume。
const workspaceDir = await mkdtemp(`${tmpdir()}/proxy-test-`);

const env = sandboxEnvFrom({
  SANDBOX_TOKEN: "secret-token",
  SANDBOX_PROVIDER_BASE_URL: "https://example.invalid",
  SANDBOX_PROVIDER_API_KEY: "k",
  SANDBOX_MODEL: "GLM-5.3",
  SANDBOX_WORKSPACE_DIR: workspaceDir,
  SANDBOX_UPSTREAM_PORT_BASE: "4600",
});

/**
 * 假上游：占住 base 端口 4600，echo 出自己的端口。
 * 真 spawn 被替换掉，所以第一个 bot（alpha）的"opencode serve"就是这个 serve 的语义替身。
 */
const upstream = serve({
  port: 4600,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url);
    const port = url.port;
    if (url.pathname === "/doc") return Response.json({ openapi: "3.1.0", served: port });
    if (url.pathname === "/session" && request.method === "POST")
      return Response.json({ id: `ses_${port}` });
    if (url.pathname === "/file/content")
      return new Response("x".repeat(300_000), {
        headers: { "content-length": String(300_000) },
      });
    return Response.json({ echo: url.pathname, method: request.method, port });
  },
});
afterAll(() => upstream.stop(true));

const runtimes = createBotRuntimes({
  env,
  spawnFn: ((bin: never, args: never, opts: never) => {
    void bin;
    void args;
    void opts;
    return { once: () => {}, kill: () => true };
  }) as never,
  fetchImpl: (async (url: string | URL, init?: RequestInit) => {
    // 假探活：startOpencodeServe 的 ready 循环立即满足（真正的路由探活走全局 fetch 打上面的 serve）。
    void url;
    void init;
    return new Response(JSON.stringify({ openapi: "3.1.0" }), { status: 200 });
  }) as never,
});

const handler = createProxyHandler(env, runtimes);
const call = (path: string, init?: RequestInit) =>
  handler(new Request(`http://127.0.0.1:4300${path}`, init));
const botHeaders = { "x-sandbox-token": "secret-token", "x-openbot-bot-id": "alpha" };

describe("proxy", () => {
  test("rejects a request without the token", async () => {
    const response = await call("/session", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
  });

  test("rejects a wrong token without leaking which part failed", async () => {
    const response = await call("/session", {
      method: "POST",
      headers: { "x-sandbox-token": "wrong", "x-openbot-bot-id": "alpha" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  test("forwards an allowed path with the body intact (first bot takes the base port)", async () => {
    const response = await call("/session", {
      method: "POST",
      headers: { ...botHeaders, "content-type": "application/json" },
      body: JSON.stringify({ title: "t" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "ses_4600" });
  });

  test("a path outside the allow-list is 404 upstream-untouched", async () => {
    const response = await call("/admin", { headers: botHeaders });
    expect(response.status).toBe(404);
  });

  test("an oversized content-length is refused before the upstream is touched", async () => {
    // POST /session is allow-listed, so the 413 can only come from the request-size gate that
    // runs before the upstream fetch. content-length is declared explicitly because a Request
    // built in-process does not derive it from the body the way a network request does.
    const response = await call("/session", {
      method: "POST",
      headers: { ...botHeaders, "content-length": String(300_000) },
      body: "x".repeat(300_000),
    });
    expect(response.status).toBe(413);
  });

  test("an oversized upstream response is refused", async () => {
    const response = await call("/file/content", { headers: botHeaders });
    expect(response.status).toBe(413);
  });

  test("health needs no token", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
  });
});

describe("proxy with per-bot runtimes", () => {
  test("缺 bot 头是 400，token 检查仍在前", async () => {
    const noBot = await call("/session", {
      method: "POST",
      headers: { "x-sandbox-token": "secret-token" },
      body: "{}",
    });
    expect(noBot.status).toBe(400);
    const noToken = await call("/session", {
      method: "POST",
      headers: { "x-openbot-bot-id": "alpha" },
      body: "{}",
    });
    expect(noToken.status).toBe(401);
  });

  test("非法 bot id 是 400", async () => {
    const response = await call("/session", {
      method: "POST",
      headers: { ...botHeaders, "x-openbot-bot-id": "../escape" },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  test("同一 bot 的请求被路由到同一个上游端口", async () => {
    const r1 = await call("/session", { method: "POST", headers: botHeaders, body: "{}" });
    const r2 = await call("/session", { method: "POST", headers: botHeaders, body: "{}" });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { id: string };
    const b2 = (await r2.json()) as { id: string };
    expect(b1.id).toBe(b2.id);
  });

  test("reset 端点移除 bot 工作区并返回 200", async () => {
    const runtime = await runtimes.getOrSpawn("reset-me");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${runtime.workspaceDir}/keep.txt`, "x");
    const response = await call("/workspace/reset", {
      method: "POST",
      headers: { ...botHeaders, "x-openbot-bot-id": "reset-me" },
    });
    expect(response.status).toBe(200);
    const { stat } = await import("node:fs/promises");
    let gone = false;
    try {
      await stat(`${runtime.workspaceDir}/keep.txt`);
    } catch {
      gone = true;
    }
    expect(gone).toBe(true);
  });
});

describe("tokenMatches", () => {
  test("length mismatch is false without timingSafeEqual", () => {
    expect(tokenMatches("short", "secret-token")).toBe(false);
  });
  test("equal value is true", () => {
    expect(tokenMatches("secret-token", "secret-token")).toBe(true);
  });
});
