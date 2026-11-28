import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PageShell } from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
import {
  MissingPage,
  RouteLoadError,
} from "@/components/layout/route-recovery";
import { Toaster, toast } from "@/components/ui/toast";
import { useTranslation } from "@/i18n";
import { client } from "@/lib/client";
import { appConfig } from "@/lib/generated/application-config";
import { Route as ScreenRoute } from "@/routes/_authed/_app/s/$screen";
import { pinLocale } from "./i18n";
import { settleReactWork } from "./settle-react-work";

/**
 * The sentences the frame itself owns when a request fails: the client's generic fallback, the
 * shared ReadError retry button, and the router's recovery screens. The caller's `fallback`,
 * `retryLabel`, `message` and `description` are page-owned sentences and must stay as the page
 * wrote them, in any language.
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(async () => {
  cleanup();
  await pinLocale("en");
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Swaps in what the server says next, failing without a JSON envelope: no message of its own. */
function theServerSaysNoMessage(): void {
  globalThis.fetch = (async () =>
    new Response("boom", { status: 500 })) as unknown as typeof fetch;
}

test("the generic request failure speaks the interface language", async () => {
  theServerSaysNoMessage();
  await expect(client("http://x.test/things", {})).rejects.toThrow(
    "That request failed.",
  );

  await pinLocale("zh-CN");

  await expect(client("http://x.test/things", {})).rejects.toThrow(
    "请求失败。",
  );
});

/** Fails with an envelope carrying the server's own sentence. */
function theServerSaysItsOwn(message: string): void {
  globalThis.fetch = (async () =>
    Response.json(
      { error: message },
      {
        status: 422,
      },
    )) as unknown as typeof fetch;
}

test("a message from the server is kept verbatim, in either language", async () => {
  const serverSays = "每小时最多创建 3 个 Bot。";
  theServerSaysItsOwn(serverSays);
  await expect(client("http://x.test/things", {})).rejects.toThrow(serverSays);

  await pinLocale("zh-CN");

  await expect(client("http://x.test/things", {})).rejects.toThrow(serverSays);
});

/** Answers 200 with a body that is not an envelope. */
function aMalformedSuccess(): void {
  globalThis.fetch = (async () =>
    new Response("null", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("a malformed success gets the same fallback, and a page's own sentence wins", async () => {
  aMalformedSuccess();
  await pinLocale("zh-CN");
  await expect(client("http://x.test/thing", "thing", {})).rejects.toThrow(
    "请求失败。",
  );

  aMalformedSuccess();
  await expect(
    client("http://x.test/thing", "thing", { fallback: "Nope." }),
  ).rejects.toThrow("Nope.");
});

const noRetryNeeded = () => Promise.resolve();

test("the shared retry button speaks the interface language", async () => {
  const view = render(
    <ReadError message="Loading the roster failed" retry={noRetryNeeded} />,
  );
  const before = view.getByRole("button", { name: "Retry" });

  await pinLocale("zh-CN");

  expect(view.getByRole("button", { name: "重试" })).toBe(before);
});

test("a page's own sentences and retry label are left as the page wrote them", async () => {
  const view = render(
    <ReadError
      description="OpenBot kept your last view."
      message="Loading the roster failed"
      retry={noRetryNeeded}
      retryLabel="Retry preview"
    />,
  );

  await pinLocale("zh-CN");

  expect(view.getByRole("button", { name: "Retry preview" })).toBeTruthy();
  expect(view.getByText("Loading the roster failed")).toBeTruthy();
  expect(view.getByText("OpenBot kept your last view.")).toBeTruthy();
});

/**
 * The app's own wiring: an unknown address is the root route's missing page, a load that throws is
 * the router's own error screen.
 */
function theAppAt(
  address: string,
  broken: () => boolean = () => false,
  initialEntries?: string[],
  error = "The loader broke.",
) {
  const root = createRootRoute({
    notFoundComponent: () => <MissingPage standalone />,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/page",
    loader: () => {
      if (broken()) throw new Error(error);
    },
    component: () => <p>The page loaded.</p>,
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <h1>Workspace</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, home]),
    history: createMemoryHistory({
      initialEntries: initialEntries ?? [address],
    }),
    defaultErrorComponent: RouteLoadError,
  });
  return render(<RouterProvider router={router} />);
}

test("the missing-page screen speaks the interface language", async () => {
  const view = theAppAt("/nowhere");
  const before = await view.findByRole("link", { name: "Open workspace" });
  view.getByRole("main", { name: "Page not found" });
  view.getByText(
    "Check the address below, or open your workspace to find your conversations and Bots.",
  );

  await pinLocale("zh-CN");

  expect(view.getByRole("link", { name: "打开工作区" })).toBe(before);
  expect(before.getAttribute("href")).toBe("/");
  view.getByRole("main", { name: "页面不存在" });
  view.getByRole("heading", { name: "页面不存在" });
  view.getByText("请检查下方地址，或打开工作区查找你的对话和 Bot。");
  expect(view.queryByRole("heading", { name: "Page not found" })).toBeNull();
});

test("the failed-load screen speaks the interface language, and its retry still loads the page", async () => {
  let broken = true;
  const view = theAppAt("/page", () => broken);
  const user = userEvent.setup({ document });
  await view.findByRole("heading", { name: "This page couldn’t load" });
  view.getByRole("region", { name: "This page couldn’t load" });
  view.getByText(
    "Try again. If the page still won’t open, check your connection or open your workspace to keep working.",
  );
  const retry = view.getByRole("button", { name: "Try again" });

  await pinLocale("zh-CN");

  expect(view.getByRole("button", { name: "重试" })).toBe(retry);
  view.getByRole("region", { name: "此页面未能加载" });
  view.getByRole("heading", { name: "此页面未能加载" });
  view.getByText(
    "请重试。如果页面仍无法打开，请检查你的网络连接，或打开工作区继续工作。",
  );
  view.getByRole("link", { name: "打开工作区" });

  broken = false;
  await user.click(retry);

  await view.findByText("The page loaded.");
  expect(view.queryByRole("button", { name: "重试" })).toBeNull();
});

test("a page reached from another one offers a way back, in the interface language", async () => {
  const view = theAppAt("/nowhere", () => false, ["/page", "/nowhere"]);
  const back = await view.findByRole("button", { name: "Go back" });
  view.getByText("Check the address below, or return to the previous page.");

  await pinLocale("zh-CN");

  expect(view.getByRole("button", { name: "返回" })).toBe(back);
  view.getByText("请检查下方地址，或返回上一页。");

  // A pointer press on it is a real press: the router's own history moves back a page.
  await userEvent.setup({ document }).click(back);
  await view.findByText("The page loaded.");
});

test("the failed-load screen says why it failed, in the interface language", async () => {
  const online = navigator.onLine;
  try {
    // No connection: the screen says so and its retry cannot run.
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const offline = theAppAt("/page", () => true);
    await offline.findByRole("heading", { name: "This page couldn’t load" });
    offline.getByText("You’re offline. Reconnect to try again.");
    expect(
      offline
        .getByRole("button", { name: "Try again" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    await pinLocale("zh-CN");
    offline.getByText("你已离线。请重新连接后再试。");
    offline.getByRole("button", { name: "重试" });

    // Connected, and the page fails a second time: the screen says that too.
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
    cleanup();
    const repeated = theAppAt("/page", () => true);
    const user = userEvent.setup({ document });
    await repeated.findByRole("heading", { name: "此页面未能加载" });
    await user.click(repeated.getByRole("button", { name: "重试" }));
    expect(
      await repeated.findByText(
        "此页面仍然无法加载。你可以重试，或打开工作区。",
      ),
    ).toBeTruthy();

    await pinLocale("en");
    repeated.getByText(
      "The page still couldn’t load. You can try again or open your workspace.",
    );
  } finally {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: online,
    });
  }
});

test("a toast's close button speaks the interface language", async () => {
  render(<Toaster />);
  const user = userEvent.setup({ document });
  const shown = () => within(document.body);
  act(() => toast.add({ title: "Signing out did not finish.", type: "error" }));
  // Until the toast is hovered or holds focus, Base UI keeps its close button out of the tree.
  const before = shown().getByLabelText("Close") as HTMLButtonElement;
  act(() => before.focus());
  shown().getByRole("button", { name: "Close" });

  await pinLocale("zh-CN");

  expect(shown().getByRole("button", { name: "关闭" })).toBe(before);
  expect(shown().queryByRole("button", { name: "Close" })).toBeNull();
  expect(shown().getByText("Signing out did not finish.")).toBeTruthy();

  await user.click(before);

  await waitFor(() =>
    expect(document.querySelector("[data-slot=toast-close]")).toBeNull(),
  );
});

/** A page that has moved to the catalog names itself through `t`, so the tab follows the language. */
function NamedPage() {
  const { t } = useTranslation();
  return (
    <PageShell title={t("frame.pageNotFound", "Page not found")}>
      Body
    </PageShell>
  );
}

test("the tab title follows a translated page, and a page still in English stays so", async () => {
  const unmigrated = render(<PageShell title="Connections">Body</PageShell>);
  expect(document.title).toBe(`Connections · ${appConfig.brand.productName}`);

  await pinLocale("zh-CN");

  // Its title never changes, so nothing asks the tab to be said again.
  expect(document.title).toBe(`Connections · ${appConfig.brand.productName}`);
  unmigrated.unmount();

  render(<NamedPage />);
  expect(document.title).toBe(`页面不存在 · ${appConfig.brand.productName}`);

  await pinLocale("en");

  expect(document.title).toBe(
    `Page not found · ${appConfig.brand.productName}`,
  );
});

test("an unsupported legacy screen keeps the app shell around the missing page", async () => {
  const root = createRootRoute({
    component: () => (
      <>
        <header>Workspace header</header>
        <Outlet />
      </>
    ),
  });
  // Wire the real route as `routeTree.gen.ts` does, so its own `Route.useParams()` resolves. The
  // cast is the house pattern for `.update()` on a real route module: the generated module's
  // options type does not carry `getParentRoute`, but the runtime merge needs it.
  const screen = (
    ScreenRoute as unknown as {
      update: (options: unknown) => never;
    }
  ).update({
    getParentRoute: () => root,
    id: "/s/$screen",
    path: "/s/$screen",
  });
  const router = createRouter({
    routeTree: root.addChildren([screen as never]),
    history: createMemoryHistory({ initialEntries: ["/s/whatever"] }),
  });
  await router.load();
  const view = render(<RouterProvider router={router} />);
  view.getByText("Workspace header");
  view.getByText("Page not found");
  view.getByText("/s/whatever");
  // Inside the shell it is a section of the page, not the whole document's main landmark.
  expect(view.queryByRole("main")).toBeNull();
});

test("the failed-load screen never prints the error it was given", async () => {
  const view = theAppAt(
    "/page",
    () => true,
    undefined,
    "postgres://openbot:secret@db/openbot",
  );
  await view.findByRole("heading", { name: "This page couldn’t load" });
  expect(view.queryByText(/postgres/)).toBeNull();
  expect(view.queryByText(/secret/)).toBeNull();
});

test("Open workspace moves focus to the page it opens", async () => {
  const view = theAppAt("/nowhere", () => false, ["/page", "/nowhere"]);
  const user = userEvent.setup({ document });
  const open = await view.findByRole("link", { name: "Open workspace" });
  await user.click(open);
  const heading = await view.findByRole("heading", { name: "Workspace" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
});
