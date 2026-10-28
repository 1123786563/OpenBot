import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { authKeys } from "./queries";

const FALLBACK = "Could not start the extra sign-in.";

/** What the challenge route issued for a company's extra sign-in (interfaces §5, T05.15). */
export type CompanyReauthChallenge = Readonly<{
  challengeId: string;
  redirectUrl: string;
  expiresAt: string;
}>;

/**
 * Start the company's additional authentication. The wall in `_authed` owns this write: it sends
 * the site-local return path, then hands the browser to the provider's `redirectUrl`, so the
 * whole app state dies with the navigation — no cache to invalidate, and no queryClient.
 */
export function companyReauthChallengeMutationOptions() {
  return mutationOptions({
    mutationFn: async (input: {
      tenantId: string;
      returnPath: string;
    }): Promise<CompanyReauthChallenge> => {
      const response = await client("/api/enterprise/company-auth/challenge", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      });
      // A malformed issuance is a failed one: the hand-off must never send the browser
      // somewhere the challenge did not actually name.
      const body = (await response.json().catch(() => null)) as unknown;
      if (body === null || typeof body !== "object") {
        throw new Error(FALLBACK);
      }
      const fields = body as Record<string, unknown>;
      for (const field of ["challengeId", "redirectUrl", "expiresAt"]) {
        if (typeof fields[field] !== "string" || fields[field] === "") {
          throw new Error(FALLBACK);
        }
      }
      return body as CompanyReauthChallenge;
    },
  });
}

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    fallbackKey: "auth.signOut",
  });
}

export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => queryClient.removeQueries({ queryKey: authKeys.all }),
  });
}
