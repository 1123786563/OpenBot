import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SandboxedRecord } from "@/lib/sandboxed/queries";
import { Route } from "@/routes/_authed/admin/playground";
import { settleReactWork } from "./settle-react-work";

const saved: SandboxedRecord = {
  name: "custom_saved_card",
  title: "Saved card",
  draftDescription: "A saved component",
  draftHtml: "<p>Saved</p>",
  draftCss: "",
  draftJsFunctions: "",
  draftArgumentSchema: {},
  publishedHtml: null,
  publishedCss: null,
  publishedJsFunctions: null,
  publishedArgumentSchema: null,
  sampleArguments: {},
  revision: 0,
  published: false,
  publishedAt: null,
  authoredBy: null,
  hasUnpublishedChanges: true,
};

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  cleanup();
  await settleReactWork();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

async function draw() {
  const drafts: unknown[] = [];
  const publications: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        if (path === "/api/sandboxed") {
          drafts.push(JSON.parse(String(init.body)));
          return Response.json({
            component: { draftVersion: "saved-version" },
          });
        }
        if (/^\/api\/sandboxed\/[^/]+\/publish$/.test(path)) {
          publications.push(JSON.parse(String(init.body)));
          return publications.length === 1
            ? Response.json({}, { status: 503 })
            : Response.json({});
        }
      }
      return path === "/api/sandboxed"
        ? Response.json({ components: [saved] })
        : Response.json({}, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: Route.options.component }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByRole("button", { name: "Open Saved card" });
  return { view, user: userEvent.setup({ document }), drafts, publications };
}

test("cancelling a dirty open restores focus and leaves the draft in the editor", async () => {
  const { view, user } = await draw();
  const title = view.getByRole("textbox", { name: "Title" });
  await user.type(title, "Unsaved title");
  const open = view.getByRole("button", { name: "Open Saved card" });
  await user.click(open);
  const dialog = await view.findByRole("alertdialog", {
    name: "Discard unsaved edits?",
  });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

  await waitFor(() => expect(document.activeElement === open).toBe(true));
  expect(view.queryByRole("alertdialog")).toBeNull();
  expect(title).toHaveProperty("value", "Unsaved title");
});

test("retrying publication uses the saved draft version without a second save", async () => {
  const { view, user, drafts, publications } = await draw();
  await user.click(view.getByRole("button", { name: "Open Saved card" }));
  await user.click(view.getByRole("button", { name: "Publish" }));
  const dialog = within(await view.findByRole("alertdialog"));
  await user.click(dialog.getByRole("button", { name: "Publish" }));
  await user.click(await dialog.findByRole("button", { name: "Try again" }));

  await view.findByText("Published.");
  expect(drafts).toHaveLength(1);
  expect(publications).toEqual([
    { expectedDraftVersion: "saved-version" },
    { expectedDraftVersion: "saved-version" },
  ]);
});

test("invalid sample arguments show a preview error and the editor can recover", async () => {
  const { view, user } = await draw();
  const sample = view.getByRole("textbox", { name: "Sample arguments" });
  await user.clear(sample);
  await user.type(sample, "invalid");
  await view.findByText("This preview can't be drawn.");
  await user.clear(sample);
  await user.type(sample, "{{}");
  await waitFor(() =>
    expect(view.queryByText("This preview can't be drawn.")).toBeNull(),
  );
});
