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
import type {
  RunDetailResult,
  RunUsageReport,
} from "../../shared/ai-observability-runs";
import { ObservationRunDetailPage } from "../src/components/ai-observability/run-detail";
// English copy: the i18n bundles initialize on import, so assertions see real sentences.
import "@/lib/i18n";

/*
 * Issue #19 — the creator's run detail, mounted at /bots/$agentId/runs/$bindingId.
 *
 * What these cases pin, in acceptance order:
 *   1. the page answers the T11 detail contract in full — state, duration, token usage,
 *      references, projected metadata and freshness — with every missing fact named as
 *      unavailable, never as zero or a guess;
 *   2. the availability block states the coverage verdict, the upstream binding status
 *      (linked / still syncing / outside the window) and why, each in its own words;
 *   3. the creator guard: a management refusal says forbidden, a run this scope did not
 *      bind says not found, and the two sentences never borrow each other's words;
 *   4. loading and fault conditions keep the T02 vocabulary: disabled, forbidden,
 *      notFound and unavailable are four different answers;
 *   5. upstream content renders as text only — a <script> in projected metadata is data,
 *      not code, and nothing outside the projection is shown;
 *   6. the step section renders T18's step tree for a detailed run — the placeholder
 *      sentence is gone and the recorded timeline stands in its place.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  /*
   * The steps query (T18) commits its render one beat after the facts these tests await,
   * so a test that ends on a detail-level sentence leaves React's scheduler with a pending
   * flush. Yield once before unmounting so that flush drains while the DOM registrar's
   * window still exists — otherwise it fires after unregister and crashes on window.event.
   */
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let detailHandler: () => Response = () => Response.json(detailBody());
/*
 * T18: the step tree rides its own query on the same run, so the page's regression
 * harness answers it — a timeline with one step of each kind by default.
 */
const stepsHandler: () => Response = () =>
  Response.json({
    steps: [
      {
        kind: "model",
        spanId: "s1",
        parentSpanId: null,
        name: "gpt-x",
        state: "completed",
        startedAt: "2026-10-16T09:30:05.000Z",
        endedAt: "2026-10-16T09:30:08.000Z",
      },
      {
        kind: "tool",
        spanId: "s2",
        parentSpanId: "s1",
        name: "search_knowledge",
        state: "completed",
        executionState: "executed",
        startedAt: "2026-10-16T09:30:08.000Z",
        endedAt: "2026-10-16T09:30:09.000Z",
        output: { state: "projected", value: "found 3 chunks" },
      },
    ],
  });

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
  detailHandler = () => Response.json(detailBody());
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      if (url === "/api/me") return Response.json({ user: ME });
      if (url.startsWith("/api/agents/agent-1"))
        return Response.json({ agent: PROFILE });
      if (url === "/api/ai-observability/bots/agent-1/runs/run-9")
        return detailHandler();
      if (url === "/api/ai-observability/bots/agent-1/runs/run-9/steps")
        return stepsHandler();
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

const PROVIDER_USAGE: Extract<RunUsageReport, { source: "provider" }> = {
  source: "provider",
  promptTokens: 10,
  completionTokens: 20,
  totalTokens: 30,
};

/** The present variant on its own, so a spread keeps the narrowed type. */
function presentUpstream(): Extract<
  RunDetailResult["upstream"],
  { status: "present" }
> {
  return {
    status: "present",
    opikTraceId: "trace-9",
    state: "failed",
    createdAt: "2026-10-16T09:30:05.000Z",
    durationMs: 21_860,
    usage: PROVIDER_USAGE,
    capability: "detailed",
    metadata: {
      model: { state: "projected", value: "gpt-x" },
      deployment_version: { state: "projected", value: "v42" },
    },
  };
}

function detailBody(overrides: Partial<RunDetailResult> = {}): RunDetailResult {
  return {
    run: {
      runId: "run-9",
      attemptId: "attempt-2",
      traceId: "trace-7",
      opikTraceId: "trace-9",
      capability: "detailed",
      state: "failed",
      createdAt: "2026-10-16T09:30:00.000Z",
      updatedAt: "2026-10-16T09:31:00.000Z",
      expiresAt: "2026-11-16T09:31:00.000Z",
    },
    upstream: presentUpstream(),
    ...overrides,
  };
}

/*
 * The page body in a router of two real paths — the detail and the list it links back to —
 * rather than the generated tree, whose _authed layout mounts the CopilotKit runtime the
 * detail page has nothing to say to (same reason as the run-list tests).
 */
function draw(initial = "/bots/agent-1/runs/run-9") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId/runs",
    component: () => null,
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId/runs/$bindingId",
    component: function TestRunDetailPage() {
      const { agentId, bindingId } = detailRoute.useParams();
      return (
        <ObservationRunDetailPage agentId={agentId} bindingId={bindingId} />
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, ...view };
}

/** Facts are laid out as label-and-value rows, so they are read off the page text. */
function pageText(view: { container: HTMLElement }) {
  return view.container.textContent ?? "";
}

describe("the detail answers the full T11 contract (acceptance 1)", () => {
  test("a present upstream record shows state, times, duration, usage, references and metadata", async () => {
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("21.9 s"));
    // State and capability verdict.
    expect(pageText(view)).toContain("Failed");
    expect(pageText(view)).toContain("Detailed coverage");
    // Times: started (upstream), recorded/updated (local), retained-until.
    expect(pageText(view)).toMatch(/10\/16\/2026/);
    // Usage: total plus the split, never only a total.
    expect(pageText(view)).toContain("30 tokens");
    expect(pageText(view)).toContain("Prompt 10 · Completion 20");
    // References: local run/attempt/trace and the upstream trace binding.
    for (const id of ["run-9", "attempt-2", "trace-7", "trace-9"]) {
      expect(pageText(view)).toContain(id);
    }
    // Projected metadata, including the version reference.
    expect(pageText(view)).toContain("gpt-x");
    expect(pageText(view)).toContain("v42");
  });

  test("every missing fact is named unavailable, never zero", async () => {
    detailHandler = () =>
      Response.json(
        detailBody({
          run: { ...detailBody().run, capability: "unavailable" },
          upstream: {
            status: "present",
            opikTraceId: "trace-9",
            state: "unknown",
            createdAt: "unavailable",
            durationMs: "unavailable",
            usage: { source: "unavailable" },
            capability: "unavailable",
            metadata: {},
          },
        }),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("Time unavailable"));
    expect(pageText(view)).toContain("Duration unavailable");
    expect(pageText(view)).toContain("Tokens unavailable");
    expect(pageText(view)).toContain("Coverage unavailable");
    // The value is the unavailable word, not a count — the explanation beside it is the
    // sentence that says unavailable is not zero ("not counted as 0 tokens").
  });

  test("a state this build cannot name fails closed as unknown, keeping every other fact (Q-M1b)", async () => {
    // A newer server may already speak a state the vocabulary has never heard of. The
    // page answers with its own fail-closed word — never a crash, never a guess.
    detailHandler = () =>
      Response.json({
        ...detailBody(),
        run: { ...detailBody().run, state: "escalated" },
      });
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("Unknown outcome"));
    // The unnamed state costs its fact, not the page: the contract's rest stays.
    expect(pageText(view)).toContain("21.9 s");
    expect(pageText(view)).toContain("30 tokens");
    expect(pageText(view)).not.toContain("Upstream unavailable");
  });
});

describe("the availability block states coverage, binding and freshness (acceptance 2)", () => {
  test("a linked record says so beside its freshness", async () => {
    const view = draw();
    await waitFor(() =>
      expect(pageText(view)).toContain(
        "Linked — the store holds this run's upstream record.",
      ),
    );
    // Freshness is the local row's last update, rendered as a datetime.
    expect(pageText(view)).toMatch(/Last update/);
  });

  test("an unreconciled record says still syncing and links no upstream trace", async () => {
    detailHandler = () =>
      Response.json(
        detailBody({
          run: {
            ...detailBody().run,
            opikTraceId: null,
            capability: "basic",
          },
          upstream: { status: "unreconciled" },
        }),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("Still syncing"));
    expect(pageText(view)).toContain("has not been confirmed upstream");
    expect(pageText(view)).toContain("Not linked yet");
    // Basic coverage is marked and explained, not silently downgraded.
    expect(pageText(view)).toContain("Basic coverage");
    expect(pageText(view)).toContain("Only what OpenBot itself observed");
    // No upstream fact is fabricated for a record the store never confirmed.
    expect(pageText(view)).not.toContain("21.9 s");
    expect(pageText(view)).not.toContain("30 tokens");
  });

  test("an absent record says outside the window but keeps its trace reference", async () => {
    detailHandler = () =>
      Response.json(detailBody({ upstream: { status: "absent" } }));
    const view = draw();
    await waitFor(() =>
      expect(pageText(view)).toContain("Record outside the recent window"),
    );
    expect(pageText(view)).toContain("only serves the most recent runs");
    expect(pageText(view)).toContain("trace-9");
    expect(pageText(view)).not.toContain("21.9 s");
  });
});

describe("the creator guard (acceptance 3)", () => {
  test("a management refusal says forbidden", async () => {
    detailHandler = () =>
      Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    const view = draw();
    await view.findByText("You cannot observe this Bot");
    expect(view.queryByText("No such run")).toBeNull();
  });

  test("a manage-gate 404 that refuses to name the Bot still says forbidden", async () => {
    detailHandler = () =>
      Response.json({ error: "OBSERVATION_BOT_NOT_FOUND" }, { status: 404 });
    const view = draw();
    await view.findByText("You cannot observe this Bot");
    expect(view.queryByText("No such run")).toBeNull();
  });

  test("a run this scope did not bind says not found, with the way back to the list", async () => {
    detailHandler = () =>
      Response.json({ error: "RUN_NOT_FOUND" }, { status: 404 });
    const view = draw() as ReturnType<typeof draw> & {
      router: { state: { location: { pathname: string } } };
    };
    await view.findByText("No such run");
    // Button-as-link: it navigates, but its accessible role is button.
    const back = view.getByRole("button", { name: "Back to run history" });
    expect(back.getAttribute("href")).toBe("/bots/agent-1/runs");
    const user = userEvent.setup({ document: view.container.ownerDocument });
    back.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe("/bots/agent-1/runs"),
    );
  });
});

describe("loading and fault conditions keep the T02 vocabulary (acceptance 4)", () => {
  test("a disabled deployment says disabled", async () => {
    detailHandler = () =>
      Response.json({ error: "capability_missing" }, { status: 503 });
    const view = draw();
    await view.findByText("Run tracing is off");
    expect(view.queryByText("No such run")).toBeNull();
  });

  test("an unreachable store says unavailable", async () => {
    detailHandler = () =>
      Response.json({ error: "OPIK_UNREACHABLE" }, { status: 503 });
    const view = draw();
    await view.findByText("Upstream unavailable");
  });

  test("a malformed success body is the unavailable fault, never a rendered page", async () => {
    detailHandler = () => Response.json({ run: { runId: 42 } });
    const view = draw();
    await view.findByText("Upstream unavailable");
  });

  test("a present status without the upstream payload is the unavailable fault, never a crash (Q-M1a)", async () => {
    // "present" is the promise that the record rides along; a 200 that breaks it — here
    // by skipping metadata — is the store failing to answer, not a page that crashes
    // halfway through rendering.
    detailHandler = () =>
      Response.json({
        ...detailBody(),
        upstream: {
          status: "present",
          opikTraceId: "trace-9",
          state: "failed",
          createdAt: "2026-10-16T09:30:05.000Z",
          durationMs: 21_860,
          usage: PROVIDER_USAGE,
          capability: "detailed",
        },
      });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("21.9 s")).toBeNull();
  });
});

describe("the present branch keeps its per-value promises (OCR round 2 R2-06/R2-07)", () => {
  test("a present upstream whose metadata holds a broken entry says unavailable, never a crash", async () => {
    // The detail page feeds each metadata entry to projectedValueText, which switches
    // on value.state — a null entry used to pass the present-branch guard ("an object")
    // and crash mid-render. The present branch now validates entries per value.
    const broken = {
      ...presentUpstream(),
      metadata: { model: null },
    } as unknown as Extract<RunDetailResult["upstream"], { status: "present" }>;
    detailHandler = () => Response.json(detailBody({ upstream: broken }));
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("21.9 s")).toBeNull();
  });

  test("a present upstream whose usage lost its provider numbers says unavailable (OCR round 2 R2-06/R2-07)", async () => {
    const broken = {
      ...presentUpstream(),
      usage: { source: "provider" } as RunUsageReport,
    } as unknown as Extract<RunDetailResult["upstream"], { status: "present" }>;
    detailHandler = () => Response.json(detailBody({ upstream: broken }));
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("30 tokens")).toBeNull();
  });
});

/*
 * OCR round 3 (R3-13): the detail guard used to stop before the two fields the page
 * actually reads for its coverage verdict — capability and opikTraceId — so a 200 that
 * dropped them half-drew the page: `capability.${undefined}` echoed a literal i18n key
 * and the steps section's two gates (basic / unavailable) let undefined through, firing
 * a steps query for a report the binding never adjudicated. The guard now claims both
 * fields, so an unadjudicated report is the unavailable fault and never asks the store
 * for a timeline.
 */
describe("the detail guard claims the fields the page reads (OCR round 3, R3-13)", () => {
  test("a run that lost its capability is unavailable, not a literal key beside a steps query", async () => {
    const body = detailBody();
    const { capability: _dropped, ...unadjudicated } = body.run;
    detailHandler = () => Response.json({ ...body, run: unadjudicated });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("Detailed coverage")).toBeNull();
    expect(pageText(view)).not.toContain("capability.");
  });

  test("a coverage word this build cannot name is not a verdict to draw", async () => {
    detailHandler = () =>
      Response.json({
        ...detailBody(),
        run: { ...detailBody().run, capability: "partial" as never },
      });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(pageText(view)).not.toContain("capability.partial");
  });

  test("an opikTraceId that is neither a string nor null is the store failing", async () => {
    detailHandler = () =>
      Response.json({
        ...detailBody(),
        run: { ...detailBody().run, opikTraceId: 42 as never },
      });
    const view = draw();
    await view.findByText("Upstream unavailable");
  });
});

describe("upstream content is projected text, never code (acceptance 5)", () => {
  test("a script payload in metadata renders as literal text", async () => {
    detailHandler = () =>
      Response.json(
        detailBody({
          upstream: {
            ...presentUpstream(),
            metadata: {
              model: {
                state: "projected",
                value: "<script>alert(1)</script>",
              },
            },
          },
        }),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("alert(1)"));
    expect(pageText(view)).toContain("<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
  });

  test("omitted and truncated metadata are visible facts, not silent absences", async () => {
    detailHandler = () =>
      Response.json(
        detailBody({
          upstream: {
            ...presentUpstream(),
            metadata: {
              model: { state: "omitted", reason: "internal_capability" },
              provider: {
                state: "truncated",
                value: "prov",
                originalBytes: 99,
              },
            },
          },
        }),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("Omitted"));
    expect(pageText(view)).toContain("Truncated");
    expect(pageText(view)).toContain("prov");
  });

  test("a record with no projected metadata says so", async () => {
    detailHandler = () =>
      Response.json(
        detailBody({
          upstream: { ...presentUpstream(), metadata: {} },
        }),
      );
    const view = draw();
    await waitFor(() =>
      expect(pageText(view)).toContain(
        "No metadata was projected for this run.",
      ),
    );
  });
});

describe("the step section renders the step tree (acceptance 6, T18)", () => {
  test("a detailed run shows its recorded steps in place of the old placeholder", async () => {
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("gpt-x"));
    // The T13 placeholder sentence is gone; the recorded timeline stands in its place.
    expect(pageText(view)).not.toContain("The step timeline will render here");
    expect(pageText(view)).toContain("search_knowledge");
    expect(pageText(view)).toContain("found 3 chunks");
  });
});
