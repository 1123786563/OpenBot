import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import type { Database } from "../src/db/client";
import { parseGatewayEndpointInput } from "../src/gateway/config-store";
import { createGatewayConfigRoutes } from "../src/gateway/routes";

/*
 * Ticket #207 (Bifrost 01.1): the gateway address and connection parameters, rejected at the same
 * three boundaries that will refuse them everywhere — the pure parse the admin save path uses, the
 * start-up environment, and the HTTP surface (administrator-only writes). Persistence against a
 * real PostgreSQL is gateway-endpoint-config.integration.test.ts.
 */

const ORIGIN = "https://bifrost.example.com";

describe("parseGatewayEndpointInput", () => {
  test("accepts a bare https origin, and an origin with a port", () => {
    expect(
      parseGatewayEndpointInput({ baseUrl: ORIGIN, requestTimeoutMs: 10_000 }),
    ).toEqual({
      ok: true,
      value: { baseUrl: ORIGIN, requestTimeoutMs: 10_000 },
    });
    expect(
      parseGatewayEndpointInput({
        baseUrl: "http://bifrost.internal:8080",
        requestTimeoutMs: 5_000,
      }),
    ).toEqual({
      ok: true,
      value: { baseUrl: "http://bifrost.internal:8080", requestTimeoutMs: 5_000 },
    });
  });

  test("rejects an empty or blank base URL", () => {
    for (const baseUrl of ["", "   "]) {
      expect(
        parseGatewayEndpointInput({ baseUrl, requestTimeoutMs: 10_000 }),
      ).toEqual({ ok: false, error: "Gateway base URL is required." });
    }
  });

  test("rejects a non-URL and a non-http(s) URL", () => {
    for (const baseUrl of ["not a url", "ftp://bifrost.example.com"]) {
      expect(
        parseGatewayEndpointInput({ baseUrl, requestTimeoutMs: 10_000 }),
      ).toEqual({
        ok: false,
        error: "Gateway base URL must be an http or https URL.",
      });
    }
  });

  test("rejects credentials carried in the URL", () => {
    expect(
      parseGatewayEndpointInput({
        baseUrl: "https://user:pw@bifrost.example.com",
        requestTimeoutMs: 10_000,
      }),
    ).toEqual({
      ok: false,
      error: "Gateway base URL must not carry credentials.",
    });
  });

  test("rejects a path, query or fragment", () => {
    for (const baseUrl of [
      `${ORIGIN}/v1`,
      `${ORIGIN}?a=1`,
      `${ORIGIN}#frag`,
    ]) {
      expect(
        parseGatewayEndpointInput({ baseUrl, requestTimeoutMs: 10_000 }),
      ).toEqual({
        ok: false,
        error:
          "Gateway base URL must be the origin only, without a path, query or fragment.",
      });
    }
  });

  test("rejects a missing, non-integer or non-positive timeout", () => {
    for (const requestTimeoutMs of [undefined, 0, -1, 2.5]) {
      expect(
        parseGatewayEndpointInput({
          baseUrl: ORIGIN,
          ...(requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs }),
        }),
      ).toEqual({
        ok: false,
        error:
          "requestTimeoutMs must be a whole number of milliseconds greater than zero.",
      });
    }
  });
});

/*
 * The same base environment billing-config.test.ts uses, so a failure on anything besides
 * GATEWAY_* is a case about the base and gets fixed there.
 */
const baseEnvironment = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3001",
  INITIAL_ADMIN_EMAILS: "admin@openbot.test",
  INTELLIGENCE_API_URL: "http://localhost:7100",
  INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
  INTELLIGENCE_API_KEY: "tenant-api-key",
  COPILOTKIT_LICENSE_TOKEN: "license-token",
  MANAGED_AGENT_AG_UI_URL: " http://localhost:4200/ag-ui ",
  MANAGED_AGENT_TOKEN: "managed-agent-token",
};

describe("gateway environment configuration", () => {
  test("no GATEWAY_* variables means no gateway block", () => {
    expect(loadConfig(baseEnvironment).gateway).toBeUndefined();
  });

  test("a legal origin configures the gateway, with the 10s default timeout", () => {
    expect(
      loadConfig({ ...baseEnvironment, GATEWAY_BASE_URL: ORIGIN }).gateway,
    ).toEqual({ baseUrl: ORIGIN, requestTimeoutMs: 10_000 });
    expect(
      loadConfig({
        ...baseEnvironment,
        GATEWAY_BASE_URL: ORIGIN,
        GATEWAY_REQUEST_TIMEOUT_MS: "2500",
      }).gateway,
    ).toEqual({ baseUrl: ORIGIN, requestTimeoutMs: 2_500 });
  });

  test("a timeout without an origin stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GATEWAY_REQUEST_TIMEOUT_MS: "2500",
      }),
    ).toThrow(
      /GATEWAY_REQUEST_TIMEOUT_MS is set without GATEWAY_BASE_URL/,
    );
  });

  test("an illegal origin stops the server with the shared reason", () => {
    for (const [GATEWAY_BASE_URL, reason] of [
      // An empty GATEWAY_BASE_URL is an unset one, by the same `optional` rule LAGO_* follows; the
      // empty string itself is refused by the parse tests above, where an administrator sends it.
      ["ftp://bifrost.example.com", /must be an http or https URL/],
      ["https://user:pw@bifrost.example.com", /must not carry credentials/],
      [`${ORIGIN}/v1`, /origin only, without a path, query or fragment/],
    ] as const) {
      expect(() =>
        loadConfig({ ...baseEnvironment, GATEWAY_BASE_URL }),
      ).toThrow(reason);
    }
  });

  test("an illegal timeout stops the server", () => {
    for (const GATEWAY_REQUEST_TIMEOUT_MS of ["0", "-1", "2.5", "soon"]) {
      expect(() =>
        loadConfig({
          ...baseEnvironment,
          GATEWAY_BASE_URL: ORIGIN,
          GATEWAY_REQUEST_TIMEOUT_MS,
        }),
      ).toThrow(
        /GATEWAY_REQUEST_TIMEOUT_MS must be a whole number of milliseconds greater than zero/,
      );
    }
  });
});

/** A database that fails the test the moment anything reads from it. */
function untouchableDatabase(): Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("the gateway routes touched the database");
      },
    },
  ) as unknown as Database;
}

function appFor(
  actor: { id: string; email: string; role: "admin" | "user" },
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const requireUser = async (
    context: Parameters<Parameters<typeof app.use>[1]>[0],
    next: () => Promise<void>,
  ) => {
    context.set("actor", actor);
    await next();
  };
  app.route(
    "/api/admin/gateway",
    createGatewayConfigRoutes({
      database: untouchableDatabase(),
      requireUser,
    }),
  );
  return app;
}

const admin = appFor({
  id: "gw-admin",
  email: "admin@openbot.test",
  role: "admin",
});
const member = appFor({
  id: "gw-member",
  email: "member@openbot.test",
  role: "user",
});

describe("gateway configuration routes", () => {
  test("a non-administrator cannot save, and nothing reaches the database", async () => {
    const response = await member.request("/api/admin/gateway/endpoint", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: ORIGIN, requestTimeoutMs: 10_000 }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Administrator access required.",
    });
  });

  test("an administrator's illegal address is refused with the reason, before any write", async () => {
    for (const baseUrl of ["", "ftp://x", "https://u:p@x", `${ORIGIN}/v1`]) {
      const response = await admin.request("/api/admin/gateway/endpoint", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl, requestTimeoutMs: 10_000 }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    }
  });
});
