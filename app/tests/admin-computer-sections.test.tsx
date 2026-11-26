import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  InactiveComputersSection,
  NetworkSection,
} from "@/components/admin/controls/computer-sections";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin, Computers: the Idle computers controls and the Network controls read one shared overview
 * read, so when that read fails the page keeps both sections' titles and puts one alert under the
 * first (Idle computers) that says it covers both, and the retry under that alert reads once and
 * restores both sections in place.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

/** What GET /api/admin/enterprise answers once the read recovers, as admin-network-describe stubs it. */
const OVERVIEW = {
  capabilities: [],
  settings: {
    ssoRequired: false,
    actionRecording: false,
    inactiveComputerDays: 30,
    modelAllowlist: { enabled: false, models: [] },
    mcpAllowlist: { enabled: false, servers: [] },
    skillSharing: false,
    proactiveDailyRuns: 24,
    modelSelection: false,
  },
  groups: [],
  network: [
    {
      scopeKind: "organization",
      scopeId: "",
      mode: "defaults_plus_allowlist",
      rules: [
        { type: "domain", value: "intranet.acme.example", ports: "8443" },
      ],
      locked: false,
      updatedBy: "admin@acme.test",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
  ],
  defaultDestinations: [
    "github.com",
    "githubusercontent.com",
    "ghcr.io",
    "registry.npmjs.org",
    "pypi.org",
  ],
  mcpServers: [],
  builtInModel: "openai/gpt-5.6-terra",
  scim: {
    configured: false,
    connectionId: "directory",
    baseUrl: null,
    rotating: false,
  },
  otel: { configured: false },
  actionRecordRetentionDays: 90,
};

let reads = 0;

function serving({ recovery }: { recovery: () => boolean }) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/api/admin/enterprise" && method === "GET") {
      reads += 1;
      return recovery()
        ? Response.json(OVERVIEW)
        : Response.json({ error: "Read denied" }, { status: 503 });
    }
    if (path.startsWith("/api/agents"))
      return Response.json({ agents: [{ id: "ops-bot", name: "Ops Bot" }] });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

async function openPage() {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <>
          <InactiveComputersSection />
          <NetworkSection />
        </>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("one alert names both sections, one retry restores both, and both titles stay", async () => {
  let recovered = false;
  reads = 0;
  serving({ recovery: () => recovered });
  const view = await openPage();

  await waitFor(
    () => {
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    },
    { timeout: 4_000 },
  );
  expect(view.getByRole("heading", { name: "Idle computers" })).toBeTruthy();
  expect(view.getByRole("heading", { name: "Network" })).toBeTruthy();
  const alert = view.getByRole("alert");
  expect(alert.textContent).toContain("Idle computers and Network settings.");

  // The retry sits beside the alert's sentence in the banner, not inside it. The stub serves 200
  // from now on: the click's own read runs inside the click's synchronous part.
  recovered = true;
  const before = reads;
  // A real press focuses the retry button first, which is what the restore remembers.
  const retry = view.getByRole("button", { name: "Retry" });
  retry.focus();
  fireEvent.click(retry);
  await waitFor(() =>
    expect(view.getByText("Stop inactive computers")).toBeTruthy(),
  );
  expect(view.getByText("Organization")).toBeTruthy();
  // One overview read per recovery: the failed first read, then one on the retry.
  expect(reads - before).toBe(1);
  await waitFor(() =>
    expect(document.activeElement?.textContent).toBe("Idle computers"),
  );
});
