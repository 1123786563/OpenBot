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
let detailHandler: () => Response | Promise<Response> = () =>
  Response.json(detailBody());
let submitHandler: () => Response | Promise<Response> = () =>
  Response.json(submittedBody());
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
        judge: null,
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
        judge: null,
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
        judge: null,
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 3,
        class: "execution_failed",
        score: null,
        reason: { class: "execution_failed", code: "CASE_EXECUTION_ERROR" },
        usage: null,
        judge: null,
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 4,
        class: "scoring_failed",
        score: null,
        reason: { class: "scoring_failed", code: "OUTPUT_MISSING" },
        usage: { inputTokens: 5 },
        judge: null,
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 5,
        class: "cancelled",
        score: null,
        reason: { class: "cancelled", code: "CANCELLED" },
        usage: null,
        judge: null,
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 6,
        class: "pending_reconciliation",
        score: null,
        reason: { class: "pending_reconciliation", code: "LEASE_EXPIRED" },
        usage: null,
        judge: null,
        resultLink:
          "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
      },
      {
        index: 7,
        class: "sync_failure",
        score: null,
        reason: { class: "sync_failure", code: "CASE_RECORD_MISSING" },
        usage: null,
        judge: null,
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

  test("a 200 body without canaryFindings is not a contract answer — the guard refuses it (T30-rev L-1)", async () => {
    listHandler = () => Response.json(datasetsBody([datasetRow()]));
    const { canaryFindings: _dropped, ...incomplete } = submittedBody();
    submitHandler = () => Response.json(incomplete);
    const view = draw();
    const { user, dialog } = await openReadyDialog(view);
    await user.click(
      within(dialog).getByRole("button", { name: "Submit experiment" }),
    );
    // The store did not answer the pinned shape: the honest refusal sentence, and
    // never a success story whose canary fact silently vanished.
    expect(
      await within(dialog).findByText(/observability store did not answer/),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/frozen and started/)).toBeNull();
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

  test("a class word the build cannot name renders verbatim, never a raw key (OCR round 3, R3-04)", async () => {
    // The summary's own closed-set classes render their sentences; a newer server's
    // class word is a missing i18n sentence, so the sample row shows the word itself
    // instead of echoing `classes.quarantined` (R2-09's standard, applied here).
    resultsHandler = () =>
      Response.json(
        reportBody({
          samples: [
            {
              index: 0,
              class: "quarantined" as never,
              score: null,
              reason: { class: "quarantined", code: "QUARANTINED" } as never,
              usage: null,
              judge: null,
              resultLink:
                "/api/ai-observability/bots/agent-1/experiments/exp-1/results/exec-1",
            },
          ],
        }),
      );
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText(/#0 quarantined/);
    expect(pageText(view)).not.toContain("classes.quarantined");
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

  test("a scored judge record renders its score and rationale beside the rule score (T27-rn L-3)", async () => {
    const base = reportBody();
    resultsHandler = () =>
      Response.json({
        ...base,
        samples: base.samples.map((sample) =>
          sample.index === 0
            ? {
                ...sample,
                judge: {
                  status: "scored",
                  score: 0.82,
                  rationale: "It agrees with the reference answer.",
                  scorerVersion: "judge/1",
                  entranceId: "main",
                  usage: null,
                },
              }
            : sample,
        ),
      });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await waitFor(() => expect(pageText(view)).toContain("Judge 0.82"));
    expect(pageText(view)).toContain("It agrees with the reference answer.");
  });

  test("a failed judge record renders its own code, never a guessed score (T27-rn L-3)", async () => {
    const base = reportBody();
    resultsHandler = () =>
      Response.json({
        ...base,
        samples: base.samples.map((sample) =>
          sample.index === 0
            ? {
                ...sample,
                judge: {
                  status: "failed",
                  code: "JUDGE_CALL_FAILED",
                  message: "the judge provider call threw",
                },
              }
            : sample,
        ),
      });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await waitFor(() => expect(pageText(view)).toContain("Judge failed"));
    expect(pageText(view)).toContain("JUDGE_CALL_FAILED");
    expect(pageText(view)).toContain("the judge provider call threw");
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

  test("a summary without its mean says unavailable, never a mid-render crash (OCR round 1 medium)", async () => {
    // `.toFixed(2)` runs on the mean after only a `=== null` check, so an undefined
    // used to slip through the envelope-only guard into a TypeError. The guard now
    // claims the number-or-null promise and refuses the body as the store's answer.
    const { summary, ...rest } = reportBody();
    resultsHandler = () =>
      Response.json({
        ...rest,
        summary: { ...summary, meanScore: undefined },
      });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText("Upstream unavailable");
  });

  test("a submit or cancel the network layer never answers says so (OCR round 1 medium)", async () => {
    // The fetch-reject half of the write verdicts: a refusal envelope has its own
    // sentence, but a request that never answered at all used to leave the dialog
    // silent. Both writes now reuse the store-did-not-answer sentence.
    listHandler = () => Response.json(datasetsBody([datasetRow()]));
    const view = draw();
    const { user, dialog } = await openReadyDialog(view);
    submitHandler = () => {
      throw new TypeError("network down");
    };
    await user.click(
      within(dialog).getByRole("button", { name: "Submit experiment" }),
    );
    expect(
      await within(dialog).findByText(
        "The observability store did not answer. Nothing changed.",
      ),
    ).toBeTruthy();
    // The cancel sentence below is the same words, so the submit view stands down
    // before it — findByText refuses to guess between two matches.
    view.unmount();

    resultsHandler = () => Response.json(runningReport());
    cancelHandler = () => {
      throw new TypeError("network down");
    };
    const results = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await user.click(
      await results.findByRole("button", { name: "Cancel this experiment" }),
    );
    expect(
      await results.findByText(
        "The observability store did not answer. Nothing changed.",
      ),
    ).toBeTruthy();
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

/*
 * R4-0/2/3/5 (OCR round 4): the guard used to claim only the crash-prone spine,
 * while the page reads more facts than it claimed — the seven summary class counts,
 * the execution projection's own row, the scorer version, and every non-scored
 * reason's code. A body missing any of them rendered `undefined` as if it were a
 * fact; each is now a promise the body must keep, and a broken promise is the same
 * store-did-not-answer fault as any other malformed success. Each category is
 * pinned here missing, one at a time, over an otherwise honest report.
 */
describe("the round-4 guard claims the page's whole render face (OCR round 4)", () => {
  test("a summary missing one of its seven class counts says unavailable, never `undefined` as a count (R4-0)", async () => {
    for (const countField of [
      "scored",
      "inProgress",
      "executionFailed",
      "scoringFailed",
      "cancelled",
      "pendingReconciliation",
      "syncFailure",
    ] as const) {
      const { summary, ...rest } = reportBody();
      resultsHandler = () =>
        Response.json({
          ...rest,
          summary: { ...summary, [countField]: undefined },
        });
      queryClient.clear();
      const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
      await view.findByText("Upstream unavailable");
      view.unmount();
    }
  }, 30_000);

  test("a report without its scorer version says unavailable, never a version of `undefined` (R4-5)", async () => {
    const body = reportBody();
    resultsHandler = () => Response.json({ ...body, scorerVersion: undefined });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText("Upstream unavailable");
  });

  test("an execution projection missing a field the record row reads says unavailable (R4-3)", async () => {
    for (const field of [
      "errorCode",
      "caseCount",
      "toolRejections",
      "startedAt",
      "settledAt",
      "experimentConfigHash",
    ] as const) {
      const { execution, ...rest } = reportBody();
      resultsHandler = () =>
        Response.json({
          ...rest,
          execution: { ...execution, [field]: undefined },
        });
      queryClient.clear();
      const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
      await view.findByText("Upstream unavailable");
      view.unmount();
    }
  }, 30_000);

  test("a non-scored reason without its code says unavailable, never a code of `undefined` (R4-2)", async () => {
    const body = reportBody();
    const samples = body.samples.map((sample, index) =>
      index === 3
        ? { ...sample, reason: { class: "execution_failed" } }
        : sample,
    );
    resultsHandler = () => Response.json({ ...body, samples });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText("Upstream unavailable");
  });

  test("a reason without its class word says unavailable, never a branch guessed (R4-2)", async () => {
    // The page picks the reason's sentence by discriminating on `class`; a body
    // that lost the word is not a reason whose branch may be guessed — the guard
    // claims it as a string for every class, scored or not.
    const body = reportBody();
    const samples = body.samples.map((sample, index) =>
      index === 3
        ? { ...sample, reason: { code: "CASE_EXECUTION_ERROR" } }
        : sample,
    );
    resultsHandler = () => Response.json({ ...body, samples });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText("Upstream unavailable");
  });
});

describe("the round-2 guard and dialog seams (OCR round 2)", () => {
  test("a scored sample without its rules array says unavailable, never a crash (R2-09)", async () => {
    // The results page filters reason.rules for the scored class; the guard used to
    // claim only `isRecord(sample.reason)`, so a scored reason without its rules
    // reached the renderer as undefined.filter.
    const body = reportBody();
    const samples = body.samples.map((sample, index) =>
      index === 0
        ? {
            ...sample,
            reason: { class: "scored", passed: 2, failed: 0 },
          }
        : sample,
    );
    resultsHandler = () => Response.json({ ...body, samples });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText("Upstream unavailable");
  });

  test("an execution state word the build cannot name renders verbatim, never a raw i18n key (R2-09)", async () => {
    const body = reportBody();
    resultsHandler = () =>
      Response.json({
        ...body,
        execution: { ...body.execution, state: "draining" },
      });
    const view = draw("/bots/agent-1/evaluations/experiments/exp-1/exec-1");
    await view.findByText("Execution record");
    const text = pageText(view);
    expect(text).toContain("draining");
    expect(text).not.toContain("states.draining");
  });

  test("a dataset whose frozen versions did not answer says so instead of an empty dropdown (R2-04)", async () => {
    // The transport-error half of the detail read used to leave the version select
    // silently empty — the sentence rendered only for `detail.data?.view === "fault"`,
    // so detail.error (fetch rejected before any HTTP verdict) drew nothing, and with
    // versionId required the submit silently locked. The shared observationScreenFault
    // derivation covers both halves.
    listHandler = () => Response.json(datasetsBody([datasetRow()]));
    detailHandler = () => {
      throw new TypeError("network down");
    };
    const view = draw();
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(
      await view.findByRole("button", { name: /Run an experiment/ }),
    );
    const dialog = await view.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Dataset"), "ds-1");
    // The page's query client retries once before the error is the state, so the
    // sentence lands after the default wait — give the retry its beat.
    expect(
      await within(dialog).findByText(
        "The frozen versions of this dataset did not answer.",
        {},
        { timeout: 4000 },
      ),
    ).toBeTruthy();
  });

  test("a submission that lands after the dialog closed never writes the reopened blank (R2-03)", async () => {
    listHandler = () => Response.json(datasetsBody([datasetRow()]));
    let release: ((response: Response | Promise<Response>) => void) | null =
      null;
    submitHandler = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    // Indirection: release's narrowing resets inside a closure, so the late
    // settlement reads the declared type.
    const settle = (response: Response | Promise<Response>) =>
      release?.(response);
    const view = draw();
    const { user, dialog } = await openReadyDialog(view);
    await user.click(
      within(dialog).getByRole("button", { name: "Submit experiment" }),
    );
    // Close while the submit is in flight; the reopened dialog is a blank slate.
    // (The dialog has a built-in sr-only "Close" X beside the footer's — pick the
    // footer's, the last one.)
    const closeButtons = within(dialog).getAllByRole("button", {
      name: "Close",
    });
    await user.click(closeButtons[closeButtons.length - 1]);
    await user.click(
      await view.findByRole("button", { name: /Run an experiment/ }),
    );
    const reopened = await view.findByRole("dialog");
    expect(
      (within(reopened).getByLabelText("Experiment name") as HTMLInputElement)
        .value,
    ).toBe("");
    settle(Response.json(submittedBody()));
    // Let the late answer land — the buggy implementation writes the frozen-
    // experiment block onto the reopened blank here — then it must still be blank.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(view.queryByText("Experiment frozen and started.")).toBeNull();
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
