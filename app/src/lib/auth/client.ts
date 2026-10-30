import { createAuthClient } from "better-auth/react";
import { openBotClientPlugins } from "./auth-plugin";
import type { AuthProviderId } from "./queries";

/**
 * The app's one Better Auth client. Its plugin composition — the preserved SSO client and
 * the fixed organization client — lives in auth-plugin.ts (T01.09, #521).
 */
export const authClient = createAuthClient({
  plugins: openBotClientPlugins(),
  // A document with no origin — `about:blank` in a test DOM, no window at all in the
  // collector — has nothing for better-auth to resolve against, and it throws that at
  // CONSTRUCTION time. A real page keeps its own origin; anything else gets a base URL
  // that only matters if a call is actually made.
  ...(typeof window === "undefined" ||
  window.location?.origin == null ||
  window.location.origin === "null"
    ? { baseURL: "http://localhost:3010" }
    : {}),
});

/** The pinned server enables these native endpoints, while their shapes are not part of the plugins. */
export type RecoveryAuthClient = {
  requestPasswordReset(input: {
    email: string;
    redirectTo: string;
  }): Promise<{ data: unknown; error: { code?: string } | null }>;
  resetPassword(input: {
    newPassword: string;
    token: string;
  }): Promise<{ data: unknown; error: { code?: string } | null }>;
  sendVerificationEmail(input: {
    email: string;
    callbackURL: string;
  }): Promise<{ data: unknown; error: { code?: string } | null }>;
};

export const recoveryAuthClient = authClient as unknown as RecoveryAuthClient;

/*
 * The platform account-admin surface, T05.16 (P13; interfaces §3.2's admin rows, wired by
 * T05.08). Same deal as the recovery surface above: the pinned server serves these native
 * endpoints while their shapes are not part of the composed plugins, so the one client is
 * cast to a narrow typed view rather than the adminClient plugin being added, which would
 * bring impersonation and user CRUD the first phase refuses. The ingress translates every
 * write into an identity command and answers with the receipt envelope.
 */

/** The receipt every platform account write answers with (interfaces §2.1). */
export type PlatformIdentityReceipt = Readonly<{
  commandId: string;
  replayed: boolean;
  userId: string;
  principalId: string;
  identityGeneration: number;
}>;

/** One of a person's open sessions, as the platform read answers it. */
export type PlatformUserSession = Readonly<{
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
}>;

type AdminCall<T> = {
  data: T;
  error: { message?: string; code?: string } | null;
};

type PlatformAdminAuthClient = {
  createUser(input: {
    email: string;
    name?: string;
    password?: string;
  }): Promise<AdminCall<PlatformIdentityReceipt>>;
  updateUser(input: {
    userId: string;
    name?: string;
    image?: string;
  }): Promise<AdminCall<PlatformIdentityReceipt>>;
  setUserPassword(input: {
    userId: string;
    newPassword: string;
    reason: string;
  }): Promise<AdminCall<PlatformIdentityReceipt>>;
  listUserSessions(input: {
    userId: string;
  }): Promise<AdminCall<{ sessions: PlatformUserSession[] }>>;
  revokeUserSession(input: {
    userId: string;
    sessionId: string;
    reason: string;
  }): Promise<AdminCall<PlatformIdentityReceipt>>;
  revokeUserSessions(input: {
    userId: string;
    reason: string;
  }): Promise<AdminCall<PlatformIdentityReceipt>>;
};

const platformAdmin = () =>
  (authClient as unknown as { admin: PlatformAdminAuthClient }).admin;

/** What each provider is called on the button, since none of them are called by their id. */
const PROVIDER_NAMES: Record<AuthProviderId, string> = {
  google: "Google",
  microsoft: "Microsoft",
  okta: "Okta",
  casdoor: "Casdoor",
};

export function providerName(provider: AuthProviderId): string {
  return PROVIDER_NAMES[provider];
}

/** What a sign-in attempt came back with, which is either nothing or a reason. */
type SocialResult = { error?: { message?: string } | null };

/**
 * Start sign-in with one provider.
 *
 * One call for all three, including Okta. Okta is served by the generic OAuth plugin rather than as
 * a named provider, but the plugin registers under a provider id like any other, so the browser does
 * not need to know which kind it is asking for. Keeping that distinction on the server is the point:
 * a deployment can gain a provider without the app being rebuilt.
 *
 * `start` is injectable because Better Auth's client is a proxy, so a test cannot replace the method
 * on it. Named so it cannot shadow anything it defaults to.
 */
export async function signInWith(
  provider: AuthProviderId,
  start: (input: {
    provider: string;
    callbackURL: string;
  }) => Promise<SocialResult> = (input) =>
    authClient.signIn.social(input as never) as Promise<SocialResult>,
) {
  const result = await start({
    provider,
    callbackURL: window.location.origin,
  });

  if (result.error) {
    // Naming the provider matters more with three buttons than it did with one: "Could not start
    // sign-in" leaves somebody looking at three of them with no idea which one refused.
    throw new Error(
      result.error.message ||
        `Could not start ${providerName(provider)} sign-in.`,
    );
  }
}

/**
 * Start sign-in through whichever identity provider covers this address.
 *
 * The email is not a credential here and no password is asked for: only the part after the @ is
 * used, to decide which registered provider to hand somebody to. A company with two IdPs mid-merger
 * has two domains, and this is how somebody reaches theirs without being asked which one they are.
 *
 * Injectable for the same reason as `signInWith`: the Better Auth client is a proxy.
 */
export async function signInWithEmailDomain(
  email: string,
  start: (input: {
    email: string;
    callbackURL: string;
  }) => Promise<SocialResult> = (input) =>
    (
      authClient as unknown as {
        signIn: { sso: (i: unknown) => Promise<SocialResult> };
      }
    ).signIn.sso(input),
) {
  const result = await start({ email, callbackURL: window.location.origin });

  if (result.error) {
    throw new Error(
      result.error.message ||
        "No identity provider is registered for that address.",
    );
  }
}

/**
 * Sign in with the deployment's own password accounts.
 *
 * The other two ways in hand the browser to an identity provider; this one answers locally, so on
 * success the caller takes the same full-page load into the app that a provider callback ends with.
 *
 * Injectable for the same reason as `signInWith`: the Better Auth client is a proxy.
 */
export async function signInWithEmailPassword(
  email: string,
  password: string,
  start: (input: {
    email: string;
    password: string;
  }) => Promise<SocialResult> = (input) =>
    authClient.signIn.email(input as never) as Promise<SocialResult>,
) {
  const result = await start({ email, password });

  if (result.error) {
    throw new Error(
      result.error.message || "Could not sign in with email and password.",
    );
  }
}

/** What a refused platform write says when the server's own words did not survive the trip. */
const PLATFORM_FALLBACK = "Could not change that account.";

function refusalOf(error: { message?: string; code?: string } | null): Error {
  return new Error(error?.message || error?.code || PLATFORM_FALLBACK);
}

/**
 * Create somebody's account. The address is the identity; a first password is optional, because
 * a person who signs in with a provider never needs one. Everything else (role, status, email
 * verification) is refused by the server, so it is not sent.
 */
export function platformCreateUser(input: {
  email: string;
  name?: string;
  password?: string;
}): Promise<PlatformIdentityReceipt> {
  return platformAdmin()
    .createUser(input)
    .then((result) =>
      result.error ? Promise.reject(refusalOf(result.error)) : result.data,
    );
}

/**
 * Edit a profile: the name and the picture, and nothing else. The address is the identity, so it
 * is changed by verifying a new one, never by an administrator typing over it.
 */
export function platformUpdateUserProfile(input: {
  userId: string;
  name?: string;
  image?: string;
}): Promise<PlatformIdentityReceipt> {
  return platformAdmin()
    .updateUser(input)
    .then((result) =>
      result.error ? Promise.reject(refusalOf(result.error)) : result.data,
    );
}

/**
 * Set somebody's password as the platform admin: no recovery token, and every session the
 * person had is signed out by the same write. The reason is required; the audit carries it.
 */
export function platformSetUserPassword(input: {
  userId: string;
  newPassword: string;
  reason: string;
}): Promise<PlatformIdentityReceipt> {
  return platformAdmin()
    .setUserPassword(input)
    .then((result) =>
      result.error ? Promise.reject(refusalOf(result.error)) : result.data,
    );
}

/** The sessions a person has open, newest facts the platform read answers. */
export function platformListUserSessions(input: {
  userId: string;
}): Promise<PlatformUserSession[]> {
  return platformAdmin()
    .listUserSessions(input)
    .then((result) => {
      if (result.error) throw refusalOf(result.error);
      return Array.isArray(result.data?.sessions) ? result.data.sessions : [];
    });
}

/** End one session of a person's, by the id the platform read listed. */
export function platformRevokeUserSession(input: {
  userId: string;
  sessionId: string;
  reason: string;
}): Promise<PlatformIdentityReceipt> {
  return platformAdmin()
    .revokeUserSession(input)
    .then((result) =>
      result.error ? Promise.reject(refusalOf(result.error)) : result.data,
    );
}

/** End every session a person has open. Their identity itself is untouched. */
export function platformRevokeUserSessions(input: {
  userId: string;
  reason: string;
}): Promise<PlatformIdentityReceipt> {
  return platformAdmin()
    .revokeUserSessions(input)
    .then((result) =>
      result.error ? Promise.reject(refusalOf(result.error)) : result.data,
    );
}
