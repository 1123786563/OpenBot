import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createOrganizationAuth } from "../../src/auth/organization";
import { organizationUserStore } from "../../src/auth/organization-store";
import { createDatabase } from "../../src/db/client";
import { accounts, userRoles, users } from "../../src/db/schema";

/*
 * T05.09 (#565, original task P12) — a remote authority's identity is its
 * (issuer, subject), never its email, and a cross-deployment handoff cannot
 * replace the session a later sign-in established (design §9, spec
 * `provider_id / issuer / subject`: "subject 必须映射当前 user，不能按相同
 * 邮箱自动并号").
 *
 * The named behaviors, as facts:
 *
 * - `matching_email_with_different_issuer_does_not_merge`: two organization
 *   authorities vouching for the SAME email with different subjects leave
 *   exactly one local user, bound to the first issuer's subject
 *   (expect(principalA).not.toBe(principalB)); the second authority's word —
 *   including its admin role — is refused loudly and materializes nothing.
 * - `late_old_authority_callback_cannot_replace_session`: after account A's
 *   pending handoff and account B's completed one, the still-fresh A ticket
 *   is dead on arrival (401, no set-cookie) and the current session is
 *   exactly the one B established (expect(currentSession).toEqual(newSession)).
 *
 * Supporting: one (issuer, subject) keeps one local identity and follows the
 * authority's current profile and role; a same-email different-subject
 * arrival under the same issuer is refused; a pre-existing local account is
 * adopted once (the controlled historical mapping) and then immune to any
 * other remote identity — including concurrently: two remote identities
 * racing to claim the same unclaimed local account leave exactly one
 * mapping and the loser is refused (r1 F1); a handoff's subject is pinned
 * at mint and refuses redemption when the authority now names someone else;
 * a cookie bound to a foreign authority origin is refused before any fetch.
 *
 * The five BA_TEST_* URLs are all required and must name one isolated
 * openbot_enterprise_* database. No DSN is ever printed.
 */

const DATABASE_VARIABLE = "BA_TEST_DATABASE_URL";
const BA_URL_VARIABLES = [
  DATABASE_VARIABLE,
  "BA_TEST_DIRECTORY_DATABASE_URL",
  "BA_TEST_DATA_DATABASE_URL",
  "BA_TEST_OPERATOR_DATABASE_URL",
  "BA_TEST_AUTH_WRITER_DATABASE_URL",
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const PREFIX = "t0509";
const EMAIL_DOMAIN = "@t0509.example.test";
const ORGANIZATION_PROVIDER = "organization";
const LOCAL_ORIGIN = "http://127.0.0.1:3010";

function shapeOf(variable: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a loopback PostgreSQL URL.`);
  }
  let database = "";
  try {
    database = decodeURIComponent(
      url.pathname.replace(/^\//, "").replace(/\/+$/, ""),
    );
  } catch {
    throw new Error(`${variable} carries invalid percent-encoding.`);
  }
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !/^openbot_enterprise_/.test(database)
  ) {
    throw new Error(
      `${variable} must name a loopback openbot_enterprise_* database.`,
    );
  }
  const host =
    url.hostname === "localhost" || url.hostname === "[::1]"
      ? "127.0.0.1"
      : url.hostname;
  return `${host}:${url.port || "5432"}/${database}`;
}

function readBaUrls(): string {
  let reference: string | undefined;
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: the remote-identity-binding suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    const shape = shapeOf(variable, raw);
    reference ??= shape;
    if (shape !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance and database as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return process.env[DATABASE_VARIABLE]!.trim();
}

/** Rows are keyed by the exact inner cookie the callback presents. */
interface RemoteUser {
  id: string;
  email: string;
  role: "admin" | "user";
  name?: string | null;
}

interface Authority {
  origin: string;
  stop(): void;
}

function authorityServer(sessions: Map<string, RemoteUser>): Authority {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const user = sessions.get(request.headers.get("cookie") ?? "");
      return user
        ? Response.json({ user })
        : new Response(null, { status: 401 });
    },
  });
  return { origin: server.url.origin, stop: () => server.stop(true) };
}

const innerCookie = (name: string) =>
  `better-auth.session_token=${PREFIX}-${name}`;

function organizationCookie(authority: string, inner: string): string {
  return (
    "openbot.organization-session=" +
    Buffer.from(JSON.stringify({ authority, cookie: inner })).toString(
      "base64url",
    )
  );
}

async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  // users cascades into accounts and user_roles; the suite writes nothing else.
  await sql`DELETE FROM users WHERE email LIKE ${`%${EMAIL_DOMAIN}`}`;
  // This suite replays no migration and creates none itself, but other
  // suites' chains leave the auth_* function family behind; sweeping them
  // keeps the shared island clean for the T02.06.01 leak check.
  await sql.unsafe(`
    DO $$
    DECLARE target text;
    BEGIN
      FOR target IN SELECT proname::text FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND position('auth_' in proname) = 1
      LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS public.%I CASCADE', target);
      END LOOP;
    END $$;
  `);
}

let sql: postgres.Sql | undefined;

describe("T05.09 remote identity binding (#565)", () => {
  let database: ReturnType<typeof createDatabase> | undefined;

  beforeAll(async () => {
    const setupUrl = readBaUrls();
    sql = postgres(setupUrl, {
      max: 4,
      idle_timeout: 5,
      onnotice: () => {},
    });
    await cleanupFixture(sql);
    database = createDatabase(setupUrl, { max: 4 });
  });

  afterAll(async () => {
    if (sql) await cleanupFixture(sql);
    await database?.$client.close();
    await sql?.end();
  });

  const sessionOf = async (
    origin: string,
    inner: string,
  ): Promise<
    Awaited<
      ReturnType<ReturnType<typeof createOrganizationAuth>["api"]["getSession"]>
    >
  > => {
    if (!database) throw new Error("harness not started");
    const auth = createOrganizationAuth({
      authorityUrl: origin,
      materializeUser: organizationUserStore(database),
    });
    return auth.api.getSession({
      headers: new Headers({ cookie: organizationCookie(origin, inner) }),
    });
  };

  const rolesOf = async (userId: string): Promise<string[]> => {
    if (!database) throw new Error("harness not started");
    const rows = await database
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    return rows.map((row) => row.role);
  };

  const userRowsForEmail = async (email: string) => {
    if (!database) throw new Error("harness not started");
    return database
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email));
  };

  const bindingsFor = async (accountId: string) => {
    if (!database) throw new Error("harness not started");
    return database
      .select({
        accountId: accounts.accountId,
        providerId: accounts.providerId,
        issuer: accounts.issuer,
        userId: accounts.userId,
      })
      .from(accounts)
      .where(eq(accounts.accountId, accountId));
  };

  test("matching_email_with_different_issuer_does_not_merge", async () => {
    const email = `shared${EMAIL_DOMAIN}`;
    const sessionsA = new Map<string, RemoteUser>([
      [
        innerCookie("issuer-a"),
        { id: `${PREFIX}-subject-a`, email, role: "user" },
      ],
    ]);
    const sessionsB = new Map<string, RemoteUser>([
      [
        innerCookie("issuer-b"),
        { id: `${PREFIX}-subject-b`, email, role: "admin" },
      ],
    ]);
    const a = authorityServer(sessionsA);
    const b = authorityServer(sessionsB);
    try {
      const sessionA = await sessionOf(a.origin, innerCookie("issuer-a"));
      const principalA = sessionA?.user.id;
      expect(principalA).toBeTruthy();

      let principalB: string | null = null;
      try {
        principalB =
          (await sessionOf(b.origin, innerCookie("issuer-b")))?.user.id ?? null;
      } catch {
        principalB = null;
      }
      // The named fact: the second issuer's subject is never merged into the
      // first principal — it is refused (null), not adopted.
      expect(principalB).not.toBe(principalA);
      expect(principalB).toBeNull();

      const locals = await userRowsForEmail(email);
      expect(locals).toHaveLength(1);
      expect(locals[0]?.id).toBe(principalA);
      expect(await rolesOf(principalA!)).toEqual(["user"]);

      const bindings = await bindingsFor(`${PREFIX}-subject-a`);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        providerId: ORGANIZATION_PROVIDER,
        issuer: a.origin,
        userId: principalA,
      });
    } finally {
      a.stop();
      b.stop();
    }
  });

  test("late_old_authority_callback_cannot_replace_session", async () => {
    const sessions = new Map<string, RemoteUser>([
      [
        innerCookie("old-account"),
        {
          id: `${PREFIX}-old-account`,
          email: `old${EMAIL_DOMAIN}`,
          role: "user",
        },
      ],
      [
        innerCookie("new-account"),
        {
          id: `${PREFIX}-new-account`,
          email: `new${EMAIL_DOMAIN}`,
          role: "user",
        },
      ],
    ]);
    const authority = authorityServer(sessions);
    try {
      const auth = createOrganizationAuth({
        authorityUrl: authority.origin,
        materializeUser: async (user) => user,
      });
      const handoff = (inner: string) =>
        auth.handler(
          new Request(`${LOCAL_ORIGIN}/api/auth/organization/session`, {
            method: "POST",
            headers: {
              origin: LOCAL_ORIGIN,
              "content-type": "application/json",
            },
            body: JSON.stringify({ cookie: inner }),
          }),
        );
      const redeem = (ticket: string) =>
        auth.handler(
          new Request(
            `${LOCAL_ORIGIN}/api/auth/organization/session?ticket=${ticket}`,
          ),
        );

      const oldStart = await handoff(innerCookie("old-account"));
      expect(oldStart.status).toBe(200);
      const oldTicket = (await oldStart.json()).ticket as string;
      const newStart = await handoff(innerCookie("new-account"));
      expect(newStart.status).toBe(200);
      const newTicket = (await newStart.json()).ticket as string;

      const newRedeem = await redeem(newTicket);
      expect(newRedeem.status).toBe(303);
      const newSessionCookie =
        newRedeem.headers.get("set-cookie")?.split(";")[0] ?? "";
      const newSession = await auth.api.getSession({
        headers: new Headers({ cookie: newSessionCookie }),
        query: { disableCookieCache: true },
      });
      expect(newSession?.user.id).toBe(`${PREFIX}-new-account`);

      // The old account's callback is still unspent and unexpired, but it
      // predates the sign-in that just completed: dead on arrival.
      const late = await redeem(oldTicket);
      expect(late.status).toBe(401);
      expect(late.headers.get("set-cookie")).toBeNull();

      const currentSession = await auth.api.getSession({
        headers: new Headers({ cookie: newSessionCookie }),
        query: { disableCookieCache: true },
      });
      expect(currentSession).toEqual(newSession);
    } finally {
      authority.stop();
    }
  });

  test("same issuer and subject keep one bound identity with the authority's current word", async () => {
    const email = `stable${EMAIL_DOMAIN}`;
    const inner = innerCookie("stable");
    const sessions = new Map<string, RemoteUser>([
      [
        inner,
        {
          id: `${PREFIX}-subject-stable`,
          email,
          role: "user",
          name: "Old Name",
        },
      ],
    ]);
    const authority = authorityServer(sessions);
    try {
      const first = await sessionOf(authority.origin, inner);
      const id = first?.user.id;
      expect(id).toBeTruthy();
      expect(first?.user.name).toBe("Old Name");

      sessions.set(inner, {
        id: `${PREFIX}-subject-stable`,
        email,
        role: "admin",
        name: "New Name",
      });
      const second = await sessionOf(authority.origin, inner);
      expect(second?.user.id).toBe(id);
      expect(second?.user.name).toBe("New Name");
      expect(second?.user.role).toBe("admin");

      expect(await userRowsForEmail(email)).toHaveLength(1);
      expect(await rolesOf(id!)).toEqual(["admin"]);
      const bindings = await bindingsFor(`${PREFIX}-subject-stable`);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]?.userId).toBe(id);
    } finally {
      authority.stop();
    }
  });

  test("same email under the same issuer with a different subject is refused", async () => {
    const email = `twin${EMAIL_DOMAIN}`;
    const sessions = new Map<string, RemoteUser>([
      [
        innerCookie("twin-1"),
        { id: `${PREFIX}-subject-twin-1`, email, role: "user" },
      ],
      [
        innerCookie("twin-2"),
        { id: `${PREFIX}-subject-twin-2`, email, role: "admin" },
      ],
    ]);
    const authority = authorityServer(sessions);
    try {
      const first = await sessionOf(authority.origin, innerCookie("twin-1"));
      const id = first?.user.id;
      expect(id).toBeTruthy();
      await expect(
        sessionOf(authority.origin, innerCookie("twin-2")),
      ).rejects.toThrow(
        "Organization sign-in cannot adopt an account bound to a different remote identity.",
      );
      expect(await userRowsForEmail(email)).toHaveLength(1);
      expect(await rolesOf(id!)).toEqual(["user"]);
      expect(await bindingsFor(`${PREFIX}-subject-twin-2`)).toHaveLength(0);
    } finally {
      authority.stop();
    }
  });

  test("a pre-existing local account is adopted once and then pinned", async () => {
    if (!database) throw new Error("harness not started");
    const email = `adopted${EMAIL_DOMAIN}`;
    const localId = `${PREFIX}-historical-local`;
    await database
      .insert(users)
      .values({ id: localId, email, name: "Historical Employee" });

    const sessionsA = new Map<string, RemoteUser>([
      [
        innerCookie("adopt-a"),
        { id: `${PREFIX}-subject-adopt-a`, email, role: "admin" },
      ],
    ]);
    const sessionsB = new Map<string, RemoteUser>([
      [
        innerCookie("adopt-b"),
        { id: `${PREFIX}-subject-adopt-b`, email, role: "user" },
      ],
    ]);
    const a = authorityServer(sessionsA);
    const b = authorityServer(sessionsB);
    try {
      const session = await sessionOf(a.origin, innerCookie("adopt-a"));
      expect(session?.user.id).toBe(localId);
      expect(await rolesOf(localId)).toEqual(["admin"]);
      const bindings = await bindingsFor(`${PREFIX}-subject-adopt-a`);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        issuer: a.origin,
        userId: localId,
      });

      const again = await sessionOf(a.origin, innerCookie("adopt-a"));
      expect(again?.user.id).toBe(localId);

      await expect(sessionOf(b.origin, innerCookie("adopt-b"))).rejects.toThrow(
        "Organization sign-in cannot adopt an account bound to a different remote identity.",
      );
      expect(await userRowsForEmail(email)).toHaveLength(1);
      expect(await rolesOf(localId)).toEqual(["admin"]);
    } finally {
      a.stop();
      b.stop();
    }
  });

  test("concurrent same-email first sign-ins adopt exactly once", async () => {
    if (!database) throw new Error("harness not started");
    const email = `race${EMAIL_DOMAIN}`;
    const localId = `${PREFIX}-race-local`;
    await database
      .insert(users)
      .values({ id: localId, email, name: "Race Seed" });

    // Two remote identities race to claim the same unclaimed local account,
    // the window review r1 F1 walked through: both materialize on the one
    // pooled client, so the interleaving is the production one.
    const store = organizationUserStore(database);
    const materialize = (subject: string, authority: string) =>
      store({
        id: `${PREFIX}-subject-${subject}`,
        email,
        name: "Remote Racer",
        image: null,
        role: "user",
        authority,
      });
    const [a, b] = await Promise.allSettled([
      materialize("race-a", "https://race-a.example.test"),
      materialize("race-b", "https://race-b.example.test"),
    ]);
    const winner = [a, b].find((r) => r.status === "fulfilled");
    const loser = [a, b].find((r) => r.status === "rejected");
    expect(winner?.status).toBe("fulfilled");
    expect(loser?.status).toBe("rejected");
    expect(String((loser as PromiseRejectedResult).reason)).toBe(
      "Error: Organization sign-in cannot adopt an account bound to a different remote identity.",
    );

    // Exactly one mapping row on the local account — the winner's — and
    // still exactly one local user behind the email.
    const bindings = await database
      .select({ accountId: accounts.accountId })
      .from(accounts)
      .where(eq(accounts.userId, localId));
    expect(bindings).toHaveLength(1);
    expect([`${PREFIX}-subject-race-a`, `${PREFIX}-subject-race-b`]).toContain(
      bindings[0].accountId,
    );
    expect(await userRowsForEmail(email)).toHaveLength(1);
  });

  test("a handoff pins its subject and refuses a foreign authority cookie", async () => {
    const inner = innerCookie("switched");
    const sessions = new Map<string, RemoteUser>([
      [
        inner,
        {
          id: `${PREFIX}-subject-first`,
          email: `first${EMAIL_DOMAIN}`,
          role: "user",
        },
      ],
    ]);
    const authority = authorityServer(sessions);
    try {
      const auth = createOrganizationAuth({
        authorityUrl: authority.origin,
        materializeUser: async (user) => user,
      });
      const start = await auth.handler(
        new Request(`${LOCAL_ORIGIN}/api/auth/organization/session`, {
          method: "POST",
          headers: { origin: LOCAL_ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ cookie: inner }),
        }),
      );
      expect(start.status).toBe(200);
      const ticket = (await start.json()).ticket as string;

      // The authority's session now names a different user; the minted
      // handoff stays pinned to the subject it was issued for.
      sessions.set(inner, {
        id: `${PREFIX}-subject-second`,
        email: `second${EMAIL_DOMAIN}`,
        role: "user",
      });
      const redeem = await auth.handler(
        new Request(
          `${LOCAL_ORIGIN}/api/auth/organization/session?ticket=${ticket}`,
        ),
      );
      expect(redeem.status).toBe(401);
      expect(redeem.headers.get("set-cookie")).toBeNull();

      // A cookie bound to any other origin is refused before a fetch: the
      // registered authority is the only one this deployment accepts.
      const foreign = await auth.api.getSession({
        headers: new Headers({
          cookie: organizationCookie(
            "http://127.0.0.1:1",
            innerCookie("switched"),
          ),
        }),
      });
      expect(foreign).toBeNull();
    } finally {
      authority.stop();
    }
  });
});
