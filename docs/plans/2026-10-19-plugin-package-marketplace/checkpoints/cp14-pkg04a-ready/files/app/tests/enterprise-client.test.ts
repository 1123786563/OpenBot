import "./preload";
import { afterEach, expect, test } from "../../tests/support/e2e-compat";
import { client, tryClient } from "../src/lib/client";

/**
 * What `client` does with a `tenantId`, per plan F02 step 6.
 *
 * THE PROPERTY, STATED ONCE. The tenant selector is the enterprise API's per-request scope, and
 * the client attaches it as the `x-openbot-tenant` header (read by the scope middleware at
 * server/src/enterprise/app.ts) — for same-origin enterprise paths and nothing else. Every case
 * below drives a REAL `client` call against a stubbed `fetch`, because the question is what the
 * transport actually put on the wire, and the stub records the init it was handed.
 *
 * THE REFUSAL ENVELOPES ARE THE TWO THIS DEPLOYMENT REALLY SENDS, read off their routes rather
 * than invented: the deployment APIs answer `{ error: "sentence" }` (the shape `client` has always
 * unwrapped), and the enterprise app's onError answers `{ error: { code, request_id, retryable,
 * summary } }` (server/src/enterprise/app.ts:110-120) — with `message` the field name plan §5.2
 * uses for the same slot. Both must reach the screen as a sentence.
 */

const realFetch = globalThis.fetch;

type Asked = {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
};

/** A fetch that records the request and answers `respond` — or 200 `{}` when none is given. */
function intercept(
  respond?: (asked: Asked) => Response | Promise<Response>,
): Asked[] {
  const asked: Asked[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    asked.push({ input, init });
    if (!respond) {
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    }
    return respond({ input, init });
  }) as unknown as typeof fetch;
  return asked;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The one selector header, read out of a captured init, however the runtime typed it. */
function selectorHeader(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return undefined;
  if (headers instanceof Headers) return headers.get("x-openbot-tenant") ?? undefined;
  return (headers as Record<string, string>)["x-openbot-tenant"];
}

test("a request without tenantId is byte-for-byte what client sent before", async () => {
  const asked = intercept();

  await client("/api/plugins/servers", "servers");
  await client("/api/me", { method: "POST", body: { key: "value" } });
  await tryClient("/api/capabilities");

  expect(asked.map((request) => request.input)).toEqual([
    "/api/plugins/servers",
    "/api/me",
    "/api/capabilities",
  ]);
  // GET without a body carried no headers object at all before, and still does.
  expect(asked[0]?.init?.headers).toBeUndefined();
  expect(asked[2]?.init?.headers).toBeUndefined();
  // A body is JSON and only JSON, exactly as before; no selector appears anywhere.
  expect(asked[1]?.init?.headers).toEqual({ "content-type": "application/json" });
  expect(selectorHeader(asked[1]?.init)).toBeUndefined();
  expect(JSON.parse(String(asked[1]?.init?.body))).toEqual({ key: "value" });
});

test("an enterprise request carries the tenant as the selection header", async () => {
  const asked = intercept();

  await client("/api/enterprise/v1/channels", { tenantId: "acme" });
  await client("/api/enterprise/v1/channels", {
    method: "POST",
    body: { botId: "bot-1" },
    tenantId: "acme",
  });

  expect(selectorHeader(asked[0]?.init)).toBe("acme");
  expect(selectorHeader(asked[1]?.init)).toBe("acme");
  // The GET gains exactly the selector; the POST keeps its JSON content type beside it.
  expect(asked[0]?.init?.headers).toEqual({ "x-openbot-tenant": "acme" });
  expect(asked[1]?.init?.headers).toEqual({
    "content-type": "application/json",
    "x-openbot-tenant": "acme",
  });
});

test("a selector is refused for every path that is not a same-origin enterprise one", async () => {
  const asked = intercept();

  // Another origin by scheme, even though its path names the enterprise API.
  await client("https://other.example/api/enterprise/v1/channels", {
    tenantId: "acme",
  });
  // Protocol-relative: the browser resolves the host against the page's scheme, so the host is
  // not ours and the header must not ride along.
  await client("//other.example/api/enterprise/v1/channels", {
    tenantId: "acme",
  });
  // A relative path on our own origin that simply is not the enterprise API.
  await client("/api/plugins/servers", { tenantId: "acme" });

  expect(selectorHeader(asked[0]?.init)).toBeUndefined();
  expect(selectorHeader(asked[1]?.init)).toBeUndefined();
  expect(selectorHeader(asked[2]?.init)).toBeUndefined();
  // And none of them grew a header object where none was due.
  expect(asked[0]?.init?.headers).toBeUndefined();
  expect(asked[1]?.init?.headers).toBeUndefined();
  expect(asked[2]?.init?.headers).toBeUndefined();
});

test("a plain-string error reaches the throw untouched, as every deployment API answers", async () => {
  intercept(() => jsonResponse(403, { error: "You cannot do that." }));

  await expect(
    client("/api/plugins/servers/linear", { fallback: "Could not remove it" }),
  ).rejects.toThrow("You cannot do that.");
});

test("the enterprise error object answers with its readable summary", async () => {
  // The shape the enterprise onError actually writes (app.ts:110-120).
  intercept(() =>
    jsonResponse(400, {
      error: {
        code: "TENANT_REQUIRED",
        request_id: "req-1",
        retryable: false,
        summary: "请求未获允许",
      },
    }),
  );
  await expect(
    client("/api/enterprise/v1/channels", { tenantId: "acme" }),
  ).rejects.toThrow("请求未获允许");

  // The field name plan §5.2 names for the same slot.
  intercept(() =>
    jsonResponse(403, {
      error: { code: "TENANT_FORBIDDEN", message: "Not a member", retryable: false },
    }),
  );
  await expect(
    client("/api/enterprise/v1/channels", { tenantId: "acme" }),
  ).rejects.toThrow("Not a member");
});

test("an error body with no readable sentence falls back to the caller's", async () => {
  intercept(() => new Response("gateway timeout", { status: 504 }));
  await expect(
    client("/api/anything", { fallback: "Could not load it" }),
  ).rejects.toThrow("Could not load it");

  intercept(() => jsonResponse(400, { error: { code: "REQUEST_BODY_INVALID" } }));
  await expect(
    client("/api/anything", { fallback: "Could not load it" }),
  ).rejects.toThrow("Could not load it");

  // No fallback either: the standing last sentence, as before this change.
  intercept(() => new Response("nope", { status: 500 }));
  await expect(client("/api/anything")).rejects.toThrow("That request failed.");
});

test("success still unwraps the envelope key, and a malformed one still refuses", async () => {
  intercept(() => jsonResponse(200, { items: [{ id: "one" }], nextCursor: null }));
  expect(await client<{ id: string }[]>("/api/somewhere", "items")).toEqual([
    { id: "one" },
  ]);

  intercept(() => new Response("[]", { headers: { "content-type": "application/json" } }));
  await expect(client("/api/somewhere", "items")).rejects.toThrow();
});

test("caller header names are normalized so transport facts cannot be duplicated", async () => {
  const asked = intercept();

  await client("/api/enterprise/plugin-packages", {
    method: "POST",
    tenantId: "acme",
    workspaceId: "team-1",
    headers: {
      "Content-Type": "text/plain",
      "X-Openbot-Tenant": "forged",
      "X-Custom": "kept",
    },
    body: { ok: true },
  });

  const headers = asked[0]?.init?.headers as Record<string, string>;
  // The transport's own facts own their slots; a case-variant caller key
  // collapses into the same header instead of appending a second one.
  expect(headers["content-type"]).toBe("application/json");
  expect(headers["x-openbot-tenant"]).toBe("acme");
  expect(headers["x-openbot-workspace"]).toBe("team-1");
  expect(headers["x-custom"]).toBe("kept");
  expect(
    Object.keys(headers).filter((name) => name === "content-type"),
  ).toHaveLength(1);
  expect(
    Object.keys(headers).filter((name) => name === "x-openbot-tenant"),
  ).toHaveLength(1);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
