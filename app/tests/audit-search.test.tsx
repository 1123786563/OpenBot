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
import { AuditPage } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { seedAuditPage } from "./seed-audit-page";

/**
 * The Audit page's search box reaches older pages.
 *
 * The box narrows the rows already loaded, but a word on an older page is not in the browser. So
 * typing asks the server with `q`, and a row from an older page comes back and draws. These hold
 * the client half: that the request carries the word, and that a returned older row is shown.
 * `server/tests/audit-search.integration.test.ts` holds the database half.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function event(
  id: string,
  at: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: "bot-a",
    payload: { bot: "bot-a", ...payload },
    createdAt: at,
  };
}

const NEWEST = event("e-new", "2026-10-27T09:00:00Z", {
  action: "computer_click",
  element: { name: "Save deal", role: "button" },
});

const OLDER = event("e-old", "2026-10-01T09:00:00Z", {
  action: "computer_click",
  element: { name: "Needle in an older page", role: "button" },
  recordedMarker: "metadata-only-match",
});

function renderAudit() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  // The newest page holds only the row without the word, and says an older page exists.
  seedAuditPage(queryClient, "", { events: [NEWEST], nextCursor: "older" });
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AuditPage /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("typing a word only an older page holds asks the server and draws that row", async () => {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (!url.includes("/api/admin/audit-events")) return Response.json({});
      const q = new URL(url, "http://openbot.local").searchParams.get("q");
      return Response.json(
        q === "metadata-only-match" ? { events: [OLDER] } : { events: [] },
      );
    },
    { preconnect: realFetch.preconnect },
  );

  const view = renderAudit();
  await view.findByText("Decision");
  // The older row is not on the newest page.
  expect(view.container.textContent).not.toContain("Needle in an older page");

  await userEvent
    .setup({ document })
    .type(
      view.getByRole("searchbox", { name: "Search events" }),
      "metadata-only-match",
    );

  await waitFor(() =>
    expect(view.container.textContent).toContain("Needle in an older page"),
  );
  // The word was asked of the server, so the match is not limited to the loaded page.
  expect(requests.some((url) => url.includes("q=metadata-only-match"))).toBe(
    true,
  );
  expect(view.container.textContent).not.toContain("Save deal");
});
