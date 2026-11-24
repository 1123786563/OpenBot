import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { enterpriseKeys } from "@/lib/enterprise/queries";
import { type Person, peopleKeys } from "./queries";

const FALLBACK = "Could not update that person";

function invalidatePeople(queryClient: QueryClient, userId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: peopleKeys.all }),
    queryClient.invalidateQueries({
      queryKey: enterpriseKeys.memberAccess(userId),
    }),
  ]);
}

export function setPersonRoleMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      userId: string;
      role: "admin" | "user";
    }): Promise<Person> =>
      client(`/api/admin/people/${variables.userId}/role`, "person", {
        method: "POST",
        body: { role: variables.role },
        fallback: FALLBACK,
      }),
    onSuccess: (_, { userId }) => invalidatePeople(queryClient, userId),
  });
}

/**
 * Remove somebody's access, or give it back.
 *
 * One mutation rather than two, because the row is a single decision with two directions and the
 * screen renders the same control either way.
 */
export function setPersonAccessMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      userId: string;
      revoked: boolean;
    }): Promise<Person> =>
      client(`/api/admin/people/${variables.userId}/access`, "person", {
        method: "POST",
        body: { revoked: variables.revoked },
        fallback: FALLBACK,
      }),
    onSuccess: (_, { userId }) => invalidatePeople(queryClient, userId),
  });
}
