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

let routes: {
  forgot: typeof import("../../src/routes/forgot-password").Route;
  reset: typeof import("../../src/routes/reset-password").Route;
  verify: typeof import("../../src/routes/verify-email").Route;
  sign: typeof import("../../src/routes/sign").Route;
};
let requests: { path: string; body: Record<string, unknown> }[];
let fetchHandler: typeof globalThis.fetch;
const originalFetch = globalThis.BunTEST_ORIGINAL_FETCH ?? globalThis.fetch;
let responseStatus = 200;
let responseBody: Record<string, unknown> = {};
let session: { email: string; emailVerified: boolean } | null = null;
// Null means the default capabilities below; a test sets this to exercise another deployment.
let capabilities: Record<string, unknown> | null = null;
let unsafeNavigationCount: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    location.origin,
  );
  return `${url.pathname}${url.search}`;
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof globalThis.fetch;
  routes = {
    forgot: (await import("../../src/routes/forgot-password")).Route,
    reset: (await import("../../src/routes/reset-password")).Route,
    verify: (await import("../../src/routes/verify-email")).Route,
    sign: (await import("../../src/routes/sign")).Route,
  };
});

beforeEach(() => {
  requests = [];
  session = null;
  capabilities = null;
  responseStatus = 200;
  responseBody = {};
  unsafeNavigationCount = 0;
  fetchHandler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    requests.push({ path, body });
    if (!path.startsWith("/api/")) unsafeNavigationCount += 1;
    if (path === "/api/auth/get-session") {
      return json(
        session
          ? {
              session: { id: "s-1", userId: "u-1" },
              user: {
                id: "u-1",
                email: session.email,
                emailVerified: session.emailVerified,
                name: "Person",
              },
            }
          : {},
      );
    }
    if (path === "/api/me") return json({}, 401);
    if (path === "/api/capabilities")
      return json(
        capabilities ?? {
          authProviders: ["google"],
          ssoConfigured: false,
          ssoRequired: false,
          emailPassword: true,
        },
      );
    if (path === "/api/auth/sign-in/email")
      return json({ token: "session-token", user: { id: "u-1" } });
    if (path === "/api/auth/sign-out") return json({ success: true });
    if (responseStatus !== 200) return json(responseBody, responseStatus);
    if (path === "/api/auth/request-password-reset")
      return json({
        status: true,
        message: "If an account exists, an email is on its way.",
      });
    if (path === "/api/auth/reset-password") return json({ status: true });
    if (path === "/api/auth/send-verification-email")
      return json({ status: true });
    return json({});
  }) as typeof globalThis.fetch;
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

function draw(path: string) {
  const root = createRootRoute({ component: Outlet });
  const routeModules = [
    routes.forgot,
    routes.reset,
    routes.verify,
    routes.sign,
  ];
  const childRoutes = routeModules.map((route) => {
    const update = (route as unknown as { update(options: unknown): unknown })
      .update;
    const id =
      route === routes.forgot
        ? "/forgot-password"
        : route === routes.reset
          ? "/reset-password"
          : route === routes.verify
            ? "/verify-email"
            : "/sign";
    return update.call(route, { id, path: id, getParentRoute: () => root });
  });
  // The sign route's beforeLoad reads the query client off the router context.
  const queryClient = new QueryClient();
  const router = createRouter({
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren(childRoutes as never),
  } as never);
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("request_reset_receive_mail_set_password_then_sign_in", async () => {
  const user = userEvent.setup({ document });
  const screen = draw("/forgot-password");
  await user.type(await screen.findByLabelText("Email"), "person@example.test");
  await user.click(screen.getByRole("button", { name: "Send reset link" }));
  await screen.findByText("We've sent a reset link to person@example.test.");
  const request = requests.find(
    (item) => item.path === "/api/auth/request-password-reset",
  );
  expect(request?.body).toEqual({
    email: "person@example.test",
    redirectTo: "/reset-password",
  });

  responseStatus = 200;
  responseBody = {};
  const reset = draw("/reset-password?token=secret-token");
  await user.type(
    await reset.findByLabelText("New password"),
    "correct-horse-battery",
  );
  await user.click(reset.getByRole("button", { name: "Reset password" }));
  await waitFor(() =>
    expect(
      requests.some(
        (item) =>
          item.path === "/api/auth/reset-password" &&
          item.body.token === "secret-token",
      ),
    ).toBe(true),
  );
  expect(requests.some((item) => item.path === "/api/auth/sign-out")).toBe(
    true,
  );
  await reset.findByText(
    "Your password has been reset. Sign in with your new password.",
  );
});

test("consumed_or_external_return_token_is_refused", async () => {
  responseStatus = 400;
  responseBody = {
    error: "Token is no longer valid.",
    code: "IDENTITY_RECOVERY_TOKEN_UNKNOWN",
  };
  const screen = draw(
    "/reset-password?token=already-used&returnPath=https://evil.example&next=//evil.example&callbackUrl=https://evil.example",
  );
  const user = userEvent.setup({ document });
  await user.type(
    await screen.findByLabelText("New password"),
    "correct-horse-battery",
  );
  await user.click(screen.getByRole("button", { name: "Reset password" }));
  await screen.findByText(
    "This link has expired or was already used. Request a new one.",
  );
  expect(unsafeNavigationCount).toBe(0);
  expect(requests.every((item) => item.path.startsWith("/api/"))).toBe(true);
  expect(
    screen
      .getByRole("link", { name: "Request a new reset link" })
      .getAttribute("href"),
  ).toBe("/forgot-password");
});

test("unknown_email_and_known_email_receive_the_same_answer", async () => {
  const user = userEvent.setup({ document });
  const screen = draw("/forgot-password");
  await user.type(await screen.findByLabelText("Email"), "nobody@example.test");
  await user.click(screen.getByRole("button", { name: "Send reset link" }));
  await screen.findByText("We've sent a reset link to nobody@example.test.");
});

test("pure_sso_deployment_closes_password_recovery", async () => {
  responseStatus = 503;
  responseBody = {
    error: "Password recovery is unavailable.",
    code: "PASSWORD_RECOVERY_CLOSED_FOR_SSO",
  };
  const user = userEvent.setup({ document });
  const screen = draw("/forgot-password");
  await user.type(await screen.findByLabelText("Email"), "person@example.test");
  await user.click(screen.getByRole("button", { name: "Send reset link" }));
  await screen.findByText(
    "Password sign-in isn’t available here. Continue with your identity provider.",
  );
});

test("verify_email_resends_only_to_the_signed_in_unverified_address", async () => {
  session = { email: "person@example.test", emailVerified: false };
  const user = userEvent.setup({ document });
  const screen = draw("/verify-email?returnPath=https://evil.example");
  await user.click(
    await screen.findByRole("button", { name: "Resend verification email" }),
  );
  await screen.findByText("A new verification email is on its way.");
  const send = requests.find(
    (item) => item.path === "/api/auth/send-verification-email",
  );
  expect(send?.body).toEqual({
    email: "person@example.test",
    callbackURL: "http://localhost/verify-email?verified=1",
  });
  expect(unsafeNavigationCount).toBe(0);
});

test("password_sign_in_form_posts_credentials_and_lands_in_the_app", async () => {
  const user = userEvent.setup({ document });
  // happy-dom's assign is observable: pin where a successful password sign-in lands.
  const landings: string[] = [];
  const originalAssign = window.location.assign.bind(window.location);
  window.location.assign = (url: string) => {
    landings.push(url);
  };
  const screen = draw("/sign");
  await user.type(await screen.findByLabelText("Email"), "person@example.test");
  await user.type(await screen.findByLabelText("Password"), "new-password");
  await user.click(
    screen.getByRole("button", { name: "Continue with email and password" }),
  );
  await waitFor(() => {
    const request = requests.find(
      (item) => item.path === "/api/auth/sign-in/email",
    );
    expect(request?.body.email).toBe("person@example.test");
    expect(request?.body.password).toBe("new-password");
  });
  // The reset loop's last step ends on the app's origin, the same landing a provider callback has.
  expect(landings).toEqual([window.location.origin]);
  window.location.assign = originalAssign;
});

test("pure_sso_deployment_shows_no_password_entrance", async () => {
  capabilities = {
    authProviders: ["google", "microsoft"],
    ssoConfigured: true,
    ssoRequired: false,
    emailPassword: false,
  };
  const screen = draw("/sign");
  await screen.findByRole("button", { name: "Continue with Google" });
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Continue with email and password" }),
  ).toBeNull();
  expect(screen.queryByText("Forgot your password?")).toBeNull();
});
