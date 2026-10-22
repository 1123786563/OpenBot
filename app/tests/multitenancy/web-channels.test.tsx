import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQuery,
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
import { hasUnseenActivity } from "../../src/components/app-sidebar/app-sidebar";
import { scopedAgentListQueryOptions } from "../../src/lib/agents/queries";
import { useMarkOpenChannelRead } from "../../src/lib/channels/mark-read";
import {
  createChannelMutationOptions,
  markChannelReadMutationOptions,
} from "../../src/lib/channels/mutations";
import {
  type ChannelPage,
  type ChannelSummary,
  ChannelUnavailableError,
  channelKeys,
  scopedChannelDetailQueryOptions,
  scopedChannelListQueryOptions,
} from "../../src/lib/channels/queries";
import { scopedCachePrefix, useScopedCache } from "../../src/lib/enterprise/tenant/scoped-cache";
import {
  type ScopeSelection,
  selectionStorageKey,
  selectWorkspaceScope,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import {
  addGroupMemberMutationOptions,
  createGroupMutationOptions,
} from "../../src/lib/groups";

/**
 * MT087 / Issue #130: the conversation pages — roster list, detail, create, group members — are
 * bound to the scope the screen holds. The list and its cursors carry the selection pair and file
 * under the scope's own cache prefix, so a switch drops the old scope's pages wholesale and the
 * new scope's first page answers (AC1); creating a conversation or a group and changing a group's
 * members submit under the scope, and the candidates a picker offers are the server's scoped
 * answer — a Bot of another scope is never selectable because the scoped roster never names it
 * (AC2); the read marker's optimistic patch lands in this scope's own entry and never rolls back
 * into a scope that replaced it, and a conversation of a left scope answers the ONE typed
 * unavailable state (AC3). The roster's live socket already carries the pair and writes both
 * homes (MT082's `transport-streams.test.tsx`, extended by this ticket to the scoped key); the
 * business regressions (AC4) run in their own suites (channel-pagination, -search, -order,
 * -menu-mutations, -socket-message).
 *
 * THE HARNESS IS THE REAL SEAM: every read and write goes through the factories the pages call,
 * the read-marker runs through the real `useMarkOpenChannelRead` hook, the selection is seeded
 * from storage exactly as production seeds it, and a switch goes through `selectWorkspaceScope`.
 * `fetch` records every request — the pair the client carried is the evidence.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};

function summaryOf(over: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "ch-1",
    name: "Expenses chat",
    agentIds: ["expenses"],
    threadId: "th-1",
    active: true,
    lastMessageAt: "2026-10-21T10:00:00.000Z",
    summary: null,
    lastMessage: "Filed the receipt",
    lastMessageAgentId: "expenses",
    createdAt: "2026-10-20T10:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...over,
  };
}

const ACME_PAGE: ChannelPage = {
  channels: [summaryOf({})],
  nextCursor: "acme-cursor",
};
const ACME_PAGE_TWO: ChannelPage = {
  channels: [summaryOf({ id: "ch-2", name: "Second" })],
  nextCursor: null,
};
const GLOBEX_PAGE: ChannelPage = {
  channels: [summaryOf({ id: "ch-g", name: "Globex chat" })],
  nextCursor: null,
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

/** The roster list exactly as the sidebar reads it, plus the page-two fetch the cursor drives. */
function RosterProbe({ onNext }: { onNext?: () => void }) {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const roster = useInfiniteQuery(
    scopedChannelListQueryOptions(queryClient, scope),
  );
  const count = roster.data?.length ?? "none";
  return (
    <>
      <span data-testid="roster-count">{count}</span>
      <button
        data-testid="load-next"
        onClick={() => {
          onNext?.();
          void queryClient
            .fetchInfiniteQuery({
              ...scopedChannelListQueryOptions(queryClient, scope),
              pages: 2,
            })
            .then(() => undefined);
        }}
        type="button"
      />
    </>
  );
}

/** The conversation detail exactly as the channel route reads it. */
function DetailProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const detail = useQuery(
    scopedChannelDetailQueryOptions(queryClient, scope, "ch-1"),
  );
  return (
    <span data-testid="detail-state">
      {detail.error instanceof ChannelUnavailableError
        ? "unavailable"
        : detail.data
          ? detail.data.name
          : detail.isPending
            ? "pending"
            : detail.error instanceof Error
              ? detail.error.message
              : ""}
    </span>
  );
}

/** The write faces the conversation surfaces call, one button each. */
function WritesProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const create = useMutation(createChannelMutationOptions(queryClient, scope));
  const createGroup = useMutation(
    createGroupMutationOptions(queryClient, scope),
  );
  const addMember = useMutation(
    addGroupMemberMutationOptions(queryClient, "ch-1", scope),
  );
  const markRead = useMutation(
    markChannelReadMutationOptions(queryClient, scope),
  );
  return (
    <>
      <button
        data-testid="create-channel"
        onClick={() => create.mutate(["expenses"])}
        type="button"
      />
      <button
        data-testid="create-group"
        onClick={() => createGroup.mutate(["expenses", "shopper"])}
        type="button"
      />
      <button
        data-testid="add-member"
        onClick={() => addMember.mutate("teammate@acme.test")}
        type="button"
      />
      <button
        data-testid="mark-read"
        onClick={() => markRead.mutate("ch-1")}
        type="button"
      />
    </>
  );
}

/** The picker's candidate source exactly as the new-conversation screen reads it. */
function CandidatesProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const roster = useQuery(scopedAgentListQueryOptions(queryClient, scope));
  return <span data-testid="candidates">{roster.data?.length ?? "none"}</span>;
}

/** The real hook the open-channel screens call, rendered as its own consumer. */
function MarkOpenReadProbe({ channelId }: { channelId: string }) {
  useMarkOpenChannelRead(channelId);
  return null;
}

beforeEach(() => {
  window.localStorage.clear();
  asked = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// AC1 — the list, its cursors and the detail reflect the scope in force
// ---------------------------------------------------------------------------

describe("MT087 AC1 — the roster, its cursors and the detail are scoped", () => {
  test("the list carries the pair, files under the scope's prefix, and pages under it too", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/channels"
        ? jsonResponse(200, ACME_PAGE)
        : path === "/api/channels?cursor=acme-cursor"
          ? jsonResponse(200, ACME_PAGE_TWO)
          : undefined,
    );
    const queryClient = freshClient();
    const view = draw(queryClient, <RosterProbe />);
    await waitFor(() =>
      expect(view.getByTestId("roster-count").textContent).toBe("1"),
    );

    const read = asked.find((ask) => ask.input === "/api/channels");
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        ...channelKeys.list(),
      ]),
    ).toBeTruthy();
    // The unscoped entry the other surfaces read stays untouched by the scoped read.
    expect(queryClient.getQueryData(channelKeys.list())).toBeUndefined();

    await act(async () => {
      view.getByTestId("load-next").click();
    });
    const pageTwo = asked.find(
      (ask) => ask.input === "/api/channels?cursor=acme-cursor",
    );
    await waitFor(() => expect(pageTwo).toBeTruthy());
    expect(headerOf(pageTwo?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(pageTwo?.init, "x-openbot-workspace")).toBe("acme-finance");
  });

  test("a switch re-keys the roster: the old scope's pages are gone, the new scope answers", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/channels"
        ? jsonResponse(200, ACME_PAGE)
        : path === "/api/channels?cursor=acme-cursor"
          ? jsonResponse(200, ACME_PAGE_TWO)
          : undefined,
    );
    const queryClient = freshClient();
    const view = draw(queryClient, <RosterProbe />);
    await waitFor(() =>
      expect(view.getByTestId("roster-count").textContent).toBe("1"),
    );
    await act(async () => {
      view.getByTestId("load-next").click();
    });

    serve((path) =>
      path === "/api/channels" ? jsonResponse(200, GLOBEX_PAGE) : undefined,
    );
    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    await settle();
    // Acme's pages — both of them — are gone from the cache before Globex answers, and no page
    // of one scope sits beside the other's roster.
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        ...channelKeys.list(),
      ]),
    ).toBeUndefined();
    const rereads = asked.filter((ask) => ask.input === "/api/channels");
    expect(rereads.length).toBeGreaterThan(1);
    expect(headerOf(rereads.at(-1)?.init, "x-openbot-tenant")).toBe("globex");
  });
});

// ---------------------------------------------------------------------------
// AC2 — creates and member writes submit the scope; cross-scope objects are not selectable
// ---------------------------------------------------------------------------

describe("MT087 AC2 — creates, members and candidates are scoped", () => {
  test("creating a conversation and a group carries the pair", async () => {
    storeSelection(USER, ACME);
    serve(() => undefined);
    const queryClient = freshClient();
    const view = draw(queryClient, <WritesProbe />);
    const create = await waitFor(() => view.getByTestId("create-channel"));

    await act(async () => {
      create.click();
    });
    const channel = asked.find(
      (ask) => ask.input === "/api/channels" && ask.init?.method === "POST",
    );
    expect(channel).toBeTruthy();
    expect(headerOf(channel?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(channel?.init, "x-openbot-workspace")).toBe("acme-finance");

    await act(async () => {
      view.getByTestId("create-group").click();
    });
    const group = asked.find(
      (ask) => ask.input === "/api/groups" && ask.init?.method === "POST",
    );
    expect(group).toBeTruthy();
    expect(headerOf(group?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(group?.init, "x-openbot-workspace")).toBe("acme-finance");
  });

  test("adding a group member carries the pair", async () => {
    storeSelection(USER, ACME);
    serve(() => undefined);
    const queryClient = freshClient();
    const view = draw(queryClient, <WritesProbe />);
    const add = await waitFor(() => view.getByTestId("add-member"));

    await act(async () => {
      add.click();
    });
    const member = asked.find(
      (ask) =>
        ask.input === "/api/groups/ch-1/members" && ask.init?.method === "POST",
    );
    expect(member).toBeTruthy();
    expect(headerOf(member?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(member?.init, "x-openbot-workspace")).toBe("acme-finance");
  });

  test("the picker's candidates are the server's scoped answer", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/agents"
        ? jsonResponse(200, {
            agents: [{ id: "expenses", name: "Acme Expenses" }],
          })
        : undefined,
    );
    const queryClient = freshClient();
    const view = draw(queryClient, <CandidatesProbe />);
    await waitFor(() =>
      expect(view.getByTestId("candidates").textContent).toBe("1"),
    );

    const read = asked.find((ask) => ask.input === "/api/agents");
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
    // Only the scope's own entry exists: a Bot the scoped answer never named is not selectable,
    // and no other scope's roster row sits in the cache.
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, GLOBEX),
        "agents",
        "list",
        { hidden: false },
      ]),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC3 — optimistic patches stay in their scope; a left scope's route says so, typed
// ---------------------------------------------------------------------------

describe("MT087 AC3 — optimistic writes and residual routes answer by scope", () => {
  test("the read marker patches this scope's entry, and a switch leaves no old-scope residue", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/channels" ? jsonResponse(200, ACME_PAGE) : undefined,
    );
    const queryClient = freshClient();
    // The roster is on screen beside the write, as the sidebar is beside the open channel: the
    // optimistic patch has an entry to land in because this scope's roster is the live one.
    const view = draw(
      queryClient,
      <>
        <RosterProbe />
        <WritesProbe />
      </>,
    );
    await waitFor(() =>
      expect(view.getByTestId("roster-count").textContent).toBe("1"),
    );

    await act(async () => {
      view.getByTestId("mark-read").click();
    });
    const put = asked.find(
      (ask) =>
        ask.input === "/api/channels/ch-1/read" && ask.init?.method === "PUT",
    );
    expect(put).toBeTruthy();
    expect(headerOf(put?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(put?.init, "x-openbot-workspace")).toBe("acme-finance");

    // The optimistic patch landed in THIS scope's entry — the row reads as seen at once.
    const acmeEntry = queryClient.getQueryData<InfiniteData<ChannelPage>>([
      ...scopedCachePrefix(USER, ACME),
      ...channelKeys.list(),
    ]);
    expect(acmeEntry?.pages[0]?.channels[0]?.lastReadAt).toBeTruthy();
    // The unscoped entry other surfaces read was not written through this scope's marker.
    expect(queryClient.getQueryData(channelKeys.list())).toBeUndefined();

    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    await settle();
    // The switch removed the whole entry: no old-scope row to patch back, no residue beside the
    // scope that replaced it (MT083's prefix discipline, MT087's roster share of it).
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        ...channelKeys.list(),
      ]),
    ).toBeUndefined();
  });

  test("the open-channel marker runs through the real hook and carries the pair", async () => {
    storeSelection(USER, ACME);
    serve((path) =>
      path === "/api/channels" ? jsonResponse(200, ACME_PAGE) : undefined,
    );
    const queryClient = freshClient();
    draw(queryClient, <MarkOpenReadProbe channelId="ch-1" />);
    // The roster row is unseen (lastReadAt null, lastMessageAt set), so opening marks it read.
    expect(hasUnseenActivity(ACME_PAGE.channels[0])).toBe(true);
    await waitFor(() => {
      const put = asked.find(
        (ask) =>
          ask.input === "/api/channels/ch-1/read" && ask.init?.method === "PUT",
      );
      expect(put).toBeTruthy();
      expect(headerOf(put?.init, "x-openbot-tenant")).toBe("acme");
      expect(headerOf(put?.init, "x-openbot-workspace")).toBe("acme-finance");
    });
  });

  test("a conversation of a left scope answers the ONE typed unavailable state", async () => {
    storeSelection(USER, GLOBEX);
    serve((path) =>
      path === "/api/channels/ch-1"
        ? jsonResponse(404, { error: "no" })
        : undefined,
    );
    const queryClient = freshClient();
    const view = draw(queryClient, <DetailProbe />);
    await waitFor(() =>
      expect(view.getByTestId("detail-state").textContent).toBe("unavailable"),
    );
    // The typed refusal is the same state as a conversation that never existed: a plain error
    // message would distinguish a leak the server deliberately did not make.
    expect(view.getByTestId("detail-state").textContent !== "unavailable").toBe(
      false,
    );
  });
});
