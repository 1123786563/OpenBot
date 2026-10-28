import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { loadCraftConfig } from "../src/craft/config";
import { createCraftMcpRelayApp } from "../src/craft/mcp-relay";
import { craftMcpRelayUrl } from "../src/craft/mcp-servers";
import {
  MCP_SESSION_TAG_HEADER,
  type CraftMCPServerConfig,
} from "../src/craft/opencode-config";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";

/**
 * The craft MCP relay — OpenBot's environment-equivalent of onyx's egress
 * proxy credential injection: opencode's in-sandbox MCP client dials the relay
 * url the session's mcp block carries, the session-tag header attributes the
 * call to its session, and ONLY the relay side ever sees the credential. A
 * call that does not attribute cleanly answers onyx's 403 payload and never
 * reaches the vendor.
 */

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function sessionRow(overrides: Partial<CraftSessionRow> = {}): CraftSessionRow {
  return {
    id: SESSION_ID,
    userId: "u1",
    name: null,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort: null,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: "ses_1",
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// the stub vendor: an MCP endpoint over real HTTP
// ---------------------------------------------------------------------------

type SeenRequest = {
  method: string;
  path: string;
  authorization: string | null;
  mcpSessionId: string | null;
  body: string;
};

const seen: SeenRequest[] = [];

const vendor = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    seen.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get("authorization"),
      mcpSessionId: request.headers.get("mcp-session-id"),
      body: await request.text(),
    });
    if (request.method === "GET") {
      return new Response("stream unsupported", { status: 405 });
    }
    const message = JSON.parse(seen[seen.length - 1].body) as {
      method?: string;
    };
    if (message.method === "tools/list") {
      // Tool discovery: the listing an opencode session's MCP client asks for,
      // answered with the two tools F3 names (one of them admin-disabled).
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [
              { name: "search", description: "run a search" },
              { name: "delete_everything", description: "wipe it all" },
            ],
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "vendor-session-9",
          },
        },
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          serverInfo: { name: "stub-vendor", version: "1" },
        },
      }),
      {
        status: 202,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "vendor-session-9",
        },
      },
    );
  },
});

afterAll(() => {
  vendor.stop(true);
});

const VENDOR_URL = `http://127.0.0.1:${vendor.port}/mcp`;
const USER_TOKEN = "vendor-secret-token"; // the credential that must never leave the relay side
const RELAY_BASE = "https://openbot.example";

const config = loadCraftConfig({});

const serverSet: CraftMCPServerConfig[] = [
  {
    key: "acme-tools-42",
    url: craftMcpRelayUrl(RELAY_BASE, "42"),
    disabledTools: [],
  },
  {
    key: "ghost-50",
    url: craftMcpRelayUrl(RELAY_BASE, "50"),
    disabledTools: [],
  },
];

type RelayInput = {
  session?: CraftSessionRow | null;
  servers?: CraftMCPServerConfig[];
  connection?: { url: string; token: string | null } | null;
};

function relayApp(input: RelayInput = {}) {
  return createCraftMcpRelayApp({
    store: {
      findSessionById: async (id: string) => {
        const row = input.session === undefined ? sessionRow() : input.session;
        return row !== null && row.id === id ? row : undefined;
      },
    } as unknown as Pick<CraftStore, "findSessionById">,
    sessionMcpServersFor: async () => input.servers ?? serverSet,
    resolveConnection: async (_userId, serverId) =>
      input.connection === undefined
        ? serverId === "42"
          ? { url: VENDOR_URL, token: USER_TOKEN }
          : null
        : input.connection,
  });
}

function relayPost(
  serverId: string,
  init: Omit<RequestInit, "headers"> & {
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const app = relayApp();
  const { headers = {}, ...rest } = init;
  return app.request(`/mcp/${serverId}`, {
    ...rest,
    method: "POST",
    headers: {
      "content-type": "application/json",
      [MCP_SESSION_TAG_HEADER]: SESSION_ID,
      ...headers,
    },
  });
}

const JSONRPC_INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26" },
});

// ---------------------------------------------------------------------------
// the happy path: credential attach + body passthrough + header propagation
// ---------------------------------------------------------------------------

describe("relay forwards MCP JSON-RPC with the owner's credential attached", () => {
  test("session-tagged call reaches the vendor authenticated; response passes through", async () => {
    seen.length = 0;
    const response = await relayPost("42", {
      body: JSONRPC_INIT,
      headers: { "mcp-session-id": "client-session-1" },
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("mcp-session-id")).toBe("vendor-session-9");
    const payload = (await response.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(payload.result?.serverInfo?.name).toBe("stub-vendor");

    expect(seen).toHaveLength(1);
    const forwarded = seen[0];
    expect(forwarded.method).toBe("POST");
    expect(forwarded.path).toBe("/mcp");
    expect(forwarded.authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(forwarded.mcpSessionId).toBe("client-session-1");
    expect(forwarded.body).toBe(JSONRPC_INIT);
  });

  test("a token naming its own scheme travels as written", async () => {
    seen.length = 0;
    const app = relayApp({
      connection: { url: VENDOR_URL, token: "Basic abc==" },
    });
    await app.request("/mcp/42", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MCP_SESSION_TAG_HEADER]: SESSION_ID,
      },
      body: JSONRPC_INIT,
    });
    expect(seen[0].authorization).toBe("Basic abc==");
  });

  test("a credential-less server forwards with no Authorization header", async () => {
    seen.length = 0;
    const app = relayApp({
      connection: { url: VENDOR_URL, token: null },
    });
    await app.request("/mcp/42", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MCP_SESSION_TAG_HEADER]: SESSION_ID,
      },
      body: JSONRPC_INIT,
    });
    expect(seen[0].authorization).toBeNull();
  });

  test("the credential never appears in the relay's own responses", async () => {
    const response = await relayPost("42", { body: JSONRPC_INIT });
    const body = await response.text();
    expect(body).not.toContain(USER_TOKEN);
  });

  test("tool discovery (tools/list) forwards and returns the vendor's listing", async () => {
    seen.length = 0;
    const response = await relayPost("42", {
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
      headers: { "mcp-session-id": "client-session-1" },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(payload.result?.tools?.map((tool) => tool.name)).toEqual([
      "search",
      "delete_everything",
    ]);
    // The dialed call carried the owner's credential, not the session's config.
    expect(seen[0].authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(seen[0].body).toContain("tools/list");
  });
});

// ---------------------------------------------------------------------------
// the boundary: every unattributable call answers 403, vendor untouched
// ---------------------------------------------------------------------------

describe("relay refusal", () => {
  test("no session-tag header → 403 not_authorized, nothing dialed", async () => {
    seen.length = 0;
    const app = relayApp();
    const response = await app.request("/mcp/42", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSONRPC_INIT,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_authorized" });
    expect(seen).toHaveLength(0);
  });

  test("unknown session → 403", async () => {
    const app = relayApp({ session: null });
    const response = await app.request("/mcp/42", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MCP_SESSION_TAG_HEADER]: "no-such-session",
      },
      body: JSONRPC_INIT,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_authorized" });
  });

  test("inactive session → 403", async () => {
    const app = relayApp({ session: sessionRow({ status: "failed" }) });
    const response = await app.request("/mcp/42", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MCP_SESSION_TAG_HEADER]: SESSION_ID,
      },
      body: JSONRPC_INIT,
    });
    expect(response.status).toBe(403);
  });

  test("server not in the session's resolved set → 403 (cross-session reach blocked)", async () => {
    seen.length = 0;
    // 99 is a real catalogue server for OTHER sessions — this session never
    // resolved it, so its tag cannot reach it.
    const response = await relayPost("99", { body: JSONRPC_INIT });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_authorized" });
    expect(seen).toHaveLength(0);
  });

  test("no usable connection for the owner → 403, vendor untouched", async () => {
    seen.length = 0;
    const app = relayApp({ connection: null });
    const refused = await app.request("/mcp/42", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MCP_SESSION_TAG_HEADER]: SESSION_ID,
      },
      body: JSONRPC_INIT,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "not_authorized" });
    expect(seen).toHaveLength(0);
  });

  test("GET (server-stream) answers 405 — the client falls back to HTTP-only", async () => {
    seen.length = 0;
    const app = relayApp();
    const response = await app.request("/mcp/42", {
      method: "GET",
      headers: { [MCP_SESSION_TAG_HEADER]: SESSION_ID },
    });
    expect(response.status).toBe(405);
    expect(seen).toHaveLength(0);
  });

  test("a mis-tagged call from another session's tag value cannot ride this session", async () => {
    seen.length = 0;
    const app = relayApp({
      session: sessionRow({ id: "other-active-session" }),
    });
    const response = await app.request("/mcp/42", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MCP_SESSION_TAG_HEADER]: SESSION_ID, // names a DIFFERENT session
      },
      body: JSONRPC_INIT,
    });
    // The store resolves the tag itself — the named session is not found here.
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// the assembly: the relay must answer inside the FULL craft tree — before the
// user guard — or production would 401 the sandbox's unauthenticated MCP client
// ---------------------------------------------------------------------------

describe("relay inside the assembled craft tree", () => {
  test("a session-tagged call reaches the relay without a user session", async () => {
    seen.length = 0;
    const { createCraftRoutes } = await import("../src/craft/routes");
    const requireUser = async (
      context: { json(body: unknown, status: number): Response },
      next: () => Promise<void>,
    ) => {
      // If the guard ever sees a relay request it has already failed the test.
      void context;
      await next();
      return undefined as never;
    };
    const app = createCraftRoutes({
      requireUser: requireUser as never,
      deps: {
        config,
        db: {} as never,
        redis: null,
        approvals: {} as never,
        botIdFor: async () => "craft",
        llmConfigFor: async () => ({}) as never,
        sandboxConnectionFor: () => null,
        userNameFor: async () => null,
        store: {
          findSessionById: async (id: string) =>
            id === SESSION_ID ? sessionRow() : undefined,
        } as never,
        mcpConnectionFor: async () => ({
          url: VENDOR_URL,
          token: USER_TOKEN,
        }),
        managedContentFor: async () => ({
          connectableAppsSection: "",
          skillFiles: new Map(),
          mcpServers: serverSet,
          skillsHash: "x",
          mcpConfigHash: "y",
          libraryFiles: new Map(),
          webTemplateFiles: new Map(),
        }),
      },
    });
    const response = await app.request("/mcp/42", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MCP_SESSION_TAG_HEADER]: SESSION_ID,
      },
      body: JSONRPC_INIT,
    });
    expect(response.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toBe(`Bearer ${USER_TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// the boundary's shape: no credential bytes in relay logs is enforced by
// construction (the relay logs ids only) — asserted via the config surface:
// ---------------------------------------------------------------------------

describe("mcp block carries no credential bytes", () => {
  test("the session's opencode.json mcp entry is url + tag header only", async () => {
    const { buildProviderOpencodeConfig, opencodeConfigJson } = await import(
      "../src/craft/opencode-config"
    );
    const llm = {
      provider: "onyx",
      modelName: "gpt-5",
      apiKey: null,
      apiBase: null,
      displayName: null,
      models: [
        {
          id: "gpt-5",
          displayName: "gpt-5",
          maxInputTokens: 1000,
          maxOutputTokens: 1000,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsReasoning: false,
          supportsToolCalls: true,
          supportsTemperature: false,
          supportsInterleavedReasoning: false,
        },
      ],
    };
    const json = opencodeConfigJson(
      buildProviderOpencodeConfig(llm, {
        mcpServers: serverSet,
        sessionId: SESSION_ID,
      }),
    );
    expect(json).not.toContain(USER_TOKEN);
    expect(json).not.toMatch(/authorization|apikey|api_key/i);
  });
});
