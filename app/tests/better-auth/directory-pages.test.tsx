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
import { tenantKeys } from "../../src/lib/enterprise/tenant/queries";
import {
  type ScopeSelection,
  selectionKeys,
  type WorkspaceScopeListing,
} from "../../src/lib/enterprise/tenant/selection";

/*
 * The people page's Directory half, T04.10 (Issue #554): the roster a ba-v1 listing row earns,
 * the member/invitation commands the ingress translates, and the T04.07 team-management grants.
 *
 * FOUR THINGS ARE UNDER TEST. First, the roster and its actions ride the Directory: the answer of
 * `/organization/get-full-organization` names the members (fixed owner/admin/member/auditor), and
 * every command addresses the member's userId — the stable id the ingress maps onto the directory
 * command — never the BA member row id, which a re-join recreates. Second, the server's conflicts
 * are actionable words, not lost input: the last-owner 409 keeps the role form exactly as the
 * person left it, and the seat/invitation 409s keep the invite form's email and role. Third, the
 * delegation surface belongs to company managers alone: a scoped team manager (a plain member
 * holding a T04.07 grant, so the §4 listing carries no capability bits) and a read-resource grant
 * holder (finance:read) render no grant control at all — a read grant is not a management grant.
 * Fourth, nothing here can delete the company or impersonate a member, and a legacy listing row
 * keeps the MT095 roster it always had, with no /api/auth read at all.
 *
 * THE HARNESS IS THIS REPOSITORY'S (the T04.09 company-team suite): one stable fetch dispatcher
 * installed before anything that captures fetch, the people route's exported singleton re-parented
 * into a memory router, the scope seeded straight into the query cache.
 */

type PeopleRouteModule =
  typeof import("../../src/routes/_authed/tenant/admin/people");

let peopleRoute: PeopleRouteModule;

let fetchHandler: typeof globalThis.fetch;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof globalThis.fetch;
  fetchHandler = originalFetch;
  peopleRoute = await import("../../src/routes/_authed/tenant/admin/people");
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

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return null;
  if (headers instanceof Headers) return headers.get(name) ?? null;
  return (headers as Record<string, string>)[name] ?? null;
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE: ScopeSelection = { tenantId: "a", workspaceId: "a-eng" };

/** The ba-v1 answer for a company-role manager: both management capabilities ride the owner role. */
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

/** The scoped team manager: a plain member holding a T04.07 grant — so the row carries no bits. */
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

/** A read-resource grant holder: finance/audit reads, never a management grant. */
const READ_GRANT_LISTING: WorkspaceScopeListing = {
  companies: [
    {
      tenantId: "a",
      organizationId: "org-a",
      name: "Alpha",
      role: "member",
      memberEpoch: 3,
      capabilities: ["finance:read", "audit:metadata:read"],
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

/*
 * The Directory's full-organization answer. Every member row's BA id deliberately differs from its
 * userId: the tests pin that commands address the userId (the stable id the ingress maps onto the
 * directory command), never the row id a re-join recreates.
 */
const FULL_ORG = {
  organization: {
    id: "org-a",
    name: "Alpha",
    slug: "alpha",
    createdAt: "2026-09-01T00:00:00.000Z",
  },
  members: [
    {
      id: "member-row-owner",
      userId: "user-owner",
      role: "owner",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "member-row-2",
      userId: "user-2",
      role: "member",
      createdAt: "2026-09-02T00:00:00.000Z",
    },
  ],
  invitations: [
    {
      id: "inv-1",
      email: "new.person@example.com",
      role: "member",
      status: "pending",
      expiresAt: "2026-11-01T00:00:00.000Z",
    },
  ],
  teams: [],
};

const LEGACY_PEOPLE = {
  members: [
    {
      principalId: "prin-1",
      userId: "user-legacy-1",
      role: "tenant_admin",
      status: "active",
      epoch: 1,
      joinedAt: "2026-09-01T00:00:00.000Z",
    },
  ],
};

const GRANTS_ANSWER = {
  grants: [
    {
      grantId: "grant-1",
      tenantId: "a",
      workspaceId: "a-eng",
      userId: "user-2",
      actions: ["team.member.add", "team.member.remove"],
      generation: 1,
      status: "active",
    },
  ],
};

/** One named directory write the page can attempt, with the status and code it answers. */
type StubbedWrite = { status: number; code: string };

/**
 * Answers everything the people page reads and writes. The listing is the test's to choose; each
 * directory write can be stubbed to a refusal; everything else answers a quiet success.
 */
function servePeople(
  options: {
    listing?: unknown;
    authority?: string;
    roleWrite?: StubbedWrite;
    inviteWrite?: StubbedWrite;
    removeWrite?: StubbedWrite;
    grantsWrite?: StubbedWrite;
  } = {},
): Asked[] & { served: { path: string; status: number }[] } {
  const asked: Asked[] = [];
  const served: { path: string; status: number }[] = [];
  const write = (stub: StubbedWrite | undefined, path: string) => {
    if (stub === undefined) return jsonResponse(200, {});
    served.push({ path, status: stub.status });
    return jsonResponse(stub.status, { error: { code: stub.code } });
  };
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
    if (path === "/api/enterprise/workspace-scope/admin/people") {
      return jsonResponse(200, LEGACY_PEOPLE);
    }
    if (path === "/api/enterprise/workspace-scope/admin/credentials") {
      return jsonResponse(200, { credentials: [] });
    }
    if (path === "/api/enterprise/workspace-scope/admin/identity") {
      return jsonResponse(200, { sso: null, scimBindings: [] });
    }
    if (path === "/api/auth/organization/get-full-organization") {
      return jsonResponse(200, FULL_ORG);
    }
    if (path === "/api/auth/organization/update-member-role") {
      return write(options.roleWrite, path);
    }
    if (path === "/api/auth/organization/invite-member") {
      return write(options.inviteWrite, path);
    }
    if (path === "/api/auth/organization/remove-member") {
      return write(options.removeWrite, path);
    }
    if (path === "/api/auth/organization/cancel-invitation") {
      return jsonResponse(200, {});
    }
    if (
      path ===
      "/api/enterprise/workspace-scope/admin/teams/a-eng/management-grants"
    ) {
      return methodOf(init) === "GET"
        ? jsonResponse(200, GRANTS_ANSWER)
        : write(options.grantsWrite, path);
    }
    if (path.includes("/management-grants/")) {
      return write(options.grantsWrite, path);
    }
    return jsonResponse(200, {});
  }) as unknown as typeof globalThis.fetch;
  return Object.assign(asked, { served });
}

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The selection in force, in the two places the coordinator reads it from. */
function seedScope(queryClient: QueryClient): void {
  queryClient.setQueryData(selectionKeys.current("u-1"), SCOPE);
  queryClient.setQueryData(tenantKeys.generation("u-1"), 1);
}

/** The real people route in a memory router. */
function drawPeople(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: Outlet });
  const people = (
    peopleRoute.Route as unknown as {
      update: (options: unknown) => unknown;
    }
  ).update({
    id: "/tenant/admin/people",
    getParentRoute: () => rootRoute,
    path: "/tenant/admin/people",
  });
  const tree = rootRoute.addChildren([people as never]);
  const router = createRouter({
    history: createMemoryHistory({
      initialEntries: ["/tenant/admin/people"],
    }),
    routeTree: tree,
  } as never);
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// The named cases
// ---------------------------------------------------------------------------

test("owner_actions_ride_directory_commands_with_stable_ids", async () => {
  const asked = servePeople({ listing: OWNER_LISTING, authority: "ba-v1" });
  const queryClient = freshClient();
  seedScope(queryClient);
  const screen = drawPeople(queryClient);

  // The Directory roster rendered: fixed roles, the BA row ids never shown as the member.
  expect(await screen.findByText("user-owner")).toBeTruthy();
  const roleOfMember = screen.getByLabelText(
    "Role of user-2",
  ) as HTMLSelectElement;
  expect(roleOfMember.value).toBe("member");
  expect(screen.queryByText("member-row-owner")).toBeNull();

  const user = userEvent.setup({ document });
  await user.selectOptions(screen.getByLabelText("Role of user-2"), "admin");
  // The enabled Set-role button is the member's own row; the owner row's stays disabled
  // (its draft still equals its role).
  const apply = screen
    .getAllByRole("button", { name: "Set role" })
    .find((button) => !button.hasAttribute("disabled"));
  expect(apply).toBeTruthy();
  await user.click(apply as HTMLElement);

  const write = await waitFor(() => {
    const found = asked.find(
      ({ input }) =>
        String(input) === "/api/auth/organization/update-member-role",
    );
    expect(found).toBeTruthy();
    return found as Asked;
  });
  // Flat ingress body; the command addresses the userId, not the BA member row id.
  const body = bodyOf(write.init);
  expect(body.organizationId).toBe("org-a");
  expect(body.memberId).toBe("user-2");
  expect(body.role).toBe("admin");
  // And no control anywhere deletes the company or impersonates a member.
  expect(screen.queryByRole("button", { name: /impersonat/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
});

test("owner_conflict_is_actionable_and_preserves_form", async () => {
  const asked = servePeople({
    listing: OWNER_LISTING,
    authority: "ba-v1",
    roleWrite: { status: 409, code: "MEMBERSHIP_LIFECYCLE_LAST_OWNER" },
  });
  const queryClient = freshClient();
  seedScope(queryClient);
  const screen = drawPeople(queryClient);

  const user = userEvent.setup({ document });
  const roleOfOwner = await screen.findByLabelText("Role of user-owner");
  // Demote the only owner: the directory refuses to leave the company ownerless.
  await user.selectOptions(roleOfOwner, "member");
  const beforeValues = { role: (roleOfOwner as HTMLSelectElement).value };
  await user.click(screen.getAllByRole("button", { name: "Set role" })[0]);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "This is the company's last owner. Transfer ownership to another member first, then change this role.",
  );
  expect(document.activeElement).toBe(alert);
  // The refusal the form handled was the directory's last-owner conflict, and the form keeps
  // exactly what the person chose: nothing was reset by the refusal.
  const status = asked.served.find(
    (entry) => entry.path === "/api/auth/organization/update-member-role",
  )?.status;
  expect(status).toBe(409);
  const formValues = { role: (roleOfOwner as HTMLSelectElement).value };
  expect(formValues).toEqual(beforeValues);
});

test("invite_conflict_preserves_input", async () => {
  servePeople({
    listing: OWNER_LISTING,
    authority: "ba-v1",
    inviteWrite: { status: 409, code: "MEMBERSHIP_INVITATION_SEATS_EXHAUSTED" },
  });
  const queryClient = freshClient();
  seedScope(queryClient);
  const screen = drawPeople(queryClient);

  const user = userEvent.setup({ document });
  await user.type(await screen.findByLabelText("Email"), "joiner@example.com");
  await user.selectOptions(screen.getByLabelText("Invite as"), "auditor");
  await user.click(screen.getByRole("button", { name: "Invite" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "The company's seats are full. Free a seat before inviting another member.",
  );
  // The invite form keeps its input: the email and the role survive the refusal.
  expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
    "joiner@example.com",
  );
  expect((screen.getByLabelText("Invite as") as HTMLSelectElement).value).toBe(
    "auditor",
  );
});

test("paused_directory_answers_wait_copy", async () => {
  servePeople({
    listing: OWNER_LISTING,
    authority: "ba-v1",
    inviteWrite: { status: 503, code: "DIRECTORY_AUTHORITY_PAUSED" },
  });
  const queryClient = freshClient();
  seedScope(queryClient);
  const screen = drawPeople(queryClient);

  const user = userEvent.setup({ document });
  await user.type(await screen.findByLabelText("Email"), "joiner@example.com");
  await user.click(screen.getByRole("button", { name: "Invite" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "Company changes are paused right now. Try again later.",
  );
});

test("ordinary_scoped_manager_cannot_render_delegate_action", async () => {
  const asked = servePeople({
    listing: SCOPED_MANAGER_LISTING,
    authority: "ba-v1",
  });
  const queryClient = freshClient();
  seedScope(queryClient);
  const screen = drawPeople(queryClient);

  // The roster itself renders for a member — but with no action and no delegation entry at all.
  expect(await screen.findByText("user-2")).toBeTruthy();
  const delegateAction = screen.queryByRole("button", { name: "Grant" });
  expect(delegateAction).toBeNull();
  expect(screen.queryByLabelText("Role of user-2")).toBeNull();
  expect(screen.queryByRole("button", { name: "Set role" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove member" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Cancel invitation" }),
  ).toBeNull();
  // And no management-grant read was attempted: the capability answer said not a manager.
  expect(
    asked.some(({ input }) => String(input).includes("/management-grants")),
  ).toBe(false);
});

test("read_resource_grant_is_not_a_management_grant", async () => {
  const asked = servePeople({
    listing: READ_GRANT_LISTING,
    authority: "ba-v1",
  });
  const queryClient = freshClient();
  seedScope(queryClient);
  const screen = drawPeople(queryClient);

  expect(await screen.findByText("user-2")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(
    asked.some(({ input }) => String(input).includes("/management-grants")),
  ).toBe(false);
});

test("team_grants_grant_and_revoke_ride_t04_07_endpoints", async () => {
  const asked = servePeople({ listing: OWNER_LISTING, authority: "ba-v1" });
  const queryClient = freshClient();
  seedScope(queryClient);
  const screen = drawPeople(queryClient);

  // The stable rows answer the list: the holder, the granted actions, and the state echo.
  expect(await screen.findByText("Team management grants")).toBeTruthy();
  expect(await screen.findByText("Active")).toBeTruthy();

  const user = userEvent.setup({ document });
  await user.type(await screen.findByLabelText("User id"), "user-3");
  await user.click(screen.getByLabelText("Add members"));
  await user.click(screen.getByLabelText("Remove members"));
  await user.click(screen.getByRole("button", { name: "Grant" }));

  const grant = await waitFor(() => {
    const found = asked.find(
      ({ input, init }) =>
        String(input).endsWith("/management-grants") &&
        methodOf(init) === "POST",
    );
    expect(found).toBeTruthy();
    return found as Asked;
  });
  expect(String(grant.input)).toBe(
    "/api/enterprise/workspace-scope/admin/teams/a-eng/management-grants",
  );
  expect(headerOf(grant.init, "x-openbot-tenant")).toBe("a");
  expect(headerOf(grant.init, "x-openbot-workspace")).toBe("a-eng");
  // The writer command is idempotent by the server's own key discipline.
  expect(typeof headerOf(grant.init, "idempotency-key")).toBe("string");
  expect(bodyOf(grant.init).userId).toBe("user-3");
  expect(bodyOf(grant.init).actions).toEqual([
    "team.member.add",
    "team.member.remove",
  ]);

  // Revoke needs the reason the audit row records.
  await user.click(screen.getByRole("button", { name: "Revoke" }));
  await user.type(screen.getByLabelText("Revocation reason"), "rotation");
  await user.click(screen.getByRole("button", { name: "Confirm revocation" }));

  await waitFor(() => {
    const revoke = asked.find(
      ({ input, init }) =>
        String(input).endsWith("/management-grants/grant-1") &&
        methodOf(init) === "DELETE",
    );
    expect(revoke).toBeTruthy();
    expect(bodyOf(revoke?.init).reason).toBe("rotation");
  });
});

test("legacy_company_keeps_mt095_roster", async () => {
  const asked = servePeople({ listing: LEGACY_LISTING });
  const queryClient = freshClient();
  seedScope(queryClient);
  const screen = drawPeople(queryClient);

  // The legacy roster renders with its own actions, and no directory read was attempted at all.
  expect(await screen.findByText("prin-1")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Demote to member" })).toBeTruthy();
  expect(
    asked.some(({ input }) => String(input).includes("/api/auth/organization")),
  ).toBe(false);
});
