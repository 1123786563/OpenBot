import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamFeaturesDialog } from "@/components/edition/team-features-dialog";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { SidebarProvider } from "@/components/ui/sidebar";
import { i18n, setLocalePreference } from "@/i18n";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import {
  type BotAttention,
  botLifecycleKeys,
} from "@/lib/bot-lifecycle/queries";
import { browserKeys } from "@/lib/browser/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { Route as AppRoute } from "@/routes/_authed/_app";
import { settleReactWork } from "./settle-react-work";

/*
 * In a narrow window (under 768px) the sidebar is a sheet over the page. Picking a conversation in
 * it opened that conversation behind the sheet, and the sheet stayed open until the person clicked
 * outside it, so it looked as if nothing had happened. Every way out of the sheet to a page closes
 * it; typing in its search box and opening its menus does not.
 */

class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const clients: QueryClient[] = [];

beforeAll(() => {
  // The width of the Windows window this was found in.
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 520,
    height: 840,
  });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(async () => {
  await i18n.changeLanguage("en");
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function conversation(id: string, summary: string): ChannelSummary {
  return {
    id,
    name: "Personal Assistant",
    agentIds: ["assistant"],
    threadId: id,
    active: true,
    lastMessageAt: "2026-11-08T14:00:00Z",
    summary,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-08T13:00:00Z",
    pinned: false,
    lastReadAt: "2026-11-08T14:00:00Z",
  };
}

function renderNarrowApp(start = "/channel/models") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  // The personal edition, as on the Windows install: OpenBot for Business sits in the account menu.
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition: "personal",
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "dana",
    name: "Dana Fresh",
    email: "dana@example.com",
    role: "admin",
    onboarding: null,
  });
  queryClient.setQueryData(userPreferencesQueryOptions("dana").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin: "openbot",
    proactive: "on",
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: [],
    lastPingId: null,
  });
  // OpenBot can run a browser here, so Teach a Bot is in the sidebar.
  queryClient.setQueryDefaults(browserKeys.state, { refetchInterval: false });
  queryClient.setQueryData(browserKeys.state, {
    available: true,
    computerId: "",
    open: false,
    tabs: [],
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [
          conversation("models", "AI Model and Agent Framework"),
          conversation("hn", "Hacker News Top Stories"),
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  const root = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <TeamFeaturesDialog />
      </>
    ),
  });
  const shell = createRoute({
    id: "_app",
    getParentRoute: () => root,
    component: AppRoute.options.component,
  });
  const routes = [
    "/",
    "/bots",
    "/connections",
    "/responsibilities",
    "/channel/new",
    "/settings",
    "/browser",
    "/channel/$channelId",
  ].map((path) =>
    createRoute({
      path,
      getParentRoute: () => shell,
      component: () => <h1>{path}</h1>,
    }),
  );
  const router = createRouter({
    routeTree: root.addChildren([shell.addChildren(routes)]),
    history: createMemoryHistory({ initialEntries: [start] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  return {
    view,
    queryClient,
    user,
    router,
    /** Opens the sheet as a person does, and answers with it. */
    async openSheet() {
      await user.click(
        await view.findByRole("button", { name: "Open navigation" }),
      );
      return view.findByRole("dialog", { name: "Navigation" });
    },
    async sheetCloses() {
      // `hidden`, because a dialog opened over the sheet hides it from the accessibility tree
      // without closing it.
      await waitFor(() =>
        expect(
          view.queryByRole("dialog", { name: "Navigation", hidden: true }),
        ).toBeNull(),
      );
    },
  };
}

test.each([
  ["a conversation", "link", /Hacker News Top Stories/, "/channel/hn"],
  [
    "the conversation already open",
    "link",
    /AI Model and Agent Framework/,
    "/channel/models",
  ],
  ["Apps", "link", /^Apps/, "/connections"],
  ["Teach a Bot", "link", /^Teach a Bot/, "/browser"],
  ["New conversation", "button", /^New conversation$/, "/channel/new"],
] as const)(
  "picking %s in the narrow sheet closes it and opens the page",
  async (_label, role, name, path) => {
    const app = renderNarrowApp();
    const sheet = await app.openSheet();
    await app.user.click(await within(sheet).findByRole(role, { name }));
    await app.sheetCloses();
    expect(app.router.state.location.pathname).toBe(path);
  },
);

test("All Bots in the Bots pane closes the sheet and opens the roster", async () => {
  const app = renderNarrowApp();
  const sheet = await app.openSheet();
  await app.user.click(within(sheet).getByRole("button", { name: "Bots" }));
  await app.user.click(within(sheet).getByRole("link", { name: "All Bots" }));
  await app.sheetCloses();
  expect(app.router.state.location.pathname).toBe("/bots");
});

test("Settings in the account menu closes the sheet and opens Settings", async () => {
  const app = renderNarrowApp();
  const sheet = await app.openSheet();
  await app.user.click(
    within(sheet).getByRole("button", { name: /Dana Fresh/ }),
  );
  // The menu opens over the sheet; opening it leaves the sheet where it is.
  const menu = await app.view.findByRole("menu");
  expect(app.view.getByRole("dialog", { name: "Navigation" })).toBeTruthy();
  await app.user.click(
    within(menu).getByRole("menuitem", { name: "Settings" }),
  );
  await app.sheetCloses();
  expect(app.router.state.location.pathname).toBe("/settings");
});

test("OpenBot for Business in the account menu closes the sheet and opens its dialog", async () => {
  const app = renderNarrowApp();
  const sheet = await app.openSheet();
  await app.user.click(
    within(sheet).getByRole("button", { name: /Dana Fresh/ }),
  );
  const menu = await app.view.findByRole("menu");
  await app.user.click(
    within(menu).getByRole("menuitem", { name: "OpenBot for Business" }),
  );
  await app.sheetCloses();
  await app.view.findByRole("dialog", { name: "OpenBot for Business" });
  expect(app.router.state.location.pathname).toBe("/channel/models");
});

test("searching the sheet keeps it open", async () => {
  const app = renderNarrowApp();
  const sheet = await app.openSheet();
  await app.user.type(
    within(sheet).getByRole("textbox", { name: "Search conversations" }),
    "hacker",
  );
  expect(app.view.getByRole("dialog", { name: "Navigation" })).toBeTruthy();
  expect(
    within(sheet).getByRole("textbox", { name: "Search conversations" }),
  ).toHaveProperty("value", "hacker");
  expect(app.router.state.location.pathname).toBe("/channel/models");
});

test("navigation can be opened, dismissed, and followed with the keyboard", async () => {
  const app = renderNarrowApp("/");
  const toggle = await app.view.findByRole("button", {
    name: "Open navigation",
  });
  toggle.focus();
  await app.user.keyboard("{Enter}");
  await app.view.findByRole("dialog", { name: "Navigation" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await app.user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(toggle));
  await app.user.keyboard("{Enter}");
  const nav = within(
    await app.view.findByRole("navigation", { name: "Workspace" }),
  );
  nav.getByRole("button", { name: "Bots" }).focus();
  await app.user.keyboard("{Enter}");
  app.view.getByRole("link", { name: "All Bots" }).focus();
  await app.user.keyboard("{Enter}");
  await app.view.findByRole("heading", { name: "/bots" });
  await waitFor(() => {
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });
  await app.user.keyboard("{Enter}");
  const current = within(
    await app.view.findByRole("dialog", { name: "Navigation" }),
  );
  expect(
    current
      .getByRole("link", { name: "All Bots", current: "page" })
      .getAttribute("href"),
  ).toBe("/bots");
});

test("an initial Bots deep link is active in desktop navigation", async () => {
  const initialWidth = window.innerWidth;
  window.innerWidth = 1200;
  try {
    const app = renderNarrowApp("/bots");
    await app.view.findByRole("heading", { name: "/bots" });
    const navigation = within(
      await app.view.findByRole("navigation", { name: "Workspace" }),
    );
    expect(
      app.view
        .getByRole("link", { name: "All Bots", current: "page" })
        .getAttribute("href"),
    ).toBe("/bots");
    expect(
      navigation.getByRole("button", { name: "Bots", pressed: true }),
    ).toBeTruthy();
    expect(
      app.view
        .getByRole("button", { name: "Close navigation" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  } finally {
    window.innerWidth = initialWidth;
  }
});

test("narrow navigation preserves conversation search and Settings", async () => {
  const app = renderNarrowApp("/");
  await app.user.click(
    await app.view.findByRole("button", { name: "Open navigation" }),
  );
  const sheet = within(
    await app.view.findByRole("dialog", { name: "Navigation" }),
  );
  await app.user.type(
    sheet.getByRole("textbox", { name: "Search conversations" }),
    "hacker",
  );
  expect(
    sheet.getByRole("link", { name: /Hacker News Top Stories/ }),
  ).toBeTruthy();
  await app.user.type(
    sheet.getByRole("textbox", { name: "Search conversations" }),
    "-no-match",
  );
  await sheet.findByText("No conversations match your search");
  await app.user.click(sheet.getByRole("button", { name: /Dana Fresh/ }));
  const menu = within(await app.view.findByRole("menu"));
  expect(
    menu.getByRole("menuitem", { name: "OpenBot for Business" }),
  ).toBeTruthy();
  expect(menu.queryByRole("menuitem", { name: "Admin" })).toBeNull();
  await app.user.click(menu.getByRole("menuitem", { name: "Settings" }));
  await app.view.findByRole("heading", { name: "/settings" });
  await app.view.findByRole("button", { name: "Open navigation" });
});

test("Goals opens Responsibilities from narrow navigation", async () => {
  const app = renderNarrowApp("/");
  await app.user.click(
    await app.view.findByRole("button", { name: "Open navigation" }),
  );
  const navigation = within(
    await app.view.findByRole("navigation", { name: "Workspace" }),
  );
  await app.user.click(navigation.getByRole("link", { name: "Goals" }));
  await app.view.findByRole("heading", { name: "/responsibilities" });
  expect(app.router.state.location.searchStr).toBe("?view=goals");
  await app.view.findByRole("button", { name: "Open navigation" });
});

test("new attention and check-ins notify once while narrow navigation is closed", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  const hasFocus = spyOn(document, "hasFocus").mockReturnValue(false);
  const notices: string[] = [];
  class GrantedNotification {
    static permission = "granted";

    constructor(_title: string, options: NotificationOptions) {
      notices.push(options.tag ?? "");
    }
  }
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: GrantedNotification,
  });
  const bot: BotAttention = {
    agentId: "assistant",
    name: "Assistant",
    questions: 1,
    approvals: 0,
    handoffs: 0,
    unread: 0,
    paused: false,
    notify: "all",
    items: 1,
    tasks: { needsInput: 0, ready: 0, failed: 0 },
  };
  try {
    const app = renderNarrowApp("/");
    await app.view.findByRole("button", { name: "Open navigation" });
    await app.sheetCloses();
    await settleReactWork();
    app.queryClient.setQueryData(botLifecycleKeys.attention, {
      bots: [bot],
      lastPingId: "new-ping",
    });
    await waitFor(() =>
      expect(notices.toSorted()).toEqual([
        "openbot-attention-assistant",
        "openbot-ping-new-ping",
      ]),
    );
    const sheet = await app.openSheet();
    expect(
      within(sheet).getByRole("img", { name: "1 thing needs you" }),
    ).toBeTruthy();
    await app.user.keyboard("{Escape}");
    await app.sheetCloses();
    await settleReactWork();
    expect(notices).toHaveLength(2);
  } finally {
    hasFocus.mockRestore();
    if (original) Object.defineProperty(globalThis, "Notification", original);
    else Reflect.deleteProperty(globalThis, "Notification");
  }
});

test("changing language keeps the narrow navigation open, its search and people's titles intact", async () => {
  const app = renderNarrowApp();
  const sheet = await app.openSheet();
  const search = within(sheet).getByRole("textbox", {
    name: "Search conversations",
  });
  await app.user.type(search, "Hacker");
  await act(() => setLocalePreference("zh-CN"));
  expect(app.view.getByRole("dialog", { name: "导航" })).toBe(sheet);
  expect(within(sheet).getByRole("textbox", { name: "搜索对话" })).toBe(search);
  expect(search).toHaveProperty("value", "Hacker");
  expect(
    app.view
      .getByRole("button", { name: "关闭导航", hidden: true })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    within(sheet).getByRole("link", { name: /Hacker News Top Stories/ }),
  ).toBeTruthy();
  expect(
    within(sheet).getByRole("link", {
      name: /Personal Assistant\b.*AI Model and Agent Framework/,
    }),
  ).toBeTruthy();
  expect(within(sheet).getByRole("link", { name: "教 Bot 做事" })).toBeTruthy();
  await app.user.click(
    within(sheet).getByRole("button", { name: /Dana Fresh/ }),
  );
  const menu = await app.view.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "设置" })).toBeTruthy();
  expect(within(menu).queryByRole("menuitem", { name: "退出登录" })).toBeNull();
  await app.user.click(
    within(menu).getByRole("menuitem", { name: "OpenBot for Business" }),
  );
  expect(
    await app.view.findByRole("dialog", { name: "OpenBot for Business" }),
  ).toBeTruthy();
  await act(() => setLocalePreference("en"));
});

test("the navigation toggle keeps its state while it changes language", async () => {
  const app = renderNarrowApp("/");
  const toggle = await app.view.findByRole("button", {
    name: "Open navigation",
  });
  await act(() => setLocalePreference("zh-CN"));
  const zhToggle = app.view.getByRole("button", { name: "打开导航" });
  expect(zhToggle).toBe(toggle);
  await app.user.click(zhToggle);
  const sheet = await app.view.findByRole("dialog", { name: "导航" });
  expect(app.view.getByRole("button", { name: "关闭导航" })).toBe(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await act(() => setLocalePreference("en"));
  expect(app.view.getByRole("button", { name: "Close navigation" })).toBe(
    toggle,
  );
  expect(app.view.getByRole("dialog", { name: "Navigation" })).toBe(sheet);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

test("the page's sidebar toggle names its action in both languages", async () => {
  const view = render(
    <SidebarProvider>
      <SidebarToggle />
    </SidebarProvider>,
  );
  const toggle = view.getByRole("button", { name: "Show sidebar" });
  await act(() => setLocalePreference("zh-CN"));
  expect(view.getByRole("button", { name: "显示侧栏" })).toBe(toggle);
  await act(() => setLocalePreference("en"));
  expect(view.getByRole("button", { name: "Show sidebar" })).toBe(toggle);
});
