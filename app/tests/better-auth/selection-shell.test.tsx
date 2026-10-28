import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "../../../tests/support/e2e-compat";
import { SCOPE_HEADER_ALLOWED_PATHS } from "../../src/lib/client";
import { tenantKeys } from "../../src/lib/enterprise/tenant/queries";
import {
  type ScopeSelection,
  scopeAbortSignal,
  selectionKeys,
  storeSelection,
  type WorkspaceScopeListing,
} from "../../src/lib/enterprise/tenant/selection";
import { Route as AppShellRoute } from "../../src/routes/_authed/_app";
import { Route as TenantAdminRoute } from "../../src/routes/_authed/tenant/admin/route";
import { Route as SelectionRoute } from "../../src/routes/_authed/tenant/selection";

/**
 * The real application shell against the one selection coordinator, T03.07 (Issue #544).
 *
 * WHAT IS UNDER TEST. The shell (`routes/_authed/_app.tsx`, the component every signed-in business
 * page renders inside) consumes the verified selection and nothing else: a pair the eligibility
 * listing no longer names is held out of the shell's business content — the sidebar and the page
 * never mount under it, so no request can ride a workspace the server would refuse — and the
 * person is held at a face that says what happened and what to do next. The empty company and
 * empty team states render their own next steps, and the allowed company-settings entry is
 * visible to a member the listing says may manage the company. A sign-in by another person ends
 * the previous account's epoch and cache — nothing survives a handover for anybody else to read.
 *
 * THE HARNESS IS THIS REPOSITORY'S (the MT080 selection suite and the MT087 sidebar suite): fetch
 * interception against a real QueryClient, exported Route singletons re-parented into a memory
 * router, and a WebSocket stub so the sidebar's live socket stays offline. The shell is mounted
 * for real — sidebar, banner, notices — because the guarantee is about what the whole shell sends.
 */

let fetchHandler: typeof globalThis.fetch;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof globalThis.fetch;
  fetchHandler = originalFetch;
});

beforeEach(() => {
  fetchHandler = originalFetch;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  fetchHandler = originalFetch;
});

afterAll(() => {
  GlobalRegistrator.unregister();
  globalThis.fetch = originalFetch;
});

type Asked = { input: RequestInfo | URL; init: RequestInit | undefined };

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
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

async function flush() {
  await act(async () => {});
}

/**
 * The requests the empty-team state must never produce: any reviewed business path ridden with a
 * scope pair. A headerless personal-context read is not a workspace request; a request naming a
 * tenant or workspace IS one, whoever attached the headers.
 */
function scopedBusinessRequests(asked: Asked[]): Asked[] {
  return asked.filter(({ input, init }) => {
    const path = String(input).split("?")[0];
    if (
      !SCOPE_HEADER_ALLOWED_PATHS.some((entry) => path.startsWith(entry.prefix))
    ) {
      return false;
    }
    return (
      headerOf(init, "x-openbot-tenant") !== undefined ||
      headerOf(init, "x-openbot-workspace") !== undefined
    );
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A company the person may manage, with no team in it — the ticket's own persona. */
const TEAMLESS_OWNER_LISTING: WorkspaceScopeListing = {
  companies: [
    {
      tenantId: "a",
      organizationId: "org-a",
      name: "Alpha",
      role: "owner",
      memberEpoch: 3,
      companyGeneration: 2,
      capabilities: ["company:manage", "team:members:manage"],
      teams: [],
    },
  ],
};

/** Same company, plain member: the settings entry must stay hidden. */
const TEAMLESS_MEMBER_LISTING: WorkspaceScopeListing = {
  companies: [
    {
      tenantId: "a",
      name: "Alpha",
      role: "member",
      memberEpoch: 3,
      teams: [],
    },
  ],
};

/** The legacy authority's answer: no advertisement, no binding fields, teams present. */
const LEGACY_LISTING: WorkspaceScopeListing = {
  companies: [
    {
      tenantId: "a",
      name: "Alpha",
      role: "tenant_admin",
      memberEpoch: 3,
      teams: [{ workspaceId: "a-finance", name: "Finance" }],
    },
  ],
};

const SCOPE_A: ScopeSelection = { tenantId: "a", workspaceId: "a-finance" };

/**
 * Answers everything the shell reads. The listing is the test's to choose; the sidebar's own
 * reads answer with their empty envelopes so the chrome renders without noise.
 */
function serveShell(options: {
  listing?: unknown;
  advertisement?: string;
}): Asked[] {
  const asked: Asked[] = [];
  fetchHandler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ input, init });
    const path = String(input).split("?")[0];
    if (path === "/api/me") {
      return jsonResponse(200, {
        user: {
          id: "u-1",
          email: "person@example.com",
          role: "user",
          onboarding: null,
        },
      });
    }
    if (path === "/api/enterprise/workspace-scope") {
      return jsonResponse(200, options.listing ?? { companies: [] }, {
        ...(options.advertisement !== undefined
          ? { "x-openbot-directory-authority": options.advertisement }
          : {}),
      });
    }
    if (path === "/api/settings/preferences") {
      return jsonResponse(200, {
        preferences: {
          messageListEmphasis: "thread",
          selfHostBannerDismissed: false,
        },
      });
    }
    if (path === "/api/agents") return jsonResponse(200, { agents: [] });
    if (path === "/api/channels") return jsonResponse(200, { channels: [] });
    if (path === "/api/bots/attention") return jsonResponse(200, { bots: [] });
    if (path === "/api/approvals") {
      return jsonResponse(200, {
        enabled: true,
        requests: [],
        rules: [],
        teamRules: [],
        questions: [],
      });
    }
    return jsonResponse(200, {});
  }) as unknown as typeof globalThis.fetch;
  return asked;
}

function HomeStub() {
  return <p>home</p>;
}

/**
 * The real shell route in a memory router, with a stub home page under it — and, when the test
 * opens the settings entry, the real company-admin route mounted beside it.
 */
function drawShell(
  queryClient: QueryClient,
  options: { admin?: boolean } = {},
) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = (
    AppShellRoute as unknown as { update: (options: unknown) => unknown }
  ).update({
    id: "/_app",
    getParentRoute: () => rootRoute,
  });
  const home = createRoute({
    component: HomeStub,
    getParentRoute: () => shell as never,
    path: "/",
  });
  const children: unknown[] = [home];
  if (options.admin === true) {
    children.push(
      (
        TenantAdminRoute as unknown as {
          update: (options: unknown) => unknown;
        }
      ).update({
        id: "/tenant/admin",
        getParentRoute: () => shell as never,
        path: "/tenant/admin",
      }),
    );
  }
  const tree = rootRoute.addChildren([
    (
      shell as unknown as { addChildren: (children: unknown[]) => unknown }
    ).addChildren(children),
  ] as never);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: tree,
  } as never);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { router, view };
}

// The selection page alone, as in the MT080 suite: the refused-switch faces are the page's own.
function drawPage(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: Outlet });
  const selection = (
    SelectionRoute as unknown as { update: (options: unknown) => unknown }
  ).update({
    getParentRoute: () => rootRoute,
    path: "/tenant/selection",
  });
  const tree = rootRoute.addChildren([selection as never]);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/tenant/selection"] }),
    routeTree: tree,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { router, view };
}

async function pickCompany(view: ReturnType<typeof render>, name: string) {
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", { name: "Select a company" }),
  );
  await user.click(await view.findByRole("option", { name }));
}

async function pickTeam(view: ReturnType<typeof render>, name: string) {
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Select a team" }));
  await user.click(await view.findByRole("option", { name }));
}

// ---------------------------------------------------------------------------
// The named cases
// ---------------------------------------------------------------------------

test("company_admin_without_team_can_open_allowed_settings", async () => {
  serveShell({ listing: TEAMLESS_OWNER_LISTING });
  const queryClient = freshClient();
  const { view } = drawShell(queryClient, { admin: true });

  // No team anywhere in the listing, so the shell names the empty team state…
  expect(await view.findByText("No team yet")).toBeTruthy();

  // …and the one setting a teamless admin may still open is offered, right there.
  const settingsVisible =
    view.queryByRole("link", { name: "Company settings" }) !== null;
  expect(settingsVisible).toBe(true);

  // The entry takes keyboard focus like any entry…
  const settings = view.getByRole("link", { name: "Company settings" });
  settings.focus();
  expect(document.activeElement).toBe(settings);

  // …and opening it lands on the real settings face, not a dead end.
  const user = userEvent.setup({ document });
  await user.click(settings);
  expect(await view.findByText("Choose a company first")).toBeTruthy();
});

test("empty_team_state_never_requests_default_workspace", async () => {
  // The team existed when the person chose it; the listing now says the company has none. The
  // pair in storage is exactly the "default" the shell must never ride again.
  storeSelection("u-1", { tenantId: "a", workspaceId: "a-gone" });
  const asked = serveShell({ listing: TEAMLESS_OWNER_LISTING });
  const queryClient = freshClient();
  const { view } = drawShell(queryClient);

  // Let the shell settle — the user answers, the chrome (or the hold) mounts — then count
  // every request the settled state produced.
  await waitFor(() =>
    expect(
      asked.some(({ input }) => String(input).split("?")[0] === "/api/me"),
    ).toBe(true),
  );
  await flush();
  await flush();

  const ridden = scopedBusinessRequests(asked);
  expect(ridden).toHaveLength(0);

  // And the state it renders is the honest one: the old pair no longer exists, and the person
  // is told what happened instead of being dropped onto the business chrome.
  expect(
    await view.findByText("Your access to that company ended"),
  ).toBeTruthy();
});

// ---------------------------------------------------------------------------
// The supporting faces
// ---------------------------------------------------------------------------

test("a_plain_member_without_teams_sees_no_company_settings_entry", async () => {
  serveShell({ listing: TEAMLESS_MEMBER_LISTING });
  const queryClient = freshClient();
  const { view } = drawShell(queryClient);

  // The empty team state renders for a member too…
  expect(await view.findByText("No team yet")).toBeTruthy();

  // …but the management entry is the capability's answer, never a blanket offer.
  expect(view.queryByRole("link", { name: "Company settings" })).toBeNull();
});

test("an_admin_of_no_company_sees_the_invite_next_step", async () => {
  serveShell({ listing: { companies: [] } });
  const queryClient = freshClient();
  const { view } = drawShell(queryClient);

  // Not a member of any company: the shell says so and names the way in.
  expect(await view.findByText("You're not in a company yet")).toBeTruthy();
  expect(view.queryByRole("link", { name: "Company settings" })).toBeNull();
});

test("legacy_listing_and_stored_selection_keep_today_s_shell", async () => {
  storeSelection("u-1", SCOPE_A);
  const asked = serveShell({ listing: LEGACY_LISTING });
  const queryClient = freshClient();
  const { view } = drawShell(queryClient);

  // A listed pair under the legacy authority verifies like any other: the full business chrome
  // mounts, no empty-state notice interrupts it, and the roster rides the verified pair.
  expect(await view.findByText("home")).toBeTruthy();
  await waitFor(() =>
    expect(
      asked.some(
        ({ input }) => String(input).split("?")[0] === "/api/channels",
      ),
    ).toBe(true),
  );
  expect(view.queryByText("No team yet")).toBeNull();
  expect(view.queryByText("Your access to that company ended")).toBeNull();
  const roster = asked.find(
    ({ input }) => String(input).split("?")[0] === "/api/channels",
  );
  expect(headerOf(roster?.init, "x-openbot-tenant")).toBe("a");
  expect(headerOf(roster?.init, "x-openbot-workspace")).toBe("a-finance");
});

// ---------------------------------------------------------------------------
// The epoch and the refusal
// ---------------------------------------------------------------------------

test("signing_in_as_another_person_ends_the_previous_account_s_epoch", async () => {
  const queryClient = freshClient();
  // The previous session left a scope in force, a generation, and cache under its subtree.
  queryClient.setQueryData(selectionKeys.current("u-old"), SCOPE_A);
  queryClient.setQueryData(tenantKeys.generation("u-old"), 3);
  const staleEntry = [
    ...tenantKeys.scope("u-old", "a"),
    "channels",
    { cursor: "" },
  ] as const;
  queryClient.setQueryData(staleEntry, { pages: [], pageParams: [] });
  const previousSignal = scopeAbortSignal(queryClient, "u-old");

  serveShell({ listing: { companies: [] } });
  const { view } = drawShell(queryClient);

  // The shell is up under the new person…
  expect(await view.findByText("home")).toBeTruthy();
  await flush();
  await flush();

  // …and nothing of the previous account survived the handover: its epoch is ended — streams,
  // requests and mutations opened against it are torn down — and its cache entries are gone.
  expect(previousSignal.aborted).toBe(true);
  expect(
    queryClient.getQueryData(selectionKeys.current("u-old")),
  ).toBeUndefined();
  expect(
    queryClient.getQueryData(tenantKeys.generation("u-old")),
  ).toBeUndefined();
  expect(queryClient.getQueryData(staleEntry)).toBeUndefined();
});

test("a_refused_reauth_switch_names_the_next_step_and_unfreezes", async () => {
  storeSelection("u-1", SCOPE_A);
  serve({
    listing: {
      status: 200,
      body: {
        companies: [
          {
            tenantId: "a",
            organizationId: "org-a",
            name: "Alpha",
            role: "owner",
            memberEpoch: 3,
            companyGeneration: 2,
            capabilities: ["company:manage"],
            teams: [
              {
                workspaceId: "a-finance",
                teamId: "team-a-finance",
                name: "Finance",
                workspaceMemberEpoch: 2,
                teamGeneration: 1,
              },
            ],
          },
          {
            tenantId: "b",
            organizationId: "org-b",
            name: "Beta",
            role: "admin",
            memberEpoch: 5,
            companyGeneration: 4,
            capabilities: [],
            teams: [
              {
                workspaceId: "b-ops",
                teamId: "team-b-ops",
                name: "Operations",
                workspaceMemberEpoch: 1,
                teamGeneration: 1,
              },
            ],
          },
        ],
      },
      advertisement: "ba-v1",
    },
    validate: {
      status: 403,
      body: { error: { code: "COMPANY_REAUTH_REQUIRED", message: "Refused." } },
    },
  });
  const queryClient = freshClient();
  const { view } = drawPage(queryClient);

  // The verified scope is on screen; the person tries to move to company B.
  expect((await view.findByText(/Working in/)).textContent).toContain("Alpha");
  await pickCompany(view, "Beta");
  await pickTeam(view, "Operations");

  // The validation refused. The pickers return to the verified scope…
  const company = (await view.findByRole("button", {
    name: "Select a company",
  })) as HTMLButtonElement;
  await waitFor(() => expect(company.disabled).toBe(false));

  // …and the page names what the extra sign-in means, instead of leaving the refusal silent.
  expect(
    view.queryByText(
      "This company asks for an extra sign-in first. That isn't available in OpenBot yet.",
    ),
  ).not.toBeNull();
});

/** The MT080 dispatcher, inlined for the one page-level test above. */
function serve(options: {
  listing: { status: number; body: unknown; advertisement?: string };
  validate?: { status: number; body: unknown };
}): Asked[] {
  const asked: Asked[] = [];
  fetchHandler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ input, init });
    const path = String(input).split("?")[0];
    if (path === "/api/me") {
      return jsonResponse(200, {
        user: { id: "u-1", email: "person@example.com", role: "user" },
      });
    }
    if (path === "/api/enterprise/workspace-scope") {
      return jsonResponse(options.listing.status, options.listing.body, {
        ...(options.listing.advertisement !== undefined
          ? { "x-openbot-directory-authority": options.listing.advertisement }
          : {}),
      });
    }
    if (path === "/api/enterprise/workspace-scope/validate-selection") {
      if (options.validate === undefined) {
        return jsonResponse(500, { error: { code: "UNEXPECTED" } });
      }
      return jsonResponse(options.validate.status, options.validate.body);
    }
    return jsonResponse(200, { data: null });
  }) as unknown as typeof globalThis.fetch;
  return asked;
}
