import { expect, test } from "bun:test";
import {
  type CorsairIntegration,
  corsairIntegrationIconUrl,
  corsairIntegrationsQueryOptions,
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
  icon: "svg",
  credentialConfigured: false,
  oauthClientConfigured: false,
  validationSkipped: true,
  connected: false,
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
  const apps = [
    entry({ id: "googlecalendar", displayName: "Google Calendar" }),
  ];
  expect(directoryApps(apps, "google calendar", false).shown).toHaveLength(1);
  expect(directoryApps(apps, "googlecalendar", false).shown).toHaveLength(1);
});

test("the integrations read unwraps the envelope and hides on a missing catalog", async () => {
  const original = globalThis.fetch;
  const respond = (status: number, body?: unknown) => {
    const reply = async () =>
      body === undefined
        ? new Response(null, { status })
        : Response.json(body, { status });
    globalThis.fetch = reply as unknown as typeof fetch;
  };
  const options = corsairIntegrationsQueryOptions();
  const run = () =>
    options.queryFn?.({
      signal: new AbortController().signal,
    } as Parameters<NonNullable<typeof options.queryFn>>[0]);

  try {
    respond(404);
    expect(await run()).toBeNull();

    respond(200, {
      catalogVersion: 2,
      total: 1,
      integrations: [entry({})],
    });
    const loaded = await run();
    expect(loaded?.[0]?.displayName).toBe("Notion");
    expect(loaded?.[0]?.connected).toBe(false);

    respond(500);
    await expect(run()).rejects.toThrow("Couldn't load the app directory.");
  } finally {
    globalThis.fetch = original;
  }
});

test("an app's icon URL follows the format the catalog names", () => {
  expect(corsairIntegrationIconUrl({ id: "notion", icon: "svg" })).toBe(
    "/corsair-icons/notion.svg",
  );
  expect(corsairIntegrationIconUrl({ id: "linear", icon: "png" })).toBe(
    "/corsair-icons/linear.png",
  );
  expect(corsairIntegrationIconUrl({ id: "anything", icon: null })).toBeNull();
});
