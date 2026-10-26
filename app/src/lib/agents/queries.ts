import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

export type AgentVisibility = "public" | "private";

/**
 * A coworker as the browser sees it.
 *
 * `canManage` and `systemOwned` are server-decided authorization facts; components render from the
 * returned flags rather than recomputing ownership rules.
 */
export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /**
   * Whether it runs on this deployment's own Bot.
   *
   * Creating a coworker with no endpoint stores the deployment's managed address, so `endpoint`
   * alone cannot tell "built-in" from "hosted by a person" — and the difference decides whether the
   * Connection screen asks for a callback token. A built-in coworker calls tools back with the
   * deployment's own credential and needs no setup at all.
   */
  builtIn: boolean;
  /** Whether a key is set for it. Never the key itself. */
  hasAuth: boolean;
  /**
   * Whether this coworker holds a credential for calling tools back.
   *
   * A boolean, because the token is readable exactly once: in the response that issued it. The
   * surface needs this only to decide between offering "generate" and "rotate".
   */
  hasCallbackToken: boolean;
  hidden: boolean;
  /** Whether the signed-in person pinned it to the top of their Bots list. Nobody else's. */
  pinned: boolean;
  /** A Team Bot an administrator assigned to this person; their Bots list always pins it. */
  assignedToMe?: boolean;
  systemOwned: boolean;
  canManage: boolean;
  /**
   * Whether the signed-in person created this coworker.
   *
   * Separate from `canManage`, which is also true for administrators on everybody's coworkers. Split
   * a roster on `canManage` and an administrator's "mine" fills up with other people's work.
   */
  mine: boolean;
};

/**
 * Whether this is an agent shared with you: made public by somebody else, not your own.
 *
 * Written once so every list of "shared with you" — the home screen's carousel among them — filters
 * through this rule rather than a copy of it.
 */
export function isSharedWithYou(agent: AgentProfile): boolean {
  return !agent.mine && agent.visibility === "public";
}

export const agentKeys = {
  all: ["agents"] as const,
  list: (hidden = false) => ["agents", "list", { hidden }] as const,
  detail: (agentId: string) => ["agents", "detail", agentId] as const,
  handoff: (agentId: string) => ["agents", "handoff", agentId] as const,
  capabilities: () => ["agents", "capabilities"] as const,
};

/** What kinds of coworker this deployment can create. */
export type AgentCapabilities = {
  /** Whether a coworker can run on the deployment's own Bot, with no endpoint of its own. */
  builtInAvailable: boolean;
};

export function agentCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: agentKeys.capabilities(),
    queryFn: (): Promise<AgentCapabilities> =>
      client("/api/agents/capabilities", "capabilities", {
        fallbackKey: "agents.loadSupport",
      }),
    // Deployment configuration, not data: it cannot change without the server restarting.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Which Bots one Bot may hand work to, and whether this deployment lets it. */
export type HandoffGrants = {
  /**
   * Whether the capability is switched on at all.
   *
   * Separate from the grants because the two fail differently: with this false, a grant is a row
   * nothing will ever read, so the screen says so rather than offering a switch wired to nothing.
   */
  enabled: boolean;
  /** Whether the signed-in person may change any of it. Granting is an administrator's. */
  canGrant: boolean;
  /** Bot ids this Bot may address today. */
  reachable: string[];
  /**
   * Whether this Bot can hold such a grant at all.
   *
   * The handing-on tool executes inside this deployment's own run loop, so only a Bot that runs in
   * it can be offered one. False means every grant would be refused, and the screen should say that
   * once instead of letting each switch bounce with the same message.
   */
  grantable: boolean;
};

export function agentListQueryOptions(hidden = false) {
  return queryOptions({
    queryKey: agentKeys.list(hidden),
    queryFn: (): Promise<AgentProfile[]> =>
      client(`/api/agents${hidden ? "?hidden=true" : ""}`, "agents", {
        fallbackKey: "agents.load",
      }),
  });
}

/**
 * The roster a picker offers, bound to the scope the screen holds (MT087 / Issue #130, AC2): keyed
 * under the scope's own cache prefix (MT083), carrying the selection pair, and answered through the
 * generation guard — so the candidates a "who to talk to" list offers are the server's answer
 * under the scope in force, and a Bot of another scope is never offered because the server never
 * names it. The unscoped list stays for the surfaces this ticket does not bind.
 */
export function scopedAgentListQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  hidden = false,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...agentKeys.list(hidden)]
        : [...agentKeys.list(hidden), ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<AgentProfile[]>(() => {})
        : async ({ signal }): Promise<AgentProfile[]> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient(
                `/api/agents${hidden ? "?hidden=true" : ""}`,
                { signal, fallbackKey: "agents.load", ...(open.selection ?? {}) },
              );
              if (!response.ok) {
                throw new Error("Coworkers could not be read.");
              }
              const body = (await response.json().catch(() => null)) as {
                agents?: AgentProfile[];
              } | null;
              if (body === null || !Array.isArray(body.agents)) {
                throw new Error("Coworkers could not be read.");
              }
              return body.agents;
            }),
  });
}

/** Package-defined IDs remain one path segment without changing their stored or cache identity. */
export function agentApiPath(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}`;
}

export function agentQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.detail(agentId),
    queryFn: (): Promise<AgentProfile> =>
      client(agentApiPath(agentId), "agent", {
        fallbackKey: "agents.loadOne",
      }),
  });
}

// ---------------------------------------------------------------------------
// The scoped half (MT084 / Issue #127): the Bot detail and configuration pages read through here
// ---------------------------------------------------------------------------

/**
 * The refusal a scoped detail read raises when the server answers that this coworker is not this
 * person's to see under the scope they hold.
 *
 * A 404 is the server's canonical no-leak answer — the same status whether the coworker never
 * existed or belongs to a scope this person has left — so the client maps every 404 to this one
 * typed refusal and the pages answer it with ONE unavailable state, never a sentence that would
 * tell the reader which of the two it was.
 */
export class AgentUnavailableError extends Error {
  constructor() {
    super("That coworker is not available under the scope you hold.");
    this.name = "AgentUnavailableError";
  }
}

/** The sentence a malformed-but-ok answer falls back to, a failed read rather than a missing one. */
const DETAIL_FALLBACK = "That coworker could not be read.";

/**
 * The Bot detail read, bound to the scope the screen holds (MT084 / Issue #127, AC1).
 *
 * The key composes onto the scope's own cache prefix (`scoped-cache.ts`, MT083), so one person's
 * two scopes never share an entry and a switch drops the old scope's row wholesale; the request
 * carries the selection pair (client.ts's reviewed inventory carries it on `/api/agents`); and the
 * answer passes the SAME generation guard the tenant face uses (`guarded`), so a response that left
 * under one selection and lands under another is refused instead of decorating the new scope.
 *
 * `scope.status === "pending"` (the signed-in user unresolved) refuses rather than guesses, the
 * same rule the streaming faces live by: the query sits disabled until the scope source answers.
 */
export function scopedAgentDetailQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  agentId: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...agentKeys.detail(agentId)]
        : [...agentKeys.detail(agentId), ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<AgentProfile>(() => {})
        : async ({ signal }): Promise<AgentProfile> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient(agentApiPath(agentId), {
                signal,
                fallbackKey: "agents.loadOne",
                ...(open.selection ?? {}),
              });
              if (!response.ok) {
                if (response.status === 404) throw new AgentUnavailableError();
                const body = (await response.json().catch(() => null)) as {
                  error?: unknown;
                } | null;
                throw new Error(
                  typeof body?.error === "string"
                    ? body.error
                    : DETAIL_FALLBACK,
                );
              }
              const body = (await response.json().catch(() => null)) as {
                agent?: AgentProfile;
              } | null;
              if (
                body === null ||
                typeof body !== "object" ||
                body.agent === null ||
                typeof body.agent !== "object"
              ) {
                throw new Error(DETAIL_FALLBACK);
              }
              return body.agent;
            }),
  });
}

/**
 * The handoff grants, bound to the scope the screen holds (MOD19 / Issue #639, T1b): keyed under
 * the scope's own cache prefix, carrying the selection pair, answered through the same generation
 * guard every scoped read passes — the shape `scopedAgentDetailQueryOptions` (MT084) established,
 * so the delegation screen reads its Bot under the scope in force and a late answer from another
 * selection is refused rather than drawn.
 */
export function scopedAgentHandoffQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  agentId: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...agentKeys.handoff(agentId)]
        : [...agentKeys.handoff(agentId), ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<HandoffGrants>(() => {})
        : async ({ signal }): Promise<HandoffGrants> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient(
                `${agentApiPath(agentId)}/handoff`,
                { signal, fallbackKey: "agents.loadDelegation", ...(open.selection ?? {}) },
              );
              if (!response.ok) {
                if (response.status === 404) throw new AgentUnavailableError();
                throw new Error("The delegation could not be read.");
              }
              const body = (await response.json().catch(() => null)) as {
                handoff?: HandoffGrants;
              } | null;
              if (
                body === null ||
                typeof body !== "object" ||
                body.handoff === null ||
                typeof body.handoff !== "object"
              ) {
                throw new Error("The delegation could not be read.");
              }
              return body.handoff;
            }),
  });
}

/** What the server said when it tried the endpoint. */
export type ConnectionVerdict =
  | { ok: true; events: string[] }
  | { ok: false; reason: string };

/**
 * Ask the server to reach a coworker's endpoint, from where a run will reach it.
 *
 * A plain function rather than a factory: the answer is about this moment, nothing caches it, and
 * there is no key for anything to invalidate. Fails closed, like the other verdicts here — an
 * endpoint that cannot be tested is reported as unreachable rather than thrown at the form.
 *
 * The unsaved key is sent so the test matches the form as it stands, not as it was last saved.
 */
export async function testAgentConnection(
  endpoint: string,
  key: string,
): Promise<ConnectionVerdict> {
  try {
    const response = await tryClient("/api/agents/test-connection", {
      method: "POST",
      body: {
        endpoint,
        ...(key.trim() ? { headers: { Authorization: key.trim() } } : {}),
      },
    });
    const body = (await response.json().catch(() => null)) as
      | ConnectionVerdict
      | { error?: string }
      | null;
    if (body && "ok" in body) return body;
    return {
      ok: false,
      reason:
        (body as { error?: string } | null)?.error ??
        "The connection could not be tested.",
    };
  } catch {
    return { ok: false, reason: "The connection could not be tested." };
  }
}
