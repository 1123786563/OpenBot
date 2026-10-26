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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "../../../tests/support/e2e-compat";
import { companyAdminSections } from "../../src/components/company-admin/company-admin-area";
import { tenantKeys } from "../../src/lib/enterprise/tenant/queries";
import {
  type ScopeSelection,
  selectionKeys,
  type WorkspaceScopeListing,
} from "../../src/lib/enterprise/tenant/selection";
import enCompanyAdmin from "../../src/locales/en/company-admin.json";
import zhCompanyAdmin from "../../src/locales/zh-CN/company-admin.json";

/*
 * The company profile and team member pages of the fixed registry, T04.09 (Issue #553, the P10
 * half this ticket owns).
 *
 * THREE THINGS ARE UNDER TEST HERE. First, the page the fixed registry mounts at
 * /organization/$view reuses the app's own surfaces: the company profile allows exactly
 * name/slug/logo through the Directory command adapter (the real BA-native endpoint the ingress
 * translates to company.profile.update — a FLAT body, as the ingress's own suite pins), the
 * status stays read-only, and closing a company stays a reviewed request with no button here.
 * Second, the two command adapters never bleed into each other: a scoped team manager's page
 * sends only the workspace-scoped team member routes T04.08 owns, and never any
 * /api/auth/organization write; a company-role manager gets the profile write, and legacy
 * deployments keep the read-only profile they always had. Third, the server's refusals arrive
 * as words a person can act on, with the focus landing on them.
 *
 * THE CAPABILITY FACTS ARE THE LISTING'S (interfaces §4): capabilitiesFor derives
 * company:manage/team:members:manage from the role row alone, so a grant-holding plain member
 * carries no capability bits — the team controls still render for them, and the server's
 * company-role|team-grant check inside the T04.08 route is the authority (fail-closed). That is
 * the persona the scoped-manager case builds.
 *
 * THE HARNESS IS THIS REPOSITORY'S (the MT080 selection suite and the T03.07 shell suite): one
 * stable fetch dispatcher installed before anything that captures fetch, exported Route
 * singletons re-parented into a memory router, and the organization route imported dynamically
 * after the DOM registers because its provider chain evaluates the Better Auth client singleton
 * at module scope.
 */

type OrganizationRouteModule =
  typeof import("../../src/routes/_authed/organization/$view");

let organizationRoute: OrganizationRouteModule;

let fetchHandler: typeof globalThis.fetch;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof globalThis.fetch;
  fetchHandler = originalFetch;
  // The route module pulls the fixed-UI provider chain, whose Better Auth client singleton
  // evaluates at module scope — under the DOM, and under the dispatcher above.
  organizationRoute = await import(
    "../../src/routes/_authed/organization/$view"
  );
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

function methodOf(init: RequestInit | undefined): string {
  return (init?.method as string | undefined) ?? "GET";
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE: ScopeSelection = { tenantId: "a", workspaceId: "a-eng" };

/** The ba-v1 answer for a company-role manager: both capabilities ride the owner role. */
const OWNER_LISTING: WorkspaceScopeListing = {
  companies: [
    {
      tenantId: "a",
      organizationId: "org-a",
      name: "Alpha",
      role: "owner",
      memberEpoch: 3,
      companyGeneration: 2,
      capabilities: ["company:manage", "team:members:manage"],
      teams: [{ workspaceId: "a-eng", name: "Engineering" }],
    },
  ],
};

/*
 * The scoped team manager: a plain member holding a T04.07 grant. The §4 listing derives
 * capabilities from the role row alone, so this row carries none — the team controls still
 * render, and the server's grant check inside the T04.08 route is the authority.
 */
const SCOPED_MANAGER_LISTING: WorkspaceScopeListing = {
  companies: [
    {
      tenantId: "a",
      organizationId: "org-a",
      name: "Alpha",
      role: "member",
      memberEpoch: 3,
      teams: [{ workspaceId: "a-eng", name: "Engineering" }],
    },
  ],
};

/** The legacy authority's answer: no advertisement, no binding fields, no capabilities. */
const LEGACY_LISTING: WorkspaceScopeListing = {
  companies: [
    {
      tenantId: "a",
      name: "Alpha",
      role: "tenant_admin",
      memberEpoch: 3,
      teams: [{ workspaceId: "a-eng", name: "Engineering" }],
    },
  ],
};

const COMPANY_CONFIG = {
  tenantId: "a",
  name: "Alpha",
  status: "active",
  teams: [{ workspaceId: "a-eng", name: "Engineering" }],
  membersByRole: [{ role: "tenant_admin", count: 2 }],
  offboardedCount: 0,
};

/**
 * Answers everything the organization page reads. The listing and the refusals are the test's
 * to choose; everything else answers a quiet empty success.
 */
function serveOrganization(
  options: {
    listing?: unknown;
    authority?: string;
    teamStatus?: number;
    updateStatus?: number;
  } = {},
): Asked[] {
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
        ...(options.authority !== undefined
          ? { "x-openbot-directory-authority": options.authority }
          : {}),
      });
    }
    if (path === "/api/enterprise/workspace-scope/admin/enterprise-config") {
      return jsonResponse(200, COMPANY_CONFIG);
    }
    if (path.startsWith("/api/enterprise/workspace-scope/admin/teams/")) {
      if (options.teamStatus !== undefined) {
        return jsonResponse(options.teamStatus as number, {
          error: { code: "TEAM_REFUSED" },
        });
      }
      return methodOf(init) === "DELETE"
        ? jsonResponse(200, {})
        : jsonResponse(201, { membership: { workspaceId: "a-eng" } });
    }
    if (path === "/api/auth/organization/update") {
      return options.updateStatus !== undefined
        ? jsonResponse(options.updateStatus as number, {
            error: { code: "PROFILE_REFUSED" },
          })
        : jsonResponse(200, { id: "org-a", name: "Alpha" });
    }
    return jsonResponse(200, {});
  }) as unknown as typeof globalThis.fetch;
  return asked;
}

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The selection in force, in the two places the coordinator reads it from. */
function seedScope(queryClient: QueryClient): void {
  queryClient.setQueryData(selectionKeys.current("u-1"), SCOPE);
  queryClient.setQueryData(tenantKeys.generation("u-1"), 1);
}

/** The real organization route in a memory router, at the view the test names. */
function drawOrganization(queryClient: QueryClient, view: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const organization = (
    organizationRoute.Route as unknown as {
      update: (options: unknown) => unknown;
    }
  ).update({
    id: "/organization/$view",
    getParentRoute: () => rootRoute,
    path: "/organization/$view",
  });
  const tree = rootRoute.addChildren([organization as never]);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [`/organization/${view}`] }),
    routeTree: tree,
  } as never);
  const screen = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { router, screen };
}

function pick(json: unknown, key: string): string {
  return (
    (json as Record<string, string> | null)?.[key] ?? `${"missing "}${key}`
  );
}

// ---------------------------------------------------------------------------
// The named cases
// ---------------------------------------------------------------------------

test("scoped_manager_uses_only_team_command", async () => {
  const asked = serveOrganization({
    listing: SCOPED_MANAGER_LISTING,
    authority: "ba-v1",
  });
  const queryClient = freshClient();
  seedScope(queryClient);
  const { screen } = drawOrganization(queryClient, "members");

  // The team surface itself had to render for this to mean anything.
  expect(await screen.findByText("Team members")).toBeTruthy();

  const user = userEvent.setup({ document });
  await user.type(await screen.findByLabelText("Member id"), "principal-7");
  await user.click(screen.getByRole("button", { name: "Add member" }));

  await waitFor(() => {
    expect(
      asked.some(({ input }) =>
        String(input).startsWith(
          "/api/enterprise/workspace-scope/admin/teams/",
        ),
      ),
    ).toBe(true);
  });

  const teamWrites = asked.filter(
    ({ input, init }) =>
      String(input).startsWith(
        "/api/enterprise/workspace-scope/admin/teams/",
      ) && methodOf(init) !== "GET",
  );
  expect(teamWrites.length).toBe(1);
  const sentPath = String(teamWrites[0].input).split("?")[0];
  const expectedScopedPath =
    "/api/enterprise/workspace-scope/admin/teams/a-eng/members";
  expect(sentPath).toBe(expectedScopedPath);
  // The scoped pair rides the request: the server's own scope resolver reads these headers.
  expect(headerOf(teamWrites[0].init, "x-openbot-tenant")).toBe("a");
  expect(headerOf(teamWrites[0].init, "x-openbot-workspace")).toBe("a-eng");
  // And nothing else was written: no company-profile write, no BA-native organization write.
  expect(
    asked.some(
      ({ input, init }) =>
        String(input).startsWith("/api/auth/organization") &&
        methodOf(init) !== "GET",
    ),
  ).toBe(false);
});

test("dangerous_company_actions_have_no_callable_control", async () => {
  serveOrganization({ listing: OWNER_LISTING, authority: "ba-v1" });
  const queryClient = freshClient();
  seedScope(queryClient);
  const { screen } = drawOrganization(queryClient, "settings");

  // The profile surface rendered, and the one write it offers is the profile save.
  expect(await screen.findByText("Company profile")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();

  const impersonateButton = screen.queryByRole("button", {
    name: /impersonat/i,
  });
  expect(impersonateButton).toBeNull();
  expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /suspend/i })).toBeNull();
});

test("company_profile_update_rides_the_directory_command", async () => {
  const asked = serveOrganization({
    listing: OWNER_LISTING,
    authority: "ba-v1",
  });
  const queryClient = freshClient();
  seedScope(queryClient);
  const { screen } = drawOrganization(queryClient, "settings");

  const user = userEvent.setup({ document });
  // The slug field starts empty: typing into it avoids userEvent.clear, whose synthetic select-all
  // + delete a controlled react-aria input reverts under happy-dom (the typed text would append to
  // the restored value). The name rides along from the loaded profile, which is the point: the
  // body is flat and names exactly the profile fields.
  await user.type(await screen.findByLabelText("Slug"), "alpha-renamed");
  await user.click(screen.getByRole("button", { name: "Save changes" }));

  const update = await waitFor(() => {
    const found = asked.find(
      ({ input }) => String(input) === "/api/auth/organization/update",
    );
    expect(found).toBeTruthy();
    return found as Asked;
  });
  // The ingress reads a FLAT body (its own suite pins {organizationId, name}); the BA client's
  // {data: …} wrapper would name none of name/slug/logo and be refused with 400.
  const body = JSON.parse(String(update.init?.body)) as Record<string, string>;
  expect(pick(body, "organizationId")).toBe("org-a");
  expect(pick(body, "slug")).toBe("alpha-renamed");
  expect(pick(body, "name")).toBe("Alpha");
  expect(Object.keys(body).sort()).toEqual(["name", "organizationId", "slug"]);
});

test("scoped_member_profile_is_read_only", async () => {
  const asked = serveOrganization({
    listing: SCOPED_MANAGER_LISTING,
    authority: "ba-v1",
  });
  const queryClient = freshClient();
  seedScope(queryClient);
  const { screen } = drawOrganization(queryClient, "settings");

  expect(await screen.findByText("Company profile")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  // No admin-gated read was attempted either: the capability answer said this member
  // manages no company surface, so the page asks for none of them.
  expect(
    asked.some(({ input }) =>
      String(input).includes("/admin/enterprise-config"),
    ),
  ).toBe(false);
});

test("legacy_company_keeps_read_only_profile", async () => {
  serveOrganization({ listing: LEGACY_LISTING });
  const queryClient = freshClient();
  seedScope(queryClient);
  const { screen } = drawOrganization(queryClient, "settings");

  expect(await screen.findByText("Company profile")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
});

test("team_refusal_answers_recoverable_copy_with_focus", async () => {
  serveOrganization({
    listing: SCOPED_MANAGER_LISTING,
    authority: "ba-v1",
    teamStatus: 403,
  });
  const queryClient = freshClient();
  seedScope(queryClient);
  const { screen } = drawOrganization(queryClient, "members");

  const user = userEvent.setup({ document });
  await user.type(await screen.findByLabelText("Member id"), "principal-7");
  await user.click(screen.getByRole("button", { name: "Add member" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "You can't manage this team's members. Ask a company admin.",
  );
  // The refusal is where the focus landed: the person reads it without hunting for it.
  expect(document.activeElement).toBe(alert);
});

// ---------------------------------------------------------------------------
// The entry the company admin area offers
// ---------------------------------------------------------------------------

function tOf(bundle: unknown): (key: string) => string {
  return (key: string) => {
    let node: unknown = bundle;
    for (const part of key.split(".")) {
      node = (node as Record<string, unknown> | null)?.[part];
    }
    return typeof node === "string" ? node : key;
  };
}

test("company_admin_area_offers_organization_section", () => {
  const manages = {
    tenantId: "a",
    principalId: "p-1",
    peopleAdmin: true,
    auditReader: false,
    financeReader: false,
    billingManager: false,
  };
  const sections = companyAdminSections(manages, tOf(enCompanyAdmin) as never);
  const entry = sections.find(
    (section) => section.to === "/organization/settings",
  );
  expect(entry?.label).toBe("Organization");

  const zhSections = companyAdminSections(
    manages,
    tOf(zhCompanyAdmin) as never,
  );
  expect(
    zhSections.find((section) => section.to === "/organization/settings")
      ?.label,
  ).toBe("组织");

  // A member with no company capability gets no entry — the nav renders the server's answer.
  const refused = companyAdminSections(
    { ...manages, peopleAdmin: false },
    tOf(enCompanyAdmin) as never,
  );
  expect(
    refused.some((section) => section.to === "/organization/settings"),
  ).toBe(false);
});
