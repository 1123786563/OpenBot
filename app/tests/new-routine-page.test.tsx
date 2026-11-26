import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewRoutinePage } from "@/components/routines/new-routine-page";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { Route as RoutinesRoute } from "@/routes/_authed/_app/routines";
import { settleReactWork } from "./settle-react-work";

beforeEach(() => GlobalRegistrator.register({ url: "http://openbot.test" }));

afterEach(async () => {
  cleanup();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentListQueryOptions().queryKey, [
    { id: "desk", name: "Desk" },
  ]);
  client.setQueryData(channelListQueryOptions().queryKey, {
    pages: [
      {
        channels: [
          { id: "room", active: true, agentIds: ["desk"], summary: "Planning" },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
  client.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
    testCreditConversations: true,
  });
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/routines/new"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/routines/new",
        component: () => <NewRoutinePage agentId="desk" channelId="room" />,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/routines",
        component: RoutinesRoute.options.component,
      }),
    ]),
  });
  return {
    router,
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

test("the create form explains daylight saving and sizes the Credits action for touch", async () => {
  const original = Intl.DateTimeFormat.prototype.resolvedOptions;
  using zone = spyOn(
    Intl.DateTimeFormat.prototype,
    "resolvedOptions",
  ).mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...original.call(this), timeZone: "America/New_York" };
  });
  const view = draw();
  expect(
    await view.findByText(/Eastern Time.*uses daylight saving time/),
  ).toBeTruthy();
  const credits = view.getByRole("button", { name: "Create using Credits" });
  expect(credits.style.minHeight).toBe("var(--spacing-11)");
  expect(zone).toHaveBeenCalled();
});

test("submitting twice saves once and returns to the focused Routines heading", async () => {
  const response = Promise.withResolvers<Response>();
  const posts: RequestInit["body"][] = [];
  using fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    async (input, init) => {
      if (String(input) === "/api/routines" && init?.method === "POST") {
        posts.push(init.body);
        return response.promise;
      }
      if (String(input) === "/api/routines")
        return Response.json({ routines: [], sweep: null });
      return Response.json({ agents: [] });
    },
  );
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send a summary.");
  const form = view
    .getByRole("button", { name: "Create routine" })
    .closest("form");
  if (!form) throw new Error("Create routine must submit a form");
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(JSON.parse(String(posts[0]))).toEqual(
    expect.objectContaining({
      agentId: "desk",
      channelId: "room",
      cron: "0 9 * * 1-5",
      instruction: "Send a summary.",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  );
  response.resolve(Response.json({ routine: { id: "routine-1" } }));
  await view.findByText("Routine created.");
  expect(view.router.state.location.pathname).toBe("/routines");
  expect(document.activeElement).toBe(
    view.getByRole("heading", { level: 1, name: "Routines" }),
  );
  expect(posts).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalled();
});
