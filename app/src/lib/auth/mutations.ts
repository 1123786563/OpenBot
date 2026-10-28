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

import { queryOptions } from "@tanstack/react-query";
/*
 * The platform account-admin actions, T05.16 (P13). Every write goes through the native admin
 * surface the ingress translates into an identity command (T05.08), so the people screen holds
 * no authorization of its own: the platform gate answers, the receipt comes back, the roster is
 * refreshed. The one client-side consequence these factories own is the teardown below.
 */
import { tenantKeys } from "@/lib/enterprise/tenant/queries";
import { peopleKeys } from "@/lib/people/queries";
import {
  type PlatformIdentityReceipt,
  platformCreateUser,
  platformListUserSessions,
  platformRevokeUserSession,
  platformRevokeUserSessions,
  platformSetUserPassword,
  platformUpdateUserProfile,
} from "./client";

const PLATFORM_SESSIONS = "platform-sessions";

/** One person's sessions, asked of the platform read while their panel is open. */
export function platformUserSessionsQueryOptions(userId: string) {
  return queryOptions({
    queryKey: [...authKeys.all, PLATFORM_SESSIONS, userId],
    queryFn: () => platformListUserSessions({ userId }),
  });
}

/**
 * Drop the identity state this browser held, after an action that killed the session it rides.
 *
 * A password write or a session sweep ends every session of the person it names. When that
 * person is the one at this keyboard, the cookies are dead but the app still holds who they
 * were and the company they had selected, and neither may outlive the session that earned
 * them. The screen cannot always tell whether it just did this to itself (the current user is
 * not always loaded yet), so the safe side wins: unless the target is positively somebody
 * else, the old identity and selection state goes.
 */
export function clearOldIdentityState(
  queryClient: QueryClient,
  targetUserId: string,
  currentUserId: string | null,
): void {
  if (currentUserId !== null && currentUserId !== targetUserId) return;
  queryClient.removeQueries({ queryKey: authKeys.all });
  queryClient.removeQueries({ queryKey: tenantKeys.all });
}

function refreshRoster(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: peopleKeys.all });
}

function refreshSessions(queryClient: QueryClient, userId: string) {
  return queryClient.invalidateQueries({
    queryKey: [...authKeys.all, PLATFORM_SESSIONS, userId],
  });
}

export function createPlatformUserMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: platformCreateUser,
    onSuccess: () => refreshRoster(queryClient),
  });
}

export function updatePlatformUserProfileMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: platformUpdateUserProfile,
    onSuccess: () => refreshRoster(queryClient),
  });
}

/**
 * A password write that names the admin's own account signs this browser out with it; the
 * teardown is why the factory needs to know who is asking.
 */
export function setPlatformUserPasswordMutationOptions(
  queryClient: QueryClient,
  currentUserId: string | null,
) {
  return mutationOptions({
    mutationFn: platformSetUserPassword,
    onSuccess: (receipt: PlatformIdentityReceipt) => {
      void refreshRoster(queryClient);
      clearOldIdentityState(queryClient, receipt.userId, currentUserId);
    },
  });
}

/** Ending one session can be ending the very session this browser holds: same teardown. */
export function revokePlatformUserSessionMutationOptions(
  queryClient: QueryClient,
  currentUserId: string | null,
) {
  return mutationOptions({
    mutationFn: platformRevokeUserSession,
    onSuccess: (
      receipt: PlatformIdentityReceipt,
      variables: { userId: string },
    ) => {
      void refreshSessions(queryClient, variables.userId);
      clearOldIdentityState(queryClient, receipt.userId, currentUserId);
    },
  });
}

/** The whole-session sweep of the person at this keyboard ends their app the same way. */
export function revokePlatformUserSessionsMutationOptions(
  queryClient: QueryClient,
  currentUserId: string | null,
) {
  return mutationOptions({
    mutationFn: platformRevokeUserSessions,
    onSuccess: (
      receipt: PlatformIdentityReceipt,
      variables: { userId: string },
    ) => {
      void refreshSessions(queryClient, variables.userId);
      void refreshRoster(queryClient);
      clearOldIdentityState(queryClient, receipt.userId, currentUserId);
    },
  });
}
