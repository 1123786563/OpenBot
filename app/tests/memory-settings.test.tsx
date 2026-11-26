import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryList, RememberFact } from "@/components/memory/memories";
import {
  type MemoryRecord,
  memoriesQueryOptions,
  updateMemoryMutationOptions,
} from "@/lib/memory";
import { settleReactWork } from "./settle-react-work";

/** Settings → Memory: what the person's Bots know about them, and which Bot learned it. */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const memory = (overrides: Partial<MemoryRecord>): MemoryRecord => ({
  id: "m1",
  content: "I prefer mornings.",
  provenance: "You told a Bot",
  sourceId: null,
  enabled: true,
  reviewState: "confirmed",
  formedBy: "person",
  formedByAgentId: null,
  sourceApp: null,
  sourceRef: null,
  sourceLink: null,
  observedAt: null,
  updatedAt: "2026-10-09T10:00:00Z",
  ...overrides,
});

const writes: { request: string; body: unknown }[] = [];
/** A refusal the server gives the next write, or none. */
let refuseWrite: string | null = null;
function serving(extra: MemoryRecord[] = []) {
  writes.length = 0;
  refuseWrite = null;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        request: `${method} ${url}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (refuseWrite) {
        const error = refuseWrite;
        refuseWrite = null;
        return Response.json({ error }, { status: 400 });
      }
      return Response.json({ ok: true });
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
        ...extra,
      ],
    });
  }) as unknown as typeof fetch;
}

function draw(
  node: ReactNode,
  history = createMemoryHistory({
    initialEntries: ["/before", "/"],
    initialIndex: 1,
  }),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The draft dialogs read the navigation blocker, so they need a mounted router.
  const router = createRouter({
    history,
    routeTree: createRootRoute({ component: () => <>{node}</> }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { router });
}

test("a memory a Bot formed names the Bot that formed it", async () => {
  serving();
  const view = draw(<MemoryList />);
  expect(await view.findByText(/Learned by Expenses/)).toBeTruthy();
});

test("memory search and status filters narrow the list together", async () => {
  serving([
    memory({ id: "m3", content: "I prefer email receipts." }),
    memory({
      id: "m4",
      content: "I work from Lisbon.",
      reviewState: "unreviewed",
    }),
  ]);
  const view = draw(<MemoryList />);
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("searchbox", { name: "Search memories" }),
    "receipts",
  );
  await user.selectOptions(
    view.getByRole("combobox", { name: "Status" }),
    "review",
  );

  expect(view.getByText("1 of 4 memories match")).toBeTruthy();
  expect(view.getByText("Receipts go to finance@.")).toBeTruthy();
  expect(view.queryByText("I prefer email receipts.")).toBeNull();
  expect(view.queryByText("I work from Lisbon.")).toBeNull();
});

test("a failed memory read can be retried without leaving the page", async () => {
  serving();
  const serve = global.fetch;
  let unavailable = true;
  global.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) =>
      String(args[0]) === "/api/memory" && unavailable
        ? Response.json({ error: "Temporary outage" }, { status: 503 })
        : serve(...args),
    { preconnect: originalFetch.preconnect },
  );

  const view = draw(<MemoryList />);
  expect(await view.findByText("Couldn't load your memories.")).toBeTruthy();
  expect(view.queryByText("No memories yet")).toBeNull();
  unavailable = false;
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  expect(await view.findByText("I prefer mornings.")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("a saved memory survives a failed refresh until access is denied", async () => {
  const original = memory({});
  const edited: MemoryRecord = {
    ...original,
    content: "I prefer afternoons.",
    reviewState: "edited",
  };
  let status = 200;
  global.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return Response.json({ memory: edited });
      return status === 200
        ? Response.json({ memories: [original] })
        : Response.json({ error: "Read refused" }, { status });
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const query = memoriesQueryOptions();
  await client.fetchQuery(query);

  status = 503;
  const update = client
    .getMutationCache()
    .build(client, updateMemoryMutationOptions(client));
  await update.execute({
    id: "m1",
    input: { content: "I prefer afternoons." },
  });
  await expect(client.fetchQuery(query)).rejects.toThrow("Read refused");
  expect(client.getQueryData<MemoryRecord[]>(query.queryKey) ?? []).toEqual([
    edited,
  ]);

  status = 403;
  await expect(client.fetchQuery(query)).rejects.toThrow("Read refused");
  status = 503;
  await expect(client.fetchQuery(query)).rejects.toThrow("Read refused");
  expect(client.getQueryData<MemoryRecord[]>(query.queryKey)?.length).toBe(0);
});

test("remembering a fact saves it", async () => {
  serving();
  const view = draw(<RememberFact />);
  const user = userEvent.setup({ document });
  // The form lives in a dialog behind the page's action, not on the page.
  fireEvent.click(await view.findByRole("button", { name: "Remember a fact" }));
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

test("leaving a typed fact for another page asks first, and Keep editing keeps the text", async () => {
  serving();
  const view = draw(<RememberFact />);
  const user = userEvent.setup({ document });
  fireEvent.click(await view.findByRole("button", { name: "Remember a fact" }));
  const field = (await view.findByRole("textbox", {
    name: "Something you want your Bots to know",
  })) as HTMLTextAreaElement;
  await user.type(field, "I work from Lisbon.");

  // Browser Back reaches the same `history.block` through popstate; the memory history in this
  // harness only consults blockers on push, so push stands in for leaving the page.
  await act(async () => view.router.history.push("/before"));

  const leave = await view.findByRole("alertdialog", {
    name: "Leave without saving?",
  });
  await user.click(within(leave).getByRole("button", { name: "Keep editing" }));
  await waitFor(() =>
    expect(
      view.queryByRole("alertdialog", { name: "Leave without saving?" }),
    ).toBeNull(),
  );
  expect(view.router.state.location.pathname).toBe("/");
  expect(field.value).toBe("I work from Lisbon.");
});

test("browser Back protects an edited memory until the draft is discarded", async () => {
  serving();
  window.history.replaceState(null, "", "/before");
  const history = createBrowserHistory();
  try {
    history.push("/");
    history.flush();
    const view = draw(<MemoryList />, history);
    const user = userEvent.setup({ document });
    await user.click(
      await view.findByRole("button", {
        name: /^Edit memory: I prefer mornings/,
      }),
    );
    const field = await view.findByRole("textbox", { name: "Memory" });
    await user.type(field, " Especially Mondays.");

    await act(async () => window.history.back());
    const leave = await view.findByRole("alertdialog", {
      name: "Leave without saving?",
    });
    expect(view.router.state.location.pathname).toBe("/");
    await user.click(
      within(leave).getByRole("button", { name: "Discard changes" }),
    );

    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe("/before"),
    );
    expect(writes).toEqual([]);
  } finally {
    history.destroy();
    window.history.replaceState(null, "", "/");
  }
});

test("leaving a clean editor for another page does not ask", async () => {
  serving();
  const view = draw(<RememberFact />);
  fireEvent.click(await view.findByRole("button", { name: "Remember a fact" }));
  await view.findByRole("textbox", {
    name: "Something you want your Bots to know",
  });

  await act(async () => view.router.history.push("/before"));

  expect(
    view.queryByRole("alertdialog", { name: "Leave without saving?" }),
  ).toBeNull();
  await waitFor(() =>
    expect(view.router.state.location.pathname).toBe("/before"),
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

test("forgetting shows the whole fact, not a clipped opening", async () => {
  const long =
    "The quarterly planning meeting moved to the first Thursday of every month, and the Lisbon office joins remotely.";
  serving([memory({ id: "m3", content: long })]);
  const view = draw(<MemoryList />);
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", {
      name: `Forget memory: ${long.slice(0, 59)}…`,
    }),
  );
  const dialog = await view.findByRole("alertdialog", {
    name: "Forget this memory?",
  });
  expect(dialog.textContent).toContain(long);
  expect(dialog.textContent).not.toContain("…");
});

test("forgetting a fact a Bot learned names that Bot as the only one affected", async () => {
  serving();
  const view = draw(<MemoryList />);
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", {
      name: "Forget memory: Receipts go to finance@.",
    }),
  );
  const dialog = await view.findByRole("alertdialog");
  expect(dialog.textContent).toContain("Only Expenses uses it.");
  expect(dialog.textContent).not.toContain("All your Bots");
});

test("forgetting an imported fact names the source it came from", async () => {
  serving([
    memory({
      id: "m4",
      content: "The roadmap ships in May.",
      formedBy: "import",
      sourceId: "s1",
      sourceApp: "Receipts folder",
      provenance: "Receipts folder: Roadmap",
    }),
  ]);
  const view = draw(<MemoryList />);
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", {
      name: "Forget memory: The roadmap ships in May.",
    }),
  );
  const dialog = await view.findByRole("alertdialog");
  expect(dialog.textContent).toContain(
    "Only Bots reading Receipts folder use it.",
  );
  expect(dialog.textContent).not.toContain("All your Bots");
});

test("forgetting a fact of the person's own says every Bot of theirs is affected", async () => {
  serving();
  const view = draw(<MemoryList />);
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", {
      name: "Forget memory: I prefer mornings.",
    }),
  );
  const dialog = await view.findByRole("alertdialog");
  expect(dialog.textContent).toContain("All your Bots use it.");
});

test("forgetting a fact formed outside every Bot names all the person's Bots", async () => {
  serving([
    memory({
      id: "m5",
      content: "Uses vim keybindings.",
      formedBy: "intelligence",
      provenance: "OpenBot memory",
      sourceApp: "OpenBot memory",
    }),
  ]);
  const view = draw(<MemoryList />);
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", {
      name: "Forget memory: Uses vim keybindings.",
    }),
  );
  const dialog = await view.findByRole("alertdialog");
  expect(dialog.textContent).toContain("All your Bots use it.");
});

test("cancelling Forget returns focus to the Forget button it came from", async () => {
  serving();
  const view = draw(<MemoryList />);
  const user = userEvent.setup({ document });
  const opener = await view.findByRole("button", {
    name: "Forget memory: I prefer mornings.",
  });
  await user.click(opener);
  const dialog = await view.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(writes).toEqual([]);
  expect(document.activeElement).toBe(opener);
});

test("forgetting a memory requires confirmation and can retry a failed deletion", async () => {
  serving();
  const view = draw(<MemoryList />);
  const user = userEvent.setup({ document });
  const opener = await view.findByRole("button", {
    name: "Forget memory: I prefer mornings.",
  });
  await user.click(opener);
  let dialog = await view.findByRole("alertdialog", {
    name: "Forget this memory?",
  });
  expect(
    within(dialog).getByText(/I prefer mornings.*All your Bots use it/),
  ).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(writes).toEqual([]);

  refuseWrite = "The connection was interrupted.";
  await user.click(opener);
  dialog = await view.findByRole("alertdialog");
  await user.click(
    within(dialog).getByRole("button", { name: "Forget memory" }),
  );
  expect((await within(dialog).findByRole("alert")).textContent).toMatch(
    /Couldn't forget/,
  );
  await user.click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(writes.map(({ request }) => request)).toEqual([
    "DELETE /api/memory/m1",
    "DELETE /api/memory/m1",
  ]);
});

test("a failed fact stays in the editor until explicitly discarded", async () => {
  serving();
  refuseWrite = "Memory is full.";
  const view = draw(<RememberFact />);
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", { name: "Remember a fact" }),
  );
  await user.type(
    await view.findByRole("textbox", {
      name: "Something you want your Bots to know",
    }),
    "I work from Lisbon.",
  );
  await user.click(view.getByRole("button", { name: "Remember" }));
  expect((await view.findByRole("alert")).textContent).toBe("Memory is full.");
  await user.keyboard("{Escape}");
  let discard = await view.findByRole("alertdialog", {
    name: "Discard unsaved changes?",
  });
  await user.click(
    within(discard).getByRole("button", { name: "Keep editing" }),
  );
  expect(await view.findByDisplayValue("I work from Lisbon.")).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Cancel" }));
  discard = await view.findByRole("alertdialog", {
    name: "Discard unsaved changes?",
  });
  await user.click(
    within(discard).getByRole("button", { name: "Discard changes" }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(
    await view.findByRole("button", { name: "Remember a fact" }),
  );
  const field = (await view.findByRole("textbox", {
    name: "Something you want your Bots to know",
  })) as HTMLTextAreaElement;
  expect(field.value).toBe("");
  expect(view.queryByRole("alert")).toBeNull();
});

test("Memory settings explain why a Bot record without a verified source stays out of its context", async () => {
  serving();
  const view = draw(<MemoryList />);
  expect(
    await view.findByText(
      "Bots can’t use this memory because its source can’t be verified.",
    ),
  ).toBeTruthy();
});
