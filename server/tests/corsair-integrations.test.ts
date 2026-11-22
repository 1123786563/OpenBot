import { expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  corsairCatalog,
  corsairIntegrations,
  findCorsairIntegration,
} from "../src/plugins/corsair/integrations";
import { createCorsairIntegrationsRoutes } from "../src/plugins/corsair/integrations-routes";

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

function app(environment: Record<string, string | undefined> = {}) {
  return new Hono<{ Variables: AppVariables }>().route(
    "/",
    createCorsairIntegrationsRoutes({ requireUser, environment }),
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

test("connect skips client credential validation", async () => {
  const withoutHeader = await app().request("/linear/connect", {
    method: "POST",
  });
  expect(withoutHeader.status).toBe(403);
  const connected = await app().request("/linear/connect", {
    method: "POST",
    headers: { "X-OpenBot-Pilot": "integrations" },
  });
  expect(connected.status).toBe(201);
  const body = await connected.json();
  expect(body.status).toBe("connected");
  expect(body.validationSkipped).toBe(true);
  expect(body.credentialConfigured).toBe(false);
});
