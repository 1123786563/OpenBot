import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/** One Bot's computer, as Admin sees it. */
export type ComputerProfile = {
  botId: string;
  running: boolean;
  startedAt: string | null;
  /** Absent when the provider does not report egress at all, which is not the same as none. */
  egress?: string | null;
  /** True when it runs an older image than a new computer would. Absent where that cannot be told. */
  updateAvailable?: boolean;
};

/** Whether each Bot has a browser profile of its own, or they share one. */
export type ComputerIsolation = "per-bot" | "shared";

/** What the list endpoint answers: the computers, and how they are separated. */
export type ComputerFleet = {
  computers: ComputerProfile[];
  isolation?: ComputerIsolation;
};

/**
 * Whether the boundary acts on its verdict.
 *
 * `dry-run` records what it would have refused without refusing it, which is how a policy is tried
 * out before it stops a Bot mid-task.
 */
export type PolicyMode = "dry-run" | "enforce";

/** The rules a Bot's actions are judged against. */
export type ActionPolicy = {
  mode: PolicyMode;
  deny: string[];
  allow: string[];
};

export const computerKeys = {
  all: ["computers"] as const,
  fleet: () => ["computers", "fleet"] as const,
  policy: () => ["computers", "policy"] as const,
};

/**
 * The deployment-wide fleet route.
 *
 * Not a Bot id in a member route, which is what this used to be. That placeholder stopped working
 * when the server began checking whether the caller may act as the Bot in the path: a placeholder
 * is not a Bot, so the list 404d and this screen showed nothing at all.
 */
const FLEET_PATH = "/api/computers/fleet";

/** No envelope key: the body carries both the list and the isolation mode. */
export function computerFleetQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.fleet(),
    queryFn: async (): Promise<ComputerFleet> => {
      const response = await client(FLEET_PATH, {
        fallbackKey: "computers.list",
      });
      return response.json();
    },
  });
}

export function actionPolicyQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.policy(),
    queryFn: (): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        fallbackKey: "computers.readBoundary",
      }),
  });
}

// ---------------------------------------------------------------------------
// The scoped half (MT086 / Issue #129): the computers pages read and act through here
// ---------------------------------------------------------------------------

/**
 * The refusal a scoped computers read raises when the server answers that the surface is not this
 * person's to hold under the scope they carry — an administrator surface under a suspended
 * company. One state for the page to answer with, never a blank fleet (MT086 AC2).
 */
export class ComputersUnavailableError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Computers are not available under the scope you hold.");
    this.name = "ComputersUnavailableError";
    this.status = status;
  }
}

/**
 * A scoped computers read: keyed under the scope's own cache prefix (MT083), carrying the
 * selection pair, answered through the generation guard, and refusing the pair-shaped refusal
 * (404, the canonical no-leak answer) as the one typed unavailable state.
 */
function scopedComputersRead<T>(
  queryClient: QueryClient,
  scope: ScopedCache,
  path: string,
  fallbackKey: string,
  /** The read-failure sentence, the unscoped read's own fallback for the same surface. */
  failure: string,
  /** The envelope key the unscoped read unwraps ("policy"); null reads the whole body. */
  envelope: string | null,
  pendingKey: readonly unknown[],
  scopedKey: readonly unknown[],
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey: open !== null ? scopedKey : pendingKey,
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<T>(() => {})
        : async ({ signal }): Promise<T> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient(path, {
                signal,
                fallbackKey,
                ...(open.selection ?? {}),
              });
              if (response.status === 404) {
                throw new ComputersUnavailableError(response.status);
              }
              if (!response.ok) {
                // The server's own sentence when it sent one — the boundaries admin gate's 403
                // names the remedy — and the surface's own fallback when it did not.
                const body = (await response.json().catch(() => null)) as {
                  error?: unknown;
                } | null;
                throw new Error(
                  typeof body?.error === "string" ? body.error : failure,
                );
              }
              if (envelope === null) {
                return (await response.json()) as T;
              }
              const body = (await response.json().catch(() => null)) as {
                [key: string]: unknown;
              } | null;
              if (body === null || body[envelope] === undefined) {
                throw new Error("The computer surface could not be read.");
              }
              return body[envelope] as T;
            }),
  });
}

/** The fleet route, bound to the scope the screen holds (MT086 / Issue #129, AC1). */
export function scopedComputerFleetQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return scopedComputersRead<ComputerFleet>(
    queryClient,
    scope,
    FLEET_PATH,
    "computers.list",
    "The computer surface could not be read.",
    null,
    [...computerKeys.fleet(), ":scope-pending"],
    scope.status === "open"
      ? [...scope.prefix, ...computerKeys.fleet()]
      : [...computerKeys.fleet(), ":scope-pending"],
  );
}

/** The action boundary, bound to the scope the screen holds (MT086 / Issue #129, AC1). */
export function scopedActionPolicyQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return scopedComputersRead<ActionPolicy>(
    queryClient,
    scope,
    "/api/computers/policy",
    "computers.readBoundary",
    "The boundary could not be read.",
    "policy",
    [...computerKeys.policy(), ":scope-pending"],
    scope.status === "open"
      ? [...scope.prefix, ...computerKeys.policy()]
      : [...computerKeys.policy(), ":scope-pending"],
  );
}

/** One recorded action a candidate policy would decide differently than what happened. */
export type DryRunChange = {
  id: string;
  createdAt: string;
  action: string;
  bot: string;
  page: string;
  element: { role: string; name: string } | null;
  command: string | null;
  file: string | null;
  was: "allowed" | "refused";
  would: "allowed" | "refused";
  rule: string | null;
  reason: string;
};

export type DryRunReport = {
  scanned: number;
  wouldRefuse: number;
  wouldAllow: number;
  unchanged: number;
  /** Capped by the server; the counts cover everything scanned. */
  changes: DryRunChange[];
};

/**
 * What would this policy have decided, about recent recorded actions?
 *
 * A plain function rather than a query: the answer is about this candidate at this moment, nothing
 * caches it and nothing invalidates it. It writes nothing — not the policy, and no audit row.
 */
export async function dryRunActionPolicy(
  candidate: ActionPolicy,
): Promise<DryRunReport> {
  return client("/api/computers/policy-dry-run", "report", {
    method: "POST",
    body: { policy: candidate },
    fallbackKey: "computers.testBoundary",
  });
}
