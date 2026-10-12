import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serve } from "bun";
import { createBotRuntimes } from "../src/bot-runtimes";
import { sandboxEnvFrom } from "../src/env";
import { createProxyHandler, tokenMatches } from "../src/proxy";

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
const eventUpstreamRequests: string[] = [];
const upstream = serve({
  port: 4600,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url);
    const port = url.port;
    if (url.pathname === "/doc")
      return Response.json({ openapi: "3.1.0", served: port });
    if (url.pathname === "/session" && request.method === "POST")
      return Response.json({ id: `ses_${port}` });
    if (url.pathname === "/file/content")
      return new Response("x".repeat(300_000), {
        headers: { "content-length": String(300_000) },
      });
    // The event bus: a short burst of real captured shapes, then the stream ends. The proxy's
    // keepalive and filter behaviour is what these tests observe. The requested scope is
    // captured for the directory-forwarding test (F-G).
    if (url.pathname === "/event") {
      eventUpstreamRequests.push(`${url.pathname}${url.search}`);
      const samples = [
        `data: {"id":"e1","type":"server.heartbeat","properties":{}}\n\n`,
        `data: {"id":"e2","type":"message.part.delta","properties":{"sessionID":"s","messageID":"m","partID":"p","field":"text","delta":"你好"}}\n\n`,
        `data: {"id":"e3","type":"plugin.added","properties":{"id":"xai"}}\n\n`,
        `data: {"id":"e4","type":"session.idle","properties":{"sessionID":"s"}}\n\n`,
      ];
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const sample of samples) {
            controller.enqueue(encoder.encode(sample));
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          controller.close();
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname.endsWith("/abort") && request.method === "POST")
      return Response.json({ aborted: true, port });
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
// The fake upstream's server is stopped at process exit: under `--isolate` the runner keeps
// this file's process alive for later files, and a serve left listening wedges the next
// file's port 4600 acquire (seen with the snapshot file's real tar children in the pool —
// the combination, not either alone). process exit, not afterAll: the serve serves THIS
// file's every describe.
process.on("exit", () => upstream.stop(true));

const call = (path: string, init?: RequestInit) =>
  handler(new Request(`http://127.0.0.1:4300${path}`, init));
const botHeaders = {
  "x-sandbox-token": "secret-token",
  "x-openbot-bot-id": "alpha",
};

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

describe("proxy: the workshop surface (S2/S5)", () => {
  test("GET /events forwards SSE with the family filter and keepalives", async () => {
    const response = await call("/events", { headers: botHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    // The delta (message_chunk) passes and is labelled with its family…
    expect(text).toContain("event: message_chunk");
    // …so does session.idle (prompt_response)…
    expect(text).toContain("event: prompt_response");
    // …while heartbeat and plugin.added (the 15%-noise) are dropped entirely.
    expect(text).not.toContain("server.heartbeat");
    expect(text).not.toContain("plugin.added");
  });

  test("GET /events without the token is 401, before any runtime is touched", async () => {
    const response = await call("/events");
    expect(response.status).toBe(401);
  });

  test("GET /events forwards the directory scope to the upstream (F-G)", async () => {
    // opencode publishes a directory-scoped session's events only on the
    // scoped stream; dropping the scope makes every craft turn invisible.
    const response = await call("/events?directory=cs-scoped-9", {
      headers: botHeaders,
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(eventUpstreamRequests).toContain("/event?directory=cs-scoped-9");
  });

  test("POST /session/:id/abort forwards to the upstream abort", async () => {
    const response = await call("/session/ses_1/abort", {
      method: "POST",
      headers: botHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      aborted?: boolean;
      port?: string;
    };
    expect(body.aborted).toBe(true);
    expect(body.port).toBe("4600");
  });

  test("POST /session/:id/permissions/:permissionId forwards (F-G: the answer path)", async () => {
    // Every permission answer — the connect_app decision endpoint's and the
    // timeout fallback's — rides this verb; an unlisted verb is a silent 404
    // that parks the turn forever (decide half cannot close).
    const response = await call(
      "/session/ses_1/permissions/perm_1?directory=/w",
      {
        method: "POST",
        headers: { ...botHeaders, "content-type": "application/json" },
        body: JSON.stringify({ response: "reject" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      echo: "/session/ses_1/permissions/perm_1",
      method: "POST",
      port: "4600",
    });
  });

  test("the not-yet-implemented table is empty — every allow-listed verb is real (S4)", async () => {
    // /runtimes (S6), the devserver verbs (S8), and the snapshot pair (S4) have all
    // graduated. The last two honest 501s are gone; this case stays as the tombstone that
    // says the surface is fully implemented, so a future stub lands with its own test.
    const snapshot = await call("/workspace/snapshot", {
      method: "GET",
      headers: botHeaders,
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("content-type")).toBe("application/gzip");
  });

  test("GET /runtimes answers the roster this proxy holds (S6)", async () => {
    // One Bot is up (the shared upstream fake answers it), then the roster names it with the
    // fields an operator asks for — and nothing else, because the roster is read-only.
    const warm = await call("/session", {
      method: "POST",
      headers: botHeaders,
      body: "{}",
    });
    expect(warm.status).toBe(200);
    const response = await call("/runtimes", {
      method: "GET",
      headers: botHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      bots: Array<{
        botId: string;
        status: string;
        port: number;
        workspaceDir: string;
        lastUsedAtMs: number;
        lastActivityAtMs: number;
        spawnAttempts: number;
      }>;
    };
    const mine = body.bots.find((bot) => bot.botId === "alpha");
    expect(mine).toBeDefined();
    expect(mine?.status).toBe("up");
    expect(typeof mine?.port).toBe("number");
    expect(mine?.workspaceDir).toContain("alpha");
    expect(mine?.spawnAttempts).toBeGreaterThanOrEqual(1);
    expect(typeof mine?.lastUsedAtMs).toBe("number");
    expect(typeof mine?.lastActivityAtMs).toBe("number");
  });

  test("POST /file (B5's writeFile verb) writes contained and answers 201 (S7's fix)", async () => {
    // The verb is the proxy's own: forwarding it to the upstream answered the SPA's
    // 200-from-nothing while nothing landed — the live isolation smoke caught it. Now the
    // file is written inside the Bot's workspace and the answer names what landed.
    const response = await call("/file?path=data.csv", {
      method: "POST",
      headers: { ...botHeaders, "content-type": "text/plain" },
      body: "a,b\n1,2\n",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { path?: string; size?: number };
    expect(body.path).toBe("data.csv");
    expect(body.size).toBe(8); // "a,b\n1,2\n" — count the bytes, not the lines.
    // And an escaping path is refused before any write.
    const escapeAttempt = await call("/file?path=../x.csv", {
      method: "POST",
      headers: { ...botHeaders, "content-type": "text/plain" },
      body: "x",
    });
    expect(escapeAttempt.status).toBe(400);
  });

  test("POST /file carries binary bodies past the 256KB relay cap (craft's upload road)", async () => {
    // The craft upload default allows 50MB files; the JSON relay cap stays at 256KB. The
    // file verb must ride its own ceiling — a 300KB binary body crosses the old line.
    const big = new Uint8Array(300_000).fill(7);
    const response = await call("/file?path=attachment.bin", {
      method: "POST",
      headers: { ...botHeaders, "content-type": "application/octet-stream" },
      body: big,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { size?: number };
    expect(body.size).toBe(300_000);
  });

  test("DELETE /file deletes one contained file and refuses directories and escapes", async () => {
    await call("/file?path=tmp/a.txt", {
      method: "POST",
      headers: { ...botHeaders, "content-type": "text/plain" },
      body: "x",
    });
    await call("/file?path=tmp/nested/b.txt", {
      method: "POST",
      headers: { ...botHeaders, "content-type": "text/plain" },
      body: "y",
    });

    // A file deletes.
    const file = await call("/file?path=tmp/a.txt", {
      method: "DELETE",
      headers: botHeaders,
    });
    expect(file.status).toBe(200);
    // A directory is the same 404 as absence (onyx's `[ -f ] && rm` semantics).
    const dir = await call("/file?path=tmp/nested", {
      method: "DELETE",
      headers: botHeaders,
    });
    expect(dir.status).toBe(404);
    // The directory's file survived that refusal.
    const survivor = await call("/file?path=tmp/nested/b.txt", {
      method: "DELETE",
      headers: botHeaders,
    });
    expect(survivor.status).toBe(200);
    // Now absent — and an escaping path is refused before any delete.
    const absent = await call("/file?path=tmp/a.txt", {
      method: "DELETE",
      headers: botHeaders,
    });
    expect(absent.status).toBe(404);
    const escapeAttempt = await call("/file?path=../workspace/..", {
      method: "DELETE",
      headers: botHeaders,
    });
    expect(escapeAttempt.status).toBe(400);
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
    const r1 = await call("/session", {
      method: "POST",
      headers: botHeaders,
      body: "{}",
    });
    const r2 = await call("/session", {
      method: "POST",
      headers: botHeaders,
      body: "{}",
    });
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
