import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { clearActivity } from "./activity";
import { type ActionPolicy, computerKeys } from "./queries";

/** The selection pair a scoped write rides (MT086); a pending scope submits nothing. */
function scopeOptions(scope: ScopedCache | undefined) {
  return scope !== undefined && scope.status === "open"
    ? (scope.selection ?? {})
    : {};
}

/**
 * Stopping frees the container; resetting also deletes the browser profile; updating moves the
 * computer onto the current image and keeps the profile.
 */
export type ComputerAction = "stop" | "reset" | "update";

function invalidateComputers(queryClient: QueryClient, scope?: ScopedCache) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: computerKeys.all }),
    ...(scope !== undefined && scope.status === "open"
      ? [
          queryClient.invalidateQueries({
            queryKey: [...scope.prefix, ...computerKeys.all],
          }),
        ]
      : []),
  ]);
}

export function setComputerStateMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      action: ComputerAction;
    }) => {
      await client(
        `/api/computers/${encodeURIComponent(variables.botId)}/computers/${variables.action}`,
        {
          method: "POST",
          fallbackKey: `computers.stateWithAction.${variables.action}`,
          ...scopeOptions(scope),
        },
      );
    },
    /** A reset deletes the profile those commands ran on; a stop keeps it, so only reset forgets. */
    onSuccess: (_result, variables) => {
      if (variables.action === "reset") clearActivity(variables.botId);
      return invalidateComputers(queryClient, scope);
    },
  });
}

/**
 * Replace the whole policy.
 *
 * A PUT rather than a patch because the rules are ordered and evaluated as a set: sending a
 * difference would leave the server deciding where a new rule belongs, and where a deny sits
 * relative to an allow is most of what a policy means.
 */
export function saveActionPolicyMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: (next: ActionPolicy): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        method: "PUT",
        body: next,
        fallbackKey: "computers.saveBoundary",
        ...scopeOptions(scope),
      }),
    onSuccess: () => invalidateComputers(queryClient, scope),
  });
}
