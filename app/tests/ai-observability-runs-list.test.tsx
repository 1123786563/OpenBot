import "./preload";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "../../tests/support/bun-test-compat";
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
import type {
  RunSummary,
  RunsListResult,
} from "../../shared/ai-observability-runs";
import { ObservationRunsPage } from "../src/components/ai-observability/runs-list";
// English copy: the i18n bundles initialize on import, so assertions see real sentences.
import "@/lib/i18n";

/*
 * Issue #18 — the creator's run list, through the real route tree at /bots/$agentId/runs.
 *
 * What these cases pin, in acceptance order:
 *   1. rows answer the real state, time, duration, tokens and capability — with every
 *      missing fact named as unavailable, never as zero or a guess;
 *   2. the five screen conditions stay five different sentences: empty, disabled,
 *      forbidden, syncing and upstream-unavailable never borrow each other's words;
 *   3. filtering works from the keyboard and applies to the loaded page, and a row with a
 *      bound run id navigates to the detail route;
 *   4. upstream content renders as text only — a <script> in metadata is data, not code;
 *   5. the cursor paginates forward and back without leaving the page.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
const requested: string[] = [];
let runsHandler: (url: string) => Response | Promise<Response> = () =>
  Response.json(listBody([]));

const ME = {
  id: "me",
  email: "me@example.test",
  role: "user",
  onboarding: null,
};
const PROFILE = {
  id: "agent-1",
  name: "Expense Manager",
  title: "Finance",
  roleDescription: "Reviews receipts.",
  avatarSeed: "expense",
  visibility: "private",
  ownerUserId: "me",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

beforeEach(() => {
  requested.length = 0;
  runsHandler = () => Response.json(listBody([]));
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      requested.push(url);
      if (url === "/api/me") return Response.json({ user: ME });
      if (url.startsWith("/api/agents/agent-1"))
        return Response.json({ agent: PROFILE });
      if (url.startsWith("/api/ai-observability/bots/agent-1/runs"))
        return runsHandler(url);
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

let rowCounter = 0;
function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  rowCounter += 1;
  return {
    opikTraceId: `trace-${rowCounter}`,
    state: "completed",
    createdAt: "2026-10-16T09:30:00.000Z",
    durationMs: 21_860,
    usage: {
      source: "provider",
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    },
    capability: "basic",
    metadata: {},
    ...overrides,
  };
}

function listBody(
  runs: RunSummary[],
  overrides: Partial<RunsListResult> = {},
): RunsListResult {
  return {
    runs,
    pagination: {
      total: runs.length,
      window: runs.length,
      offset: 0,
      limit: 20,
      nextCursor: null,
    },
    syncing: false,
    ...overrides,
  };
}

/*
 * The page body in a router of two real paths — the list and the detail it links to —
 * rather than the generated tree, whose _authed layout mounts the CopilotKit runtime the
 * list has nothing to say to. The full-tree guarantees (the URL sits under /_authed, so a
 * typed-in address walks the session guard) are pinned by ai-observability-routes.test.tsx.
 */
function draw(initial = "/bots/agent-1/runs") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const runsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId/runs",
    component: function TestRunsPage() {
      const { agentId } = runsRoute.useParams();
      return <ObservationRunsPage agentId={agentId} />;
    },
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    // The real detail page (#19) reads params through its own route hook, which an
    // ad-hoc tree cannot satisfy — so the destination is asserted on the router's
    // location, and the body here stays empty.
    path: "/bots/$agentId/runs/$bindingId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([runsRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, ...view };
}

/** Row facts are joined into one description line, so they are read off the page text. */
function pageText(view: { container: HTMLElement }) {
  return view.container.textContent ?? "";
}

/** The router draw() built, for asserting where a link or a button took the person. */
type Drawn = ReturnType<typeof draw> & {
  router: { state: { location: { pathname: string } } };
};

describe("the run list answers the real facts (acceptance 1)", () => {
  test("a full row shows state, time, duration, tokens and capability", async () => {
    runsHandler = () =>
      Response.json(
        listBody([
          summary({
            metadata: { model: { state: "projected", value: "gpt-x" } },
          }),
        ]),
      );
    const view = draw();
    // The state word also names a filter chip, so the row is anchored on its own facts.
    await waitFor(() => expect(pageText(view)).toContain("21.9 s"));
    expect(pageText(view)).toMatch(/\d{1,2}:\d{2} (AM|PM)/); // start time, localized
    expect(pageText(view)).toContain("30 tokens");
    expect(pageText(view)).toContain("Basic coverage");
    expect(pageText(view)).toContain("gpt-x");
  });

  test("every missing fact is named unavailable, never zero", async () => {
    runsHandler = () =>
      Response.json(
        listBody([
          summary({
            state: "unknown",
            createdAt: "unavailable",
            durationMs: "unavailable",
            usage: { source: "unavailable" },
            capability: "unavailable",
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("Time unavailable"));
    expect(pageText(view)).toContain("Duration unavailable");
    expect(pageText(view)).toContain("Tokens unavailable");
    expect(pageText(view)).toContain("Coverage unavailable");
    // Unavailable is not zero: no "0" token claim is rendered anywhere.
    expect(pageText(view)).not.toContain("0 tokens");
  });

  test("a row whose state this build cannot name fails closed as unknown (Q-M1b)", async () => {
    runsHandler = () =>
      Response.json({
        ...listBody([]),
        runs: [
          { ...summary(), state: "escalated" },
          summary({ state: "completed", durationMs: 30_000 }),
        ],
      });
    const view = draw();
    // The row keeps its own facts — it renders, it does not crash.
    await waitFor(() => expect(pageText(view)).toContain("21.9 s"));
    expect(pageText(view)).toContain("30.0 s");
    // The unknown word is the row's title, not just the filter chip that always shows it.
    const rowTitle = view
      .getAllByText("Unknown outcome")
      .find((node) => node.tagName !== "BUTTON");
    expect(rowTitle).toBeTruthy();
  });
});

describe("a success body that lost its shape is the unavailable fault, never a crash (OCR round 1 medium)", () => {
  test("a row without its metadata SafeRecord says the store did not answer", async () => {
    // The row guard (OCR round 1 medium): the list envelope alone used to pass a row
    // that lost `metadata` through, and RunRow's `run.metadata.run_id` crashed the
    // render — the exact silently-broken page the module header promises never to
    // answer with. The whole list is the store's non-answer, so the page faults.
    runsHandler = () =>
      Response.json({
        ...listBody([]),
        runs: [{ ...summary(), metadata: undefined }],
      });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("21.9 s")).toBeNull();
  });

  test("a row whose usage lost its source says the store did not answer", async () => {
    runsHandler = () =>
      Response.json({
        ...listBody([]),
        runs: [
          summary({
            // `source: "provider"` without its counts is a promise the body breaks.
            usage: { source: "provider" } as unknown as RunSummary["usage"],
          }),
        ],
      });
    const view = draw();
    await view.findByText("Upstream unavailable");
  });

  test("a row whose capability speaks an unknown verdict says the store did not answer (R4-4)", async () => {
    // The list half of R3-13: the row's coverage cell renders `capability.<verdict>`
    // straight off the body, so an unknown word used to echo the raw key mid-list —
    // the exact half-drawn row the detail guard (R3-13) already refuses. The verdict
    // vocabulary is the binding table's closed set; a body carrying any other word
    // is contract drift, the store failing to answer, never a verdict to draw.
    runsHandler = () =>
      Response.json({
        ...listBody([]),
        runs: [
          summary({
            capability: "premium" as unknown as RunSummary["capability"],
          }),
        ],
      });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("21.9 s")).toBeNull();
  });

  test("a pagination whose range numbers are gone says the store did not answer", async () => {
    runsHandler = () =>
      Response.json({
        ...listBody([]),
        pagination: { ...listBody([]).pagination, offset: undefined },
      });
    const view = draw();
    await view.findByText("Upstream unavailable");
  });
});

describe("the five screen conditions stay five different sentences (acceptance 2)", () => {
  test("a truthful empty page says empty, with no syncing noise", async () => {
    runsHandler = () => Response.json(listBody([]));
    const view = draw();
    await view.findByText("No runs yet");
    expect(view.getByText(/has not recorded a run/)).toBeTruthy();
    expect(view.queryByText("Still syncing")).toBeNull();
    // An empty page draws no "0–0 of 0" range: there is no page to describe.
    expect(view.queryByText(/–\d+ of/)).toBeNull();
  });

  test("a disabled deployment says disabled, not empty", async () => {
    runsHandler = () =>
      Response.json({ error: "capability_missing" }, { status: 503 });
    const view = draw();
    await view.findByText("Run tracing is off");
    expect(view.queryByText("No runs yet")).toBeNull();
  });

  test("a management refusal says forbidden", async () => {
    runsHandler = () =>
      Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    const view = draw();
    await view.findByText("You cannot observe this Bot");
  });

  test("an unreachable store says unavailable, never an empty list", async () => {
    runsHandler = () =>
      Response.json({ error: "OPIK_UNREACHABLE" }, { status: 503 });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("No runs yet")).toBeNull();
  });

  test("a malformed success body is the unavailable fault, never a rendered page (L-2)", async () => {
    // A 200 whose body is not the list contract: key fields missing means the store
    // failed to answer — an explicit fault, not rows of undefined.
    runsHandler = () => Response.json({ runs: "no", pagination: null });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("No runs yet")).toBeNull();
  });

  test("a pagination object without a cursor is the unavailable fault, not a clickable Next (Q-L)", async () => {
    // nextCursor absent: a Next button that would fire an undefined cursor is a
    // promise the body cannot keep, so the malformed success is the store failing
    // to answer — not a page of rows that pages into a refusal.
    runsHandler = () =>
      Response.json({
        ...listBody([summary()]),
        pagination: { total: 1, window: 1, offset: 0, limit: 20 },
      });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("21.9 s")).toBeNull();
  });

  test("a still-syncing store says so beside the rows it does have", async () => {
    runsHandler = () => Response.json(listBody([summary()], { syncing: true }));
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("Still syncing"));
    expect(pageText(view)).toContain("21.9 s"); // the rows stay on screen
  });
});

describe("filtering and detail, keyboard-first (acceptance 3)", () => {
  test("state chips filter the loaded page from the keyboard alone", async () => {
    // The durations differ so each row owns a text no filter chip shares.
    runsHandler = () =>
      Response.json(
        listBody([
          summary({ state: "failed", durationMs: 21_860 }),
          summary({ state: "completed", durationMs: 30_000 }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("21.9 s"));
    expect(pageText(view)).toContain("30.0 s");

    const user = userEvent.setup({ document: view.container.ownerDocument });
    const failedChip = view.getByRole("button", { name: "Failed" });
    failedChip.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pageText(view)).not.toContain("30.0 s"));
    expect(pageText(view)).toContain("21.9 s");

    // And back: "All states" restores the page.
    const allChip = view.getByRole("button", { name: "All states" });
    allChip.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pageText(view)).toContain("30.0 s"));
  });

  test("a time filter keeps known-old rows out and never hides an undated row", async () => {
    runsHandler = () =>
      Response.json(
        listBody([
          summary({
            state: "failed",
            durationMs: 21_860,
            createdAt: new Date(Date.now() - 60_000).toISOString(),
          }),
          summary({
            state: "running",
            durationMs: 5_000,
            createdAt: "2020-01-01T00:00:00.000Z",
          }),
          summary({
            state: "unknown",
            durationMs: 1_000,
            createdAt: "unavailable",
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("5.0 s"));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const day = view.getByRole("button", { name: "Last 24 hours" });
    day.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pageText(view)).not.toContain("5.0 s"));
    expect(pageText(view)).toContain("1.0 s"); // the undated row stays
    expect(pageText(view)).toContain("21.9 s");
  });

  test("a filtered-empty page says the filters matched nothing, not that no runs exist", async () => {
    runsHandler = () =>
      Response.json(
        listBody([summary({ state: "completed", durationMs: 30_000 })]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("30.0 s"));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const failedChip = view.getByRole("button", { name: "Failed" });
    failedChip.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(pageText(view)).toContain(
        "No run on this page matches the filters.",
      ),
    );
    expect(pageText(view)).not.toContain("No runs yet");
  });

  test("a row with a bound run id links to its detail, and the keyboard can follow it", async () => {
    runsHandler = () =>
      Response.json(
        listBody([
          summary({
            state: "failed",
            metadata: { run_id: { state: "projected", value: "run-9" } },
          }),
          summary({ state: "completed", metadata: {} }),
        ]),
      );
    const view = draw() as Drawn;
    const link = await view.findByRole("link", { name: /Failed/ });
    expect(link.getAttribute("href")).toBe("/bots/agent-1/runs/run-9");
    // The unbound row makes no link it cannot keep.
    expect(
      view
        .getAllByRole("link")
        .filter((node) => node.getAttribute("href")?.includes("/runs/run-")),
    ).toHaveLength(1);

    const user = userEvent.setup({ document: view.container.ownerDocument });
    link.focus();
    await user.keyboard("{Enter}");
    // The keyboard lands on the detail URL; what it renders is #19's to say.
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        "/bots/agent-1/runs/run-9",
      ),
    );
  });
});

describe("upstream content is text, never code (acceptance 4)", () => {
  test("a script payload in metadata renders as literal text", async () => {
    runsHandler = () =>
      Response.json(
        listBody([
          summary({
            metadata: {
              model: { state: "projected", value: "<script>alert(1)</script>" },
            },
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("alert(1)"));
    expect(pageText(view)).toContain("<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
  });
});

describe("cursor pagination (acceptance 5, T06 semantics)", () => {
  test("next and previous page through cursors without leaving the screen", async () => {
    runsHandler = (url) => {
      const cursor = new URL(url, "http://openbot.test").searchParams.get(
        "cursor",
      );
      if (cursor === null)
        return Response.json(
          listBody([summary({ state: "failed" })], {
            pagination: {
              total: 5,
              window: 5,
              offset: 0,
              limit: 20,
              nextCursor: "cursor-2",
            },
          }),
        );
      return Response.json(
        listBody([summary({ state: "running", durationMs: 5_000 })], {
          pagination: {
            total: 5,
            window: 5,
            offset: 1,
            limit: 20,
            nextCursor: null,
          },
        }),
      );
    };
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("1–1 of 5"));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const next = view.getByRole("button", { name: "Next page" });
    next.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pageText(view)).toContain("5.0 s"));
    expect(
      requested.some(
        (url) => url.includes("/runs?") && url.includes("cursor=cursor-2"),
      ),
    ).toBeTruthy();
    expect(pageText(view)).toContain("2–2 of 5");

    const previous = view.getByRole("button", { name: "Previous page" });
    previous.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pageText(view)).toContain("1–1 of 5"));
  });

  test("a cursor the server rotated out (403) keeps the fault sentence and the way back to page one", async () => {
    runsHandler = (url) => {
      const cursor = new URL(url, "http://openbot.test").searchParams.get(
        "cursor",
      );
      if (cursor === null)
        return Response.json(
          listBody([summary({ state: "failed", durationMs: 21_860 })], {
            pagination: {
              total: 5,
              window: 5,
              offset: 0,
              limit: 20,
              nextCursor: "cursor-2",
            },
          }),
        );
      // A restart or an ownership epoch bump (T06) kills outstanding cursors
      // with 403 — mid-pagination, that is where the person is standing.
      return Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    };
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("21.9 s"));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const next = view.getByRole("button", { name: "Next page" });
    next.focus();
    await user.keyboard("{Enter}");
    await view.findByText("You cannot observe this Bot");
    // The way back is offered beside the refusal, not hidden behind it.
    const reset = view.getByRole("button", { name: "Back to the first page" });
    reset.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pageText(view)).toContain("21.9 s"));
    expect(pageText(view)).not.toContain("You cannot observe this Bot");
    expect(
      requested.filter((url) => url.includes("/runs?")).length,
    ).toBeGreaterThanOrEqual(3); // page one, the refused cursor, page one again
  });

  test("a gone cursor (410) lands on the unavailable sentence, with the same way back", async () => {
    runsHandler = (url) => {
      const cursor = new URL(url, "http://openbot.test").searchParams.get(
        "cursor",
      );
      if (cursor === null)
        return Response.json(
          listBody([summary({ state: "failed", durationMs: 21_860 })], {
            pagination: {
              total: 5,
              window: 5,
              offset: 0,
              limit: 20,
              nextCursor: "cursor-2",
            },
          }),
        );
      return new Response(null, { status: 410 });
    };
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("21.9 s"));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const next = view.getByRole("button", { name: "Next page" });
    next.focus();
    await user.keyboard("{Enter}");
    await view.findByText("Upstream unavailable");
    const reset = view.getByRole("button", { name: "Back to the first page" });
    reset.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pageText(view)).toContain("21.9 s"));
    expect(pageText(view)).not.toContain("Upstream unavailable");
  });

  test("a forward page still shows the previous rows while it loads, never a blank screen (OCR round 2 R2-12)", async () => {
    // The cursor is part of the query key, so a forward navigation used to make the
    // new query isPending — unmounting the whole page (filters, rows, pagination)
    // until the answer came back. keepPreviousData holds the last answer instead.
    runsHandler = (url) => {
      const cursor = new URL(url, "http://openbot.test").searchParams.get(
        "cursor",
      );
      if (cursor === null)
        return Response.json(
          listBody([summary({ state: "failed", durationMs: 21_860 })], {
            pagination: {
              total: 5,
              window: 5,
              offset: 0,
              limit: 20,
              nextCursor: "cursor-2",
            },
          }),
        );
      // Page two never answers within this test: the assertion is that page one's
      // rows stay on screen for as long as the fetch is in flight.
      return new Promise<Response>(() => {});
    };
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("1–1 of 5"));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const next = view.getByRole("button", { name: "Next page" });
    next.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(requested.some((url) => url.includes("cursor=cursor-2"))).toBe(
        true,
      ),
    );
    // The in-flight page must not blank the screen: page one is still drawn.
    expect(pageText(view)).toContain("1–1 of 5");
    expect(pageText(view)).toContain("21.9 s");
  });
});
