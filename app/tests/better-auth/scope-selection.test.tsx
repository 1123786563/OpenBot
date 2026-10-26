import "../preload";
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
import type { ValidatedSelection } from "../../../shared/auth-directory";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "../../../tests/support/e2e-compat";
import { client } from "../../src/lib/client";
import { tenantKeys } from "../../src/lib/enterprise/tenant/queries";
import {
  adoptActivePreference,
  companyOfBinding,
  type DirectoryAuthorityAdvertisement,
  type ScopeSelection,
  selectionKeys,
  selectionStorageKey,
  storeSelection,
  switchWorkspaceScope,
  validateWorkspaceScopeSelection,
  type WorkspaceScopeListing,
  WorkspaceScopeRefusedError,
  workspaceScopeListingQueryOptions,
} from "../../src/lib/enterprise/tenant/selection";
import { Route as SelectionRoute } from "../../src/routes/_authed/tenant/selection";

/**
 * The company/team switch coordinator, T03.05 / Issue #542 (the web half of P07).
 *
 * WHAT IS UNDER TEST. One coordinator owns every switch: an explicit act freezes the session's
 * intent order, the §4 validation accepts or refuses the target (only where the listing
 * advertised `ba-v1`), the BA active preference moves to the BOUND organizationId, and only then
 * does the selection generation publish. A refusal publishes nothing — the previously verified
 * scope (or no scope) stays, and the screen and the request headers it rides cannot fall out of
 * step. A late answer — a delayed active-company response, an out-of-order validation — replaces
 * no explicit selection. Legacy authority keeps the old adapter byte-for-byte: the MT080 switch
 * over the legacy DTO, with no second gate and no preference write.
 *
 * THE FIXTURES ARE THE §4 SHAPES the T03.02 surface serves: the ba-v1 listing with its binding
 * and version fields, and the ValidatedSelection echo. `organizationId` here is deliberately NOT
 * the tenant id (today's server happens to make them equal; the field is the binding's own fact,
 * and the coordinator must read it rather than guess), and `teamId` is deliberately NOT the
 * workspace id — the stable workspace identity is what publishes, never the BA team row.
 *
 * THE HARNESS IS THIS REPOSITORY'S, as in the MT080 selection suite (fetch interception against a
 * real QueryClient, the exported Route singleton re-parented into a memory router) and the T01.09
 * adapter suite (the organization plugin imported dynamically after the DOM registers, because
 * its Better Auth singleton evaluates at module scope).
 */

type OrganizationPlugin =
  typeof import("../../src/lib/auth/organization-plugin");

let organization: OrganizationPlugin;

/*
 * One stable fetch dispatcher, installed before anything that CAPTURES fetch. Better Auth's
 * client resolves its transport as `customFetchImpl: fetch` while its module evaluates, so a
 * stub swapped per test would never be seen by the preference write. The dispatcher delegates
 * to whichever handler the current test installed; everything — the app's own client, the
 * lazy auth client, the page — records through the one channel.
 */
let fetchHandler: typeof globalThis.fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof globalThis.fetch;
  fetchHandler = originalFetch;
  // The organization plugin evaluates its Better Auth singleton at module scope, which is why
  // it is imported here — under the DOM, and under the dispatcher above.
  organization = await import("../../src/lib/auth/organization-plugin");
});

afterEach(() => {
  cleanup();
  fetchHandler = originalFetch;
});
afterAll(() => {
  GlobalRegistrator.unregister();
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;

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

function generationOf(queryClient: QueryClient, userId: string): number {
  return queryClient.getQueryData<number>(tenantKeys.generation(userId)) ?? 0;
}

// ---------------------------------------------------------------------------
// The §4 fixtures
// ---------------------------------------------------------------------------

/** The ba-v1 listing: two companies, each bound, with binding facts that differ from the ids they bind. */
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
};

/** The legacy listing: the MT006 DTO, no binding fields — what the unwrapped surface serves. */
const LEGACY_LISTING: WorkspaceScopeListing = {
  companies: BA_LISTING.companies.map((company) => ({
    tenantId: company.tenantId,
    name: company.name,
    role: company.role,
    memberEpoch: company.memberEpoch,
    teams: company.teams.map((team) => ({
      workspaceId: team.workspaceId,
      name: team.name,
    })),
  })),
};

const SCOPE_A: ScopeSelection = { tenantId: "a", workspaceId: "a-finance" };
const SCOPE_B: ScopeSelection = { tenantId: "b", workspaceId: "b-ops" };

/** The §4 echo for scope B: the asked pair comes back, bound to the BA rows it owns. */
function validatedB(): ValidatedSelection {
  return {
    tenantId: "b",
    workspaceId: "b-ops",
    organizationId: "org-b",
    teamId: "team-b-ops",
    memberEpoch: 5,
    workspaceMemberEpoch: 1,
    companyGeneration: 4,
    teamGeneration: 1,
    capabilities: [],
  };
}

/** One held promise, released by hand — the interleavings are the test's to order. */
function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// ---------------------------------------------------------------------------
// 1. The listing read — the advertisement is part of the answer
// ---------------------------------------------------------------------------

test("the listing carries the directory authority advertisement it was answered with", async () => {
  const cases: {
    headers: Record<string, string>;
    body: unknown;
    authority: DirectoryAuthorityAdvertisement | undefined;
  }[] = [
    {
      headers: { "x-openbot-directory-authority": "ba-v1" },
      body: BA_LISTING,
      authority: "ba-v1",
    },
    {
      headers: { "x-openbot-directory-authority": "legacy" },
      body: LEGACY_LISTING,
      authority: "legacy",
    },
    // An unwrapped deployment (the pre-T03.02 mount) answers with no header at all: the old
    // DTO, and the old adapter for every switch.
    { headers: {}, body: LEGACY_LISTING, authority: undefined },
  ];
  for (const one of cases) {
    fetchHandler = (async () =>
      jsonResponse(
        200,
        one.body,
        one.headers,
      )) as unknown as typeof globalThis.fetch;
    const data = await freshClient().fetchQuery(
      workspaceScopeListingQueryOptions("u-1"),
    );
    expect(data.authority).toBe(one.authority);
  }

  // A contract this client does not know is a refusal, never a guessed branch.
  fetchHandler = (async () =>
    jsonResponse(200, LEGACY_LISTING, {
      "x-openbot-directory-authority": "ba-v2",
    })) as unknown as typeof globalThis.fetch;
  let caught: unknown = null;
  try {
    await freshClient().fetchQuery(workspaceScopeListingQueryOptions("u-1"));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkspaceScopeRefusedError);
  expect((caught as WorkspaceScopeRefusedError).code).toBe(
    "DIRECTORY_AUTHORITY_UNKNOWN",
  );
});

// ---------------------------------------------------------------------------
// 2. The validation read — the explicit target, and nothing else on the wire
// ---------------------------------------------------------------------------

test("validate_selection_posts_the_explicit_target_and_carries_no_scope_headers", async () => {
  const asked: Asked[] = [];
  fetchHandler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ input, init });
    return jsonResponse(200, validatedB());
  }) as unknown as typeof globalThis.fetch;

  const validated = await validateWorkspaceScopeSelection(SCOPE_B);

  expect(validated).toEqual(validatedB());
  expect(String(asked[0]?.input)).toBe(
    "/api/enterprise/workspace-scope/validate-selection",
  );
  expect(asked[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(asked[0]?.init?.body))).toEqual({
    tenantId: "b",
    workspaceId: "b-ops",
  });
  // The body is the explicit target; carrying the scope being LEFT would be the §4 conflict
  // the person never chose, and there is no new pair to name until this accepts one.
  expect(headerOf(asked[0]?.init, "x-openbot-tenant")).toBeUndefined();
  expect(headerOf(asked[0]?.init, "x-openbot-workspace")).toBeUndefined();
});

test("a refused or malformed validation is a typed refusal, never an acceptance", async () => {
  fetchHandler = (async () =>
    jsonResponse(403, {
      error: { code: "COMPANY_REAUTH_REQUIRED", message: "Request refused." },
    })) as unknown as typeof globalThis.fetch;
  let caught: unknown = null;
  try {
    await validateWorkspaceScopeSelection(SCOPE_B);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkspaceScopeRefusedError);
  expect((caught as WorkspaceScopeRefusedError).status).toBe(403);
  expect((caught as WorkspaceScopeRefusedError).code).toBe(
    "COMPANY_REAUTH_REQUIRED",
  );

  // A 200 that is not a ValidatedSelection is a malformed acceptance, which is not one.
  fetchHandler = (async () =>
    jsonResponse(200, {
      noted: "not the frozen shape",
    })) as unknown as typeof globalThis.fetch;
  caught = null;
  try {
    await validateWorkspaceScopeSelection(SCOPE_B);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkspaceScopeRefusedError);
  expect((caught as WorkspaceScopeRefusedError).code).toBe(
    "VALIDATION_MALFORMED",
  );
});

// ---------------------------------------------------------------------------
// 3. The coordinator — freeze, validate, prefer, publish, in that order
// ---------------------------------------------------------------------------

test("ba_v1_switch_freezes_validates_updates_preference_then_publishes", async () => {
  const queryClient = freshClient();
  queryClient.setQueryData(selectionKeys.current("u-1"), SCOPE_A);
  const before = generationOf(queryClient, "u-1");
  const sink: string[] = [];
  const validateAsked: ScopeSelection[] = [];
  const gate = held<ValidatedSelection>();
  const validate = async (target: ScopeSelection) => {
    validateAsked.push(target);
    return gate.promise;
  };

  const outcome = switchWorkspaceScope(queryClient, "u-1", SCOPE_A, SCOPE_B, {
    authority: "ba-v1",
    setActiveOrganization: (organizationId) => {
      sink.push(organizationId);
    },
    validate,
  });

  // FROZEN, not published: while the validation is in flight nothing has moved — the old
  // scope still answers, and a request under it still carries its pair.
  await Promise.resolve();
  expect(queryClient.getQueryData(selectionKeys.current("u-1"))).toEqual(
    SCOPE_A,
  );
  expect(sink).toEqual([]);

  gate.release(validatedB());
  const settled = await outcome;

  expect(settled.kind).toBe("published");
  if (settled.kind === "published") {
    expect(settled.selection).toEqual(SCOPE_B);
    expect(settled.preferenceRecorded).toBe(true);
  }
  // The validation was asked for the explicit target — the input decides.
  expect(validateAsked).toEqual([SCOPE_B]);
  // The preference moved to the BOUND organizationId the answer carries, not a tenant guess.
  expect(sink).toEqual(["org-b"]);
  // And only after all of that did the generation publish.
  expect(queryClient.getQueryData(selectionKeys.current("u-1"))).toEqual(
    SCOPE_B,
  );
  expect(generationOf(queryClient, "u-1")).toBeGreaterThan(before);
});

test("delayed_active_a_cannot_replace_explicit_b", async () => {
  const queryClient = freshClient();
  queryClient.setQueryData(selectionKeys.current("u-1"), SCOPE_A);
  const gate = held<ValidatedSelection>();
  const sink: string[] = [];

  // The person explicitly commits B; its validation is still in flight…
  const outcome = switchWorkspaceScope(queryClient, "u-1", SCOPE_A, SCOPE_B, {
    authority: "ba-v1",
    setActiveOrganization: (organizationId) => {
      sink.push(organizationId);
    },
    validate: () => gate.promise,
  });
  await Promise.resolve();

  // …when the delayed active-company A answer finally lands. It is refused: an explicit
  // selection is in progress, and no background response outranks it.
  expect(adoptActivePreference(queryClient, "u-1", SCOPE_A)).toBe(false);

  gate.release(validatedB());
  await outcome;

  const selection = queryClient.getQueryData<ScopeSelection>(
    selectionKeys.current("u-1"),
  );
  if (selection === undefined) throw new Error("the switch published nothing");
  expect(selection.tenantId).toBe("b");
  expect(sink).toEqual(["org-b"]);
});

test("late_validate_a_cannot_commit_after_explicit_b", async () => {
  const queryClient = freshClient();
  const forA = held<ValidatedSelection>();
  const forB = held<ValidatedSelection>();
  const validate = (target: ScopeSelection) =>
    target.tenantId === "a" ? forA.promise : forB.promise;
  const validatedA: ValidatedSelection = {
    ...validatedB(),
    tenantId: "a",
    workspaceId: "a-finance",
    organizationId: "org-a",
    teamId: "team-a-finance",
    memberEpoch: 3,
    workspaceMemberEpoch: 2,
    companyGeneration: 2,
  };

  // An explicit A intent starts first, then an explicit B intent supersedes it before either
  // validation answers.
  const outcomeA = switchWorkspaceScope(queryClient, "u-1", null, SCOPE_A, {
    authority: "ba-v1",
    validate,
  });
  const outcomeB = switchWorkspaceScope(queryClient, "u-1", null, SCOPE_B, {
    authority: "ba-v1",
    validate,
  });
  await Promise.resolve();

  const generationAtFreeze = generationOf(queryClient, "u-1");
  forB.release(validatedB());
  const settledB = await outcomeB;
  expect(settledB.kind).toBe("published");

  // The late A validation resolves afterwards — into a supersession, publishing nothing.
  forA.release(validatedA);
  const settledA = await outcomeA;
  expect(settledA.kind).toBe("superseded");

  const selection = queryClient.getQueryData<ScopeSelection>(
    selectionKeys.current("u-1"),
  );
  if (selection === undefined) throw new Error("the switch published nothing");
  expect(selection.tenantId).toBe("b");
  // B's publish is the only generation move the two intents made between them.
  expect(generationOf(queryClient, "u-1")).toBe(generationAtFreeze + 1);
});

test("active_preference_seeds_only_a_silent_session", async () => {
  const queryClient = freshClient();

  // A session with no explicit selection adopts the preference it is seeded with…
  expect(adoptActivePreference(queryClient, "u-1", SCOPE_A)).toBe(true);
  expect(queryClient.getQueryData(selectionKeys.current("u-1"))).toEqual(
    SCOPE_A,
  );
  // …the first seed wins, and a second background answer never fights it…
  expect(adoptActivePreference(queryClient, "u-1", SCOPE_B)).toBe(false);
  expect(queryClient.getQueryData(selectionKeys.current("u-1"))).toEqual(
    SCOPE_A,
  );

  // …and once a person has chosen explicitly, no late arrival replaces them.
  const settled = await switchWorkspaceScope(
    queryClient,
    "u-1",
    SCOPE_A,
    SCOPE_B,
    {
      authority: "ba-v1",
      validate: async () => validatedB(),
    },
  );
  expect(settled.kind).toBe("published");
  expect(adoptActivePreference(queryClient, "u-1", SCOPE_A)).toBe(false);
  expect(queryClient.getQueryData(selectionKeys.current("u-1"))).toEqual(
    SCOPE_B,
  );
});

test("legacy_authority_keeps_the_old_adapter", async () => {
  const queryClient = freshClient();
  queryClient.setQueryData(selectionKeys.current("u-1"), SCOPE_A);
  const sink: string[] = [];
  const plan = {
    validate: async (): Promise<ValidatedSelection> => {
      throw new Error("the old adapter never validates");
    },
    setActiveOrganization: (organizationId: string) => {
      sink.push(organizationId);
    },
  };

  // The plan may name legacy explicitly, or not at all (an unwrapped deployment); both keep
  // the MT080 switch — eligibility listed, no second gate, no preference write.
  const toB = await switchWorkspaceScope(queryClient, "u-1", SCOPE_A, SCOPE_B, {
    authority: "legacy",
    ...plan,
  });
  expect(toB.kind).toBe("published");
  const backToA = await switchWorkspaceScope(
    queryClient,
    "u-1",
    SCOPE_B,
    SCOPE_A,
    plan,
  );
  expect(backToA.kind).toBe("published");
  expect(queryClient.getQueryData(selectionKeys.current("u-1"))).toEqual(
    SCOPE_A,
  );
  expect(sink).toEqual([]);

  // Leaving a scope is the same under ba-v1: it grants nothing, so it validates nothing.
  const settled = await switchWorkspaceScope(
    queryClient,
    "u-1",
    SCOPE_A,
    null,
    {
      authority: "ba-v1",
      ...plan,
    },
  );
  expect(settled.kind).toBe("published");
  expect(queryClient.getQueryData(selectionKeys.current("u-1"))).toBeNull();
  expect(sink).toEqual([]);
});

test("an_answer_about_another_scope_is_not_an_acceptance_of_this_one", async () => {
  const queryClient = freshClient();
  queryClient.setQueryData(selectionKeys.current("u-1"), SCOPE_A);
  const sink: string[] = [];

  const settled = await switchWorkspaceScope(
    queryClient,
    "u-1",
    SCOPE_A,
    SCOPE_B,
    {
      authority: "ba-v1",
      setActiveOrganization: (organizationId) => {
        sink.push(organizationId);
      },
      validate: async () => ({ ...validatedB(), tenantId: "a" }),
    },
  );

  expect(settled.kind).toBe("refused");
  if (settled.kind === "refused") {
    expect(settled.refusal.code).toBe("VALIDATION_ECHO_MISMATCH");
    expect(settled.selection).toEqual(SCOPE_A);
  }
  // Nothing published, nothing preferred.
  expect(queryClient.getQueryData(selectionKeys.current("u-1"))).toEqual(
    SCOPE_A,
  );
  expect(sink).toEqual([]);
});

// ---------------------------------------------------------------------------
// 4. The binding — the switcher's ids resolve through the listing, never a guess
// ---------------------------------------------------------------------------

test("the_binding_resolves_organization_or_tenant_ids_and_refuses_team_ids", () => {
  expect(companyOfBinding(BA_LISTING, "org-b")?.tenantId).toBe("b");
  expect(companyOfBinding(BA_LISTING, "a")?.tenantId).toBe("a");
  // A BA team row id is neither field: no company, no guess.
  expect(companyOfBinding(BA_LISTING, "team-b-ops")).toBeNull();
  expect(companyOfBinding(null, "org-b")).toBeNull();
  expect(companyOfBinding(LEGACY_LISTING, "b")?.tenantId).toBe("b");
});

// ---------------------------------------------------------------------------
// 5. The registry switcher — one adapter over the one controlled selection source
// ---------------------------------------------------------------------------

test("registry_switcher_rides_the_one_controlled_selection_source", async () => {
  const queryClient = freshClient();
  queryClient.setQueryData(selectionKeys.current("u-1"), SCOPE_A);

  const adapter = organization.openBotScopeSelectionAdapter({
    userId: "u-1",
    queryClient,
    listing: BA_LISTING,
  });

  // The switcher's face reads the same source every other surface reads.
  expect(adapter.userId).toBe("u-1");
  expect(adapter.activeCompanyId).toBe("a");
  expect(adapter.listingQueryKey).toEqual(selectionKeys.listing("u-1"));
  const companies = await adapter.listCompanies();
  expect(companies.map((company) => company.id)).toEqual(["a", "b"]);

  // A company intent through the binding: the old team cannot ride along — a company alone is
  // no scope — and no workspace is ever invented from the BA team row.
  adapter.selectCompany("org-b");
  expect(queryClient.getQueryData(selectionKeys.current("u-1"))).toBeNull();

  // Re-asserting the company already named by no selection changes nothing further.
  adapter.selectCompany("b");
  expect(queryClient.getQueryData(selectionKeys.current("u-1"))).toBeNull();

  // An id the listing does not name — a team row id, a ghost — is no intent at all.
  adapter.selectCompany("team-b-ops");
  adapter.selectCompany("org-ghost");
  expect(queryClient.getQueryData(selectionKeys.current("u-1"))).toBeNull();
});

// ---------------------------------------------------------------------------
// 6. The page — the pickers drive the coordinator; the URL is a verified scope
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
});

/** One answer per route, several answers unroll across retries. */
function serve(options: {
  listing: { status: number; body: unknown; advertisement?: string };
  validate?:
    | { status: number; body: unknown }
    | (() => Response | Promise<Response>);
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
      return typeof options.validate === "function"
        ? options.validate()
        : jsonResponse(options.validate.status, options.validate.body);
    }
    // Anything else — including the BA preference write — answers a bare ok; the caller
    // asserts on what was asked, not on what came back.
    return jsonResponse(200, { data: null });
  }) as unknown as typeof globalThis.fetch;
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

test("failed_switch_never_displays_b_with_a_headers", async () => {
  storeSelection("u-1", SCOPE_A);
  const asked = serve({
    listing: { status: 200, body: BA_LISTING, advertisement: "ba-v1" },
    validate: {
      status: 403,
      body: { error: { code: "COMPANY_REAUTH_REQUIRED" } },
    },
  });
  const queryClient = freshClient();
  const { router, view } = drawPage(queryClient);

  // The verified scope A is on screen…
  expect((await view.findByText(/Working in/)).textContent).toContain("Alpha");

  // …and the person tries to move to company B and its team.
  await pickCompany(view, "Beta");
  await pickTeam(view, "Operations");

  // The validation was asked, and refused. The URL never moved — and once the refusal lands
  // the company picker shows the verified company again: nothing on screen names B.
  await waitFor(() => {
    expect(
      asked.some((one) => String(one.input).includes("validate-selection")),
    ).toBe(true);
  });
  await waitFor(() => {
    expect(
      view.getByRole("button", { name: "Select a company" }).textContent,
    ).toContain("Alpha");
  });
  expect(router.state.location.search).toEqual({});
  expect(
    globalThis.window.localStorage.getItem(selectionStorageKey("u-1")),
  ).toBe(JSON.stringify(SCOPE_A));
  // The refusal never reached the preference write, and B was never displayed as in force.
  expect(
    asked.some((one) => String(one.input).includes("/organization/set-active")),
  ).toBe(false);
  expect(view.getByText(/Working in/).textContent).not.toContain("Beta");

  // The screen and the request headers stay one fact: what renders is what a scoped
  // request under the app's controlled selection carries.
  const selection = queryClient.getQueryData<ScopeSelection>(
    selectionKeys.current("u-1"),
  );
  if (selection === undefined) {
    throw new Error("the refusal left no verified scope in force");
  }
  const renderedTenant = selection.tenantId;
  await client("/api/enterprise/conversations", {
    tenantId: selection.tenantId,
    workspaceId: selection.workspaceId,
  });
  const scoped = asked[asked.length - 1];
  const sentTenant = headerOf(scoped.init, "x-openbot-tenant");
  expect(renderedTenant).toBe(sentTenant);

  // And the pair is whole: the workspace header is A's team, not B's and not any team row.
  expect(headerOf(scoped.init, "x-openbot-workspace")).toBe("a-finance");
});

test("ba_v1_switch_publishes_url_storage_generation_and_preference", async () => {
  const asked = serve({
    listing: { status: 200, body: BA_LISTING, advertisement: "ba-v1" },
    validate: { status: 200, body: validatedB() },
  });
  const queryClient = freshClient();
  const { router, view } = drawPage(queryClient);

  await pickCompany(view, "Beta");
  // A company half never moves the URL under ba-v1: the URL is a verified scope or silent.
  expect(router.state.location.search).toEqual({});
  await pickTeam(view, "Operations");

  await waitFor(() =>
    expect(router.state.location.search).toEqual({
      company: "b",
      team: "b-ops",
    }),
  );
  expect((await view.findByText(/Working in/)).textContent).toContain("Beta");
  expect(
    globalThis.window.localStorage.getItem(selectionStorageKey("u-1")),
  ).toBe(JSON.stringify(SCOPE_B));
  expect(
    queryClient.getQueryData<ScopeSelection>(selectionKeys.current("u-1")),
  ).toEqual(SCOPE_B);
  expect(generationOf(queryClient, "u-1")).toBeGreaterThan(0);

  // The preference write happened once, after validation, with the BOUND organizationId.
  const preferenceWrites = asked.filter((one) =>
    String(one.input).includes("/organization/set-active"),
  );
  expect(preferenceWrites).toHaveLength(1);
  expect(JSON.parse(String(preferenceWrites[0]?.init?.body))).toEqual({
    organizationId: "org-b",
  });
});

test("legacy_page_keeps_the_verified_half_step_switch", async () => {
  const asked = serve({
    // No advertisement: the unwrapped deployment, the MT080 world.
    listing: { status: 200, body: LEGACY_LISTING },
  });
  const queryClient = freshClient();
  const { router, view } = drawPage(queryClient);

  await pickCompany(view, "Beta");

  // The legacy page moves at the half step, exactly as MT080 pinned it…
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ company: "b" }),
  );
  await pickTeam(view, "Operations");
  await waitFor(() =>
    expect(router.state.location.search).toEqual({
      company: "b",
      team: "b-ops",
    }),
  );
  expect((await view.findByText(/Working in/)).textContent).toContain("Beta");
  // …and never asked the §4 gate or the BA preference anything.
  expect(
    asked.some((one) => String(one.input).includes("validate-selection")),
  ).toBe(false);
  expect(
    asked.some((one) => String(one.input).includes("/organization/set-active")),
  ).toBe(false);
});

test("a_pending_company_choice_freezes_the_switch_but_keeps_the_verified_scope", async () => {
  storeSelection("u-1", SCOPE_A);
  const gate = held<Response>();
  serve({
    listing: { status: 200, body: BA_LISTING, advertisement: "ba-v1" },
    validate: () => gate.promise,
  });
  const queryClient = freshClient();
  const { router, view } = drawPage(queryClient);

  await pickCompany(view, "Beta");
  await pickTeam(view, "Operations");

  // While the validation is held, the verified scope is still the one on screen and in
  // force; the pickers are frozen so a second intent cannot pile onto the first.
  expect(view.getByText(/Working in/).textContent).toContain("Alpha");
  expect(router.state.location.search).toEqual({});
  expect(
    queryClient.getQueryData<ScopeSelection>(selectionKeys.current("u-1")),
  ).toEqual(SCOPE_A);

  gate.release(jsonResponse(403, { error: { code: "SCOPE_REVOKED" } }));
  await waitFor(() => {
    expect(
      view
        .getByRole("button", { name: "Select a company" })
        .getAttribute("disabled"),
    ).toBeNull();
  });
  // The refusal restored the verified face: the company picker shows Alpha again.
  expect(
    view.getByRole("button", { name: "Select a company" }).textContent,
  ).toContain("Alpha");
  expect(
    queryClient.getQueryData<ScopeSelection>(selectionKeys.current("u-1")),
  ).toEqual(SCOPE_A);
});
