import "./preload";
import "./preload";
import { afterEach, expect, test } from "../../tests/support/e2e-compat";
import {
  MutationObserver,
  QueryObserver,
  QueryClient,
} from "@tanstack/react-query";
import {
  archiveChannelMutationOptions,
  createChannelMutationOptions,
} from "../src/lib/enterprise/tenant/mutations";
import {
  channelQueryOptions,
  channelsQueryOptions,
  type ChannelPage,
  type PersonalConversation,
  selectTenant,
  tenantKeys,
  tenantsQueryOptions,
  TenantSelectionChangedError,
} from "../src/lib/enterprise/tenant/queries";

/**
 * The tenant member surface's query layer, per plan F02 step 7.
 *
 * TWO THINGS ARE UNDER TEST HERE. First, the four states a screen can be in — pending, error,
 * empty, rows — driven through a real `QueryClient` against a stubbed `fetch`, because the page
 * (routes/_authed/tenant/channels.tsx) renders each of them from exactly these result fields, and
 * an empty array standing in for a refusal would read as "no channels" when the truth is "not
 * yours". Second, the tenant switch: `selectTenant` drops the old tenant's cache and advances a
 * generation, and a response that left under one selection and lands under another is refused with
 * {@link TenantSelectionChangedError} instead of decorating the new tenant's screen.
 *
 * THE STUB ANSWERS WITH THE SHAPES THE ROUTES REALLY SEND (server/src/enterprise/conversations
 * routes over the frozen mobile schemas). The page's own React rendering is not re-tested here;
 * what is tested is every state the page can be handed and the switch it drives.
 */

const realFetch = globalThis.fetch;

type Asked = { input: RequestInfo | URL; init: RequestInit | undefined };

function intercept(respond: (asked: Asked) => Response | Promise<Response>): Asked[] {
  const asked: Asked[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    asked.push({ input, init });
    return respond({ input, init });
  }) as unknown as typeof fetch;
  return asked;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A page of channels as GET /api/enterprise/v1/channels answers it. */
function pageOf(...channelIds: string[]): ChannelPage {
  return {
    items: channelIds.map((channelId) => ({
      channelId,
      botId: `bot-for-${channelId}`,
      threadId: `thread-for-${channelId}`,
      mode: "single",
      status: "active",
    })),
    nextCursor: null,
  };
}

/** The selector a captured request carried, however the runtime typed the headers. */
function selectorOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return undefined;
  if (headers instanceof Headers) return headers.get("x-openbot-tenant") ?? undefined;
  return (headers as Record<string, string>)["x-openbot-tenant"];
}

/**
 * The context a direct `queryFn` call needs — everything else on it is React Query's own. Typed
 * by inference at the call site, because the branded `queryOptions` factories narrow the context
 * their `queryFn` accepts to their own key.
 */
function contextOf<C>(
  queryKey: readonly unknown[],
  queryClient: QueryClient,
): C {
  return {
    client: queryClient,
    queryKey: [...queryKey],
    signal: new AbortController().signal,
    meta: undefined,
  } as C;
}

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

test("every key names the user, the tenant and the parameters it was asked under", () => {
  // Spread before comparing: `queryOptions` brands keys with TanStack's DataTag phantom symbols,
  // which exist only in the type system, so the elements are what get compared.
  expect([...tenantKeys.chooser("u-1")]).toEqual(["enterprise-tenant", "u-1", ":chooser"]);
  expect([...tenantKeys.scope("u-1", "acme")]).toEqual([
    "enterprise-tenant",
    "u-1",
    "acme",
  ]);
  expect([...tenantKeys.channels("u-1", "acme", null)]).toEqual([
    "enterprise-tenant",
    "u-1",
    "acme",
    "channels",
    { cursor: null },
  ]);
  expect([...tenantKeys.channels("u-1", "acme", "cur-9")]).toEqual([
    "enterprise-tenant",
    "u-1",
    "acme",
    "channels",
    { cursor: "cur-9" },
  ]);
  expect([...tenantKeys.channel("u-1", "acme", "ch-1")]).toEqual([
    "enterprise-tenant",
    "u-1",
    "acme",
    "channel",
    "ch-1",
  ]);
  // One person's two tenants share nothing: the tenant is IN the key, not a global.
  expect([...tenantKeys.channels("u-1", "acme", null)]).not.toEqual([
    ...tenantKeys.channels("u-1", "other", null),
  ]);
});

test("the channels read starts pending, then answers rows", async () => {
  const asked = intercept(() => jsonResponse(200, pageOf("ch-1", "ch-2")));
  const queryClient = freshClient();
  const observer = new QueryObserver(
    queryClient,
    channelsQueryOptions(queryClient, "u-1", "acme"),
  );

  const statuses: string[] = [];
  const unsubscribe = observer.subscribe((result) => {
    statuses.push(result.status);
  });
  // In flight: the screen shows nothing yet rather than an empty list.
  expect(observer.getCurrentResult().status).toBe("pending");
  expect(observer.getCurrentResult().fetchStatus).toBe("fetching");

  await observer.fetchOptimistic(
    channelsQueryOptions(queryClient, "u-1", "acme"),
  );
  unsubscribe();

  const result = observer.getCurrentResult();
  expect(result.status).toBe("success");
  expect(result.data?.items.map((row) => row.channelId)).toEqual(["ch-1", "ch-2"]);
  // The read rode the header and the exact path the route mounts.
  expect(asked[0]?.input).toBe("/api/enterprise/v1/channels");
  expect(selectorOf(asked[0]?.init)).toBe("acme");
});

test("an empty page is an empty page, and a refusal is an error — never an empty array", async () => {
  const queryClient = freshClient();

  intercept(() => jsonResponse(200, { items: [], nextCursor: null }));
  const empty = await queryClient.fetchQuery(
    channelsQueryOptions(queryClient, "u-1", "acme"),
  );
  expect(empty.items).toEqual([]);
  expect(empty.nextCursor).toBe(null);

  const refused = freshClient();
  // The status and envelope the scope middleware answers a non-member with (scope.ts:43).
  intercept(() =>
    jsonResponse(403, {
      error: {
        code: "TENANT_FORBIDDEN",
        request_id: "req-2",
        retryable: false,
        summary: "请求未获允许",
      },
    }),
  );
  await expect(
    refused.fetchQuery(channelsQueryOptions(refused, "u-1", "acme")),
  ).rejects.toThrow("请求未获允许");
  expect(
    refused.getQueryData(tenantKeys.channels("u-1", "acme", null)),
  ).toBeUndefined();
});

test("the channel record read names the tenant and the encoded channel id", async () => {
  const record: PersonalConversation = {
    channelId: "ch/1",
    botId: "bot-1",
    threadId: "thread-1",
    mode: "single",
    status: "archived",
  };
  const asked = intercept(() => jsonResponse(200, record));
  const queryClient = freshClient();

  const read = await queryClient.fetchQuery(
    channelQueryOptions(queryClient, "u-1", "acme", "ch/1"),
  );

  expect(read).toEqual(record);
  expect(asked[0]?.input).toBe(
    `/api/enterprise/v1/channels/${encodeURIComponent("ch/1")}`,
  );
  expect(selectorOf(asked[0]?.init)).toBe("acme");
});

test("the chooser read names no tenant — it is answered before the scope exists", async () => {
  const asked = intercept(() =>
    jsonResponse(200, {
      items: [{ id: "acme", name: "Acme", role: "member" }],
    }),
  );
  const queryClient = freshClient();

  await queryClient.fetchQuery(tenantsQueryOptions("u-1"));

  expect(asked[0]?.input).toBe("/api/enterprise/v1/tenants");
  expect(selectorOf(asked[0]?.init)).toBeUndefined();
});

test("switching tenants drops the old tenant's cache and keeps the chooser", async () => {
  const queryClient = freshClient();
  intercept(() => jsonResponse(200, pageOf("ch-1")));
  await queryClient.fetchQuery(channelsQueryOptions(queryClient, "u-1", "acme"));
  await queryClient.fetchQuery(
    channelQueryOptions(queryClient, "u-1", "acme", "ch-1"),
  );
  queryClient.setQueryData(tenantKeys.chooser("u-1"), { items: [] });

  selectTenant(queryClient, "u-1", "acme", "other");

  expect(
    queryClient.getQueryData(tenantKeys.channels("u-1", "acme", null)),
  ).toBeUndefined();
  expect(
    queryClient.getQueryData(tenantKeys.channel("u-1", "acme", "ch-1")),
  ).toBeUndefined();
  expect(queryClient.getQueryData(tenantKeys.chooser("u-1")) as unknown).toEqual({
    items: [],
  });
});

test("selecting the tenant already selected changes nothing", () => {
  const queryClient = freshClient();
  intercept(() => jsonResponse(200, pageOf("ch-1")));
  const before = queryClient.getQueryData(tenantKeys.generation("u-1"));

  selectTenant(queryClient, "u-1", "acme", "acme");

  expect(
    queryClient.getQueryData(tenantKeys.generation("u-1")) as unknown,
  ).toBe(before);
});

test("a response that outlives its selection is refused, not rendered", async () => {
  let release: ((response: Response) => void) | undefined;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  intercept(() => held);
  const queryClient = freshClient();
  const options = channelsQueryOptions(queryClient, "u-1", "acme");

  // The read starts under acme; the switch happens while it is still in flight.
  const inFlight = options.queryFn?.(
    contextOf(options.queryKey, queryClient),
  );
  selectTenant(queryClient, "u-1", "acme", "other");
  release?.(jsonResponse(200, pageOf("ch-1")));

  await expect(inFlight).rejects.toBeInstanceOf(TenantSelectionChangedError);
  // And the answer never landed under the new tenant's key either.
  expect(
    queryClient.getQueryData(tenantKeys.channels("u-1", "other", null)),
  ).toBeUndefined();
});

test("a response that arrives before the switch is accepted, as the control case", async () => {
  const queryClient = freshClient();
  intercept(() => jsonResponse(200, pageOf("ch-1")));
  const options = channelsQueryOptions(queryClient, "u-1", "acme");

  const landed = await options.queryFn?.(
    contextOf(options.queryKey, queryClient),
  );

  expect(landed?.items.map((row) => row.channelId)).toEqual(["ch-1"]);
});

test("creating a channel mints a fresh request id and refreshes the tenant's views", async () => {
  const asked = intercept(() =>
    jsonResponse(200, pageOf("ch-new").items[0] ?? {}),
  );
  const queryClient = freshClient();
  const invalidateCalls: unknown[] = [];
  const invalidate = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: never) => {
    invalidateCalls.push(filters);
    return invalidate(filters);
  }) as typeof queryClient.invalidateQueries;

  const observer = new MutationObserver(
    queryClient,
    createChannelMutationOptions(queryClient, "u-1", "acme") as never,
  );
  await observer.mutate({ botId: "bot-1" } as never);

  const body = JSON.parse(String(asked[0]?.init?.body)) as {
    botId: string;
    clientRequestId: string;
  };
  expect(body.botId).toBe("bot-1");
  // The idempotency key is a uuid the client minted, one per press.
  expect(
    /^[0-9a-f-]{36}$/i.test(body.clientRequestId),
    `expected a uuid, got ${body.clientRequestId}`,
  ).toBe(true);
  expect(asked[0]?.input).toBe("/api/enterprise/v1/channels");
  expect(selectorOf(asked[0]?.init)).toBe("acme");
  expect(invalidateCalls).toEqual([
    { queryKey: [...tenantKeys.scope("u-1", "acme")] },
  ]);
});

test("archiving a channel posts to its own path and refreshes the tenant's views", async () => {
  const asked = intercept(() => jsonResponse(200, { channelId: "ch/1", status: "archived" }));
  const queryClient = freshClient();
  const invalidateCalls: unknown[] = [];
  const invalidate = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: never) => {
    invalidateCalls.push(filters);
    return invalidate(filters);
  }) as typeof queryClient.invalidateQueries;

  const observer = new MutationObserver(
    queryClient,
    archiveChannelMutationOptions(queryClient, "u-1", "acme") as never,
  );
  await observer.mutate({ channelId: "ch/1" } as never);

  expect(asked[0]?.input).toBe(
    `/api/enterprise/v1/channels/${encodeURIComponent("ch/1")}/archive`,
  );
  expect(asked[0]?.init?.method).toBe("POST");
  expect(selectorOf(asked[0]?.init)).toBe("acme");
  expect(invalidateCalls).toEqual([
    { queryKey: [...tenantKeys.scope("u-1", "acme")] },
  ]);
});
