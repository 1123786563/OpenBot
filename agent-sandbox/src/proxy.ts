/**
 * The sandbox's only network surface: a token-gated, path-allow-listed proxy in front of
 * `opencode serve`.
 *
 * opencode serve has no authentication of its own, so the wrapper is the boundary, exactly as the
 * computer's token is its process boundary. Only the verbs the server's client actually uses pass
 * through; everything else is a 404, so a future opencode route cannot silently become reachable.
 */
import { timingSafeEqual } from "node:crypto";
import type { SandboxEnv } from "./env";

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

export function createProxyHandler(
  env: SandboxEnv,
  upstreamPort: number,
): (request: Request) => Promise<Response> {
  const upstream = `http://127.0.0.1:${upstreamPort}`;

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

    const headers = new Headers(request.headers);
    headers.delete("x-sandbox-token");
    headers.delete("host");
    headers.delete("content-length");
    const body = request.method === "GET" ? undefined : await request.arrayBuffer();
    const response = await fetch(`${upstream}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
    });

    const upstreamLength = Number(response.headers.get("content-length") ?? "0");
    if (upstreamLength > env.maxResponseBytes)
      return Response.json({ error: "The sandbox response is too large." }, { status: 413 });

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  };
}
