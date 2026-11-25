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
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { browserKeys } from "@/lib/browser/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { pinLocale } from "./i18n";
import { settleReactWork } from "./settle-react-work";

/*
 * The roster's times are the first place the interface draws a time. Choosing another language must
 * redraw them where they stand: the same row, in the same mount, over the same instant.
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
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
  // Every test file in a run shares one translation instance, so this file puts English back.
  await pinLocale("en");
});
afterAll(async () => {
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function renderSidebar(channels: ChannelSummary[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "maya",
    name: "Maya Chen",
    email: "maya@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(userPreferencesQueryOptions("maya").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin: "openbot",
    proactive: "on",
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  // The attention list polls on its own schedule; nothing here is waiting on it.
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: [],
    lastPingId: null,
  });
  queryClient.setQueryData(browserKeys.state, {
    available: false,
    computerId: "",
    open: false,
    tabs: [],
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor: null }],
    pageParams: [""],
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("choosing a language redraws the conversation times where they stand", async () => {
  const spokenAt = new Date(Date.now() - 3 * 60_000).toISOString();
  const view = renderSidebar([
    {
      id: "planning",
      name: "Quarterly planning",
      agentIds: [],
      threadId: "planning",
      active: true,
      lastMessageAt: spokenAt,
      summary: "Budget review for Q2",
      lastMessage: null,
      lastMessageAgentId: null,
      createdAt: "2026-03-05T12:00:00.000Z",
      pinned: false,
      lastReadAt: null,
    },
  ]);
  const row = await view.findByRole("link", { name: /Quarterly planning/ });
  expect(within(row).getByText("3m")).toBeTruthy();

  await pinLocale("zh-CN");

  expect(within(row).getByText("3 分钟前")).toBeTruthy();
  expect(within(row).queryByText("3m")).toBeNull();

  await pinLocale("en");

  expect(within(row).getByText("3m")).toBeTruthy();
  expect(within(row).queryByText("3 分钟前")).toBeNull();
  // Redrawn, not rebuilt: it is still the row that was mounted first.
  expect(view.getByRole("link", { name: /Quarterly planning/ })).toBe(row);
  // The instant on record is the one the server sent; only its wording moved.
  expect(clients[0]?.getQueryData(channelKeys.list())).toMatchObject({
    pages: [{ channels: [{ lastMessageAt: spokenAt }] }],
  });
});
