import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { cacheWriteGate, type ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  type AgentProfile,
  type AgentVisibility,
  agentApiPath,
  agentKeys,
} from "./queries";

export type AgentInput = {
  name: string;
  title: string;
  roleDescription: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Empty means the Bot in the box. */
  endpoint?: string;
  /** Write-only auth value; omitted when the user leaves the key field empty. */
  auth?: { header: string; value: string };
};

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "Coworker operation failed";

/**
 * The scope the writes here submit under (MT084 / Issue #127, AC3): an open scope's selection
 * rides the request as the client's own per-request pair, and a pending one submits nothing — a
 * write cannot fire before its surface's scope source has answered.
 */
function scopeOptions(scope: ScopedCache | undefined) {
  return scope !== undefined && scope.status === "open"
    ? (scope.selection ?? {})
    : {};
}

/**
 * Server-derived fields are invalidated instead of patched by hand, in both homes: the roster's
 * unscoped entries, and — when a scope is in force — this scope's own subtree (MT083's prefix),
 * where the detail and configuration pages read.
 */
function invalidateAgents(queryClient: QueryClient, scope?: ScopedCache) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: agentKeys.all }),
    ...(scope !== undefined && scope.status === "open"
      ? [
          queryClient.invalidateQueries({
            queryKey: [...scope.prefix, ...agentKeys.all],
          }),
        ]
      : []),
  ]);
}

/**
 * The optimistic row a save paints before the server answers: the fields the form owns, exactly as
 * typed. Server-derived facts (`hasAuth`, callback tokens, derived summaries) stay as they were —
 * the settle's invalidation is what corrects them.
 */
function optimisticProfile(
  previous: AgentProfile,
  input: AgentInput,
): AgentProfile {
  return {
    ...previous,
    name: input.name,
    title: input.title,
    roleDescription: input.roleDescription,
    visibility: input.visibility,
    ...(input.endpoint !== undefined
      ? { endpoint: input.endpoint.trim() === "" ? null : input.endpoint }
      : {}),
  };
}

export function createAgentMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: (input: AgentInput): Promise<AgentProfile> =>
      client("/api/agents", "agent", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
        ...scopeOptions(scope),
      }),
    onSuccess: () => invalidateAgents(queryClient, scope),
  });
}

export function updateAgentMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      input: AgentInput;
    }): Promise<AgentProfile> =>
      client(agentApiPath(variables.agentId), "agent", {
        method: "PATCH",
        body: variables.input,
        fallback: FALLBACK,
        ...scopeOptions(scope),
      }),
    onMutate: (variables) => {
      // The configuration save paints its own row optimistically (MT084 AC3): the fields are the
      // person's own typing, so the row shows them at once. Only under an open scope — an
      // unscoped caller (not yet a scoped surface) keeps today's invalidate-on-settle behavior.
      if (scope === undefined || scope.status !== "open") return undefined;
      const detailKey = [
        ...scope.prefix,
        ...agentKeys.detail(variables.agentId),
      ];
      const previous = queryClient.getQueryData<AgentProfile>(detailKey);
      if (previous === undefined) return undefined;
      const gate = cacheWriteGate(queryClient, scope.userId);
      queryClient.setQueryData(
        detailKey,
        optimisticProfile(previous, variables.input),
      );
      return { detailKey, previous, gate };
    },
    onError: (_error, _variables, context) => {
      if (context === undefined) return;
      // A rollback that outlived its scope is dropped (MT083's gate): the switch already removed
      // this entry, and replaying the snapshot would resurrect the old scope's row beside — or
      // into — the scope that replaced it.
      if (context.gate.stillCurrent()) {
        queryClient.setQueryData(context.detailKey, context.previous);
      }
    },
    onSettled: () => invalidateAgents(queryClient, scope),
  });
}

export function duplicateAgentMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<AgentProfile> =>
      client(`${agentApiPath(agentId)}/duplicate`, "agent", {
        method: "POST",
        fallback: FALLBACK,
        ...scopeOptions(scope),
      }),
    onSuccess: () => invalidateAgents(queryClient, scope),
  });
}

export function setAgentHiddenMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; hidden: boolean }) => {
      await client(
        `${agentApiPath(variables.agentId)}/${variables.hidden ? "hide" : "unhide"}`,
        { method: "POST", fallback: FALLBACK, ...scopeOptions(scope) },
      );
    },
    onSuccess: () => invalidateAgents(queryClient, scope),
  });
}

export function setAgentPinnedMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; pinned: boolean }) => {
      await client(
        `${agentApiPath(variables.agentId)}/${variables.pinned ? "pin" : "unpin"}`,
        { method: "POST", fallback: FALLBACK, ...scopeOptions(scope) },
      );
    },
    onSuccess: () => invalidateAgents(queryClient, scope),
  });
}

export function deleteAgentMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(agentApiPath(agentId), {
        method: "DELETE",
        fallback: FALLBACK,
        ...scopeOptions(scope),
      });
    },
    onSuccess: () => invalidateAgents(queryClient, scope),
  });
}

/**
 * Issue this coworker a credential for calling tools back, and hand it over once.
 *
 * The token is in this response and nowhere else, ever again, so the caller has to show it to the
 * person immediately. Calling this on a coworker that already has one rotates it, which is how a
 * leaked token is retired.
 */
export function issueCallbackTokenMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<string> =>
      client(`${agentApiPath(agentId)}/callback-token`, "token", {
        method: "POST",
        fallback: FALLBACK,
        ...scopeOptions(scope),
      }),
    onSuccess: () => invalidateAgents(queryClient, scope),
  });
}

/** Take the credential away. The coworker may still talk; it may not reach anything outside a chat. */
export function revokeCallbackTokenMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(`${agentApiPath(agentId)}/callback-token`, {
        method: "DELETE",
        fallback: FALLBACK,
        ...scopeOptions(scope),
      });
    },
    onSuccess: () => invalidateAgents(queryClient, scope),
  });
}

/**
 * Whether one Bot may hand work to another.
 *
 * The same `plugin_grants` write every other grant makes, with `kind: "bot"`, so the audit row and
 * the refusals are the ones already in place: an administrator only, never a Bot on itself, and
 * never onto a Bot that does not exist.
 *
 * DIRECTIONAL, and the two ids are easy to swap: `agentId` is the Bot doing the asking and `ref` is
 * the Bot it may reach. Granted the other way round it reads as working and hands over nothing.
 */
export function setHandoffGrantMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      /** The Bot doing the asking. */
      agentId: string;
      /** The Bot it may reach. */
      ref: string;
      granted: boolean;
    }) => {
      if (variables.granted) {
        await client("/api/plugins/grants", {
          method: "POST",
          body: { kind: "bot", ref: variables.ref, agentId: variables.agentId },
          fallback: FALLBACK,
        });
        return;
      }
      await client(
        `/api/plugins/grants?kind=bot&ref=${encodeURIComponent(variables.ref)}&agentId=${encodeURIComponent(variables.agentId)}`,
        { method: "DELETE", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient, scope),
  });
}
