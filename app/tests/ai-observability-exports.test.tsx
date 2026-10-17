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
import { cleanup, configure, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ExportJobListItem,
  ExportJobView,
} from "../../shared/ai-observability-admin";
import { ObservationExportsPage } from "../src/components/ai-observability/exports-status";
import { ObservationRunsPage } from "../src/components/ai-observability/runs-list";
// English copy: the i18n bundles initialize on import, so assertions see real sentences.
import "@/lib/i18n";

/*
 * Issue #42 — the creator's export status page, through the same ad-hoc router the runs
 * chain tests with (the generated tree's _authed layout drags in the CopilotKit runtime;
 * the full-tree guarantee — this URL sits under /_authed/_app, and the page's own data
 * query walks the manage gate on every load — is pinned by ai-observability-routes.test.tsx).
 *
 * What these cases pin, in acceptance order:
 *   1. a job answers its state, its rows and its times, and a finished job's file is
 *      downloadable from the keyboard alone;
 *   2. a permission change flips the page on the next poll — the running job's rows do
 *      not survive as stale cache beside the refusal;
 *   3. a directly typed URL to a Bot the caller cannot manage answers forbidden;
 *   4. fault, in-flight and not-enabled stay three different answers;
 *   5. a malformed body or a state word this build cannot name is the unavailable
 *      fault — never a crash, never rows of undefined;
 *   6. the runs page links here, so the page is not a dark address.
 */

beforeAll(() => GlobalRegistrator.register());
/*
 * The shared CI harness default (1s) flakes on a loaded host — the suite's own
 * machine regularly carries load averages in the dozens, where a render commit
 * can legitimately take seconds. A generous ceiling keeps these tests about
 * behavior, not wall-clock luck; RED/GREEN assertions are unaffected.
 */
configure({ asyncUtilTimeout: 10_000 });
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
let exportsHandler: () => Response = () =>
  Response.json({ jobs: [job({ state: "queued" })] });
let detailHandler: () => Response = () => new Response(null, { status: 404 });

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
  exportsHandler = () => Response.json({ jobs: [job({ state: "queued" })] });
  detailHandler = () => new Response(null, { status: 404 });
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      requested.push(url);
      if (url === "/api/me") return Response.json({ user: ME });
      if (url.startsWith("/api/agents/agent-1"))
        return Response.json({ agent: PROFILE });
      // The list face is the bare path; the detail face is the artifactUrl a
      // completed row carries (R2-40's shape: the list never inlines the rows).
      if (url === "/api/ai-observability/bots/agent-1/exports")
        return exportsHandler();
      if (url.startsWith("/api/ai-observability/bots/agent-1/exports/"))
        return detailHandler();
      if (url.startsWith("/api/ai-observability/bots/agent-1/runs"))
        return Response.json({
          runs: [],
          pagination: {
            total: 0,
            window: 0,
            offset: 0,
            limit: 20,
            nextCursor: null,
          },
          syncing: false,
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

let jobCounter = 0;
function job(overrides: Partial<ExportJobListItem> = {}): ExportJobListItem {
  jobCounter += 1;
  const jobId = `job-${jobCounter}`;
  const state = overrides.state ?? "completed";
  return {
    jobId,
    state,
    rowLimit: 1000,
    rowCount: 2,
    errorCode: null,
    redactionPolicyVersion: "opik-redaction/1",
    createdAt: "2026-10-16T09:30:00.000Z",
    settledAt: "2026-10-16T09:31:00.000Z",
    // The list names the artifact exactly when the job completed — R2-40's
    // shape, the one real wire the server answers with.
    ...(state === "completed"
      ? { artifactUrl: `/api/ai-observability/bots/agent-1/exports/${jobId}` }
      : {}),
    ...overrides,
  };
}

/** The rows only the detail endpoint carries — what a download must fetch back. */
const ARTIFACT_ROWS = [
  {
    opikTraceId: "trace-1",
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
  },
  {
    opikTraceId: "trace-2",
    state: "failed",
    createdAt: "2026-10-16T09:40:00.000Z",
    durationMs: "unavailable",
    usage: { source: "unavailable" },
    capability: "unavailable",
    metadata: {},
  },
] as const;

/** The detail endpoint's answer for a completed job: the rows ride here, only here. */
function detailAnswer(row: ExportJobListItem): { job: ExportJobView } {
  return {
    job: {
      jobId: row.jobId,
      state: "completed",
      rowLimit: row.rowLimit,
      rowCount: row.rowCount,
      errorCode: null,
      redactionPolicyVersion: row.redactionPolicyVersion,
      createdAt: row.createdAt,
      settledAt: row.settledAt,
      artifact: ARTIFACT_ROWS,
    },
  };
}

function draw(initial = "/bots/agent-1/exports", pollMs = 40) {
  // The production QueryClient's globals (retry and focus refetch both off) —
  // so a flip driven by visibilitychange here proves the page-level opt-in,
  // not a library default the shipped app never had (review Maj-2).
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
  const rootRoute = createRootRoute();
  const exportsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId/exports",
    component: function TestExportsPage() {
      const { agentId } = exportsRoute.useParams();
      return <ObservationExportsPage agentId={agentId} pollMs={pollMs} />;
    },
  });
  const runsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId/runs",
    component: function TestRunsPage() {
      const { agentId } = runsRoute.useParams();
      return <ObservationRunsPage agentId={agentId} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([exportsRoute, runsRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, ...view };
}

/** Row facts are joined into single description lines, so they are read off the page text. */
function pageText(view: { container: HTMLElement }) {
  return view.container.textContent ?? "";
}

describe("a job answers its state, rows, times and file (acceptance 2)", () => {
  test("a completed job's file downloads through the artifactUrl the list carries (R2fix F-1)", async () => {
    // R2-40 moved the rows off the list: a completed row now names the detail
    // endpoint in artifactUrl, and the download must fetch the bytes from there —
    // the old `job.artifact ?? []` read downloads an empty file on the real wire.
    const row = job();
    exportsHandler = () => Response.json({ jobs: [row] });
    detailHandler = () => Response.json(detailAnswer(row));
    const blobs: Blob[] = [];
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:mock";
    };
    URL.revokeObjectURL = () => {};
    try {
      const view = draw();
      const download = await view.findByRole("button", {
        name: "Download JSON",
      });
      const user = userEvent.setup({ document: view.container.ownerDocument });
      download.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(blobs.length).toBe(1));
      // The file went through the detail endpoint the list named — not a guess.
      expect(requested).toContain(
        "/api/ai-observability/bots/agent-1/exports/job-1",
      );
      // The file is the artifact the detail endpoint sent: the trace ids it carried.
      const text = await blobs[0].text();
      expect(text).toContain("trace-1");
      expect(text).toContain("trace-2");
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  }, 30_000);

  test("a download the manage gate refuses flips the page to the refusal it now is", async () => {
    const row = job();
    exportsHandler = () => Response.json({ jobs: [row] });
    detailHandler = () =>
      Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    const view = draw();
    await view.findByText("Ready to download");
    // The manage right ends before the click: both faces now answer the
    // refusal. The download hears it on the detail face, and the refetch it
    // triggers re-asks the list — the page must not keep the download button
    // alive beside the refusal.
    exportsHandler = () =>
      Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(view.getByRole("button", { name: "Download JSON" }));
    await view.findByText("Outside your scope");
    expect(pageText(view)).not.toContain("Ready to download");
  }, 30_000);

  test("a detail answer that lost its artifact never downloads an empty file", async () => {
    const row = job();
    exportsHandler = () => Response.json({ jobs: [row] });
    detailHandler = () =>
      Response.json({ job: { ...row, artifact: undefined } });
    const blobs: Blob[] = [];
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:mock";
    };
    URL.revokeObjectURL = () => {};
    try {
      const view = draw();
      const user = userEvent.setup({ document: view.container.ownerDocument });
      await user.click(
        await view.findByRole("button", {
          name: "Download JSON",
        }),
      );
      // No file is saved: a body without the rows is not an empty export. The
      // detail request is observable, so wait for it before judging the blobs.
      await waitFor(() =>
        expect(requested).toEqual(expect.arrayContaining([row.artifactUrl])),
      );
      await Bun.sleep(300);
      expect(blobs).toEqual([]);
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  }, 30_000);

  test("rows answer state, rows and times", async () => {
    exportsHandler = () =>
      Response.json({
        jobs: [
          job({ state: "completed", rowCount: 500 }),
          job({
            state: "running",
            rowCount: null,
            settledAt: null,
            createdAt: "2026-10-16T08:00:00.000Z",
          }),
        ],
      });
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("500 of 1,000 rows"));
    expect(pageText(view)).toContain("Ready to download");
    expect(pageText(view)).toContain("Exporting");
    expect(pageText(view)).toContain("rows pending");
    expect(pageText(view)).toMatch(/settled \d{1,2}:\d{2} (AM|PM)/);
  });

  test("an empty list says no exports yet", async () => {
    exportsHandler = () => Response.json({ jobs: [] });
    const view = draw();
    await view.findByText("No exports yet");
  });
});

describe("a permission change flips the page, not the cache (acceptance 2)", () => {
  test("a revocation mid-flight answers forbidden with no stale rows", async () => {
    exportsHandler = () =>
      Response.json({
        jobs: [job({ state: "running", rowCount: null, settledAt: null })],
      });
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("Exporting"));
    // The manage right ends: the next answer is the refusal, and the page flips. In the
    // browser that next answer arrives on the in-flight poll or the tab regaining focus —
    // both real production paths now, this page opting into the focus refetch the
    // app-wide QueryClient turns off. Here the interval scheduler is inert because
    // react-query froze isServer at import, before happy-dom registered, so the focus
    // refetch stands in for the same reload.
    exportsHandler = () =>
      Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    window.dispatchEvent(new Event("visibilitychange"));
    await view.findByText("Outside your scope");
    expect(pageText(view)).not.toContain("Exporting");
  });

  test("a revocation after every job has settled still flips the page", async () => {
    // Review Maj-2's other half: with all jobs settled the poll closes, and a
    // focus refetch the shipped app had turned off left the download button
    // alive indefinitely. The tab returning to the foreground now re-asks, the
    // refusal replaces the data, and the file offer goes with it.
    exportsHandler = () => Response.json({ jobs: [job()] });
    const view = draw();
    await view.findByText("Ready to download");
    exportsHandler = () =>
      Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    window.dispatchEvent(new Event("visibilitychange"));
    await view.findByText("Outside your scope");
    expect(pageText(view)).not.toContain("Ready to download");
  });
});

describe("a directly typed URL cannot widen scope (acceptance 4)", () => {
  test("a Bot the caller cannot manage answers forbidden, not a list", async () => {
    exportsHandler = () =>
      Response.json({ error: "OBSERVATION_BOT_NOT_FOUND" }, { status: 404 });
    const view = draw();
    await view.findByText("Outside your scope");
    expect(view.queryByText("No exports yet")).toBeNull();
  });
});

describe("fault, in-flight and not-enabled stay three answers (acceptance 5)", () => {
  test("a failed job names its closed-vocabulary code", async () => {
    exportsHandler = () =>
      Response.json({
        jobs: [
          job({ state: "failed", errorCode: "OPIK_TIMEOUT", rowCount: null }),
        ],
      });
    const view = draw();
    await view.findByText("Failed");
    expect(pageText(view)).toContain(
      "The observability store was too slow to answer.",
    );
    // A terminal job never completes, so its rows are not "pending" — the pending
    // word is reserved for jobs that can still produce them (OCR round 1 medium).
    expect(pageText(view)).not.toContain("rows pending");
  });

  test("a capability-missing failure says the integration is off, not a fault", async () => {
    exportsHandler = () =>
      Response.json({
        jobs: [
          job({
            state: "failed",
            errorCode: "CAPABILITY_MISSING",
            rowCount: null,
          }),
        ],
      });
    const view = draw();
    await view.findByText("Failed");
    // The not-enabled sentence: a configuration state, in the reserved disabled words —
    // not the store-failure words a fault would get.
    expect(pageText(view)).toContain(
      "This is a configuration state, not a fault.",
    );
  });

  test("a store failure is the unavailable fault, never an empty list", async () => {
    exportsHandler = () => new Response(null, { status: 502 });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("No exports yet")).toBeNull();
  });
});

describe("a body this build cannot trust is the unavailable fault (acceptance 5)", () => {
  test("a completed row that lost its artifactUrl fails closed (R2fix F-1)", async () => {
    // The download's only route to the rows is the URL the list named; a
    // completed row without it is a body this page cannot act on — the
    // unavailable fault, never a download button that saves an empty file.
    const row = job();
    const withoutUrl = { ...row } as Record<string, unknown>;
    delete withoutUrl.artifactUrl;
    exportsHandler = () => Response.json({ jobs: [withoutUrl] });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(pageText(view)).not.toContain("Ready to download");
  }, 30_000);

  test("a state word this build has never heard of fails closed", async () => {
    exportsHandler = () =>
      Response.json({ jobs: [job({ state: "exploded" as never })] });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(pageText(view)).not.toContain("job-1");
  });

  test("a malformed success body never renders rows of undefined", async () => {
    exportsHandler = () => Response.json({ jobs: "no" });
    const view = draw();
    await view.findByText("Upstream unavailable");
  });
});

describe("the runs page links here", () => {
  test("the export status link navigates from the keyboard", async () => {
    const view = draw("/bots/agent-1/runs");
    // Base UI's Button renders its Link with role="button" — a button that navigates,
    // the same shape every settings row in the app uses for its chevron links.
    const link = await view.findByRole("button", { name: "Export status" });
    expect(link.getAttribute("href")).toBe("/bots/agent-1/exports");
    const user = userEvent.setup({ document: view.container.ownerDocument });
    link.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe("/bots/agent-1/exports"),
    );
  });
});
