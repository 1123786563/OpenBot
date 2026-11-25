import { queryOptions } from "@tanstack/react-query";
import { ClientError, client } from "@/lib/client";

/**
 * An identity provider a company registered, rather than one this deployment was configured with.
 *
 * The three in the environment are Google, Entra and Okta. These are somebody's own: registered
 * while the deployment is running, from metadata their identity team supplied, and there can be
 * several. A company mid-merger has two.
 */
export type IdentityProvider = {
  providerId: string;
  issuer: string;
  /** The email domain that routes somebody here. */
  domain: string;
  /** Which protocol it speaks. SAML is what most enterprise identity teams hand over. */
  protocol: "saml" | "oidc";
  /**
   * Whether the person who registered it still has an account here. Null once they are gone.
   *
   * Shown so somebody auditing a deployment can see that a provider outlived whoever set it up,
   * which is the normal case a year in and used to be the case where the provider vanished instead.
   */
  registeredBy: string | null;
};

/**
 * Who a registered provider is the only way in for, read before an administrator removes it.
 *
 * The account rows decide, not the provider's email domain: somebody who signed in through a
 * provider may still sign in with Google or a password, and somebody the configuration names as an
 * emergency admin is exempt. Either list is capped and `total` is over everybody.
 */
export type IdentityProviderImpact = {
  /** People with no other account and no emergency address. `emails` is the first few. */
  losing: { total: number; emails: string[] };
  /** People who keep a way in, and why. `accounts` is the first few. */
  keeping: {
    total: number;
    accounts: {
      email: string;
      reason: "another-sign-in" | "emergency-admin";
    }[];
  };
  /** Whether the person asking is among those losing their only way in. */
  includesYou: boolean;
};

export const identityProviderKeys = {
  all: ["identity-providers"] as const,
  list: () => ["identity-providers", "list"] as const,
  impact: (providerId: string) =>
    ["identity-providers", "impact", providerId] as const,
};

export function identityProvidersAccessDenied(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    (error.status === 401 || error.status === 403)
  );
}

/**
 * The registered providers.
 *
 * Read from our own admin route, not Better Auth's `GET /sso/providers`. That one answers with the
 * providers the person asking registered themselves, so two administrators saw two different
 * deployments and the second one to open this screen found it empty and registered a provider that
 * already existed. What is registered is a fact about the deployment.
 *
 * The payload carries no client secret or signing certificate; the server's projection cannot express
 * them.
 */
export function identityProviderListQueryOptions() {
  return queryOptions({
    queryKey: identityProviderKeys.list(),
    retry: (failures, error) =>
      failures < 1 && !identityProvidersAccessDenied(error),
    queryFn: ({
      client: cache,
      queryKey,
      signal,
    }): Promise<IdentityProvider[]> =>
      client<IdentityProvider[]>("/api/admin/identity-providers", "providers", {
        fallback: "Could not load identity providers",
        signal,
      }).catch((error: unknown) => {
        if (identityProvidersAccessDenied(error)) {
          cache.setQueryData<IdentityProvider[]>(queryKey, (current) =>
            current?.length ? [] : current,
          );
        }
        throw error;
      }),
  });
}

/**
 * Who signs in through one provider, asked when its removal is being confirmed.
 *
 * `staleTime: 0` because the accounts move: the dialog is opened to decide about this moment, and a
 * cached answer from five minutes ago would name somebody who has since added another way in.
 */
export function identityProviderImpactQueryOptions(providerId: string) {
  return queryOptions({
    queryKey: identityProviderKeys.impact(providerId),
    staleTime: 0,
    // A provider that is gone stays gone: retrying a 404 only delays saying so.
    retry: (failures, error) =>
      failures < 1 &&
      !identityProvidersAccessDenied(error) &&
      !(error instanceof ClientError && error.status === 404),
    queryFn: ({ signal }): Promise<IdentityProviderImpact> =>
      client<IdentityProviderImpact>(
        `/api/admin/identity-providers/${encodeURIComponent(providerId)}/impact`,
        "impact",
        { fallback: "Could not check who signs in with this provider", signal },
      ),
  });
}
