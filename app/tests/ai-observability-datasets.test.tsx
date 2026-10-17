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
  CaseReviewOutcome,
  ObservationDatasetDetailResult,
  ObservationDatasetListItem,
  ObservationDatasetsResult,
  SavedDatasetVersionResult,
} from "../../shared/ai-observability-datasets";
import { ObservationDatasetDetailPage } from "../src/components/ai-observability/dataset-detail";
import { ObservationDatasetsBody } from "../src/components/ai-observability/datasets-list";
// English copy: the i18n bundles initialize on import, so assertions see real sentences.
import "@/lib/i18n";
import { queryClient } from "../src/query-client";

/*
 * Issue #27 — the creator's dataset surfaces, through the real components at the addresses
 * the route convention recorded (/bots/$agentId/evaluations and its $datasetId detail).
 *
 * What these cases pin, in acceptance order:
 *   1. datasets and their frozen versions are visible — list, detail, version history,
 *      each version answering its hash, time, case count and projection policy;
 *   2. immutability is what the UI says: the history offers no edit affordance at all, and
 *      says so beside the rows;
 *   3. the save flow answers every step: review preview (with the canary count), staleness
 *      after an edit, the freeze, and the idempotent replay — each with its own sentence;
 *   4. error codes are explainable: the T20 refusal codes keep their own words;
 *   5. empty, disabled, forbidden and unavailable never borrow each other's sentences;
 *   6. every request is scoped to the Bot — the URL carries the botId, and a refused scope
 *      reads as the management sentence, never as somebody else's data;
 *   7. upstream content renders as text only — a <script> in a projected value is data.
 *
 * The wire shapes here are the shared contract's (shared/ai-observability-datasets.ts),
 * which mirrors the T19/T20 server shapes; the endpoints themselves are T33's to wire.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
const requested: string[] = [];
let listHandler: () => Response = () => Response.json(datasetsBody([]));
let detailHandler: () => Response | Promise<Response> = () =>
  Response.json(detailBody());
let reviewHandler: () => Response = () => Response.json(reviewBody());
let saveHandler: () => Response = () => Response.json(savedBody());

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
  reviewHandler = () => Response.json(reviewBody());
  saveHandler = () => Response.json(savedBody());
  queryClient.clear();
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      requested.push(url);
      if (url === "/api/me") return Response.json({ user: ME });
      if (url.startsWith("/api/agents/agent-1"))
        return Response.json({ agent: PROFILE });
      if (url === "/api/ai-observability/bots/agent-1/datasets")
        return listHandler();
      if (url === "/api/ai-observability/bots/agent-1/datasets/ds-1")
        return detailHandler();
      if (url === "/api/ai-observability/bots/agent-1/case-review/review")
        return reviewHandler();
      if (url === "/api/ai-observability/bots/agent-1/case-review/save")
        return saveHandler();
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function datasetItem(
  overrides: Partial<ObservationDatasetListItem> = {},
): ObservationDatasetListItem {
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

function datasetsBody(
  datasets: ObservationDatasetListItem[],
): ObservationDatasetsResult {
  return { datasets };
}

const HASH_NEWEST = `b${"0".repeat(63)}`;
const HASH_OLDEST = `a${"1".repeat(63)}`;

function detailBody(
  overrides: Partial<ObservationDatasetDetailResult> = {},
): ObservationDatasetDetailResult {
  return {
    dataset: {
      id: "ds-1",
      name: "Support replies",
      syncState: "synced",
      createdAt: "2026-10-15T09:00:00.000Z",
      updatedAt: "2026-10-16T09:00:00.000Z",
    },
    versions: [
      {
        id: "v-2",
        datasetId: "ds-1",
        contentHash: HASH_NEWEST,
        redactionPolicyVersion: "opik-redaction/5",
        caseCount: 1,
        createdAt: "2026-10-16T09:00:00.000Z",
      },
      {
        id: "v-1",
        datasetId: "ds-1",
        contentHash: HASH_OLDEST,
        redactionPolicyVersion: "opik-redaction/5",
        caseCount: 2,
        createdAt: "2026-10-15T09:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

/** The T20 review answer: one projected case whose reference output the policy refused. */
function reviewBody(): CaseReviewOutcome {
  return {
    decision: "approved",
    runId: "run-9",
    attemptId: "att-1",
    bindingId: "bind-1",
    preview: [
      {
        safeInput: { state: "projected", text: "What is the refund policy?" },
        referenceOutput: { state: "omitted", reason: "credential" },
        toolFixtures: { state: "projected", value: { kb: { hits: 3 } } },
        sourceRunId: "run-9",
        sourceAttemptId: "att-1",
        sourceBindingId: "bind-1",
      },
    ],
    canaryFindings: 1,
  };
}

function savedBody(
  overrides: Partial<SavedDatasetVersionResult> = {},
): SavedDatasetVersionResult {
  return {
    datasetId: "ds-1",
    datasetName: "Support replies",
    version: {
      id: "v-3",
      contentHash: `c${"2".repeat(63)}`,
      redactionPolicyVersion: "opik-redaction/5",
      caseCount: 1,
      createdAt: "2026-10-16T10:00:00.000Z",
    },
    replayed: false,
    canaryFindings: 1,
    ...overrides,
  };
}

/*
 * The pages in a router of two real paths — the evaluations page and the dataset detail it
 * links to — rather than the generated tree, whose _authed layout mounts the CopilotKit
 * runtime the page has nothing to say to. The full-tree guarantees (the URL sits under
 * /_authed, so a typed-in address walks the session guard) are pinned by
 * ai-observability-routes.test.tsx.
 *
 * The provider is the real singleton, because the save mutation's invalidation reaches it:
 * a fresh client per draw would sever exactly the refresh this ticket must show.
 */
function draw(initial = "/bots/agent-1/evaluations") {
  const rootRoute = createRootRoute();
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId/evaluations",
    component: function TestDatasetsPage() {
      const { agentId } = listRoute.useParams();
      /*
       * The datasets section as the evaluations page mounts it (the Bot frame lives on
       * ObservationEvaluationsPage, whose tests are the experiments file's) — the
       * body is the mountable unit without the authenticated runtime.
       */
      return <ObservationDatasetsBody botId={agentId} />;
    },
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId/evaluations/$datasetId",
    component: function TestDetailPage() {
      const { agentId, datasetId } = detailRoute.useParams();
      return (
        <ObservationDatasetDetailPage agentId={agentId} datasetId={datasetId} />
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

/** Facts are joined into description lines, so they are read off the page text. */
function pageText(view: { container: HTMLElement }) {
  return view.container.textContent ?? "";
}

type Drawn = ReturnType<typeof draw> & {
  router: { state: { location: { pathname: string } } };
};

/** The save dialog, opened from its entry row and driven to a completed review. */
async function openReviewedDialog(view: ReturnType<typeof draw>) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(
    await view.findByRole("button", { name: /Save a case from a run/ }),
  );
  const dialog = await view.findByRole("dialog");
  await user.type(within(dialog).getByLabelText("Run id"), "run-9");
  await user.type(
    within(dialog).getByLabelText("Dataset name"),
    "Support replies",
  );
  await user.type(
    within(dialog).getByLabelText("Case input"),
    "What is the refund policy?",
  );
  await user.type(
    within(dialog).getByLabelText("Reference output"),
    "sk-live-refused",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Preview the freeze" }),
  );
  await waitFor(() =>
    expect(within(dialog).getByText("What will freeze")).toBeTruthy(),
  );
  return { user, dialog };
}

describe("datasets and versions are visible (acceptance 1)", () => {
  test("the list answers name, sync state, version count and latest time", async () => {
    listHandler = () =>
      Response.json(
        datasetsBody([
          datasetItem(),
          datasetItem({
            id: "ds-2",
            name: "Escalation notes",
            syncState: "failed",
            versionCount: 0,
            latestVersionAt: null,
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("Support replies"));
    expect(pageText(view)).toContain("Synced");
    expect(pageText(view)).toContain("2 versions");
    expect(pageText(view)).toContain("Escalation notes");
    expect(pageText(view)).toContain("Sync failed");
    expect(pageText(view)).toContain("No frozen version yet");
    // Every read is scoped to the Bot: the URL carries the botId (acceptance 6).
    expect(requested).toContain("/api/ai-observability/bots/agent-1/datasets");
  });

  test("a list row links to its detail page, and the keyboard can follow it", async () => {
    listHandler = () => Response.json(datasetsBody([datasetItem()]));
    const view = draw() as Drawn;
    const link = await view.findByRole("link", { name: /Support replies/ });
    expect(link.getAttribute("href")).toBe("/bots/agent-1/evaluations/ds-1");
    const user = userEvent.setup({ document: view.container.ownerDocument });
    link.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        "/bots/agent-1/evaluations/ds-1",
      ),
    );
  });

  test("the detail page answers the version history: hash, time, cases, policy, newest first", async () => {
    const view = draw("/bots/agent-1/evaluations/ds-1");
    await waitFor(() => expect(pageText(view)).toContain(HASH_NEWEST));
    expect(pageText(view)).toContain(HASH_OLDEST);
    expect(pageText(view)).toContain("opik-redaction/5");
    expect(pageText(view)).toContain("1 case");
    expect(pageText(view)).toContain("2 cases");
    // Newest first: the newer hash always reads before the older one.
    expect(pageText(view).indexOf(HASH_NEWEST)).toBeLessThan(
      pageText(view).indexOf(HASH_OLDEST),
    );
    expect(
      requested.includes("/api/ai-observability/bots/agent-1/datasets/ds-1"),
    ).toBe(true);
  });
});

describe("immutability is what the UI says (acceptance 2)", () => {
  test("the version history offers no edit affordance and says why", async () => {
    const view = draw("/bots/agent-1/evaluations/ds-1");
    await waitFor(() => expect(pageText(view)).toContain(HASH_NEWEST));
    // Read-only means read-only: no control that could edit, delete or mint a version —
    // the only buttons the shell knows (navigation) never touch content.
    expect(
      view.queryByRole("button", {
        name: /save|edit|delete|remove|add|create|new|update/i,
      }),
    ).toBeNull();
    // And the section states the discipline beside the rows.
    expect(pageText(view)).toContain("immutable snapshot");
    expect(pageText(view)).toContain("never editable");
  });
});

describe("the save flow answers every step (acceptance 3)", () => {
  test("review projects the case once and shows the canary count", async () => {
    const view = draw();
    listHandler = () => Response.json(datasetsBody([]));
    const { dialog } = await openReviewedDialog(view);
    const text = dialog.textContent ?? "";
    expect(text).toContain("What is the refund policy?");
    // The refused reference output reads as omitted, never as the typed secret.
    expect(text).toContain("Reference output: Omitted");
    expect(text).toContain('{"kb":{"hits":3}}');
    expect(text).toContain(
      "1 case came back with parts the redaction policy refused",
    );
    expect(requested.some((url) => url.endsWith("/case-review/review"))).toBe(
      true,
    );
  });

  test("editing after the review retires the preview and refuses to save it", async () => {
    const view = draw();
    listHandler = () => Response.json(datasetsBody([]));
    const { user, dialog } = await openReviewedDialog(view);
    await user.type(within(dialog).getByLabelText("Case input"), " more");
    await waitFor(() =>
      expect(within(dialog).getByText(/Preview the freeze first/)).toBeTruthy(),
    );
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Save version",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("save freezes, refreshes the list, and the replay says it hit the same version", async () => {
    let listCalls = 0;
    listHandler = () => {
      listCalls += 1;
      return Response.json(
        listCalls <= 1
          ? datasetsBody([])
          : datasetsBody([datasetItem({ versionCount: 1 })]),
      );
    };
    saveHandler = () => Response.json(savedBody());
    const view = draw();
    const { user, dialog } = await openReviewedDialog(view);
    await user.click(
      within(dialog).getByRole("button", { name: "Save version" }),
    );
    await waitFor(() =>
      expect(within(dialog).getByText(/Frozen as a new version/)).toBeTruthy(),
    );
    expect(dialog.textContent ?? "").toContain(`c${"2".repeat(63)}`);
    expect(within(dialog).getByText("1 case frozen.")).toBeTruthy();
    // The save invalidates the list: the store is asked again and the new row arrives.
    await waitFor(() => expect(listCalls).toBeGreaterThan(1));
  });

  test("a replayed save says it hit the same version and created nothing", async () => {
    saveHandler = () => Response.json(savedBody({ replayed: true }));
    const view = draw();
    listHandler = () => Response.json(datasetsBody([]));
    const { user, dialog } = await openReviewedDialog(view);
    await user.click(
      within(dialog).getByRole("button", { name: "Save version" }),
    );
    await waitFor(() =>
      expect(within(dialog).getByText(/already saved/)).toBeTruthy(),
    );
    expect(within(dialog).getByText(/Nothing new was created/)).toBeTruthy();
    // The same version hash the first save would have returned is the one shown.
    expect(dialog.textContent ?? "").toContain(`c${"2".repeat(63)}`);
  });

  test("refusal codes from the review and the save keep their own sentences", async () => {
    reviewHandler = () =>
      Response.json({ error: "CASE_REVIEW_RUN_NOT_FOUND" }, { status: 404 });
    const view = draw();
    listHandler = () => Response.json(datasetsBody([]));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(
      await view.findByRole("button", { name: /Save a case from a run/ }),
    );
    const dialog = await view.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Run id"), "run-404");
    await user.type(
      within(dialog).getByLabelText("Dataset name"),
      "Support replies",
    );
    await user.type(within(dialog).getByLabelText("Case input"), "x");
    await user.type(within(dialog).getByLabelText("Reference output"), "y");
    await user.click(
      within(dialog).getByRole("button", { name: "Preview the freeze" }),
    );
    expect(
      await within(dialog).findByText(
        "This Bot's records hold no run with that id. Nothing was saved.",
      ),
    ).toBeTruthy();

    reviewHandler = () => Response.json(reviewBody());
    saveHandler = () =>
      Response.json({ error: "DATASET_INPUT_INVALID" }, { status: 400 });
    await user.click(
      within(dialog).getByRole("button", { name: "Preview the freeze" }),
    );
    await waitFor(() =>
      expect(within(dialog).getByText("What will freeze")).toBeTruthy(),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Save version" }),
    );
    expect(
      await within(dialog).findByText(
        "The dataset name or the case is not valid. Nothing was saved.",
      ),
    ).toBeTruthy();
  });

  test("a store that does not answer the save says so, and saves nothing", async () => {
    saveHandler = () => new Response(null, { status: 500 });
    const view = draw();
    listHandler = () => Response.json(datasetsBody([]));
    const { user, dialog } = await openReviewedDialog(view);
    await user.click(
      within(dialog).getByRole("button", { name: "Save version" }),
    );
    expect(
      await within(dialog).findByText(
        "The observability store did not answer. Nothing was saved.",
      ),
    ).toBeTruthy();
  });

  test("a review or save the network layer never answers says so (OCR round 1 medium)", async () => {
    // The fetch-reject half of the write verdicts: a refusal envelope has its own
    // sentence, but a request that never answered at all used to leave the dialog
    // silent with its buttons re-armed. Both writes now reuse the same sentence.
    const view = draw();
    listHandler = () => Response.json(datasetsBody([]));
    const { user, dialog } = await openReviewedDialog(view);
    reviewHandler = () => {
      throw new TypeError("network down");
    };
    // Re-review after killing the wire: the retry starts from a clean slate.
    await user.click(
      within(dialog).getByRole("button", { name: "Preview the freeze" }),
    );
    expect(
      await within(dialog).findByText(
        "The observability store did not answer. Nothing was saved.",
      ),
    ).toBeTruthy();
    saveHandler = () => {
      throw new TypeError("network down");
    };
    await user.click(
      within(dialog).getByRole("button", { name: "Save version" }),
    );
    // The same sentence as the review refusal beside it, so the plural answer is
    // asserted for, not guessed between.
    const answers = await within(dialog).findAllByText(
      "The observability store did not answer. Nothing was saved.",
    );
    expect(answers.length).toBe(2);
  });

  test("a preview entry that is not a frozen case is refused, never rendered (OCR round 1 medium)", async () => {
    // The dialog reads preview[0].safeInput.state — an entry that lost its shape
    // used to crash it; the guard answers with the store-did-not-anter refusal.
    reviewHandler = () =>
      Response.json({ ...reviewBody(), preview: [{ nope: true }] });
    const view = draw();
    listHandler = () => Response.json(datasetsBody([]));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(
      await view.findByRole("button", { name: /Save a case from a run/ }),
    );
    const dialog = await view.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Run id"), "run-9");
    await user.type(within(dialog).getByLabelText("Dataset name"), "Refunds");
    await user.type(
      within(dialog).getByLabelText("Case input"),
      "What is the refund policy?",
    );
    await user.type(
      within(dialog).getByLabelText("Reference output"),
      "30 days.",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Preview the freeze" }),
    );
    expect(
      await within(dialog).findByText(
        "The observability store did not answer. Nothing was saved.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/What will freeze/)).toBeNull();
  });

  test("a save answer that lost its projected facts is refused (OCR round 1 medium)", async () => {
    // The success toast reads datasetName and version.contentHash/caseCount; a body
    // missing them is the store failing to answer, not a save to celebrate.
    saveHandler = () => Response.json({ version: {} });
    const view = draw();
    listHandler = () => Response.json(datasetsBody([]));
    const { user, dialog } = await openReviewedDialog(view);
    await user.click(
      within(dialog).getByRole("button", { name: "Save version" }),
    );
    expect(
      await within(dialog).findByText(
        "The observability store did not answer. Nothing was saved.",
      ),
    ).toBeTruthy();
  });
});

describe("the screen conditions stay distinct (acceptance 5)", () => {
  test("a truthful empty page says empty and still offers the save entry", async () => {
    listHandler = () => Response.json(datasetsBody([]));
    const view = draw();
    await view.findByText("No dataset versions yet");
    expect(
      view.getByRole("button", { name: /Save a case from a run/ }),
    ).toBeTruthy();
  });

  test("a disabled deployment says disabled, not empty", async () => {
    listHandler = () =>
      Response.json({ error: "capability_missing" }, { status: 503 });
    const view = draw();
    await view.findByText("Evaluation is off");
    expect(view.queryByText("No dataset versions yet")).toBeNull();
  });

  test("a management refusal says forbidden and draws no save entry", async () => {
    listHandler = () =>
      Response.json({ error: "OWNERSHIP_REQUIRED" }, { status: 403 });
    const view = draw();
    await view.findByText("You cannot manage this dataset");
    expect(
      view.queryByRole("button", { name: /Save a case from a run/ }),
    ).toBeNull();
  });

  test("an unreachable store says unavailable, never an empty list", async () => {
    listHandler = () => new Response(null, { status: 502 });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("No dataset versions yet")).toBeNull();
  });

  test("a dataset row that lost its readable facts says the store did not answer (OCR round 1 medium)", async () => {
    // The envelope guard alone passed a row missing versionCount/syncState through,
    // and the row rendered `sync.undefined`-style fragments instead of a fault.
    listHandler = () =>
      Response.json({ datasets: [{ id: "ds-1", name: "Refunds" }] });
    const view = draw();
    await view.findByText("Upstream unavailable");
    expect(view.queryByText("Refunds")).toBeNull();
  });
});

describe("content is text, never code (acceptance 7)", () => {
  test("a script payload in a projected value renders as literal text", async () => {
    const scripted = reviewBody();
    reviewHandler = () =>
      Response.json({
        ...scripted,
        preview: [
          {
            ...scripted.preview[0],
            safeInput: {
              state: "projected",
              text: "<script>alert(1)</script>",
            },
          },
        ],
      });
    const view = draw();
    listHandler = () => Response.json(datasetsBody([]));
    const { dialog } = await openReviewedDialog(view);
    const text = dialog.textContent ?? "";
    expect(text).toContain("<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
  });
});

/*
 * The T21-rev leftovers this ticket was asked to pin (F3/F4/F5): the two sync states
 * the list had no assertion for, the truncated branches of the projection markers,
 * and the pending title that used to flash the placeholder before the data arrived.
 */
describe("T21-rev pinned leftovers", () => {
  test("a syncing and a pending dataset row each keep their own sync word", async () => {
    listHandler = () =>
      Response.json(
        datasetsBody([
          // The row names avoid the sync words, so each word assertion can only be
          // satisfied by the sync column itself, never by the row's own name.
          datasetItem({
            id: "ds-s",
            name: "In-flight one",
            syncState: "syncing",
          }),
          datasetItem({
            id: "ds-p",
            name: "Queued one",
            syncState: "pending",
          }),
        ]),
      );
    const view = draw();
    await waitFor(() => expect(pageText(view)).toContain("In-flight one"));
    expect(pageText(view)).toContain("Syncing");
    expect(pageText(view)).toContain("Waiting to sync");
  });

  test("a truncated projected field shows its content with the truncated marker", async () => {
    const scripted = reviewBody();
    reviewHandler = () =>
      Response.json({
        ...scripted,
        preview: [
          {
            ...scripted.preview[0],
            safeInput: { state: "truncated", text: "What is the refund" },
            toolFixtures: { state: "truncated", value: { kb: { hits: 3 } } },
          },
        ],
      });
    const view = draw();
    listHandler = () => Response.json(datasetsBody([]));
    const { dialog } = await openReviewedDialog(view);
    const text = dialog.textContent ?? "";
    expect(text).toContain("What is the refund · Truncated");
    expect(text).toContain('{"kb":{"hits":3}} · Truncated');
  });

  test("a pending detail keeps its title blank rather than flashing a placeholder", async () => {
    detailHandler = () => new Promise<Response>(() => {});
    const view = draw("/bots/agent-1/evaluations/ds-1");
    // The read never settles: the honest name has not arrived, and no placeholder
    // stands in for it (T21-rev F5 — the title flashes blank, not "Dataset").
    await waitFor(() =>
      expect(view.container.querySelector("h1")?.textContent).toBe(""),
    );
  });
});
