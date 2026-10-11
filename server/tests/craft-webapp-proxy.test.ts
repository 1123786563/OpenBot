import { describe, expect, test } from "bun:test";
import { proxyWebappRequest, tarGzip } from "../src/craft/webapp-proxy";

describe("proxyWebappRequest", () => {
  test("streams the body with a dev-road CSP and strips hop-by-hop + credential headers", async () => {
    const seen: { headers: Headers | null } = { headers: null };
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.headers = new Headers(init.headers as Record<string, string>);
      return new Response("<html>hi</html>", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "content-encoding": "gzip",
          "content-length": "13",
          "set-cookie": "a=b",
          connection: "keep-alive",
        },
      });
    }) as typeof fetch;

    const result = await proxyWebappRequest({
      upstreamBaseUrl: "http://127.0.0.1:3010",
      path: "index.html",
      query: "",
      requestHeaders: new Headers({
        host: "example.com",
        connection: "keep-alive",
        cookie: "secret=1",
        authorization: "Bearer x",
        "x-forwarded-for": "1.2.3.4",
        accept: "text/html",
      }),
      fetchImpl,
    });

    expect(result.status).toBe(200);
    expect(result.headers.get("content-security-policy")).toBeTruthy();
    expect(result.headers.get("content-type")).toBe("text/html");
    // Response hop-by-hop + set-cookie stripped.
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(result.headers.get("content-encoding")).toBeNull();
    expect(result.headers.get("content-length")).toBeNull();
    // Request hop-by-hop, credentials, and forwarding context stripped; benign kept.
    expect(seen.headers?.get("host")).toBeNull();
    expect(seen.headers?.get("connection")).toBeNull();
    expect(seen.headers?.get("cookie")).toBeNull();
    expect(seen.headers?.get("authorization")).toBeNull();
    expect(seen.headers?.get("x-forwarded-for")).toBeNull();
    expect(seen.headers?.get("accept")).toBe("text/html");
  });

  test("a connection failure is a 502, not a pass-through", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await proxyWebappRequest({
      upstreamBaseUrl: "http://127.0.0.1:3010",
      path: "",
      query: "",
      requestHeaders: new Headers(),
      fetchImpl,
    });
    expect(result.status).toBe(502);
  });
});

describe("tarGzip", () => {
  test("emits a gzip stream (magic bytes)", () => {
    const bytes = new TextEncoder().encode("<html></html>");
    const buf = tarGzip([{ path: "index.html", bytes }]);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });
});
