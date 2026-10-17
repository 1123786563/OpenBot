import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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
import type { AdminSummaryResult } from "../../shared/ai-observability-admin";
import { ObservationAdminSummaryPage } from "../src/components/ai-observability/admin-summary";
// English copy: the i18n bundles initialize on import, so assertions see real sentences.
import "@/lib/i18n";

/*
 * Issue #42 — the administrator's summary page, through the same ad-hoc router the runs
 * chain tests with (the generated tree's _authed layout drags in the CopilotKit runtime;
 * the full-tree guarantee — this URL sits under /_authed/admin, so a typed-in address
 * still walks the admin role guard — is pinned by ai-observability-routes.test.tsx).
 *
 * What these cases pin, in acceptance order:
 *   1. the page answers the T33 summary — per-Bot facts, collection health, drops, and
 *      every upstream-null number named unavailable rather than zero;
 *   2. the page consumes only the summary endpoint: a restricted admin role cannot be
 *      widened by anything the page itself fetches, and a refusal or store failure is an
 *      explicit sentence, never an empty list;
 *   3. the time filters refetch from the keyboard alone, and the facts wrap instead of
 *      overflowing on a narrow screen;
 *   4. fault, still-syncing and not-enabled stay three different answers;
 *   5. the T33-rev3 page-side notes are on screen: the upstream window the unbound and
 *      usage counts actually cover, and the one-Bot-at-a-time scope resolution.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  // Drain react-dom's scheduler queue before the globals go away: a commit still
  // scheduled when the last test ended would fire after unregister() and crash on
  // `window.event`, an artifact of teardown rather than anything the page did.
  await Bun.sleep(20);
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
const requested: string[] = [];
let summaryHandler: () => Response = () => Response.json(summaryBody([]));

beforeEach(() => {
  requested.length = 0;
  summaryHandler = () => Response.json(summaryBody([]));
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      requested.push(url);
      if (url.startsWith("/api/ai-observability/admin/summary"))
        return summaryHandler();
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function botSummary(
  botId: string,
  overrides: Partial<AdminSummaryResult["bots"][number]> = {},
): AdminSummaryResult["bots"][number] {
  return {
    botId,
    runs: {
      total: 12,
      byState: {
        running: 0,
        completed: 9,
        failed: 2,
        canceled: 1,
        interrupted: 0,
        unknown: 0,
      },
      pendingSync: 1,
      capabilities: { basic: 4, detailed: 8, unavailable: 0 },
      unboundUpstream: 3,
      usage: { providerReported: 10, unavailable: 2 },
    },
    experiments: { draft: 1, frozen: 2 },
    exports: {
      byState: { queued: 0, running: 0, completed: 1, failed: 1, cancelled: 0 },
      lastFailedErrorCode: "OPIK_TIMEOUT",
    },
    collection: { lastCollectedAt: "2026-10-16T09:41:00.000Z" },
    ...overrides,
  };
}

function summaryBody(
  bots: AdminSummaryResult["bots"],
  overrides: Partial<AdminSummaryResult> = {},
): AdminSummaryResult {
  return {
    window: { from: null, to: null, botId: null },
    collection: {
      readiness: { ready: true, reason: null },
      dropped: { queueFull: 2, notReady: 1 },
    },
    bots,
    botsTruncated: false,
    ...overrides,
  };
}

/*
 * The page body in a router of one real path, not the generated tree (its _authed layout
 * mounts the CopilotKit runtime an admin summary has nothing to say to).
 */
function draw(initial = "/admin/ai-observability") {
  // The production QueryClient's globals (retry and focus refetch both off) —
  // so a flip driven by visibilitychange here proves the page-level opt-in,
  // not a library default the shipped app never had.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
  const rootRoute = createRootRoute();
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin/ai-observability",
    component: ObservationAdminSummaryPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([adminRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Facts are joined into single description lines, so they are read off the page text. */
function pageText(view: { container: HTMLElement }) {
  return view.container.textContent ?? "";
}

describe("the scoped summary answers the real facts (acceptance 1)", () => {
  test("per-Bot facts, collection health and drops all render", async () => {
    summaryHandler = () => Response.json(summaryBody([botSummary("bot-1")]));
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("12 runs"));
    expect(pageText(view)).toContain("2 failed");
    expect(pageText(view)).toContain("1 pending sync");
    expect(pageText(view)).toMatch(/last collected \d{1,2}:\d{2} (AM|PM)/);
    expect(pageText(view)).toContain("3 unbound");
    expect(pageText(view)).toContain("10 usage reported");
    expect(pageText(view)).toContain("1 draft · 2 frozen experiments");
    expect(pageText(view)).toContain("1 completed · 1 failed");
    expect(pageText(view)).toContain("last failure OPIK_TIMEOUT");
    expect(pageText(view)).toContain("Collection healthy");
    expect(pageText(view)).toContain(
      "Dropped writes: 2 queue full · 1 not ready",
    );
  });

  test("a truncated answer says so, with the cap it hit", async () => {
    summaryHandler = () =>
      Response.json(
        summaryBody([botSummary("bot-1")], {
          botsTruncated: true,
          window: { from: null, to: null, botId: null },
        }),
      );
    const view = draw();
    await view.findByText("Scope truncated");
  });

  test("upstream-null counts are named unavailable, never zero", async () => {
    summaryHandler = () =>
      Response.json(
        summaryBody([
          botSummary("bot-1", {
            runs: {
              ...botSummary("bot-1").runs,
              unboundUpstream: null,
              usage: null,
            },
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("12 runs"));
    expect(pageText(view)).toContain("Upstream counts unavailable");
    // Unavailable is not zero: no "0 unbound" claim is rendered anywhere.
    expect(pageText(view)).not.toContain("0 unbound");
  });

  test("only the Bots the answer names are rendered", async () => {
    summaryHandler = () =>
      Response.json(summaryBody([botSummary("bot-1"), botSummary("bot-2")]));
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("bot-1"));
    expect(pageText(view)).toContain("bot-2");
    expect(pageText(view)).not.toContain("bot-3");
  });
});

describe("the page is no bypass around the API's scope (acceptance 1)", () => {
  test("the summary endpoint is the only thing the page asks", async () => {
    summaryHandler = () => Response.json(summaryBody([botSummary("bot-1")]));
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("bot-1"));
    // No per-Bot probe, no other observability surface: the page cannot widen what the
    // answer never named, because it fetches nothing but the scoped summary itself.
    const foreign = requested.filter(
      (url) =>
        url.startsWith("/api/") &&
        !url.startsWith("/api/ai-observability/admin/summary"),
    );
    expect(foreign).toEqual([]);
  });

  test("a management refusal says forbidden", async () => {
    summaryHandler = () =>
      Response.json({ error: "OBSERVATION_BOT_NOT_FOUND" }, { status: 403 });
    const view = draw();
    await view.findByText("Outside your scope");
    expect(view.queryByText("Nothing in scope")).toBeNull();
  });

  test("a store failure is an explicit error, never a silent empty list", async () => {
    // The T33-rev3 listBots minor, page side: a failed listing answers an error state,
    // not "no Bots in scope" — those are two different facts.
    summaryHandler = () => new Response(null, { status: 500 });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("Nothing in scope")).toBeNull();
  });

  test("a malformed success body is the unavailable fault", async () => {
    summaryHandler = () => Response.json({ bots: "no" });
    const view = draw();
    await view.findByText("Upstream unavailable");
  });

  test("a bot row that lost a nested count the row renders is the unavailable fault (OCR round 1 medium)", async () => {
    // The old per-bot guard stopped at `botId` and `runs.total`, so a row whose
    // `exports.byState` went missing passed the guard and crashed AdminBotRow
    // mid-render. The deeper guard answers the store's non-answer instead.
    summaryHandler = () =>
      Response.json(
        summaryBody([
          botSummary("bot-1", {
            exports:
              {} as unknown as AdminSummaryResult["bots"][number]["exports"],
          }),
        ]),
      );
    const view = draw();
    await view.findByText("Upstream unavailable");
  });

  test("a bot row whose byState lost the keys the page reads is the unavailable fault (OCR round 2 R2-05)", async () => {
    // isNumberRecord used to pass `{}` — "every value that exists is a number" — so a
    // body whose byState lost its keys reached formatNumber(bot.runs.byState.failed)
    // as undefined.toLocaleString. The guard now requires the page-read keys to exist.
    const base = botSummary("bot-1");
    summaryHandler = () =>
      Response.json(
        summaryBody([
          {
            ...base,
            runs: {
              ...base.runs,
              byState:
                {} as unknown as AdminSummaryResult["bots"][number]["runs"]["byState"],
            },
          },
        ]),
      );
    const view = draw();
    await view.findByText("Upstream unavailable");
  });

  test("the truncation notice names the cutoff, never a literal placeholder (OCR round 1 medium)", async () => {
    summaryHandler = () =>
      Response.json(
        summaryBody([botSummary("bot-1")], { botsTruncated: true }),
      );
    const view = draw();
    await view.findByText("Scope truncated");
    const text = pageText(view);
    expect(text).not.toContain("{{count}}");
    // One Bot in scope: the sentence shows that one, formatted.
    expect(text).toContain("This answer covers the first 1 Bots");
  });

  test("a role narrowed while the admin stays on the page reaches them on focus", async () => {
    // Spec A6, review Maj-2: this page has no poll and the app-wide QueryClient
    // turns focus refetch off, so the opt-in is the only production path a
    // narrowed role has to the person still looking — the tab regaining focus
    // re-asks, and the refusal replaces the page's wider answer.
    summaryHandler = () => Response.json(summaryBody([botSummary("bot-1")]));
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("bot-1"));
    summaryHandler = () =>
      Response.json({ error: "OBSERVATION_SCOPE_REFUSED" }, { status: 403 });
    window.dispatchEvent(new Event("visibilitychange"));
    await view.findByText("Outside your scope");
    expect(pageText(view)).not.toContain("bot-1");
  });
});

describe("filters, keyboard and narrow screens (acceptance 3)", () => {
  test("a time window refetches with the window in the query string, from the keyboard", async () => {
    summaryHandler = () => Response.json(summaryBody([botSummary("bot-1")]));
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("bot-1"));
    expect(requested[requested.length - 1].includes("timeFrom=")).toBeFalsy(); // "All time" asks for no window

    const user = userEvent.setup({ document: view.container.ownerDocument });
    const day = view.getByRole("button", { name: "Last 7 days" });
    day.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(requested[requested.length - 1]).toContain("timeFrom="),
    );
    expect(requested[requested.length - 1]).toContain("timeTo=");

    const all = view.getByRole("button", { name: "All time" });
    all.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(requested[requested.length - 1].includes("timeFrom=")).toBeFalsy(),
    );
  });

  test("each time filter asks for the span its label names", async () => {
    // Review Maj-1: the labels promised 24 hours / 7 days / 30 days while the
    // copied-over milliseconds answered 1 hour / 1 day / 7 days — a "Last 30
    // days" that silently summarized one week. The span sent is now asserted,
    // not just the parameter's presence.
    summaryHandler = () => Response.json(summaryBody([botSummary("bot-1")]));
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("bot-1"));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    for (const [label, span] of [
      ["Last 24 hours", 86_400_000],
      ["Last 7 days", 604_800_000],
      ["Last 30 days", 2_592_000_000],
    ] as const) {
      const chip = view.getByRole("button", { name: label });
      chip.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => {
        const url = requested[requested.length - 1];
        const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
        const from = params.get("timeFrom");
        const to = params.get("timeTo");
        expect(from).not.toBeNull();
        expect(to).not.toBeNull();
        // Resolved from the clock at fetch time: anything within seconds of
        // the named span is that span, not a neighbouring preset.
        expect(
          Math.abs(Date.parse(to ?? "") - Date.parse(from ?? "") - span),
        ).toBeLessThan(5_000);
      });
    }
  });

  test("the filter row and per-Bot facts wrap instead of overflowing", async () => {
    summaryHandler = () => Response.json(summaryBody([botSummary("bot-1")]));
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("bot-1"));
    // Narrow-screen contract, asserted at the class level: rows wrap, they do not clip.
    const wrapping = view.container.querySelectorAll(".flex-wrap");
    expect(wrapping.length).toBeGreaterThan(0);
  });
});

describe("fault, syncing and not-enabled stay three answers (acceptance 5)", () => {
  test("a disabled deployment says off — a configuration state — and the local counts still answer", async () => {
    summaryHandler = () =>
      Response.json(
        summaryBody(
          [
            botSummary("bot-1", {
              runs: {
                ...botSummary("bot-1").runs,
                unboundUpstream: null,
                usage: null,
              },
            }),
          ],
          {
            collection: {
              readiness: { ready: false, reason: "disabled" },
              dropped: { queueFull: 0, notReady: 1 },
            },
          },
        ),
      );
    const view = draw();
    await view.findByText("Observability is off");
    expect(pageText(view)).toContain("12 runs"); // local truth survives the disabled state
    expect(pageText(view)).toContain("Upstream counts unavailable");
    expect(pageText(view)).not.toContain("Collection healthy");
  });

  test("an unreachable store keeps its fault sentence while local counts answer", async () => {
    summaryHandler = () =>
      Response.json(
        summaryBody([botSummary("bot-1")], {
          collection: {
            readiness: { ready: false, reason: "unreachable" },
            dropped: { queueFull: 5, notReady: 0 },
          },
        }),
      );
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(pageText(view)).toContain("12 runs");
    expect(pageText(view)).toContain("Dropped writes: 5 queue full");
  });

  test("pending sync is its own sentence beside the facts", async () => {
    summaryHandler = () => Response.json(summaryBody([botSummary("bot-1")]));
    const view = draw();
    await view.findByText("Ingest lagging");
  });
});

describe("the T33-rev3 notes are on screen", () => {
  test("the upstream window the unbound and usage counts cover is explained", async () => {
    summaryHandler = () => Response.json(summaryBody([botSummary("bot-1")]));
    const view = draw();
    await waitFor(() =>
      expect(pageText(view)).toContain("most recent 100-trace window"),
    );
  });

  test("the one-Bot-at-a-time scope resolution is explained", async () => {
    summaryHandler = () => Response.json(summaryBody([botSummary("bot-1")]));
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("one Bot at a time"));
  });

  test("the retention defaults are stated", async () => {
    summaryHandler = () => Response.json(summaryBody([botSummary("bot-1")]));
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("7 days"));
  });
});
