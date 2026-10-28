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
import type { PlatformIdentityReceipt } from "../../src/lib/auth/client";
import { authKeys } from "../../src/lib/auth/queries";
import { tenantKeys } from "../../src/lib/enterprise/tenant/queries";
import {
  type ScopeSelection,
  selectionKeys,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import type { Route as PeopleRoute } from "../../src/routes/_authed/admin/people";
import type { Route as AdminRoute } from "../../src/routes/_authed/admin/route";

/**
 * The platform account-admin screen, T05.16 (P13).
 *
 * WHAT IS UNDER TEST. The people screen is the platform's: creating somebody, editing their
 * name, setting their password, and revoking one session or all of them all go through the
 * native admin surface the ingress translates into identity commands (T05.08), and a company
 * admin, whose global role is `user`, never reaches the screen at all. Nothing here can
 * impersonate or delete. A password write or an access removal against the admin's own account
 * kills the session this browser holds, so the old identity and selection state must not
 * outlive it. Restoring somebody says what comes back, and does not promise their old access
 * returns with it.
 *
 * THE HARNESS IS THIS REPOSITORY'S, as in the T05.15 assurance suite: the exported admin
 * layout and people routes re-parented into a memory router over the one fetch dispatcher.
 */

let admin: typeof AdminRoute;
let people: typeof PeopleRoute;
let requests: { path: string; body: Record<string, unknown> }[];
let fetchHandler: typeof globalThis.fetch;
const originalFetch = globalThis.BunTEST_ORIGINAL_FETCH ?? globalThis.fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof globalThis.fetch;
  fetchHandler = originalFetch;
  admin = (await import("../../src/routes/_authed/admin/route")).Route;
  people = (await import("../../src/routes/_authed/admin/people")).Route;
});

beforeEach(() => {
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

const ADMIN_ID = "u-admin";
const SCOPE: ScopeSelection = { tenantId: "a", workspaceId: "a-finance" };

/** The receipt every identity write answers with (interfaces §2.1). */
function receipt(userId: string) {
  return {
    commandId: `cmd-${userId}`,
    replayed: false,
    userId,
    principalId: `prin-${userId}`,
    identityGeneration: 2,
  };
}

const PEOPLE = [
  {
    id: ADMIN_ID,
    email: "admin@example.test",
    name: "Admin",
    image: null,
    role: "admin",
    providers: ["google"],
    lastSignedInAt: "2026-10-01T00:00:00.000Z",
    revoked: false,
    configuredAdmin: true,
  },
  {
    id: "u-person",
    email: "person@example.test",
    name: "Person",
    image: null,
    role: "user",
    providers: [],
    lastSignedInAt: null,
    revoked: false,
    configuredAdmin: false,
  },
  {
    id: "u-gone",
    email: "gone@example.test",
    name: "Gone",
    image: null,
    role: "user",
    providers: [],
    lastSignedInAt: null,
    revoked: true,
    configuredAdmin: false,
  },
];

const SESSIONS = [
  {
    id: "s-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    userAgent: "Mozilla/5.0 laptop",
    ipAddress: "203.0.113.1",
  },
  {
    id: "s-2",
    createdAt: "2026-10-02T00:00:00.000Z",
    expiresAt: "2026-11-02T00:00:00.000Z",
    userAgent: "Mozilla/5.0 phone",
    ipAddress: "203.0.113.2",
  },
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type WriteAnswer = (body: Record<string, unknown>) => number | unknown;

/**
 * The platform world: a signed-in admin (their own row in the list), the roster, and the native
 * account-admin writes. Every write is recorded; `answers` lets a test fail one of them.
 */
function serve(world: {
  meRole?: string;
  answers?: Partial<
    Record<
      | "/api/auth/admin/create-user"
      | "/api/auth/admin/update-user"
      | "/api/auth/admin/set-user-password"
      | "/api/auth/admin/revoke-user-session"
      | "/api/auth/admin/revoke-user-sessions",
      WriteAnswer
    >
  >;
}) {
  fetchHandler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.origin,
    );
    const path = `${url.pathname}${url.search}`;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    requests.push({ path, body });
    if (path === "/api/me") {
      return jsonResponse(200, {
        user: {
          id: ADMIN_ID,
          email: "admin@example.test",
          name: "Admin",
          role: world.meRole ?? "admin",
          onboarding: { step: 1, completedAt: "2026-01-01T00:00:00.000Z" },
        },
      });
    }
    if (path === "/api/admin/people") {
      return jsonResponse(200, { people: PEOPLE, nextCursor: null });
    }
    if (path === "/api/auth/admin/list-user-sessions") {
      return jsonResponse(200, { sessions: SESSIONS });
    }
    const answer =
      world.answers?.[path as keyof NonNullable<typeof world.answers>];
    if (answer) {
      const result = answer(body);
      return typeof result === "number"
        ? jsonResponse(result, { message: `refused:${path}` })
        : jsonResponse(200, result);
    }
    if (path.startsWith("/api/auth/admin/")) {
      return jsonResponse(200, receipt(String(body.userId ?? "u-born")));
    }
    return jsonResponse(200, {});
  }) as typeof globalThis.fetch;
}

function drawAdmin(entry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const reparent = (route: unknown, options: Record<string, unknown>) =>
    (route as { update(o: unknown): unknown }).update.call(route, options);
  reparent(admin, {
    id: "/_authed/admin",
    path: "/admin",
    getParentRoute: () => root,
  });
  reparent(people, {
    id: "/_authed/admin/people",
    path: "/people",
    getParentRoute: () => admin as never,
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <div>home</div>,
  });
  const tree = (
    admin as unknown as { addChildren(children: unknown[]): unknown }
  ).addChildren([people as never]);
  const router = createRouter({
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [entry] }),
    routeTree: root.addChildren([tree as never, home as never]),
  } as never);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { queryClient, view };
}

/** The dialog of one person's account, opened from their row. */
async function openManage(
  view: ReturnType<typeof render>,
  email: string,
): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup({ document });
  await view.findByText(new RegExp(email.replace(".", "\\.")));
  await user.click(
    view.getByRole("button", { name: `Manage account: ${email}` }),
  );
  return user;
}

test("company_admin_cannot_enter_platform_user_admin", async () => {
  // A company admin's global role is `user`: the entrance itself refuses them, before any
  // admin request can leave the browser.
  serve({ meRole: "user" });
  const { view } = drawAdmin("/admin/people");

  expect(await view.findByText("home")).toBeTruthy();
  const adminRequests = requests.filter(
    (one) =>
      one.path.startsWith("/api/admin") ||
      one.path.startsWith("/api/auth/admin"),
  );
  expect(adminRequests).toHaveLength(0);
});

test("password_or_disable_action_clears_old_identity_state", async () => {
  serve({});
  storeSelection(ADMIN_ID, SCOPE);
  const { queryClient, view } = drawAdmin("/admin/people");

  // The world this browser held before the action: who it is, and the company it worked in.
  queryClient.setQueryData(authKeys.currentUser(), {
    id: ADMIN_ID,
    email: "admin@example.test",
  });
  queryClient.setQueryData(selectionKeys.current(ADMIN_ID), SCOPE);
  queryClient.setQueryData(tenantKeys.generation(ADMIN_ID), 3);

  // The admin sets their OWN password: every session of theirs dies, this browser's included.
  const user = await openManage(view, "admin@example.test");
  await user.type(view.getByLabelText("New password"), "a-fresh-secret");
  await user.type(
    view.getByRole("textbox", { name: "Why (kept in the audit log)" }),
    "t0516 self reset",
  );
  await user.click(view.getByRole("button", { name: "Set password" }));

  await waitFor(() => {
    expect(queryClient.getQueryData(authKeys.currentUser()) ?? null).toBeNull();
  });
  const write = requests.find(
    (one) => one.path === "/api/auth/admin/set-user-password",
  );
  expect(write?.body).toEqual({
    userId: ADMIN_ID,
    newPassword: "a-fresh-secret",
    reason: "t0516 self reset",
  });
  // The selection half died with the identity: no company, generation or scope survives.
  expect(
    queryClient.getQueryData(selectionKeys.current(ADMIN_ID)) ?? null,
  ).toBeNull();
  expect(
    queryClient.getQueryData(tenantKeys.generation(ADMIN_ID)) ?? null,
  ).toBe(null);
});

test("revoking_every_session_of_yourself_clears_old_identity_state_too", async () => {
  // The same teardown rides every action that kills the target's sessions, not only the
  // password write. Driven headlessly against the factory, because the screen's own row
  // refuses a self-targeted access removal (its button is disabled for the person looking
  // at it), while a whole-session sweep of yourself is one dialog away.
  serve({});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  storeSelection(ADMIN_ID, SCOPE);
  queryClient.setQueryData(authKeys.currentUser(), {
    id: ADMIN_ID,
    email: "admin@example.test",
  });
  queryClient.setQueryData(selectionKeys.current(ADMIN_ID), SCOPE);
  queryClient.setQueryData(tenantKeys.generation(ADMIN_ID), 3);

  const { revokePlatformUserSessionsMutationOptions } = await import(
    "../../src/lib/auth/mutations"
  );
  // The factory's own inference sprawls across TanStack's option unions; the contract under
  // test is just the pair below.
  type RevokeAllFactory = {
    mutationFn: (input: {
      userId: string;
      reason: string;
    }) => Promise<PlatformIdentityReceipt>;
    onSuccess?: (
      receipt: PlatformIdentityReceipt,
      variables: { userId: string; reason: string },
    ) => void;
  };
  const options = revokePlatformUserSessionsMutationOptions(
    queryClient,
    ADMIN_ID,
  ) as RevokeAllFactory;
  const sweep = { userId: ADMIN_ID, reason: "t0516 self sweep" };
  await options.mutationFn(sweep);
  options.onSuccess?.(
    {
      commandId: "cmd",
      replayed: false,
      userId: ADMIN_ID,
      principalId: "p",
      identityGeneration: 3,
    },
    sweep,
  );

  expect(queryClient.getQueryData(authKeys.currentUser()) ?? null).toBeNull();
  expect(
    queryClient.getQueryData(selectionKeys.current(ADMIN_ID)) ?? null,
  ).toBeNull();
  expect(
    queryClient.getQueryData(tenantKeys.generation(ADMIN_ID)) ?? null,
  ).toBe(null);
});

test("a_password_write_for_somebody_else_keeps_the_admin_signed_in", async () => {
  serve({});
  const { queryClient, view } = drawAdmin("/admin/people");
  queryClient.setQueryData(authKeys.currentUser(), {
    id: ADMIN_ID,
    email: "admin@example.test",
  });

  const user = await openManage(view, "person@example.test");
  await user.type(view.getByLabelText("New password"), "their-secret");
  await user.type(
    view.getByRole("textbox", { name: "Why (kept in the audit log)" }),
    "t0516 offboarding",
  );
  await user.click(view.getByRole("button", { name: "Set password" }));

  await waitFor(() => {
    expect(
      requests.some((one) => one.path === "/api/auth/admin/set-user-password"),
    ).toBe(true);
  });
  const stillMe = queryClient.getQueryData<{ id?: string }>(
    authKeys.currentUser(),
  );
  expect(stillMe?.id ?? null).toBe(ADMIN_ID);
});

test("create_and_rename_go_through_the_identity_envelope", async () => {
  serve({});
  const { view } = drawAdmin("/admin/people");
  const user = userEvent.setup({ document });

  await view.findByText(/person@example\.test/);
  await user.click(view.getByRole("button", { name: "Add person" }));
  await user.type(
    view.getByRole("textbox", { name: "Email address" }),
    "new@example.test",
  );
  await user.type(view.getByRole("textbox", { name: "Name" }), "New Person");
  await user.click(view.getByRole("button", { name: "Create account" }));

  await waitFor(() => {
    expect(
      requests.some((one) => one.path === "/api/auth/admin/create-user"),
    ).toBe(true);
  });
  const create = requests.find(
    (one) => one.path === "/api/auth/admin/create-user",
  );
  // The closed set exactly: the address, the name, and nothing else. No role, no status.
  expect(create?.body).toEqual({
    email: "new@example.test",
    name: "New Person",
  });

  await waitFor(() => {
    expect(view.queryByRole("button", { name: "Create account" })).toBeNull();
  });
  /*
   * The roster refetch the create action kicked off must land before the next dialog opens:
   * a re-render mid-keystroke reasserts the input's controlled value and eats the selection,
   * so the rename would type beside the old name instead of replacing it.
   */
  await waitFor(() => {
    expect(
      requests.filter((one) => one.path === "/api/admin/people").length,
    ).toBeGreaterThanOrEqual(2);
  });

  // The profile edit is the name alone; the address is not editable here because the server
  // refuses an email change on this surface, and the screen does not offer what it knows
  // will be refused.
  const manage = await openManage(view, "person@example.test");
  expect(view.queryByRole("textbox", { name: "Email address" })).toBeNull();
  const nameBox = view.getByRole("textbox", { name: "Name" });
  // Backspace over "Person" rather than clearing: in this harness only real keystrokes
  // reach the input's state, and a clear's selection does not survive a mid-test re-render.
  await manage.type(nameBox, "{backspace>6}");
  await manage.type(nameBox, "Renamed Person");
  await manage.click(view.getByRole("button", { name: "Save name" }));

  await waitFor(() => {
    expect(
      requests.some((one) => one.path === "/api/auth/admin/update-user"),
    ).toBe(true);
  });
  const rename = requests.find(
    (one) => one.path === "/api/auth/admin/update-user",
  );
  expect(rename?.body).toEqual({ userId: "u-person", name: "Renamed Person" });
});

test("sessions_can_be_revoked_one_at_a_time_or_all_at_once", async () => {
  serve({});
  const { view } = drawAdmin("/admin/people");
  const user = await openManage(view, "person@example.test");

  // The sessions the platform read answers, each with its own revoke.
  expect(await view.findByText("Mozilla/5.0 laptop")).toBeTruthy();
  expect(view.getByText("Mozilla/5.0 phone")).toBeTruthy();

  await user.type(
    view.getByRole("textbox", { name: "Reason (kept in the audit log)" }),
    "t0516 sweep",
  );
  const rejections = view.getAllByRole("button", { name: "Revoke" });
  await user.click(rejections[0]!);

  await waitFor(() => {
    expect(
      requests.some(
        (one) => one.path === "/api/auth/admin/revoke-user-session",
      ),
    ).toBe(true);
  });
  const one = requests.find(
    (request) => request.path === "/api/auth/admin/revoke-user-session",
  );
  expect(one?.body).toEqual({
    userId: "u-person",
    sessionId: "s-1",
    reason: "t0516 sweep",
  });

  await user.click(view.getByRole("button", { name: "Revoke every session" }));
  await waitFor(() => {
    expect(
      requests.some(
        (one) => one.path === "/api/auth/admin/revoke-user-sessions",
      ),
    ).toBe(true);
  });
  const all = requests.find(
    (one) => one.path === "/api/auth/admin/revoke-user-sessions",
  );
  expect(all?.body).toEqual({ userId: "u-person", reason: "t0516 sweep" });
});

test("no_impersonation_or_deletion_is_offered", async () => {
  serve({});
  const { view } = drawAdmin("/admin/people");
  await view.findAllByText(/person@example\.test/);
  const user = await openManage(view, "person@example.test");
  await view.findByText("Sessions");
  // Leave the dialog closed behind this test, the way a person would.
  await user.keyboard("{Escape}");

  // First phase has neither action: no control on the screen names them.
  expect(view.queryByRole("button", { name: /impersonate/i })).toBeNull();
  expect(view.queryByRole("button", { name: /delete/i })).toBeNull();
  expect(view.queryByRole("button", { name: /sign in as/i })).toBeNull();
  expect(
    requests.some(
      (one) =>
        one.path === "/api/auth/admin/impersonate-user" ||
        one.path === "/api/auth/admin/remove-user",
    ),
  ).toBe(false);
});

test("restoring_does_not_advertise_returning_old_access", async () => {
  serve({});
  const { view } = drawAdmin("/admin/people");

  // The removed person's row says what restore does, and what it does not.
  expect(await view.findByText(/gone@example\.test/)).toBeTruthy();
  expect(
    view.getByText(
      "Restoring their sign-in does not return what they had before.",
    ),
  ).toBeTruthy();
});

test("role_and_access_actions_keep_their_legacy_routes", async () => {
  serve({});
  const { view } = drawAdmin("/admin/people");
  const user = userEvent.setup({ document });
  await view.findAllByText(/person@example\.test/);

  await user.click(
    view.getByRole("switch", { name: "Administrator: person@example.test" }),
  );
  await waitFor(() => {
    expect(
      requests.some((one) => one.path === "/api/admin/people/u-person/role"),
    ).toBe(true);
  });
  const role = requests.find(
    (one) => one.path === "/api/admin/people/u-person/role",
  );
  expect(role?.body).toEqual({ role: "admin" });

  await user.click(
    view.getByRole("button", { name: "Remove access: person@example.test" }),
  );
  await waitFor(() => {
    expect(
      requests.some((one) => one.path === "/api/admin/people/u-person/access"),
    ).toBe(true);
  });
  const access = requests.find(
    (one) => one.path === "/api/admin/people/u-person/access",
  );
  expect(access?.body).toEqual({ revoked: true });
});

test("each_security_action_shows_its_own_error", async () => {
  serve({
    answers: {
      "/api/auth/admin/update-user": () => 403,
      "/api/auth/admin/set-user-password": () => 403,
    },
  });
  const { view } = drawAdmin("/admin/people");
  const user = await openManage(view, "person@example.test");

  await user.type(view.getByLabelText("New password"), "nope-secret");
  await user.type(
    view.getByRole("textbox", { name: "Why (kept in the audit log)" }),
    "t0516 failure",
  );
  await user.click(view.getByRole("button", { name: "Set password" }));

  const nameBox = view.getByRole("textbox", { name: "Name" });
  await user.type(nameBox, "{backspace>6}");
  await user.type(nameBox, "Never Saved");
  await user.click(view.getByRole("button", { name: "Save name" }));
  await waitFor(() => {
    expect(
      requests.some((one) => one.path === "/api/auth/admin/set-user-password"),
    ).toBe(true);
  });

  // Two refusals, two answers: each action reports its own failure, neither swallows the
  // other's, and both stay on screen together.
  await waitFor(() => {
    const alerts = view.getAllByRole("alert").map((alert) => alert.textContent);
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    const distinct = new Set(alerts.filter((text) => text !== null));
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });
});
