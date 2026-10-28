import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "../../../tests/support/e2e-compat";
import { client } from "../../src/lib/client";
import { resetCompanyReauthState } from "../../src/lib/auth/company-assurance";
import {
  readCurrentSelection,
  selectionKeys,
  selectionStorageKey,
  storeSelection,
  type ScopeSelection,
  type WorkspaceScopeListing,
} from "../../src/lib/enterprise/tenant/selection";
import { Route as AuthedRoute } from "../../src/routes/_authed";

/**
 * The company assurance client continuation, T05.15 (P13).
 *
 * WHAT IS UNDER TEST. When the server answers 403 COMPANY_REAUTH_REQUIRED the app keeps the
 * company and team it was working under, pauses business, and offers the company's extra sign-in
 * through the real challenge endpoint — then hands the browser to the provider. Coming back from
 * that sign-in re-validates the scope through the §4 validation: a completed proof resumes the
 * company, a changed account or a cancelled journey never does.
 *
 * THE HARNESS IS THIS REPOSITORY'S, as in the T05.14 recovery suite: the exported `_authed` Route
 * re-parented into a memory router over the one fetch dispatcher, with a probe route under the
 * gate that fires a real business read the moment it mounts. The probe is the canary: while a
 * company demands proof, it must never mount, so its request must never leave the browser.
 */

let authed: typeof AuthedRoute;
let requests: {
  path: string;
  body: Record<string, unknown>;
  init: RequestInit | undefined;
}[];
let fetchHandler: typeof globalThis.fetch;
const originalFetch = globalThis.BunTEST_ORIGINAL_FETCH ?? globalThis.fetch;

/** One stable dispatcher, installed before anything that captures fetch (T05.14 discipline). */
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof globalThis.fetch;
  fetchHandler = originalFetch;
  authed = (await import("../../src/routes/_authed")).Route;
});

beforeEach(() => {
  // The pause is per-app-session memory; each test draws a fresh app session, as a real
  // navigation to the provider's page would.
  resetCompanyReauthState();
  requests = [];
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  fetchHandler = originalFetch;
});

afterAll(() => {
  GlobalRegistrator.unregister();
  globalThis.fetch = originalFetch;
});

const USER = "u-1";
const SCOPE_A: ScopeSelection = { tenantId: "a", workspaceId: "a-finance" };

const BA_LISTING: WorkspaceScopeListing = {
  companies: [
    {
      tenantId: "a",
      organizationId: "org-a",
      name: "Alpha",
      role: "member",
      memberEpoch: 3,
      companyGeneration: 2,
      capabilities: ["finance:read"],
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
  ],
};

/** The §4 echo for scope A, with the binding facts the validation answers. */
function validatedA() {
  return {
    tenantId: "a",
    workspaceId: "a-finance",
    organizationId: "org-a",
    teamId: "team-a-finance",
    memberEpoch: 3,
    workspaceMemberEpoch: 2,
    companyGeneration: 2,
    teamGeneration: 1,
    capabilities: ["finance:read"],
  };
}

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

/** Paths that are not business: the gate's own reads, the challenge, the session. */
const NOT_BUSINESS = new Set([
  "/api/me",
  "/api/enterprise/workspace-scope",
  "/api/enterprise/workspace-scope/validate-selection",
  "/api/enterprise/company-auth/challenge",
  "/api/auth/get-session",
]);

/**
 * Serves the gate's world: a signed-in user with a completed onboarding, the ba-v1 listing, and
 * per-test validate/challenge answers. Anything else is a business path and is recorded.
 */
function serve(world: {
  listing?: { status: number; body: unknown; advertisement?: string };
  validate?: { status: number; body: unknown };
  challenge?: { status: number; body: unknown };
}) {
  const listing = world.listing ?? {
    status: 200,
    body: BA_LISTING,
    advertisement: "ba-v1",
  };
  const validate = world.validate ?? { status: 200, body: validatedA() };
  const challenge = world.challenge ?? {
    status: 200,
    body: {
      challengeId: "cac_x",
      redirectUrl: "https://idp.example.test/authorize?state=x",
      expiresAt: "2026-10-28T23:59:59.000Z",
    },
  };
  fetchHandler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.origin,
    );
    const path = `${url.pathname}${url.search}`;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    requests.push({ path, body, init });
    if (path === "/api/me") {
      return jsonResponse(200, {
        user: {
          id: USER,
          email: "person@example.test",
          name: "Person",
          role: "user",
          onboarding: { step: 1, completedAt: "2026-01-01T00:00:00.000Z" },
        },
      });
    }
    if (path === "/api/enterprise/workspace-scope") {
      return jsonResponse(
        listing.status,
        listing.body,
        listing.advertisement
          ? { "x-openbot-directory-authority": listing.advertisement }
          : {},
      );
    }
    if (path === "/api/enterprise/workspace-scope/validate-selection") {
      return jsonResponse(validate.status, validate.body);
    }
    if (path === "/api/enterprise/company-auth/challenge") {
      return jsonResponse(challenge.status, challenge.body);
    }
    return jsonResponse(200, {});
  }) as typeof globalThis.fetch;
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

/**
 * The business canary: a screen under the gate that reads company data the moment it mounts.
 * Rendered, its request proves business is open; unmounted, the pause is holding.
 */
function BusinessProbe() {
  useQuery({
    queryKey: ["business-probe"],
    queryFn: () =>
      client("/api/agents", "agents", { fallback: "Could not load Bots." }),
  });
  return <div>business rendered</div>;
}

function drawApp(entry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const reparent = (route: unknown, id: string) =>
    (route as { update(options: unknown): unknown }).update.call(route, {
      id,
      getParentRoute: () => root,
    });
  reparent(authed, "/_authed");
  const business = createRoute({
    getParentRoute: () => authed as never,
    path: "/",
    component: BusinessProbe,
  });
  const selection = createRoute({
    getParentRoute: () => authed as never,
    path: "/tenant/selection",
    component: () => <div>selection stub</div>,
  });
  const tree = (authed as unknown as {
    addChildren(children: unknown[]): unknown;
  }).addChildren([business, selection]);
  const router = createRouter({
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [entry] }),
    routeTree: root.addChildren([tree as never]),
  } as never);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { queryClient, view };
}

test("reauth_required_preserves_target_and_blocks_business", async () => {
  storeSelection(USER, SCOPE_A);
  serve({
    validate: {
      status: 403,
      body: { error: { code: "COMPANY_REAUTH_REQUIRED", message: "Request refused." } },
    },
  });
  const { queryClient, view } = drawApp("/");

  // The pause wall speaks, in the app's own words.
  await view.findByText("This company asks for an extra sign-in.");

  // The original target is preserved: storage still names scope A, nothing moved it.
  expect(localStorage.getItem(selectionStorageKey(USER))).toBe(
    JSON.stringify(SCOPE_A),
  );

  // Business is paused: the probe never mounted, so its read never left the browser.
  const businessRequestsWhileReauth = requests.filter(
    (one) => !NOT_BUSINESS.has(one.path),
  );
  expect(businessRequestsWhileReauth).toHaveLength(0);

  // The preserved target rides into the challenge: the sign-in is for A, and the return path
  // is the page the person was on, site-local and never taken from anywhere but the location.
  const landings: string[] = [];
  const originalAssign = window.location.assign.bind(window.location);
  window.location.assign = (url: string) => {
    landings.push(url);
  };
  const user = userEvent.setup({ document });
  await user.click(
    view.getByRole("button", { name: "Sign in again" }),
  );
  await waitFor(() => {
    expect(
      requests.some(
        (one) => one.path === "/api/enterprise/company-auth/challenge",
      ),
    ).toBe(true);
  });
  const challenge = requests.find(
    (one) => one.path === "/api/enterprise/company-auth/challenge",
  );
  expect(challenge?.body).toEqual({ tenantId: "a", returnPath: "/" });

  // Leaving the pause is a person's act too: the escape drops the wall and offers the chooser.
  await user.click(
    view.getByRole("button", { name: "Choose another company" }),
  );
  await view.findByText("selection stub");
  expect(queryClient.getQueryData(selectionKeys.current(USER)) ?? null).toBe(
    null,
  );
  window.location.assign = originalAssign;
});

test("completed_reauth_resumes_the_paused_company", async () => {
  storeSelection(USER, SCOPE_A);
  sessionStorage.setItem(
    `openbot.company-reauth.v1:${USER}`,
    JSON.stringify({ tenantId: "a", workspaceId: "a-finance", returnPath: "/" }),
  );
  serve({});
  const { queryClient, view } = drawApp("/");

  // The callback landed, the proof is recorded, the validation accepts: the company resumes
  // through the one switch coordinator, and business renders again.
  await view.findByText("business rendered");
  expect(
    view.queryByText("This company asks for an extra sign-in."),
  ).toBeNull();
  const validations = requests.filter(
    (one) => one.path === "/api/enterprise/workspace-scope/validate-selection",
  );
  expect(validations).toHaveLength(1);
  expect(readCurrentSelection(queryClient, USER)).toEqual(SCOPE_A);
  // The one-shot marker is consumed: a refresh does not re-run the resume.
  expect(sessionStorage.getItem(`openbot.company-reauth.v1:${USER}`)).toBeNull();
});

test("changed_account_callback_never_resumes_old_scope", async () => {
  storeSelection(USER, SCOPE_A);
  sessionStorage.setItem(
    `openbot.company-reauth.v1:${USER}`,
    JSON.stringify({ tenantId: "a", workspaceId: "a-finance", returnPath: "/" }),
  );
  serve({
    validate: {
      status: 403,
      body: { error: { code: "COMPANY_REAUTH_REQUIRED", message: "Request refused." } },
    },
  });
  const { queryClient, view } = drawApp("/");

  // The sign-in finished with a different account (or the company changed): the wall says so,
  // and the old scope never resumes.
  await view.findByText("That extra sign-in didn't work.");
  const resumedBusiness = requests.filter(
    (one) =>
      !NOT_BUSINESS.has(one.path) &&
      headerOf(one.init, "x-openbot-tenant") === "a",
  );
  const oldScopeResumed =
    resumedBusiness.length > 0 ||
    localStorage.getItem(selectionStorageKey(USER)) !== JSON.stringify(SCOPE_A) ||
    readCurrentSelection(queryClient, USER)?.tenantId === "a";
  expect(oldScopeResumed).toBe(false);
});

test("challenge_hands_off_to_the_provider_with_a_site_local_return_path", async () => {
  storeSelection(USER, SCOPE_A);
  serve({
    validate: {
      status: 403,
      body: { error: { code: "COMPANY_REAUTH_REQUIRED", message: "Request refused." } },
    },
  });
  const landings: string[] = [];
  const originalAssign = window.location.assign.bind(window.location);
  window.location.assign = (url: string) => {
    landings.push(url);
  };
  const { view } = drawApp("/?next=https://evil.example");
  await view.findByText("This company asks for an extra sign-in.");

  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Sign in again" }));
  await waitFor(() => {
    expect(
      requests.some(
        (one) => one.path === "/api/enterprise/company-auth/challenge",
      ),
    ).toBe(true);
  });

  // The return path is the whole site-local location in the router's own serialization — the
  // foreign-looking query value rides as inert, encoded data inside a same-origin path, never
  // as the destination itself.
  const challenge = requests.find(
    (one) => one.path === "/api/enterprise/company-auth/challenge",
  );
  expect(challenge?.body).toEqual({
    tenantId: "a",
    returnPath: "/?next=https%3A%2F%2Fevil.example",
  });
  // The hand-off is the provider's own page, and the resume marker is recorded before we leave.
  expect(landings).toEqual(["https://idp.example.test/authorize?state=x"]);
  expect(
    JSON.parse(
      sessionStorage.getItem(`openbot.company-reauth.v1:${USER}`) ?? "null",
    ),
  ).toEqual({
    tenantId: "a",
    workspaceId: "a-finance",
    returnPath: "/?next=https%3A%2F%2Fevil.example",
  });
  window.location.assign = originalAssign;
});

test("legacy_authority_never_pauses_or_challenges", async () => {
  storeSelection(USER, SCOPE_A);
  serve({
    listing: { status: 200, body: BA_LISTING },
    validate: { status: 200, body: validatedA() },
  });
  const { view } = drawApp("/");

  // An unwrapped deployment keeps the MT080 behavior byte-for-byte: no §4 validation runs at
  // the gate, no wall appears, and business renders as it always did.
  await view.findByText("business rendered");
  expect(
    requests.some(
      (one) => one.path === "/api/enterprise/workspace-scope/validate-selection",
    ),
  ).toBe(false);
  expect(
    view.queryByText("This company asks for an extra sign-in."),
  ).toBeNull();
});
