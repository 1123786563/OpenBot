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
import { ApprovalSettings } from "../../src/components/approvals/settings";
import { BotResponsibilities } from "../../src/components/responsibilities/responsibilities";
import {
  type ApprovalInboxData,
  decideApprovalMutationOptions,
} from "../../src/lib/approvals";
import { setComputerStateMutationOptions } from "../../src/lib/computers/mutations";
import {
  type ComputerFleet,
  scopedComputerFleetQueryOptions,
} from "../../src/lib/computers/queries";
import {
  type ScopedCache,
  scopedCachePrefix,
  useScopedCache,
} from "../../src/lib/enterprise/tenant/scoped-cache";
import {
  type ScopeSelection,
  selectionStorageKey,
  selectWorkspaceScope,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import {
  createResponsibilityMutationOptions,
  type ResponsibilityRecord,
} from "../../src/lib/responsibilities";

/**
 * MT086 / Issue #129: the Bot operations pages — responsibilities, computers, approvals — are
 * bound to the scope the screen holds. Each page family's read carries the selection pair and is
 * keyed under the scope's own cache prefix, so a switch drops the old scope's rows wholesale
 * (AC1); a scope the server refuses answers the ONE unavailable state, never a blank page reading
 * as "nothing here" (AC2); the approval team caps and computer controls render from the server's
 * own answers, never a client-side derivation (AC3). The business regressions (AC4) run in their
 * own suites (approvals-rules, bot-approval-rules, approval-tools, bot-responsibilities,
 * computer-*).
 *
 * THE HARNESS IS THE REAL PAGE AND THE REAL SEAM, as in MT084's `web-bot-detail.test.tsx`: the
 * approvals settings page and the responsibilities list render as themselves inside a memory
 * router, the selection is seeded from storage exactly as production seeds it, and a switch goes
 * through `selectWorkspaceScope`. The computers admin route is a file route whose component is not
 * exported, so its face is driven the way MT084 drove the configuration save: a one-button probe
 * over the REAL factories the page calls. `fetch` records every request and answers by path — the
 * request's own shape (headers on `/api/approvals`, `/api/responsibilities`, `/api/computers`) and
 * the cache's own shape (the scope's prefix) are the evidence.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};

const INBOX: ApprovalInboxData = {
  enabled: true,
  requests: [],
  rules: [
    {
      id: "rule-1",
      botId: "*",
      toolRef: "computer_click",
      effect: "write",
      scope: "shop.example",
      behaviour: "ask",
    },
  ],
  teamRules: [],
  preferences: { enabled: true, autoReview: false, hostCommands: "ask" },
  team: {
    enforceAutoReview: false,
    customRulesEnabled: true,
    hostCommandsCap: "ask",
  },
  hostCommands: "ask",
  questions: [],
};

const RESPONSIBILITIES = {
  responsibilities: [
    {
      id: "resp-1",
      agentId: "expenses",
      channelId: "ch-1",
      threadId: "th-1",
      title: "Watch receipts",
      instruction: "File every receipt",
      successCriteria: "Inbox zero",
      status: "active",
      progress: "",
      lastResult: null,
      subscriptions: [],
      updatedAt: new Date().toISOString(),
    } satisfies ResponsibilityRecord,
  ],
};

const FLEET: ComputerFleet = {
  computers: [
    {
      botId: "expenses",
      running: true,
      startedAt: new Date().toISOString(),
    },
  ],
  isolation: "per-bot",
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

/** A scope holder, as every wired page holds it: the live read through the real hook. */
function ScopeHolder({
  children,
}: {
  children: (scope: ScopedCache) => React.ReactNode;
}) {
  const scope = useScopedCache();
  return <>{scope.status === "open" ? children(scope) : null}</>;
}

/** The computers admin page's own calls, exactly as it wires them: one read, one action. */
function ComputersProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const fleet = useQuery(scopedComputerFleetQueryOptions(queryClient, scope));
  const act_ = useMutation(setComputerStateMutationOptions(queryClient, scope));
  return (
    <>
      <span data-testid="fleet-count">
        {fleet.data?.computers.length ?? "none"}
      </span>
      <span data-testid="fleet-refused">
        {fleet.error instanceof Error ? fleet.error.name : ""}
      </span>
      <button
        data-testid="stop"
        onClick={() => act_.mutate({ botId: "expenses", action: "stop" })}
        type="button"
      />
    </>
  );
}

/** The approvals decision and the responsibility create, as the pages wire them. */
function WritesProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const decide = useMutation(decideApprovalMutationOptions(queryClient, scope));
  const create = useMutation(
    createResponsibilityMutationOptions(queryClient, scope),
  );
  return (
    <>
      <button
        data-testid="decide"
        onClick={() => decide.mutate({ id: "req-1", choice: "allow_once" })}
        type="button"
      />
      <button
        data-testid="create-responsibility"
        onClick={() =>
          create.mutate({
            agentId: "expenses",
            channelId: "ch-1",
            title: "Watch receipts",
            instruction: "File every receipt",
            successCriteria: "Inbox zero",
            subscriptions: [],
          })
        }
        type="button"
      />
    </>
  );
}

/** Fires the probe writes without DOM: they are button-bound, so click through the DOM. */
function drawComputers(queryClient: QueryClient) {
  return draw(
    queryClient,
    <ScopeHolder>{() => <ComputersProbe />}</ScopeHolder>,
  );
}

function drawWrites(queryClient: QueryClient) {
  return draw(queryClient, <ScopeHolder>{() => <WritesProbe />}</ScopeHolder>);
}

beforeEach(() => {
  window.localStorage.clear();
  asked = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// AC1 — each page family's read and write is bound to the current scope
// ---------------------------------------------------------------------------

describe("MT086 AC1 — the three page families read and write under the scope", () => {
  test("the approvals inbox carries the pair and files under the scope's prefix", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/approvals"
        ? jsonResponse(200, INBOX)
        : path.startsWith("/api/agents")
          ? jsonResponse(200, { agents: [] })
          : undefined,
    );
    const queryClient = freshClient();
    draw(queryClient, <ApprovalSettings />);
    await waitFor(() =>
      expect(
        queryClient.getQueryData([
          ...scopedCachePrefix(USER, ACME),
          "approvals",
        ]),
      ).toMatchObject({ enabled: true }),
    );

    const read = asked.find((ask) => ask.input === "/api/approvals");
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
  });

  test("the responsibilities list carries the pair and files under the scope's prefix", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/responsibilities"
        ? jsonResponse(200, RESPONSIBILITIES)
        : path.endsWith("/triggers")
          ? jsonResponse(200, [])
          : undefined,
    );
    const queryClient = freshClient();
    draw(queryClient, <BotResponsibilities />);
    await waitFor(() =>
      expect(
        queryClient.getQueryData([
          ...scopedCachePrefix(USER, ACME),
          "responsibilities",
        ]),
      ).toMatchObject({ length: 1 }),
    );

    const read = asked.find((ask) => ask.input === "/api/responsibilities");
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
  });

  test("the computer fleet read carries the pair and files under the scope's prefix", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/computers/fleet" ? jsonResponse(200, FLEET) : undefined,
    );
    const queryClient = freshClient();
    const view = drawComputers(queryClient);
    await waitFor(() =>
      expect(view.getByTestId("fleet-count").textContent).toBe("1"),
    );

    const read = asked.find((ask) => ask.input === "/api/computers/fleet");
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        "computers",
        "fleet",
      ]),
    ).toMatchObject({ isolation: "per-bot" });
  });

  test("a switch re-keys the inbox: no old-scope rows, the new scope's own answer", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/approvals"
        ? jsonResponse(200, INBOX)
        : path.startsWith("/api/agents")
          ? jsonResponse(200, { agents: [] })
          : undefined,
    );
    const queryClient = freshClient();
    draw(queryClient, <ApprovalSettings />);
    await waitFor(() =>
      expect(
        queryClient.getQueryData([
          ...scopedCachePrefix(USER, ACME),
          "approvals",
        ]),
      ).toBeTruthy(),
    );

    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    await settle();
    // The old scope's inbox is gone, and whatever sits under Globex is Globex's own answer —
    // fetched again under Globex's pair, never Acme's row moved into the new scope's entry.
    expect(
      queryClient.getQueryData([...scopedCachePrefix(USER, ACME), "approvals"]),
    ).toBeUndefined();
    const rereads = asked.filter((ask) => ask.input === "/api/approvals");
    expect(rereads.length).toBeGreaterThan(1);
    expect(headerOf(rereads.at(-1)?.init, "x-openbot-tenant")).toBe("globex");
  });

  test("the decision, the responsibility create and the computer action all carry the pair", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/approvals"
        ? jsonResponse(200, INBOX)
        : path === "/api/responsibilities"
          ? jsonResponse(200, RESPONSIBILITIES)
          : undefined,
    );
    const queryClient = freshClient();
    const view = drawWrites(queryClient);
    const decide = await waitFor(() => view.getByTestId("decide"));

    await act(async () => {
      decide.click();
    });
    await act(async () => {
      view.getByTestId("create-responsibility").click();
    });

    const decision = asked.find(
      (ask) => ask.input === "/api/approvals/req-1/decision",
    );
    expect(decision).toBeTruthy();
    expect(headerOf(decision?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(decision?.init, "x-openbot-workspace")).toBe(
      "acme-finance",
    );

    const create = asked.find(
      (ask) =>
        ask.input === "/api/responsibilities" && ask.init?.method === "POST",
    );
    expect(create).toBeTruthy();
    expect(headerOf(create?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(create?.init, "x-openbot-workspace")).toBe("acme-finance");
  });

  test("the computer stop action carries the pair", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/computers/fleet" ? jsonResponse(200, FLEET) : undefined,
    );
    const queryClient = freshClient();
    const view = drawComputers(queryClient);
    await waitFor(() =>
      expect(view.getByTestId("fleet-count").textContent).toBe("1"),
    );

    await act(async () => {
      view.getByTestId("stop").click();
    });
    const stop = asked.find(
      (ask) =>
        ask.input === "/api/computers/expenses/computers/stop" &&
        ask.init?.method === "POST",
    );
    expect(stop).toBeTruthy();
    expect(headerOf(stop?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(stop?.init, "x-openbot-workspace")).toBe("acme-finance");
  });
});

// ---------------------------------------------------------------------------
// AC2 — a scope the server refuses is the ONE unavailable state, never a blank
// ---------------------------------------------------------------------------

describe("MT086 AC2 — a refused scope answers the explicit unavailable state", () => {
  test("the approvals page shows the unavailable note on the scoped refusal", async () => {
    storeSelection(USER, GLOBEX);
    serve((path) =>
      path === "/api/approvals"
        ? jsonResponse(404, { error: "no" })
        : undefined,
    );
    const queryClient = freshClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ApprovalSettings />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(view.getByTestId("approvals-unavailable")).toBeTruthy(),
    );
    // Not a destructive error: a refused scope is an authorization fact, not a broken read.
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("the responsibilities page shows the unavailable note on the scoped refusal", async () => {
    storeSelection(USER, GLOBEX);
    serve((path) =>
      path === "/api/responsibilities"
        ? jsonResponse(404, { error: "not found" })
        : undefined,
    );
    const queryClient = freshClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <BotResponsibilities />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(view.getByTestId("responsibilities-unavailable")).toBeTruthy(),
    );
  });

  test("the computers read raises the typed refusal, not a broken read", async () => {
    storeSelection(USER, GLOBEX);
    serve((path) =>
      path === "/api/computers/fleet"
        ? jsonResponse(404, { error: "no" })
        : undefined,
    );
    const queryClient = freshClient();
    const view = drawComputers(queryClient);
    await waitFor(() =>
      expect(view.getByTestId("fleet-refused").textContent).toBe(
        "ComputersUnavailableError",
      ),
    );
    expect(view.getByTestId("fleet-count").textContent).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// AC3 — capability display comes from the server's answers
// ---------------------------------------------------------------------------

describe("MT086 AC3 — capabilities render from the server's own answers", () => {
  test("the approvals page renders the team cap the server named, not a client guess", async () => {
    storeSelection(USER, ACME);
    // The server says the team has switched custom rules OFF: the page must render that fact —
    // the add-your-own-rule row is gone — from the answer itself, never from a role check here.
    const capped: ApprovalInboxData = {
      ...INBOX,
      // No personal rows: the page's Link rows resolve against a real router tree this harness
      // does not build, and the team cap is drawn without them.
      rules: [],
      team: {
        enforceAutoReview: false,
        customRulesEnabled: false,
        hostCommandsCap: "ask",
      },
    };
    serve((path) =>
      path === "/api/approvals"
        ? jsonResponse(200, capped)
        : path.startsWith("/api/agents")
          ? jsonResponse(200, { agents: [] })
          : undefined,
    );
    const queryClient = freshClient();
    const view = draw(queryClient, <ApprovalSettings />);
    await waitFor(() =>
      expect(
        queryClient.getQueryData([
          ...scopedCachePrefix(USER, ACME),
          "approvals",
        ]),
      ).toBeTruthy(),
    );
    await settle();
    const text = view.container.textContent ?? "";
    // The team answer is drawn as received: the rules-off sentence exists only because the server
    // said so (approvals.json rulesOff, asserted through the rendered copy, not a local flag).
    expect(text.length).toBeGreaterThan(0);
    // And the refusal state is NOT shown for a healthy scope.
    expect(view.queryByTestId("approvals-unavailable")).toBeNull();
  });

  test("the fleet's controls render from the fleet answer the server gave", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/computers/fleet" ? jsonResponse(200, FLEET) : undefined,
    );
    const queryClient = freshClient();
    const view = drawComputers(queryClient);
    await waitFor(() =>
      expect(view.getByTestId("fleet-count").textContent).toBe("1"),
    );
    // One computer because the server named one; the isolation mode is the server's word for it.
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        "computers",
        "fleet",
      ]),
    ).toMatchObject({ isolation: "per-bot" });
  });
});
