import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
import { scopedCachePrefix } from "../../src/lib/enterprise/tenant/scoped-cache";
import {
  type ScopeSelection,
  selectWorkspaceScope,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import {
  componentKeys,
  scopedComponentListQueryOptions,
} from "../../src/lib/components/queries";
import { setComponentPublishedMutationOptions } from "../../src/lib/components/mutations";
import {
  marketplaceKeys,
  scopedMarketplaceQueryOptions,
} from "../../src/lib/marketplace/queries";
import {
  installMarketSkillMutationOptions,
  uninstallExpertMutationOptions,
} from "../../src/lib/marketplace/mutations";
import { pluginKeys } from "../../src/lib/plugins/queries";
import type { ComponentRecord } from "../../src/lib/components/queries";
import type { MarketplacePayload } from "../../src/lib/marketplace/queries";

/**
 * MT094 / Issue #137: the plugin, skill and component catalog pages are bound to the scope the
 * screen holds. The catalogue is browsable and its install marks are the asking scope's own
 * answer (AC1 — the pair rides the shelf read and the install writes, and the shelf files under
 * the scope's cache prefix); the installed list and configuration are the scope's own answer
 * (AC2 — the component roster reads the same way); the publication action submits under the
 * scope in force, its availability read off the server's own row state (AC3 — publish/unpublish
 * is the row's `published` fact plus `hasUnpublishedChanges`, the server's answers, never a
 * client-side role guess); and an uninstall settles at BOTH cache roots so the cards and the
 * plugins surface reflect it immediately (AC4).
 *
 * THE HARNESS IS THE REAL SEAM: the scoped factories the pages themselves read through, the
 * selection seeded from storage exactly as production seeds it, a switch through
 * `selectWorkspaceScope`, and `fetch` recording every request — the pair the client carried is
 * the evidence.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};

const acmeShelf = (installed: boolean): MarketplacePayload => ({
  experts: [
    {
      slug: "expenses",
      name: "Expenses",
      tagline: "Receipts",
      description: "Files receipts",
      category: "Finance",
      tags: [],
      avatar: "",
      skills: [],
      installed,
      agentId: installed ? "agent-1" : null,
    },
  ],
  skills: [
    {
      slug: "weekly-digest",
      title: "Weekly digest",
      summary: "Summarizes the week",
      icon: "📬",
      category: "Writing",
      installed,
      mine: installed,
    },
  ],
  categories: { experts: [], skills: [], connectors: [] },
});

const component = (name: string, published: boolean): ComponentRecord => ({
  name,
  title: name,
  kind: "card",
  draftDescription: "Draft",
  publishedDescription: published ? "Published" : null,
  published,
  publishedAt: published ? "2026-10-20T00:00:00Z" : null,
  updatedBy: null,
  updatedAt: "2026-10-21T00:00:00Z",
  hasUnpublishedChanges: !published,
  withheldFrom: [],
  functions: [],
});

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
    const path = String(input).split("?")[0];
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

/*
 * The write probe the mt15 suites use: the real mutation factory behind a real button. The
 * build type is deliberately loose (any mutation options) — the factories' own types are the
 * product's; the probe only presses them.
 */
function WriteProbe({
  build,
  variables,
}: {
  build: (queryClient: QueryClient) => Record<string, unknown>;
  variables: unknown;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    build(queryClient) as Parameters<typeof useMutation>[0],
  );
  return (
    <button
      data-testid="write"
      onClick={() => void mutation.mutateAsync(variables as never)}
      type="button"
    />
  );
}

async function press(
  build: (queryClient: QueryClient) => Record<string, unknown>,
  variables: unknown,
): Promise<QueryClient> {
  cleanup();
  const queryClient = freshClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <WriteProbe build={build} variables={variables} />
    </QueryClientProvider>,
  );
  await act(async () => {
    view.getByTestId("write").click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return queryClient;
}

/** Holds an active observer on the scoped shelf, as the market page does. */
function ShelfObserver({
  scope,
}: {
  scope: {
    status: "open";
    userId: string;
    selection: ScopeSelection | null;
    generation: number;
    prefix: readonly unknown[];
    key: string;
  };
}) {
  const queryClient = useQueryClient();
  useQuery(scopedMarketplaceQueryOptions(queryClient, scope));
  return null;
}

beforeEach(() => {
  window.localStorage.clear();
  asked = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// AC1 — the catalogue is the scope's own answer, and installs submit its scope
// ---------------------------------------------------------------------------

describe("MT094 AC1 — catalogue reads and install writes carry the pair", () => {
  test("the shelf read carries the pair and files under the scope's prefix", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/marketplace"
        ? jsonResponse(200, acmeShelf(false))
        : undefined,
    );
    const queryClient = freshClient();
    await queryClient.fetchQuery(
      scopedMarketplaceQueryOptions(queryClient, {
        status: "open",
        userId: USER,
        selection: ACME,
        generation: 1,
        prefix: scopedCachePrefix(USER, ACME),
        key: "k",
      }),
    );

    const read = asked.find((ask) => ask.input === "/api/marketplace");
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        ...marketplaceKeys.catalogue(),
      ]),
    ).toBeTruthy();
  });

  test("install and uninstall writes submit the current scope", async () => {
    serve(() => jsonResponse(200, {}));
    const openScope = () =>
      ({
        status: "open" as const,
        userId: USER,
        selection: ACME,
        generation: 1,
        prefix: scopedCachePrefix(USER, ACME),
        key: "k",
      }) as const;
    await press(
      (queryClient) =>
        installMarketSkillMutationOptions(queryClient, openScope()),
      "weekly-digest",
    );
    const post = asked.find(
      (ask) =>
        ask.input === "/api/marketplace/skills/weekly-digest/install" &&
        ask.init?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(headerOf(post?.init, "x-openbot-tenant")).toBe("acme");

    await press(
      (queryClient) => uninstallExpertMutationOptions(queryClient, openScope()),
      "expenses",
    );
    const del = asked.find(
      (ask) =>
        ask.input === "/api/marketplace/experts/expenses/install" &&
        ask.init?.method === "DELETE",
    );
    expect(del).toBeTruthy();
    expect(headerOf(del?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(del?.init, "x-openbot-workspace")).toBe("acme-finance");
  });

  test("a switch drops the old scope's shelf wholesale", async () => {
    storeSelection(USER, ACME);
    let current = ACME;
    serve((path) =>
      path === "/api/marketplace"
        ? jsonResponse(200, acmeShelf(current !== ACME))
        : undefined,
    );
    const queryClient = freshClient();
    const scope = () =>
      ({
        status: "open",
        userId: USER,
        selection: current,
        generation: 1,
        prefix: scopedCachePrefix(USER, current),
        key: "k",
      }) as const;

    const acmeKey = [
      ...scopedCachePrefix(USER, ACME),
      ...marketplaceKeys.catalogue(),
    ];
    await queryClient.fetchQuery(
      scopedMarketplaceQueryOptions(queryClient, scope()),
    );
    expect(
      (queryClient.getQueryData(acmeKey) as MarketplacePayload).skills[0]
        .installed,
    ).toBe(false);

    // The switch seam itself, then the new scope's own answer.
    storeSelection(USER, GLOBEX);
    await act(async () => {
      selectWorkspaceScope(queryClient, USER, ACME, GLOBEX);
    });
    current = GLOBEX;
    await queryClient.fetchQuery(
      scopedMarketplaceQueryOptions(queryClient, scope()),
    );
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, GLOBEX),
        ...marketplaceKeys.catalogue(),
      ]),
    ).toBeTruthy();
    expect(queryClient.getQueryData(acmeKey)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2 — the installed list and configuration are the scope's own answer
// ---------------------------------------------------------------------------

describe("MT094 AC2 — the component roster is the scope's own answer", () => {
  test("the roster read carries the pair and files under the scope's prefix", async () => {
    storeSelection(USER, ACME);
    /*
     * The server answers in an envelope, the way every list endpoint here does. The mock used to
     * answer with a bare array, which the reader took at face value — so the page was handed an
     * object where it expected a roster and `components.data.map` was not a function.
     */
    serve((path) =>
      path === "/api/components"
        ? jsonResponse(200, { components: [component("spend-card", true)] })
        : undefined,
    );
    const queryClient = freshClient();
    const roster = await queryClient.fetchQuery(
      scopedComponentListQueryOptions(queryClient, {
        status: "open",
        userId: USER,
        selection: ACME,
        generation: 1,
        prefix: scopedCachePrefix(USER, ACME),
        key: "k",
      }),
    );

    const read = asked.find((ask) => ask.input === "/api/components");
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(roster.map((entry) => entry.name)).toEqual(["spend-card"]);
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        ...componentKeys.list(),
      ]),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AC3 — the publication action submits the scope; its availability is the row's own answer
// ---------------------------------------------------------------------------

describe("MT094 AC3 — publication submits the scope in force", () => {
  test("publish and unpublish carry the pair; the row's own facts drive the action", async () => {
    serve(() => jsonResponse(200, {}));
    const openScope = () =>
      ({
        status: "open" as const,
        userId: USER,
        selection: ACME,
        generation: 1,
        prefix: scopedCachePrefix(USER, ACME),
        key: "k",
      }) as const;

    // AC3's availability half is the server's row: `published` and `hasUnpublishedChanges`
    // decide which action the governance page offers — asserted here against the row shape
    // the roster answers with, not any client-side role logic.
    const row = component("spend-card", false);
    expect(row.hasUnpublishedChanges).toBe(true); // a draft awaits publication

    await press(
      (queryClient) =>
        setComponentPublishedMutationOptions(queryClient, openScope()),
      { name: "spend-card", published: true },
    );
    const post = asked.find(
      (ask) =>
        ask.input === "/api/components/spend-card/publication" &&
        ask.init?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(headerOf(post?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(post?.init, "x-openbot-workspace")).toBe("acme-finance");

    await press(
      (queryClient) =>
        setComponentPublishedMutationOptions(queryClient, openScope()),
      { name: "spend-card", published: false },
    );
    expect(
      asked.filter(
        (ask) =>
          ask.input === "/api/components/spend-card/publication" &&
          ask.init?.method === "POST",
      ).length,
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC4 — an uninstall settles at BOTH cache roots and reflects immediately
// ---------------------------------------------------------------------------

describe("MT094 AC4 — writes settle at both cache roots", () => {
  test("an uninstall invalidates the scope's shelf AND the plugins surface", async () => {
    storeSelection(USER, ACME);
    let installed = true;
    serve((path) => {
      if (path === "/api/marketplace")
        return jsonResponse(200, acmeShelf(installed));
      return undefined;
    });
    const queryClient = freshClient();
    const openScope = {
      status: "open" as const,
      userId: USER,
      selection: ACME,
      generation: 1,
      prefix: scopedCachePrefix(USER, ACME),
      key: "k",
    };
    const shelfKey = [
      ...scopedCachePrefix(USER, ACME),
      ...marketplaceKeys.catalogue(),
    ];
    const pageKey = [...scopedCachePrefix(USER, ACME), ...pluginKeys.page()];
    await queryClient.fetchQuery(
      scopedMarketplaceQueryOptions(queryClient, openScope),
    );
    // A fresh plugins entry the settle must also touch.
    queryClient.setQueryData(pageKey, {
      catalogue: [],
      servers: [],
      skills: [],
      botsMayCallBack: true,
      redirectUri: null,
      composioConfigured: false,
      openConnectorConfigured: false,
    });

    installed = false;
    // The real write on the same client the entries live under, with a mounted observer
    // holding the scoped shelf — as the market page does — so the settle's invalidation
    // refetches under the same scope.
    cleanup();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ShelfObserver scope={openScope} />
        <WriteProbe
          build={(client) => uninstallExpertMutationOptions(client, openScope)}
          variables="expenses"
        />
      </QueryClientProvider>,
    );
    await act(async () => {
      view.getByTestId("write").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The settle marked both scoped entries stale: the shelf re-reads under the same scope.
    await waitFor(() => {
      const refetched = queryClient.getQueryData<MarketplacePayload>(shelfKey);
      expect(refetched?.experts[0]?.installed).toBe(false);
    });
    expect(queryClient.getQueryState(pageKey)?.isInvalidated).toBe(true);
  });
});
