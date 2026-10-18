import "./preload";
import "./preload";
import { afterAll, afterEach, beforeAll, expect, mock, test } from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";

/*
 * Bifrost 03.5 (#227): the "sync now" entry on the administrator's model
 * catalog page. What the entry owes — before any styling question — is what
 * this file pins (the route contract itself is pinned server-side, in
 * server/tests/catalog-manual-sync.test.ts):
 *
 * - the button fires exactly the manual-sync route and, when the server
 *   answers a successful sync, the page says so with the synced time and the
 *   snapshot outcome — and re-reads the catalog, so what it lists is what the
 *   server now holds;
 * - a failed sync shows the server's fixed reason code, never a success
 *   sentence, and still re-reads the catalog;
 * - while a sync is running the button is disabled, so double-clicking
 *   cannot fire a second request on top of the one the server single-flights
 *   anyway;
 * - a process without the sync service answers 503 and the page says the
 *   trigger is unavailable rather than pretending nothing happened.
 *
 * The network is a stub with one mutable deployment state, the same shape
 * the 01.8 gateway screen tests use.
 */

mock.module("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: React.ReactNode }) =>
    children ?? null;
  return {
    Dialog: pass,
    DialogContent: pass,
    DialogHeader: pass,
    DialogBody: pass,
    DialogFooter: pass,
    DialogTitle: ({ children }: { children?: React.ReactNode }) => (
      <h2>{children}</h2>
    ),
    DialogDescription: ({ children }: { children?: React.ReactNode }) => (
      <p>{children}</p>
    ),
    DialogClose: pass,
    DialogOverlay: pass,
    DialogPortal: pass,
    DialogTrigger: pass,
  };
});

const { Route } = await import("@/routes/_authed/admin/model-catalog");

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  void i18n.changeLanguage("en");
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

type SyncResult =
  | {
      status: "ok";
      syncedAt: string;
      appended: number;
      skipped: number;
      record: {
        fetchedAt: string;
        source: string;
        rawItemCount: number;
        configVersion: number;
      };
    }
  | {
      status: "failed";
      stage: string;
      reasonCode: string;
      failedAt: string;
    };

/** What the stubbed server holds; each test stages it before rendering. */
let models: unknown[];
let nextSyncResult: SyncResult;
let nextSyncStatus: number;
let syncPosts: number;
/** Held open while non-null: the sync POST resolves only on release. */
let holdSync: (() => void) | null = null;

function model(id: string) {
  const [provider, ...rest] = id.split("/");
  return {
    ref: { provider, model: rest.join("/"), capability: "chat" },
    capabilitySource: "supported_methods",
    unknownReason: null,
    priceStatus: "known",
    priceStatusReason: null,
    priceMissingDims: null,
    scope: null,
    open: false,
  };
}

function installFetchStub() {
  syncPosts = 0;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && url === "/api/admin/gateway/models") {
      return json({ models });
    }
    if (method === "POST" && url === "/api/admin/gateway/catalog/sync") {
      syncPosts += 1;
      if (holdSync) {
        await new Promise<void>((resolve) => {
          holdSync = resolve;
        });
      }
      if (nextSyncStatus !== 200) {
        return json(
          {
            error: "The catalog sync service is not available.",
            code: "gateway_catalog_sync_unavailable",
          },
          nextSyncStatus,
        );
      }
      return json({ result: nextSyncResult });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function renderCatalogPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const rootRoute = createRootRoute({
    component: Route.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByRole("heading", { name: "Model catalog" });
  return view;
}

const OK_SYNC: SyncResult = {
  status: "ok",
  syncedAt: "2026-10-17T12:00:00.000Z",
  appended: 2,
  skipped: 1,
  record: {
    fetchedAt: "2026-10-17T12:00:00.000Z",
    source: "gateway:/v1/models",
    rawItemCount: 3,
    configVersion: 4,
  },
};

test("the sync button fires the manual route, reports the outcome and re-reads the catalog", async () => {
  models = [];
  nextSyncResult = OK_SYNC;
  nextSyncStatus = 200;
  holdSync = null;
  installFetchStub();
  const view = await renderCatalogPage();

  // Before the sync the gateway has listed nothing.
  expect(view.getByText(/has not synced any models yet/)).not.toBeNull();

  const button = view.getByRole("button", { name: "Sync now" });
  models = [model("openai/gpt-4o")];
  fireEvent.click(button);

  // The route that ran is the manual sync route.
  await waitFor(() => expect(syncPosts).toBe(1));
  // The outcome is displayed with the synced time and the snapshot counts.
  await waitFor(() =>
    expect(view.getByTestId("catalog-sync-result").textContent).toContain(
      "2",
    ),
  );
  expect(
    view.getByTestId("catalog-sync-result").textContent,
  ).toContain("2026");
  // The catalog was re-read: what the server now holds is what is listed.
  await waitFor(() =>
    expect(view.queryByText(/has not synced any models yet/)).toBeNull(),
  );
  expect(view.getByText("gpt-4o")).not.toBeNull();
});

test("a failed sync shows the server's fixed reason, never a success sentence", async () => {
  models = [model("openai/gpt-4o")];
  nextSyncResult = {
    status: "failed",
    stage: "catalog",
    reasonCode: "catalog_fetch_unreachable",
    failedAt: "2026-10-17T12:05:00.000Z",
  };
  nextSyncStatus = 200;
  holdSync = null;
  installFetchStub();
  const view = await renderCatalogPage();

  fireEvent.click(view.getByRole("button", { name: "Sync now" }));

  await waitFor(() => expect(syncPosts).toBe(1));
  const result = view.getByTestId("catalog-sync-result");
  await waitFor(() => expect(result.textContent).toContain("catalog_fetch_unreachable"));
  expect(result.textContent).not.toContain("Synced");
});

test("a running sync disables the button, so double-clicking fires no second request", async () => {
  models = [];
  nextSyncResult = OK_SYNC;
  nextSyncStatus = 200;
  installFetchStub();
  // The first POST parks until released; the second click must never fire.
  syncPosts = 0;
  holdSync = () => {};
  const view = await renderCatalogPage();

  const button = view.getByRole("button", { name: "Sync now" });
  fireEvent.click(button);
  await waitFor(() => expect(syncPosts).toBe(1));

  await userEvent.click(button);
  expect(syncPosts).toBe(1);
  expect((button as HTMLButtonElement).disabled).toBe(true);

  // Let the sync land; the button comes back.
  const release = holdSync as unknown as () => void;
  holdSync = null;
  release();
  await waitFor(() => expect((view.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(false));
});

test("a process without the sync service says the trigger is unavailable", async () => {
  models = [];
  nextSyncResult = OK_SYNC;
  nextSyncStatus = 503;
  holdSync = null;
  installFetchStub();
  const view = await renderCatalogPage();

  fireEvent.click(view.getByRole("button", { name: "Sync now" }));

  await waitFor(() => expect(syncPosts).toBe(1));
  const result = view.getByTestId("catalog-sync-result");
  await waitFor(() =>
    expect(result.textContent).toContain("unavailable"),
  );
});
