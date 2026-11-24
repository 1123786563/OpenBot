import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import { Route as AuditRoute } from "@/routes/_authed/admin/audit";
import { seedAuditPage } from "./seed-audit-page";

beforeAll(() => GlobalRegistrator.register());

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

afterAll(() => GlobalRegistrator.unregister());

async function exportWith(headers: Record<string, string>, query = "") {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response("id\n", {
        headers: { "content-type": "text/csv", ...headers },
      });
    },
    { preconnect: realFetch.preconnect },
  );
  URL.createObjectURL = () => "blob:audit";
  URL.revokeObjectURL = () => {};
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  seedAuditPage(queryClient, "", { events: [] });
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    routeTree: createRootRoute({ component: AuditRoute.options.component }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const input = await view.findByRole("searchbox", { name: "Search events" });
  const user = userEvent.setup({ document });
  if (query) await user.type(input, query);
  const label = query ? "Export CSV without search" : "Export CSV";
  const button = view.getByRole("button", { name: label });
  if (query) {
    const description = (button.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(description).toContain("including older events");
    expect(description).toContain("Text search applies to loaded events.");
  }
  await user.click(button);
  await view.findByRole("button", { name: label });
  return { view, requests };
}

// A file that stopped at the cap reads as the whole trail unless the page says otherwise.
test("an export that stopped at the cap says how much the file holds", async () => {
  const { view } = await exportWith({ "x-audit-export-truncated": "5000" });
  const notice = await view.findByText(/The file has the newest/);
  expect(notice.getAttribute("role")).toBe("status");
  expect(notice.textContent).toContain("newest 5,000 events");
});

test("a whole export says nothing extra", async () => {
  const { view } = await exportWith({});
  expect(view.queryByText(/The file has the newest/)).toBeNull();
});

test("the export action states the broader scope while text search is active", async () => {
  const { requests } = await exportWith(
    {},
    "word missing from the loaded rows",
  );
  expect(requests.filter((url) => url.includes("format=csv"))).toEqual([
    "/api/admin/audit-events?format=csv",
  ]);
});
