// Deliberately has no upstream: unknown requests fail locally.
import { CONVERSATIONS, seededConversations } from "./conversations.mjs";
import { governance, salesBot } from "./governance-fixture.mjs";
import { sweepRead } from "./sweep-reads.mjs";

const port = Number(process.env.FIXTURE_API_PORT || 41850);
const appPort = Number(process.env.FIXTURE_APP_PORT || 41849);
let signedIn = false;
const channelReads = new Map();
const threadIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const models = {
  provider: "openai",
  source: "openai",
  exposure: "all",
  default: "fixture-model",
  models: [{ id: "fixture-model", label: "Fixture model", vendor: "openai" }],
};
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
const server = Bun.serve({
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
      channelReads.clear();
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
    if (signedIn) {
      const read = sweepRead(request, path, json, {
        edition: governance.edition,
        role: governance.role,
        salesBot,
        userId: user.id,
      });
      if (read) return read;
    }
    const currentUser = { ...user, role: governance.role, onboarding: null };
    if (path === "/api/me/onboarding" && request.method === "POST") {
      if (!signedIn) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => null);
      // The recorder injects the onboarding state into /api/me for its onboarding page.
      // Persisting it here would make the app gate redirect the sweep's other pages.
      if (body?.completed === true) {
        return json({
          onboarding: { step: 0, completedAt: new Date().toISOString() },
        });
      }
      if (
        Number.isInteger(body?.step) &&
        body.step >= 0 &&
        body.step <= 2_147_483_647
      ) {
        return json({ onboarding: { step: body.step, completedAt: null } });
      }
      return json(
        { error: "Send the step to move to, or completed: true." },
        400,
      );
    }
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
        url: `http://localhost:${server.port}/__fixture/session?signedIn=true`,
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
    if (path === "/api/threads/mint" && request.method === "POST") {
      if (!signedIn) return json({ error: "Unauthorized" }, 401);
      return json({ threadId: crypto.randomUUID() });
    }
    const connect = /^\/api\/copilotkit\/agent\/([^/]+)\/connect$/.exec(path);
    if (
      request.method === "POST" &&
      connect &&
      Object.hasOwn(runtimeInfo.agents, connect[1])
    ) {
      if (!signedIn) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => null);
      if (typeof body?.threadId !== "string" || !body.threadId.trim()) {
        return json({ error: "Invalid request body" }, 400);
      }
      // A fresh thread has no runs to replay. The SSE stream closes without events.
      return new Response("", {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-openbot-fixture": "isolated",
        },
      });
    }
    const history = /^\/api\/copilotkit\/threads\/([^/]+)\/messages$/.exec(
      path,
    );
    if (
      request.method === "GET" &&
      history &&
      (threadIdPattern.test(history[1]) ||
        CONVERSATIONS.some(({ id }) => id === history[1]))
    ) {
      return signedIn
        ? json({ messages: [] })
        : json({ error: "Unauthorized" }, 401);
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
    if (path === "/api/channels" && request.method === "GET") {
      const channels = seededConversations().map((channel) => ({
        ...channel,
        lastReadAt: channelReads.get(channel.id) ?? channel.lastReadAt,
      }));
      return json({ channels, nextCursor: null });
    }
    const conversation = /^\/api\/(channels|groups)\/([^/]+)(\/read)?$/.exec(
      path,
    );
    if (conversation) {
      const [, collection, id, read] = conversation;
      const seed = CONVERSATIONS.find((entry) => entry.id === id);
      if (
        seed &&
        collection === "channels" &&
        read &&
        request.method === "PUT"
      ) {
        if (!signedIn) return json({ error: "Unauthorized" }, 401);
        channelReads.set(id, new Date().toISOString());
        return new Response(null, {
          status: 204,
          headers: { "x-openbot-fixture": "isolated" },
        });
      }
      if (seed && !read && request.method === "GET") {
        if (!signedIn) return json({ error: "Unauthorized" }, 401);
        if (collection === "groups") {
          return json({
            bots: [{ id: seed.bot, name: seed.name }],
            people: [
              {
                userId: user.id,
                email: user.email,
                name: user.name,
                creator: true,
              },
            ],
            messages: [],
            backgroundRuns: [],
          });
        }
        const {
          name,
          agentIds,
          threadId,
          active,
          lastMessageAt,
          work = [],
        } = seededConversations().find((entry) => entry.id === id);
        return json({
          channel: {
            id,
            name,
            agentIds,
            threadId,
            active,
            lastMessageAt,
            work,
          },
        });
      }
    }
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
    if (path === "/api/models" && request.method === "GET")
      return json({ ...models, choosable: true });
    if (path === "/api/models/available" && request.method === "GET") {
      if (!signedIn) return json({ error: "Unauthorized" }, 401);
      if (governance.role !== "admin") return json({ error: "Forbidden" }, 403);
      return json({ ...models, listed: true });
    }
    return json(
      { error: `Unimplemented fixture: ${request.method} ${path}` },
      501,
    );
  },
});
console.log(`Isolated fixture API http://127.0.0.1:${server.port}`);
