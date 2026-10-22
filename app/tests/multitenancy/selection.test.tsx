import "../preload";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "../../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { client } from "../../src/lib/client";
import {
  type ChannelPage,
  channelsQueryOptions,
  selectTenant,
  TenantSelectionChangedError,
  tenantKeys,
} from "../../src/lib/enterprise/tenant/queries";
import {
  readStoredSelection,
  type ScopeSelection,
  scopeRefusalOf,
  selectionFromSources,
  selectionKeys,
  selectionState,
  selectWorkspaceScope,
  storeSelection,
  type WorkspaceScopeListing,
  WorkspaceScopeRefusedError,
  workspaceScopeListingQueryOptions,
} from "../../src/lib/enterprise/tenant/selection";
import enTenant from "../../src/locales/en/tenant.json";
import zhTenant from "../../src/locales/zh-CN/tenant.json";
import { Route as SelectionRoute } from "../../src/routes/_authed/tenant/selection";

/**
 * The company-and-team selection surface, MT080 / Issue #123.
 *
 * THREE THINGS ARE UNDER TEST HERE. First, the selection state machine over the real MT006
 * listing contract (`GET /api/enterprise/workspace-scope`): loading, failure, the no-eligibility
 * empty state, the eligible nothing-selected state, and the revoked state — every one explicit,
 * none falling back to a default scope. Second, the switch discipline: the selection moves the
 * SAME cache generation the tenant channels surface guards its reads with, so an in-flight
 * response that outlives its scope is refused on arrival (spec A10) instead of decorating the new
 * scope. Third, the page itself rendering each state, including "nothing is chosen for you" (the
 * selector never auto-picks the first company or any team), and the two bundles carrying the
 * selection strings together.
 *
 * THE WIRE SHAPES ARE THE MT006 LISTER'S (server/src/enterprise/tenancy/workspace-admin.ts). The
 * listing answers with `{ companies: [...] }` and never with a current/default/selected field;
 * the stubs here answer with exactly that shape, so a server drift is this file's failure.
 *
 * THE HARNESS IS THIS REPOSITORY'S, as in `enterprise-session.test.ts` (fetch interception against
 * a real QueryClient), `agent-roster-error.test.tsx` (GlobalRegistrator + testing-library) and
 * `skills-read-failure.test.tsx` (the exported Route singleton captured, re-parented, restored).
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

type Asked = { input: RequestInfo | URL; init: RequestInit | undefined };

/** The listing as the MT006 lister answers it: two companies, cross-company, one admin. */
const LISTING: WorkspaceScopeListing = {
  companies: [
    {
      tenantId: "acme",
      name: "Acme Inc",
      role: "member",
      memberEpoch: 3,
      teams: [
        { workspaceId: "acme-finance", name: "Finance" },
        { workspaceId: "acme-sales", name: "Sales" },
      ],
    },
    {
      tenantId: "globex",
      name: "Globex",
      role: "admin",
      memberEpoch: 7,
      teams: [{ workspaceId: "globex-ops", name: "Operations" }],
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function contextOf<C>(
  queryKey: readonly unknown[],
  queryClient: QueryClient,
): C {
  return {
    client: queryClient,
    queryKey: [...queryKey],
    signal: new AbortController().signal,
    meta: undefined,
  } as C;
}

// ---------------------------------------------------------------------------
// 1. Keys — one mechanism, the tenant scope prefix owns the workspace subtree
// ---------------------------------------------------------------------------

test("every selection key names the user and rides the existing tenant scope prefixes", () => {
  expect([...selectionKeys.listing("u-1")]).toEqual([
    "enterprise-tenant",
    "u-1",
    ":workspace-scope",
  ]);
  expect([
    ...selectionKeys.workspaceScope("u-1", "acme", "acme-finance"),
  ]).toEqual([
    "enterprise-tenant",
    "u-1",
    "acme",
    ":workspace",
    "acme-finance",
  ]);
  // The workspace subtree lives under the tenant scope prefix, so the tenant switch's
  // removal covers it — team selection added on top, not a second cache to forget.
  const workspaceKey = [
    ...selectionKeys.workspaceScope("u-1", "acme", "acme-finance"),
  ];
  const tenantScopePrefix = [...tenantKeys.scope("u-1", "acme")];
  expect(workspaceKey.slice(0, tenantScopePrefix.length)).toEqual(
    tenantScopePrefix,
  );
  // The reserved `:workspace` token cannot collide with the channels keys at the same depth.
  expect(workspaceKey[3]).not.toBe("channels");
  expect(workspaceKey[3]).not.toBe("channel");
});

// ---------------------------------------------------------------------------
// 2. The listing read — the MT006 contract, answered before any scope exists
// ---------------------------------------------------------------------------

test("the listing read calls the workspace-scope endpoint and carries no selection header", async () => {
  const asked: Asked[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ input, init });
    return jsonResponse(200, LISTING);
  }) as unknown as typeof fetch;
  const queryClient = freshClient();

  const data = await queryClient.fetchQuery(
    workspaceScopeListingQueryOptions("u-1"),
  );

  expect(data.companies.map((company) => company.tenantId)).toEqual([
    "acme",
    "globex",
  ]);
  expect(asked[0]?.input).toBe("/api/enterprise/workspace-scope");
  // Ruling #1: the listing selects nothing — no tenant, no workspace header.
  expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBeUndefined();
  expect(headerOf(asked[0]?.init, "x-openbot-workspace")).toBeUndefined();
});

test("a refused listing is a typed refusal carrying the status and the server's code", async () => {
  global.fetch = (async () =>
    jsonResponse(401, {
      error: { code: "AUTH_REQUIRED", message: "Request refused." },
    })) as unknown as typeof fetch;
  const queryClient = freshClient();

  let caught: unknown = null;
  try {
    await queryClient.fetchQuery(workspaceScopeListingQueryOptions("u-1"));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkspaceScopeRefusedError);
  const refusal = caught as WorkspaceScopeRefusedError;
  expect(refusal.status).toBe(401);
  expect(refusal.code).toBe("AUTH_REQUIRED");
  expect(scopeRefusalOf(refusal)).toBe(refusal);
  // An ordinary failure is not a refusal.
  expect(scopeRefusalOf(new Error("boom"))).toBeNull();
});

test("a malformed listing is a refusal, never a silent empty answer", async () => {
  global.fetch = (async () =>
    jsonResponse(200, {
      noted: "the gateway answered, but not with a listing",
    })) as unknown as typeof fetch;
  const queryClient = freshClient();

  let caught: unknown = null;
  try {
    await queryClient.fetchQuery(workspaceScopeListingQueryOptions("u-1"));
  } catch (error) {
    caught = error;
  }
  // A broken body must not read as "you have no companies" (the empty-state lie this
  // repository's tests exist to kill); it is an error the page retries.
  expect(caught).toBeInstanceOf(WorkspaceScopeRefusedError);
  expect((caught as WorkspaceScopeRefusedError).code).toBe(
    "WORKSPACE_SCOPE_MALFORMED",
  );
});

// ---------------------------------------------------------------------------
// 3. The state machine — five explicit kinds, none invented, none defaulted
// ---------------------------------------------------------------------------

const ACME_FINANCE: ScopeSelection = {
  tenantId: "acme",
  workspaceId: "acme-finance",
};

test("the state machine answers loading, error, empty, ready, selected, revoked — in that order of facts", () => {
  expect(selectionState({ status: "pending" }, null)).toEqual({
    kind: "loading",
  });
  expect(selectionState({ status: "error" }, ACME_FINANCE)).toEqual({
    kind: "error",
  });
  // An empty listing is an empty answer, not an error and not a suggestion.
  expect(
    selectionState({ status: "success", listing: { companies: [] } }, null),
  ).toEqual({ kind: "empty" });
  // Eligible companies but nothing chosen: ready, and NOTHING is selected for you.
  expect(selectionState({ status: "success", listing: LISTING }, null)).toEqual(
    {
      kind: "ready",
    },
  );

  const selected = selectionState(
    { status: "success", listing: LISTING },
    ACME_FINANCE,
  );
  expect(selected.kind).toBe("selected");
  if (selected.kind === "selected") {
    expect(selected.company.name).toBe("Acme Inc");
    expect(selected.team.name).toBe("Finance");
  }

  // The company vanished from the listing: revoked.
  expect(
    selectionState(
      { status: "success", listing: LISTING },
      {
        tenantId: "initech",
        workspaceId: "initech-ops",
      },
    ).kind,
  ).toBe("revoked");
  // The company is still there but the team row is gone: revoked just the same.
  expect(
    selectionState(
      { status: "success", listing: LISTING },
      {
        tenantId: "acme",
        workspaceId: "acme-marketing",
      },
    ).kind,
  ).toBe("revoked");
  // A failure is never promoted to a revocation: infrastructure trouble says so.
  expect(selectionState({ status: "error" }, ACME_FINANCE).kind).toBe("error");
});

test("selection resolution: the URL wins when present, storage fills only a silent URL, partial URL selects nothing", () => {
  const stored: ScopeSelection = {
    tenantId: "globex",
    workspaceId: "globex-ops",
  };
  expect(
    selectionFromSources({ company: "acme", team: "acme-sales" }, stored),
  ).toEqual({ tenantId: "acme", workspaceId: "acme-sales" });
  // A deep link that names only a company is an incomplete scope, not half of the stored one.
  expect(selectionFromSources({ company: "acme" }, stored)).toBeNull();
  expect(selectionFromSources({ team: "acme-sales" }, stored)).toBeNull();
  // No URL at all: the user's own last explicit choice speaks.
  expect(selectionFromSources({}, stored)).toEqual(stored);
  expect(selectionFromSources({}, null)).toBeNull();
});

// ---------------------------------------------------------------------------
// 4. The switch — the SAME generation the channels surface guards its reads with
// ---------------------------------------------------------------------------

function pageOf(...channelIds: string[]): ChannelPage {
  return {
    items: channelIds.map((channelId) => ({
      channelId,
      botId: `bot-for-${channelId}`,
      threadId: `thread-for-${channelId}`,
      mode: "single",
      status: "active",
    })),
    nextCursor: null,
  };
}

function generationOf(queryClient: QueryClient, userId: string): number {
  return queryClient.getQueryData<number>(tenantKeys.generation(userId)) ?? 0;
}

test("switching companies drops the old company's whole subtree and advances the shared generation", async () => {
  const queryClient = freshClient();
  global.fetch = (async () =>
    jsonResponse(200, pageOf("ch-1"))) as unknown as typeof fetch;
  await queryClient.fetchQuery(
    channelsQueryOptions(queryClient, "u-1", "acme"),
  );
  queryClient.setQueryData(
    selectionKeys.workspaceScope("u-1", "acme", "acme-finance"),
    { scope: "acme-finance" },
  );
  queryClient.setQueryData(tenantKeys.chooser("u-1"), { items: [] });
  const before = generationOf(queryClient, "u-1");

  selectWorkspaceScope(queryClient, "u-1", ACME_FINANCE, {
    tenantId: "globex",
    workspaceId: "globex-ops",
  });

  expect(generationOf(queryClient, "u-1")).toBe(before + 1);
  // The old company's channels cache — another surface's — went with the switch.
  expect(
    queryClient.getQueryData(tenantKeys.channels("u-1", "acme", null)),
  ).toBeUndefined();
  expect(
    queryClient.getQueryData(
      selectionKeys.workspaceScope("u-1", "acme", "acme-finance"),
    ),
  ).toBeUndefined();
  // The chooser (pre-selection) is nobody's scope to drop.
  expect(
    queryClient.getQueryData(tenantKeys.chooser("u-1")) as unknown,
  ).toEqual({
    items: [],
  });
});

test("switching teams inside one company drops only the old team's subtree", () => {
  const queryClient = freshClient();
  queryClient.setQueryData(
    selectionKeys.workspaceScope("u-1", "acme", "acme-finance"),
    { scope: "acme-finance" },
  );
  queryClient.setQueryData(
    selectionKeys.workspaceScope("u-1", "acme", "acme-sales"),
    { scope: "acme-sales" },
  );
  const before = generationOf(queryClient, "u-1");

  selectWorkspaceScope(queryClient, "u-1", ACME_FINANCE, {
    tenantId: "acme",
    workspaceId: "acme-sales",
  });

  expect(generationOf(queryClient, "u-1")).toBe(before + 1);
  expect(
    queryClient.getQueryData(
      selectionKeys.workspaceScope("u-1", "acme", "acme-finance"),
    ),
  ).toBeUndefined();
  // A team the user still belongs to keeps its cache; leaving one team is not leaving the company.
  expect(
    queryClient.getQueryData(
      selectionKeys.workspaceScope("u-1", "acme", "acme-sales"),
    ) as unknown,
  ).toEqual({ scope: "acme-sales" });
});

test("re-selecting the selection already selected changes nothing", () => {
  const queryClient = freshClient();
  queryClient.setQueryData(
    selectionKeys.workspaceScope("u-1", "acme", "acme-finance"),
    { scope: "acme-finance" },
  );
  const before = generationOf(queryClient, "u-1");

  selectWorkspaceScope(queryClient, "u-1", ACME_FINANCE, ACME_FINANCE);

  expect(generationOf(queryClient, "u-1")).toBe(before);
  expect(
    queryClient.getQueryData(
      selectionKeys.workspaceScope("u-1", "acme", "acme-finance"),
    ) as unknown,
  ).toEqual({ scope: "acme-finance" });
});

test("a response that outlives a company switch through the selection layer is refused", async () => {
  let release: ((response: Response) => void) | undefined;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  global.fetch = (async () => held) as unknown as typeof fetch;
  const queryClient = freshClient();
  const options = channelsQueryOptions(queryClient, "u-1", "acme");

  const inFlight = options.queryFn?.(contextOf(options.queryKey, queryClient));
  selectWorkspaceScope(queryClient, "u-1", ACME_FINANCE, {
    tenantId: "globex",
    workspaceId: "globex-ops",
  });
  release?.(jsonResponse(200, pageOf("ch-1")));

  await expect(inFlight).rejects.toBeInstanceOf(TenantSelectionChangedError);
  // And nothing landed under the new company either.
  expect(
    queryClient.getQueryData(tenantKeys.channels("u-1", "globex", null)),
  ).toBeUndefined();
});

test("the selection layer's switch and selectTenant drive one generation", () => {
  const queryClient = freshClient();
  const before = generationOf(queryClient, "u-1");

  selectTenant(queryClient, "u-1", null, "acme");
  const afterTenant = generationOf(queryClient, "u-1");
  expect(afterTenant).toBe(before + 1);

  selectWorkspaceScope(
    queryClient,
    "u-1",
    { tenantId: "acme", workspaceId: "acme-finance" },
    { tenantId: "globex", workspaceId: "globex-ops" },
  );
  expect(generationOf(queryClient, "u-1")).toBe(afterTenant + 1);
});

// ---------------------------------------------------------------------------
// 5. Persistence — the user's own explicit choice, per account, never invented
// ---------------------------------------------------------------------------

test("a stored selection round-trips per user and never leaks across accounts", () => {
  expect(readStoredSelection("u-1")).toBeNull();
  storeSelection("u-1", ACME_FINANCE);
  expect(readStoredSelection("u-1")).toEqual(ACME_FINANCE);
  // Another account on this browser reads its own (empty) selection.
  expect(readStoredSelection("u-2")).toBeNull();
  storeSelection("u-2", { tenantId: "globex", workspaceId: "globex-ops" });
  expect(readStoredSelection("u-1")).toEqual(ACME_FINANCE);
  expect(readStoredSelection("u-2")).toEqual({
    tenantId: "globex",
    workspaceId: "globex-ops",
  });
});

test("a corrupted or wrong-shaped stored selection reads as nothing, without throwing", () => {
  globalThis.window.localStorage.setItem(
    "openbot.workspace-scope.v1:u-1",
    "{not json",
  );
  expect(readStoredSelection("u-1")).toBeNull();
  globalThis.window.localStorage.setItem(
    "openbot.workspace-scope.v1:u-1",
    JSON.stringify({ tenantId: "acme" }),
  );
  expect(readStoredSelection("u-1")).toBeNull();
  globalThis.window.localStorage.setItem(
    "openbot.workspace-scope.v1:u-1",
    JSON.stringify({ tenantId: 7, workspaceId: null }),
  );
  expect(readStoredSelection("u-1")).toBeNull();
});

// ---------------------------------------------------------------------------
// 6. The page — every state has a face, and nothing is chosen for you
// ---------------------------------------------------------------------------

let selectionRouteSnapshot: Record<string, unknown>;

function routeOptionsOf(route: object): Record<string, unknown> {
  return { ...(route as unknown as { options: object }).options };
}

beforeEach(() => {
  selectionRouteSnapshot = { options: routeOptionsOf(SelectionRoute) };
  globalThis.window.localStorage.clear();
});

afterEach(() => {
  Object.assign(
    SelectionRoute as unknown as Record<string, unknown>,
    selectionRouteSnapshot,
  );
  global.fetch = originalFetch;
});

type ListingAnswer =
  | { status: number; body: unknown }
  | (() => Response | Promise<Response>);

/** Serves `/api/me` plus a scripted listing; several answers unroll across retries. */
function serve(options: { listing: ListingAnswer | ListingAnswer[] }): Asked[] {
  const asked: Asked[] = [];
  const answers = Array.isArray(options.listing)
    ? options.listing
    : [options.listing];
  let call = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ input, init });
    const path = String(input).split("?")[0];
    if (path === "/api/me") {
      return jsonResponse(200, {
        user: { id: "u-1", email: "person@example.com", role: "user" },
      });
    }
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (typeof answer === "function") return answer();
    return jsonResponse(answer.status, answer.body);
  }) as unknown as typeof fetch;
  return asked;
}

function drawPage(queryClient: QueryClient, entry = "/tenant/selection") {
  const rootRoute = createRootRoute({ component: Outlet });
  const selection = (
    SelectionRoute as unknown as { update: (options: unknown) => unknown }
  ).update({
    path: "/tenant/selection",
    getParentRoute: () => rootRoute,
  });
  const tree = rootRoute.addChildren([selection as never]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { router, view };
}

test("while the listing is in flight the page shows a skeleton and no selector", async () => {
  serve({ listing: () => new Promise<Response>(() => {}) });
  const { view } = drawPage(freshClient());

  await waitFor(() => {
    expect(
      view.container.querySelector('[data-slot="table-skeleton"]'),
    ).toBeTruthy();
  });
  expect(view.queryByRole("combobox", { name: "Select a company" })).toBeNull();
  expect(view.queryByRole("combobox", { name: "Select a team" })).toBeNull();
});

test("a failed listing says so and retries into a working page", async () => {
  serve({
    listing: [
      { status: 503, body: { error: { code: "DATA_DATABASE_UNAVAILABLE" } } },
      { status: 200, body: LISTING },
    ],
  });
  const { view } = drawPage(freshClient());
  const user = userEvent.setup({ document });

  expect(
    await view.findByText("Your companies and teams could not be loaded."),
  ).toBeTruthy();
  // A failure is not an empty state: no guidance to "get added", just the fact and a way back.
  expect(view.queryByText(/administrator/)).toBeNull();
  await user.click(await view.findByRole("button", { name: "Retry" }));

  expect(
    await view.findByRole("combobox", { name: "Select a company" }),
  ).toBeTruthy();
});

test("with no eligibility the page shows the empty guidance and no selector at all", async () => {
  serve({ listing: { status: 200, body: { companies: [] } } });
  const { view } = drawPage(freshClient());

  expect(await view.findByText("No company membership yet")).toBeTruthy();
  expect(view.getByText(/Ask your company administrator/)).toBeTruthy();
  expect(view.queryByRole("combobox", { name: "Select a company" })).toBeNull();
  expect(view.queryByRole("combobox", { name: "Select a team" })).toBeNull();
});

test("eligible but nothing chosen: both selectors sit at their placeholders, no scope is named", async () => {
  serve({ listing: { status: 200, body: LISTING } });
  const { view } = drawPage(freshClient());

  const company = await view.findByRole("combobox", {
    name: "Select a company",
  });
  expect(company.textContent).toContain("Pick a company");
  const team = view.getByRole("combobox", { name: "Select a team" });
  expect(team.textContent).toContain("Pick a team");
  // Not the first company, not any default team, not a stale summary.
  expect(company.textContent).not.toContain("Acme Inc");
  expect(view.queryByText(/Working in/)).toBeNull();
});

test("a stored selection that is still eligible is restored and shown", async () => {
  storeSelection("u-1", ACME_FINANCE);
  serve({ listing: { status: 200, body: LISTING } });
  const { view } = drawPage(freshClient());

  const company = await view.findByRole("combobox", {
    name: "Select a company",
  });
  expect(company.textContent).toContain("Acme Inc");
  const team = view.getByRole("combobox", { name: "Select a team" });
  expect(team.textContent).toContain("Finance");
  expect(view.getByText(/Working in/).textContent).toContain("Acme Inc");
  expect(view.getByText(/Working in/).textContent).toContain("Finance");
});

test("a stored selection whose team has vanished renders the revoked state, never a silent fallback", async () => {
  storeSelection("u-1", { tenantId: "acme", workspaceId: "acme-marketing" });
  const revokedListing: WorkspaceScopeListing = {
    companies: [
      {
        tenantId: "acme",
        name: "Acme Inc",
        role: "member",
        memberEpoch: 4,
        teams: [{ workspaceId: "acme-finance", name: "Finance" }],
      },
    ],
  };
  serve({
    listing: [
      { status: 200, body: revokedListing },
      { status: 200, body: revokedListing },
    ],
  });
  const { view } = drawPage(freshClient());
  const user = userEvent.setup({ document });

  expect(
    await view.findByText(
      "Your access to that company or team has been revoked",
    ),
  ).toBeTruthy();
  // Not silently moved to the one remaining team.
  expect(view.queryByText(/Working in/)).toBeNull();

  await user.click(await view.findByRole("button", { name: "Check again" }));
  // The re-check still refuses to choose for you; the selector is there for an explicit pick.
  expect(
    await view.findByRole("combobox", { name: "Select a company" }),
  ).toBeTruthy();
  expect(
    view.getByText("Your access to that company or team has been revoked"),
  ).toBeTruthy();
});

test("a cross-company user sees each of their companies with its own teams", async () => {
  serve({ listing: { status: 200, body: LISTING } });
  const { view } = drawPage(freshClient());
  const user = userEvent.setup({ document });

  await user.click(
    await view.findByRole("combobox", { name: "Select a company" }),
  );
  await user.click(await view.findByRole("option", { name: "Acme Inc" }));
  await user.click(view.getByRole("combobox", { name: "Select a team" }));
  await user.click(await view.findByRole("option", { name: "Finance" }));
  expect(view.getByText(/Working in/).textContent).toContain("Finance");

  // The second company is offered too, and keeps its own team.
  await user.click(view.getByRole("combobox", { name: "Select a company" }));
  await user.click(await view.findByRole("option", { name: "Globex" }));
  // Choosing a company alone never picks a team for you.
  expect(
    view.getByRole("combobox", { name: "Select a team" }).textContent,
  ).toContain("Pick a team");
  await user.click(view.getByRole("combobox", { name: "Select a team" }));
  await user.click(await view.findByRole("option", { name: "Operations" }));
  expect(view.getByText(/Working in/).textContent).toContain("Globex");
  expect(view.getByText(/Working in/).textContent).toContain("Operations");
});

test("completing a selection moves the URL, the storage, and the shared generation", async () => {
  const queryClient = freshClient();
  serve({ listing: { status: 200, body: LISTING } });
  const { router, view } = drawPage(queryClient);
  const user = userEvent.setup({ document });

  await user.click(
    await view.findByRole("combobox", { name: "Select a company" }),
  );
  await user.click(await view.findByRole("option", { name: "Acme Inc" }));
  await waitFor(() =>
    expect(router.state.location.search as unknown).toEqual({
      company: "acme",
    }),
  );
  // The half-choice cleared any stored team: a company alone is not a scope.
  expect(readStoredSelection("u-1")).toBeNull();

  await user.click(view.getByRole("combobox", { name: "Select a team" }));
  await user.click(await view.findByRole("option", { name: "Finance" }));

  await waitFor(() =>
    expect(router.state.location.search as unknown).toEqual({
      company: "acme",
      team: "acme-finance",
    }),
  );
  expect(readStoredSelection("u-1")).toEqual(ACME_FINANCE);
  // The selection moved the shared generation, so any in-flight guarded read elsewhere is refused.
  expect(generationOf(queryClient, "u-1")).toBeGreaterThan(0);
  // And the page reflects the new scope immediately.
  expect(view.getByText(/Working in/).textContent).toContain("Finance");
});

test("a deep link to a scope that is still eligible opens selected", async () => {
  serve({ listing: { status: 200, body: LISTING } });
  const { view } = drawPage(
    freshClient(),
    "/tenant/selection?company=acme&team=acme-sales",
  );
  const company = await view.findByRole("combobox", {
    name: "Select a company",
  });
  expect(company.textContent).toContain("Acme Inc");
  expect(view.getByText(/Working in/).textContent).toContain("Sales");
});

test("a deep link to a scope that is gone opens revoked, never re-homed", async () => {
  serve({ listing: { status: 200, body: LISTING } });
  const { view } = drawPage(
    freshClient(),
    "/tenant/selection?company=initech&team=initech-ops",
  );
  expect(
    await view.findByText(
      "Your access to that company or team has been revoked",
    ),
  ).toBeTruthy();
  expect(view.queryByText(/Working in/)).toBeNull();
  // And no eligible scope was substituted: the picker still names the revoked company, raw —
  // the honest face of "this selection is revoked", never a quiet re-homing onto another scope.
  expect(
    view.getByRole("combobox", { name: "Select a company" }).textContent,
  ).toContain("initech");
  expect(
    view.getByRole("combobox", { name: "Select a company" }).textContent,
  ).not.toContain("Acme Inc");
});

// ---------------------------------------------------------------------------
// 7. The transport — the team half of the selection rides the same discipline
// ---------------------------------------------------------------------------

test("the workspace selector rides only same-origin reviewed paths, next to the tenant one", async () => {
  const asked: Asked[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ input, init });
    return jsonResponse(200, { ok: true });
  }) as unknown as typeof fetch;

  await client("/api/enterprise/conversations", {
    tenantId: "acme",
    workspaceId: "acme-finance",
  });
  expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBe("acme");
  expect(headerOf(asked[0]?.init, "x-openbot-workspace")).toBe("acme-finance");

  // `/api/agents` earned its review at MT084 (the scoped Bot detail/config surface), so the pair
  // rides it too — the reviewed inventory, not "enterprise paths only", is the rule. An
  // unreviewed business path still attaches nothing.
  await client("/api/agents", {
    tenantId: "acme",
    workspaceId: "acme-finance",
  });
  expect(headerOf(asked[1]?.init, "x-openbot-tenant")).toBe("acme");
  expect(headerOf(asked[1]?.init, "x-openbot-workspace")).toBe("acme-finance");

  // `/api/channels` earned its review at MT087 (the scoped conversation surfaces) and
  // `/api/craft` at MT091 (the scoped creation surfaces); the proactive surface is the
  // unreviewed example now.
  await client("/api/proactive/suggestions", {
    tenantId: "acme",
    workspaceId: "acme-finance",
  });
  expect(headerOf(asked[2]?.init, "x-openbot-tenant")).toBeUndefined();
  expect(headerOf(asked[2]?.init, "x-openbot-workspace")).toBeUndefined();

  await client("https://evil.example/api/enterprise/conversations", {
    tenantId: "acme",
    workspaceId: "acme-finance",
  });
  expect(headerOf(asked[3]?.init, "x-openbot-workspace")).toBeUndefined();
  expect(headerOf(asked[3]?.init, "x-openbot-tenant")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 8. i18n — the two bundles carry the selection strings together
// ---------------------------------------------------------------------------

function leafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) =>
      leafPaths(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

test("the selection strings exist in en and zh-CN together", () => {
  const en = leafPaths(enTenant.selection).sort();
  const zh = leafPaths(zhTenant.selection).sort();
  expect(zh).toEqual(en);
  expect(en.length).toBeGreaterThan(0);
  // The repo discipline is key-set sync; both sides say something real.
  expect(zhTenant.selection.revoked.title).not.toBe("");
  expect(enTenant.selection.revoked.title).not.toBe("");
});
