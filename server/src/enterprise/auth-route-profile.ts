/**
 * The compiled-time auth route profile, per plan 02 §7 T3-B step 4.
 *
 * The enterprise entry forwards /api/auth requests by EXACT `METHOD pathname` against a set an
 * operator can only SUBSET (enterprise/config.ts `selectAuthRoutes`); this module is that set, and
 * it is compiled into the artifact on purpose. Nothing in the environment can extend it: an
 * operator who invents a route gets INVALID_AUTH_ROUTE_SELECTION, not a new endpoint.
 *
 * WHAT IS IN, and how it was chosen. Every entry below was read out of the locked SDK
 * (better-auth@1.7.1) and exercised by the deployment's own sign-in flow — the web client starts
 * sign-in with `signIn.social` (app/src/lib/auth/client.ts) and the browser lands back on the
 * provider callback:
 *
 *   POST /api/auth/sign-in/social   dist/api/routes/sign-in.mjs   "/sign-in/social", method POST
 *   GET+POST /api/auth/callback/:id dist/api/routes/callback.mjs  "/callback/:id", GET and POST
 *                                   (POST normalizes itself to a redirect onto GET)
 *   GET+POST /api/auth/get-session  dist/api/routes/session.mjs  "/get-session", GET and POST
 *   POST /api/auth/sign-out         dist/api/routes/sign-out.mjs "/sign-out", POST
 *
 * The provider is Google because that is the one configuration verified by real login flows so
 * far. Another provider joins this file only with its own verified login/callback pair — never by
 * loosening the matcher to a prefix or a wildcard.
 *
 * WHAT IS OUT, on purpose, and stays out: SCIM (/api/auth/scim/v2/*), SSO registration and
 * management (/api/auth/sso/*), the desktop account-connection endpoints
 * (/api/auth/electron/token, /init-oauth-proxy, /transfer-user — present in
 * @better-auth/electron/dist/index.mjs), organization management, sign-up, password and every
 * account-management route. They remain mounted inside the legacy deployment; on the shared
 * enterprise entry they answer 404 (createEnterpriseApp's allowlist) even though the plugins that
 * own them initialize, because initialization registers routes and touches no table.
 */

/** Why a route exists, so an operator choosing among them can see what each one is for. */
export type AuthRouteCategory = "sign-in" | "callback" | "session" | "sign-out";

export type ApprovedAuthRoute = {
  method: "GET" | "POST";
  pathname: string;
  category: AuthRouteCategory;
};

const GOOGLE_LOGIN_ROUTES: readonly ApprovedAuthRoute[] = [
  {
    method: "POST",
    pathname: "/api/auth/sign-in/social",
    category: "sign-in",
  },
  {
    method: "GET",
    pathname: "/api/auth/callback/google",
    category: "callback",
  },
  {
    method: "POST",
    pathname: "/api/auth/callback/google",
    category: "callback",
  },
  {
    method: "GET",
    pathname: "/api/auth/get-session",
    category: "session",
  },
  {
    method: "POST",
    pathname: "/api/auth/get-session",
    category: "session",
  },
  {
    method: "POST",
    pathname: "/api/auth/sign-out",
    category: "sign-out",
  },
];

function keyOf(route: ApprovedAuthRoute): string {
  return `${route.method} ${route.pathname}`;
}

/** The whole allowlist an operator may choose from; nothing outside it can ever be forwarded. */
export const APPROVED_AUTH_ROUTES: ReadonlySet<string> = new Set(
  GOOGLE_LOGIN_ROUTES.map(keyOf),
);

/*
 * What every approved configuration MUST allow. With one verified provider bundle this is the
 * whole set — an operator subsetting the profile down cannot drop half a login flow. When a second
 * provider's real login pair is verified and added above, this constant stays the union of routes
 * every configuration needs (session, sign-out, sign-in start), while provider callbacks become
 * per-configuration requirements enforced where the configuration is parsed.
 */
export const REQUIRED_AUTH_ROUTES: ReadonlySet<string> = new Set(
  GOOGLE_LOGIN_ROUTES.map(keyOf),
);

/**
 * Normalize one `METHOD pathname` entry, or reject it with null.
 *
 * The enterprise app matches requests by exact `method + " " + pathname`, so a configuration that
 * snuck an encoded separator (%2F), a duplicate slash, a dot segment, a trailing slash, a query or
 * fragment, or a lowercase method past selection would simply never match — a silent
 * misconfiguration that reads as "login is broken". This function refuses all of those at
 * configuration time, the cheap moment, and is also applied to this module's own entries at import
 * so the compiled set cannot drift out of canonical form.
 */
export function canonicalAuthRoute(entry: string): string | null {
  const split = entry.split(" ");
  if (split.length !== 2) return null;
  const [method, pathname] = split;

  if (!/^[A-Z]+$/.test(method)) return null;
  if (!pathname.startsWith("/")) return null;
  if (pathname.includes("%") || pathname.includes("\\")) return null;
  if (pathname.includes("//")) return null;
  if (pathname.includes("?") || pathname.includes("#")) return null;
  if (pathname.endsWith("/")) return null;
  if (
    pathname.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }

  return `${method} ${pathname}`;
}

/* The compiled set itself is held to the same canonical form it enforces on selections. */
for (const entry of APPROVED_AUTH_ROUTES) {
  if (canonicalAuthRoute(entry) !== entry) {
    throw new Error(`Non-canonical compiled auth route: ${entry}`);
  }
}
