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
 * Who can still sign in once a registered provider is removed, read before an administrator removes
 * it.
 *
 * The server decides it by the rule sign-in applies, on account rows and not on the provider's email
 * domain: an account at another provider is a way in only while that provider is registered, a
 * password or social account only while Require SSO is off, and an address named as an emergency
 * admin keeps a way in either way. Either list is capped and `total` is over everybody.
 */
export type IdentityProviderImpact = {
  /** People who cannot sign in once this provider is gone. `emails` is the first few. */
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
 * What a failed impact read says when the server sent no sentence of its own. Exported because the
 * page shows the same sentence for a failure that sent nothing at all, so one read has one sentence.
 */
export const IMPACT_FALLBACK = "Couldn’t check who can still sign in.";

/**
 * Who can still sign in once one provider is removed, asked when its removal is being confirmed.
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
        { fallback: IMPACT_FALLBACK, signal },
      ),
  });
}
