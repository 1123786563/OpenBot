// Deliberately has no upstream: unknown requests fail locally.
import { CONVERSATIONS, seededConversations } from "./conversations.mjs";
import { governance, salesBot } from "./governance-fixture.mjs";

const port = Number(process.env.FIXTURE_API_PORT || 41850);
const appPort = Number(process.env.FIXTURE_APP_PORT || 41849);
let signedIn = false;
let preferences = {
  messageListEmphasis: "thread",
  selfHostBannerDismissed: false,
  narration: null,
  skin: "openbot",
  proactive: "on",
};
let instructions =
  "Always preserve the complete evidence and explain every decision. ".repeat(
    60,
  );
const user = {
  id: "browser-acceptance",
  name: "Acceptance Tester",
  email: "acceptance@example.test",
  role: "admin",
  onboarding: null,
};
const runtimeInfo = {
  version: "fixture",
  agents: Object.fromEntries(
    [
      ...CONVERSATIONS.map(({ bot, name }) => [bot, name]),
      [salesBot.id, salesBot.name],
    ].map(([id, description]) => [id, { name: id, description }]),
  ),
  mode: "sse",
  telemetryDisabled: true,
};
Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    console.log(request.method, path);
    const json = (body, status = 200) =>
      Response.json(body, {
        status,
        headers: { "x-openbot-fixture": "isolated" },
      });
    if (path === "/__fixture/session") {
      signedIn = new URL(request.url).searchParams.get("signedIn") === "true";
      return Response.redirect(
        `http://localhost:${appPort}/${signedIn ? "settings" : "sign"}`,
      );
    }
    if (path === "/api/__fixture/desktop.js")
      return new Response(
        `window.__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: 'main' } }, transformCallback: () => 1,
    invoke: async (command) => {
      if (command.endsWith('|ai_connection')) return { kind: 'compatible-endpoint', model: 'acceptance-model-' + 'very-long-model-name-'.repeat(20), endpointHost: 'https://acceptance.example.test/' + 'long-path-segment/'.repeat(20) };
      if (command.endsWith('|usage_data')) return { shared: false, offByEnvironment: false };
      if (command.endsWith('|update_offer')) return { version: null, current: 'fixture', installing: null, updatesItself: false };
      throw new Error('Unsupported acceptance desktop command: ' + command);
    }
  };`,
        { headers: { "content-type": "text/javascript" } },
      );
    const governanceReply = await governance.respond(request, path, json);
    if (governanceReply) return governanceReply;
    const currentUser = { ...user, role: governance.role };
    if (path === "/api/me")
      return signedIn
        ? json({ user: currentUser })
        : json({ error: "Unauthorized" }, 401);
    if (path === "/api/capabilities")
      return json({
        authProviders: ["google", "microsoft", "okta"],
        ssoConfigured: true,
        ssoRequired: false,
        generativeUi: true,
        edition: governance.edition,
      });
    if (path === "/api/auth/get-session")
      return json(
        signedIn
          ? {
              user: currentUser,
              session: {
                id: "fixture-session",
                userId: user.id,
                expiresAt: "2099-01-01T00:00:00Z",
              },
            }
          : null,
      );
    if (path.startsWith("/api/auth/sign-in/"))
      return json({
        url: `http://localhost:${port}/__fixture/session?signedIn=true`,
        redirect: true,
      });
    if (path === "/api/auth/sign-out") {
      signedIn = false;
      return json({ success: true });
    }
    if (path === "/api/components/catalogue" && request.method === "PUT") {
      if (!signedIn) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => null);
      if (!Array.isArray(body?.components))
        return json({ error: "A list of components is required." }, 400);
      const invalid = body.components.findIndex(
        (entry) =>
          !entry ||
          !["name", "title", "kind", "description"].every(
            (field) => typeof entry[field] === "string" && entry[field].trim(),
          ),
      );
      if (invalid !== -1)
        return json(
          {
            error: `Component at index ${invalid} needs a name, a title, a kind and a description.`,
          },
          400,
        );
      // The fixture keeps its component data fixed across gallery announcements.
      return json({ added: [] });
    }
    if (path === "/api/sandboxed/published" && request.method === "GET")
      return signedIn
        ? json({ components: [] })
        : json({ error: "Unauthorized" }, 401);
    if (path === "/api/copilotkit/info" && request.method === "GET")
      return json(runtimeInfo);
    if (path === "/api/copilotkit" && request.method === "POST") {
      // CopilotKit probes the single-route transport when REST discovery fails.
      const body = await request.json().catch(() => null);
      if (body?.method === "info") return json(runtimeInfo);
    }
    if (path === "/api/settings/preferences") {
      if (request.method !== "GET")
        preferences = { ...preferences, ...(await request.json()) };
      return json({ preferences });
    }
    if (path === "/api/settings/instructions") {
      if (request.method !== "GET")
        instructions = (await request.json()).instructions;
      return json({ instructions });
    }
    // The roster, aged from this request so the sidebar's short relative times stay put.
    if (path === "/api/channels")
      return json({ channels: seededConversations(), nextCursor: null });
    const lists = {
      "/api/agents": "agents",
      "/api/bots": "bots",
      "/api/notifications": "notifications",
      "/api/workspaces": "workspaces",
    };
    if (path in lists) return json({ [lists[path]]: [], nextCursor: null });
    if (path === "/api/setup")
      return json({
        checklist: {
          audience: "admin",
          rows: [{ id: "computer", ready: true }],
        },
      });
    if (path === "/api/models")
      return json({
        provider: "openai",
        source: "openai",
        exposure: "all",
        default: "fixture-model",
        choosable: true,
        models: [
          { id: "fixture-model", label: "Fixture model", vendor: "openai" },
        ],
      });
    return json(
      { error: `Unimplemented fixture: ${request.method} ${path}` },
      501,
    );
  },
});
console.log(`Isolated fixture API http://127.0.0.1:${port}`);
