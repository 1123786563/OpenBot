import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { gatewayConfigs } from "../src/db/schema/gateway";
import {
  GATEWAY_CONFIG_TOPIC,
  parseGatewayEndpointInput,
  readGatewayEndpoint,
  saveGatewayEndpoint,
} from "../src/gateway/config-store";
import { createGatewayConfigRoutes } from "../src/gateway/routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket #207 (Bifrost 01.1) against a dedicated PostgreSQL (TEST_DATABASE_URL, never a fallback):
 * a saved endpoint survives store reconstruction, every successful save produces a strictly greater
 * configVersion, the readonly shape carries no secret, and the HTTP surface is administrator-only
 * for writes. Same seam production uses: the drizzle store, the transactional NOTIFY, the routes.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const ORIGIN = "https://bifrost.example.com";

beforeAll(async () => {
  await database.delete(gatewayConfigs);
});

afterAll(async () => {
  await database.delete(gatewayConfigs);
  await database.$client.end({ timeout: 5 });
});

function endpointInput(baseUrl: string, requestTimeoutMs: number) {
  const parsed = parseGatewayEndpointInput({ baseUrl, requestTimeoutMs });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("gateway endpoint persistence", () => {
  test("each successful save produces a strictly greater configVersion, and re-saving an older-looking value cannot write a version back", async () => {
    const saved1 = await saveGatewayEndpoint(
      database,
      endpointInput(ORIGIN, 10_000),
      "admin@openbot.test",
    );
    expect(saved1).toEqual({
      baseUrl: ORIGIN,
      requestTimeoutMs: 10_000,
      configVersion: 1,
    });

    const saved2 = await saveGatewayEndpoint(
      database,
      endpointInput(ORIGIN, 10_000),
      "admin@openbot.test",
    );
    expect(saved2.configVersion).toBeGreaterThan(saved1.configVersion);

    // The input carries no version, so the only thing a save can do is move forward: re-saving the
    // very values of version 1 still lands on a version strictly greater than 2.
    const saved3 = await saveGatewayEndpoint(
      database,
      endpointInput(ORIGIN, 10_000),
      "admin@openbot.test",
    );
    expect(saved3.configVersion).toBeGreaterThan(saved2.configVersion);

    const read = await readGatewayEndpoint(database);
    expect(read).toEqual(saved3);
  });

  test("a reconstructed store (restart) reads the same endpoint and version", async () => {
    const before = await readGatewayEndpoint(database);
    expect(before).toBeDefined();

    const restarted = createDatabase(testDatabaseUrl(), { max: 1 });
    try {
      const after = await readGatewayEndpoint(restarted);
      expect(after).toEqual(before);
    } finally {
      await restarted.$client.end({ timeout: 5 });
    }
  });

  test("the readonly shape is exactly the non-sensitive triple, and the row carries no credential-like column", async () => {
    const read = await readGatewayEndpoint(database);
    expect(read).toBeDefined();
    expect(Object.keys(read!).sort()).toEqual([
      "baseUrl",
      "configVersion",
      "requestTimeoutMs",
    ]);
    expect(JSON.stringify(read!)).not.toMatch(
      /secret|token|password|credential|api[-_]?key/i,
    );

    const rows = await database.select().from(gatewayConfigs);
    expect(rows).toHaveLength(1);
    for (const column of Object.keys(rows[0])) {
      expect(column).not.toMatch(/secret|token|password|credential|key/i);
    }
    expect(rows[0].baseUrl).toBe(ORIGIN);
    expect(rows[0].configVersion).toBeGreaterThan(0);
  });

  test("a save announces the new version on the gateway topic", async () => {
    const listener = postgres(testDatabaseUrl(), { max: 1 });
    const received: string[] = [];
    const subscription = await listener.listen(GATEWAY_CONFIG_TOPIC, (payload) =>
      received.push(payload),
    );
    try {
      const saved = await saveGatewayEndpoint(
        database,
        endpointInput(ORIGIN, 10_000),
        "admin@openbot.test",
      );
      const deadline = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(received).toContain(String(saved.configVersion));
    } finally {
      await subscription.unlisten();
      await listener.end({ timeout: 5 });
    }
  });
});

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
    createGatewayConfigRoutes({ database, requireUser }),
  );
  return app;
}

const asAdmin = appFor({
  id: "gw-admin",
  email: "admin@openbot.test",
  role: "admin",
});
const asMember = appFor({
  id: "gw-member",
  email: "member@openbot.test",
  role: "user",
});

describe("gateway configuration HTTP surface", () => {
  test("an administrator saves, and the response is the readonly triple", async () => {
    const before = await readGatewayEndpoint(database);
    const response = await asAdmin.request("/api/admin/gateway/endpoint", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://bifrost-2.example.com",
        requestTimeoutMs: 4_000,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      gateway: {
        baseUrl: string;
        requestTimeoutMs: number;
        configVersion: number;
      };
    };
    expect(body.gateway).toEqual({
      baseUrl: "https://bifrost-2.example.com",
      requestTimeoutMs: 4_000,
      configVersion: (before?.configVersion ?? 0) + 1,
    });
    expect(await readGatewayEndpoint(database)).toEqual(body.gateway);
  });

  test("a non-administrator write is refused and changes nothing", async () => {
    const before = await readGatewayEndpoint(database);
    const response = await asMember.request("/api/admin/gateway/endpoint", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://attacker.example.com",
        requestTimeoutMs: 1_000,
      }),
    });
    expect(response.status).toBe(403);
    expect(await readGatewayEndpoint(database)).toEqual(before);
  });

  test("an illegal address is refused with an explainable reason", async () => {
    const before = await readGatewayEndpoint(database);
    const response = await asAdmin.request("/api/admin/gateway/endpoint", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://user:pw@bifrost.example.com",
        requestTimeoutMs: 1_000,
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Gateway base URL must not carry credentials.");
    expect(await readGatewayEndpoint(database)).toEqual(before);
  });

  test("a timeout above the largest integer the column can store is refused as 400, never a 500, and changes nothing", async () => {
    const before = await readGatewayEndpoint(database);
    const response = await asAdmin.request("/api/admin/gateway/endpoint", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: ORIGIN,
        requestTimeoutMs: 3_000_000_000,
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "requestTimeoutMs must be no greater than 2147483647, the largest value a PostgreSQL integer column can store.",
    );
    expect(await readGatewayEndpoint(database)).toEqual(before);
  });

  test("a signed-in non-administrator may read the readonly shape", async () => {
    const response = await asMember.request("/api/admin/gateway/endpoint");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { gateway: unknown };
    expect(JSON.stringify(body)).not.toMatch(
      /secret|token|password|credential|api[-_]?key/i,
    );
    expect(body.gateway).toEqual(await readGatewayEndpoint(database));
  });
});
