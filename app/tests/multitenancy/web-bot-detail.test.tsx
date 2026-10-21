import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
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
} from "../../../tests/support/bun-test-compat";
import { BotSubpage } from "../../src/components/bot-profile/bot-subpage";
import { agentKeys, type AgentProfile } from "../../src/lib/agents/queries";
import { updateAgentMutationOptions } from "../../src/lib/agents/mutations";
import {
  type ScopeSelection,
  selectionStorageKey,
  selectWorkspaceScope,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import {
  type ScopedCache,
  scopedCachePrefix,
  useScopedCache,
} from "../../src/lib/enterprise/tenant/scoped-cache";

/**
 * MT084 / Issue #127: the Bot detail and configuration pages are bound to the scope the screen
 * holds. The detail read carries the selection pair and is keyed under the scope's own cache
 * prefix, so a switch drops the old scope's row and re-reads (AC1); a route object from a scope
 * the person has left answers the ONE unavailable state — the same words as a coworker that never
 * existed, because the server's 404 does not distinguish them (AC2); the configuration save
 * submits under the current scope and paints its optimistic row there, rolling it back only while
 * that scope still holds (AC3). The business regressions (AC4) run in their own suites
 * (bot-manage, bot-settings-rows, bot-setup, bot-profile-*, bot-sharing).
 *
 * THE HARNESS IS THE REAL PAGE AND THE REAL SEAM, as in MT083's `cache-generation.test.tsx`: the
 * frame every `/bots/$agentId/<area>` page reads through (`BotSubpage`) renders inside a memory
 * router, the selection is seeded from storage exactly as production seeds it, and a switch goes
 * through `selectWorkspaceScope`. `fetch` records every request and answers by path — the
 * request's own shape (headers on `/api/agents`) and the cache's own shape (the scope's prefix)
 * are the evidence. The save flows drive the real mutation factory through a one-button probe, so
 * what is pinned is the wiring the setup page uses, not a sketch of it.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};

const ACME_BOT: AgentProfile = {
  id: "expenses",
  name: "Acme Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const GLOBEX_BOT: AgentProfile = {
  ...ACME_BOT,
  name: "Globex Expenses",
  mine: false,
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

/**
 * `/api/me` always answers this one person; everything else goes to the test's own handler, and
 * every request is recorded so the pair the client carried is the evidence.
 */
function serve(
  handler: (
    path: string,
    init: RequestInit | undefined,
  ) => Response | undefined,
): void {
  global.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = String(input);
    asked.push({ input: path, init });
    if (path === "/api/me") return jsonResponse(200, { user: { id: USER } });
    return handler(path, init) ?? jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

/** `/api/me` never answers: the scope source is unresolved, and nothing may be read on a guess. */
function servePendingAuth(
  handler?: (path: string) => Response | undefined,
): void {
  global.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    asked.push({ input: path, init: undefined });
    if (path === "/api/me") return new Promise<Response>(() => {});
    return handler?.(path) ?? jsonResponse(200, {});
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

function drawFrame(queryClient: QueryClient, agentId: string) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <BotSubpage agentId={agentId} description="The area" title="Sharing">
          {(agent) => <span data-testid="detail">{agent.name}</span>}
        </BotSubpage>
      ),
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The configuration save, exactly as the setup page wires it: the real factory, one button. */
function SaveProbe({ scope }: { scope: ScopedCache }) {
  const queryClient = useQueryClient();
  const update = useMutation(updateAgentMutationOptions(queryClient, scope));
  return (
    <button
      data-testid="save"
      onClick={() =>
        update.mutate({
          agentId: "expenses",
          input: {
            name: "Edited Expenses",
            title: "Finance",
            roleDescription: "Receipts.",
            visibility: "private",
          },
        })
      }
      type="button"
    />
  );
}

/** A scope holder for the save probe: the live read, as the setup page holds it. */
function ScopeProbe({
  children,
}: {
  children: (scope: ScopedCache) => React.ReactNode;
}) {
  const scope = useScopedCache();
  return <>{scope.status === "open" ? children(scope) : null}</>;
}

function drawSave(queryClient: QueryClient) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <ScopeProbe>{(scope) => <SaveProbe scope={scope} />}</ScopeProbe>
      ),
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** One switch as production makes it: the storage mirror and the one switch seam. */
function switchSelection(
  queryClient: QueryClient,
  previous: ScopeSelection | null,
  next: ScopeSelection | null,
): void {
  if (next !== null) storeSelection(USER, next);
  else window.localStorage.removeItem(selectionStorageKey(USER));
  selectWorkspaceScope(queryClient, USER, previous, next);
}

async function settleSwitch(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const detailKey = (selection: ScopeSelection | null, agentId = "expenses") => [
  ...scopedCachePrefix(USER, selection),
  ...agentKeys.detail(agentId),
];

beforeEach(() => {
  window.localStorage.clear();
  asked = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// AC1 — the detail read is bound to the current scope
// ---------------------------------------------------------------------------

describe("MT084 AC1 — the detail read carries the scope and is keyed by it", () => {
  test("the read carries the selection pair and files under the scope's own prefix", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/agents/expenses"
        ? jsonResponse(200, { agent: ACME_BOT })
        : undefined,
    );
    const queryClient = freshClient();
    const view = drawFrame(queryClient, "expenses");
    await waitFor(() =>
      expect(view.getByTestId("detail").textContent).toBe("Acme Expenses"),
    );

    const read = asked.find((ask) => ask.input === "/api/agents/expenses");
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
    expect(queryClient.getQueryData(detailKey(ACME))).toMatchObject({
      name: "Acme Expenses",
    });
  });

  test("no read is made while the scope source is unresolved", async () => {
    storeSelection(USER, ACME);
    servePendingAuth();
    const queryClient = freshClient();
    const view = drawFrame(queryClient, "expenses");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(asked.some((ask) => ask.input === "/api/agents/expenses")).toBe(
      false,
    );
    expect(view.queryByTestId("detail")).toBeNull();
    expect(view.queryByTestId("bot-unavailable")).toBeNull();
  });

  test("a switch re-keys the read: no old-scope row, the new scope's own answer", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/agents/expenses"
        ? jsonResponse(200, { agent: ACME_BOT })
        : undefined,
    );
    const queryClient = freshClient();
    const view = drawFrame(queryClient, "expenses");
    await waitFor(() =>
      expect(view.getByTestId("detail").textContent).toBe("Acme Expenses"),
    );

    serve((path) =>
      path === "/api/agents/expenses"
        ? jsonResponse(200, { agent: GLOBEX_BOT })
        : undefined,
    );
    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    await settleSwitch();
    // The old scope's row is gone from the cache before the new answer exists — the screen holds
    // nothing of Acme's while Globex answers.
    expect(queryClient.getQueryData(detailKey(ACME))).toBeUndefined();
    await waitFor(() =>
      expect(view.getByTestId("detail").textContent).toBe("Globex Expenses"),
    );
    const reread = asked.filter((ask) => ask.input === "/api/agents/expenses");
    expect(reread.length).toBe(2);
    expect(headerOf(reread[1]?.init, "x-openbot-tenant")).toBe("globex");
    expect(headerOf(reread[1]?.init, "x-openbot-workspace")).toBe("globex-ops");
    expect(queryClient.getQueryData(detailKey(GLOBEX))).toMatchObject({
      name: "Globex Expenses",
    });
  });
});

// ---------------------------------------------------------------------------
// AC2 — an old-scope route object answers the ONE unavailable state, leaking nothing
// ---------------------------------------------------------------------------

describe("MT084 AC2 — an old-scope route is explicitly unavailable, distinguishing nothing", () => {
  test("under the new scope the old route's read answers 404 and shows the unavailable state", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/agents/expenses"
        ? jsonResponse(200, { agent: ACME_BOT })
        : undefined,
    );
    const queryClient = freshClient();
    const view = drawFrame(queryClient, "expenses");
    await waitFor(() =>
      expect(view.getByTestId("detail").textContent).toBe("Acme Expenses"),
    );

    // Globex does not answer this coworker — one status, whether it never existed or moved away.
    serve((path) =>
      path === "/api/agents/expenses" ? jsonResponse(404, {}) : undefined,
    );
    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    await settleSwitch();
    await waitFor(() =>
      expect(view.getByTestId("bot-unavailable")).toBeTruthy(),
    );
    // The unavailable state is not an error alert, and nothing of Acme's row survives on screen.
    expect(view.getByTestId("bot-unavailable").textContent).toBe(
      "This Bot is not available here.",
    );
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByText("Acme Expenses")).toBeNull();
    expect(queryClient.getQueryData(detailKey(GLOBEX))).toBeUndefined();
  });

  test("a coworker that never existed says it in the same words", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/agents/ghost" ? jsonResponse(404, {}) : undefined,
    );
    const queryClient = freshClient();
    const view = drawFrame(queryClient, "ghost");
    // The same state, the same words: a reader cannot tell this apart from the switched case,
    // which is the whole point of answering one status for both.
    const missing = await waitFor(() => view.getByTestId("bot-unavailable"));
    expect(missing.textContent).toBe("This Bot is not available here.");
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByTestId("detail")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC3 — the configuration save submits the current scope; its rollback respects the generation
// ---------------------------------------------------------------------------

describe("MT084 AC3 — the save submits the scope and its optimistic row is generation-safe", () => {
  test("the PATCH carries the pair and paints the optimistic row in the scope's entry", async () => {
    storeSelection(USER, ACME);
    const patch = deferred<Response>();
    serve((path, init) => {
      if (path === "/api/agents/expenses" && init?.method === "PATCH") {
        return patch.promise as unknown as Response;
      }
      if (path === "/api/agents/expenses") {
        return jsonResponse(200, { agent: ACME_BOT });
      }
      return undefined;
    });
    const queryClient = freshClient();
    queryClient.setQueryData(detailKey(ACME), ACME_BOT);
    const view = drawSave(queryClient);
    const save = await waitFor(() => view.getByTestId("save"));

    await act(async () => {
      save.click();
    });
    // The save left with the scope's pair on it, and the row shows the person's typing at once —
    // in the scope's own entry, not in some unscoped one.
    const write = asked.find(
      (ask) =>
        ask.input === "/api/agents/expenses" && ask.init?.method === "PATCH",
    );
    expect(write).toBeTruthy();
    expect(headerOf(write?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(write?.init, "x-openbot-workspace")).toBe("acme-finance");
    expect(queryClient.getQueryData(detailKey(ACME))).toMatchObject({
      name: "Edited Expenses",
    });

    await act(async () => {
      patch.resolve(
        jsonResponse(200, { agent: { ...ACME_BOT, name: "Edited Expenses" } }),
      );
    });
    await settleSwitch();
    // The settle's invalidation corrects the row through the server's own answer; nothing about
    // the switch discipline disturbed the scope's entry on the way.
    expect(queryClient.getQueryData(detailKey(ACME))).toMatchObject({
      name: "Edited Expenses",
    });
  });

  test("a failed save restores the row while the scope holds", async () => {
    storeSelection(USER, ACME);
    const patch = deferred<Response>();
    serve((path, init) => {
      if (path === "/api/agents/expenses" && init?.method === "PATCH") {
        return patch.promise as unknown as Response;
      }
      return undefined;
    });
    const queryClient = freshClient();
    queryClient.setQueryData(detailKey(ACME), ACME_BOT);
    const view = drawSave(queryClient);
    const save = await waitFor(() => view.getByTestId("save"));
    await act(async () => {
      save.click();
    });
    expect(queryClient.getQueryData(detailKey(ACME))).toMatchObject({
      name: "Edited Expenses",
    });

    await act(async () => {
      patch.resolve(
        jsonResponse(500, { error: "The save did not go through." }),
      );
    });
    await settleSwitch();
    // The rollback landed: the row is the server's last word again, not the abandoned edit.
    expect(queryClient.getQueryData(detailKey(ACME))).toMatchObject({
      name: "Acme Expenses",
    });
  });

  test("a failed save after a switch rolls back nothing: the old entry stays gone", async () => {
    storeSelection(USER, ACME);
    const patch = deferred<Response>();
    serve((path, init) => {
      if (path === "/api/agents/expenses" && init?.method === "PATCH") {
        return patch.promise as unknown as Response;
      }
      return undefined;
    });
    const queryClient = freshClient();
    queryClient.setQueryData(detailKey(ACME), ACME_BOT);
    const view = drawSave(queryClient);
    const save = await waitFor(() => view.getByTestId("save"));
    await act(async () => {
      save.click();
    });

    // The switch happens while the save is in flight: its rollback must not resurrect the old
    // scope's entry, and must not touch the scope that replaced it.
    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    await act(async () => {
      patch.resolve(
        jsonResponse(500, { error: "The save did not go through." }),
      );
    });
    await settleSwitch();
    expect(queryClient.getQueryData(detailKey(ACME))).toBeUndefined();
    expect(queryClient.getQueryData(detailKey(GLOBEX))).toBeUndefined();
  });
});
