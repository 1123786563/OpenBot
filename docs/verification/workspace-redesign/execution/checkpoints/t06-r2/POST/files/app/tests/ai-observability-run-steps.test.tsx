import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  RunDetailResult,
  RunStep,
  RunUsageReport,
} from "../../shared/ai-observability-runs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { ObservationRunDetailPage } from "../src/components/ai-observability/run-detail";
// English copy: the i18n bundles initialize on import, so assertions see real sentences.
import "@/lib/i18n";

/*
 * Issue #24 — the step tree on the creator's run detail.
 *
 * What these cases pin, in acceptance order:
 *   1. a detailed run with an upstream record renders its steps — model calls, tool calls
 *      and retrievals — as a tree whose order is the recorded chronology and whose nesting
 *      is the recorded parentage (a dangling parent nests at the root, never vanishes);
 *   2. tool steps render T15's three-way determination in its own words — proposed,
 *      executed, unobserved — and the terminal state stays in states.* vocabulary; a step
 *      not observed as executed is never rendered as success, even if a body claims it;
 *   3. retrieval steps show the query and the hit summary along T15's retrieval seam shape;
 *   4. missing or malformed data fails closed through the T13 vocabulary — the section
 *      answers unavailable/disabled/forbidden/notFound, the page's other facts stay, and
 *      nothing crashes or gets invented;
 *   5. upstream content renders as text only;
 *   6. basic and unverified coverage do not query at all: internal steps that were never
 *      recorded are not drawn, and their absence is not read as evidence of nothing.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let detailHandler: () => Response = () => Response.json(detailBody());
let stepsHandler: () => Response = () => Response.json(stepsBody());
let stepsCalls = 0;

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
  stepsHandler = () => Response.json(stepsBody());
  stepsCalls = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      if (url === "/api/me") return Response.json({ user: ME });
      if (url.startsWith("/api/agents/agent-1"))
        return Response.json({ agent: PROFILE });
      if (url === "/api/ai-observability/bots/agent-1/runs/run-9")
        return detailHandler();
      if (url === "/api/ai-observability/bots/agent-1/runs/run-9/steps") {
        stepsCalls += 1;
        return stepsHandler();
      }
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
    metadata: {},
  };
}

/** The whole timeline in one body: every kind, every determination, one dangling parent. */
function step(overrides: Partial<RunStep> & Pick<RunStep, "spanId">): RunStep {
  return {
    kind: "tool",
    parentSpanId: null,
    name: null,
    state: "unknown",
    startedAt: "2026-10-16T09:30:10.000Z",
    endedAt: "2026-10-16T09:30:11.000Z",
    ...overrides,
  };
}

function stepsBody(steps: readonly RunStep[] = defaultSteps()): {
  steps: readonly RunStep[];
} {
  return { steps };
}

function defaultSteps(): readonly RunStep[] {
  return [
    step({
      kind: "model",
      spanId: "s1",
      name: "gpt-x",
      state: "completed",
      startedAt: "2026-10-16T09:30:05.000Z",
      endedAt: "2026-10-16T09:30:08.000Z",
      output: { state: "projected", value: "Planning the expense review." },
    }),
    step({
      spanId: "s2",
      parentSpanId: "s1",
      name: "search_knowledge",
      state: "completed",
      executionState: "executed",
      startedAt: "2026-10-16T09:30:08.000Z",
      endedAt: "2026-10-16T09:30:09.000Z",
      output: { state: "projected", value: "found 3 chunks" },
    }),
    step({
      kind: "retrieval",
      spanId: "s3",
      parentSpanId: "s1",
      state: "completed",
      startedAt: "2026-10-16T09:30:08.100Z",
      endedAt: "2026-10-16T09:30:08.900Z",
      input: { state: "projected", value: "receipts policy" },
      retrieval: { outcome: "hit", fragmentCount: 3, kbIds: ["kb-1", "kb-2"] },
    }),
    step({
      spanId: "s4",
      name: "ask_human",
      state: "unknown",
      executionState: "proposed",
      startedAt: "2026-10-16T09:30:09.000Z",
      endedAt: "2026-10-16T09:30:09.500Z",
    }),
    // A parent this body never carried: the step keeps its place as a root, never vanishes.
    step({
      spanId: "s5",
      parentSpanId: "s9-missing",
      name: "orphan_tool",
      state: "unknown",
      executionState: "unobserved",
      startedAt: "2026-10-16T09:30:10.000Z",
      endedAt: "2026-10-16T09:30:10.200Z",
    }),
  ];
}

/*
 * The page body in a router of two real paths, exactly like the run-detail tests: the
 * generated tree's _authed layout mounts a runtime this page has nothing to say to.
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
  return view;
}

function pageText(view: { container: HTMLElement }) {
  return view.container.textContent ?? "";
}

/** Step rows carry their span id so nesting can be asserted structurally. */
function stepNode(view: { container: HTMLElement }, spanId: string) {
  return view.container.querySelector(`[data-step="${spanId}"]`);
}

describe("the step tree answers the recorded chronology (acceptance 1)", () => {
  test("model, tool and retrieval steps all render, ordered by start time", async () => {
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("gpt-x"));
    const text = pageText(view);
    // Recorded order: the model span opens the run, the tool and retrieval nest under it,
    // the proposal and the orphan follow. The page reads in that order.
    const order = [
      "gpt-x",
      "search_knowledge",
      "receipts policy",
      "ask_human",
      "orphan_tool",
    ];
    let cursor = -1;
    for (const title of order) {
      const at = text.indexOf(title);
      expect(
        at,
        `${title} should appear after the previous step`,
      ).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("nesting follows the recorded parentage; a dangling parent nests at the root", async () => {
    const view = draw();
    await waitFor(() => expect(stepNode(view, "s1")).not.toBeNull());
    // Children render inside their parent's node.
    const parent = stepNode(view, "s1");
    expect(parent?.contains(stepNode(view, "s2"))).toBe(true);
    expect(parent?.contains(stepNode(view, "s3"))).toBe(true);
    // A parent the body never carried keeps the step at the root, not dropped.
    const orphan = stepNode(view, "s5");
    expect(orphan?.parentElement?.closest("[data-step]")).toBeNull();
  });

  test("a two-node cycle roots both steps, nesting under neither (T18-rev L-1)", async () => {
    stepsHandler = () =>
      Response.json(
        stepsBody([
          step({
            spanId: "cyc-a",
            parentSpanId: "cyc-b",
            name: "loop_one",
            startedAt: "2026-10-16T09:30:06.000Z",
            endedAt: "2026-10-16T09:30:07.000Z",
          }),
          step({
            spanId: "cyc-b",
            parentSpanId: "cyc-a",
            name: "loop_two",
            startedAt: "2026-10-16T09:30:07.000Z",
            endedAt: "2026-10-16T09:30:08.000Z",
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(stepNode(view, "cyc-a")).not.toBeNull());
    // The cycle roots both steps — neither nests under the other, neither is dropped.
    expect(
      stepNode(view, "cyc-a")?.parentElement?.closest("[data-step]"),
    ).toBeNull();
    expect(
      stepNode(view, "cyc-b")?.parentElement?.closest("[data-step]"),
    ).toBeNull();
    expect(stepNode(view, "cyc-a")?.contains(stepNode(view, "cyc-b"))).toBe(
      false,
    );
  });

  test("a child hanging off a cycle keeps its real parent (T18-rev L-1)", async () => {
    stepsHandler = () =>
      Response.json(
        stepsBody([
          step({
            spanId: "cyc-a",
            parentSpanId: "cyc-b",
            name: "loop_one",
            startedAt: "2026-10-16T09:30:06.000Z",
            endedAt: "2026-10-16T09:30:07.000Z",
          }),
          step({
            spanId: "cyc-b",
            parentSpanId: "cyc-a",
            name: "loop_two",
            startedAt: "2026-10-16T09:30:07.000Z",
            endedAt: "2026-10-16T09:30:08.000Z",
          }),
          step({
            spanId: "child-c",
            parentSpanId: "cyc-a",
            name: "real_child",
            state: "completed",
            executionState: "executed",
            startedAt: "2026-10-16T09:30:08.500Z",
            endedAt: "2026-10-16T09:30:09.000Z",
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(stepNode(view, "child-c")).not.toBeNull());
    // Only the broken ancestors root; the child still nests under its real parent.
    expect(stepNode(view, "cyc-a")?.contains(stepNode(view, "child-c"))).toBe(
      true,
    );
  });
});

describe("tool steps render T15's three-way determination (acceptance 2)", () => {
  test("an executed step says so beside its terminal state and result summary", async () => {
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("Executed here"));
    expect(pageText(view)).toContain("Completed");
    expect(pageText(view)).toContain("found 3 chunks");
  });

  test("a proposed step says proposed, and never renders success", async () => {
    const view = draw();
    await waitFor(() =>
      expect(pageText(view)).toContain("Proposed, not executed"),
    );
    const proposed = stepNode(view, "s4");
    expect(proposed?.textContent).toContain("Unknown outcome");
    expect(proposed?.textContent).not.toContain("Completed");
  });

  test("an unobserved step that claims completed is still rendered unknown (A3)", async () => {
    stepsHandler = () =>
      Response.json(
        stepsBody([
          step({
            spanId: "liar",
            name: "browser_tool",
            state: "completed",
            executionState: "unobserved",
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(stepNode(view, "liar")).not.toBeNull());
    const row = stepNode(view, "liar");
    // The invariant the recorder enforces is enforced at the read boundary too: only an
    // execution this deployment observed may render success.
    expect(row?.textContent).toContain("Execution unobserved");
    expect(row?.textContent).toContain("Unknown outcome");
    expect(row?.textContent).not.toContain("Completed");
  });

  test("a terminal state this build cannot name fails closed as unknown", async () => {
    stepsHandler = () =>
      Response.json(
        stepsBody([
          step({ spanId: "s-x", name: "weird", state: "escalated" as never }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(stepNode(view, "s-x")).not.toBeNull());
    const row = stepNode(view, "s-x");
    expect(row?.textContent).toContain("Unknown outcome");
    expect(row?.textContent).not.toContain("Completed");
  });

  test("a determination this build cannot name is coerced unobserved, never success (T18-rev L-2)", async () => {
    stepsHandler = () =>
      Response.json(
        stepsBody([
          step({
            spanId: "s-det",
            name: "weird_determination",
            state: "completed",
            executionState: "hallucinated" as never,
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(stepNode(view, "s-det")).not.toBeNull());
    const row = stepNode(view, "s-det");
    expect(row?.textContent).toContain("Execution unobserved");
    expect(row?.textContent).toContain("Unknown outcome");
    expect(row?.textContent).not.toContain("Completed");
  });

  test("a kind this build cannot name renders its locator, unnamed but present (T18-rev L-2)", async () => {
    stepsHandler = () =>
      Response.json(
        stepsBody([
          step({
            spanId: "span-locator-7",
            kind: "quantum" as never,
            name: null,
            state: "completed",
          }),
        ]),
      );
    const view = draw();
    await waitFor(() =>
      expect(stepNode(view, "span-locator-7")).not.toBeNull(),
    );
    // The span id is the title when neither name nor kind can be named; the row stays.
    expect(stepNode(view, "span-locator-7")?.textContent).toContain(
      "span-locator-7",
    );
  });

  test("an unnamed tool renders the kind word, not a blank title", async () => {
    stepsHandler = () =>
      Response.json(stepsBody([step({ spanId: "s-n", name: null })]));
    const view = draw();
    await waitFor(() => expect(stepNode(view, "s-n")).not.toBeNull());
    expect(stepNode(view, "s-n")?.textContent).toContain("Tool call");
  });
});

describe("retrieval steps show the query and the hit summary (acceptance 3)", () => {
  test("a hit shows the query, the fragment count and the knowledge bases", async () => {
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("receipts policy"));
    expect(pageText(view)).toContain("3 fragments");
    expect(pageText(view)).toContain("2 knowledge bases");
  });

  test("a miss says so beside its query", async () => {
    stepsHandler = () =>
      Response.json(
        stepsBody([
          step({
            kind: "retrieval",
            spanId: "s-m",
            state: "completed",
            input: { state: "projected", value: "void query" },
            retrieval: { outcome: "miss" },
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("void query"));
    expect(pageText(view)).toContain("No fragments returned");
  });

  test("a degraded retrieval shows its reason and fails", async () => {
    stepsHandler = () =>
      Response.json(
        stepsBody([
          step({
            kind: "retrieval",
            spanId: "s-d",
            state: "failed",
            input: { state: "projected", value: "slow query" },
            retrieval: { outcome: "degraded", reason: "upstream timeout" },
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("slow query"));
    expect(pageText(view)).toContain("Degraded: upstream timeout");
    expect(pageText(view)).toContain("Failed");
  });

  test("a truncated payload is a visible fact, not a silent cut", async () => {
    stepsHandler = () =>
      Response.json(
        stepsBody([
          step({
            spanId: "s-t",
            name: "big_tool",
            state: "completed",
            executionState: "executed",
            output: {
              state: "truncated",
              value: "partial",
              originalBytes: 99,
            },
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("partial"));
    expect(pageText(view)).toContain("Truncated");
    const disclosure = view
      .getByText("Show recorded content")
      .closest("details");
    expect(disclosure?.open).toBe(false);
    fireEvent.click(view.getByText("Show recorded content"));
    expect(disclosure?.open).toBe(true);
    expect(disclosure?.textContent).toContain("partial · Truncated");
  });
});

describe("missing and malformed data fails closed (acceptance 4)", () => {
  test("null and omitted payloads keep the step tree renderable without empty disclosures (P17)", async () => {
    stepsHandler = () =>
      Response.json(
        stepsBody([
          step({
            spanId: "null-payload",
            name: "null_payload",
            input: null,
            output: null,
          } as unknown as RunStep),
          step({
            spanId: "omitted-payload",
            name: "omitted_payload",
            input: { state: "omitted" },
            output: undefined,
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(stepNode(view, "null-payload")).not.toBeNull());
    expect(stepNode(view, "omitted-payload")).not.toBeNull();
    expect(view.queryAllByText("Show recorded content")).toHaveLength(0);
  });

  test("a malformed steps body is the unavailable fault, and the page keeps its facts", async () => {
    stepsHandler = () => Response.json({ steps: "no" });
    const view = draw();
    await waitFor(() =>
      expect(pageText(view)).toContain("Upstream unavailable"),
    );
    // The step fault costs its section, not the page.
    expect(pageText(view)).toContain("21.9 s");
    expect(pageText(view)).toContain("30 tokens");
  });

  test("a step missing its structural fields is the unavailable fault too", async () => {
    stepsHandler = () =>
      Response.json({
        steps: [{ kind: "tool", state: "completed" }],
      });
    const view = draw();
    await waitFor(() =>
      expect(pageText(view)).toContain("Upstream unavailable"),
    );
  });

  test("the steps fault vocabulary is the T13 one: disabled, forbidden, notFound", async () => {
    stepsHandler = () =>
      Response.json({ error: "capability_missing" }, { status: 503 });
    const first = draw();
    await waitFor(() =>
      expect(pageText(first)).toContain("Run tracing is off"),
    );

    stepsHandler = () =>
      Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    const second = draw();
    await waitFor(() =>
      expect(pageText(second)).toContain("You cannot observe this Bot"),
    );

    stepsHandler = () =>
      Response.json({ error: "RUN_NOT_FOUND" }, { status: 404 });
    const third = draw();
    await waitFor(() => expect(pageText(third)).toContain("No such run"));
  });

  test("upstream content is projected text, never code", async () => {
    stepsHandler = () =>
      Response.json(
        stepsBody([
          step({
            spanId: "s-s",
            name: "evil_tool",
            state: "completed",
            executionState: "executed",
            output: {
              state: "projected",
              value: "<script>alert(1)</script>",
            },
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("alert(1)"));
    expect(document.querySelector("script")).toBeNull();
  });

  test("a detailed run with no recorded steps says so, without claiming nothing happened", async () => {
    stepsHandler = () => Response.json(stepsBody([]));
    const view = draw();
    await waitFor(() =>
      expect(pageText(view)).toContain("No steps were recorded for this run."),
    );
  });
});

describe("coverage gates the query, not the rendering of guesses (acceptance 6)", () => {
  test("a basic run does not query and says internal steps are not visible", async () => {
    detailHandler = () =>
      Response.json(
        detailBody({
          run: { ...detailBody().run, capability: "basic" },
          upstream: { ...presentUpstream(), capability: "basic" },
        }),
      );
    const view = draw();
    await waitFor(() =>
      expect(pageText(view)).toContain(
        "Steps inside the remote Agent are not visible",
      ),
    );
    expect(pageText(view)).toContain("not evidence they did not happen");
    expect(stepsCalls).toBe(0);
  });

  test("an unverified coverage run does not query either", async () => {
    detailHandler = () =>
      Response.json(
        detailBody({
          run: { ...detailBody().run, capability: "unavailable" },
          upstream: { ...presentUpstream(), capability: "unavailable" },
        }),
      );
    const view = draw();
    await waitFor(() =>
      expect(pageText(view)).toContain("no step tree can be vouched for"),
    );
    expect(stepsCalls).toBe(0);
  });

  test("a still-syncing run mirrors the syncing word and does not query", async () => {
    detailHandler = () =>
      Response.json(detailBody({ upstream: { status: "unreconciled" } }));
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("Still syncing"));
    expect(stepsCalls).toBe(0);
  });

  test("an out-of-window record mirrors the absent word and does not query", async () => {
    detailHandler = () =>
      Response.json(detailBody({ upstream: { status: "absent" } }));
    const view = draw();
    await waitFor(() =>
      expect(pageText(view)).toContain("Record outside the recent window"),
    );
    expect(stepsCalls).toBe(0);
  });

  test("an unadjudicated report — a run without any capability — never queries (R3-13)", async () => {
    // The detail guard used to let a body whose run lost `capability` through, and the
    // section's two gates only named basic and unavailable: undefined passed both and
    // the store was asked for a timeline the coverage verdict never vouched for. The
    // guard now refuses the body, so the page answers unavailable and asks for nothing.
    const body = detailBody();
    const { capability: _dropped, ...unadjudicated } = body.run;
    detailHandler = () => Response.json({ ...body, run: unadjudicated });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(stepsCalls).toBe(0);
  });
});
