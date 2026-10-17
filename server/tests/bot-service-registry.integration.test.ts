/**
 * Ticket 04.1 (#234): the admin bot-service registry.
 *
 * A botId is a server-side service identity an administrator registers once: unique, never
 * recycled (there is no delete), admin-only to register/edit/disable, and queryable in its
 * disabled state so downstream (04.2 credentials, 03.8/#238, 05.3/#241) can refuse on it.
 * Registration itself must stay inert: no credential, no grant, no credit authority, no
 * content permission — the registry row and its audit trail are the only effects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AuditStore } from "../src/audit";
import {
  type AppVariables,
  type AuthenticatedActor,
  requireAdmin,
} from "../src/auth/guards";
import { createBotAdminRoutes } from "../src/bots/admin-routes";
import {
  getBotService,
  listBotServices,
} from "../src/bots/service-registry";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const ADMIN: AuthenticatedActor = {
  id: "user-admin-234",
  email: "admin-234@openbot.test",
  role: "admin",
};
const MEMBER: AuthenticatedActor = {
  id: "user-member-234",
  email: "member-234@openbot.test",
  role: "user",
};

/** The session guard as a switch: an absent actor is the not-signed-in request. */
function requireUserAs(
  actor: AuthenticatedActor | undefined,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (!actor) {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", actor);
    await next();
  };
}

/** An audit store that records, so a test can assert exactly what registration left behind. */
function recordingAudit() {
  const events: Parameters<AuditStore["insert"]>[0][] = [];
  const store: AuditStore = {
    insert: async (event) => {
      events.push(event);
    },
  };
  return { events, store };
}

function buildApp(
  actor: AuthenticatedActor | undefined,
  audit: AuditStore,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/admin/bots",
    createBotAdminRoutes({
      database,
      requireUser: requireUserAs(actor),
      requireAdmin,
      audit,
    }),
  );
  return app;
}

function post(app: Hono<{ Variables: AppVariables }>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function patch(app: Hono<{ Variables: AppVariables }>, path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** Row counts of every side-effect table a registration must NOT write to. */
async function sideEffectCounts() {
  const tables = [
    "credentials",
    "credit_grants",
    "credit_ledger",
    "billing_customers",
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = (await database.execute(
      sql.raw(`SELECT COUNT(*)::text AS count FROM ${table}`),
    )) as unknown as { count: string }[];
    counts[table] = Number(rows[0].count);
  }
  return counts;
}

beforeAll(async () => {
  await database.execute(
    sql`DELETE FROM bot_services WHERE bot_id LIKE 'test-bot-234-%'`,
  );
});

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM bot_services WHERE bot_id LIKE 'test-bot-234-%'`,
  );
  await database.$client.close();
});

describe("admin bot service registry (#234)", () => {
  test("admin registers a bot; the record carries the BotServiceRecord contract", async () => {
    const audit = recordingAudit();
    const app = buildApp(ADMIN, audit.store);
    const res = await post(app, "/api/admin/bots", {
      botId: "test-bot-234-alpha",
      displayName: "Workbench Bot",
      kind: "builtin",
      capabilities: ["chat", "image"],
    });
    expect(res.status).toBe(201);

    const record = await getBotService(database, "test-bot-234-alpha");
    expect(record).toMatchObject({
      botId: "test-bot-234-alpha",
      displayName: "Workbench Bot",
      kind: "builtin",
      capabilities: ["chat", "image"],
      status: "active",
    });
    expect(record?.createdAt).toBeInstanceOf(Date);

    const listed = await listBotServices(database);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ botId: "test-bot-234-alpha" }),
      ]),
    );

    // Registration is audited with the actor and the exact registered payload.
    expect(audit.events).toEqual([
      expect.objectContaining({
        eventType: "bot_service.registered",
        targetType: "bot_service",
        targetId: "test-bot-234-alpha",
        actorUserId: "user-admin-234",
      }),
    ]);
  });

  test("duplicate botId is rejected, and a disabled botId is never reusable", async () => {
    const app = buildApp(ADMIN, recordingAudit().store);
    await post(app, "/api/admin/bots", {
      botId: "test-bot-234-beta",
      displayName: "First Claim",
      kind: "external",
      capabilities: ["chat"],
    });

    const dup = await post(app, "/api/admin/bots", {
      botId: "test-bot-234-beta",
      displayName: "Second Claim",
      kind: "external",
      capabilities: ["chat"],
    });
    expect(dup.status).toBe(409);

    // Disable it, then try to reclaim the id under a different kind: still refused.
    const off = await post(app, "/api/admin/bots/test-bot-234-beta/status", {
      status: "disabled",
    });
    expect(off.status).toBe(200);
    const recycled = await post(app, "/api/admin/bots", {
      botId: "test-bot-234-beta",
      displayName: "Rebirth",
      kind: "builtin",
      capabilities: ["async"],
    });
    expect(recycled.status).toBe(409);
  });

  test("non-admin cannot register, edit or disable; anonymous is 401", async () => {
    const memberApp = buildApp(MEMBER, recordingAudit().store);
    expect((await memberApp.request("/api/admin/bots")).status).toBe(403);
    expect(
      (
        await post(memberApp, "/api/admin/bots", {
          botId: "test-bot-234-gamma",
          displayName: "x",
          kind: "external",
          capabilities: ["chat"],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await patch(memberApp, "/api/admin/bots/test-bot-234-alpha", {
          displayName: "Hijacked",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(memberApp, "/api/admin/bots/test-bot-234-alpha/status", {
          status: "disabled",
        })
      ).status,
    ).toBe(403);

    const anonApp = buildApp(undefined, recordingAudit().store);
    expect((await anonApp.request("/api/admin/bots")).status).toBe(401);
  });

  test("admin edits displayName and capabilities; botId and kind are immutable", async () => {
    const audit = recordingAudit();
    const app = buildApp(ADMIN, audit.store);
    const res = await patch(app, "/api/admin/bots/test-bot-234-alpha", {
      displayName: "Workbench Bot v2",
      capabilities: ["chat", "audio", "embedding"],
    });
    expect(res.status).toBe(200);

    const record = await getBotService(database, "test-bot-234-alpha");
    expect(record).toMatchObject({
      botId: "test-bot-234-alpha",
      displayName: "Workbench Bot v2",
      kind: "builtin",
      capabilities: ["chat", "audio", "embedding"],
      status: "active",
    });
    expect(audit.events).toEqual([
      expect.objectContaining({
        eventType: "bot_service.edited",
        targetId: "test-bot-234-alpha",
        actorUserId: "user-admin-234",
      }),
    ]);

    // Unknown botId: 404, not a silent create-by-edit.
    const missing = await patch(app, "/api/admin/bots/test-bot-234-nope", {
      displayName: "Ghost",
      capabilities: ["chat"],
    });
    expect(missing.status).toBe(404);
  });

  test("disabled state is queryable so downstream can refuse on it", async () => {
    const audit = recordingAudit();
    const app = buildApp(ADMIN, audit.store);
    const off = await post(app, "/api/admin/bots/test-bot-234-alpha/status", {
      status: "disabled",
    });
    expect(off.status).toBe(200);

    expect(await getBotService(database, "test-bot-234-alpha")).toMatchObject({
      botId: "test-bot-234-alpha",
      status: "disabled",
    });
    const listed = await listBotServices(database);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          botId: "test-bot-234-alpha",
          status: "disabled",
        }),
      ]),
    );
    expect(audit.events).toEqual([
      expect.objectContaining({
        eventType: "bot_service.status_changed",
        targetId: "test-bot-234-alpha",
        actorUserId: "user-admin-234",
      }),
    ]);

    // Status on an unknown botId is a 404, and a garbage status is a 400.
    expect(
      (
        await post(app, "/api/admin/bots/test-bot-234-nope/status", {
          status: "disabled",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(app, "/api/admin/bots/test-bot-234-alpha/status", {
          status: "deleted",
        })
      ).status,
    ).toBe(400);
  });

  test("registration produces no credential, grant, credit or billing side effect", async () => {
    const before = await sideEffectCounts();
    const audit = recordingAudit();
    const app = buildApp(ADMIN, audit.store);
    const res = await post(app, "/api/admin/bots", {
      botId: "test-bot-234-delta",
      displayName: "Inert Bot",
      kind: "external",
      capabilities: ["realtime"],
    });
    expect(res.status).toBe(201);
    expect(await sideEffectCounts()).toEqual(before);
    // The only trail registration leaves is the registry row plus its audit event.
    expect(audit.events.map((event) => event.eventType)).toEqual([
      "bot_service.registered",
    ]);
  });

  test("malformed registrations are 400s", async () => {
    const app = buildApp(ADMIN, recordingAudit().store);
    const cases: unknown[] = [
      { botId: "Bad Id!", displayName: "x", kind: "external", capabilities: ["chat"] },
      { botId: "-leading-dash", displayName: "x", kind: "external", capabilities: ["chat"] },
      { botId: "a".repeat(65), displayName: "x", kind: "external", capabilities: ["chat"] },
      { botId: "test-bot-234-eps", displayName: "", kind: "external", capabilities: ["chat"] },
      { botId: "test-bot-234-eps", displayName: "y".repeat(101), kind: "external", capabilities: ["chat"] },
      { botId: "test-bot-234-eps", displayName: "x", kind: "third-party", capabilities: ["chat"] },
      { botId: "test-bot-234-eps", displayName: "x", kind: "external", capabilities: [] },
      { botId: "test-bot-234-eps", displayName: "x", kind: "external", capabilities: ["telepathy"] },
      { botId: "test-bot-234-eps", displayName: "x", kind: "external" },
    ];
    for (const body of cases) {
      expect((await post(app, "/api/admin/bots", body)).status).toBe(400);
    }
    // Nothing from the rejected batch landed.
    expect(await getBotService(database, "test-bot-234-eps")).toBeUndefined();
  });
});
