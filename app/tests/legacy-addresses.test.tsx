import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { cleanup } from "@testing-library/react";
import { Route as CapabilitiesIndexRoute } from "@/routes/_authed/_app/capabilities.index";
import { Route as ConnectionBotRoute } from "@/routes/_authed/_app/connections.$key_.bots.$agentId";
import { Route as ScreenRoute } from "@/routes/_authed/_app/s/$screen";
import { Route as SkillsRoute } from "@/routes/_authed/_app/skills";
import { Route as TeamBotsRoute } from "@/routes/_authed/_app/team-bots";
import { Route as ConnectedAccountsRoute } from "@/routes/_authed/settings/connected-accounts/index";
import { settleReactWork } from "./settle-react-work";

GlobalRegistrator.register();
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** A page that only has to exist for a redirect to land on it. */
function landing(path: string) {
  return createRoute({
    path,
    getParentRoute: () => shell,
    component: () => null,
  });
}

const root = createRootRoute();
const shell = createRoute({
  id: "_app",
  getParentRoute: () => root,
  component: Outlet,
});

/**
 * The legacy addresses under test, each carrying its real route module's behaviour. The real
 * modules' generics name the real registered tree, so each wired route is carried as `AnyRoute`
 * (the pattern `personal-no-memory.test.tsx` uses); only the behaviour's runtime effect is
 * asserted here.
 */
function wired(
  options: {
    path: string;
    getParentRoute: () => AnyRoute;
    component?: () => null;
  },
  module: { options: { beforeLoad?: unknown; validateSearch?: unknown } },
): AnyRoute {
  return createRoute({
    path: options.path,
    getParentRoute: options.getParentRoute as never,
    beforeLoad: module.options.beforeLoad as never,
    validateSearch: module.options.validateSearch as never,
    component: options.component,
  }) as unknown as AnyRoute;
}

function routeTree() {
  const capabilities = wired(
    { path: "/capabilities/", getParentRoute: () => shell },
    CapabilitiesIndexRoute,
  );
  const skills = wired(
    { path: "/skills", getParentRoute: () => shell },
    SkillsRoute,
  );
  const teamBots = wired(
    { path: "/team-bots", getParentRoute: () => shell },
    TeamBotsRoute,
  );
  const screen = wired(
    {
      path: "/s/$screen",
      getParentRoute: () => shell,
      component: () => null,
    },
    ScreenRoute,
  );
  const connectionBot = wired(
    { path: "/connections/$key/bots/$agentId", getParentRoute: () => shell },
    ConnectionBotRoute,
  );
  const settings = createRoute({
    path: "/settings",
    getParentRoute: () => root,
    component: Outlet,
  });
  const connectedAccounts = wired(
    { path: "/connected-accounts/", getParentRoute: () => settings },
    ConnectedAccountsRoute,
  );
  return root.addChildren([
    shell.addChildren([
      capabilities,
      skills,
      teamBots,
      screen,
      connectionBot,
      landing("/capabilities/skills"),
      landing("/bots"),
      landing("/responsibilities"),
      landing("/ideas"),
      landing("/connections"),
      landing("/connections/$key"),
    ]),
    settings.addChildren([connectedAccounts]),
  ]);
}

/** Where the router settles after opening `address`. */
async function settleAt(address: string) {
  const router = createRouter({
    routeTree: routeTree(),
    history: createMemoryHistory({ initialEntries: [address] }),
  });
  await router.load();
  return router.state.location;
}

test.each([
  {
    address: "/skills?new=true&edit=agent_1",
    pathname: "/capabilities/skills",
    search: { new: true, edit: "agent_1" },
  },
  { address: "/team-bots", pathname: "/bots", search: {} },
  { address: "/capabilities", pathname: "/capabilities/skills", search: {} },
  {
    address: "/s/goals?agent=agent_1",
    pathname: "/responsibilities",
    search: { agent: "agent_1", view: "goals" },
  },
  {
    address: "/s/ideas?agent=agent_1",
    pathname: "/ideas",
    search: { agent: "agent_1" },
  },
  {
    address: "/connections/notion/bots/agent_1",
    pathname: "/connections/notion",
    search: {},
  },
  {
    address: "/settings/connected-accounts?connected=ok&linked=1",
    pathname: "/connections",
    search: { connected: "ok", linked: "1" },
  },
] as const)(
  "$address lands on $pathname with its search intact",
  async (legacy) => {
    const location = await settleAt(legacy.address);
    expect(location.pathname).toBe(legacy.pathname);
    expect(location.search).toEqual(legacy.search);
  },
);
