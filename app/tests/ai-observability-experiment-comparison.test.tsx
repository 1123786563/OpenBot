import "./preload";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
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
  ExperimentComparison,
  ExperimentResultsReport,
} from "../../shared/ai-observability-experiments";
import type { ExperimentComparisonSearch } from "../src/components/ai-observability/experiment-comparison";
import { ObservationExperimentComparisonPage } from "../src/components/ai-observability/experiment-comparison";
// English copy: the i18n bundles initialize on import, so assertions see real sentences.
import "@/lib/i18n";
import { queryClient } from "../src/query-client";

/*
 * Issue #37 — the creator's experiment comparison page: two experiments'
 * configurations side by side, the per-sample deltas over the shared frozen cases, and
 * the regressions that link back to both execution records.
 *
 * What these cases pin, in acceptance order:
 *   1. an addressed comparison renders both sides' own facts (state, effective
 *      samples, completion, usage, the server-minted result links), the frozen-field
 *      ledger with its blocking marks, the per-sample four-word directions, and the
 *      regression rows with the frozen case and both result links;
 *   2. an incompatible pair explains its blocking fields and shows no deltas, no
 *      regressions and no winner sentence;
 *   3. the page is addressed by its own selection form when the four ids are absent,
 *      drivable from the keyboard alone, and the URL it builds is the machine-readable
 *      face the read then consumes — asserted by name;
 *   4. the four fault answers — disabled, forbidden, notFound, unavailable — never
 *      borrow each other's sentences, and a manage-gate 404 renders forbidden;
 *   5. the machine-readable export carries the comparison the server answered, as JSON;
 *   6. upstream content renders as text only — a <script> in a witness is data.
 *
 * The endpoint is fetch-mocked: the comparison read is T29's mounted face, pinned in
 * shared/ai-observability-experiments.ts.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
const requested: { url: string; method: string }[] = [];
let comparisonHandler: () => Response = () => Response.json(comparisonBody());

const ME = {
  id: "me",
  email: "me@example.test",
  role: "user",
  onboarding: null,
};

const COMPARISON_URL =
  "/api/ai-observability/bots/agent-1/experiment-comparisons" +
  "?baselineExperimentId=exp-1&baselineExecutionId=exec-1" +
  "&candidateExperimentId=exp-2&candidateExecutionId=exec-2";

beforeEach(() => {
  requested.length = 0;
  comparisonHandler = () => Response.json(comparisonBody());
  queryClient.clear();
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      requested.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/me") return Response.json({ user: ME });
      if (url === COMPARISON_URL) return comparisonHandler();
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

const CONFIG_HASH = `e${"3".repeat(63)}`;
const RESULT_LINK_BASELINE =
  "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1";
const RESULT_LINK_CANDIDATE =
  "/api/ai-observability/bots/agent-1/experiments/exp-2/results/exec-2";

/** One side's T28 report, in the shape the shared contract pins. */
function reportBody(
  experimentId: string,
  executionId: string,
  overrides: Partial<ExperimentResultsReport> = {},
): ExperimentResultsReport {
  return {
    experimentId,
    executionId,
    resultLink: `/api/ai-observability/bots/agent-1/experiments/${experimentId}/results/${executionId}`,
    state: "completed",
    scorerVersion: "rules/1",
    execution: {
      id: executionId,
      state: "completed",
      errorCode: null,
      caseCount: 3,
      toolRejections: 0,
      experimentConfigHash: CONFIG_HASH,
      startedAt: "2026-10-16T10:00:00.000Z",
      settledAt: "2026-10-16T10:04:00.000Z",
      createdAt: "2026-10-16T09:59:00.000Z",
    },
    summary: {
      sampleBase: 3,
      scored: 3,
      executionFailed: 0,
      scoringFailed: 0,
      cancelled: 0,
      pendingReconciliation: 0,
      syncFailure: 0,
      inProgress: 0,
      meanScore: 1,
    },
    samples: [],
    ...overrides,
  };
}

function candidateReport(): ExperimentResultsReport {
  const base = reportBody("exp-2", "exec-2");
  return {
    ...base,
    summary: {
      ...base.summary,
      scored: 1,
      executionFailed: 1,
      pendingReconciliation: 1,
      meanScore: 0.5,
    },
  };
}

/**
 * A compatible comparison over three shared frozen cases: one dropped its score, one
 * failed terminally, and one is still awaiting reconciliation — the open sample that
 * must read "not comparable", never a regression.
 */
function comparisonBody(
  overrides: Partial<ExperimentComparison> = {},
): ExperimentComparison {
  return {
    baseline: {
      experimentId: "exp-1",
      executionId: "exec-1",
      resultLink: RESULT_LINK_BASELINE,
      report: reportBody("exp-1", "exec-1"),
      completionRate: 1,
      timing: {
        startedAt: "2026-10-16T10:00:00.000Z",
        settledAt: "2026-10-16T10:04:00.000Z",
        durationMs: 240_000,
      },
      usage: { reported: 3, missing: 0 },
    },
    candidate: {
      experimentId: "exp-2",
      executionId: "exec-2",
      resultLink: RESULT_LINK_CANDIDATE,
      report: candidateReport(),
      completionRate: 2 / 3,
      timing: {
        startedAt: "2026-10-16T11:00:00.000Z",
        settledAt: "2026-10-16T11:05:00.000Z",
        durationMs: 300_000,
      },
      usage: { reported: 1, missing: 2 },
    },
    compatibility: {
      compatible: true,
      fields: [
        {
          field: "datasetContentHash",
          baseline: `c${"0".repeat(63)}`,
          candidate: `c${"0".repeat(63)}`,
          equal: true,
          blocking: true,
        },
        {
          field: "judgeVersion",
          baseline: "rules/1",
          candidate: "rules/1",
          equal: true,
          blocking: true,
        },
        {
          field: "judgeConfig",
          baseline: `sha256:${"1".repeat(64)}`,
          candidate: `sha256:${"1".repeat(64)}`,
          equal: true,
          blocking: true,
        },
        {
          field: "readOnlyTools",
          baseline: '["search"]',
          candidate: '["search"]',
          equal: true,
          blocking: false,
        },
        {
          field: "modelName",
          baseline: "claude-sonnet-5",
          candidate: "claude-haiku-4-5",
          equal: false,
          blocking: false,
        },
        {
          field: "modelParameters",
          baseline: `sha256:${"2".repeat(64)}`,
          candidate: `sha256:${"3".repeat(64)}`,
          equal: false,
          blocking: false,
        },
        {
          field: "prompt",
          baseline: `sha256:${"4".repeat(64)}`,
          candidate: `sha256:${"4".repeat(64)}`,
          equal: true,
          blocking: false,
        },
        {
          field: "botConfig",
          baseline: `sha256:${"5".repeat(64)}`,
          candidate: `sha256:${"5".repeat(64)}`,
          equal: true,
          blocking: false,
        },
        {
          field: "toolFixtures",
          baseline: `sha256:${"6".repeat(64)}`,
          candidate: `sha256:${"6".repeat(64)}`,
          equal: true,
          blocking: false,
        },
      ],
    },
    deltas: {
      meanScore: { baseline: 1, candidate: 0.5, delta: -0.5 },
      perSample: [
        {
          index: 0,
          baseline: { class: "scored", score: 1 },
          candidate: { class: "scored", score: 0.5 },
          scoreDelta: -0.5,
          direction: "regressed",
        },
        {
          index: 1,
          baseline: { class: "scored", score: 1 },
          candidate: { class: "execution_failed", score: null },
          scoreDelta: null,
          direction: "regressed",
        },
        {
          index: 2,
          baseline: { class: "scored", score: 1 },
          candidate: { class: "pending_reconciliation", score: null },
          scoreDelta: null,
          direction: "incomparable",
        },
      ],
    },
    regressions: [
      {
        index: 0,
        case: {
          datasetVersionId: "version-1",
          contentHash: `c${"0".repeat(63)}`,
        },
        baseline: {
          class: "scored",
          score: 1,
          code: null,
          resultLink: RESULT_LINK_BASELINE,
        },
        candidate: {
          class: "scored",
          score: 0.5,
          code: null,
          resultLink: RESULT_LINK_CANDIDATE,
        },
      },
      {
        index: 1,
        case: {
          datasetVersionId: "version-1",
          contentHash: `c${"0".repeat(63)}`,
        },
        baseline: {
          class: "scored",
          score: 1,
          code: null,
          resultLink: RESULT_LINK_BASELINE,
        },
        candidate: {
          class: "execution_failed",
          score: null,
          code: "CASE_FAILED",
          resultLink: RESULT_LINK_CANDIDATE,
        },
      },
    ],
    ...overrides,
  };
}

/*
 * The page in a router of two real paths — the comparison route itself and the
 * evaluations page its back link names — rather than the generated tree, whose _authed
 * layout mounts the CopilotKit runtime the page has nothing to say to. The full-tree
 * guarantees (the URL sits under /_authed, so a typed-in address walks the session
 * guard) are pinned by ai-observability-routes.test.tsx.
 */
function draw(initial = "/bots/agent-1/evaluations/experiment-comparisons") {
  const rootRoute = createRootRoute();
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId/evaluations",
    component: function TestEvaluationsPage() {
      return null;
    },
  });
  const comparisonRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId/evaluations/experiment-comparisons",
    validateSearch: (search: Record<string, unknown>) => search,
    component: function TestComparisonPage() {
      const { agentId } = comparisonRoute.useParams();
      const search = comparisonRoute.useSearch() as ExperimentComparisonSearch;
      return (
        <ObservationExperimentComparisonPage
          agentId={agentId}
          search={search}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, comparisonRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, ...view };
}

/** Facts are joined into description lines, so they are read off the page text. */
function pageText(view: { container: HTMLElement }) {
  return view.container.textContent ?? "";
}

const ADDRESSED =
  "/bots/agent-1/evaluations/experiment-comparisons" +
  "?baselineExperimentId=exp-1&baselineExecutionId=exec-1" +
  "&candidateExperimentId=exp-2&candidateExecutionId=exec-2";

describe("an addressed comparison answers both sides and the ledger (acceptance 1)", () => {
  test("both sides' own facts, the field ledger, and the read's pinned URL", async () => {
    const view = draw(ADDRESSED);
    await waitFor(() =>
      expect(pageText(view)).toContain(
        "Comparable — the same frozen sample set",
      ),
    );
    // The read hit T29's mounted URL, with the four ids as query parameters.
    expect(
      requested.some(
        (entry) => entry.url === COMPARISON_URL && entry.method === "GET",
      ),
    ).toBe(true);

    // The two sides, each with its own facts and its server-minted result link.
    expect(pageText(view)).toContain("Baseline");
    expect(pageText(view)).toContain("Candidate");
    expect(pageText(view)).toContain("exp-1 · exec-1");
    expect(pageText(view)).toContain("exp-2 · exec-2");
    expect(pageText(view)).toContain("3 frozen cases");
    expect(pageText(view)).toContain("1 scored sample");
    expect(pageText(view)).toContain("100% settled");
    expect(pageText(view)).toContain("67% settled");
    expect(pageText(view)).toContain("Usage records: 1 reported · 2 missing");
    expect(pageText(view)).toContain("Ran for 240 s");
    expect(pageText(view)).toContain(RESULT_LINK_BASELINE);
    expect(pageText(view)).toContain(RESULT_LINK_CANDIDATE);

    // The ledger: differences shown, the blocking trio equal here.
    expect(pageText(view)).toContain("Same on both sides");
    expect(pageText(view)).toContain(
      "A configuration difference — shown, never blocking",
    );
    expect(pageText(view)).toContain("claude-sonnet-5 → claude-haiku-4-5");
    expect(pageText(view)).toContain("Judge version");
    expect(pageText(view)).toContain("Dataset content hash");
  });

  test("per-sample deltas speak the closed four-word vocabulary, regressions link both records", async () => {
    const view = draw(ADDRESSED);
    await waitFor(() =>
      expect(pageText(view)).toContain("Mean moved by -0.50"),
    );
    // The mean row: both means and the arithmetic difference.
    expect(pageText(view)).toContain("1.00");
    expect(pageText(view)).toContain("0.50");
    // The direction words, including the open sample's fail-closed verdict.
    expect(pageText(view)).toContain("Regressed");
    expect(pageText(view)).toContain("Not comparable");
    expect(pageText(view)).toContain("Δ -0.50");
    expect(pageText(view)).toContain(
      "No score delta — a missing score is not a zero.",
    );
    expect(pageText(view)).toContain("Execution failed");

    // The regression rows: the frozen case, the codes, both result links as anchors.
    const links = await view.findAllByRole("link");
    const hrefs = links.map((link) => link.getAttribute("href"));
    expect(hrefs).toContain(RESULT_LINK_BASELINE);
    expect(hrefs).toContain(RESULT_LINK_CANDIDATE);
    expect(pageText(view)).toContain("Case version-1 ·");
    expect(pageText(view)).toContain("CASE_FAILED");
    expect(pageText(view)).not.toContain("No sample regressed.");
  });

  test("no regressions says so as its own status", async () => {
    comparisonHandler = () =>
      Response.json(
        comparisonBody({
          deltas: {
            meanScore: { baseline: 1, candidate: 1, delta: 0 },
            perSample: [
              {
                index: 0,
                baseline: { class: "scored", score: 1 },
                candidate: { class: "scored", score: 1 },
                scoreDelta: 0,
                direction: "unchanged",
              },
            ],
          },
          regressions: [],
        }),
      );
    const view = draw(ADDRESSED);
    await waitFor(() =>
      expect(pageText(view)).toContain("No sample regressed."),
    );
    expect(pageText(view)).toContain("Unchanged");
  });

  test("a delta row names each side's judge fact when one exists (T27-rn L-3)", async () => {
    comparisonHandler = () => {
      const body = comparisonBody();
      return Response.json({
        ...body,
        baseline: {
          ...body.baseline,
          report: reportBody("exp-1", "exec-1", {
            samples: [
              {
                index: 0,
                class: "scored",
                score: 1,
                reason: { class: "scored", passed: 2, failed: 0, rules: [] },
                usage: null,
                judge: {
                  status: "scored",
                  score: 0.82,
                  rationale: "It agrees.",
                  scorerVersion: "judge/1",
                  entranceId: "main",
                  usage: null,
                },
                resultLink: RESULT_LINK_BASELINE,
              },
            ],
          }),
        },
        candidate: {
          ...body.candidate,
          report: reportBody("exp-2", "exec-2", {
            samples: [
              {
                index: 0,
                class: "scored",
                score: 0.5,
                reason: { class: "scored", passed: 1, failed: 1, rules: [] },
                usage: null,
                judge: {
                  status: "failed",
                  code: "JUDGE_CALL_FAILED",
                  message: "the judge provider call threw",
                },
                resultLink: RESULT_LINK_CANDIDATE,
              },
            ],
          }),
        },
      });
    };
    const view = draw(ADDRESSED);
    await waitFor(() =>
      expect(pageText(view)).toContain("Baseline Judge 0.82"),
    );
    expect(pageText(view)).toContain(
      "Candidate · Judge failed · JUDGE_CALL_FAILED",
    );
  });
});

describe("an incompatible pair explains itself and claims no winner (acceptance 3)", () => {
  test("the blocking fields are named, no deltas or regressions are shown", async () => {
    comparisonHandler = () =>
      Response.json(
        comparisonBody({
          compatibility: {
            compatible: false,
            fields: comparisonBody().compatibility.fields.map((entry) =>
              entry.field === "datasetContentHash"
                ? {
                    ...entry,
                    candidate: `d${"0".repeat(63)}`,
                    equal: false,
                  }
                : entry.field === "judgeVersion"
                  ? { ...entry, candidate: null, equal: false }
                  : entry,
            ),
          },
          deltas: null,
          regressions: null,
        }),
      );
    const view = draw(ADDRESSED);
    await waitFor(() =>
      expect(pageText(view)).toContain(
        "Not comparable — the blocking fields differ",
      ),
    );
    expect(pageText(view)).toContain("Blocks the comparison");
    // A withheld witness is its own fact: unknown, never assumed equal.
    expect(pageText(view)).toContain("Withheld — unknown, not equal");
    // No deltas, no regressions, nothing that reads as a verdict.
    expect(pageText(view)).not.toContain("Mean moved by");
    expect(pageText(view)).not.toContain("One row per shared frozen case");
    expect(pageText(view)).not.toContain("The samples that got worse");
    expect(pageText(view)).not.toContain("Regressed");
  });
});

describe("the page is addressed by its own selection form (acceptance 4)", () => {
  test("the four ids are typed and compared from the keyboard alone", async () => {
    const view = draw("/bots/agent-1/evaluations/experiment-comparisons");
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await view.findByLabelText("Baseline experiment id");
    const compare = await view.findByRole("button", { name: "Compare" });
    // Incomplete: the button refuses, its own sentence says why.
    expect((compare as HTMLButtonElement).disabled).toBe(true);
    expect(pageText(view)).toContain(
      "All four ids are needed before a comparison can be read.",
    );

    await user.type(view.getByLabelText("Baseline experiment id"), "exp-1");
    await user.type(view.getByLabelText("Baseline execution id"), "exec-1");
    await user.type(view.getByLabelText("Candidate experiment id"), "exp-2");
    await user.type(view.getByLabelText("Candidate execution id"), "exec-2");
    expect((compare as HTMLButtonElement).disabled).toBe(false);
    compare.focus();
    await user.keyboard("{Enter}");

    // The address the form built is the shareable, machine-readable URL — and the
    // read consumed exactly it.
    await waitFor(() =>
      expect(pageText(view)).toContain(
        "Comparable — the same frozen sample set",
      ),
    );
    expect(requested.some((entry) => entry.url === COMPARISON_URL)).toBe(true);
  });
});

describe("the fault answers stay distinct (acceptance 4)", () => {
  test("a disabled deployment says disabled, not empty", async () => {
    comparisonHandler = () =>
      Response.json({ error: "capability_missing" }, { status: 503 });
    const view = draw(ADDRESSED);
    await view.findByText("Evaluation is off");
  });

  test("a management refusal says forbidden", async () => {
    comparisonHandler = () =>
      Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    const view = draw(ADDRESSED);
    await view.findByText("You cannot run this experiment");
    expect(view.queryByText("No such experiment")).toBeNull();
  });

  test("a scope-local not-found says notFound, never borrowed forbidden words", async () => {
    comparisonHandler = () =>
      Response.json({ error: "RESULTS_EXPERIMENT_NOT_FOUND" }, { status: 404 });
    const view = draw(ADDRESSED);
    await view.findByText("No such experiment");
    expect(view.queryByText("You cannot run this experiment")).toBeNull();
  });

  test("a manage-gate 404 without a scope-local code is forbidden, not notFound", async () => {
    comparisonHandler = () =>
      Response.json({ error: "OBSERVATION_BOT_NOT_FOUND" }, { status: 404 });
    const view = draw(ADDRESSED);
    await view.findByText("You cannot run this experiment");
    expect(view.queryByText("No such experiment")).toBeNull();
  });

  test("an unreachable store says unavailable, and a broken 200 body too", async () => {
    comparisonHandler = () => new Response(null, { status: 502 });
    const view = draw(ADDRESSED);
    await view.findByText("Upstream unavailable");

    comparisonHandler = () => Response.json({});
    const broken = draw(ADDRESSED);
    await broken.findByText("Upstream unavailable");
  });

  test("a body that lost a shape the page indexes into says unavailable, never a crash (OCR round 1 medium)", async () => {
    // meanScore is read as three `.toFixed(2)` cells; a body without it used to pass
    // the envelope-only guard and crash MeanRow instead of answering.
    comparisonHandler = () =>
      Response.json({
        ...comparisonBody(),
        deltas: { perSample: [] },
      });
    const meanLess = draw(ADDRESSED);
    await meanLess.findByText("Upstream unavailable");
    meanLess.unmount();

    // The deltas section indexes each side's report samples by a delta's index, so a
    // report without its samples array crashes the map — the guard refuses it first.
    const withoutSamples = comparisonBody();
    const reportless = {
      ...withoutSamples,
      baseline: {
        ...withoutSamples.baseline,
        report: {},
      },
    };
    comparisonHandler = () => Response.json(reportless);
    const noSamples = draw(ADDRESSED);
    await noSamples.findByText("Upstream unavailable");
    noSamples.unmount();

    // A per-sample delta that lost one of its halves is the store failing too.
    comparisonHandler = () =>
      Response.json({
        ...comparisonBody(),
        deltas: {
          meanScore: { baseline: 1, candidate: 0.5, delta: 0.5 },
          perSample: [{ index: 0 }],
        },
      });
    const halfDelta = draw(ADDRESSED);
    await halfDelta.findByText("Upstream unavailable");
    halfDelta.unmount();
  });
});

describe("a side that lost a fact the page reads is the unavailable fault (OCR round 2, R2-08)", () => {
  test("a side without its completionRate/usage/timing/report.summary is unavailable, never NaN% or a crash", async () => {
    // SideRow reads side.completionRate*100, side.usage.reported/missing,
    // side.timing.durationMs and report.summary.{meanScore,sampleBase,scored}; the
    // round-1 guard stopped at report.samples, so a side missing the rest passed and
    // crashed SideRow (undefined.toFixed) and rendered NaN% — never again.
    const body = comparisonBody();
    comparisonHandler = () =>
      Response.json({
        ...body,
        baseline: {
          experimentId: body.baseline.experimentId,
          executionId: body.baseline.executionId,
          resultLink: body.baseline.resultLink,
          report: body.baseline.report,
        },
      });
    const view = draw(ADDRESSED);
    await view.findByText("Upstream unavailable");
    expect(pageText(view)).not.toContain("NaN");
  });

  test("a summary whose meanScore is gone is unavailable, never a mid-render TypeError", async () => {
    const body = comparisonBody();
    comparisonHandler = () =>
      Response.json({
        ...body,
        baseline: {
          ...body.baseline,
          report: {
            ...body.baseline.report,
            summary: {
              ...body.baseline.report.summary,
              meanScore: undefined,
            },
          },
        },
      });
    const view = draw(ADDRESSED);
    await view.findByText("Upstream unavailable");
    expect(pageText(view)).not.toContain("NaN");
  });

  test("an execution state word the build cannot name renders verbatim, never a raw i18n key", async () => {
    // A newer server's state word is a missing i18n sentence, not a key to echo: the
    // side shows its own word instead of `states.terminated` (R2-08/R2-09, same seam).
    const body = comparisonBody();
    comparisonHandler = () =>
      Response.json({
        ...body,
        baseline: {
          ...body.baseline,
          report: {
            ...body.baseline.report,
            execution: {
              ...body.baseline.report.execution,
              state: "terminated",
            },
          },
        },
      });
    const view = draw(ADDRESSED);
    await view.findByText("Download comparison (JSON)");
    const text = pageText(view);
    expect(text).toContain("terminated");
    expect(text).not.toContain("states.terminated");
  });
});

describe("a number the wire guard cannot tell from a real score renders as absence (OCR round 5, R5-1)", () => {
  /*
   * R2-08 finite-checked SideRow's own interpolations; the other numeric render
   * points in this file — MeanRow's three mean cells, SampleDeltaRow's side scores
   * and score delta, RegressionRowView's score — still trusted the wire guard's
   * typeof check. JSON can carry 1e999: JSON.parse hands the page a typeof-number
   * Infinity, `Infinity.toFixed(2)` renders the literal "Infinity", and a hostile
   * or damaged upstream writes it into the verdict. The SideRow discipline extends
   * to every numeric this file interpolates: a non-finite renders as its field's
   * own absence sentence, never as a number.
   */
  const rawWithMean = (search: string, replace: string): Response =>
    new Response(JSON.stringify(comparisonBody()).replace(search, replace), {
      headers: { "content-type": "application/json" },
    });

  test("a mean the guard let through as Infinity reads the absence sentence, never Infinity", async () => {
    comparisonHandler = () =>
      rawWithMean(
        '"meanScore":{"baseline":1,',
        '"meanScore":{"baseline":1e999,',
      );
    const view = draw(ADDRESSED);
    await waitFor(() =>
      expect(pageText(view)).toContain("Mean moved by -0.50"),
    );
    // The candidate mean and the arithmetic delta are finite and still speak.
    expect(pageText(view)).toContain("0.50");
    expect(pageText(view)).not.toContain("Infinity");
    expect(pageText(view)).toContain(
      "No sample was scored — a missing score is not a zero.",
    );
  });

  test("a sample score and score delta of Infinity render the class word and the absence sentence", async () => {
    comparisonHandler = () =>
      new Response(
        JSON.stringify(comparisonBody())
          .replaceAll('"score":1}', '"score":1e999}')
          .replaceAll('"score":0.5}', '"score":1e999}')
          .replace('"scoreDelta":-0.5}', '"scoreDelta":1e999}'),
        { headers: { "content-type": "application/json" } },
      );
    const view = draw(ADDRESSED);
    await waitFor(() => expect(pageText(view)).toContain("Regressed"));
    expect(pageText(view)).not.toContain("Infinity");
    expect(pageText(view)).toContain(
      "No score delta — a missing score is not a zero.",
    );
    // The rows keep their remaining facts: the direction word and the regression
    // row's code, with only the unusable score cell gone.
    expect(pageText(view)).toContain("CASE_FAILED");
  });
});

/*
 * OCR round 3 (R3-10/R3-01/R3-02/R3-03): the guard claims the remaining fields the page
 * reads or renders — the comparison's compatible boolean (the only field that decides
 * conclusion-level copy), each side's samples index consistency (the deltas section
 * indexes samples positionally, so a carried index that disagrees with its position is
 * misattribution, not a rendering quirk) — and the pages give the dynamic i18n
 * vocabularies the R2-09 treatment: a word the bundle cannot name renders verbatim,
 * never as a raw key.
 */
describe("the guard and the vocabularies hold (OCR round 3)", () => {
  test("a 200 that lost compatibility.compatible is unavailable, never a bare 'not comparable' (R3-10)", async () => {
    const body = comparisonBody();
    const { compatible: _dropped, fields } = body.compatibility;
    comparisonHandler = () =>
      Response.json({ ...body, compatibility: { fields } });
    const view = draw(ADDRESSED);
    await view.findByText("Upstream unavailable");
    // The conclusion sentence must not be reachable by absence: undefined used to
    // take the falsy branch and confidently declare the pair incompatible.
    expect(pageText(view)).not.toContain("Not comparable");
  });

  test("a sample whose carried index disagrees with its position is unavailable (R3-01)", async () => {
    const body = comparisonBody();
    comparisonHandler = () =>
      Response.json({
        ...body,
        baseline: {
          ...body.baseline,
          report: reportBody("exp-1", "exec-1", {
            samples: [
              {
                index: 1,
                class: "scored",
                score: 1,
                reason: { class: "scored", passed: 2, failed: 0, rules: [] },
                usage: null,
                judge: {
                  status: "scored",
                  score: 0.9,
                  rationale: "misplaced",
                  scorerVersion: "judge/1",
                  entranceId: "main",
                  usage: null,
                },
                resultLink: RESULT_LINK_BASELINE,
              },
            ],
          }),
        },
      });
    const view = draw(ADDRESSED);
    await view.findByText("Upstream unavailable");
    expect(pageText(view)).not.toContain("misplaced");
  });

  test("a ledger field the build cannot name renders verbatim, never a raw key (R3-02)", async () => {
    const body = comparisonBody();
    comparisonHandler = () =>
      Response.json({
        ...body,
        compatibility: {
          compatible: true,
          fields: [
            {
              field: "scoringDefinition" as never,
              baseline: "rules/1",
              candidate: "rules/2",
              equal: false,
              blocking: true,
            },
          ],
        },
      });
    const view = draw(ADDRESSED);
    await view.findByText("scoringDefinition");
    expect(pageText(view)).not.toContain("comparison.fields.scoringDefinition");
  });

  test("a class word the build cannot name renders verbatim in deltas and regressions (R3-03)", async () => {
    const body = comparisonBody();
    comparisonHandler = () =>
      Response.json({
        ...body,
        deltas: {
          meanScore: { baseline: 1, candidate: 1, delta: 0 },
          perSample: [
            {
              index: 0,
              baseline: { class: "quarantined" as never, score: 1 },
              candidate: { class: "quarantined" as never, score: 1 },
              scoreDelta: 0,
              direction: "unchanged",
            },
          ],
        },
        regressions: [
          {
            index: 0,
            case: {
              datasetVersionId: "version-1",
              contentHash: `c${"0".repeat(63)}`,
            },
            baseline: {
              class: "quarantined" as never,
              score: 1,
              code: null,
              resultLink: RESULT_LINK_BASELINE,
            },
            candidate: {
              class: "quarantined" as never,
              score: 1,
              code: null,
              resultLink: RESULT_LINK_CANDIDATE,
            },
          },
        ],
      });
    const view = draw(ADDRESSED);
    await view.findByText("#0 Unchanged");
    expect(pageText(view)).toContain("quarantined");
    expect(pageText(view)).not.toContain("classes.quarantined");
  });
});

describe("the machine-readable export and literal text (acceptance 4)", () => {
  test("the download carries the comparison the server answered, as JSON", async () => {
    const blobs: Blob[] = [];
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:mock";
    };
    URL.revokeObjectURL = () => {};
    try {
      const view = draw(ADDRESSED);
      const download = await view.findByRole("button", {
        name: "Download comparison (JSON)",
      });
      const user = userEvent.setup({ document: view.container.ownerDocument });
      download.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(blobs.length).toBe(1));
      const text = await blobs[0].text();
      expect(text).toContain(RESULT_LINK_BASELINE);
      expect(text).toContain('"delta": -0.5');
      expect(text).toContain('"compatible": true');
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });

  test("a script payload in a witness renders as literal text", async () => {
    comparisonHandler = () =>
      Response.json(
        comparisonBody({
          compatibility: {
            compatible: true,
            fields: comparisonBody().compatibility.fields.map((entry) =>
              entry.field === "modelName"
                ? { ...entry, baseline: "<script>alert(1)</script>" }
                : entry,
            ),
          },
        }),
      );
    const view = draw(ADDRESSED);
    await waitFor(() =>
      expect(pageText(view)).toContain("<script>alert(1)</script>"),
    );
    expect(document.querySelector("script")).toBeNull();
  });
});
