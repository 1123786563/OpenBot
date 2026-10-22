import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  GLOBAL_EXCEPTION_ENTRIES,
  matchGlobalException,
} from "../../../server/src/enterprise/tenancy/global-exceptions";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "../../../tests/support/bun-test-compat";
import { channelKeys as rosterKeys } from "../../src/lib/channels/queries";
import { useChannelEvents } from "../../src/lib/channels/use-channel-events";
import { useBuildStreaming } from "../../src/lib/craft/streaming";
import {
  type ScopeSelection,
  selectionStorageKey,
  selectWorkspaceScope,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import {
  SCOPE_STREAM_ALLOWED_PATHS,
  withStreamScope,
} from "../../src/lib/enterprise/tenant/stream-scope";
import { socketUrl } from "../../src/lib/socket-url";
import { useWorkshopStream } from "../../src/lib/workshop/stream";

/**
 * MT082 / Issue #125: streaming connections (SSE and WebSocket) carry the current selection on
 * establish and reconnect, are torn down when the selection moves, reconnect under the scope
 * that is current then (never a default), and consult the same cache generation the REST reads
 * guard with before they write.
 *
 * THE HARNESS IS TRANSPORT INTERCEPTION, as in `selection.test.tsx` and `transport-rest.test.tsx`:
 * a fake `EventSource` records every URL it is asked to open, a fake `WebSocket` does the same,
 * and `fetch` serves the one REST read the scope source needs (`/api/me`) plus the craft SSE. No
 * route is rendered and no server stands up — the connection's own shape and lifecycle are the
 * evidence. Three live surfaces are driven at hook level (the workshop EventSource, the roster
 * WebSocket, the craft fetch-SSE); the two remaining surfaces' wiring is one `withStreamScope`
 * call each, pinned by the URL-level cases below.
 *
 * THE SELECTION SOURCE IS THE REAL ONE: storage seeds the live current-selection entry, and a
 * switch goes through `selectWorkspaceScope` — the same seam the selection page commits through —
 * so what these tests move is exactly what production moves.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};

beforeAll(() => GlobalRegistrator.register());
// Unregistered again so a sibling DOM file in the same bun process can register
// its own (the registrator refuses a second global registration).
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

// ---------------------------------------------------------------------------
// The fake transports
// ---------------------------------------------------------------------------

type Handler = (() => void) | null;

class FakeEventSource {
  static opened: FakeEventSource[] = [];
  url: string;
  onopen: Handler = null;
  onerror: Handler = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }

  close() {
    this.closed = true;
  }
}

class FakeWebSocket {
  static opened: FakeWebSocket[] = [];
  url: string;
  onopen: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.opened.push(this);
  }

  close() {
    this.closed = true;
  }
}

const originalFetch = global.fetch;
const originalWebSocket = globalThis.WebSocket;
let asked: string[] = [];

/** Serves `/api/me` (the scope source's own read) and records every other fetch's URL. */
function serveAuth(): void {
  asked = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    asked.push(path);
    if (path === "/api/me") {
      return new Response(JSON.stringify({ user: { id: USER } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // The craft SSE: an ok body that says nothing until the caller aborts it —
    // a live stream, so a teardown is observable as the drain loop ending.
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    });
    init?.signal?.addEventListener("abort", () => {
      stream?.error(
        new DOMException("The stream was torn down.", "AbortError"),
      );
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

/** `/api/me` never answers: the scope source is unresolved, nothing may subscribe. */
function servePendingAuth(): void {
  global.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "/api/me") {
      return new Promise<Response>(() => {
        /* never */
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

/** The roster URL as production derives it from THIS DOM's own location. */
function socketUrlOf(path: string): string {
  return socketUrl(path);
}

/** The whole switch, as production makes it: the storage mirror and the one switch seam. */
function switchSelection(
  queryClient: QueryClient,
  previous: ScopeSelection | null,
  next: ScopeSelection | null,
): void {
  if (next !== null) storeSelection(USER, next);
  else window.localStorage.removeItem(selectionStorageKey(USER));
  selectWorkspaceScope(queryClient, USER, previous, next);
}

beforeEach(() => {
  FakeEventSource.opened = [];
  FakeWebSocket.opened = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  window.localStorage.clear();
  serveAuth();
});

afterEach(() => {
  global.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

function WorkshopProbe({ channelId = "ch-1" }: { channelId?: string }) {
  const { events, connected } = useWorkshopStream({
    channelId,
    active: true,
    sourceFactory: FakeEventSource as unknown as typeof EventSource,
  });
  return (
    <div>
      <span data-testid="connected">{connected ? "yes" : "no"}</span>
      <span data-testid="events">{events.length}</span>
    </div>
  );
}

function RosterProbe() {
  useChannelEvents();
  return <div data-testid="roster" />;
}

function CraftProbe() {
  const { items, isStreaming, streamTurnEvents } =
    useBuildStreaming("session-1");
  return (
    <div>
      <span data-testid="craft-items">{items.length}</span>
      <span data-testid="craft-streaming">{isStreaming ? "yes" : "no"}</span>
      <button
        data-testid="craft-attach"
        onClick={() => void streamTurnEvents("turn-1")}
        type="button"
      />
    </div>
  );
}

function drawInRouter(queryClient: QueryClient, probe: React.ReactNode) {
  const rootRoute = createRootRoute({
    // The roster hook reads the router at event time; any router context will do.
    component: () => <>{probe}</>,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

// The roster cache the socket writes into, seeded so a write is observable.
type ChannelCache = {
  pages: { channels: Record<string, unknown>[] }[];
  pageParams: unknown[];
};

function seedRoster(queryClient: QueryClient): void {
  const cache: ChannelCache = {
    pages: [
      {
        channels: [
          {
            id: "ch-1",
            title: "Acme channel",
            createdAt: "2026-10-01T00:00:00Z",
            lastMessage: "before",
            lastMessageAt: "2026-10-01T00:00:00Z",
          },
        ],
      },
    ],
    pageParams: [null],
  };
  queryClient.setQueryData(rosterKeys.list(), cache);
}

function rosterPreview(queryClient: QueryClient): string | undefined {
  const data = queryClient.getQueryData<ChannelCache>(rosterKeys.list());
  return (data?.pages[0] as { channels?: { lastMessage?: string }[] })
    ?.channels?.[0]?.lastMessage;
}

// ---------------------------------------------------------------------------
// AC1 — establish and reconnect carry the current selection; a missing one is
// carried as absent, and an unresolved scope source opens no subscription at all
// ---------------------------------------------------------------------------

describe("MT082 AC1 — connections carry the current selection", () => {
  test("the workshop EventSource carries the pair on its URL", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    drawInRouter(queryClient, <WorkshopProbe />);

    await waitFor(() => {
      expect(FakeEventSource.opened.length).toBe(1);
    });
    expect(FakeEventSource.opened[0]?.url).toBe(
      "/api/workshop/ch-1/events" +
        "?x-openbot-tenant=acme&x-openbot-workspace=acme-finance",
    );
  });

  test("the roster WebSocket carries the pair on its (ws-scheme) URL", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    drawInRouter(queryClient, <RosterProbe />);

    await waitFor(() => {
      expect(FakeWebSocket.opened.length).toBe(1);
    });
    expect(FakeWebSocket.opened[0]?.url).toBe(
      socketUrlOf("/api/channels/events") +
        "?x-openbot-tenant=acme&x-openbot-workspace=acme-finance",
    );
  });

  test("personal context (no selection) opens with NO pair — absent, never defaulted", async () => {
    const queryClient = freshClient();
    drawInRouter(queryClient, <WorkshopProbe />);

    await waitFor(() => {
      expect(FakeEventSource.opened.length).toBe(1);
    });
    expect(FakeEventSource.opened[0]?.url).toBe("/api/workshop/ch-1/events");
  });

  test("an unresolved scope source opens no business subscription at all", async () => {
    servePendingAuth();
    const queryClient = freshClient();
    drawInRouter(queryClient, <WorkshopProbe />);

    // Give the pending auth every chance to (not) resolve into a subscription.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(FakeEventSource.opened.length).toBe(0);
  });

  test("the craft SSE read carries the pair on its URL", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    const view = drawInRouter(queryClient, <CraftProbe />);

    await waitFor(() => {
      expect(view.getByTestId("craft-attach")).toBeTruthy();
    });
    await act(async () => {
      view.getByTestId("craft-attach").click();
    });
    // The attach's own async start (the reset, the fetch's first tick) is one
    // microtask behind the click; flush it inside act too.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(asked.some((path) => path === "/api/me")).toBe(true);
    expect(
      asked.some(
        (path) =>
          path ===
          "/api/craft/sessions/session-1/turns/turn-1/events" +
            "?x-openbot-tenant=acme&x-openbot-workspace=acme-finance",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2 — a switch cancels the old connection; no old-scope event survives it
// ---------------------------------------------------------------------------

describe("MT082 AC2 — a switch cancels the old connection", () => {
  test("the workshop source is closed and reopened under the new pair; a frame from the old source writes nothing", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    const view = drawInRouter(queryClient, <WorkshopProbe />);
    await waitFor(() => {
      expect(FakeEventSource.opened.length).toBe(1);
    });
    const old = FakeEventSource.opened[0] as FakeEventSource;

    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });

    await waitFor(() => {
      expect(FakeEventSource.opened.length).toBe(2);
    });
    expect(old.closed).toBe(true);
    expect(FakeEventSource.opened[1]?.url).toContain("x-openbot-tenant=globex");
    expect(FakeEventSource.opened[1]?.url).toContain(
      "x-openbot-workspace=globex-ops",
    );

    // A frame that races the teardown through the OLD source is refused (AC4's
    // write discipline, seen from the EventSource side).
    await act(async () => {
      old.onmessage?.({
        data: JSON.stringify({ type: "log", seq: 1, message: "stale" }),
      });
    });
    expect(view.getByTestId("events").textContent).toBe("0");
  });

  test("the roster socket is closed and reopened; an event through the old socket writes nothing", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    seedRoster(queryClient);
    drawInRouter(queryClient, <RosterProbe />);
    await waitFor(() => {
      expect(FakeWebSocket.opened.length).toBe(1);
    });
    const old = FakeWebSocket.opened[0] as FakeWebSocket;

    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });

    await waitFor(() => {
      expect(FakeWebSocket.opened.length).toBe(2);
    });
    expect(old.closed).toBe(true);
    expect(FakeWebSocket.opened[1]?.url).toContain("x-openbot-tenant=globex");

    await act(async () => {
      old.onmessage?.({
        data: JSON.stringify({
          channelId: "ch-1",
          lastMessage: "from the old scope",
          lastMessageAt: "2026-10-02T00:00:00Z",
        }),
      });
    });
    expect(rosterPreview(queryClient)).toBe("before");
  });

  test("a switch committed in ANOTHER tab (the storage event) rebinds this tab the same way", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    drawInRouter(queryClient, <WorkshopProbe />);
    await waitFor(() => {
      expect(FakeEventSource.opened.length).toBe(1);
    });

    // The other tab commits: its storage mirror moves, this tab only hears the event.
    storeSelection(USER, GLOBEX);
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: selectionStorageKey(USER),
          newValue: JSON.stringify(GLOBEX),
        }),
      );
    });

    await waitFor(() => {
      expect(FakeEventSource.opened.length).toBe(2);
    });
    expect(FakeEventSource.opened[0]?.closed).toBe(true);
    expect(FakeEventSource.opened[1]?.url).toContain("x-openbot-tenant=globex");
  });

  test("the live craft stream aborts and resets when the scope moves", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    const view = drawInRouter(queryClient, <CraftProbe />);
    await waitFor(() => {
      expect(view.getByTestId("craft-attach")).toBeTruthy();
    });
    await act(async () => {
      view.getByTestId("craft-attach").click();
    });
    // The attach's own async start (the reset, the fetch's first tick) is one
    // microtask behind the click; flush it inside act too.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => {
      expect(view.getByTestId("craft-streaming").textContent).toBe("yes");
    });

    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    // The abort tears the SSE body down a tick later; its finish dispatch is an
    // update too — flush it inside act before asserting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(view.getByTestId("craft-streaming").textContent).toBe("no");
    });
    // The next attach carries the new pair.
    await act(async () => {
      view.getByTestId("craft-attach").click();
    });
    // The attach's own async start (the reset, the fetch's first tick) is one
    // microtask behind the click; flush it inside act too.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      asked.some(
        (path) =>
          path ===
          "/api/craft/sessions/session-1/turns/turn-1/events" +
            "?x-openbot-tenant=globex&x-openbot-workspace=globex-ops",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3 — a dropped line reconnects under the scope current THEN, never a default
// ---------------------------------------------------------------------------

describe("MT082 AC3 — reconnect uses the current scope, not a default", () => {
  test("a workshop retry scheduled under one selection reopens under the new one", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    drawInRouter(queryClient, <WorkshopProbe />);
    await waitFor(() => {
      expect(FakeEventSource.opened.length).toBe(1);
    });

    // The line drops; the backoff is scheduled while ACME is still current…
    await act(async () => {
      (FakeEventSource.opened[0] as FakeEventSource).onerror?.();
    });
    // …then the selection moves before the retry fires.
    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });

    jest.useFakeTimers();
    try {
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
    } finally {
      jest.useRealTimers();
    }

    // The rebind (not the stale retry) is what opened: every live source answers
    // to GLOBEX, and nothing ever carried a defaulted pair.
    for (const source of FakeEventSource.opened) {
      if (source.closed) continue;
      expect(source.url).toContain("x-openbot-tenant=globex");
    }
    expect(
      FakeEventSource.opened.some((source) =>
        source.url.includes("x-openbot-tenant=acme"),
      ),
    ).toBe(true); // the original, under ACME — now closed
  });

  test("a scope dropped to nothing reconnects with NO pair (no fallback to the old one)", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    drawInRouter(queryClient, <WorkshopProbe />);
    await waitFor(() => {
      expect(FakeEventSource.opened.length).toBe(1);
    });

    await act(async () => {
      switchSelection(queryClient, ACME, null);
    });

    await waitFor(() => {
      expect(FakeEventSource.opened.length).toBe(2);
    });
    expect(FakeEventSource.opened[1]?.url).toBe("/api/workshop/ch-1/events");
  });

  test("a roster socket that drops reconnects under the current pair", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    drawInRouter(queryClient, <RosterProbe />);
    await waitFor(() => {
      expect(FakeWebSocket.opened.length).toBe(1);
    });

    await act(async () => {
      (FakeWebSocket.opened[0] as FakeWebSocket).onclose?.();
    });
    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });

    // The rebind, not the stale retry: the dropped socket's own backoff was scheduled
    // under ACME, and the switch must be what answers, under GLOBEX.
    await waitFor(() => {
      expect(FakeWebSocket.opened.length).toBe(2);
    });
    expect(FakeWebSocket.opened[0]?.closed).toBe(true);
    for (const socket of FakeWebSocket.opened) {
      if (socket.closed) continue;
      expect(socket.url).toContain("x-openbot-tenant=globex");
    }

    // And nothing is left scheduled to resurrect the dropped line: advancing past
    // the backoff opens nothing new.
    jest.useFakeTimers();
    try {
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
    } finally {
      jest.useRealTimers();
    }
    expect(FakeWebSocket.opened.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC4 — the generation discipline: no old-scope write, and one registry for it
// ---------------------------------------------------------------------------

describe("MT082 AC4 — the cache generation guards stream writes", () => {
  test("a roster event whose generation outlived the switch is dropped, not applied", async () => {
    storeSelection(USER, ACME);
    const queryClient = freshClient();
    seedRoster(queryClient);
    drawInRouter(queryClient, <RosterProbe />);
    await waitFor(() => {
      expect(FakeWebSocket.opened.length).toBe(1);
    });
    const socket = FakeWebSocket.opened[0] as FakeWebSocket;

    // A team change inside one company moves the generation (and only the old
    // team's subtree), exactly as the selection page's commit does.
    const nextTeam = { tenantId: "acme", workspaceId: "acme-legal" };
    await act(async () => {
      switchSelection(queryClient, ACME, nextTeam);
    });

    // A frame that was already on the wire under the old generation:
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          channelId: "ch-1",
          lastMessage: "stale in-flight frame",
          lastMessageAt: "2026-10-03T00:00:00Z",
        }),
      });
    });
    expect(rosterPreview(queryClient)).toBe("before");
  });

  test("the stream-path inventory is closed, registry-shaped, and reconciles with MT030", () => {
    expect(SCOPE_STREAM_ALLOWED_PATHS.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const entry of SCOPE_STREAM_ALLOWED_PATHS) {
      expect(entry.id.trim().length).toBeGreaterThan(0);
      expect(entry.prefix.startsWith("/")).toBe(true);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(entry.ownerTicket.trim().length).toBeGreaterThan(0);
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);
    }

    // A global exception surface (login, health, identity) is global by design and
    // must never receive a company/team selection on a stream URL either.
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    for (const entry of SCOPE_STREAM_ALLOWED_PATHS) {
      for (const method of methods) {
        for (const probe of [entry.prefix, `${entry.prefix}probe`]) {
          expect(matchGlobalException(method, probe)?.id ?? null).toBeNull();
        }
      }
    }
    for (const exception of GLOBAL_EXCEPTION_ENTRIES) {
      const base = exception.pattern.endsWith("/*")
        ? exception.pattern.slice(0, -2)
        : exception.pattern;
      if (!base.startsWith("/api")) continue;
      const covered = SCOPE_STREAM_ALLOWED_PATHS.some((allowed) =>
        base.startsWith(allowed.prefix),
      );
      expect({ exception: exception.id, covered }).toEqual({
        exception: exception.id,
        covered: false,
      });
    }
  });

  test("the pair never rides an unreviewed path, another origin, or a query-less personal URL", () => {
    expect(withStreamScope("/api/agents", ACME)).toBe("/api/agents");
    expect(withStreamScope("wss://api.x.ai/v1/realtime", ACME)).toBe(
      "wss://api.x.ai/v1/realtime",
    );
    expect(withStreamScope("//evil.example/api/workshop/x/events", ACME)).toBe(
      "//evil.example/api/workshop/x/events",
    );
    expect(withStreamScope("/api/workshop/ch-1/events", null)).toBe(
      "/api/workshop/ch-1/events",
    );
    // The workshop stream's own resume cursor rides the same URL; both survive.
    expect(
      withStreamScope("/api/workshop/ch-1/events?lastEventId=7", ACME),
    ).toBe(
      "/api/workshop/ch-1/events?lastEventId=7" +
        "&x-openbot-tenant=acme&x-openbot-workspace=acme-finance",
    );
  });
});
