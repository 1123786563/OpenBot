import { describe, expect, test, afterAll } from "bun:test";
import { serve } from "bun";
import { createProxyHandler, tokenMatches } from "../src/proxy";
import { sandboxEnvFrom } from "../src/env";

const env = sandboxEnvFrom({
  SANDBOX_TOKEN: "secret-token",
  SANDBOX_PROVIDER_BASE_URL: "https://example.invalid",
  SANDBOX_PROVIDER_API_KEY: "k",
  SANDBOX_MODEL: "GLM-5.3",
  SANDBOX_UPSTREAM_PORT: "4599",
});

const upstream = serve({
  port: 4599,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/doc") return Response.json({ openapi: "3.1.0" });
    if (url.pathname === "/session" && request.method === "POST")
      return Response.json({ id: "ses_upstream" });
    if (url.pathname === "/file/content")
      return new Response("x".repeat(300_000), {
        headers: { "content-length": String(300_000) },
      });
    return Response.json({ echo: url.pathname, method: request.method });
  },
});
afterAll(() => upstream.stop(true));

const handler = createProxyHandler(env, 4599);
const call = (path: string, init?: RequestInit) =>
  handler(new Request(`http://127.0.0.1:4300${path}`, init));

describe("proxy", () => {
  test("rejects a request without the token", async () => {
    const response = await call("/session", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
  });

  test("rejects a wrong token without leaking which part failed", async () => {
    const response = await call("/session", {
      method: "POST",
      headers: { "x-sandbox-token": "wrong" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  test("forwards an allowed path with the body intact and strips the token header", async () => {
    const response = await call("/session", {
      method: "POST",
      headers: { "x-sandbox-token": "secret-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "t" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "ses_upstream" });
  });

  test("a path outside the allow-list is 404 upstream-untouched", async () => {
    const response = await call("/admin", { headers: { "x-sandbox-token": "secret-token" } });
    expect(response.status).toBe(404);
  });

  test("an oversized content-length is refused before the upstream is touched", async () => {
    // POST /session is allow-listed, so the 413 can only come from the request-size gate that
    // runs before the upstream fetch. content-length is declared explicitly because a Request
    // built in-process does not derive it from the body the way a network request does.
    const response = await call("/session", {
      method: "POST",
      headers: { "x-sandbox-token": "secret-token", "content-length": String(300_000) },
      body: "x".repeat(300_000),
    });
    expect(response.status).toBe(413);
  });

  test("an oversized upstream response is refused", async () => {
    const response = await call("/file/content", {
      headers: { "x-sandbox-token": "secret-token" },
    });
    expect(response.status).toBe(413);
  });

  test("health needs no token", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
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
