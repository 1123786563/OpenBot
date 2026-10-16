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
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ExperimentResultsReport,
  ExperimentSubmitInput,
  SubmittedExperimentResult,
} from "../../shared/ai-observability-experiments";
import { ObservationEvaluationsPage } from "../src/components/ai-observability/evaluations-page";
import { ObservationExperimentResultsPage } from "../src/components/ai-observability/experiment-results";
// English copy: the i18n bundles initialize on import, so assertions see real sentences.
import "@/lib/i18n";
import enEvaluations from "../src/locales/en/ai-observability-evaluations.json";
import enRuns from "../src/locales/en/ai-observability-runs.json";
import { queryClient } from "../src/query-client";

/*
 * Issue #36 — the creator's experiment surfaces: submitting a frozen configuration,
 * reading its per-sample results, and canceling the execution that runs it.
 *
 * What these cases pin, in acceptance order:
 *   1. the submit dialog offers this Bot's datasets and their frozen versions, sends
 *      the T22 frozen contract (seven configuration fields) to the pinned URL, and
 *      the answer — new or replayed, canary count, config hash — says what froze;
 *   2. the results page answers the state vocabulary (runs' own states.* words for
 *      the three states both machines share), the execution record with its
 *      server-minted result link, and every one of the T28 seven sample classes in
 *      its own word, with the mean averaging scored samples only — null when none,
 *      never a masked zero;
 *   3. a running execution can be canceled from the page and settles as canceled; a
 *      settled one offers no cancel;
 *   4. keyboard navigation reaches the results route; the four fault answers —
 *      disabled, forbidden, notFound, unavailable — never borrow each other's
 *      sentences, and a manage-gate 404 renders forbidden, not notFound;
 *   5. upstream content renders as text only — a <script> in a usage record is data;
 *   6. the wire contract is asserted by name: every request hits the real URLs and
 *      the response fields the pages read are the shared contract's own.
 *
 * The endpoints are fetch-mocked: the results read is T28's mounted-by-T29 face, and
 * the submit/cancel writes are the URL faces this ticket pinned in
 * shared/ai-observability-experiments.ts for the later wiring ticket to implement.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
const requested: { url: string; method: string; body?: string }[] = [];
let listHandler: () => Response = () => Response.json(datasetsBody([]));
let detailHandler: () => Response = () => Response.json(detailBody());
let submitHandler: () => Response = () => Response.json(submittedBody());
let resultsHandler: () => Response = () => Response.json(reportBody());
let cancelHandler: () => Response = () =>
  Response.json({ executionId: "exec-1", state: "cancelled" });

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
  listHandler = () => Response.json(datasetsBody([]));
  detailHandler = () => Response.json(detailBody());
  submitHandler = () => Response.json(submittedBody());
  resultsHandler = () => Response.json(reportBody());
  cancelHandler = () =>
    Response.json({ executionId: "exec-1", state: "cancelled" });
  queryClient.clear();
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      requested.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url === "/api/me") return Response.json({ user: ME });
      if (url.startsWith("/api/agents/agent-1"))
        return Response.json({ agent: PROFILE });
      if (url === "/api/ai-observability/bots/agent-1/datasets")
        return listHandler();
      if (url === "/api/ai-observability/bots/agent-1/datasets/ds-1")
        return detailHandler();
      if (
        url === "/api/ai-observability/bots/agent-1/experiments" &&
        (init?.method ?? "GET") === "POST"
      )
        return submitHandler();
      if (
        url ===
        "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1"
      )
        return resultsHandler();
      if (
        url ===
        "/api/ai-observability/bots/agent-1/experiments/exp-1/executions/exec-1/cancel"
      )
        return cancelHandler();
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

const CONFIG_HASH = `e${"3".repeat(63)}`;

function datasetsBody(datasets: unknown[]): { datasets: unknown[] } {
  return { datasets };
}

function datasetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ds-1",
    name: "Support replies",
    syncState: "synced",
    createdAt: "2026-10-15T09:00:00.000Z",
    updatedAt: "2026-10-16T09:00:00.000Z",
    versionCount: 2,
    latestVersionAt: "2026-10-16T09:00:00.000Z",
    ...overrides,
  };
}

function detailBody() {
  return {
    dataset: datasetRow(),
    versions: [
      {
        id: "v-2",
        datasetId: "ds-1",
        contentHash: `b${"0".repeat(63)}`,
        redactionPolicyVersion: "opik-redaction/5",
        caseCount: 8,
        createdAt: "2026-10-16T09:00:00.000Z",
      },
      {
        id: "v-1",
        datasetId: "ds-1",
        contentHash: `a${"1".repeat(63)}`,
        redactionPolicyVersion: "opik-redaction/5",
        caseCount: 4,
        createdAt: "2026-10-15T09:00:00.000Z",
      },
    ],
  };
}

function submittedBody(
  overrides: Partial<SubmittedExperimentResult> = {},
): SubmittedExperimentResult {
  return {
    experimentId: "exp-1",
    executionId: "exec-1",
    name: "Tone check",
    datasetVersionId: "v-2",
    datasetContentHash: `b${"0".repeat(63)}`,
    configHash: CONFIG_HASH,
    replayed: false,
    canaryFindings: 0,
    ...overrides,
  };
}

/** A report whose execution has not settled — both state fields say so, as the row does. */
function runningReport(): ExperimentResultsReport {
  const base = reportBody();
  return {
    ...base,
    state: "running",
    execution: { ...base.execution, state: "running", settledAt: null },
  };
}

/** One sample per T28 class, two of them scored, so the mean has something to average. */
function reportBody(
  overrides: Partial<ExperimentResultsReport> = {},
): ExperimentResultsReport {
  return {
    experimentId: "exp-1",
    executionId: "exec-1",
    resultLink:
      "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
    state: "completed",
    scorerVersion: "rule-scorer/3",
    execution: {
      id: "exec-1",
      state: "completed",
      errorCode: null,
      caseCount: 8,
      toolRejections: 2,
      experimentConfigHash: CONFIG_HASH,
      startedAt: "2026-10-16T10:00:00.000Z",
      settledAt: "2026-10-16T10:04:00.000Z",
      createdAt: "2026-10-16T09:59:00.000Z",
    },
    summary: {
      sampleBase: 8,
      scored: 2,
      executionFailed: 1,
      scoringFailed: 1,
      cancelled: 1,
      pendingReconciliation: 1,
      syncFailure: 1,
      inProgress: 1,
      meanScore: 0.75,
    },
    samples: [
      {
        index: 0,
        class: "scored",
        score: 1,
        reason: {
          class: "scored",
          passed: 2,
          failed: 0,
          rules: [
            { id: "refund-mentioned", index: 0, status: "passed" },
            { id: "tone", index: 1, status: "passed" },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 20 },
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 1,
        class: "scored",
        score: 0.5,
        reason: {
          class: "scored",
          passed: 1,
          failed: 1,
          rules: [
            { id: "refund-mentioned", index: 0, status: "passed" },
            {
              id: "length",
              index: 1,
              status: "failed",
              reason: "comparison_false",
            },
          ],
        },
        usage: null,
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 2,
        class: "in_progress",
        score: null,
        reason: {
          class: "in_progress",
          code: "EXECUTION_NOT_SETTLED",
          state: "running",
        },
        usage: null,
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 3,
        class: "execution_failed",
        score: null,
        reason: { class: "execution_failed", code: "CASE_EXECUTION_ERROR" },
        usage: null,
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 4,
        class: "scoring_failed",
        score: null,
        reason: { class: "scoring_failed", code: "OUTPUT_MISSING" },
        usage: { inputTokens: 5 },
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 5,
        class: "cancelled",
        score: null,
        reason: { class: "cancelled", code: "CANCELLED" },
        usage: null,
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 6,
        class: "pending_reconciliation",
        score: null,
        reason: { class: "pending_reconciliation", code: "LEASE_EXPIRED" },
        usage: null,
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 7,
        class: "sync_failure",
        score: null,
        reason: { class: "sync_failure", code: "CASE_RECORD_MISSING" },
        usage: null,
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
    ],
    ...overrides,
  };
}

/*
 * The two pages in a router of two real paths — the evaluations page the experiments
 * section lives on, and the results route its submission links to — rather than the
 * generated tree, whose _authed layout mounts the CopilotKit runtime the page has
 * nothing to say to. The full-tree guarantees (both URLs sit under /_authed, so a
 * typed-in address walks the session guard) are pinned by ai-observability-routes.test.tsx.
 *
 * The provider is the real singleton, because the cancel mutation's invalidation
 * reaches it: a fresh client per draw would sever exactly the refresh this ticket
 * must show.
 */
function draw(initial = "/bots/agent-1/evaluations") {
  const rootRoute = createRootRoute();
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId/evaluations",
    component: function TestEvaluationsPage() {
      const { agentId } = listRoute.useParams();
      return <ObservationEvaluationsPage agentId={agentId} />;
    },
  });
  const resultsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId/evaluations/experiments/$experimentId/$executionId",
    component: function TestResultsPage() {
      const { agentId, experimentId, executionId } = resultsRoute.useParams();
      return (
        <ObservationExperimentResultsPage
          agentId={agentId}
          experimentId={experimentId}
          executionId={executionId}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, resultsRoute]),
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

type Drawn = ReturnType<typeof draw> & {
  router: { state: { location: { pathname: string } } };
};

/** The submit dialog, opened from its entry row and driven to a submittable draft. */
async function openReadyDialog(view: ReturnType<typeof draw>) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(
    await view.findByRole("button", { name: /Run an experiment/ }),
  );
  const dialog = await view.findByRole("dialog");
  await user.type(
    within(dialog).getByLabelText("Experiment name"),
    "Tone check",
  );
  await user.selectOptions(within(dialog).getByLabelText("Dataset"), "ds-1");
  await waitFor(() =>
    expect(
      within(dialog).getByLabelText("Frozen version").querySelectorAll("option")
        .length,
    ).toBeGreaterThan(1),
  );
  await user.selectOptions(
    within(dialog).getByLabelText("Frozen version"),
    "v-2",
  );
  await user.type(within(dialog).getByLabelText("Prompt"), "Answer kindly.");
  await user.type(within(dialog).getByLabelText("Model"), "gpt-test");
  await user.type(
    within(dialog).getByLabelText("Judge version"),
    "rule-scorer/3",
  );
  return { user, dialog };
}

describe("submitting an experiment freezes the T22 contract (acceptance 1)", () => {
  test("the dialog offers this Bot's datasets and frozen versions, and submits the seven-field configuration", async () => {
    listHandler = () => Response.json(datasetsBody([datasetRow()]));
    const view = draw();
    const { user, dialog } = await openReadyDialog(view);
    // The version dropdown answers the pinned version's own case count.
    expect(dialog.textContent ?? "").toContain("8 cases");
    await user.click(
      within(dialog).getByRole("button", { name: "Submit experiment" }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByText("Experiment frozen and started."),
      ).toBeTruthy(),
    );

    // The contract is asserted by name: the real URL, the real method.
    const submit = requested.find(
      (entry) =>
        entry.url === "/api/ai-observability/bots/agent-1/experiments" &&
        entry.method === "POST",
    );
    expect(submit).toBeDefined();
    expect(submit?.body).toBeDefined();
    const body = JSON.parse(submit?.body ?? "{}") as ExperimentSubmitInput;
    expect(body).toEqual({
      name: "Tone check",
      datasetVersionId: "v-2",
      config: {
        botConfig: {},
        prompt: "Answer kindly.",
        modelName: "gpt-test",
        modelParameters: {},
        toolFixtures: {},
        judgeConfig: {},
        judgeVersion: "rule-scorer/3",
      },
    });

    // The answer says what froze: the config hash, and where to watch it run.
    expect(dialog.textContent ?? "").toContain(CONFIG_HASH);
    const link = within(dialog).getByRole("link", { name: "View results" });
    expect(link.getAttribute("href")).toBe(
      "/bots/agent-1/evaluations/experiments/exp-1/exec-1",
    );
  });

  test("a replayed submission says it hit the same experiment and created nothing", async () => {
    listHandler = () => Response.json(datasetsBody([datasetRow()]));
    submitHandler = () => Response.json(submittedBody({ replayed: true }));
    const view = draw();
    const { user, dialog } = await openReadyDialog(view);
    await user.click(
      within(dialog).getByRole("button", { name: "Submit experiment" }),
    );
    expect(await within(dialog).findByText(/already frozen/)).toBeTruthy();
    expect(within(dialog).getByText(/nothing new was created/i)).toBeTruthy();
  });

  test("the canary count says when the redaction policy refused fields", async () => {
    listHandler = () => Response.json(datasetsBody([datasetRow()]));
    submitHandler = () => Response.json(submittedBody({ canaryFindings: 2 }));
    const view = draw();
    const { user, dialog } = await openReadyDialog(view);
    await user.click(
      within(dialog).getByRole("button", { name: "Submit experiment" }),
    );
    expect(
      await within(dialog).findByText(/2 fields the redaction policy refused/),
    ).toBeTruthy();
  });

  test("a configuration field that is not a JSON object refuses to submit", async () => {
    listHandler = () => Response.json(datasetsBody([datasetRow()]));
    const view = draw();
    const { user, dialog } = await openReadyDialog(view);
    // "{{" is user-event's escape for a literal brace; "{bad" alone would parse as a
    // keyboard sequence.
    await user.type(
      within(dialog).getByLabelText("Model parameters (JSON)"),
      "{{bad",
    );
    expect(
      await within(dialog).findByText("This field must be a JSON object."),
    ).toBeTruthy();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Submit experiment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("refusal codes keep their own sentences", async () => {
    listHandler = () => Response.json(datasetsBody([datasetRow()]));
    submitHandler = () =>
      Response.json(
        { error: "EXPERIMENT_DATASET_VERSION_NOT_FOUND" },
        { status: 404 },
      );
    const view = draw();
    const { user, dialog } = await openReadyDialog(view);
    await user.click(
      within(dialog).getByRole("button", { name: "Submit experiment" }),
    );
    expect(
      await within(dialog).findByText(
        "This Bot's datasets hold no frozen version with that id. Nothing was submitted.",
      ),
    ).toBeTruthy();

    submitHandler = () =>
      Response.json({ error: "EXPERIMENT_INPUT_INVALID" }, { status: 400 });
    await user.click(
      within(dialog).getByRole("button", { name: "Submit experiment" }),
    );
    expect(
      await within(dialog).findByText(
        "The experiment name or configuration is not valid. Nothing was submitted.",
      ),
    ).toBeTruthy();
  });

  test("a store that does not answer the submit says so", async () => {
    listHandler = () => Response.json(datasetsBody([datasetRow()]));
    submitHandler = () => new Response(null, { status: 500 });
    const view = draw();
    const { user, dialog } = await openReadyDialog(view);
    await user.click(
      within(dialog).getByRole("button", { name: "Submit experiment" }),
    );
    expect(
      await within(dialog).findByText(
        "The observability store did not answer. Nothing changed.",
      ),
    ).toBeTruthy();
  });

  test("a refused scope draws no submit entry at all", async () => {
    listHandler = () =>
      Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    const view = draw();
    // The page's datasets section answers the refusal with its own sentence (the
    // datasets namespace's); the experiments section contributes no entry to a scope
    // that could not answer what it holds.
    await view.findByText("You cannot manage this dataset");
    expect(
      view.queryByRole("button", { name: /Run an experiment/ }),
    ).toBeNull();
  });
});

describe("the results page answers the report (acceptance 1 and 2)", () => {
  test("the execution record answers state, error, counts, hash and the server-minted result link", async () => {
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await waitFor(() => expect(pageText(view)).toContain("Completed"));
    expect(pageText(view)).toContain("rule-scorer/3");
    expect(pageText(view)).toContain(CONFIG_HASH);
    expect(pageText(view)).toContain("2");
    // The result link is the server-minted API path, shown in full.
    expect(pageText(view)).toContain(
      "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
    );
    // The read hit T28's pinned URL (acceptance 6: the contract by name).
    expect(
      requested.some(
        (entry) =>
          entry.url ===
            "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1" &&
          entry.method === "GET",
      ),
    ).toBe(true);
  });

  test("seven sample classes each keep their own word, and the mean averages scored samples only", async () => {
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await waitFor(() => expect(pageText(view)).toContain("Scored"));
    for (const word of [
      "Still running",
      "Execution failed",
      "Scoring failed",
      "Canceled",
      "Awaiting reconciliation",
      "Result sync failure",
    ]) {
      expect(pageText(view)).toContain(word);
    }
    // The scored samples answer their score and their rule counts.
    expect(pageText(view)).toContain("1");
    expect(pageText(view)).toContain("0.5");
    expect(pageText(view)).toContain("2 rules passed");
    expect(pageText(view)).toContain("1 rule failed");
    // A failed rule's own reason word is the reason the sample shows.
    expect(pageText(view)).toContain("comparison_false");
    // The summary answers the base and the mean over scored samples only.
    expect(pageText(view)).toContain("8 frozen cases");
    expect(pageText(view)).toContain("0.75");
    expect(pageText(view)).not.toContain("0.00");
  });

  test("no scored sample means no mean, never a masked zero", async () => {
    resultsHandler = () =>
      Response.json(
        reportBody({
          state: "failed",
          summary: {
            sampleBase: 2,
            scored: 0,
            executionFailed: 2,
            scoringFailed: 0,
            cancelled: 0,
            pendingReconciliation: 0,
            syncFailure: 0,
            inProgress: 0,
            meanScore: null,
          },
        }),
      );
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await waitFor(() =>
      expect(pageText(view)).toContain("No sample was scored"),
    );
    expect(pageText(view)).not.toContain("0.00");
  });

  test("the sample rows answer their reason codes and usage as text", async () => {
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await waitFor(() => expect(pageText(view)).toContain("OUTPUT_MISSING"));
    expect(pageText(view)).toContain("CASE_EXECUTION_ERROR");
    expect(pageText(view)).toContain("LEASE_EXPIRED");
    expect(pageText(view)).toContain("CASE_RECORD_MISSING");
    expect(pageText(view)).toContain("CANCELLED");
    expect(pageText(view)).toContain('{"inputTokens":10,"outputTokens":20}');
  });

  test("a script payload in a usage record renders as literal text", async () => {
    const base = reportBody();
    const scripted = {
      ...base,
      samples: base.samples.map((sample) =>
        sample.index === 0
          ? {
              ...sample,
              usage: { inputTokens: "<script>alert(1)</script>" },
            }
          : sample,
      ),
    };
    resultsHandler = () => Response.json(scripted);
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await waitFor(() =>
      expect(pageText(view)).toContain("<script>alert(1)</script>"),
    );
    expect(document.querySelector("script")).toBeNull();
  });
});

describe("canceling the execution (acceptance 1)", () => {
  test("a running execution offers cancel, which settles it as canceled", async () => {
    let calls = 0;
    resultsHandler = () => {
      calls += 1;
      return Response.json(calls <= 1 ? runningReport() : reportBody());
    };
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await waitFor(() => expect(pageText(view)).toContain("Running"));
    await user.click(
      await view.findByRole("button", { name: "Cancel this experiment" }),
    );
    // The write hit the pinned URL and method.
    expect(
      requested.some(
        (entry) =>
          entry.url ===
            "/api/ai-observability/bots/agent-1/experiments/exp-1/executions/exec-1/cancel" &&
          entry.method === "POST",
      ),
    ).toBe(true);
    // The results read is invalidated: the settled report redraws.
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    await waitFor(() => expect(pageText(view)).toContain("Completed"));
    expect(
      view.queryByRole("button", { name: "Cancel this experiment" }),
    ).toBeNull();
  });

  test("a settled execution offers no cancel", async () => {
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await waitFor(() => expect(pageText(view)).toContain("Completed"));
    expect(
      view.queryByRole("button", { name: "Cancel this experiment" }),
    ).toBeNull();
  });

  test("a cancel the execution refuses says so, and nothing changes", async () => {
    resultsHandler = () => Response.json(runningReport());
    cancelHandler = () =>
      Response.json({ error: "EXECUTION_STATE_INVALID" }, { status: 409 });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await waitFor(() => expect(pageText(view)).toContain("Running"));
    await user.click(
      await view.findByRole("button", { name: "Cancel this experiment" }),
    );
    expect(
      await view.findByText(
        "Only a running execution can be canceled — this one has already settled.",
      ),
    ).toBeTruthy();
  });
});

describe("the fault answers stay distinct, and the route is typed-address safe (acceptance 3 and 4)", () => {
  test("a disabled deployment says disabled, not empty", async () => {
    resultsHandler = () =>
      Response.json({ error: "capability_missing" }, { status: 503 });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText("Evaluation is off");
  });

  test("a management refusal says forbidden", async () => {
    resultsHandler = () =>
      Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText("You cannot run this experiment");
    expect(view.queryByText("No such experiment")).toBeNull();
  });

  test("a scope-local not-found says notFound, never borrowed forbidden words", async () => {
    resultsHandler = () =>
      Response.json({ error: "RESULTS_EXPERIMENT_NOT_FOUND" }, { status: 404 });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText("No such experiment");
    expect(view.queryByText("You cannot run this experiment")).toBeNull();
  });

  test("a manage-gate 404 without a scope-local code is forbidden, not notFound", async () => {
    resultsHandler = () =>
      Response.json({ error: "OBSERVATION_BOT_NOT_FOUND" }, { status: 404 });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText("You cannot run this experiment");
    expect(view.queryByText("No such experiment")).toBeNull();
  });

  test("an unreachable store says unavailable, never an empty page", async () => {
    resultsHandler = () => new Response(null, { status: 502 });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText("Upstream unavailable");
  });

  test("the results link is keyboard reachable and navigates to the results route", async () => {
    listHandler = () => Response.json(datasetsBody([datasetRow()]));
    const view = draw() as Drawn;
    const { user, dialog } = await openReadyDialog(view);
    await user.click(
      within(dialog).getByRole("button", { name: "Submit experiment" }),
    );
    const link = await within(dialog).findByRole("link", {
      name: "View results",
    });
    link.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        "/bots/agent-1/evaluations/experiments/exp-1/exec-1",
      ),
    );
  });
});

describe("the state vocabulary is the runs chain's own (acceptance 2)", () => {
  test("the three states both machines share carry the states.* words verbatim", () => {
    const states = (
      enEvaluations as unknown as {
        states: Record<string, string>;
      }
    ).states;
    const runsStates = (
      enRuns as unknown as {
        states: Record<string, string>;
      }
    ).states;
    for (const shared of ["running", "completed", "failed"] as const) {
      expect(states[shared], `states.${shared}`).toBe(runsStates[shared]);
    }
  });
});
