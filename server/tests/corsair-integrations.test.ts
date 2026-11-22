import { afterAll, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import {
  corsairCatalog,
  corsairIntegrations,
  findCorsairIntegration,
} from "../src/plugins/corsair/integrations";
import { createCorsairIntegrationsRoutes } from "../src/plugins/corsair/integrations-routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(() => database.$client.close());

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "corsair-pilot-admin",
    email: "corsair-pilot-admin@example.invalid",
    role: "admin",
  });
  await next();
};

const WORKSPACE = "corsair-integrations-test";

function app(environment: Record<string, string | undefined> = {}) {
  return new Hono<{ Variables: AppVariables }>().route(
    "/",
    createCorsairIntegrationsRoutes({
      requireUser,
      database,
      workspaceId: WORKSPACE,
      environment,
    }),
  );
}

test("the vendored upstream catalog is intact", () => {
  const catalog = corsairCatalog();
  expect(catalog.plugins.length).toBeGreaterThan(700);
  expect(new Set(catalog.plugins.map((p) => p.id)).size).toBe(
    catalog.plugins.length,
  );
  for (const known of ["github", "slack", "notion", "linear", "gmail"])
    expect(findCorsairIntegration(known)?.npmPackageName).toBe(
      `@corsair-dev/${known}`,
    );
});

test("every integration registers without any credentials", () => {
  const integrations = corsairIntegrations({});
  expect(integrations).toHaveLength(corsairCatalog().plugins.length);
  expect(integrations.every((i) => i.validationSkipped)).toBe(true);
  expect(integrations.every((i) => !i.credentialConfigured)).toBe(true);
  expect(integrations.every((i) => !i.oauthClientConfigured)).toBe(true);
});

test("provided credentials surface per integration without gating others", () => {
  const integrations = corsairIntegrations({
    CORSAIR_NOTION_API_KEY: "secret_ntn",
    CORSAIR_LINEAR_CLIENT_ID: "lin_client",
    CORSAIR_LINEAR_CLIENT_SECRET: "lin_secret",
  });
  const notion = integrations.find((i) => i.id === "notion");
  const linear = integrations.find((i) => i.id === "linear");
  const github = integrations.find((i) => i.id === "github");
  expect(notion?.credentialConfigured).toBe(true);
  expect(notion?.oauthClientConfigured).toBe(false);
  expect(linear?.credentialConfigured).toBe(false);
  expect(linear?.oauthClientConfigured).toBe(true);
  expect(github?.credentialConfigured).toBe(false);
});

test("the integrations list route serves the whole catalog", async () => {
  const response = await app().request("/?search=notion");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.total).toBe(corsairCatalog().plugins.length);
  expect(body.integrations.map((i: { id: string }) => i.id)).toContain(
    "notion",
  );
});

test("integration detail and unknown ids", async () => {
  const known = await app().request("/slack");
  expect(known.status).toBe(200);
  expect((await known.json()).npmPackageName).toBe("@corsair-dev/slack");
  expect((await app().request("/definitely-not-real")).status).toBe(404);
});

test("connect skips client credential validation and records the row once", async () => {
  // The account row's person references a user; seed the fixed pilot actor.
  await database
    .insert(users)
    .values({
      id: "corsair-pilot-admin",
      email: "corsair-pilot-admin@example.test",
    })
    .onConflictDoNothing();
  const routes = app();
  const withoutHeader = await routes.request("/linear/connect", {
    method: "POST",
  });
  expect(withoutHeader.status).toBe(403);
  const connected = await routes.request("/linear/connect", {
    method: "POST",
    headers: { "X-OpenBot-Pilot": "integrations" },
  });
  expect(connected.status).toBe(201);
  const body = await connected.json();
  expect(body.status).toBe("connected");
  expect(body.connected).toBe(true);
  expect(body.validationSkipped).toBe(true);
  expect(body.credentialConfigured).toBe(false);
  await routes.request("/linear/connect", {
    method: "POST",
    headers: { "X-OpenBot-Pilot": "integrations" },
  });
  const listed = await (await routes.request("/?search=linear")).json();
  expect(listed.integrations[0].connected).toBe(true);
  const other = await (await routes.request("/?search=notion")).json();
  expect(other.integrations[0].connected).toBe(false);
});
