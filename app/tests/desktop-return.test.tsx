import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DESKTOP_LINK,
  DesktopReturn,
} from "@/components/desktop/desktop-return";

/**
 * The page an app's sign-in started in OpenBot Desktop comes back to, in the person's own browser.
 *
 * It confirms the account, as the account's page does on arrival, and then follows `openbot://open`
 * to bring the Desktop window forward. Loaded in the window itself, it goes to the account's page.
 */

const realFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:57220/" }));
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(() => GlobalRegistrator.unregister());

function show(
  app: string | undefined,
  answer = () => Response.json({ connected: true }),
  catalogue: () => Response | Promise<Response> = () =>
    Response.json({
      servers: [{ id: "gmail", title: "Gmail" }],
      catalogue: [],
    }),
) {
  const asked: string[] = [];
  const opened: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/plugins") return catalogue();
    asked.push(`${init?.method ?? "GET"} ${String(input)}`);
    return answer();
  }) as unknown as typeof fetch;
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/desktop-return"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/desktop-return",
        component: () => (
          <DesktopReturn app={app} openDesktop={(link) => opened.push(link)} />
        ),
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/connections/$key",
        component: () => <p>The account's page</p>,
      }),
    ]),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { asked, opened, router, view };
}

test("in the browser, it confirms the account and then brings OpenBot Desktop forward", async () => {
  const { asked, opened, view } = show("gmail");

  expect(
    await view.findByRole("heading", { name: "Back to OpenBot" }),
  ).toBeTruthy();
  await waitFor(() => expect(opened).toEqual([DESKTOP_LINK]));
  expect(asked).toContain("POST /api/plugins/servers/gmail/connection/confirm");
  expect(
    view
      .getByRole("link", { name: "Open OpenBot Desktop" })
      .getAttribute("href"),
  ).toBe("openbot://open");
});

test("a failed confirmation keeps the browser open and can be retried", async () => {
  let attempts = 0;
  const { asked, opened, view } = show("gmail", () =>
    ++attempts === 1
      ? Response.json({ error: "no" }, { status: 503 })
      : Response.json({ connected: true }),
  );

  const retry = await view.findByRole("button", { name: "Retry" });
  expect(opened).toEqual([]);
  expect(
    view
      .getByRole("link", { name: "View connection in browser" })
      .getAttribute("href"),
  ).toBe("/connections/gmail");
  await userEvent.setup({ document }).click(retry);
  expect(await view.findByText("Gmail is connected.")).toBeTruthy();
  // The recovery moves focus to where it was headed: the Desktop entry, not the top of the page.
  const launch = view.getByRole("link", { name: "Open OpenBot Desktop" });
  await waitFor(() => expect(document.activeElement).toBe(launch));
  await waitFor(() => expect(opened).toEqual([DESKTOP_LINK]));
  expect(asked).toEqual(
    Array(2).fill("POST /api/plugins/servers/gmail/connection/confirm"),
  );
});

test("an unconfirmed account does not trigger Desktop", async () => {
  const { opened, view } = show("gmail", () =>
    Response.json({ connected: false }),
  );
  expect(await view.findByText("Gmail isn’t connected yet.")).toBeTruthy();
  expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(opened).toEqual([]);
});

test("app metadata can finish after the confirmed account returns to Desktop", async () => {
  const metadata = Promise.withResolvers<Response>();
  const { opened, view } = show("gmail", undefined, () => metadata.promise);
  try {
    expect(await view.findByText("Account connected.")).toBeTruthy();
    await waitFor(() => expect(opened).toEqual([DESKTOP_LINK]));
  } finally {
    metadata.resolve(Response.json({ servers: [], catalogue: [] }));
  }
});

test("in the Desktop window itself, it goes to the account's page", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async () => null,
    transformCallback: () => 0,
  };
  const { opened, router, view } = show("gmail");

  expect(await view.findByText("The account's page")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/connections/gmail");
  expect(opened).toEqual([]);
});
