import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryList, RememberFact } from "@/components/memory/memories";
import { MemoryPauseControlsSection } from "@/components/memory/pause-controls";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { settleReactWork } from "./settle-react-work";

/** Settings → Memory: what the person's Bots know about them, and which Bot learned it. */

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

const memory = (overrides: Record<string, unknown>) => ({
  id: "m1",
  content: "I prefer mornings.",
  provenance: "You told a Bot",
  sourceId: null,
  enabled: true,
  reviewState: "confirmed",
  formedBy: "person",
  formedByAgentId: null,
  sourceApp: null,
  sourceLink: null,
  observedAt: null,
  updatedAt: "2026-10-09T10:00:00Z",
  ...overrides,
});

const writes: { request: string; body: unknown }[] = [];
/** A refusal the server gives the next write, or none. */
let refuseWrite: string | null = null;
/** The pause switches' state the server holds, or null where no face is mounted (#392). */
let pauseControls: {
  learningPausedAt: string | null;
  usagePausedAt: string | null;
} | null = { learningPausedAt: null, usagePausedAt: null };
/** Whether the deployment mounts the pause switches' face at all (#392). */
let pauseMounted = true;
/** Whether the read answers the resolver's "no company selected" (400) instead (#392). */
let pauseNoCompany = false;
/**
 * One subject's sync status, keyed `${subjectType}/${subjectId}`; a subject the batched read
 * does not answer draws no badge (#384). The list reads them all through one batched request.
 */
let syncStates: Record<string, Record<string, unknown>> = {};
/** Every status-face request the surface made, for the batching assertions (FIX-OCR1 / #376). */
let statusReads: { method: string; url: string }[] = [];
/** A refusal the status face gives the next batched read, or none (the 越权 regression). */
let refuseStatusRead = false;
function serving() {
  writes.length = 0;
  refuseWrite = null;
  pauseControls = { learningPausedAt: null, usagePausedAt: null };
  pauseMounted = true;
  pauseNoCompany = false;
  syncStates = {};
  statusReads = [];
  refuseStatusRead = false;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // The scoped memory read (MT089) waits for the scope source before it asks anything.
    if (url === "/api/me") return Response.json({ user: { id: "user-1" } });
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        request: `${method} ${url}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      // The list's one batched badge read (FIX-OCR1 / #376): a POST, so it lands here. A
      // refused read (a selection the server's membership no longer backs) is the 越权
      // case: the badges answer nothing rather than drawing a made-up state.
      if (url === "/api/memory/hindsight/status/batch") {
        statusReads.push({ method, url });
        if (refuseStatusRead)
          return Response.json({ error: "Access denied." }, { status: 403 });
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as {
                subjects: { subjectType: string; subjectId: string }[];
              })
            : { subjects: [] };
        const statuses: Record<string, unknown> = {};
        for (const { subjectType, subjectId } of body.subjects) {
          const status = syncStates[`${subjectType}/${subjectId}`];
          if (status !== undefined)
            statuses[`${subjectType}:${subjectId}`] = status;
        }
        return Response.json({ statuses });
      }
      // A pause write lands, so the settle's re-read carries the new state back (#392).
      if (url === "/api/memory/pause-controls") {
        if (refuseWrite) {
          const error = refuseWrite;
          refuseWrite = null;
          return Response.json({ error }, { status: 400 });
        }
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as {
                learningPaused?: boolean;
                usagePaused?: boolean;
              })
            : {};
        const at = new Date().toISOString();
        if (pauseControls)
          pauseControls = {
            learningPausedAt:
              body.learningPaused === undefined
                ? pauseControls.learningPausedAt
                : body.learningPaused
                  ? at
                  : null,
            usagePausedAt:
              body.usagePaused === undefined
                ? pauseControls.usagePausedAt
                : body.usagePaused
                  ? at
                  : null,
          };
        return Response.json({ pauseControls });
      }
      if (refuseWrite) {
        const error = refuseWrite;
        refuseWrite = null;
        return Response.json({ error }, { status: 400 });
      }
      return Response.json({ ok: true });
    }
    if (url === "/api/memory/pause-controls") {
      // A deployment without the trusted-scope face answers 404, and the personal context
      // answers the resolver's own missing-selection code — both grey the screen out.
      if (pauseNoCompany)
        return Response.json({ error: "TENANT_REQUIRED" }, { status: 400 });
      return pauseMounted && pauseControls !== null
        ? Response.json({ pauseControls })
        : Response.json({ error: "Not found" }, { status: 404 });
    }
    if (url.startsWith("/api/memory/hindsight/status/")) {
      statusReads.push({ method, url });
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (url.startsWith("/api/agents")) {
      return Response.json({
        agents: [{ id: "expenses", name: "Expenses", mine: true }],
      });
    }
    return Response.json({
      memories: [
        memory({}),
        memory({
          id: "m2",
          content: "Receipts go to finance@.",
          formedBy: "bot",
          formedByAgentId: "expenses",
          sourceApp: "Gmail",
          reviewState: "unreviewed",
        }),
      ],
    });
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

test("a memory a Bot formed names the Bot that formed it", async () => {
  serving();
  const view = draw(<MemoryList />);
  expect(await view.findByText(/Formed by Expenses/)).toBeTruthy();
});

test("remembering a fact saves it", async () => {
  serving();
  const view = draw(<RememberFact />);
  const user = userEvent.setup({ document });
  // The form lives in a dialog behind the page's action, not on the page.
  fireEvent.click(view.getByRole("button", { name: "Remember a fact" }));
  await user.type(
    await view.findByRole("textbox", {
      name: "Something you want your Bots to know",
    }),
    "I work from Lisbon.",
  );
  fireEvent.click(view.getByRole("button", { name: "Remember" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/memory",
      body: { content: "I work from Lisbon." },
    }),
  );
});

test("each memory's switch is named for the memory it turns on or off", async () => {
  serving();
  const view = draw(<MemoryList />);
  expect(
    await view.findByRole("switch", {
      name: "Use this memory: I prefer mornings.",
    }),
  ).toBeTruthy();
  expect(
    view.getByRole("switch", {
      name: "Use this memory: Receipts go to finance@.",
    }),
  ).toBeTruthy();
});

test("reopening Remember a fact after a failure starts clean", async () => {
  serving();
  refuseWrite = "Memory is full.";
  const view = draw(<RememberFact />);
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Remember a fact" }));
  await user.type(
    await view.findByRole("textbox", {
      name: "Something you want your Bots to know",
    }),
    "I work from Lisbon.",
  );
  await user.click(view.getByRole("button", { name: "Remember" }));
  expect((await view.findByRole("alert")).textContent).toBe("Memory is full.");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(view.getByRole("button", { name: "Remember a fact" }));
  const field = (await view.findByRole("textbox", {
    name: "Something you want your Bots to know",
  })) as HTMLTextAreaElement;
  expect(field.value).toBe("");
  expect(view.queryByRole("alert")).toBeNull();
});

/*
 * The person's two pause switches (#392): both render from the server's own answer, each flip
 * sends exactly its patch, the settle re-reads the echo, and a deployment without the face
 * greys the rows out instead of reporting a fault.
 */

test("the pause switches show the server's own state", async () => {
  serving();
  pauseControls = {
    learningPausedAt: null,
    usagePausedAt: "2026-10-20T08:00:00Z",
  };
  const view = draw(<MemoryPauseControlsSection />);
  expect(
    (await view.findByRole("switch", { name: "Pause learning" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("false");
  const recall = view.getByRole("switch", { name: "Pause recall" });
  expect(recall.getAttribute("aria-checked")).toBe("true");
  // Pause recall keeps what the person confirmed; the note says so while it is on.
  expect(
    view.getByText("Confirmed memories are kept. Only recall is paused."),
  ).toBeTruthy();
});

test("turning pause learning on sends its patch and the switch echoes the answer", async () => {
  serving();
  const view = draw(<MemoryPauseControlsSection />);
  fireEvent.click(await view.findByRole("switch", { name: "Pause learning" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/memory/pause-controls",
      body: { learningPaused: true },
    }),
  );
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "Pause learning" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

test("turning pause recall off sends its own patch and nothing else", async () => {
  serving();
  pauseControls = {
    learningPausedAt: "2026-10-19T08:00:00Z",
    usagePausedAt: "2026-10-19T09:00:00Z",
  };
  const view = draw(<MemoryPauseControlsSection />);
  fireEvent.click(await view.findByRole("switch", { name: "Pause recall" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/memory/pause-controls",
      body: { usagePaused: false },
    }),
  );
  expect(writes).toHaveLength(1);
});

test("a deployment without the switches greys them out and says so", async () => {
  serving();
  pauseMounted = false;
  const view = draw(<MemoryPauseControlsSection />);
  const learning = await view.findByRole("switch", { name: "Pause learning" });
  expect(learning.hasAttribute("data-disabled")).toBe(true);
  expect(
    view
      .getByRole("switch", { name: "Pause recall" })
      .hasAttribute("data-disabled"),
  ).toBe(true);
  expect(
    view.getByText("These switches aren't available on this OpenBot."),
  ).toBeTruthy();
  fireEvent.click(learning);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(writes).toEqual([]);
});

test("the personal context greys the switches out and says what it needs", async () => {
  serving();
  pauseNoCompany = true;
  const view = draw(<MemoryPauseControlsSection />);
  const learning = await view.findByRole("switch", { name: "Pause learning" });
  expect(learning.hasAttribute("data-disabled")).toBe(true);
  expect(
    view.getByText("Choose a company to use these switches."),
  ).toBeTruthy();
  expect(
    view.queryByText("These switches aren't available on this OpenBot."),
  ).toBeNull();
});

/*
 * The sync badge (#384): the whole list asks the status surface ONCE and each row draws only
 * its own entry from the shared answer, so a subject the chain does not hold draws nothing
 * rather than a made-up "Synced" — and the page makes no request per memory (FIX-OCR1 / #376).
 */

test("a memory's sync badge maps the surface's answer", async () => {
  serving();
  syncStates = {
    "preference/m1": {
      state: "indexed",
      syncedAt: "2026-10-09T10:05:00Z",
    },
    "source_bound/m2": {
      state: "failed",
      attempts: 2,
      lastError: "service answered 500",
      willRetry: true,
    },
  };
  const view = draw(<MemoryList />);
  expect(await view.findByText(/Synced/)).toBeTruthy();
  expect(view.getByText("Sync failed")).toBeTruthy();
});

test("a waiting memory draws the waiting badge, and one the chain does not hold draws none", async () => {
  serving();
  syncStates = { "preference/m1": { state: "pending", attempts: 0 } };
  const view = draw(<MemoryList />);
  await view.findByText(/Formed by Expenses/);
  expect(view.getByText(/Waiting to sync/)).toBeTruthy();
  expect(view.queryByText(/Synced/)).toBeNull();
  expect(view.queryByText("Sync failed")).toBeNull();
});

test("a failed sync explains on click that the retry comes on its own", async () => {
  serving();
  syncStates = {
    "source_bound/m2": {
      state: "failed",
      attempts: 1,
      lastError: "service answered 503",
      willRetry: true,
    },
  };
  const view = draw(<MemoryList />);
  fireEvent.click(await view.findByText("Sync failed"));
  expect(
    await view.findByText(
      "This memory hasn't synced yet. OpenBot will retry it for you.",
    ),
  ).toBeTruthy();
});

test("the whole list's badges ride one batched read, not a request per memory", async () => {
  serving();
  syncStates = { "preference/m1": { state: "indexed", syncedAt: null } };
  const view = draw(<MemoryList />);
  await view.findByText(/Synced/);
  // Two memories on the list, one status-face request in total: the batched read carried
  // both rows' subjects, and no per-subject read went out beside it.
  expect(statusReads).toHaveLength(1);
  expect(statusReads[0]).toEqual({
    method: "POST",
    url: "/api/memory/hindsight/status/batch",
  });
});

test("a refused batched read draws no badges and reports no fault", async () => {
  serving();
  refuseStatusRead = true;
  const view = draw(<MemoryList />);
  // The rows still draw; the badges simply have no answer to show — a 403 from a
  // membership the server no longer backs is not the list's error to raise.
  expect(await view.findByText(/Formed by Expenses/)).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(view.queryByText(/Synced/)).toBeNull();
  expect(view.queryByText("Sync failed")).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
});
