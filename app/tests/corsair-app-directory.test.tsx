import { expect, test } from "bun:test";
import {
  corsairIntegrationsQueryOptions,
  type CorsairIntegration,
} from "@/lib/connections/corsair";
import { directoryApps } from "@/routes/_authed/_app/connections.index";

const entry = (overrides: Partial<CorsairIntegration>): CorsairIntegration => ({
  id: "notion",
  displayName: "Notion",
  description: "Notes and documents.",
  npmPackageName: "@corsair-dev/notion",
  authTypes: ["api_key", "oauth_2"],
  defaultAuthType: "api_key",
  counts: { api: 14, webhooks: 3, db: 4 },
  credentialConfigured: false,
  oauthClientConfigured: false,
  validationSkipped: true,
  ...overrides,
});

test("the directory previews without a query and shows every match with one", () => {
  const apps = Array.from({ length: 30 }, (_, index) =>
    entry({ id: `app${index}`, displayName: `App ${index}` }),
  );
  const preview = directoryApps(apps, "", false);
  expect(preview.shown).toHaveLength(24);
  expect(preview.matching).toHaveLength(30);
  expect(directoryApps(apps, "", true).shown).toHaveLength(30);

  const searched = directoryApps(apps, "app 2", false);
  expect(searched.shown.map((app) => app.id)).toEqual([
    "app2",
    "app20",
    "app21",
    "app22",
    "app23",
    "app24",
    "app25",
    "app26",
    "app27",
    "app28",
    "app29",
  ]);
  expect(directoryApps(apps, "nothing like this", false).shown).toHaveLength(0);
});

test("the directory matches by id as well as by display name", () => {
  const apps = [entry({ id: "googlecalendar", displayName: "Google Calendar" })];
  expect(directoryApps(apps, "google calendar", false).shown).toHaveLength(1);
  expect(directoryApps(apps, "googlecalendar", false).shown).toHaveLength(1);
});

test("the integrations read unwraps the envelope and hides on a missing catalog", async () => {
  const original = globalThis.fetch;
  const respond = (status: number, body?: unknown) =>
    (globalThis.fetch = (async () =>
      body === undefined
        ? new Response(null, { status })
        : Response.json(body, { status })) as typeof fetch);
  const options = corsairIntegrationsQueryOptions();
  const context = { signal: new AbortController().signal };

  try {
    respond(404);
    expect(await options.queryFn(context)).toBeNull();

    respond(200, {
      catalogVersion: 2,
      total: 1,
      integrations: [entry({})],
    });
    const loaded = await options.queryFn(context);
    expect(loaded?.[0]?.displayName).toBe("Notion");

    respond(500);
    expect(options.queryFn(context)).rejects.toThrow(
      "Couldn't load the app directory.",
    );
  } finally {
    globalThis.fetch = original;
  }
});
