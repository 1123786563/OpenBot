import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  PersonalConversation,
  TenantSummary,
} from "../../../../../shared/enterprise/mobile-schemas";

/**
 * The tenant member surface's reads, per plan F02 step 6: the tenant chooser, the personal
 * channel page, and one channel's persisted record.
 *
 * THE TWO RULES THE TENANCY DESIGN IMPOSES ON A CLIENT. First, the selector rides the request:
 * every call passes `tenantId` to `client`, which attaches `x-openbot-tenant` for same-origin
 * enterprise paths only — there is no module-level "current tenant" here, matching the server's
 * own rule (tenancy/scope.ts resolves the scope from the header per request). Second, the cache
 * is scoped: every key names the user and the tenant, so one person's two tenants never share an
 * entry, and switching tenants removes the old tenant's entries and advances a generation — a
 * response that left under one selection and lands under another is refused by the guard in
 * {@link guarded}, instead of decorating a screen the user has already left.
 *
 * The wire shapes are the frozen mobile contract (shared/enterprise/mobile-schemas.ts), the same
 * schema the server parses rows with — imported as types so a drift is a compile error here too.
 * What this surface does NOT have: a channel-to-run mapping. Run state is read by run id
 * (`POST`/`GET /runs/:id`, mounted conditionally), and the channel's persisted record carries no
 * run id — so the channel's `status` is the whole state a channel page can read, and these
 * factories do not invent more.
 */

export type { PersonalConversation, TenantSummary };

/** One page of the owner's channels, the frozen cursor envelope. */
export type ChannelPage = {
  items: PersonalConversation[];
  nextCursor: string | null;
};

/** The tenant chooser's answer: this user's fully active memberships, nothing else. */
export type TenantChooser = { items: TenantSummary[] };

/*
 * Reserved second-element tokens. A tenant id matches `^[A-Za-z0-9_-]{1,128}$`
 * (tenancy/scope.ts SELECTOR_PATTERN), so the leading colon keeps these from ever colliding with
 * one — which is what lets `forgetTenantQueries` remove a tenant subtree by prefix.
 */
const CHOOSER = ":chooser";
const GENERATION = ":generation";

export const tenantKeys = {
  all: ["enterprise-tenant"] as const,
  /** The membership list, scoped to the person — the one read that needs no tenant. */
  chooser: (userId: string) => [...tenantKeys.all, userId, CHOOSER] as const,
  /** The selection's generation. Read by the guard, advanced by {@link selectTenant}. */
  generation: (userId: string) =>
    [...tenantKeys.all, userId, GENERATION] as const,
  /** Everything one tenant answers for, the prefix removal targets. */
  scope: (userId: string, tenantId: string) =>
    [...tenantKeys.all, userId, tenantId] as const,
  channels: (userId: string, tenantId: string, cursor: string | null) =>
    [...tenantKeys.scope(userId, tenantId), "channels", { cursor }] as const,
  channel: (userId: string, tenantId: string, channelId: string) =>
    [...tenantKeys.scope(userId, tenantId), "channel", channelId] as const,
};

function generationOf(queryClient: QueryClient, userId: string): number {
  return queryClient.getQueryData<number>(tenantKeys.generation(userId)) ?? 0;
}

/**
 * The refusal an outlived selection raises. Typed so a caller that wants to swallow it can name
 * it, and everything else still surfaces as the error it is.
 */
export class TenantSelectionChangedError extends Error {
  constructor() {
    super("That answer outlived the tenant it was asked under.");
    this.name = "TenantSelectionChangedError";
  }
}

/**
 * Run `fetch_`, but refuse its answer if the selection moved while it was in flight.
 *
 * The generation is read from the `QueryClient` — the one store this app already scopes per test
 * and per app instance — rather than from module state, so two live views never advance each
 * other's counter. A refused answer throws: React Query records the error on the entry that asked,
 * which a tenant switch has already removed, and the entry now on screen is untouched.
 */
async function guarded<T>(
  queryClient: QueryClient,
  userId: string,
  fetch_: () => Promise<T>,
): Promise<T> {
  const atStart = generationOf(queryClient, userId);
  const value = await fetch_();
  if (generationOf(queryClient, userId) !== atStart) {
    throw new TenantSelectionChangedError();
  }
  return value;
}

/**
 * The whole switch: advance the generation first, then drop the old tenant's cache.
 *
 * Order matters — the generation moves before any cache goes, so a response already in flight
 * against the old tenant is refused on arrival rather than written into an entry about to be
 * removed and resurrected. Dropping (not invalidating) is deliberate: a stale row from another
 * tenant's grant state must not be visible for one render while the refetch runs.
 */
export function selectTenant(
  queryClient: QueryClient,
  userId: string,
  previousTenantId: string | null,
  nextTenantId: string | null,
): void {
  if (previousTenantId === nextTenantId) return;
  queryClient.setQueryData(
    tenantKeys.generation(userId),
    generationOf(queryClient, userId) + 1,
  );
  if (previousTenantId !== null) {
    queryClient.removeQueries({
      queryKey: tenantKeys.scope(userId, previousTenantId),
    });
  }
}

/** The tenant chooser: which tenants this person may select at all. */
export function tenantsQueryOptions(userId: string) {
  return queryOptions({
    queryKey: tenantKeys.chooser(userId),
    queryFn: async (): Promise<TenantChooser> =>
      (
        await client("/api/enterprise/v1/tenants", {
          // The chooser is answered before the scope middleware: naming a tenant here would be
          // circular, and the server reads no header for it.
          fallback: "Could not load your tenants",
        })
      ).json(),
  });
}

function channelPagePath(cursor: string | null): string {
  return cursor === null
    ? "/api/enterprise/v1/channels"
    : `/api/enterprise/v1/channels?cursor=${encodeURIComponent(cursor)}`;
}

/** One page of the selected tenant's channels this person owns. */
export function channelsQueryOptions(
  queryClient: QueryClient,
  userId: string,
  tenantId: string,
  cursor: string | null = null,
) {
  return queryOptions({
    queryKey: tenantKeys.channels(userId, tenantId, cursor),
    queryFn: async ({ signal }): Promise<ChannelPage> =>
      guarded(queryClient, userId, async () => {
        const response = await client(channelPagePath(cursor), {
          tenantId,
          signal,
          fallback: "Could not load your channels",
        });
        return (await response.json()) as ChannelPage;
      }),
  });
}

/** One channel's persisted record: the whole state this API publishes about it. */
export function channelQueryOptions(
  queryClient: QueryClient,
  userId: string,
  tenantId: string,
  channelId: string,
) {
  return queryOptions({
    queryKey: tenantKeys.channel(userId, tenantId, channelId),
    queryFn: async ({ signal }): Promise<PersonalConversation> =>
      guarded(queryClient, userId, async () => {
        const response = await client(
          `/api/enterprise/v1/channels/${encodeURIComponent(channelId)}`,
          {
            tenantId,
            signal,
            fallback: "Could not load that channel",
          },
        );
        return (await response.json()) as PersonalConversation;
      }),
  });
}
