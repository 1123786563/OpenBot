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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxEnv } from "./env";
import type { BotRuntimes } from "./bot-runtimes";
import { readWebappFile, startWebapp, stopWebapp } from "./webapp";
import { createSnapshot, restoreArchive } from "./snapshot";
import { isPlainBotId } from "./bot-id";
import { forwardEvents } from "./sse";
import { bridgeWebSocket } from "./ws-passthrough";

export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const got = Buffer.from(presented);
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The paths a caller may reach, fixed once to the whole surface the workshop plan needs (§8 #8:
 * one extension, not one per task). Endpoints whose implementation lands later answer 501 from
 * the stub table below — present in the allow-list, honestly unimplemented on the wire.
 */
const ALLOWED = new Set([
  "POST /session",
  "GET /session/:id",
  "GET /session/:id/message",
  "POST /session/:id/message",
  "GET /file",
  "GET /file/content",
  "POST /workspace/reset",
  // The workshop plan's additions, frozen here in one change:
  "GET /events",
  "POST /session/:id/abort",
  "POST /file",
  // Not yet implemented — allowed, and answered 501 until their tasks land:
  "POST /devserver/start",
  "POST /devserver/stop",
  // The static webapp road (S3): a different door from the dev server — built files, no process.
  "POST /webapp/start",
  "POST /webapp/stop",
  "GET /webapp/file",
  "GET /runtimes",
  // The WS passthrough (B15b): the dev road's live half, gated like every other verb.
  "GET /preview/ws",
  "GET /workspace/snapshot",
  "POST /workspace/restore",
]);

/**
 * Empty as of S4: every allow-listed verb is implemented. The table stays — one honest 501
 * is still the right answer for a verb that is allowed but not yet real, and the shape that
 * carried this surface's honesty for fifteen waves should not lose its home when it is
 * briefly empty.
 */
const NOT_YET_IMPLEMENTED = new Set<string>([]);

function allowedPath(method: string, pathname: string): boolean {
  if (ALLOWED.has(`${method} ${pathname}`)) return true;
  // The shape-routed entries: /session/:id(/message|/abort) with one non-empty id segment.
  if (!pathname.startsWith("/session/")) return false;
  const segments = pathname.slice("/session/".length).split("/");
  if (segments.length === 1) return segments[0]?.length > 0 && method === "GET";
  if (segments.length === 2)
    return (
      segments[0]?.length > 0 &&
      ((segments[1] === "message" && (method === "GET" || method === "POST")) ||
        (segments[1] === "abort" && method === "POST"))
    );
  return false;
}

/** The exact key a path would be allowed under, for the 501 stub lookup. */
function allowedKey(method: string, pathname: string): string | null {
  if (ALLOWED.has(`${method} ${pathname}`)) return `${method} ${pathname}`;
  if (pathname.startsWith("/session/") && pathname.endsWith("/abort"))
    return "POST /session/:id/abort";
  if (pathname.startsWith("/session/") && pathname.endsWith("/message"))
    return `${method} /session/:id/message`;
  return null;
}

const upstreamBase = (port: number) => `http://127.0.0.1:${port}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createProxyHandler(
  env: SandboxEnv,
  runtimes: BotRuntimes,
): (
  request: Request,
  bunServer?: { upgrade(request: Request, options?: { data?: unknown }): boolean },
) => Promise<Response> {
  return async (request: Request, bunServer): Promise<Response> => {
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

    // Allowed but awaiting its task: honest 501, never a silent 404 that would read as a typo.
    const stubKey = allowedKey(request.method, url.pathname);
    if (stubKey && NOT_YET_IMPLEMENTED.has(stubKey)) {
      return Response.json(
        { error: `${stubKey} is not implemented yet.` },
        { status: 501 },
      );
    }

    // The operator's roster: this proxy's own runtimes, their liveness and their churn. Not a
    // proxied call — the answer IS this process. It sits after the bot-id gate (a roster ask
    // still names a Bot today, like every other call through this proxy) and before the
    // per-bot resolution, which it does not need.
    if (request.method === "GET" && url.pathname === "/runtimes") {
      return Response.json({ bots: runtimes.listRuntimes() });
    }

    // The WS passthrough (B15b): only for a Bot whose dev server is up, and only through
    // Bun's own upgrade — the pipe never opens for a caller that failed either gate above.
    if (url.pathname === "/preview/ws") {
      if (request.method !== "GET")
        return Response.json({ error: "Use GET." }, { status: 405 });
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return Response.json(
          { error: "This endpoint is a websocket upgrade." },
          { status: 426 },
        );
      }
      const devTarget = runtimes.listDevServers().find((entry) => entry.botId === botId);
      if (!devTarget) {
        return Response.json(
          { error: "This Bot's dev server is not running." },
          { status: 503 },
        );
      }
      if (!bunServer) {
        // A caller without the runtime's upgrade hook (tests, odd deployments): honest 501,
        // never a half-open pipe.
        return Response.json(
          { error: "This deployment cannot upgrade websockets." },
          { status: 501 },
        );
      }
      const subprotocol =
        request.headers.get("sec-websocket-protocol") ?? null;
      const path = url.searchParams.get("path") ?? "/";
      const upgraded = bunServer.upgrade(request, {
        data: { botId, port: devTarget.port, subprotocol, path },
      });
      if (upgraded) return new Response(null, { status: 101 });
      return Response.json(
        { error: "The upgrade was refused." },
        { status: 500 },
      );
    }

    // The dev server verbs (S8): a Bot's live webapp, started lazily in its workspace. The
    // cap is a refusal with a reason, never a queue; the WS passthrough to the started port
    // is B15's batch, so this batch answers the lifecycle over HTTP only.
    if (url.pathname === "/devserver/start" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        dir?: unknown;
        command?: unknown;
      };
      const dir = typeof body.dir === "string" && body.dir.trim() ? body.dir.trim() : "";
      if (!dir)
        return Response.json({ error: "dir is a required string." }, { status: 400 });
      if (typeof body.command === "string" && !body.command.trim() && body.command !== "")
        return Response.json({ error: "command must be a non-empty string." }, { status: 400 });
      const started = await runtimes.startDevServer({
        botId,
        dir,
        ...(typeof body.command === "string" && body.command.trim()
          ? { command: body.command }
          : {}),
      });
      if (!started.ok) {
        if (started.reason === "outside-workspace") {
          return Response.json(
            {
              error: `The dev server directory must stay inside the Bot's workspace (got ${started.dir}).`,
              reason: started.reason,
            },
            { status: 400 },
          );
        }
        return Response.json(
          {
            error: `The dev server cap is reached (${started.running}/${started.max}); stop one before starting another.`,
            reason: started.reason,
          },
          { status: 503 },
        );
      }
      return Response.json({ port: started.port, command: started.command });
    }
    if (url.pathname === "/devserver/stop" && request.method === "POST") {
      await runtimes.stopDevServer(botId);
      return Response.json({ ok: true, botId });
    }

    // POST /file (B5's writeFile verb): the PROXY writes the file, contained. There is no
    // upstream verb for this — forwarding it answers the SPA's 200-from-nothing, which a
    // caller reads as success while nothing lands (the isolation smoke caught exactly this).
    if (url.pathname === "/file" && request.method === "POST") {
      const path = url.searchParams.get("path") ?? "";
      if (!path || path.startsWith("/") || path.split("/").includes("..")) {
        return Response.json(
          { error: "The path must be a plain relative path inside the workspace." },
          { status: 400 },
        );
      }
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength > env.maxResponseBytes) {
        return Response.json({ error: "The file is too large." }, { status: 413 });
      }
      const target = join(env.workspaceDir, "bots", botId, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, body);
      return Response.json({ path, size: body.byteLength }, { status: 201 });
    }

    // The static webapp road (S3): files that were built, no process. Start verifies the
    // build exists (404-shaped refusal); GET serves one file under containment.
    if (url.pathname === "/webapp/start" && request.method === "POST") {
      const started = await startWebapp({ workspaceRoot: env.workspaceDir + "/bots" }, botId);
      if (!started.ok) {
        return Response.json(
          { error: "No webapp build found for this Bot.", reason: started.reason },
          { status: 404 },
        );
      }
      return Response.json({ ok: true, root: started.root });
    }
    if (url.pathname === "/webapp/stop" && request.method === "POST") {
      return Response.json(await stopWebapp());
    }
    if (url.pathname === "/webapp/file" && request.method === "GET") {
      const path = url.searchParams.get("path") ?? "";
      const file = await readWebappFile(
        { workspaceRoot: env.workspaceDir + "/bots" },
        botId,
        path,
      );
      if (!file) return Response.json({ error: "Not found." }, { status: 404 });
      return new Response(file.bytes as BodyInit, {
        status: 200,
        headers: { "content-type": file.contentType },
      });
    }

    // The snapshot pair (S4): the workspace as one stream, and its restore. A restore is
    // refused while the Bot holds a live turn — a workspace swapped under a running serve is
    // a serve whose memory lies about its files.
    if (url.pathname === "/workspace/snapshot" && request.method === "GET") {
      const archive = await createSnapshot({
        botWorkspace: `${env.workspaceDir}/bots/${botId}`,
        botId,
      });
      return new Response(archive as unknown as BodyInit, {
        status: 200,
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="${botId}-workspace.tar.gz"`,
        },
      });
    }
    if (url.pathname === "/workspace/restore" && request.method === "POST") {
      const busy = runtimes.listRuntimes().find((entry) => entry.botId === botId);
      if (busy?.streamCount && busy.streamCount > 0) {
        return Response.json(
          { error: "The Bot is mid-turn; restore after it settles." },
          { status: 409 },
        );
      }
      const archive = new Uint8Array(await request.arrayBuffer());
      await runtimes.stopBot(botId);
      const restored = await restoreArchive(
        archive,
        `${env.workspaceDir}/bots/${botId}`,
      );
      if (!restored.ok) {
        return Response.json(
          { error: "That archive is not a workspace snapshot.", reason: restored.reason },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, botId });
    }

    const runtime = await runtimes.getOrSpawn(botId);

    // The event stream is forwarded, not relayed: keepalives and the family filter are the
    // wrapper's own contribution (see ./sse.ts) — a plain byte-pipe would forward the noise
    // the capture measured at 15% of a real turn. Every forwarded block also refreshes the
    // Bot's activity clock, which is what keeps a mid-turn reap from killing a chatty stream.
    if (url.pathname === "/events") {
      if (request.method !== "GET")
        return Response.json({ error: "Use GET." }, { status: 405 });
      // The listener count is what splits the reaper's two endings: a quiet stream WITH this
      // listener is a stall; a quiet runtime WITHOUT any is just idle. Open before the stream
      // exists, close when it tears down — the count must not leak on either path.
      runtimes.noteStreamOpen(botId);
      try {
        const response = await forwardEvents({
          upstreamPort: runtime.port,
          onEvent: () => runtimes.markActivity(botId),
          onClose: () => runtimes.noteStreamClose(botId),
        });
        if (response.status !== 200) {
          runtimes.noteStreamClose(botId);
          return response;
        }
        return response;
      } catch {
        runtimes.noteStreamClose(botId);
        return Response.json(
          { error: "The bot's event stream is not available." },
          { status: 503 },
        );
      }
    }

    // Abort is forwarded verbatim: the upstream abort is opencode's own, and the wrapper adds
    // no semantics of its own beyond the token and the bot routing it just performed.
    if (url.pathname.endsWith("/abort")) {
      const response = await fetch(`${upstreamBase(runtime.port)}${url.pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => null);
      if (!response)
        return Response.json({ error: "The abort did not reach the runtime." }, { status: 503 });
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    }
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
