import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
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
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { Toaster } from "@/components/ui/toast";
import { initI18n } from "@/i18n";
import { queryClient } from "@/query-client";
import { Route as SignRoute } from "@/routes/sign";
import { pinLocale } from "./i18n";
import { settleReactWork } from "./settle-react-work";

/**
 * Sign out, from the sidebar's user menu. The server ends the person's Recorders before their session, and when it
 * cannot it does not sign them out (server/src/auth/index.ts, server/src/auth/organization.ts): the person stays signed
 * in, where they were, told so in a toast, and can sign out again. Better Auth refuses with its sentence in `message`,
 * the organization's sign-in in `error`; either way the person reads one plain sentence.
 */

const UNFINISHED = "Signing out did not finish. Try again.";

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  cleanup();
  await pinLocale("en");
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** How the server answers the next sign-out. */
let answer: () => Response;
const originalFetch = global.fetch;
beforeEach(() => {
  queryClient.clear();
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/api/auth/sign-out")) return answer();
      // Arriving at the real sign screen: nobody is signed in, and this deployment
      // has no way in configured, which is what the screen then says.
      if (url.endsWith("/api/me")) return new Response(null, { status: 401 });
      if (url.endsWith("/api/capabilities"))
        return Response.json({
          authProviders: [],
          ssoConfigured: false,
          ssoRequired: false,
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function SignOutButton() {
  const signOut = useSignOut();
  return (
    <button type="button" disabled={signOut.pending} onClick={signOut.run}>
      Sign out
    </button>
  );
}

/** The menu's Sign out on a router with the sign-in screen, with the app's one query client and its toasts. */
function draw() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <Toaster />
      </>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient },
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: SignOutButton,
      }),
      // The real destination: the same route main.tsx mounts on /sign.
      SignRoute.update({
        id: "/sign",
        path: "/sign",
        getParentRoute: () => rootRoute,
      } as never),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

const toasts = () =>
  [...document.querySelectorAll("[data-slot=toast]")].map(
    (toast) => toast.textContent,
  );

for (const [who, body] of [
  ["Better Auth", { code: "SERVICE_UNAVAILABLE", message: UNFINISHED }],
  ["the organization's sign-in", { error: UNFINISHED }],
] as const) {
  test(`a sign-out ${who} could not finish leaves the person here, told so, and Sign out works again`, async () => {
    answer = () => Response.json(body, { status: 503 });
    const { view, router } = draw();
    const button = await view.findByRole("button", { name: "Sign out" });
    await userEvent.click(button);
    await waitFor(() => expect(toasts()).toEqual([UNFINISHED]));
    expect(router.state.location.pathname).toBe("/");
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));

    // Signing out again, once the server can: the person reaches the sign-in screen, and the note goes.
    answer = () => Response.json({ success: true });
    await userEvent.click(button);
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign"));
    await waitFor(() => expect(toasts()).toEqual([]));
  });
}

test("sign-out lands on the real sign screen, speaking the language this browser kept", async () => {
  localStorage.setItem("openbot-locale", "zh-CN");
  initI18n();
  answer = () => Response.json({ success: true });
  const { view, router } = draw();
  const button = await view.findByRole("button", { name: "Sign out" });
  await userEvent.click(button);
  await waitFor(() => expect(router.state.location.pathname).toBe("/sign"));
  expect(
    await view.findByRole("heading", { name: "登录 OpenBot" }),
  ).toBeTruthy();
  expect(toasts()).toEqual([]);
});
