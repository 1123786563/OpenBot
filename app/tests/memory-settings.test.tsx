import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
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
  sourceLink: null,
  observedAt: null,
  updatedAt: "2026-10-09T10:00:00Z",
  ...overrides,
});

const writes: { request: string; body: unknown }[] = [];
/** A refusal the server gives the next write, or none. */
let refuseWrite: string | null = null;
function serving() {
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
  expect(await view.findByText(/Learned by Expenses/)).toBeTruthy();
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
    within(dialog).getByText(/I prefer mornings.*Your Bots will stop using it/),
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
  await user.click(view.getByRole("button", { name: "Remember a fact" }));
  const field = (await view.findByRole("textbox", {
    name: "Something you want your Bots to know",
  })) as HTMLTextAreaElement;
  expect(field.value).toBe("");
  expect(view.queryByRole("alert")).toBeNull();
});
