import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { actionPolicyQueryOptions } from "@/lib/computers/queries";
import { Route as BoundariesRoute } from "@/routes/_authed/admin/boundaries";

/**
 * Boundaries is drawn from one read, `GET /api/computers/policy`. When that read fails the page
 * used to render its title over nothing, for as long as it stayed open, because nothing read the
 * query's error. The harness is the one `composing-enter.test.tsx` uses for the same screen.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let policyResponse: () => Response;

beforeEach(() => {
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) =>
      path === "/api/computers/policy"
        ? policyResponse()
        : new Response(null, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function drawBoundaries() {
  const Boundaries = BoundariesRoute.options.component as ComponentType;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute();
  const authed = createRoute({ id: "/_authed", getParentRoute: () => root });
  const boundaries = createRoute({
    path: "/admin/boundaries",
    getParentRoute: () => authed,
    validateSearch: BoundariesRoute.options.validateSearch,
    component: () => <Boundaries />,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/admin/boundaries"] }),
    routeTree: root.addChildren([authed.addChildren([boundaries])]),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("a failed boundary read can be retried without showing an empty list", async () => {
  // The shape a broken server actually sends: a 500 with no body, so the query's own sentence.
  policyResponse = () => new Response(null, { status: 500 });

  const view = drawBoundaries();

  const alert = await view.findByRole("alert");
  expect(
    within(alert).getByText("The boundary could not be read."),
  ).toBeTruthy();
  expect(view.queryByText("No rules yet")).toBeNull();
  policyResponse = () =>
    Response.json({ policy: { mode: "enforce", deny: [], allow: ["true"] } });
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  expect(await view.findByText("No rules yet")).toBeTruthy();
});

test("a refused read shows the server's own reason", async () => {
  policyResponse = () =>
    Response.json(
      { error: "Only an administrator may read the boundary." },
      { status: 403 },
    );

  const view = drawBoundaries();

  const alert = await view.findByRole("alert");
  expect(
    within(alert).getByText("Only an administrator may read the boundary."),
  ).toBeTruthy();
  expect(view.queryByRole("switch", { name: "Trial mode" })).toBeNull();
});

test("a refused boundary read clears cached rules before a later outage", async () => {
  const cache = new QueryClient();
  const options = { ...actionPolicyQueryOptions(), retry: false };
  policyResponse = () =>
    Response.json({
      policy: {
        mode: "enforce",
        deny: ['page.host == "example.test"'],
        allow: ["true"],
      },
    });
  await expect(cache.fetchQuery(options)).resolves.toMatchObject({
    mode: "enforce",
  });

  policyResponse = () => new Response(null, { status: 403 });
  await expect(cache.fetchQuery(options)).rejects.toMatchObject({
    status: 403,
  });
  policyResponse = () => new Response(null, { status: 503 });
  await expect(cache.fetchQuery(options)).rejects.toMatchObject({
    status: 503,
  });
  expect(cache.getQueryData(options.queryKey)).toBeNull();
});
