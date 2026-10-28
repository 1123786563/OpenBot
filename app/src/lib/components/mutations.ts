import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { componentScopePair, invalidateComponentsInScope } from "./queries";

/**
 * Writes against a component's governance: publication, per-Bot grants, per-function grants, and the
 * draft description.
 *
 * Every one of these is a decision the server records and may refuse, so none of them patch the
 * cache — the list is invalidated and the screen re-reads whatever was actually decided.
 */

/** The sentence for every write here, for the rare case the server sends none of its own. */
const FALLBACK = "Component operation failed";

/** The path segment for one component, which is a tool name rather than an opaque id. */
function componentPath(name: string): string {
  return `/api/components/${encodeURIComponent(name)}`;
}

/**
 * Whether one Bot may answer with a component.
 *
 * Granting posts to the collection; withholding deletes from it. The absence of a grant is what
 * withholds it, so there is no third state to send.
 */
/*
 * Every governance write here submits under the scope in force (MT094 / Issue #137, AC3 —
 * 发布界面按服务端能力展示可用动作, the actions themselves ride the selection pair) and settles
 * at BOTH cache roots so the roster reflects the decision immediately (AC4).
 */
export function setComponentGrantMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      name: string;
      agentId: string;
      granted: boolean;
    }) => {
      const pair = componentScopePair(scope) ?? {};
      await (variables.granted
        ? client(`${componentPath(variables.name)}/grants`, {
            method: "POST",
            body: { agentId: variables.agentId },
            fallback: FALLBACK,
            ...pair,
          })
        : client(
            `${componentPath(variables.name)}/grants/${encodeURIComponent(variables.agentId)}`,
            { method: "DELETE", fallback: FALLBACK, ...pair },
          ));
    },
    onSuccess: () => invalidateComponentsInScope(queryClient, scope),
  });
}

/** Whether a component may read one deployment data function. */
export function setComponentFunctionMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      name: string;
      functionName: string;
      granted: boolean;
    }) => {
      const pair = componentScopePair(scope) ?? {};
      await (variables.granted
        ? client(`${componentPath(variables.name)}/functions`, {
            method: "POST",
            body: { function: variables.functionName },
            fallback: FALLBACK,
            ...pair,
          })
        : client(
            `${componentPath(variables.name)}/functions/${encodeURIComponent(variables.functionName)}`,
            { method: "DELETE", fallback: FALLBACK, ...pair },
          ));
    },
    onSuccess: () => invalidateComponentsInScope(queryClient, scope),
  });
}

/** Whether any Bot is told the component exists. */
export function setComponentPublishedMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (variables: { name: string; published: boolean }) => {
      await client(`${componentPath(variables.name)}/publication`, {
        method: "POST",
        body: { published: variables.published },
        fallback: FALLBACK,
        ...(componentScopePair(scope) ?? {}),
      });
    },
    onSuccess: () => invalidateComponentsInScope(queryClient, scope),
  });
}

/**
 * The description the model will read once it is published. Saving it changes nothing a Bot can see
 * until publication, which is why it is a separate write.
 */
export function saveComponentDraftMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (variables: { name: string; description: string }) => {
      await client(`${componentPath(variables.name)}/draft`, {
        method: "PUT",
        body: { description: variables.description },
        fallback: FALLBACK,
        ...(componentScopePair(scope) ?? {}),
      });
    },
    onSuccess: () => invalidateComponentsInScope(queryClient, scope),
  });
}
