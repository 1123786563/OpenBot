import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type {
  IdentityProviderImpact,
  IdentityProviderStore,
} from "../src/auth/identity-provider-store";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const ADMIN = { id: "admin", email: "admin@openbot.test" };

function app(
  role = "admin",
  identityProviders?: Partial<IdentityProviderStore>,
  actor = ADMIN,
) {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  // createApp takes positional stores: auditStore is 13th and identityProviders 19th. Built by
  // index so a store appended later cannot shift them.
  const args = Array.from({ length: 19 }) as Parameters<typeof createApp>;
  args[0] = loadConfig(testEnvironment()) as never;
  args[1] = {
    /*
     * Reads the body, as the real sign-in library does. A handler that leaves the stream
     * untouched hides the ordering this depends on: a clone taken after the handler has run is of
     * a consumed request, and the row would name no provider.
     */
    handler: async (request: Request) => {
      await request.json().catch(() => null);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    api: { getSession: async () => ({ user: actor }) },
  } as never;
  args[2] = { rolesForUser: async () => [role] } as never;
  args[12] = auditStore as never;
  args[18] = identityProviders as never;
  const hono = createApp(...args);
  return { rows, hono };
}

const REGISTER_BODY = {
  providerId: "acme",
  issuer: "https://login.acme.test",
  domain: "acme.test",
};

describe("the trail says how an identity provider came to exist", () => {
  test("records the registration of an identity provider", async () => {
    const { rows, hono } = app();
    const response = await hono.request("/api/auth/sso/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REGISTER_BODY),
    });
    expect(response.status).toBe(200);
    expect(rows.map((row) => row.eventType)).toContain(
      "identity_provider.registered",
    );
  });

  test("names who registered it and which provider", async () => {
    const { rows, hono } = app();
    await hono.request("/api/auth/sso/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REGISTER_BODY),
    });
    const row = rows.find(
      (candidate) => candidate.eventType === "identity_provider.registered",
    );
    expect(row?.targetId).toBe("acme");
    expect(row?.actorUserId).toBe("admin");
  });

  test("records a removal made through the library's own endpoint", async () => {
    const { rows, hono } = app();
    await hono.request("/api/auth/sso/delete-provider", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "acme" }),
    });
    expect(rows.map((row) => row.eventType)).toContain(
      "identity_provider.removed",
    );
  });

  test("writes nothing when the library refuses the change", async () => {
    const rows: AuditEventInput[] = [];
    const hono = createApp(
      loadConfig(testEnvironment()),
      {
        handler: async (request: Request) => {
          await request.json().catch(() => null);
          return new Response("no", { status: 400 });
        },
        api: { getSession: async () => ({ user: ADMIN }) },
      } as never,
      { rolesForUser: async () => ["admin"] },
      ...(Array.from({ length: 9 }) as never[]),
      { insert: async (event) => void rows.push(event) } as never,
    );
    await hono.request("/api/auth/sso/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REGISTER_BODY),
    });
    expect(rows).toEqual([]);
  });

  test("writes nothing when a non-administrator is refused", async () => {
    const { rows, hono } = app("user");
    const response = await hono.request("/api/auth/sso/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REGISTER_BODY),
    });
    expect(response.status).toBe(403);
    expect(rows).toEqual([]);
  });
});

/** The provider store as the admin routes use it: registered providers, and what was asked of it. */
function providers(registered: string[], impactOf?: (id: string) => unknown) {
  const calls: string[] = [];
  const store: IdentityProviderStore = {
    list: async () => [],
    remove: async (providerId) => {
      calls.push(`remove ${providerId}`);
      return registered.includes(providerId);
    },
    impact: async (providerId) => {
      calls.push(`impact ${providerId}`);
      return (impactOf?.(providerId) ?? null) as IdentityProviderImpact | null;
    },
  };
  return { calls, store };
}

describe("the admin route that removes an identity provider", () => {
  test("records the removal, naming the provider and the admin who asked", async () => {
    const { calls, store } = providers(["acme"]);
    const { rows, hono } = app("admin", store);
    const response = await hono.request("/api/admin/identity-providers/acme", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
    expect(calls).toEqual(["remove acme"]);
    expect(rows).toEqual([
      {
        eventType: "identity_provider.removed",
        targetType: "identity_provider",
        targetId: "acme",
        actorUserId: "admin",
        payload: { removedBy: "admin@openbot.test" },
      },
    ]);
  });

  test("answers 404 for a provider that is not registered, and records nothing", async () => {
    const { store } = providers([]);
    const { rows, hono } = app("admin", store);
    const response = await hono.request("/api/admin/identity-providers/acme", {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "There is no such provider.",
    });
    expect(rows).toEqual([]);
  });

  test("refuses a member before the store is asked, and records nothing", async () => {
    const { calls, store } = providers(["acme"]);
    const { rows, hono } = app("user", store);
    const response = await hono.request("/api/admin/identity-providers/acme", {
      method: "DELETE",
    });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
    expect(rows).toEqual([]);
  });
});

describe("the admin route that says who a provider is the only way in for", () => {
  test("lists the first 20 of each list with the true totals, and whether the admin asking loses their only way in", async () => {
    const losing = Array.from({ length: 25 }, (_, index) => ({
      userId: `losing-${index}`,
      email: `losing-${index}@example.test`,
    }));
    const keeping = [
      {
        userId: "keeper",
        email: "keeper@example.test",
        reason: "emergency-admin" as const,
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        userId: `keeping-${index}`,
        email: `keeping-${index}@example.test`,
        reason: "another-sign-in" as const,
      })),
    ];
    // The admin asking is beyond the cap, so "including you" cannot come from the listed emails.
    const asking = { ...ADMIN, id: "losing-24" };
    const { calls, store } = providers(["acme"], () => ({
      losing,
      keeping,
    }));
    const { rows, hono } = app("admin", store, asking);
    const response = await hono.request(
      "/api/admin/identity-providers/acme/impact",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      impact: {
        losing: {
          total: 25,
          emails: Array.from(
            { length: 20 },
            (_, index) => `losing-${index}@example.test`,
          ),
        },
        keeping: {
          total: 31,
          accounts: [
            { email: "keeper@example.test", reason: "emergency-admin" },
            ...Array.from({ length: 19 }, (_, index) => ({
              email: `keeping-${index}@example.test`,
              reason: "another-sign-in",
            })),
          ],
        },
        includesYou: true,
      },
    });
    expect(calls).toEqual(["impact acme"]);
    expect(rows).toEqual([]);
  });

  test("answers 404 for a provider that is not registered", async () => {
    const { store } = providers([]);
    const { hono } = app("admin", store);
    const response = await hono.request(
      "/api/admin/identity-providers/acme/impact",
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "There is no such provider.",
    });
  });

  test("refuses a member before the store is asked", async () => {
    const { calls, store } = providers(["acme"], () => ({
      losing: [],
      keeping: [],
    }));
    const { hono } = app("user", store);
    const response = await hono.request(
      "/api/admin/identity-providers/acme/impact",
    );
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });
});
