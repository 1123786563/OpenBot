import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { routineKeys } from "./queries";

/** The selection pair a scoped write rides (MT089); a pending scope submits nothing. */
function scopeOptions(scope: ScopedCache | undefined) {
  return scope !== undefined && scope.status === "open"
    ? (scope.selection ?? {})
    : {};
}

/**
 * Writes against a person's own standing instructions.
 *
 * THERE IS NO CREATE AND NO EDIT HERE, on purpose: this page only shows and stops. Making a routine
 * and changing one are conversational, through the `RoutineTools` a Bot calls mid-chat — see
 * `server/src/routines/routes.ts` for the full reasoning.
 */

const FALLBACK = "That routine could not be changed.";

function invalidateRoutines(queryClient: QueryClient, scope?: ScopedCache) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: routineKeys.all }),
    ...(scope !== undefined && scope.status === "open"
      ? [
          queryClient.invalidateQueries({
            queryKey: [...scope.prefix, ...routineKeys.all],
          }),
        ]
      : []),
  ]);
}

/** Switch one routine on or off. Immediate; there is no save. Carries the scope (MT089 AC2). */
export function setRoutineEnabledMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: (variables: { id: string; enabled: boolean }) =>
      client(`/api/routines/${encodeURIComponent(variables.id)}/enabled`, {
        method: "PUT",
        body: { enabled: variables.enabled },
        fallback: FALLBACK,
        ...scopeOptions(scope),
      }),
    onSuccess: () => invalidateRoutines(queryClient, scope),
  });
}

export function deleteRoutineMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/routines/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: FALLBACK,
        ...scopeOptions(scope),
      }),
    onSuccess: () => invalidateRoutines(queryClient, scope),
  });
}

/**
 * Run now — the Test button. This DOES REAL WORK: the Bot carries out the instruction in the
 * routine's channel exactly as a scheduled firing would. Refused for a paused routine. Carries
 * the scope (MT089 AC2).
 */
export function runRoutineNowMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/routines/${encodeURIComponent(id)}/run`, {
        method: "POST",
        fallbackKey: "routines.start",
        ...scopeOptions(scope),
      }),
    onSuccess: () => invalidateRoutines(queryClient, scope),
  });
}
