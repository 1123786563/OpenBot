import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MissingPage,
  RouteLoadError,
} from "@/components/layout/route-recovery";
import { ReadError } from "@/components/layout/read-status";
import { Toaster, toast } from "@/components/ui/toast";
import { client } from "@/lib/client";
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
function theAppAt(address: string, broken: () => boolean = () => false) {
  const root = createRootRoute({
    notFoundComponent: () => <MissingPage standalone />,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/page",
    loader: () => {
      if (broken()) throw new Error("The loader broke.");
    },
    component: () => <p>The page loaded.</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [address] }),
    defaultErrorComponent: RouteLoadError,
  });
  return render(<RouterProvider router={router} />);
}

test("the missing-page screen speaks the interface language", async () => {
  const view = theAppAt("/nowhere");
  const before = await view.findByRole("link", { name: "Open workspace" });
  view.getByRole("main", { name: "Page not found" });
  view.getByText(
    "Check the address or open your workspace to find your conversations and Bots.",
  );

  await pinLocale("zh-CN");

  expect(view.getByRole("link", { name: "打开工作区" })).toBe(before);
  expect(before.getAttribute("href")).toBe("/");
  view.getByRole("main", { name: "页面不存在" });
  view.getByRole("heading", { name: "页面不存在" });
  view.getByText("请检查地址，或打开工作区查找你的对话和 Bot。");
  expect(view.queryByRole("heading", { name: "Page not found" })).toBeNull();
});

test("the failed-load screen speaks the interface language, and its retry still loads the page", async () => {
  let broken = true;
  const view = theAppAt("/page", () => broken);
  const user = userEvent.setup({ document });
  await view.findByRole("heading", { name: "This page couldn’t load" });
  view.getByRole("region", { name: "This page couldn’t load" });
  view.getByText(
    "Try loading this page again, or return to your workspace to keep working.",
  );
  const retry = view.getByRole("button", { name: "Try again" });

  await pinLocale("zh-CN");

  expect(view.getByRole("button", { name: "重试" })).toBe(retry);
  view.getByRole("region", { name: "此页面未能加载" });
  view.getByRole("heading", { name: "此页面未能加载" });
  view.getByText("请重新加载此页面，或返回工作区继续工作。");
  view.getByRole("link", { name: "打开工作区" });

  broken = false;
  await user.click(retry);

  await view.findByText("The page loaded.");
  expect(view.queryByRole("button", { name: "重试" })).toBeNull();
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
