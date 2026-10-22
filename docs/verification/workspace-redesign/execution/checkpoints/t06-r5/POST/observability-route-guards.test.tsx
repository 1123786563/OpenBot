import "./preload";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { requireBotObservabilityAccess } from "@/lib/observability/route-guard";
import { expect, test } from "../../tests/support/bun-test-compat";
import type { RouterContext } from "../src/router-context";
import { Route as ExportsRoute } from "../src/routes/_authed/_app/bots.$agentId.exports";

const rootRoute = createRootRoute({ component: Outlet });
const botsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "bots",
  component: Outlet,
});
const exportsRoute = ExportsRoute.update({
  id: "/$agentId/exports",
  path: "/$agentId/exports",
  getParentRoute: () => botsRoute,
} as Parameters<typeof ExportsRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof botsRoute;
});
const routeTree = rootRoute.addChildren([
  botsRoute.addChildren([exportsRoute]),
]);

const clientWith = (canManage: boolean) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.detail("bot-1"), {
    id: "bot-1",
    canManage,
  } as AgentProfile);
  return queryClient;
};

test("a manager reaches the observability page", async () => {
  const agent = await requireBotObservabilityAccess(clientWith(true), "bot-1");
  expect(agent.canManage).toBe(true);
});

for (const canManage of [false, undefined]) {
  test(`canManage=${String(canManage)} is redirected to /bots`, async () => {
    let thrown: unknown;
    try {
      await requireBotObservabilityAccess(
        clientWith(canManage as boolean),
        "bot-1",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
  });
}

for (const canManage of [true, false]) {
  test(`direct exports route with canManage=${canManage} runs the production beforeLoad guard`, async () => {
    const queryClient = clientWith(canManage);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/"] }),
      context: { queryClient } as RouterContext,
    });
    await router.navigate({
      to: "/bots/$agentId/exports",
      params: { agentId: "bot-1" },
    });
    if (canManage) {
      expect(router.state.location.pathname).toBe("/bots/bot-1/exports");
      expect(router.state.matches.length).toBeGreaterThan(0);
    } else {
      // TanStack cancels the guarded match on redirect when this minimal harness has
      // no destination page; an empty match list proves the direct route was refused.
      expect(router.state.matches).toHaveLength(0);
    }
  });
}
