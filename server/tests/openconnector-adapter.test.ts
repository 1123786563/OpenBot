import { afterEach, describe, expect, test } from "../../tests/support/e2e-compat";
import {
  buildOpenConnectorClient,
  createOpenConnectorClient,
} from "../src/plugins/openconnector-adapter";

function clientWith(dial: (path: string, init: { method: string; body?: unknown; headers: Record<string, string> }) => Promise<unknown>) {
  return buildOpenConnectorClient({
    dial: async (path, init) => ({
      ok: true,
      json: async () => dial(path, init),
    }),
  });
}

describe("the broker", () => {
  test("maps the published authTypes array onto broker connections, oauth2-only to unsupported", async () => {
    const client = clientWith(async (path) => {
      if (path === "/api/providers") {
        return [
          { service: "github", displayName: "GitHub", authTypes: ["api_key"], actions: [{ id: "github.get_current_user" }, { id: "github.create_issue" }] },
          { service: "hackernews", displayName: "Hacker News", authTypes: ["no_auth"], actions: [{ id: "hackernews.get_top_stories" }] },
          { service: "example-oauth", displayName: "Example", authTypes: ["oauth2"], actions: [{ id: "example.post" }] },
        ];
      }
      throw new Error(`unexpected ${path}`);
    });
    const apps = await client.broker.listApps();
    const bySlug = Object.fromEntries(apps.map((app) => [app.slug, app]));
    expect(bySlug.github.connection).toEqual({ kind: "fields", authScheme: "API_KEY" });
    expect(bySlug.github.name).toBe("GitHub");
    expect(bySlug.github.actionCount).toBe(2);
    expect(bySlug.hackernews.connection).toEqual({ kind: "no-auth" });
    expect(bySlug.hackernews.actionCount).toBe(1);
    expect(bySlug["example-oauth"].connection.kind).toBe("unsupported");
  });

  test("a provider publishing several auth types is driven by a fixed priority, not array order", async () => {
    const client = clientWith(async (path) => {
      if (path === "/api/providers") {
        return [
          { service: "airtable", displayName: "Airtable", authTypes: ["oauth2", "api_key"], actions: [] },
          { service: "swapped", displayName: "Swapped", authTypes: ["api_key", "oauth2"], actions: [] },
          { service: "custom-first", displayName: "Custom", authTypes: ["custom_credential", "oauth2"], actions: [] },
          { service: "keyed-anon", displayName: "Keyed", authTypes: ["api_key", "no_auth"], actions: [] },
        ];
      }
      throw new Error(`unexpected ${path}`);
    });
    const apps = await client.broker.listApps();
    const bySlug = Object.fromEntries(apps.map((app) => [app.slug, app]));
    expect(bySlug.airtable.connection).toEqual({ kind: "fields", authScheme: "API_KEY" });
    expect(bySlug.swapped.connection).toEqual({ kind: "fields", authScheme: "API_KEY" });
    expect(bySlug["custom-first"].connection).toEqual({ kind: "fields", authScheme: "CUSTOM_CREDENTIAL" });
    expect(bySlug["keyed-anon"].connection).toEqual({ kind: "fields", authScheme: "API_KEY" });
  });

  test("connectWithFields sends the alias as connectionName and values verbatim", async () => {
    // A neutral stand-in for whatever the person typed: the assertion below is that the VALUE
    // crosses this seam unchanged, which any distinct string proves as well as a key-shaped one.
    const typedByThePerson = "the-value-the-person-typed";
    const seen: unknown[] = [];
    const client = clientWith(async (path, init) => {
      if (path === "/api/connections/github" && init.method === "PUT") {
        seen.push(init.body);
        return { data: {} };
      }
      throw new Error(`unexpected ${path}`);
    });
    const answer = await client.broker.connectWithFields({
      account: { holder: "person", userId: "user-1", vendorUserId: "openbot-u-user-1-github" },
      toolkit: "github",
      authScheme: "API_KEY",
      values: { apiKey: typedByThePerson },
    });
    expect(answer.accountId).toBe("openbot-u-user-1-github");
    expect(seen[0]).toEqual({
      authType: "api_key",
      values: { apiKey: typedByThePerson },
      connectionName: "openbot-u-user-1-github",
    });
  });

  test("authorize refuses: consent apps are not offered, so this is never reachable", async () => {
    const client = clientWith(async () => { throw new Error("should not dial"); });
    await expect(
      client.broker.authorize({ account: { holder: "person", userId: "u", vendorUserId: "a" }, toolkit: "x", returnUrl: "https://openbot.test/settings" }),
    ).rejects.toThrow(/not offered/i);
  });

  test("ensureAuthConfig answers not-needed: key and custom apps have no config at the broker", async () => {
    const client = clientWith(async () => { throw new Error("should not dial"); });
    const outcome = await client.broker.ensureAuthConfig({
      toolkit: "github", name: "GitHub",
      connection: { kind: "fields", authScheme: "API_KEY" },
    });
    expect(outcome).toBe("not-needed");
  });

  test("revoke answers whether the connection was there", async () => {
    let deleted = 0;
    const client = clientWith(async (path, init) => {
      if (path.startsWith("/api/connections/") && init.method === "DELETE") {
        deleted += 1;
        return { data: {} };
      }
      throw new Error(`unexpected ${path}`);
    });
    const gone = await client.broker.revoke({
      account: { holder: "person", userId: "u", vendorUserId: "openbot-u-u-github" },
      toolkit: "github",
    });
    expect(gone).toBe(true);
    expect(deleted).toBe(1);
  });

  test("revoke answers false when the vendor reports the connection was never there", async () => {
    // Expressed as a wire stub rather than through `clientWith`, whose seam is the JSON body:
    // "not there" is a fact about the RESPONSE, so the stub owns ok and status directly.
    const client = buildOpenConnectorClient({
      dial: async () => ({
        ok: false,
        status: 404,
        json: async () => ({ success: false, message: "Connection not found." }),
      }),
    });
    const gone = await client.broker.revoke({
      account: { holder: "person", userId: "u", vendorUserId: "openbot-u-u-gone" },
      toolkit: "github",
    });
    expect(gone).toBe(false);
  });

  test("revokeAccount scans the admin list and deletes by the alias alone", async () => {
    const calls: { path: string; method: string }[] = [];
    const client = clientWith(async (path, init) => {
      calls.push({ path, method: init.method });
      if (path === "/api/connections" && init.method === "GET") {
        return { data: [
          { service: "github", connectionName: "openbot-u-u-github" },
          { service: "hackernews", connectionName: "openbot-u-u-hackernews" },
        ] };
      }
      if (
        path === "/api/connections/hackernews?connectionName=openbot-u-u-hackernews" &&
        init.method === "DELETE"
      ) {
        return { data: {} };
      }
      throw new Error(`unexpected ${path}`);
    });
    await client.broker.revokeAccount("openbot-u-u-hackernews");
    expect(calls).toEqual([
      { path: "/api/connections", method: "GET" },
      { path: "/api/connections/hackernews?connectionName=openbot-u-u-hackernews", method: "DELETE" },
    ]);
  });

  test("revokeAccount throws when nothing matches: an undo path may not report success", async () => {
    const client = clientWith(async (path, init) => {
      if (path === "/api/connections" && init.method === "GET") return { data: [] };
      throw new Error(`unexpected ${path}`);
    });
    await expect(client.broker.revokeAccount("openbot-u-nobody-github")).rejects.toThrow(/nothing was there/i);
  });

  test("connectionFields maps the provider's credential fields onto the form's shape", async () => {
    const client = clientWith(async (path) => {
      if (path === "/api/providers/github") {
        return { data: {
          service: "github",
          auth: [
            { type: "api_key", label: "Personal access token", description: "A GitHub token.", extraFields: [
              { key: "owner", label: "Owner", inputType: "text", required: false, secret: false },
            ] },
          ],
        } };
      }
      throw new Error(`unexpected ${path}`);
    });
    const fields = await client.broker.connectionFields({ toolkit: "github", authScheme: "API_KEY" });
    expect(fields).toEqual([
      { name: "apiKey", label: "Personal access token", help: "A GitHub token.", required: true, secret: true },
      { name: "owner", label: "Owner", help: "", required: false, secret: false },
    ]);
  });

  test("connectionFields refuses a field it cannot read rather than guessing a box for it", async () => {
    const client = clientWith(async (path) => {
      if (path === "/api/providers/github") {
        return { data: {
          service: "github",
          auth: [{ type: "api_key", extraFields: [{ key: "owner", label: "Owner", inputType: "text", required: "yes", secret: false }] }],
        } };
      }
      throw new Error(`unexpected ${path}`);
    });
    await expect(
      client.broker.connectionFields({ toolkit: "github", authScheme: "API_KEY" }),
    ).rejects.toThrow(/could not be read/i);
  });

  test("a non-JSON answer is a refusal, never a guess", async () => {
    const client = buildOpenConnectorClient({
      dial: async () => ({
        ok: true,
        json: async () => { throw new Error("not json"); },
      }),
    });
    await expect(client.broker.listApps()).rejects.toThrow(/could not be read/i);
  });
});

describe("the actions client", () => {
  test("execute reaches /v1/actions/<id> with the alias header and input body", async () => {
    const seen: { path: string; headers: Record<string, string>; body: unknown }[] = [];
    const client = clientWith(async (path, init) => {
      seen.push({ path, headers: init.headers, body: init.body });
      return { data: { login: "octocat" } };
    });
    await client.actions.execute({ service: "github", actionId: "github.get_current_user", alias: "openbot-u-u-github" }, {});
    expect(seen[0].path).toBe("/v1/actions/github.get_current_user");
    expect(seen[0].headers["x-oo-connector-alias"]).toBe("openbot-u-u-github");
    expect(seen[0].body).toEqual({ input: {} });
  });

  test("execute sends no alias header when the call runs on no account of anybody's", async () => {
    const seen: { path: string; headers: Record<string, string> }[] = [];
    const client = clientWith(async (path, init) => {
      seen.push({ path, headers: init.headers });
      return { data: {} };
    });
    await client.actions.execute({ service: "hackernews", actionId: "hackernews.get_top_stories", alias: null }, {});
    expect("x-oo-connector-alias" in seen[0].headers).toBe(false);
  });

  test("listActions dials the per-service runtime endpoint, not the whole catalog", async () => {
    const paths: string[] = [];
    const client = clientWith(async (path) => {
      paths.push(path);
      if (path === "/v1/actions?service=github") {
        return { data: [
          { id: "github.get_current_user", description: "Get the authenticated user", inputSchema: { type: "object" } },
          { id: "github.create_issue", description: "Create an issue" },
        ] };
      }
      throw new Error(`unexpected ${path}`);
    });
    const actions = await client.actions.listActions("github");
    expect(paths).toEqual(["/v1/actions?service=github"]);
    expect(actions).toEqual([
      { id: "github.get_current_user", description: "Get the authenticated user", inputSchema: { type: "object" } },
      { id: "github.create_issue", description: "Create an issue", inputSchema: null },
    ]);
  });
});

describe("the trust boundary of the configured base", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a base that is not an http(s) URL without userinfo refuses at construction", () => {
    for (const url of [
      "not a url",
      "ftp://example.com",
      "file:///etc/passwd",
      "http://user:pass@localhost:3100",
      "https://alice@example.com",
      "openconnector://github",
    ]) {
      expect(() =>
        createOpenConnectorClient({ url, adminToken: "a", runtimeToken: "r" }),
      ).toThrow(/OPENCONNECTOR_URL/);
    }
  });

  test("construction closes over the config and reaches nothing", () => {
    const attempts: string[] = [];
    globalThis.fetch = ((input: unknown) => {
      attempts.push(String(input));
      return Promise.reject(new Error("no network in this test"));
    }) as typeof globalThis.fetch;
    createOpenConnectorClient({ url: "http://localhost:3100", adminToken: "a", runtimeToken: "r" });
    expect(attempts).toEqual([]);
  });

  test("the production dial follows no redirect and only ever dials the configured base", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return { ok: true, status: 200, json: async () => [] };
    }) as typeof globalThis.fetch;
    const client = createOpenConnectorClient({ url: "http://localhost:3100", adminToken: "a", runtimeToken: "r" });
    await client.broker.listApps();
    await client.broker.revoke({ account: { holder: "person", userId: "u", vendorUserId: "openbot-u-u-github" }, toolkit: "github" });
    expect(seen.map((attempt) => attempt.url)).toEqual([
      "http://localhost:3100/api/providers",
      "http://localhost:3100/api/connections/github?connectionName=openbot-u-u-github",
    ]);
    expect(seen.every((attempt) => attempt.init.redirect === "manual")).toBe(true);
    const headers = (attempt: number) => seen[attempt].init.headers as Record<string, string>;
    expect(headers(0).Authorization).toBe("Bearer a");
    expect(headers(1).Authorization).toBe("Bearer a");
  });
});
