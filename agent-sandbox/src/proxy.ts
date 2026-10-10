/**
 * The sandbox's only network surface: a token-gated, bot-scoped, path-allow-listed proxy in front
 * of one `opencode serve` per Bot.
 *
 * opencode serve has no authentication of its own, so the wrapper is the boundary, exactly as the
 * computer's token is its process boundary. Only the verbs the server's client actually uses pass
 * through; everything else is a 404, so a future opencode route cannot silently become reachable.
 *
 * Which serve a request reaches is decided by the `x-openbot-bot-id` header — the same id the
 * registry turns into a working directory — so a caller cannot reach a Bot other than the one it
 * names, and cannot reach any upstream at all without naming one.
 */
import { timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import type { SandboxEnv } from "./env";
import type { BotRuntimes } from "./bot-runtimes";
import { isPlainBotId } from "./bot-id";

export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const got = Buffer.from(presented);
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The paths a caller may reach. Anything else 404s without touching the upstream. */
const ALLOWED = new Set([
  "POST /session",
  "GET /session/:id",
  "GET /session/:id/message",
  "POST /session/:id/message",
  "GET /file",
  "GET /file/content",
  "POST /workspace/reset",
]);

function allowedPath(method: string, pathname: string): boolean {
  if (ALLOWED.has(`${method} ${pathname}`)) return true;
  // /session/:id and its message sub-path: one non-empty segment after /session, and at most one
  // further segment, which must be exactly "message". (Equivalent to the anchored pattern
  // ^/session/<id>(/message)?$ written as segment checks.)
  if (!pathname.startsWith("/session/")) return false;
  const segments = pathname.slice("/session/".length).split("/");
  if (segments.length === 1) return segments[0]?.length > 0 && method === "GET";
  if (segments.length === 2)
    return (
      segments[0]?.length > 0 &&
      segments[1] === "message" &&
      (method === "GET" || method === "POST")
    );
  return false;
}

const upstreamBase = (port: number) => `http://127.0.0.1:${port}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createProxyHandler(
  env: SandboxEnv,
  runtimes: BotRuntimes,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });

    const presented = request.headers.get("x-sandbox-token") ?? undefined;
    if (!tokenMatches(presented, env.token))
      return Response.json({ error: "The sandbox token is missing or wrong." }, { status: 401 });

    if (!allowedPath(request.method, url.pathname))
      return Response.json({ error: "No such sandbox route." }, { status: 404 });

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > env.maxResponseBytes)
      return Response.json({ error: "The request body is too large." }, { status: 413 });

    const botId = request.headers.get("x-openbot-bot-id")?.trim() ?? "";
    if (!isPlainBotId(botId))
      return Response.json({ error: "A valid x-openbot-bot-id header is required." }, { status: 400 });

    // reset 是治理动作：只允许显式端点，路径白名单之外照旧 404。
    if (url.pathname === "/workspace/reset") {
      if (request.method !== "POST")
        return Response.json({ error: "Use POST." }, { status: 405 });
      await runtimes.stopBot(botId);
      await rm(`${env.workspaceDir}/bots/${botId}`, { recursive: true, force: true });
      return Response.json({ ok: true, botId });
    }

    const runtime = await runtimes.getOrSpawn(botId);
    const headers = new Headers(request.headers);
    headers.delete("x-sandbox-token");
    headers.delete("host");
    headers.delete("content-length");
    const body = request.method === "GET" ? undefined : await request.arrayBuffer();

    // 探活重试：子进程可能刚被清扫或正在上线，最多等 15 秒。
    let response: Response | null = null;
    for (let attempt = 0; attempt < 30 && response === null; attempt++) {
      try {
        const probe = await fetch(`http://127.0.0.1:${runtime.port}/doc`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (!probe.ok) throw new Error("not ready");
        response = await fetch(`${upstreamBase(runtime.port)}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
        });
        if (response.status >= 502) {
          response = null;
          await sleep(500);
        }
      } catch {
        await sleep(500);
      }
    }
    if (response === null)
      return Response.json({ error: "The bot's sandbox runtime is not ready." }, { status: 503 });

    const upstreamLength = Number(response.headers.get("content-length") ?? "0");
    if (upstreamLength > env.maxResponseBytes)
      return Response.json({ error: "The sandbox response is too large." }, { status: 413 });
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}
