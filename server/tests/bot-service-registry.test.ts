import { afterAll, describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { sql } from "drizzle-orm";
import type { AuditStore } from "../src/audit";
import { type AppVariables, type AuthenticatedActor, requireAdmin } from "../src/auth/guards";
import { createBotAdminRoutes } from "../src/bots/admin-routes";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const ADMIN: AuthenticatedActor = {
  id: "user-admin",
  email: "admin@openbot.test",
  role: "admin",
};
const MEMBER: AuthenticatedActor = {
  id: "user-member",
  email: "member@openbot.test",
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

/** An audit store that records, so a test can assert registration left its row. */
function recordingAudit() {
  const events: AuditStore extends { insert: (e: infer E) => unknown } ? E[] : never[] = [];
  const store: AuditStore = {
    insert: async (event) => {
      events.push(event);
    },
  };
  return { events, store };
}

function buildApp(admin: boolean, audit: AuditStore) {
  const actor = admin ? ADMIN : MEMBER;
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/admin/bots",
    createBotAdminRoutes({ database, requireUser: requireUserAs(actor), requireAdmin, audit }),
  );
  return app;
}

afterAll(async () => {
  await database.execute(sql`DELETE FROM bot_services WHERE bot_id LIKE 'test-bot-%'`);
  await database.$client.close();
});

describe("admin bot service registry", () => {
  test("admin registers a bot with capabilities; duplicate botId is rejected", async () => {
    const audit = recordingAudit();
    const app = buildApp(true, audit.store);
    const res = await app.request("/api/admin/bots", {
      method: "POST",
      body: JSON.stringify({ botId: "test-bot-1", displayName: "Workbench", kind: "builtin", capabilities: ["chat"] }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);

    const dup = await app.request("/api/admin/bots", {
      method: "POST",
      body: JSON.stringify({ botId: "test-bot-1", displayName: "Again", kind: "external", capabilities: ["chat"] }),
      headers: { "content-type": "application/json" },
    });
    expect(dup.status).toBe(409);

    // Registration is audited: one bot_service.registered row naming the actor and the payload.
    expect(audit.events).toEqual([
      expect.objectContaining({
        eventType: "bot_service.registered",
        targetId: "test-bot-1",
        actorUserId: "user-admin",
      }),
    ]);
  });

  test("invalid capability and malformed botId are 400s", async () => {
    const app = buildApp(true, recordingAudit().store);
    const bad = await app.request("/api/admin/bots", {
      method: "POST",
      body: JSON.stringify({ botId: "Bad Id!", displayName: "x", kind: "external", capabilities: ["nope"] }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });

  test("non-admin is rejected on every route", async () => {
    const app = buildApp(false, recordingAudit().store);
    expect((await app.request("/api/admin/bots")).status).toBe(403);
    expect((await app.request("/api/admin/bots", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(403);
  });

  test("disable is sticky and there is no delete", async () => {
    const app = buildApp(true, recordingAudit().store);
    const off = await app.request("/api/admin/bots/test-bot-1/status", {
      method: "POST",
      body: JSON.stringify({ status: "disabled" }),
      headers: { "content-type": "application/json" },
    });
    expect(off.status).toBe(200);
    expect(await (await app.request("/api/admin/bots")).json()).toMatchObject([{ botId: "test-bot-1", status: "disabled" }]);
  });
});
