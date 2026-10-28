import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/**
 * The realtime session consumption read (Bifrost 15.8, #321) as the browser sees it,
 * mirroring `/api/billing/credits/realtime-sessions` exactly.
 *
 * The account is never a parameter: the server resolves the payer from the session (the
 * same rule every credits read keeps), so this module sends no account identifier of any
 * kind — the sessions it answers are the signed-in reader's own, and only those. Amounts
 * are the ledger's own ×100 integers (`consumedCents`/`pendingCents`), scaled at render the
 * way `format.credits` expects, so the page's numbers and the ledger's cannot disagree.
 */

/** The session's abnormal state as the page reads it: the doors' own closed codes. */
export type RealtimeSessionAbnormal = {
  kind: "stopped" | "closed";
  reason: string;
  at: string;
};

/** One realtime session as the server's view answers it. */
export type RealtimeSessionUsage = {
  sessionId: string;
  provider: string;
  model: string;
  startedAt: string;
  state: "open" | "closed";
  stopped: boolean;
  closed: boolean;
  abnormal: RealtimeSessionAbnormal | null;
  units: {
    settled: number;
    holding: number;
    unknown: number;
    refused: number;
  };
  /** Settled units' charges, ×100 scaled integers. */
  consumedCents: number;
  /** Holding + unknown units' ceilings — awaiting settlement or disposal, ×100 scaled. */
  pendingCents: number;
};

export const realtimeKeys = {
  all: ["billing", "realtime"] as const,
  sessions: [...(["billing", "realtime"] as const), "sessions"] as const,
};

/** Reads the realtime sessions path; a 404 surface is the billing-unavailable fact. */
async function readSessions(
  fallback: string,
  selection: { tenantId: string; workspaceId: string } | null = null,
): Promise<{
  sessions: RealtimeSessionUsage[];
}> {
  const response = await tryClient("/api/billing/credits/realtime-sessions", {
    fallbackKey: "billing.scopedRead",
    ...(selection ?? {}),
  });
  if (response.status === 404) {
    throw new Error("Realtime usage is unavailable on this deployment.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? fallback);
  }
  return (await response.json()) as { sessions: RealtimeSessionUsage[] };
}

/**
 * The person's own realtime sessions — consumption, the amount awaiting settlement, and the
 * abnormal-state reason the doors wrote. Always fresh: a live session's money moves with
 * every unit, the same reason the balance read is uncached.
 */
export const realtimeSessionsQueryOptions = queryOptions({
  queryKey: realtimeKeys.sessions,
  staleTime: 0,
  queryFn: () => readSessions("Your realtime sessions could not be loaded."),
});

/** The scoped half: the same read filed under the scope in force (MT097's contract). */
export function scopedRealtimeSessionsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    enabled: open !== null,
    queryKey: open
      ? [...open.prefix, ...realtimeKeys.sessions]
      : [...realtimeKeys.sessions, ":scope-pending"],
    staleTime: 0,
    queryFn: () => {
      if (open === null) throw new Error("Billing data is not readable yet.");
      return guarded(queryClient, open.userId, () =>
        readSessions(
          "Your realtime sessions could not be loaded.",
          open.selection,
        ),
      );
    },
  });
}
