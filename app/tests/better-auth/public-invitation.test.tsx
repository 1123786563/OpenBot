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

/*
 * The invitation landing, T04.11 (Issue #555): what /accept-invitation?id=… shows, and everything
 * it must never do.
 *
 * FOUR THINGS ARE UNDER TEST. First, the invitation survives the whole way in: the sign-in the page
 * offers carries the invitation's own path as the return target, and a wrong account that lands on
 * it can switch and get the SAME return target again — the path is rebuilt from the invitation id,
 * never carried from a query parameter. Second, an untrusted query never becomes a destination:
 * with returnPath/next/callbackUrl pointing at an outside origin, the page loads neither it nor any
 * private directory surface — the narrow invitation read and the session read are its whole diet.
 * Third, every state has its own sentence: expired, cancelled, already answered, unverified, and
 * the wrong account each land somewhere determinate, and the concurrent double-accept (the
 * server's 409 MEMBERSHIP_INVITATION_NOT_PENDING) lands on the settled sentence with the buttons
 * gone. Fourth, accepting and declining ride the real controlled commands with the flat
 * {invitationId} body the ingress pins — no company proof is asked for first.
 *
 * THE HARNESS IS THIS REPOSITORY'S (the T04.10 people suite): one stable fetch dispatcher
 * installed before anything that captures fetch, the route's exported singleton re-parented into
 * a memory router, and a live fixture object whose session half flips mid-test the way a real
 * sign-in would.
 */

type AcceptInvitationRouteModule =
  typeof import("../../src/routes/accept-invitation");

let acceptRoute: AcceptInvitationRouteModule;

let fetchHandler: typeof globalThis.fetch;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof globalThis.fetch;
  fetchHandler = originalFetch;
  acceptRoute = await import("../../src/routes/accept-invitation");
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

/** The path of one asked request, whatever form the caller handed fetch. */
function pathOf(input: RequestInfo | URL): string {
  const raw = input instanceof URL ? input.href : String(input);
  return raw.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Who is signed in, the way /api/auth/get-session answers it. */
type SessionFixture = { email: string; emailVerified: boolean } | null;

/** The unauthenticated landing answer. */
type LandingFixture = { status: string; expired?: boolean } | "404";

/** One named command refusal the stubbed write answers with. */
type StubbedWrite = { status: number; code: string };

const INVITED_EMAIL = "person@example.com";

/**
 * Answers everything the landing page reads and writes. The session half is read at dispatch
 * time, so a test flips it the way a real sign-in would; the invitation half follows the
 * server's own rule — the landing view while signed out, the caller's own (or the uniform 404)
 * while signed in.
 */
function serveInvitation(
  options: {
    session?: SessionFixture;
    landing?: LandingFixture;
    own?: "own" | "404";
    accept?: StubbedWrite;
    reject?: StubbedWrite;
  } = {},
): Asked[] {
  const asked: Asked[] = [];
  const session = () => options.session ?? null;
  const landing = options.landing ?? { status: "pending" };
  const write = (stub: StubbedWrite | undefined) =>
    stub === undefined
      ? jsonResponse(200, {})
      : jsonResponse(stub.status, { error: { code: stub.code } });
  fetchHandler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ input, init });
    const path = pathOf(input);
    if (path === "/api/auth/get-session") {
      const who = session();
      return who === null
        ? jsonResponse(200, {})
        : jsonResponse(200, {
            session: { id: "s-1", userId: "u-1" },
            user: {
              id: "u-1",
              email: who.email,
              emailVerified: who.emailVerified,
              name: "Person",
            },
          });
    }
    if (path === "/api/capabilities") {
      return jsonResponse(200, {
        authProviders: ["google"],
        ssoConfigured: true,
        ssoRequired: false,
      });
    }
    if (path === "/api/enterprise/invitations/inv-a") {
      if (session() === null) {
        if (landing === "404") {
          return jsonResponse(404, {
            error: {
              code: "INVITATION_READ_NOT_FOUND",
              message: "Request refused.",
            },
          });
        }
        return jsonResponse(200, {
          invitation: {
            invitationId: "inv-a",
            status: landing.status,
            expired: landing.expired === true,
          },
        });
      }
      if (options.own === "404") {
        return jsonResponse(404, {
          error: {
            code: "INVITATION_READ_NOT_FOUND",
            message: "Request refused.",
          },
        });
      }
      return jsonResponse(200, {
        invitation: {
          invitationId: "inv-a",
          organizationId: "org-a",
          organizationName: "Alpha",
          email: INVITED_EMAIL,
          role: "member",
          teamId: null,
          status: "pending",
          expired: false,
          expiresAt: "2026-11-01T00:00:00.000Z",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      });
    }
    if (path === "/api/auth/sign-in/social") return jsonResponse(200, {});
    if (path === "/api/auth/sign-out") return jsonResponse(200, {});
    if (path === "/api/auth/organization/accept-invitation") {
      return write(options.accept);
    }
    if (path === "/api/auth/organization/reject-invitation") {
      return write(options.reject);
    }
    return jsonResponse(200, {});
  }) as unknown as typeof globalThis.fetch;
  return asked;
}

/** The real landing route in a memory router, at whatever entry the test names. */
function draw(entry: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const accept = (
    acceptRoute.Route as unknown as {
      update: (options: unknown) => unknown;
    }
  ).update({
    id: "/accept-invitation",
    getParentRoute: () => rootRoute,
    path: "/accept-invitation",
  });
  const tree = rootRoute.addChildren([accept as never]);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [entry] }),
    routeTree: tree,
  } as never);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The return target of one social sign-in start, as the server's redirect target sees it. */
function returnPathOf(ask: Asked): string {
  const body = bodyOf(ask.init);
  const target = new URL(String(body.callbackURL));
  return `${target.pathname}${target.search}`;
}

// ---------------------------------------------------------------------------
// The named cases
// ---------------------------------------------------------------------------

test("invitation_survives_login_and_wrong_account_switch", async () => {
  const who: { session: SessionFixture } = { session: null };
  const asked = serveInvitation({
    get session() {
      return who.session;
    },
    own: "404",
  });
  const user = userEvent.setup({ document });

  // Signed out, the invitation is pending and the page offers the way in.
  const screen = draw("/accept-invitation?id=inv-a");
  await user.click(
    await screen.findByRole("button", { name: /Continue with Google/i }),
  );
  const first = asked.find(
    ({ input }) => pathOf(input) === "/api/auth/sign-in/social",
  );
  expect(first).toBeTruthy();
  let returnPath = returnPathOf(first as Asked);
  expect(returnPath).toBe("/accept-invitation?id=inv-a");

  // The sign-in returns — into the WRONG mailbox. The page names the account, offers the
  // switch, and after it the same invitation is pending again with the SAME return target.
  who.session = { email: "wrong.person@example.com", emailVerified: true };
  cleanup();
  const signedIn = draw("/accept-invitation?id=inv-a");
  expect(await signedIn.findByText(/wrong\.person@example\.com/)).toBeTruthy();
  who.session = null;
  await user.click(
    await signedIn.findByRole("button", { name: "Switch account" }),
  );
  await waitFor(() => {
    expect(
      asked.some(({ input }) => pathOf(input) === "/api/auth/sign-out"),
    ).toBeTruthy();
  });
  await user.click(
    await signedIn.findByRole("button", { name: /Continue with Google/i }),
  );
  const second = [...asked]
    .reverse()
    .find(({ input }) => pathOf(input) === "/api/auth/sign-in/social");
  expect(second).toBeTruthy();
  returnPath = returnPathOf(second as Asked);
  expect(returnPath).toBe("/accept-invitation?id=inv-a");
});

test("external_return_or_private_directory_is_never_loaded", async () => {
  const who: { session: SessionFixture } = {
    session: { email: "wrong.person@example.com", emailVerified: true },
  };
  const asked = serveInvitation({
    get session() {
      return who.session;
    },
    own: "404",
  });
  const user = userEvent.setup({ document });

  // The link carries outside return targets next to the invitation id; the wrong account is
  // signed in, so every branch of the page is exercised with them present.
  const screen = draw(
    "/accept-invitation?id=inv-a&returnPath=https%3A%2F%2Fevil.example%2Fcatch&next=https%3A%2F%2Fevil.example%2Fnext&callbackUrl=http%3A%2F%2Fevil.example%2Fcb",
  );
  expect(await screen.findByText(/another email address/i)).toBeTruthy();

  // Switching accounts walks the signed-out landing too, still with the outside targets present.
  who.session = null;
  await user.click(
    await screen.findByRole("button", { name: "Switch account" }),
  );
  await user.click(
    await screen.findByRole("button", { name: /Continue with Google/i }),
  );
  const social = [...asked]
    .reverse()
    .find(({ input }) => pathOf(input) === "/api/auth/sign-in/social");
  expect(social).toBeTruthy();
  expect(returnPathOf(social as Asked)).toBe("/accept-invitation?id=inv-a");

  // Nothing left the origin, and no private directory surface was read for a landing page.
  const externalRequests = asked.filter(
    ({ input }) => !pathOf(input).startsWith("/api/"),
  );
  expect(externalRequests).toHaveLength(0);
  const privateReads = asked.filter(({ input }) =>
    [
      "/api/auth/organization/list-invitations",
      "/api/auth/organization/list-user-invitations",
      "/api/auth/organization/get-full-organization",
      "/api/auth/organization/list",
      "/api/enterprise/workspace-scope",
    ].includes(pathOf(input)),
  );
  expect(privateReads).toHaveLength(0);
});

test("accept_and_decline_ride_the_controlled_commands", async () => {
  const asked = serveInvitation({
    session: { email: INVITED_EMAIL, emailVerified: true },
  });
  const user = userEvent.setup({ document });

  const screen = draw("/accept-invitation?id=inv-a");
  expect(await screen.findByText("Alpha")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Accept invitation" }));
  const accepted = await waitFor(() => {
    const found = asked.find(
      ({ input }) =>
        pathOf(input) === "/api/auth/organization/accept-invitation",
    );
    expect(found).toBeTruthy();
    return found as Asked;
  });
  // The flat body the ingress pins — the invitation id is the whole command.
  expect(bodyOf(accepted.init)).toEqual({ invitationId: "inv-a" });
  expect(await screen.findByText(/You've joined Alpha/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Accept invitation" }),
  ).toBeNull();

  cleanup();
  const asked2 = serveInvitation({
    session: { email: INVITED_EMAIL, emailVerified: true },
  });
  const declined = draw("/accept-invitation?id=inv-a");
  await declined.findByText("Alpha");
  await user.click(declined.getByRole("button", { name: "Decline" }));
  const refused = await waitFor(() => {
    const found = asked2.find(
      ({ input }) =>
        pathOf(input) === "/api/auth/organization/reject-invitation",
    );
    expect(found).toBeTruthy();
    return found as Asked;
  });
  expect(bodyOf(refused.init)).toEqual({ invitationId: "inv-a" });
  expect(await declined.findByText(/declined the invitation/i)).toBeTruthy();
});

test("landing_states_each_have_their_sentence", async () => {
  const cases: { landing: LandingFixture; sentence: RegExp }[] = [
    { landing: { status: "pending", expired: true }, sentence: /expired/i },
    { landing: { status: "canceled" }, sentence: /cancelled/i },
    { landing: { status: "accepted" }, sentence: /already accepted/i },
    { landing: "404", sentence: /isn't available/i },
  ];
  for (const one of cases) {
    serveInvitation({ session: null, landing: one.landing });
    const screen = draw("/accept-invitation?id=inv-a");
    expect(await screen.findByText(one.sentence)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Accept invitation" }),
    ).toBeNull();
    cleanup();
  }
});

test("unverified_mailbox_sees_the_verification_step", async () => {
  serveInvitation({
    session: { email: INVITED_EMAIL, emailVerified: false },
    own: "404",
  });
  const screen = draw("/accept-invitation?id=inv-a");
  expect(await screen.findByText(/Verify your email first/i)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Accept invitation" }),
  ).toBeNull();
});

test("concurrent_double_accept_lands_on_the_settled_sentence", async () => {
  serveInvitation({
    session: { email: INVITED_EMAIL, emailVerified: true },
    accept: { status: 409, code: "MEMBERSHIP_INVITATION_NOT_PENDING" },
  });
  const user = userEvent.setup({ document });
  const screen = draw("/accept-invitation?id=inv-a");
  await screen.findByText("Alpha");
  await user.click(screen.getByRole("button", { name: "Accept invitation" }));
  expect(await screen.findByText(/already answered/i)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Accept invitation" }),
  ).toBeNull();
});
