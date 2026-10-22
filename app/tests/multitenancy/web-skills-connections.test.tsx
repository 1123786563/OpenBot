import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../../tests/support/e2e-compat";
import { scopedCachePrefix, useScopedCache } from "../../src/lib/enterprise/tenant/scoped-cache";
import { type ScopeSelection, storeSelection } from "../../src/lib/enterprise/tenant/selection";
import {
  connectAccountMutationOptions,
  disconnectBrokeredMutationOptions,
  removeSkillMutationOptions,
  revealConnectionSecretMutationOptions,
  saveSkillMutationOptions,
} from "../../src/lib/plugins/mutations";
import {
  type PluginConnections,
  pluginKeys,
  scopedConnectionsQueryOptions,
  scopedPluginsPageQueryOptions,
} from "../../src/lib/plugins/queries";

/**
 * MT088 / Issue #131: the skills and connected-accounts pages are bound to the scope the screen
 * holds. Both reads carry the selection pair and file under the scope's own cache prefix, so a
 * switch drops the old scope's rows wholesale (AC1); a connection's secret is masked by structure
 * — the list answer has no secret field at all — and reading it in the clear is its OWN action,
 * offered only where the server says `canDisclose`, carrying the pair, cached nowhere (AC2); the
 * connect, skill and clear-consent writes submit under the scope (AC3); a disconnect retracts the
 * row at once in this scope's own cache (AC4). The business regressions run in their own suites
 * (plugin-grants, plugin-logo, bot-access-skills, skills editors).
 *
 * THE HARNESS IS THE REAL SEAM: every read and write goes through the factories the pages call,
 * the selection is seeded from storage exactly as production seeds it, and `fetch` records every
 * request — the pair the client carried is the evidence.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };

const PLUGINS_PAGE = {
  servers: [
    {
      id: "gdrive",
      title: "Google Drive",
      authScheme: "OAUTH",
      provenance: "curated",
      accountMode: "personal",
    },
  ],
  catalogue: [],
  skills: [
    {
      slug: "file-receipts",
      title: "File receipts",
      summary: "File every receipt as it arrives.",
      instructions: "Watch the inbox and file receipts.",
      global: false,
    },
  ],
};

const CONNECTIONS: PluginConnections = {
  connections: [
    {
      serverId: "gdrive",
      scope: "drive.readonly",
      connectedAt: "2026-10-01T00:00:00.000Z",
      holder: "person",
    },
  ],
  redirectUri: null,
};

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

const originalFetch = global.fetch;

type Asked = { input: string; init: RequestInit | undefined };

let asked: Asked[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serve(handler: (path: string) => Response | undefined): void {
  global.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = String(input);
    asked.push({ input: path, init });
    if (path === "/api/me") return jsonResponse(200, { user: { id: USER } });
    return handler(path) ?? jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

function headerOf(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return (headers as Record<string, string>)[name];
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function draw(queryClient: QueryClient, node: React.ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => node }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The two page reads, exactly as the skills and connected-accounts pages make them. */
function ReadsProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const page = useQuery(scopedPluginsPageQueryOptions(queryClient, scope));
  const connections = useQuery(
    scopedConnectionsQueryOptions(queryClient, scope),
  );
  return (
    <>
      <span data-testid="skills">{page.data?.skills.length ?? "none"}</span>
      <span data-testid="connections">
        {connections.data?.connections.length ?? "none"}
      </span>
    </>
  );
}

/** The reveal action the connection detail page offers, over the real factory. */
function RevealProbe() {
  const scope = useScopedCache();
  const reveal = useMutation(revealConnectionSecretMutationOptions(scope));
  return (
    <>
      <span data-testid="revealed">
        {typeof reveal.data === "string"
          ? "shown"
          : reveal.error
            ? "refused"
            : ""}
      </span>
      <button
        data-testid="reveal"
        onClick={() => reveal.mutate("gdrive")}
        type="button"
      />
    </>
  );
}

/** The connect, skill and disconnect writes the pages make, one button each. */
function WritesProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const connect = useMutation(connectAccountMutationOptions("settings", scope));
  const saveSkill = useMutation(saveSkillMutationOptions(queryClient, scope));
  const removeSkill = useMutation(
    removeSkillMutationOptions(queryClient, scope),
  );
  const disconnect = useMutation(
    disconnectBrokeredMutationOptions(queryClient, scope),
  );
  return (
    <>
      <button
        data-testid="connect"
        onClick={() => connect.mutate("gdrive")}
        type="button"
      />
      <button
        data-testid="save-skill"
        onClick={() =>
          saveSkill.mutate({
            slug: "file-receipts",
            title: "File receipts",
            summary: "File every receipt as it arrives.",
            instructions: "Watch the inbox and file receipts.",
          })
        }
        type="button"
      />
      <button
        data-testid="remove-skill"
        onClick={() => removeSkill.mutate("file-receipts")}
        type="button"
      />
      <button
        data-testid="disconnect"
        onClick={() => disconnect.mutate("gdrive")}
        type="button"
      />
    </>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  asked = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// AC1 — the skills and connections lists only reflect the scope in force
// ---------------------------------------------------------------------------

describe("MT088 AC1 — both page reads are scoped", () => {
  test("the skills page and the connections read carry the pair and file under the prefix", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/plugins"
        ? jsonResponse(200, PLUGINS_PAGE)
        : path === "/api/plugins/connections"
          ? jsonResponse(200, CONNECTIONS)
          : undefined,
    );
    const queryClient = freshClient();
    const view = draw(queryClient, <ReadsProbe />);
    await waitFor(() =>
      expect(view.getByTestId("skills").textContent).toBe("1"),
    );
    await waitFor(() =>
      expect(view.getByTestId("connections").textContent).toBe("1"),
    );

    const page = asked.find((ask) => ask.input === "/api/plugins");
    expect(page).toBeTruthy();
    expect(headerOf(page?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(page?.init, "x-openbot-workspace")).toBe("acme-finance");
    const connections = asked.find(
      (ask) => ask.input === "/api/plugins/connections",
    );
    expect(connections).toBeTruthy();
    expect(headerOf(connections?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(connections?.init, "x-openbot-workspace")).toBe(
      "acme-finance",
    );
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        ...pluginKeys.page(),
      ]),
    ).toBeTruthy();
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        ...pluginKeys.connections(),
      ]),
    ).toBeTruthy();
    // The unscoped entries other surfaces read stay untouched by the scoped reads.
    expect(queryClient.getQueryData(pluginKeys.page())).toBeUndefined();
    expect(queryClient.getQueryData(pluginKeys.connections())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2 — masked by default; the plaintext is its own scoped, audited, uncached action
// ---------------------------------------------------------------------------

describe("MT088 AC2 — the secret is masked and its reveal is an independent action", () => {
  test("the reveal carries the pair and nothing of it lands in any cache", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/plugins/servers/gdrive/connection/disclose"
        ? jsonResponse(200, { secret: "live-refresh-token" })
        : undefined,
    );
    const queryClient = freshClient();
    const view = draw(queryClient, <RevealProbe />);
    const reveal = await waitFor(() => view.getByTestId("reveal"));

    await act(async () => {
      reveal.click();
    });
    await waitFor(() =>
      expect(view.getByTestId("revealed").textContent).toBe("shown"),
    );
    const disclosed = asked.find(
      (ask) => ask.input === "/api/plugins/servers/gdrive/connection/disclose",
    );
    expect(disclosed).toBeTruthy();
    expect(disclosed?.init?.method).toBe("POST");
    expect(headerOf(disclosed?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(disclosed?.init, "x-openbot-workspace")).toBe(
      "acme-finance",
    );
    // Cached nowhere: the answer lives in the component alone, so a refetch can never replay it.
    for (const entry of queryClient.getQueryCache().getAll()) {
      expect(JSON.stringify(entry.state.data ?? null)).not.toContain(
        "live-refresh-token",
      );
    }
  });

  test("an answer with no secret on it refuses, rather than showing an empty one", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/plugins/servers/gdrive/connection/disclose"
        ? jsonResponse(200, {})
        : undefined,
    );
    const queryClient = freshClient();
    const view = draw(queryClient, <RevealProbe />);
    const reveal = await waitFor(() => view.getByTestId("reveal"));

    await act(async () => {
      reveal.click();
    });
    await waitFor(() =>
      expect(view.getByTestId("revealed").textContent).toBe("refused"),
    );
  });
});

// ---------------------------------------------------------------------------
// AC3 — installs, connects and skill writes submit the scope
// ---------------------------------------------------------------------------

describe("MT088 AC3 — the writes carry the pair", () => {
  test("connect, save-skill and remove-skill all carry the pair", async () => {
    storeSelection(USER, ACME);
    serve(() => undefined);
    const queryClient = freshClient();
    const view = draw(queryClient, <WritesProbe />);
    const connect = await waitFor(() => view.getByTestId("connect"));

    await act(async () => {
      connect.click();
    });
    const connectAsk = asked.find(
      (ask) =>
        ask.input === "/api/plugins/servers/gdrive/connect?returnTo=settings",
    );
    expect(connectAsk).toBeTruthy();
    expect(connectAsk?.init?.method).toBe("POST");
    expect(headerOf(connectAsk?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(connectAsk?.init, "x-openbot-workspace")).toBe(
      "acme-finance",
    );

    await act(async () => {
      view.getByTestId("save-skill").click();
    });
    const save = asked.find(
      (ask) =>
        ask.input === "/api/plugins/skills" && ask.init?.method === "POST",
    );
    expect(save).toBeTruthy();
    expect(headerOf(save?.init, "x-openbot-tenant")).toBe("acme");

    await act(async () => {
      view.getByTestId("remove-skill").click();
    });
    const remove = asked.find(
      (ask) =>
        ask.input === "/api/plugins/skills/file-receipts" &&
        ask.init?.method === "DELETE",
    );
    expect(remove).toBeTruthy();
    expect(headerOf(remove?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(remove?.init, "x-openbot-workspace")).toBe("acme-finance");
  });
});

// ---------------------------------------------------------------------------
// AC4 — a disconnect retracts the row at once in this scope's own cache
// ---------------------------------------------------------------------------

describe("MT088 AC4 — a disconnect is reflected immediately", () => {
  test("the settle's invalidation refetches this scope's connections with the pair", async () => {
    storeSelection(USER, ACME);
    // First answer: connected. After the disconnect, the server says no row.
    let connected = true;
    serve((path) => {
      if (path === "/api/plugins") {
        return jsonResponse(200, PLUGINS_PAGE);
      }
      if (path === "/api/plugins/connections") {
        return jsonResponse(200, {
          ...CONNECTIONS,
          connections: connected
            ? CONNECTIONS.connections
            : CONNECTIONS.connections.filter(
                (row) => row.serverId !== "gdrive",
              ),
        });
      }
      if (path === "/api/plugins/servers/gdrive/connection") {
        connected = false;
        return jsonResponse(200, {});
      }
      return undefined;
    });
    const queryClient = freshClient();
    const view = draw(
      queryClient,
      <>
        <ReadsProbe />
        <WritesProbe />
      </>,
    );
    await waitFor(() =>
      expect(view.getByTestId("connections").textContent).toBe("1"),
    );

    await act(async () => {
      view.getByTestId("disconnect").click();
    });
    // The row is gone from the screen without any navigation: the settle invalidated THIS
    // scope's own entry, and the refetch — under the pair — answered the server's new truth.
    await waitFor(() =>
      expect(view.getByTestId("connections").textContent).toBe("0"),
    );
    const refetches = asked.filter(
      (ask) => ask.input === "/api/plugins/connections",
    );
    expect(refetches.length).toBeGreaterThan(1);
    expect(headerOf(refetches.at(-1)?.init, "x-openbot-tenant")).toBe("acme");
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        ...pluginKeys.connections(),
      ]),
    ).toMatchObject({ connections: [] });
  });
});
