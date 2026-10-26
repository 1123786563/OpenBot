import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { tenantKeys } from "./queries";
import {
  adoptExplicitSelection,
  readStoredSelection,
  type ScopeSelection,
  scopeAbortSignal,
  selectionKeys,
  selectionStorageKey,
} from "./selection";

/*
 * The streaming half of the selection transport, MT082 (Issue #125).
 *
 * WHERE MT081 LEFT OFF. `client.ts` attaches the selection pair (`x-openbot-tenant`,
 * `x-openbot-workspace`) as HEADERS on reviewed REST paths — a thing `fetch` can do. A streaming
 * connection cannot: `EventSource` and a browser `WebSocket` expose no way to set request headers
 * on the opening request, so on these surfaces the SAME pair rides the URL's query, under the same
 * two names, on the same kind of closed reviewed-path inventory (below). One vocabulary, so the
 * server-side wiring that reads the pair (MT125 lays the client selection onto the legacy
 * assembly) reads one set of names wherever the connection came from.
 *
 * THE LIFECYCLE HALF IS THE TICKET'S REAL SUBJECT. A stream that outlives its scope is a pipe
 * pushing one company's events into a screen that has moved on, so this module binds every
 * business stream's lifecycle to the selection: connections open only once the scope source has
 * resolved (never on a guess), carry the current pair when one exists, are torn down by the SAME
 * generation the REST reads guard with (`selectWorkspaceScope` advances it, so a stream opened
 * under one selection is refused the moment it changes), and re-read the selection at every
 * (re)connect — a dropped line that comes back answers under the scope that is current THEN, not
 * the one that was current when it dropped, and never a defaulted one (spec A6).
 *
 * THE LIVE SELECTION SOURCE. The pair a stream carries is this module's ONE cache entry
 * (`selectionKeys.current`): seeded from the per-account storage the selection page maintains,
 * moved by `selectWorkspaceScope` (the one switch seam), and mirrored across tabs through the
 * browser's own `storage` event — which is what makes a second tab's switch rebind the first
 * tab's streams (spec A10) using the same generation discipline, not a parallel mechanism.
 */

/** The transport this module serves: connection setups the browser will not let carry headers. */
export interface ScopeStreamPathEntry {
  /** Stable id, the tests name entries by. */
  readonly id: string;
  /** The path prefix the pair may ride on; the prefix itself is included. */
  readonly prefix: string;
  /** Why this stream path is trusted with the selection pair (non-empty). */
  readonly reason: string;
  /** The ticket that reviewed it (non-empty). */
  readonly ownerTicket: string;
}

/**
 * The closed inventory of reviewed same-origin stream paths the selection pair may ride
 * (MT082 / Issue #125).
 *
 * Same discipline as `SCOPE_HEADER_ALLOWED_PATHS` in client.ts: an entry exists because a ticket
 * reviewed the path, each names its owner and its reason, and widening the list is a review, not
 * an accident. The paths here are the deployment's legacy stream surfaces; the server does not
 * read the pair on them YET (MT125 wires the legacy assembly), but the connection lifecycle
 * already keys on it — a stream under one selection is torn down when the selection moves, which
 * is the guarantee this ticket owns even before the server consumes the pair.
 */
export const SCOPE_STREAM_ALLOWED_PATHS: readonly ScopeStreamPathEntry[] = [
  {
    id: "workshop-turn-events",
    prefix: "/api/workshop/",
    reason:
      "the workshop turn stream: an EventSource, which cannot carry request headers, so the pair rides the query on the one URL family this SSE opens (MT082 AC1)",
    ownerTicket: "MT082",
  },
  {
    id: "craft-turn-events",
    prefix: "/api/craft/",
    reason:
      "the craft session's turn and scheduled-run SSE reads: same connection family as the workshop stream, read by fetch but bound to the same lifecycle rule (MT082 AC1)",
    ownerTicket: "MT082",
  },
  {
    id: "channel-roster-events",
    prefix: "/api/channels/events",
    reason:
      "the channel roster's WebSocket: an upgrade request, which cannot carry request headers, so the pair rides the query (MT082 AC1)",
    ownerTicket: "MT082",
  },
  {
    id: "computer-screen-stream",
    prefix: "/api/computers/",
    reason:
      "the live computer screen's WebSocket: an upgrade request, which cannot carry request headers, so the pair rides the query (MT082 AC1)",
    ownerTicket: "MT082",
  },
  {
    id: "voice-call-establishment",
    prefix: "/api/voice/calls",
    reason:
      "the POST that establishes a voice call — the stream's subscription moment; the realtime socket it returns is a third-party origin and never receives the pair (MT082 AC1)",
    ownerTicket: "MT082",
  },
];

/**
 * The selection pair, riding a stream URL's query.
 *
 * Same-origin relative paths only — the same gate `client.ts` applies, so the pair cannot leak to
 * an origin the app never chose (the voice realtime socket's `wss://api.x.ai` address is exactly
 * that, and is deliberately left alone). `null` (personal context: no company/team selected)
 * changes nothing at all — a missing selection is carried as absent, never defaulted (spec A6).
 * Existing query parameters are preserved, because the workshop stream's own resume cursor rides
 * the same URL.
 */
export function withStreamScope(
  path: string,
  selection: ScopeSelection | null,
): string {
  if (selection === null) return path;
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  const queryAt = path.indexOf("?");
  const bare = queryAt === -1 ? path : path.slice(0, queryAt);
  if (
    !SCOPE_STREAM_ALLOWED_PATHS.some((entry) => bare.startsWith(entry.prefix))
  )
    return path;
  const pair =
    `x-openbot-tenant=${encodeURIComponent(selection.tenantId)}` +
    `&x-openbot-workspace=${encodeURIComponent(selection.workspaceId)}`;
  return queryAt === -1 ? `${path}?${pair}` : `${path}&${pair}`;
}

/**
 * What one stream opens against: the resolved selection world, or the fact it is not resolved yet.
 *
 * `pending` means the scope SOURCE has not answered — the signed-in user is still loading, so
 * nobody can say which selection (if any) this person holds. AC1's rule for that state is refusal:
 * a business subscription is not established on a guess. It resolves in practice as soon as the
 * auth read the route gate already made answers, because the storage read is synchronous.
 */
export type StreamScope =
  | { status: "pending" }
  | {
      status: "open";
      /** Whose streams these are — the guard keys the cache generation by it. */
      userId: string;
      /** The pair a connection carries, or null: personal context, carried as absent. */
      selection: ScopeSelection | null;
      /** The cache generation at render time; a stream opened under another one is stale. */
      generation: number;
      /**
       * Changes exactly when a live connection must rebind: the pair moved, or the generation the
       * whole tenant surface advances on a switch moved. Identity-stable between those moments,
       * so it is the one dependency a connection effect needs.
       */
      key: string;
    };

/** The pending answer, frozen: every unresolved scope is the same answer. */
const PENDING: StreamScope = { status: "pending" };

/*
 * The streaming half's abort face (T03.06): one re-export so a stream consumer imports its whole
 * binding — scope, URL pair and epoch signal — from this module alone.
 */
export { scopeAbortSignal };

/**
 * The cross-tab mirror of the selection (T03.06), as one bindable seam.
 *
 * The browser's `storage` event is how another tab's committed switch reaches this session; this
 * function runs the SAME explicit-act seam here (`adoptExplicitSelection` — the intent freezes
 * first, then the generation moves, then the old scope's cache goes), so a selection committed in
 * one tab rebinds the other tab's streams under the rules the caches already follow, not a
 * parallel mechanism beside them. A person acted — in another tab — so this session's in-flight
 * intents go stale with it, exactly as they would have had the act landed here. It is bound by
 * {@link useStreamScope} for the React tree and exported so the discipline is bindable — and
 * testable — outside a renderer. Idempotent: a second listener hears the same event and the
 * same-scope switch is a no-op.
 */
export function bindScopeStorageMirror(
  queryClient: QueryClient,
  userId: string,
): () => void {
  const key = selectionStorageKey(userId);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== key) return;
    adoptExplicitSelection(queryClient, userId, readStoredSelection(userId));
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/**
 * The selection every business stream opens against, as one reactive value.
 *
 * Reads the live current-selection entry (seeded from storage, moved by the switch seam) beside
 * the generation the tenant surface already guards its reads with, so a stream and a REST read
 * move on the SAME fact. Cross-tab, the browser's `storage` event runs the SAME switch seam
 * (`bindScopeStorageMirror`) in this tab — generation first, then the old scope's cache goes — so
 * a selection committed in one tab rebinds the other tab's streams under the rules the caches
 * already follow, not a parallel mechanism beside them.
 */
export function useStreamScope(): StreamScope {
  const queryClient = useQueryClient();
  const user = useQuery(currentUserQueryOptions());
  const userId = user.data?.id;
  const known = userId ?? ":unresolved";

  const generation = useQuery({
    queryKey: tenantKeys.generation(known),
    // The cache is the writer (`selectTenant` / `selectWorkspaceScope`); this observer never
    // fetches on its own — the queryFn only exists so the observer is a complete query, and it
    // answers with the same fact the cache holds.
    enabled: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: () =>
      queryClient.getQueryData<number>(tenantKeys.generation(known)) ?? 0,
    initialData: 0,
  });
  const selection = useQuery({
    queryKey: selectionKeys.current(known),
    enabled: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    // The one honest "fetch" of the selection: the same storage read the seed does.
    queryFn: () =>
      known === ":unresolved" ? null : readStoredSelection(known),
    // Seeded from the same storage the selection page maintains — the user's own last explicit
    // choice, which is exactly what a stream should carry until they choose again.
    initialData: () =>
      userId === undefined ? null : readStoredSelection(userId),
  });

  useEffect(() => {
    if (userId === undefined) return;
    // The full cross-tab discipline lives in one seam (T03.06): the generation advances and the
    // old scope's entries go, exactly as a switch in THIS tab would do (spec A10). Idempotent,
    // so a second listener on the same tab is a no-op.
    return bindScopeStorageMirror(queryClient, userId);
  }, [queryClient, userId]);

  return useMemo(() => {
    if (userId === undefined) return PENDING;
    const pair = selection.data ?? null;
    const current = generation.data ?? 0;
    return {
      status: "open",
      userId,
      selection: pair,
      generation: current,
      key: `${pair?.tenantId ?? ":personal"}/${pair?.workspaceId ?? "-"}@${current}`,
    };
  }, [userId, selection.data, generation.data]);
}

/**
 * Whether a stream opened at `openedAtGeneration` may still WRITE.
 *
 * The streaming counterpart of `guarded` in queries.ts: a message that left the server under one
 * selection and arrives after the switch is dropped rather than applied — it must not decorate
 * the roster the new scope is about to fill (MT082 AC4). The rebind closes the socket on the
 * same render; this guard is the belt for a frame already in flight through that teardown.
 */
export function streamWriteStillCurrent(
  queryClient: QueryClient,
  userId: string,
  openedAtGeneration: number,
): boolean {
  return (
    (queryClient.getQueryData<number>(tenantKeys.generation(userId)) ?? 0) ===
    openedAtGeneration
  );
}
