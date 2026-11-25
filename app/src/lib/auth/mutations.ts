import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { t } from "@/i18n";
import { client } from "@/lib/client";
import { type AuthenticatedUser, authKeys } from "./queries";

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    // What a refused sign-out means whoever answers it (Better Auth puts its sentence where `client` does not read).
    fallback: "Signing out did not finish. Try again.",
  });
}

export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: authKeys.all });
    },
  });
}

/** Saves the person's display name, then refreshes who they are. */
export function updateProfileNameMutationOptions(queryClient: QueryClient) {
  const queryKey = authKeys.currentUser();
  return mutationOptions({
    mutationFn: (name: string) =>
      client<{ name: string; needsName: boolean }>(
        "/api/me/profile",
        "profile",
        {
          method: "PATCH",
          body: { name },
          // Read when the mutation runs, in the language in force then.
          fallback: t(
            "settings.name.saveFailed",
            "Your name could not be saved",
          ),
        },
      ),
    onMutate: () =>
      queryClient.getQueryData<AuthenticatedUser | null>(queryKey)?.id,
    onSuccess: async (profile, _name, ownerId) => {
      if (ownerId && profile) {
        await queryClient.cancelQueries({ queryKey, exact: true });
        queryClient.setQueryData<AuthenticatedUser | null>(
          queryKey,
          (current) =>
            current?.id === ownerId
              ? { ...current, name: profile.name, needsName: profile.needsName }
              : current,
        );
      }
      return queryClient.invalidateQueries({
        queryKey,
        refetchType: "all",
      });
    },
  });
}
