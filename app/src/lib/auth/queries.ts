import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/**
 * Where this person is in first-run onboarding.
 *
 * On the user rather than its own query, so the `_authed` gate learns it from the request it
 * already makes. A null `completedAt` is what sends the app to /onboarding.
 */
export type OnboardingStatus = {
  step: number;
  completedAt: string | null;
};

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: "admin" | "user";
  /** Null means this deployment does not track onboarding, which reads as nothing to finish. */
  onboarding: OnboardingStatus | null;
  /**
   * True when this deployment has no sign-in at all: every visitor is the one administrator and
   * there is no session to end, so UI that presumes one (a Log-out button) stays hidden. Always
   * present after {@link currentUser} parses the response, optional in the type so tests and
   * callers may build a bare user.
   */
  singleUser?: boolean;
};

/** Whether the gate holds: there is an onboarding to do and this person has not finished it. */
export function needsOnboarding(user: AuthenticatedUser): boolean {
  return user.onboarding !== null && user.onboarding.completedAt === null;
}

export const authKeys = {
  all: ["auth"] as const,
  currentUser: () => [...authKeys.all, "current-user"] as const,
  providers: () => [...authKeys.all, "providers"] as const,
};

/** An identity provider this deployment can sign somebody in with. */
export type AuthProviderId = "google" | "microsoft" | "okta" | "casdoor";

/** What the sign-in screen may offer, answered by the process that knows. */
export type SignInOptions = {
  providers: AuthProviderId[];
  /**
   * Whether any enterprise identity provider is registered.
   *
   * A boolean, not a list: naming them would tell anybody who loads the sign-in page which companies
   * use this deployment, before they have signed in.
   */
  sso: boolean;
  /** An administrator requires SSO; social sign-in stays only as the administrators' break-glass. */
  ssoRequired: boolean;
  emailPassword: boolean;
};

async function signInOptions(): Promise<SignInOptions> {
  // The whole body, so both fields arrive together. Reading a field off the Response `client`
  // returns without a key quietly yields undefined: the screen would say no provider is configured
  // while the server was saying it has one.
  const body = (await (
    await client("/api/capabilities", { fallbackKey: "auth.loadSignIn" })
  ).json()) as {
    authProviders?: AuthProviderId[];
    ssoConfigured?: boolean;
    ssoRequired?: boolean;
    emailPassword?: boolean;
  };

  return {
    providers: body.authProviders ?? [],
    sso: body.ssoConfigured === true,
    ssoRequired: body.ssoRequired === true,
    emailPassword: body.emailPassword === true,
  };
}

/**
 * Which providers the sign-in screen may offer.
 *
 * From the server rather than from the build. The image is built once with no deployment
 * environment, so a list compiled into the bundle can only ever describe the build machine.
 */
export function authProvidersQueryOptions() {
  return queryOptions({
    queryKey: authKeys.providers(),
    queryFn: signInOptions,
    // Configuration, not data. It cannot change without the process restarting.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

async function currentUser(): Promise<AuthenticatedUser | null> {
  /*
   * `tryClient` rather than `client`: not being signed in is an answer here, not a failure, and it
   * arrives as a 401 that has to be read before anything decides the request went wrong.
   */
  const response = await tryClient("/api/me");
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Could not load the current user (${response.status})`);
  }

  const body = (await response.json()) as {
    user: AuthenticatedUser;
    singleUser?: boolean;
  };
  return { ...body.user, singleUser: body.singleUser === true };
}

export function currentUserQueryOptions() {
  return queryOptions({
    queryKey: authKeys.currentUser(),
    queryFn: currentUser,
    staleTime: 60_000,
  });
}
