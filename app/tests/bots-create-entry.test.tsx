import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { settleReactWork } from "./settle-react-work";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function bot(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    name: overrides.id,
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: true,
    mine: true,
    ...overrides,
  };
}

/**
 * The Bot's own page, as far as this harness needs it: its title takes focus after creation.
 * Mirrors `bots.$agentId.index.tsx`'s heading effect, which is where the focus hand-off lands.
 */
function DetailProfile() {
  const { agentId } = useParams({ strict: false });
  const createdBotId = useLocation({
    select: (location) => location.state.createdBotId,
  });
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (createdBotId !== agentId || document.activeElement !== document.body)
      return;
    heading.current?.focus();
  }, [agentId, createdBotId]);
  return (
    <h1 ref={heading} tabIndex={-1}>
      Bot profile for {agentId}
    </h1>
  );
}

function renderEntry(initialEntry: string, agents: AgentProfile[] = []) {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  query.setQueryData(agentKeys.list(false), agents);
  query.setQueryData(agentKeys.list(true), []);
  query.setQueryData(deploymentKeys.capabilities(), { edition: "personal" });
  globalThis.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (path === "/api/agents/capabilities") {
        return NativeResponse.json({
          capabilities: { builtInAvailable: true },
        });
      }
      if (path === "/api/agents" && init?.method === "POST") {
        return NativeResponse.json(
          { agent: { id: "new-bot" } },
          { status: 201 },
        );
      }
      if (path === "/api/agents") {
        return NativeResponse.json({ agents });
      }
      if (path === "/api/agents?hidden=true") {
        return NativeResponse.json({ agents: [] });
      }
      return NativeResponse.json({}, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );

  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({ id: "/_authed", getParentRoute: () => root });
  const app = createRoute({ id: "/_app", getParentRoute: () => authed });
  const bots = createRoute({
    component: BotsRoute.options.component,
    validateSearch: BotsRoute.options.validateSearch,
    path: "/bots/",
    getParentRoute: () => app,
  });
  const detail = createRoute({
    path: "/bots/$agentId",
    getParentRoute: () => app,
    component: DetailProfile,
  });
  const home = createRoute({
    path: "/",
    getParentRoute: () => app,
  });
  const history = createMemoryHistory({ initialEntries: [initialEntry] });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([home, bots, detail])]),
    ]),
    history,
  });
  return Object.assign(
    render(
      <QueryClientProvider client={query}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
    { history },
  );
}

const rosterActionRole = "link";

test("the Bots header creates a Bot, opens its profile, and Back returns to a closed roster", async () => {
  const view = renderEntry("/bots");
  const user = userEvent.setup({ document });
  const header = within(await view.findByRole("banner"));
  await user.click(header.getByRole(rosterActionRole, { name: "New Bot" }));
  const sheet = within(await view.findByRole("dialog", { name: "New Bot" }));
  await user.type(sheet.getByLabelText("Name"), "Planning Bot");
  await user.click(await sheet.findByRole("button", { name: "Create Bot" }));
  await view.findByRole(
    "heading",
    { name: "Bot profile for new-bot" },
    { timeout: 3500 },
  );

  await act(async () => view.history.back());
  await view.findByRole("heading", { level: 1, name: "Bots" });
  expect(view.history.location.search).toBe("");
  expect(view.queryByRole("dialog", { name: "New Bot" })).toBeNull();
});

test("Escape returns focus to New Bot on the empty roster", async () => {
  const view = renderEntry("/bots");
  expect(await view.findByText("No Bots available yet")).toBeTruthy();
  const newBot = view.getByRole(rosterActionRole, {
    name: "New Bot",
  });

  const user = userEvent.setup({ document });
  await user.click(newBot);
  expect(await view.findByRole("dialog", { name: "New Bot" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "New Bot" })).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(newBot));
});

test("Escape and Cancel ask before discarding edited Bot details", async () => {
  const view = renderEntry("/bots");
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("link", { name: "New Bot" }));
  const sheet = within(await view.findByRole("dialog", { name: "New Bot" }));
  const name = sheet.getByLabelText("Name");
  await user.type(name, "Planning Bot");

  await user.keyboard("{Escape}");
  const confirmation = within(
    await view.findByRole("alertdialog", { name: "Discard this Bot draft?" }),
  );
  await user.click(confirmation.getByRole("button", { name: "Keep editing" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(name).toHaveProperty("value", "Planning Bot");
  expect(view.history.location.search).toBe("?new=true");

  await user.click(sheet.getByRole("button", { name: "Cancel" }));
  const discard = await view.findByRole("button", { name: "Discard changes" });
  await user.click(discard);
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "New Bot" })).toBeNull(),
  );
  expect(view.history.location.search).toBe("");

  await user.click(view.getByRole("link", { name: "New Bot" }));
  expect(
    within(await view.findByRole("dialog", { name: "New Bot" })).getByLabelText(
      "Name",
    ),
  ).toHaveProperty("value", "");
});

test("dismissing a directly opened creation sheet focuses the Bots header action", async () => {
  const view = renderEntry("/bots?new=true");
  const sheet = within(await view.findByRole("dialog", { name: "New Bot" }));
  await userEvent
    .setup({ document })
    .click(sheet.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "New Bot" })).toBeNull(),
  );
  expect(view.history.location.search).toBe("");
  const header = within(view.getByRole("banner"));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      header.getByRole(rosterActionRole, { name: "New Bot" }),
    ),
  );
});

test("Back from a Bot's page keeps the search and focuses the row that opened it", async () => {
  const agents = [
    bot({ id: "planning", name: "Planning Bot" }),
    bot({ id: "expenses", name: "Expenses" }),
  ];
  const view = renderEntry("/bots?q=plan", agents);
  const opened = (await view.findByText("Planning Bot")).closest("a");
  expect(opened?.getAttribute("href")).toBe("/bots/planning");

  await userEvent.setup({ document }).click(opened as HTMLElement);
  expect(
    await view.findByRole("heading", { name: "Bot profile for planning" }),
  ).toBeTruthy();

  await act(async () => view.history.back());
  await waitFor(() => expect(view.history.location.search).toBe("?q=plan"));
  const restored = (await view.findByText("Planning Bot")).closest("a");
  expect(restored?.getAttribute("href")).toBe("/bots/planning");
  await waitFor(() => expect(document.activeElement).toBe(restored));
});

test("a newly created Bot's page title takes focus", async () => {
  const view = renderEntry("/bots");
  const user = userEvent.setup({ document });
  const header = within(await view.findByRole("banner"));
  await user.click(header.getByRole(rosterActionRole, { name: "New Bot" }));
  const sheet = within(await view.findByRole("dialog", { name: "New Bot" }));
  await user.type(sheet.getByLabelText("Name"), "Planning Bot");
  await user.click(await sheet.findByRole("button", { name: "Create Bot" }));

  const heading = await view.findByRole(
    "heading",
    { name: "Bot profile for new-bot" },
    { timeout: 3500 },
  );
  await waitFor(() => expect(document.activeElement).toBe(heading));
});
