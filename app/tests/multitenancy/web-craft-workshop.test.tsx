import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { WorkshopPanel } from "../../src/components/channels/workshop-panel";
import { SessionSidebar } from "../../src/components/craft/session-sidebar";
import { Route as CraftSessionRoute } from "../../src/routes/_authed/_app/craft/$sessionId";
import { scopedCachePrefix } from "../../src/lib/enterprise/tenant/scoped-cache";
import {
  type ScopeSelection,
  selectWorkspaceScope,
  selectionStorageKey,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import { craftKeys } from "../../src/lib/craft/queries";
import { issuePreviewTicket } from "../../src/lib/craft/client";
import {
  cancelWorkshopTurn,
  createWorkshopSchedule,
  startWorkshopTurn,
  type WorkshopSnapshot,
} from "../../src/lib/workshop/client";
import { workshopKeys } from "../../src/lib/workshop/queries";
import { interruptSession, sendMessage } from "../../src/lib/craft/client";
import { runScheduledTaskNow } from "../../src/lib/craft/scheduled-tasks";
import type { CraftSession } from "../../src/lib/craft/types";

/**
 * MT091 / Issue #134: the craft and workshop pages are bound to the scope the screen holds. The
 * sessions roster, one session's detail and the workshop's aggregate snapshot carry the selection
 * pair and file under the scope's own cache prefix (AC1 — a cross-scope id answers 404 and reads
 * as the typed unavailable error, never as another scope's rows); the artifact and preview faces
 * ride the server's authorizations — the preview pass is minted under the scope in force, and a
 * revoked share settles at both cache roots so the tab reflects it immediately (AC2); the
 * execution and scheduling writes — send, interrupt, turn start/cancel, schedules, share mint and
 * revoke — submit the current scope (AC3). The business regressions (AC4) run in their own suites
 * (craft-session-title, plugin and channel suites; craft-preview-tab / craft-files-tab-outputs /
 * gallery-components carry the known Node-runner paint baseline reds recorded in the reports).
 *
 * THE HARNESS IS THE REAL PAGE AND THE REAL SEAM: `SessionSidebar` and `WorkshopPanel` render as
 * themselves inside a memory router, the selection is seeded from storage exactly as production
 * seeds it, and a switch goes through `selectWorkspaceScope`. `fetch` records every request — the
 * pair the client carried is the evidence.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};
const ACME_PAIR = { tenantId: "acme", workspaceId: "acme-finance" };

const session = (id: string, name: string): CraftSession => ({
  id,
  user_id: USER,
  name,
  status: "active",
  created_at: "2026-10-20T00:00:00Z",
  last_activity_at: "2026-10-21T00:00:00Z",
  nextjs_port: null,
  sharing_scope: "private",
  origin: "INTERACTIVE",
  agent_provider: null,
  agent_model: null,
  opencode_session_id: null,
  skills_stale: false,
});

const snapshot = (share: WorkshopSnapshot["share"]): WorkshopSnapshot => ({
  session: {
    id: "ws-1",
    channelId: "ch-1",
    botId: "bot-1",
    status: "active",
    visibility: "unlisted",
    createdAt: "2026-10-20T00:00:00Z",
    lastActivityAt: "2026-10-21T00:00:00Z",
  },
  turns: [],
  artifacts: [
    {
      id: "art-1",
      sessionId: "ws-1",
      type: "report",
      name: "acme-report.md",
      path: "outputs/acme-report.md",
      sizeBytes: 1024,
      previewUrl: null,
      visibility: "public",
      createdAt: "2026-10-21T00:00:00Z",
    },
  ],
  sandbox: { kind: "ready" },
  usage: {
    total: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
  },
  share,
});

const LIVE_SHARE: WorkshopSnapshot["share"] = {
  visibility: "unlisted",
  scope: "preview",
  shareUrl: "http://localhost/share/live-token",
  shareExpiresAt: "2026-11-01T00:00:00Z",
  shareRevokedAt: null,
};
const REVOKED_SHARE: WorkshopSnapshot["share"] = {
  ...LIVE_SHARE,
  shareRevokedAt: "2026-10-21T12:00:00Z",
};

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // The workshop's live-turn stream opens an EventSource when a turn is running; happy-dom
  // ships none, and the panel's default tab mounts the hook unconditionally.
  if (!("EventSource" in globalThis)) {
    class StubEventSource {
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = StubEventSource;
  }
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

const originalFetch = global.fetch;

type Asked = { input: string; init: RequestInit | undefined };

let asked: Asked[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serve(handler: (path: string) => Response | undefined): void {
  global.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = String(input).split("?")[0];
    asked.push({ input: path, init });
    if (path === "/api/me") return jsonResponse(200, { user: { id: USER } });
    return handler(path) ?? jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

function headerOf(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return (headers as Record<string, string>)[name];
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function draw(queryClient: QueryClient, node: React.ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => node }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The craft detail view, mounted the way its route mounts it (params and all). */
function drawCraftDetail(
  queryClient: QueryClient,
  sessionId: string,
  handler: (path: string) => Response | undefined,
) {
  serve(handler);
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const appRoute = createRoute({
    id: "/_app",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const detail = (
    CraftSessionRoute as unknown as {
      update: (options: unknown) => unknown;
    }
  ).update({
    path: "/craft/$sessionId",
    getParentRoute: () => appRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([detail as never])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: [`/craft/${sessionId}`],
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  asked = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// AC1 — the roster, the detail and the workshop snapshot are the scope's own answer
// ---------------------------------------------------------------------------

describe("MT091 AC1 — craft and workshop reads are the scope's own answer", () => {
  test("the sessions roster carries the pair and files under the scope's prefix", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/craft/sessions"
        ? jsonResponse(200, { sessions: [session("s-1", "Acme landing page")] })
        : undefined,
    );
    const queryClient = freshClient();
    const view = draw(queryClient, <SessionSidebar />);

    await waitFor(() =>
      expect(view.getByText("Acme landing page")).toBeTruthy(),
    );

    const read = asked.find((ask) => ask.input === "/api/craft/sessions");
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        ...craftKeys.list(),
      ]),
    ).toBeTruthy();
  });

  test("a cross-scope session id answers 404 and renders the explicit unavailable state", async () => {
    storeSelection(USER, ACME);
    const view = drawCraftDetail(freshClient(), "s-other-company", (path) =>
      path === "/api/craft/sessions/s-other-company"
        ? jsonResponse(404, { error: "not found" })
        : path === "/api/craft/sessions"
          ? jsonResponse(200, { sessions: [] })
          : path.endsWith("/messages")
            ? jsonResponse(200, { messages: [] })
            : path.endsWith("/approvals/live")
              ? jsonResponse(200, { approvals: [] })
              : undefined,
    );

    await waitFor(() =>
      expect(
        view.getByText("This session is not available in the current workspace."),
      ).toBeTruthy(),
    );
    // The invisible semantic leaks nothing about the other company's session.
    expect(view.queryByText("Globex quarterly plan")).toBeNull();
  });

  test("the workshop snapshot carries the pair; a cross-scope channel id renders unavailable", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/workshop/ch-1"
        ? jsonResponse(404, { error: "not found" })
        : undefined,
    );
    const queryClient = freshClient();
    const view = draw(queryClient, <WorkshopPanel channelId="ch-1" botId="bot-1" />);

    await waitFor(() =>
      expect(
        view.getByText("This workshop is not available in the current workspace."),
      ).toBeTruthy(),
    );

    const read = asked.find((ask) => ask.input === "/api/workshop/ch-1");
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
  });

  test("a switch drops the old scope's roster wholesale — no residue beside the new scope", async () => {
    storeSelection(USER, ACME);
    let current = ACME;
    serve((path) => {
      if (path !== "/api/craft/sessions") return undefined;
      return jsonResponse(200, {
        sessions: [
          session("s-acme", current === ACME ? "Acme landing page" : "Globex ops run"),
        ],
      });
    });
    const queryClient = freshClient();
    const view = draw(queryClient, <SessionSidebar />);
    await waitFor(() =>
      expect(view.getByText("Acme landing page")).toBeTruthy(),
    );

    // The switch seam itself, exactly as the selection page drives it.
    window.localStorage.setItem(selectionStorageKey(USER), JSON.stringify(GLOBEX));
    await act(async () => {
      selectWorkspaceScope(queryClient, USER, ACME, GLOBEX);
    });
    current = GLOBEX;
    await waitFor(() => expect(view.getByText("Globex ops run")).toBeTruthy());

    // The old scope's entry is gone from the cache, not merely replaced in view.
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        ...craftKeys.list(),
      ]),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2 — the artifact and preview faces ride the server's authorizations
// ---------------------------------------------------------------------------

describe("MT091 AC2 — issuance and revocation reflect immediately", () => {
  test("the preview pass is minted under the scope in force", async () => {
    serve(() => jsonResponse(200, { ticket: "t", origin: "http://p", expiresAt: "2026-10-22T00:00:00Z" }));
    await issuePreviewTicket("s-1", ACME_PAIR);
    const mint = asked.find((ask) =>
      ask.input.endsWith("/api/craft/sessions/s-1/preview-ticket"),
    );
    expect(mint).toBeTruthy();
    expect(mint?.init?.method).toBe("POST");
    expect(headerOf(mint?.init, "x-openbot-tenant")).toBe("acme");
  });

  test("revoking the share settles at BOTH cache roots — the panel reflects it immediately", async () => {
    storeSelection(USER, ACME);
    let share = LIVE_SHARE;
    serve((path) => {
      if (path === "/api/workshop/ch-1")
        return jsonResponse(200, snapshot(share));
      if (path === "/api/workshop/ch-1/share") {
        // The revoke lands: every snapshot read after this one carries the revoked fact.
        share = REVOKED_SHARE;
        return jsonResponse(200, {});
      }
      return undefined;
    });
    const queryClient = freshClient();
    const view = draw(
      queryClient,
      <WorkshopPanel channelId="ch-1" botId="bot-1" />,
    );

    // The share tab answers from the scoped snapshot the panel holds.
    const shareTab = await view.findByRole("tab", { name: "Share" });
    await act(async () => {
      shareTab.click();
    });
    expect(await view.findByText("Sharing is live, until 11/1/2026, 12:00:00 AM.")).toBeTruthy();

    // The real page flow: revoke asks once, then confirms.
    await act(async () => {
      view.getByRole("button", { name: "Revoke link" }).click();
    });
    await act(async () => {
      view.getByRole("button", { name: "Revoke" }).click();
    });

    // The write carried the pair…
    const revoke = asked.find(
      (ask) => ask.input === "/api/workshop/ch-1/share",
    );
    expect(revoke?.init?.method).toBe("DELETE");
    expect(headerOf(revoke?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(revoke?.init, "x-openbot-workspace")).toBe("acme-finance");

    // …and the settle re-read the SCOPED entry, which now carries the revoked fact.
    await waitFor(() =>
      expect(view.getByText("No share is live.")).toBeTruthy(),
    );
    expect(
      queryClient.getQueryData<WorkshopSnapshot>([
        ...scopedCachePrefix(USER, ACME),
        ...workshopKeys.snapshot("ch-1"),
      ])?.share.shareRevokedAt,
    ).toBe(REVOKED_SHARE.shareRevokedAt);
  });
});

// ---------------------------------------------------------------------------
// AC3 — execution and scheduling actions submit the current scope
// ---------------------------------------------------------------------------

describe("MT091 AC3 — execution and scheduling writes carry the pair", () => {
  test("send and interrupt carry the pair", async () => {
    serve(() => jsonResponse(200, { turn_id: "t-1" }));
    await sendMessage("s-1", "hello", undefined, ACME_PAIR);
    const send = asked.find((ask) =>
      ask.input.endsWith("/api/craft/sessions/s-1/send-message"),
    );
    expect(send?.init?.method).toBe("POST");
    expect(headerOf(send?.init, "x-openbot-tenant")).toBe("acme");

    await interruptSession("s-1", ACME_PAIR);
    const stop = asked.find((ask) =>
      ask.input.endsWith("/api/craft/sessions/s-1/interrupt"),
    );
    expect(stop?.init?.method).toBe("POST");
    expect(headerOf(stop?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(stop?.init, "x-openbot-workspace")).toBe("acme-finance");
  });

  test("workshop turn writes carry the pair", async () => {
    serve(() => jsonResponse(200, { turnId: "t-1" }));
    await startWorkshopTurn("ch-1", { prompt: "run" }, undefined, ACME_PAIR);
    const start = asked.find((ask) => ask.input === "/api/workshop/ch-1/turns");
    expect(start?.init?.method).toBe("POST");
    expect(headerOf(start?.init, "x-openbot-tenant")).toBe("acme");

    await cancelWorkshopTurn("ch-1", "t-1", ACME_PAIR);
    const cancel = asked.find((ask) =>
      ask.input === "/api/workshop/ch-1/turns/t-1/cancel",
    );
    expect(cancel?.init?.method).toBe("POST");
    expect(headerOf(cancel?.init, "x-openbot-workspace")).toBe("acme-finance");
  });

  test("schedule writes carry the pair — craft scheduled tasks and workshop schedules", async () => {
    serve(() => jsonResponse(200, { id: "sch-1", rrule: "FREQ=DAILY" }));
    await createWorkshopSchedule(
      "ch-1",
      { prompt: "daily digest", mode: { kind: "daily", time: "09:00" } },
      ACME_PAIR,
    );
    const create = asked.find(
      (ask) => ask.input === "/api/workshop/ch-1/schedules",
    );
    expect(create?.init?.method).toBe("POST");
    expect(headerOf(create?.init, "x-openbot-tenant")).toBe("acme");

    await runScheduledTaskNow("task-1", ACME_PAIR);
    const runNow = asked.find((ask) =>
      ask.input === "/api/craft/scheduled-tasks/task-1/run-now",
    );
    expect(runNow?.init?.method).toBe("POST");
    expect(headerOf(runNow?.init, "x-openbot-tenant")).toBe("acme");
  });
});

