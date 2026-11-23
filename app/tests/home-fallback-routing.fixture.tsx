import { mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { z } from "zod";
import { BotLookProvider } from "@/components/agents/bot-look";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";
import { Route as StartRoute } from "@/routes/_authed/_app/start.$startId";

mock.module("@/components/layout/sidebar-toggle", () => ({
  SidebarToggle: () => null,
  SidebarToggleBar: () => null,
}));

export function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    avatarSeed: "seed",
    builtIn: false,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    mine: true,
    name: "Agent",
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

export function queryClientWithAgents(
  agents: AgentProfile[],
  owner = "person",
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  queryClient.setQueryData(authKeys.currentUser(), {
    id: owner,
    email: `${owner}@example.test`,
    onboarding: null,
    role: "user",
  } satisfies AuthenticatedUser);
  queryClient.setQueryData(deploymentKeys.capabilities(), { edition: "team" });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [undefined],
  });
  return queryClient;
}

export function renderHome(queryClient: QueryClient, entry = "/") {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_authed",
    component: Outlet,
  });
  const appRoute = createRoute({
    getParentRoute: () => authedRoute,
    id: "_app",
    component: Outlet,
  });
  const startRouteOptions = {
    path: "/start/$startId",
    getParentRoute: () => appRoute,
    component: StartRoute.options.component,
  };
  const destinations = appRoute.addChildren([
    createRoute({
      getParentRoute: () => appRoute,
      path: "/",
      validateSearch: HomeRoute.options.validateSearch,
      component: HomeRoute.options.component,
    }),
    StartRoute.update(startRouteOptions),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/channel/$channelId",
      component: () => <p>The conversation</p>,
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/channel/new",
      component: () => <p>New conversation destination</p>,
    }),
  ]);
  const routeTree = rootRoute.addChildren([
    authedRoute.addChildren([destinations]),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <BotLookProvider value="orb">
        <RouterProvider router={router} />
      </BotLookProvider>
    </QueryClientProvider>,
  );
  return Object.assign(view, { router });
}

export async function submitHomeMessage(
  view: ReturnType<typeof renderHome>,
  text: string,
) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByRole("textbox", { name: "Message" }), text);
  await user.click(await view.findByRole("button", { name: "Send message" }));
}

const channelRequest = z.object({
  agentIds: z.array(z.string()),
  requestId: z.string().min(1),
});

export function readChannelRequest(init?: RequestInit) {
  return channelRequest.parse(JSON.parse(String(init?.body)));
}

export function createdChannel(id: string, agentIds: string[]) {
  return Response.json({
    channel: {
      id,
      name: "Knowledge",
      agentIds,
      threadId: `thread-${id}`,
      active: true,
      lastMessageAt: null,
    },
  });
}
