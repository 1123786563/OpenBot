import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { PeopleStore, Person } from "../src/people/store";
import { testEnvironment } from "./support/environment";

/**
 * Who may change who can get in.
 *
 * The rules worth pinning are the refusals, because each of them stops a deployment reaching a state
 * with nobody able to administer it, and none of them is obvious from the route's shape. What a
 * change puts on the trail is the store's, held against a real database in
 * people-actions.integration.test.ts; here the store is a fake that only says what it was asked.
 */
const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "u1",
    email: "member@openbot.test",
    name: "A Member",
    image: null,
    role: "user",
    providers: ["google"],
    lastSignedInAt: null,
    revoked: false,
    configuredAdmin: false,
    ...overrides,
  };
}

function appWith(
  people: Person[],
  role: "admin" | "user" = "admin",
  overrides: Partial<PeopleStore> = {},
): {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  const store: PeopleStore = {
    // One page, and no next one: what a small deployment answers. The paging itself is covered
    // against a real database in people-paging.integration.test.ts.
    list: async () => ({ people, nextCursor: null }),
    find: async (userId) => people.find((entry) => entry.id === userId),
    setRole: async (userId, next, by) => {
      calls.push(`setRole:${userId}:${next}:${by}`);
    },
    revoke: async (userId, by) => {
      calls.push(`revoke:${userId}:${by}`);
    },
    retireOwned: async (userId, by) => {
      calls.push(`retireOwned:${userId}:${by}`);
    },
    restore: async (userId, by) => {
      calls.push(`restore:${userId}:${by}`);
    },
    isRevoked: async () => false,
    ...overrides,
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    /*
     * Fourteen fillers, not fifteen: positions 4-17 are other stores, and `store` is 18,
     * peopleStore. Every parameter from 4 on is optional, so getting the count wrong is a silent
     * type-check pass: the store lands in `ssoProviderCount`, the people routes see no store, and
     * every test below fails with a 503 that says nothing about why.
     */
    ...(Array.from({ length: 14 }) as never[]),
    store as never,
  );

  return {
    request: (path, init) => app.request(`http://openbot.test${path}`, init),
    calls,
  };
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("people routes", () => {
  test("lists everybody for an administrator", async () => {
    const { request } = appWith([person()]);

    const response = await request("/api/admin/people");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      people: [person()],
      nextCursor: null,
    });
  });

  // A plain user reading the list would learn every colleague's address and when they last signed
  // in, which is not theirs to have.
  test("refuses the list to somebody who is not an administrator", async () => {
    const { request } = appWith([person()], "user");

    expect((await request("/api/admin/people")).status).toBe(403);
  });

  test("promotes somebody", async () => {
    const { request, calls } = appWith([person()]);

    const response = await request(
      "/api/admin/people/u1/role",
      json({ role: "admin" }),
    );

    expect(response.status).toBe(200);
    // Who asked goes with it, for the row the store writes.
    expect(calls).toEqual(["setRole:u1:admin:admin-1"]);
  });

  /**
   * The configured floor wins over the screen.
   *
   * Somebody named in `INITIAL_ADMIN_EMAILS` is promoted again at their next sign-in whatever this
   * route writes, so allowing the demotion would produce a screen that lies until they come back.
   */
  test("refuses to demote somebody the configuration names", async () => {
    const { request, calls } = appWith([person({ configuredAdmin: true })]);

    const response = await request(
      "/api/admin/people/u1/role",
      json({ role: "user" }),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("INITIAL_ADMIN_EMAILS");
    expect(calls).toEqual([]);
  });

  test("refuses to remove somebody the configuration names", async () => {
    const { request, calls } = appWith([person({ configuredAdmin: true })]);

    const response = await request(
      "/api/admin/people/u1/access",
      json({ revoked: true }),
    );

    expect(response.status).toBe(409);
    expect(calls).toEqual([]);
  });

  // Both of these lock the person doing it out of the screen that would undo it, and on a
  // deployment with one administrator that is the whole deployment.
  test("refuses to let somebody demote themselves", async () => {
    const { request, calls } = appWith([
      person({ id: ADMIN.id, email: ADMIN.email, role: "admin" }),
    ]);

    const response = await request(
      `/api/admin/people/${ADMIN.id}/role`,
      json({ role: "user" }),
    );

    expect(response.status).toBe(409);
    expect(calls).toEqual([]);
  });

  test("refuses to let somebody remove their own access", async () => {
    const { request, calls } = appWith([
      person({ id: ADMIN.id, email: ADMIN.email, role: "admin" }),
    ]);

    const response = await request(
      `/api/admin/people/${ADMIN.id}/access`,
      json({ revoked: true }),
    );

    expect(response.status).toBe(409);
    expect(calls).toEqual([]);
  });

  test("removes and restores access", async () => {
    const { request, calls } = appWith([person()]);

    await request("/api/admin/people/u1/access", json({ revoked: true }));

    expect(calls).toEqual([
      `revoke:u1:${ADMIN.id}`,
      `retireOwned:u1:${ADMIN.id}`,
    ]);
  });

  test("restores access for somebody already removed", async () => {
    const { request, calls } = appWith([person({ revoked: true })]);

    await request("/api/admin/people/u1/access", json({ revoked: false }));

    expect(calls).toEqual(["restore:u1:admin-1"]);
  });

  /*
   * The removal commits before the retirement runs, so a broker that will not answer leaves the
   * person removed and their credentials live. A bare 500 told the administrator nothing had been
   * confirmed; the answer now says which half took effect, and asking again finishes the other half
   * without removing them twice.
   */
  test("a removal whose retirement failed says what took effect and asks for a retry", async () => {
    const member = person();
    let attempts = 0;
    const { request, calls } = appWith([member], "admin", {
      // The removal sticks, as the real store's does: the retry finds them already removed.
      revoke: async (userId, by) => {
        calls.push(`revoke:${userId}:${by}`);
        member.revoked = true;
      },
      retireOwned: async (userId, by) => {
        calls.push(`retireOwned:${userId}:${by}`);
        attempts += 1;
        if (attempts === 1)
          throw new Error("composio: 503 Service Unavailable");
      },
    });

    const failed = await request(
      "/api/admin/people/u1/access",
      json({ revoked: true }),
    );

    expect(failed.status).toBe(503);
    expect((await failed.json()).error).toBe(
      "Access is removed for this person, but some of their credentials or Recorders could not be retired yet. Try again to finish.",
    );
    expect(calls).toEqual([
      `revoke:u1:${ADMIN.id}`,
      `retireOwned:u1:${ADMIN.id}`,
    ]);

    expect(
      (await request("/api/admin/people/u1/access", json({ revoked: true })))
        .status,
    ).toBe(200);
    expect(attempts).toBe(2);
    expect(calls).toEqual([
      `revoke:u1:${ADMIN.id}`,
      `retireOwned:u1:${ADMIN.id}`,
      `retireOwned:u1:${ADMIN.id}`,
    ]);
  });

  test("refuses a role that is not one of the two", async () => {
    const { request, calls } = appWith([person()]);

    const response = await request(
      "/api/admin/people/u1/role",
      json({ role: "owner" }),
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("answers 404 for somebody who is not here", async () => {
    const { request } = appWith([]);

    const response = await request(
      "/api/admin/people/nobody/role",
      json({ role: "admin" }),
    );

    expect(response.status).toBe(404);
  });

  /*
   * Absent store answers 503, not an empty list. "Nobody has signed in" and "this deployment cannot
   * tell you" are different answers, and an administrator deciding who has access needs to know
   * which one they are reading.
   */
  test("says so when people are not available at all", async () => {
    const app = createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: { getSession: async () => ({ user: ADMIN }) },
      } as never,
      { rolesForUser: async () => ["admin"] },
    );

    const response = await app.request("http://openbot.test/api/admin/people");

    expect(response.status).toBe(503);
  });
});
