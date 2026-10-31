import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { RoutinesList } from "../../src/components/routines/routines-list";
import {
  type ScopedCache,
  scopedCachePrefix,
  useScopedCache,
} from "../../src/lib/enterprise/tenant/scoped-cache";
import {
  type ScopeSelection,
  selectionStorageKey,
  selectWorkspaceScope,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import { setRoutineEnabledMutationOptions } from "../../src/lib/routines/mutations";
import {
  type RoutinesPage,
  routineKeys,
  scopedRoutinesQueryOptions,
} from "../../src/lib/routines/queries";

/**
 * MT089 / Issue #132: the routines page is bound to the scope the screen holds. Its read and
 * its enable/delete/run-now writes submit under the scope in force (AC2), and a switch drops
 * the old scope's routines wholesale — no residue beside the scope that replaced it (AC3).
 *
 * #732: this file used to carry the old memories and sources pages beside the routines ones.
 * Those surfaces left with the old engine, so the suite keeps the routines half.
 *
 * THE HARNESS IS THE REAL PAGE AND THE REAL SEAM: `RoutinesList` renders as itself inside a
 * memory router, the selection is seeded from storage exactly as production seeds it, and a
 * switch goes through `selectWorkspaceScope`. `fetch` records every request — the pair the
 * client carried is the evidence.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};

const ROUTINES: RoutinesPage = {
  routines: [
    {
      id: "routine-1",
      agentId: "expenses",
      schedule: "Every weekday at 09:00",
      timezone: "UTC",
      instruction: "File overnight receipts",
      channel: { id: "ch-1", name: "Expenses", gone: false },
      enabled: true,
      nextRunAt: "2026-10-22T09:00:00.000Z",
      lastRun: { status: "succeeded", at: "2026-10-21T09:05:00.000Z" },
    },
  ],
  sweep: { lastSweptAt: "2026-10-21T09:05:00.000Z", working: false },
};

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

const originalFetch = global.fetch;

type Asked = { input: string; init: RequestInit | undefined };

let asked: Asked[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serve(handler: (path: string) => Response | undefined): void {
  global.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = String(input);
    asked.push({ input: path, init });
    if (path === "/api/me") return jsonResponse(200, { user: { id: USER } });
    return handler(path) ?? jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

function headerOf(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return (headers as Record<string, string>)[name];
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function switchSelection(
  queryClient: QueryClient,
  previous: ScopeSelection | null,
  next: ScopeSelection | null,
): void {
  if (next !== null) storeSelection(USER, next);
  else window.localStorage.removeItem(selectionStorageKey(USER));
  selectWorkspaceScope(queryClient, USER, previous, next);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function draw(queryClient: QueryClient, node: React.ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => node }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The routine enable write, as the routines page wires it. */
function RoutineWriteProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const setEnabled = useMutation(
    setRoutineEnabledMutationOptions(queryClient, scope),
  );
  return (
    <button
      data-testid="toggle-routine"
      onClick={() => setEnabled.mutate({ id: "routine-1", enabled: false })}
      type="button"
    />
  );
}

/** A scope holder for the write probe. */
function ScopeHolder({
  children,
}: {
  children: (scope: ScopedCache) => React.ReactNode;
}) {
  const scope = useScopedCache();
  return <>{scope.status === "open" ? children(scope) : null}</>;
}

beforeEach(() => {
  window.localStorage.clear();
  asked = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// AC2 — the routines read and its writes submit the scope
// ---------------------------------------------------------------------------

describe("MT089 AC2 — routines are read and changed under the scope", () => {
  test("the routines read carries the pair and files under the scope's prefix", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/routines"
        ? jsonResponse(200, ROUTINES)
        : path.endsWith("/runs")
          ? jsonResponse(200, { runs: [] })
          : undefined,
    );
    const queryClient = freshClient();
    const view = draw(queryClient, <RoutinesList />);
    await waitFor(() =>
      expect(view.getByText("File overnight receipts")).toBeTruthy(),
    );

    const read = asked.find((ask) => ask.input === "/api/routines");
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        ...routineKeys.list(),
      ]),
    ).toMatchObject({ routines: [{ id: "routine-1" }] });
  });

  test("the enable write carries the pair", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/routines" ? jsonResponse(200, ROUTINES) : undefined,
    );
    const queryClient = freshClient();
    const view = draw(
      queryClient,
      <ScopeHolder>{() => <RoutineWriteProbe />}</ScopeHolder>,
    );
    const toggle = await waitFor(() => view.getByTestId("toggle-routine"));

    await act(async () => {
      toggle.click();
    });
    const put = asked.find(
      (ask) =>
        ask.input === "/api/routines/routine-1/enabled" &&
        ask.init?.method === "PUT",
    );
    expect(put).toBeTruthy();
    expect(headerOf(put?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(put?.init, "x-openbot-workspace")).toBe("acme-finance");
  });
});

// ---------------------------------------------------------------------------
// AC3 — a switch leaves no old-scope task behind
// ---------------------------------------------------------------------------

describe("MT089 AC3 — a switch drops the old scope's routines", () => {
  test("the scoped entries for routines go on the switch", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/routines" ? jsonResponse(200, ROUTINES) : undefined,
    );
    const queryClient = freshClient();
    // Fill the scoped entry through the real factory, as the page does.
    await act(async () => {
      await queryClient.fetchQuery(
        scopedRoutinesQueryOptions(queryClient, await openScope()),
      );
    });
    const acmePrefix = scopedCachePrefix(USER, ACME);
    expect(
      queryClient.getQueryData([...acmePrefix, ...routineKeys.list()]),
    ).toBeTruthy();

    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    await settle();
    // The switch removed the whole subtree the entry lived under: no old-scope schedule sits
    // beside Globex's answers.
    expect(
      queryClient.getQueryData([...acmePrefix, ...routineKeys.list()]),
    ).toBeUndefined();
  });
});

/**
 * The open scope a factory needs when driven outside a component: the same facts the live hook
 * reads — the user from `/api/me` and the selection from storage — assembled the same way
 * `useScopedCache` assembles them, with the generation the switch seam advances.
 */
async function openScope(): Promise<ScopedCache> {
  storeSelection(USER, ACME);
  return {
    status: "open",
    userId: USER,
    selection: ACME,
    generation: 0,
    prefix: scopedCachePrefix(USER, ACME),
    key: "acme-open",
  };
}
