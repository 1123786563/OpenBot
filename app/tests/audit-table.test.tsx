import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  type AuditEvent,
  botText,
  subjectText,
} from "@/components/audit/audit-cells";
import { AuditPage } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import {
  type AuditVocabulary,
  auditEventsQueryOptions,
  auditVocabularyQueryOptions,
} from "@/lib/audit/queries";
import { seedAuditPage } from "./seed-audit-page";

/**
 * Admin → Audit as a log viewer: one window tall, the table across the whole pane and the only thing
 * that scrolls, searchable and sortable by time, each row coloured by what
 * happened.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
// The filter test leaves a menu open; let React finish closing it before `window` goes away.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

test("audit access denial clears old pages and cursors across views", async () => {
  const originalFetch = globalThis.fetch;
  let status = 503;
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "Read failed" }, { status }),
    { preconnect: originalFetch.preconnect },
  );
  const cache = new QueryClient();
  const all = auditEventsQueryOptions();
  const blocked = auditEventsQueryOptions("?eventType=computer.action_denied");
  const vocabulary = auditVocabularyQueryOptions();
  const previousVocabulary: AuditVocabulary = {
    bots: [{ id: "bot-a", name: "Previously visible Bot" }],
    apps: [],
    people: [],
    tools: [],
    rules: [],
  };
  cache.setQueryData<AuditVocabulary | null>(
    vocabulary.queryKey,
    () => previousVocabulary,
  );
  const seed = { events: [], nextCursor: "older" };
  seedAuditPage(cache, "", seed);
  seedAuditPage(cache, "?eventType=computer.action_denied", seed);
  try {
    await expect(
      cache.fetchInfiniteQuery({ ...all, retry: false }),
    ).rejects.toThrow("Read failed");
    expect(cache.getQueryData(all.queryKey)?.pages).toEqual([seed]);

    status = 403;
    await expect(cache.fetchInfiniteQuery(all)).rejects.toThrow("Read failed");
    expect(cache.getQueryData(all.queryKey)?.pages).toEqual([]);
    expect(cache.getQueryData(blocked.queryKey)?.pageParams).toEqual([]);
    expect(cache.getQueryData(vocabulary.queryKey)).toBeNull();

    status = 503;
    await expect(
      cache.fetchInfiniteQuery({ ...blocked, retry: false }),
    ).rejects.toThrow("Read failed");
    expect(cache.getQueryData(blocked.queryKey)?.pages).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    cache.clear();
  }
});

function event(
  id: string,
  eventType: string,
  at: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType: "computer",
    targetId: "bot-a",
    payload: { bot: "bot-a", ...payload },
    createdAt: at,
  };
}

const ROWS = [
  event("e1", "computer.action_allowed", "2026-10-27T09:00:00Z", {
    action: "computer_click",
    element: { name: "Save deal", role: "button" },
  }),
  event("e2", "computer.action_refused", "2026-10-27T10:00:00Z", {
    action: "computer_navigate",
    element: "https://evil.test",
  }),
  event("e3", "computer.action_failed", "2026-10-27T08:00:00Z", {
    action: "computer_type",
    element: { name: "Notes", role: "textbox" },
  }),
];

async function renderAudit(
  sections?: ReactNode,
  firstPage: Parameters<typeof seedAuditPage>[2] = { events: ROWS },
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  seedAuditPage(queryClient, "", firstPage);
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <AuditPage>{sections}</AuditPage>,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  if (firstPage.events.length) await view.findByText("Decision");
  return view;
}

test("an empty audit page can still load older events if it has a cursor", async () => {
  const view = await renderAudit(undefined, {
    events: [],
    nextCursor: "older",
  });
  await view.findByRole("button", { name: "Show older events" });
  expect(
    view.getByText(
      "No events on the loaded pages. Older events are available.",
    ),
  ).toBeTruthy();
  expect(view.queryByText("No events match this filter yet.")).toBeNull();
});

const whats = (container: HTMLElement) =>
  [...container.querySelectorAll("tbody tr")].map(
    (row) => row.querySelector("[data-column=what] > div")?.textContent,
  );

test("the page fills the shell's panel and only the table scrolls", async () => {
  const view = await renderAudit();
  const heading = view.getByRole("heading", { name: "Audit" });
  const page = heading.closest(".overflow-hidden");
  expect(page).not.toBeNull();
  expect(page?.className).toContain("flex-1");
  expect(page?.className).toContain("min-h-0");
  expect(heading.closest(".max-w-3xl")).toBeNull();
  const scroller =
    view.queryByRole("region", { name: "Audit events" }) ??
    (view.container.querySelector(
      "[data-slot=table-container]",
    ) as HTMLElement);
  expect(scroller.className).toContain("overflow-auto");
  expect(scroller.className).toContain("flex-1");
  expect(scroller.contains(heading)).toBe(false);
});

test("newest first, and a press on When turns it oldest first", async () => {
  const view = await renderAudit();
  expect(whats(view.container)).toEqual([
    "Open a page",
    "Click on a page",
    "Fill in a field",
  ]);
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: /When/ }));
  await waitFor(() =>
    expect(whats(view.container)).toEqual([
      "Fill in a field",
      "Click on a page",
      "Open a page",
    ]),
  );
});

test("search narrows the rows already loaded, and says how many match", async () => {
  const view = await renderAudit();
  const user = userEvent.setup({ document });
  const input = view.getByRole("searchbox", { name: "Search events" });
  await user.type(input, "save deal");
  await waitFor(() =>
    expect(whats(view.container)).toEqual(["Click on a page"]),
  );
  expect(view.getByText("1 of 3 events")).toBeDefined();
  await user.clear(input);
  await user.type(input, "deal click");
  await waitFor(() =>
    expect(whats(view.container)).toEqual(["Click on a page"]),
  );
});

test("each row carries what happened, for its colour", async () => {
  const view = await renderAudit();
  const outcomes = [...view.container.querySelectorAll("tbody tr")].map((row) =>
    row.getAttribute("data-outcome"),
  );
  expect(outcomes).toEqual(["refused", "allowed", "did-not-happen"]);
});

test("a row about a Bot names it under Bot, not under On", () => {
  const routed = {
    ...event("e4", "channel.routed", "2026-10-27T11:00:00Z"),
    targetType: "agent",
    targetId: "general-assistant",
    payload: {
      chosen: "general-assistant",
      reason: "named by the person asking",
    },
  } as unknown as AuditEvent;
  const nameFor = (id: string) =>
    id === "general-assistant" ? "General Assistant" : id;
  expect(botText(routed, nameFor)).toBe("General Assistant");
  expect(subjectText(routed)).toBe("");
});

test("the Outcome button narrows the rows to the outcomes ticked", async () => {
  const view = await renderAudit();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /Outcome/ }));
  await user.click(
    await view.findByRole("menuitemcheckbox", { name: /Blocked/ }),
  );
  await waitFor(() => expect(whats(view.container)).toEqual(["Open a page"]));
  expect(view.getByText("1 of 3 events")).toBeTruthy();
});

test("recording history shares a page scroller with the bounded audit log", async () => {
  const view = await renderAudit(
    <section aria-label="Recorded commands">
      {Array.from({ length: 100 }, (_, i) => `Command ${i}`).map((command) => (
        <p key={command}>{command}</p>
      ))}
    </section>,
  );
  const recording = view.getByRole("region", { name: "Recorded commands" });
  const pageScroller = recording.closest(".overflow-y-auto");
  expect(pageScroller).not.toBeNull();
  const tableScroller = view.container.querySelector(
    "[data-slot=table-container]",
  );
  expect(pageScroller?.contains(tableScroller)).toBe(true);
  expect(tableScroller?.contains(recording)).toBe(false);
  expect(recording.textContent).toContain("Command 99");
});

test("the event log is a named keyboard stop for scrolling its table", async () => {
  const view = await renderAudit();
  const log = view.getByRole("region", { name: "Audit events" });
  expect(log.tabIndex).toBe(0);
  expect(log.contains(view.getByRole("table"))).toBe(true);
});
