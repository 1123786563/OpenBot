import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  adminKeyFingerprint,
  type GatewayAdminCredentialRead,
  type GatewayAdminCredentialService,
  type GatewayAdminCredentialStatus,
  GatewayAdminCredentialNotConfiguredError,
  GatewayAdminCredentialStaleError,
  gatewayAdminCredentialRefFromStored,
  validateGatewayAdminCredentialInput,
} from "../src/gateway/admin-credential";
import { gatewayAdminCredentialRoutes } from "../src/gateway/admin-credential-routes";

/**
 * Bifrost 01.2 (#208): the write-only semantics of the gateway admin credential, at the seams that
 * need no database. The key's only way out of the server is {@link resolveGatewayAdminCredential}
 * into trusted server-side code — everything an administrator can reach is a redacted status, and
 * the refusals carry reasons, never key material.
 */

const KEY = "bifrost-admin-key-7f3a9c2e1d";

test("a legal admin key validates and is trimmed", () => {
  const result = validateGatewayAdminCredentialInput({
    adminKey: `  ${KEY}  `,
  });
  expect(result).toEqual({ ok: true, adminKey: KEY });
});

test("input that is not a single adminKey field is refused, naming the reason", () => {
  expect(validateGatewayAdminCredentialInput(null).ok).toBe(false);
  expect(validateGatewayAdminCredentialInput("sk-123").ok).toBe(false);
  expect(validateGatewayAdminCredentialInput([]).ok).toBe(false);
  expect(validateGatewayAdminCredentialInput({}).ok).toBe(false);
  expect(validateGatewayAdminCredentialInput({ adminKey: "" }).ok).toBe(false);
  expect(validateGatewayAdminCredentialInput({ adminKey: "   " }).ok).toBe(
    false,
  );
  expect(validateGatewayAdminCredentialInput({ adminKey: 42 }).ok).toBe(false);

  const unknown = validateGatewayAdminCredentialInput({
    adminKey: KEY,
    plaintext: KEY,
  });
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.error).toContain("plaintext");

  const long = validateGatewayAdminCredentialInput({
    adminKey: "k".repeat(4097),
  });
  expect(long.ok).toBe(false);
});

test("the fingerprint is the last four hex digits of sha-256 over the key", async () => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(KEY),
  );
  const expected = Buffer.from(digest).toString("hex").slice(-4);
  expect(adminKeyFingerprint(KEY)).toBe(expected);
  expect(adminKeyFingerprint(KEY)).toMatch(/^[0-9a-f]{4}$/);
  expect(adminKeyFingerprint(KEY)).not.toBe(adminKeyFingerprint(`${KEY}x`));
});

test("a stored reference row is read strictly: broken shapes are not references", () => {
  const valid = {
    credentialId: "0b5b0ld5-0000-4000-8000-000000000001",
    configVersion: 3,
    fingerprint: "beef",
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
  expect(gatewayAdminCredentialRefFromStored(valid)).toEqual({
    ref: { credentialId: valid.credentialId, configVersion: 3 },
    fingerprint: "beef",
    updatedAt: valid.updatedAt,
  });

  expect(gatewayAdminCredentialRefFromStored(undefined)).toBeUndefined();
  expect(gatewayAdminCredentialRefFromStored(null)).toBeUndefined();
  expect(gatewayAdminCredentialRefFromStored("row")).toBeUndefined();
  expect(
    gatewayAdminCredentialRefFromStored({ ...valid, configVersion: 0 }),
  ).toBeUndefined();
  expect(
    gatewayAdminCredentialRefFromStored({ ...valid, configVersion: 2.5 }),
  ).toBeUndefined();
  expect(
    gatewayAdminCredentialRefFromStored({ ...valid, configVersion: "3" }),
  ).toBeUndefined();
  expect(
    gatewayAdminCredentialRefFromStored({ ...valid, credentialId: "" }),
  ).toBeUndefined();
  expect(
    gatewayAdminCredentialRefFromStored({
      ...valid,
      fingerprint: "beef",
      updatedAt: undefined,
    }),
  ).toBeUndefined();
});

test("the two refusal classes are distinct and both are errors", () => {
  const notConfigured = new GatewayAdminCredentialNotConfiguredError(
    "The gateway admin credential is not configured.",
  );
  const stale = new GatewayAdminCredentialStaleError(
    "The gateway admin credential reference is stale.",
  );
  expect(notConfigured).toBeInstanceOf(Error);
  expect(stale).toBeInstanceOf(Error);
  expect(notConfigured.name).toBe("GatewayAdminCredentialNotConfiguredError");
  expect(stale.name).toBe("GatewayAdminCredentialStaleError");
  expect(stale instanceof GatewayAdminCredentialNotConfiguredError).toBe(false);
});

/* ----------------------------- the HTTP surface ----------------------------- */

const ADMIN: MiddlewareHandler<{
  Variables: import("../src/auth/guards").AppVariables;
}> = async (context, next) => {
  context.set("actor", {
    id: "admin-person",
    email: "admin@example.com",
    role: "admin",
  } as never);
  await next();
};

const USER: MiddlewareHandler<{
  Variables: import("../src/auth/guards").AppVariables;
}> = async (context, next) => {
  context.set("actor", {
    id: "plain-person",
    email: "user@example.com",
    role: "user",
  } as never);
  await next();
};

const NOBODY: MiddlewareHandler<import("../src/auth/guards").AppVariables> = (
  context,
) => context.json({ error: "Authentication required." }, 401);

const configuredStatus: GatewayAdminCredentialStatus = {
  state: "configured",
  configVersion: 2,
  fingerprint: "beef",
  updatedAt: "2026-10-16T00:00:00.000Z",
};

function fixture(
  requireUser: MiddlewareHandler<
    import("../src/auth/guards").AppVariables
  > = ADMIN,
) {
  const calls: { save: unknown[]; resolve: unknown[] } = {
    save: [],
    resolve: [],
  };
  let read: GatewayAdminCredentialRead = { state: "unconfigured" };
  const service: GatewayAdminCredentialService = {
    saveGatewayAdminCredential: async (input) => {
      calls.save.push(input);
      return { ok: true, status: configuredStatus };
    },
    readGatewayAdminCredential: async () => read,
    resolveGatewayAdminCredential: async (ref) => {
      calls.resolve.push(ref);
      return { adminKey: KEY, ref: { credentialId: "c", configVersion: 2 } };
    },
  };
  const app = new Hono().route(
    "/",
    gatewayAdminCredentialRoutes(requireUser, service),
  );
  return {
    app,
    calls,
    service,
    setRead: (value: GatewayAdminCredentialRead) => {
      read = value;
    },
  };
}

test("an administrator reads a redacted status and never key material", async () => {
  const { app, setRead } = fixture();
  setRead(configuredStatus);
  const response = await app.request("/", { method: "GET" });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ status: configuredStatus });
  expect(body).not.toContain(KEY);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("an unconfigured gateway reads as unconfigured, not as a failure", async () => {
  const { app, setRead } = fixture();
  setRead({ state: "unconfigured" });
  const response = await app.request("/", { method: "GET" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: { state: "unconfigured" },
  });
});

test("a write returns only the redacted status", async () => {
  const { app, calls } = fixture();
  const response = await app.request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminKey: KEY }),
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ status: configuredStatus });
  expect(body).not.toContain(KEY);
  expect(calls.save).toEqual([{ adminKey: KEY }]);
});

test("an invalid write is a 400 and never reaches the service", async () => {
  const { app, calls } = fixture();
  for (const body of [
    "{}",
    "not-json",
    JSON.stringify({ adminKey: "" }),
    JSON.stringify({ adminKey: KEY, extra: 1 }),
  ]) {
    const response = await app.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(400);
  }
  expect(calls.save).toEqual([]);
});

test("a plain user is refused on both the write and the read", async () => {
  const { app } = fixture(USER);
  expect((await app.request("/", { method: "GET" })).status).toBe(403);
  expect(
    (
      await app.request("/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminKey: KEY }),
      })
    ).status,
  ).toBe(403);
});

test("an unauthenticated request never reaches the credential", async () => {
  const { app } = fixture(NOBODY);
  expect((await app.request("/", { method: "GET" })).status).toBe(401);
  expect(
    (
      await app.request("/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminKey: KEY }),
      })
    ).status,
  ).toBe(401);
});

test("without the service the surface answers a tagged 503", async () => {
  const app = new Hono().route(
    "/",
    gatewayAdminCredentialRoutes(ADMIN, undefined),
  );
  expect((await app.request("/", { method: "GET" })).status).toBe(503);
  expect(
    (
      await app.request("/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminKey: KEY }),
      })
    ).status,
  ).toBe(503);
});

test("a refused save (non-admin at the service) maps to its status", async () => {
  const service: GatewayAdminCredentialService = {
    saveGatewayAdminCredential: async () => ({
      ok: false,
      status: 403,
      error: "Only an administrator may change the gateway credential.",
    }),
    readGatewayAdminCredential: async () => ({ state: "unconfigured" }),
    resolveGatewayAdminCredential: async () => {
      throw new GatewayAdminCredentialNotConfiguredError("not configured");
    },
  };
  const app = new Hono().route(
    "/",
    gatewayAdminCredentialRoutes(ADMIN, service),
  );
  const response = await app.request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminKey: KEY }),
  });
  expect(response.status).toBe(403);
  expect(((await response.json()) as { error: string }).error).not.toContain(
    KEY,
  );
});

test("the resolve entry is not exposed over HTTP by any route", async () => {
  const { app, calls } = fixture();
  for (const [method, path] of [
    ["GET", "/resolve"],
    ["POST", "/resolve"],
    ["POST", "/"],
  ] as const) {
    const response = await app.request(path, { method });
    expect(response.status).toBe(404);
  }
  expect(calls.resolve).toEqual([]);
});
