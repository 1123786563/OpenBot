import {
  clearDesktopConnectionFailure,
  recordDesktopConnectionFailure,
} from "../desktop-connection-failure";
import type { AuthenticatedActor, AuthService } from "./guards";

const COOKIE = "openbot.organization-session";
const HANDOFF_PATH = "/api/auth/organization/session";
const COOKIE_AGE = 7 * 24 * 60 * 60;
class AuthorityUnavailable extends Error {}

/** Explicit customer OpenBot authority, never inferred from an Intelligence endpoint. */
export function organizationAuthority(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Organization sign-in requires an HTTPS OpenBot origin (HTTP is allowed only on loopback).",
    );
  }
  return url.origin;
}

function actor(value: unknown): AuthenticatedActor | null {
  if (!value || typeof value !== "object" || !("user" in value)) return null;
  const user = value.user;
  if (
    !user ||
    typeof user !== "object" ||
    !("id" in user) ||
    !("email" in user) ||
    !("role" in user)
  )
    return null;
  if (
    typeof user.id !== "string" ||
    !user.id ||
    user.id === "dev-local-user" ||
    typeof user.email !== "string" ||
    !user.email ||
    (user.role !== "admin" && user.role !== "user")
  )
    return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    name: "name" in user && typeof user.name === "string" ? user.name : null,
    image:
      "image" in user && typeof user.image === "string" ? user.image : null,
  };
}

/** Only the signed session cookie is forwarded; local app cookies never leave this server. */
function sessionCookie(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 8192 &&
    /^(?:__Secure-)?better-auth\.session_token=[^;\s\r\n]+$/.test(value)
  );
}

/*
 * The identity a handoff carries, as this server knows it: the authority's
 * word about the person (`AuthenticatedActor`) plus the registered authority
 * origin that vouched for it. The origin is this server's own setting — it
 * is never read from a remote body — and it is what the subject binds to:
 * the same subject under a different authority is a different remote
 * identity, never the same local account by email (T05.09, design §9).
 */
export type RemoteOrganizationIdentity = AuthenticatedActor & {
  readonly authority: string;
};

export function createOrganizationAuth(options: {
  authorityUrl: string;
  materializeUser: (
    user: RemoteOrganizationIdentity,
  ) => Promise<AuthenticatedActor>;
}): AuthService {
  const authority = organizationAuthority(options.authorityUrl);
  /*
   * A pending handoff records the subject the authority named when the
   * ticket was minted, under the sign-in epoch the ticket belongs to. Every
   * completed handoff opens a new epoch, so a callback minted before the
   * current sign-in — an old tab, a queued redirect, an account already
   * switched away from — is dead on arrival and can neither replace the
   * session that follows it nor pick among pending ones (T05.09).
   */
  const tickets = new Map<
    string,
    { cookie: string; subject: string; epoch: number; expires: number }
  >();
  let handoffEpoch = 0;

  async function verify(cookie: string): Promise<AuthenticatedActor | null> {
    if (!sessionCookie(cookie)) return null;
    let response: Response;
    try {
      response = await fetch(`${authority}/api/me`, {
        headers: { cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AuthorityUnavailable(
        "The organization could not be reached. Try again.",
      );
    }
    if (response.status >= 500)
      throw new AuthorityUnavailable(
        "The organization is temporarily unavailable. Try again.",
      );
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        recordDesktopConnectionFailure({
          connection: "organization",
          code: "organization_authentication_failed",
        });
      return null;
    }
    const user = actor(await response.json().catch(() => null));
    if (!user) return null;
    // Materializing is a database step like any other here: a failure it throws is an
    // authority outage to the caller, not a raw error to escape as a bare 500.
    let localUser: Awaited<ReturnType<typeof options.materializeUser>>;
    try {
      localUser = await options.materializeUser({ ...user, authority });
    } catch (error) {
      throw new AuthorityUnavailable(
        "The account could not be loaded just now. Try again.",
        { cause: error instanceof Error ? error : undefined },
      );
    }
    clearDesktopConnectionFailure("organization");
    // The registered origin is this server's own fact, consumed by the
    // binding above; the session payload keeps its established shape.
    return {
      id: localUser.id,
      email: localUser.email,
      name: localUser.name,
      image: localUser.image,
      role: localUser.role,
    };
  }

  function cookieFrom(headers: Headers): string | null {
    const encoded = headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!encoded || encoded.length > 12000) return null;
    try {
      // Binding the cookie to the authority prevents a changed organization setting reusing it.
      const record: unknown = JSON.parse(
        Buffer.from(encoded, "base64url").toString(),
      );
      if (
        !record ||
        typeof record !== "object" ||
        !("authority" in record) ||
        record.authority !== authority ||
        !("cookie" in record) ||
        !sessionCookie(record.cookie)
      )
        return null;
      return record.cookie;
    } catch {
      return null;
    }
  }

  const getSession: AuthService["api"]["getSession"] = async ({ headers }) => {
    const cookie = cookieFrom(headers);
    if (!cookie)
      recordDesktopConnectionFailure({
        connection: "organization",
        code: "organization_authentication_failed",
      });
    const user = cookie ? await verify(cookie) : null;
    return user ? { user } : null;
  };

  return {
    api: { getSession },
    async handler(request) {
      try {
        const url = new URL(request.url);
        const json = (body: unknown, status = 200) =>
          Response.json(body, {
            status,
            headers: { "cache-control": "no-store" },
          });
        const unavailable = () =>
          json(
            {
              error: "Sign in to your organization again.",
              connection: "organization",
            },
            401,
          );
        const allowedOrigin = () => {
          const origin = request.headers.get("origin");
          if (origin === url.origin) return true;
          try {
            const source = new URL(origin ?? "");
            const loopback = (value: URL) =>
              value.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname);
            return (
              source.origin === origin && loopback(source) && loopback(url)
            );
          } catch {
            return false;
          }
        };
        // The request already came from the authority itself: routing it back here would hand a
        // page served on the authority's origin this deployment's session cookies (host/port
        // confusion between the two local faces), so it is refused outright.
        if (url.origin === authority) return unavailable();
        if (url.pathname === HANDOFF_PATH && request.method === "POST") {
          // Native supplies this exact Origin; a foreign browser cannot deliver a login via CSRF.
          if (!allowedOrigin()) return json({ error: "Origin refused." }, 403);
          const body: unknown = await request.json().catch(() => null);
          const handoffCookie =
            body &&
            typeof body === "object" &&
            "cookie" in body &&
            sessionCookie(body.cookie)
              ? body.cookie
              : null;
          // The subject is pinned at mint time: redemption re-verifies the
          // cookie and refuses it if the authority now names someone else
          // (T05.09 — no silent account switch mid-handoff).
          if (!handoffCookie) return unavailable();
          const verified = await verify(handoffCookie);
          if (!verified) return unavailable();
          const now = Date.now();
          for (const [key, ticket] of tickets)
            if (ticket.expires <= now) tickets.delete(key);
          if (tickets.size >= 32)
            return json({ error: "Too many pending sign-ins." }, 429);
          const ticket = crypto.randomUUID();
          tickets.set(ticket, {
            cookie: handoffCookie,
            subject: verified.id,
            epoch: handoffEpoch,
            expires: now + 60_000,
          });
          return json({ ticket });
        }
        if (url.pathname === HANDOFF_PATH && request.method === "GET") {
          const key = url.searchParams.get("ticket") ?? "";
          const ticket = tickets.get(key);
          if (
            !ticket ||
            ticket.expires <= Date.now() ||
            ticket.epoch !== handoffEpoch
          ) {
            tickets.delete(key);
            return unavailable();
          }
          // Consumed only once the cookie has proven itself: a verify that trips on a transient
          // authority outage must not burn a ticket the person just earned.
          const verified = await verify(ticket.cookie);
          if (!verified || verified.id !== ticket.subject) return unavailable();
          tickets.delete(key);
          handoffEpoch += 1;
          const value = Buffer.from(
            JSON.stringify({ authority, cookie: ticket.cookie }),
          ).toString("base64url");
          return new Response(null, {
            status: 303,
            headers: {
              location: "/",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "set-cookie": `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_AGE}${url.protocol === "https:" ? "; Secure" : ""}`,
            },
          });
        }
        if (url.pathname === "/api/auth/get-session")
          return json(
            await getSession({
              headers: request.headers,
              query: { disableCookieCache: true },
            }),
          );
        if (
          url.pathname === "/api/auth/sign-out" &&
          request.method === "POST"
        ) {
          if (!allowedOrigin()) return json({ error: "Origin refused." }, 403);
          const cookie = cookieFrom(request.headers);
          if (cookie) {
            try {
              const response = await fetch(`${authority}/api/auth/sign-out`, {
                method: "POST",
                headers: {
                  cookie,
                  origin: authority,
                  "content-type": "application/json",
                },
                body: "{}",
                redirect: "manual",
                signal: AbortSignal.timeout(10_000),
              });
              if (!response.ok)
                throw new AuthorityUnavailable("Sign-out was not accepted.");
            } catch {
              return json(
                { error: "The organization could not be reached to sign out." },
                503,
              );
            }
          }
          return Response.json(
            { success: true },
            {
              headers: {
                "cache-control": "no-store",
                "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
              },
            },
          );
        }
        return json(
          { error: "Use the OpenBot organization sign-in screen." },
          404,
        );
      } catch (error) {
        if (!(error instanceof AuthorityUnavailable)) throw error;
        return Response.json(
          { error: error.message },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
    },
  };
}
