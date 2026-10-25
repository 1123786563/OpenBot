import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryAnswerBasisSection } from "@/components/memory/answer-basis";
import { MemoryCleanupSection } from "@/components/memory/cleanup-progress";
import { JudgmentReviewSections } from "@/components/memory/judgment-review";
import { storeSelection } from "@/lib/enterprise/tenant/selection";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → Memory, the Hindsight half (FR-4 + FIX-W12): judgment candidates with their
 * complete basis, the three review decisions, the adopted group the SERVER lists across
 * sessions, the answer-basis listing with its expansion and correct/forget actions, and the
 * cleanup picture's two states.
 *
 * The fetches here ride the scope the screen holds (MT089's family, FR2-1): the default serving
 * seeds a stored company/team selection, so the requests carry the selection pair the production
 * resolver demands — and the no-selection test pins the fail-closed refusal.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** One open candidate (#389): the claim, its provenance, and two basis entries it cites. */
const candidate = {
  id: "j1",
  content: "Prefers written summaries over calls.",
  provenance: "Derived from your memories",
  scope: { kind: "general" },
  reviewState: "unreviewed",
  proposedAt: "2026-10-24T09:00:00Z",
  evidence: [
    {
      kind: "preference",
      id: "p1",
      content: "I prefer written summaries.",
      provenance: "You told a Bot",
      markedGenericAt: "2026-10-20T10:00:00Z",
      effectiveFrom: "2026-10-20T10:00:00Z",
      effectiveUntil: null,
    },
    {
      kind: "source_bound",
      id: "s1",
      content: "Shared a doc titled Quarterly.",
      provenance: "Google Drive",
      restriction: { kind: "source", sourceId: "src1" },
      formedAt: "2026-10-21T08:00:00Z",
    },
  ],
};

/** The honest forget answer (#390): stopped now, remote cleanup tracked, never "cleared". */
const revocation = {
  stoppedUsingAt: "2026-10-25T10:00:01Z",
  remoteDeletion: { attempted: true, outstanding: 0 },
  summary: "This memory stopped being used immediately.",
};

/** What the evidence seam answers per id (#387): available in full, or unavailable, nothing else. */
let evidence: Record<string, Record<string, unknown>>;
/** The candidate rows the listing holds; a decision removes the row. */
let candidates: Record<string, unknown>[];
/** The adopted rows the server listing holds (#389, FR2-3); it outlives any one page. */
let adopted: Record<string, unknown>[];
/** The memory entries the answer-basis listing holds (FR2-3). */
let memoryEntries: Record<string, unknown>[];
/** The cleanup picture; "Check now" flips it to the fully evidenced state. */
let cleanupStatus: Record<string, unknown>;
/** Every request the surface made, with the headers it rode — the selection pair's evidence. */
let seen: { method: string; url: string; headers: Record<string, string> }[];

const notCleared = () => ({
  controlledCopiesCleared: false,
  summary: null,
  externalModelLogs: {
    coveredByThisClaim: false,
    note: "Logs kept by external model providers are not controlled copies.",
  },
  activeData: {
    cleared: false,
    documents: 2,
    outstanding: 0,
    unverified: 1,
    resurrected: 0,
    observedAt: "2026-10-24T12:00:00Z",
    blockedByOpenRestore: false,
  },
  finishedTaskPayloads: {
    cleared: false,
    checked: true,
    retentionDays: 30,
    banksChecked: 1,
    beyondWindow: 1,
    reason: null,
  },
  controlledBackups: {
    cleared: false,
    registered: 1,
    outstanding: 2,
    oldestOutstandingTakenAt: "2026-10-18T00:00:00Z",
  },
  computedAt: "2026-10-25T00:00:00Z",
});

const cleared = () => ({
  ...notCleared(),
  controlledCopiesCleared: true,
  summary: "All controlled copies are cleared.",
  activeData: {
    ...notCleared().activeData,
    cleared: true,
    unverified: 0,
  },
  finishedTaskPayloads: {
    ...notCleared().finishedTaskPayloads,
    cleared: true,
    beyondWindow: 0,
  },
  controlledBackups: {
    ...notCleared().controlledBackups,
    cleared: true,
    outstanding: 0,
  },
});

const writes: { request: string; body: unknown }[] = [];

/** One adopted judgment, exactly as the confirm or edit answer carries it. */
const adoptedJudgment = (
  id: string,
  content: string,
  state: "confirmed" | "edited",
  provenance = "Derived from your memories",
) => ({
  id,
  content,
  provenance,
  scope: { kind: "general" },
  reviewState: state,
  reviewedAt: "2026-10-25T10:00:00Z",
  evidence: candidate.evidence,
});

function serving() {
  writes.length = 0;
  seen = [];
  candidates = [structuredClone(candidate)];
  adopted = [];
  memoryEntries = [];
  cleanupStatus = notCleared();
  window.localStorage.clear();
  storeSelection("user-1", { tenantId: "t1", workspaceId: "w1" });
  evidence = {
    p1: {
      state: "available",
      kind: "preference",
      id: "p1",
      content: "I prefer written summaries.",
      provenance: "You told a Bot",
      markedGenericAt: "2026-10-20T10:00:00Z",
      effectiveFrom: "2026-10-20T10:00:00Z",
      effectiveUntil: null,
      supersededBy: null,
      supersededTimeUnknown: false,
      correctedAt: null,
      actions: ["correct", "forget"],
    },
    // The revocation already landed: the seam answers unavailable, with no content to infer.
    s1: { state: "unavailable", id: "s1" },
  };
  cleanupStatus = notCleared();
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ method, url, headers });
    if (method !== "GET") {
      writes.push({ request: `${method} ${url}`, body });
    }
    if (url === "/api/me") return Response.json({ user: { id: "user-1" } });
    // The resolver's own refusal (FR2-1's fail-closed half): no selection, no answer.
    if (
      url.startsWith("/api/hindsight") &&
      !headers["x-openbot-tenant"] &&
      !headers["x-openbot-workspace"]
    ) {
      return Response.json(
        { error: "Select the company and workspace first." },
        { status: 400 },
      );
    }
    if (url === "/api/hindsight/judgments/candidates") {
      return Response.json({ candidates });
    }
    if (url === "/api/hindsight/judgments/adopted") {
      return Response.json({ adopted });
    }
    if (url === "/api/hindsight/memories") {
      return Response.json({ memories: memoryEntries });
    }
    if (url === "/api/hindsight/evidence") {
      return Response.json({
        evidence: body.ids.map(
          (id: string) => evidence[id] ?? { state: "unavailable", id },
        ),
      });
    }
    if (url === "/api/hindsight/judgments/j1/confirm") {
      candidates = [];
      adopted = [
        adoptedJudgment(
          "j1",
          "Prefers written summaries over calls.",
          "confirmed",
        ),
        ...adopted,
      ];
      return Response.json({
        judgment: adoptedJudgment(
          "j1",
          "Prefers written summaries over calls.",
          "confirmed",
        ),
        remoteSynced: false,
      });
    }
    if (url === "/api/hindsight/judgments/j1" && method === "PATCH") {
      candidates = [];
      adopted = [
        adoptedJudgment("j1", body.content as string, "edited"),
        ...adopted.filter((held) => held.id !== "j1"),
      ];
      return Response.json({
        judgment: adoptedJudgment("j1", body.content as string, "edited"),
        remoteSynced: false,
      });
    }
    if (url === "/api/hindsight/judgments/j1/reject") {
      candidates = [];
      return Response.json({
        judgment: { id: "j1", reviewState: "rejected" },
      });
    }
    if (url === "/api/hindsight/judgments/j1" && method === "DELETE") {
      adopted = adopted.filter((held) => held.id !== "j1");
      return Response.json(revocation);
    }
    if (url === "/api/hindsight/evidence/p1/correction") {
      return Response.json({ ok: true });
    }
    if (url === "/api/memory/hindsight/preferences/p1" && method === "DELETE") {
      evidence.p1 = { state: "unavailable", id: "p1" };
      return Response.json(revocation);
    }
    if (url === "/api/memory/hindsight/preferences/p9" && method === "DELETE") {
      memoryEntries = [];
      return Response.json(revocation);
    }
    if (url === "/api/hindsight/cleanup") {
      return Response.json(cleanupStatus);
    }
    if (url === "/api/hindsight/cleanup/verify") {
      cleanupStatus = cleared();
      return Response.json({ outcomes: [], backupRegistration: null });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

/**
 * FR2-1's contract: the open scope's selection pair rides every read and write — the reviewed
 * headers the production resolver demands — and nothing beyond the pair ever rides one.
 */
test("the hindsight reads and writes ride the open scope's selection pair", async () => {
  serving();
  const view = draw(<JudgmentReviewSections />);
  await view.findByText(/Prefers written summaries over calls/);
  fireEvent.click(view.getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/hindsight/judgments/j1/confirm",
      body: undefined,
    }),
  );
  const rode = seen.filter((call) => call.url.startsWith("/api/hindsight"));
  expect(rode.length).toBeGreaterThanOrEqual(3);
  for (const call of rode) {
    expect(call.headers["x-openbot-tenant"]).toBe("t1");
    expect(call.headers["x-openbot-workspace"]).toBe("w1");
    // The pair selects and nothing else: no principal, no bank, no other identity rides along.
    expect(
      Object.keys(call.headers).filter((name) => name.startsWith("x-openbot-")),
    ).toEqual(["x-openbot-tenant", "x-openbot-workspace"]);
  }
});

/** FR2-1's fail-closed half: the personal context selects nothing, and the resolver refuses. */
test("with no company selected the surface answers the resolver's own sentence", async () => {
  serving();
  window.localStorage.clear();
  const view = draw(<JudgmentReviewSections />);
  const refusals = await view.findAllByText(
    "Select the company and workspace first.",
  );
  expect(refusals.length).toBeGreaterThanOrEqual(1);
  const asked = seen.find(
    (call) => call.url === "/api/hindsight/judgments/candidates",
  );
  expect(asked).toBeDefined();
  expect(asked?.headers["x-openbot-tenant"]).toBeUndefined();
  expect(asked?.headers["x-openbot-workspace"]).toBeUndefined();
});

test("a candidate shows its judgment text and where it came from", async () => {
  serving();
  const view = draw(<JudgmentReviewSections />);
  expect(
    await view.findByText("Prefers written summaries over calls."),
  ).toBeTruthy();
  expect(view.getByText(/Derived from your memories/)).toBeTruthy();
});

test("confirming a candidate adopts it into the confirmed list", async () => {
  serving();
  const view = draw(<JudgmentReviewSections />);
  fireEvent.click(await view.findByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/hindsight/judgments/j1/confirm",
      body: undefined,
    }),
  );
  // The settle re-reads the listing, so the candidate is gone...
  expect(
    await view.findByText("No judgments are waiting for review."),
  ).toBeTruthy();
  // ...and the confirm's own answer moved into the adopted group.
  expect(
    view.getAllByText("Prefers written summaries over calls."),
  ).toHaveLength(1);
  expect(view.getByText("Confirmed judgments")).toBeTruthy();
});

test("editing sends only the words, and the adopted judgment carries the edit", async () => {
  serving();
  const view = draw(<JudgmentReviewSections />);
  fireEvent.click(await view.findByRole("button", { name: "Edit" }));
  const user = userEvent.setup({ document });
  const field = (await view.findByRole("textbox", {
    name: "Judgment",
  })) as HTMLTextAreaElement;
  await user.type(field, " Short.");
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  // Exactly the words ride the PATCH: no evidence, no scope, nothing else.
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "PATCH /api/hindsight/judgments/j1",
      body: { content: "Prefers written summaries over calls. Short." },
    }),
  );
  expect(
    await view.findByText("Prefers written summaries over calls. Short."),
  ).toBeTruthy();
  expect(view.getByText(/Edited /)).toBeTruthy();
});

test("rejecting closes the candidate", async () => {
  serving();
  const view = draw(<JudgmentReviewSections />);
  fireEvent.click(await view.findByRole("button", { name: "Reject" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/hindsight/judgments/j1/reject",
      body: undefined,
    }),
  );
  expect(
    await view.findByText("No judgments are waiting for review."),
  ).toBeTruthy();
});

/**
 * FR2-3's cross-session half (#389): the adopted group is the SERVER's listing, so a reload —
 * a fresh cache, the page state gone — still shows the judgments the person stood behind.
 */
test("the adopted group survives a reload", async () => {
  serving();
  candidates = [];
  adopted = [
    adoptedJudgment("j1", "Prefers written summaries over calls.", "confirmed"),
    adoptedJudgment(
      "j2",
      "Weekly reports go out on Fridays.",
      "edited",
      "Derived from a team source",
    ),
  ];
  const first = draw(<JudgmentReviewSections />);
  expect(
    await first.findByText("Weekly reports go out on Fridays."),
  ).toBeTruthy();
  expect(first.getByText("Prefers written summaries over calls.")).toBeTruthy();
  // A reload: the page's own state is gone, the server listing is what answers.
  cleanup();
  const second = draw(<JudgmentReviewSections />);
  expect(
    await second.findByText("Prefers written summaries over calls."),
  ).toBeTruthy();
  expect(second.getByText("Weekly reports go out on Fridays.")).toBeTruthy();
  expect(second.getByText(/Edited /)).toBeTruthy();
});

/**
 * FR2-5 beside FR2-3: forgetting the LAST adopted judgment still leaves the honest "stopped"
 * sentence on the page, beside the empty state — the note is not the list's to swallow.
 */
test("forgetting the last adopted judgment keeps the stopped note beside the empty state", async () => {
  serving();
  adopted = [
    adoptedJudgment("j1", "Prefers written summaries over calls.", "confirmed"),
  ];
  const view = draw(<JudgmentReviewSections />);
  fireEvent.click(await view.findByRole("button", { name: "Forget" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "DELETE /api/hindsight/judgments/j1",
      body: undefined,
    }),
  );
  expect(await view.findByText(/Stopped using this memory/)).toBeTruthy();
  expect(
    await view.findByText("None yet. Confirm a judgment and it appears here."),
  ).toBeTruthy();
});

/**
 * FR2-3's answer-basis half (#387 AC1/AC2): the memory entries a Bot's answers read list with
 * their basis expansion, and the expansion's forget closes the loop — the entry leaves the
 * listing, and the honest two-part status is what stays on the page.
 */
test("a memory entry expands its basis and forgets from the expansion", async () => {
  serving();
  memoryEntries = [
    {
      kind: "preference",
      id: "p9",
      content: "Prefers written summaries over calls.",
      provenance: "You told a Bot",
      markedGenericAt: "2026-10-20T10:00:00Z",
      effectiveFrom: "2026-10-20T10:00:00Z",
      effectiveUntil: null,
    },
  ];
  evidence.p9 = {
    state: "available",
    kind: "preference",
    id: "p9",
    content: "Prefers written summaries over calls.",
    provenance: "You told a Bot",
    markedGenericAt: "2026-10-20T10:00:00Z",
    effectiveFrom: "2026-10-20T10:00:00Z",
    effectiveUntil: null,
    supersededBy: null,
    supersededTimeUnknown: false,
    correctedAt: null,
    actions: ["correct", "forget"],
  };
  const view = draw(<MemoryAnswerBasisSection />);
  expect(
    await view.findByText("Prefers written summaries over calls."),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Basis" }));
  const dialog = await view.findByRole("dialog", { name: "Basis" });
  expect(dialog.textContent).toContain("You told a Bot");
  fireEvent.click(view.getByRole("button", { name: "Forget" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "DELETE /api/memory/hindsight/preferences/p9",
      body: undefined,
    }),
  );
  expect(await view.findByText(/Stopped using this memory/)).toBeTruthy();
  expect(
    await view.findByText(
      "Nothing here yet. Memories your Bots confirm appear with their basis.",
    ),
  ).toBeTruthy();
});

test("the basis expands; a basis the person can no longer see draws unavailable, never content", async () => {
  serving();
  const view = draw(<JudgmentReviewSections />);
  fireEvent.click(await view.findByRole("button", { name: "Basis (2)" }));
  const dialog = await view.findByRole("dialog", { name: "Basis" });
  expect(dialog.textContent).toContain("I prefer written summaries.");
  expect(dialog.textContent).toContain("You told a Bot");
  expect(dialog.textContent).toContain("Unavailable");
  // The revoked source-bound basis shows nothing of what it held.
  expect(dialog.textContent).not.toContain("Shared a doc titled Quarterly.");
});

test("correcting a preference basis sends the correction entry", async () => {
  serving();
  const view = draw(<JudgmentReviewSections />);
  fireEvent.click(await view.findByRole("button", { name: "Basis (2)" }));
  fireEvent.click(await view.findByRole("button", { name: "Correct" }));
  const user = userEvent.setup({ document });
  const field = (await view.findByRole("textbox", {
    name: "Fact",
  })) as HTMLTextAreaElement;
  await user.type(field, " Voice notes now.");
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/hindsight/evidence/p1/correction",
      body: { content: "I prefer written summaries. Voice notes now." },
    }),
  );
});

test("forgetting a preference basis stops its use and the entry draws unavailable", async () => {
  serving();
  const view = draw(<JudgmentReviewSections />);
  fireEvent.click(await view.findByRole("button", { name: "Basis (2)" }));
  fireEvent.click(await view.findByRole("button", { name: "Forget" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "DELETE /api/memory/hindsight/preferences/p1",
      body: undefined,
    }),
  );
  // The honest two-part status (#390 AC3): stopped now, copies never claimed cleared.
  expect(await view.findByText(/Stopped using this memory/)).toBeTruthy();
  await waitFor(() =>
    expect(view.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2),
  );
});

test("a partially evidenced cleanup states what is left, never the claim", async () => {
  serving();
  const view = draw(<MemoryCleanupSection />);
  expect(await view.findByText("Not everything is cleared yet.")).toBeTruthy();
  expect(view.queryByText(/All controlled copies are cleared/)).toBeNull();
  expect(view.getByText("Deleted memories")).toBeTruthy();
  // One deletion unverified and one payload past its window; two backup copies outstanding.
  expect(view.getAllByText("1 to clear")).toHaveLength(2);
  expect(view.getByText("2 to clear")).toBeTruthy();
  expect(
    view.getByText(
      /Logs kept by model providers outside OpenBot aren't controlled copies/,
    ),
  ).toBeTruthy();
});

test("a fully evidenced cleanup shows the claim", async () => {
  serving();
  cleanupStatus = cleared();
  const view = draw(<MemoryCleanupSection />);
  expect(
    await view.findByText(/All controlled copies are cleared/),
  ).toBeTruthy();
  expect(view.queryByText("Not everything is cleared yet.")).toBeNull();
  expect(view.getAllByText("Cleared").length).toBe(3);
});

test("Check now re-probes, and the picture refreshes into the claim", async () => {
  serving();
  const view = draw(<MemoryCleanupSection />);
  await view.findByText("Not everything is cleared yet.");
  fireEvent.click(await view.findByRole("button", { name: "Check now" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/hindsight/cleanup/verify",
      body: undefined,
    }),
  );
  expect(
    await view.findByText(/All controlled copies are cleared/),
  ).toBeTruthy();
});
