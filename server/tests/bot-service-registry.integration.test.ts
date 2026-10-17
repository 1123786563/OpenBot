/**
 * 04.1 / #234 — the Bot service registry, from its public seams.
 *
 * The store is the seam 04.2 (service authentication), 03.8 (capability filter) and 05.3 (per-
 * authorization keys) are contracted to consume, so the registry's behaviour is pinned here at
 * both of its boundaries: the store's own functions, and the administrator routes that are the
 * only way a person can write one.
 *
 * Requires TEST_DATABASE_URL: uniqueness and the concurrent double registration are database
 * guarantees (the primary key is the constraint that makes a botId globally unique and, since no
 * path deletes a row, permanently un-reusable), not array bookkeeping a unit test could fake.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { createAuditStore, type AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createBotServiceAdminRoutes } from "../src/bot-services/routes";
import {
  BOT_SERVICE_CAPABILITIES,
  BotServiceRefusedError,
  createBotServiceStore,
  type BotServiceRecord,
  type BotServiceStore,
} from "../src/bot-services/store";
import { createDatabase, type Database } from "../src/db/client";
import { auditEvents, botServices, credentials } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database: Database = createDatabase(databaseUrl, TEST_POOL);
const auditStore: AuditStore = createAuditStore(database);
const store: BotServiceStore = createBotServiceStore(database, auditStore);

const ADMIN = { userId: "bot-registry-admin", role: "admin" } as const;
const MEMBER = { userId: "bot-registry-member", role: "user" } as const;

// Short on purpose: a botId is capped at 64 characters, and this prefix plus a suffix must fit
// inside it, so the prefix carries a slice of a uuid rather than the whole thing.
const testPrefix = `botreg-${randomUUID().slice(0, 8)}`;

function botId(suffix: string) {
  return `${testPrefix}-${suffix}`;
}

/** The route half, behind the same three actors the real guard chain produces. */
function requireUserAs(
  actor: { userId: string; role: "admin" | "user" } | null,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (
    context: Context<{ Variables: AppVariables }>,
    next: () => Promise<void>,
  ) => {
    if (!actor) {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", {
      id: actor.userId,
      email: `${actor.userId}@openbot.test`,
      role: actor.role,
    });
    await next();
  };
}

const adminRoutes = new Hono<{ Variables: AppVariables }>().route(
  "/api/admin/bot-services",
  createBotServiceAdminRoutes({ requireUser: requireUserAs(ADMIN), store }),
);
const memberRoutes = new Hono<{ Variables: AppVariables }>().route(
  "/api/admin/bot-services",
  createBotServiceAdminRoutes({ requireUser: requireUserAs(MEMBER), store }),
);
const anonymousRoutes = new Hono<{ Variables: AppVariables }>().route(
  "/api/admin/bot-services",
  createBotServiceAdminRoutes({ requireUser: requireUserAs(null), store }),
);

function registerBody(botIdValue: string, overrides: Record<string, unknown> = {}) {
  return {
    botId: botIdValue,
    displayName: "Registered Test Bot",
    kind: "external",
    capabilities: ["chat"],
    ...overrides,
  };
}

afterEach(async () => {
  // The audit trail is append-only (a database trigger refuses mutation), so the rows this file
  // writes stay — the same deal every other audited integration test makes with a dedicated test
  // database. Only the registry rows themselves are cleaned, keyed by this file's unique prefix.
  await database.delete(botServices).where(like(botServices.botId, `${testPrefix}%`));
});

afterAll(async () => {
  await database.$client.close();
});

describe("registering a Bot service", () => {
  test("an administrator registers a builtin and an external Bot with a capability declaration", async () => {
    const builtin = await store.register(
      {
        botId: botId("builtin"),
        displayName: "Workbench Bot",
        kind: "builtin",
        capabilities: ["chat", "image"],
      },
      { userId: ADMIN.userId },
    );

    expect(builtin).toMatchObject({
      botId: botId("builtin"),
      displayName: "Workbench Bot",
      kind: "builtin",
      capabilities: ["chat", "image"],
      status: "active",
    });
    expect(builtin.createdAt).toBeInstanceOf(Date);

    const external = await store.register(
      {
        botId: botId("external"),
        displayName: "Approved Partner Bot",
        kind: "external",
        capabilities: BOT_SERVICE_CAPABILITIES,
      },
      { userId: ADMIN.userId },
    );
    expect(external.kind).toBe("external");
    expect(external.status).toBe("active");
  });

  test("a duplicate botId is refused, sequentially and under a concurrent race", async () => {
    const id = botId("dup");
    await store.register(registerBody(id), { userId: ADMIN.userId });

    const sequential = store.register(registerBody(id), { userId: ADMIN.userId });
    await expect(sequential).rejects.toBeInstanceOf(BotServiceRefusedError);
    await expect(sequential).rejects.toMatchObject({ status: 409 });

    // Deterministic failure injection: two registrations of one not-yet-taken botId race, and
    // exactly one may win. The primary key, not the store's bookkeeping, decides.
    const raced = botId("race");
    const attempts = await Promise.allSettled([
      store.register(registerBody(raced), { userId: ADMIN.userId }),
      store.register(registerBody(raced), { userId: ADMIN.userId }),
    ]);
    const fulfilled = attempts.filter(
      (attempt) => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === "rejected") {
      expect(rejected[0].reason).toBeInstanceOf(BotServiceRefusedError);
      expect(rejected[0].reason.status).toBe(409);
    }

    // The loser of the race did not leave a disabled or half-written row behind: one row, active.
    const rows = await database
      .select()
      .from(botServices)
      .where(eq(botServices.botId, raced));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });

  test("a disabled botId is not reusable: re-registering it is a duplicate refusal", async () => {
    const id = botId("disabled-not-reusable");
    await store.register(registerBody(id), { userId: ADMIN.userId });
    await store.disable(id, { userId: ADMIN.userId });

    await expect(
      store.register(registerBody(id), { userId: ADMIN.userId }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("botId, displayName and capabilities are validated", async () => {
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["uppercase botId", registerBody(botId("UPPER"))],
      ["botId with spaces", registerBody("has space")],
      ["leading dash botId", registerBody("-lead")],
      ["trailing dot botId", registerBody("trail.")],
      ["over-length botId", registerBody("a".repeat(65))],
      ["empty botId", registerBody("")],
      [
        "empty displayName",
        registerBody(botId("no-name"), { displayName: "   " }),
      ],
      [
        "over-length displayName",
        registerBody(botId("long-name"), { displayName: "n".repeat(201) }),
      ],
      [
        "empty capabilities",
        registerBody(botId("no-caps"), { capabilities: [] }),
      ],
      [
        "unknown capability",
        registerBody(botId("bad-cap"), { capabilities: ["video"] }),
      ],
      [
        "duplicate capability",
        registerBody(botId("dup-cap"), { capabilities: ["chat", "chat"] }),
      ],
      [
        "unknown kind",
        registerBody(botId("bad-kind"), { kind: "rogue" }),
      ],
    ];

    for (const [label, body] of invalid) {
      await expect(
        store.register(body as never, { userId: ADMIN.userId }),
        label,
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  test("registration produces no credential, authorization or credit permission of any kind", async () => {
    const before = await database.select().from(credentials);

    const record = await store.register(registerBody(botId("no-side-effects")), {
      userId: ADMIN.userId,
    });

    const after = await database.select().from(credentials);
    expect(after).toHaveLength(before.length);

    // The record itself carries identity and status only: nothing a caller could mistake for a
    // secret, a grant or a credit balance.
    expect(Object.keys(record).sort()).toEqual(
      [
        "botId",
        "capabilities",
        "createdAt",
        "disabledAt",
        "disabledBy",
        "displayName",
        "kind",
        "registeredBy",
        "status",
        "updatedAt",
      ].sort(),
    );
  });
});

describe("editing a Bot service", () => {
  test("an administrator edits displayName and capabilities, never kind or status", async () => {
    const id = botId("editable");
    await store.register(
      registerBody(id, { displayName: "Before", capabilities: ["chat"] }),
      { userId: ADMIN.userId },
    );

    const edited = await store.edit(
      { botId: id, displayName: "After", capabilities: ["chat", "embedding"] },
      { userId: ADMIN.userId },
    );
    expect(edited.displayName).toBe("After");
    expect(edited.capabilities).toEqual(["chat", "embedding"]);
    expect(edited.kind).toBe("external");
    expect(edited.status).toBe("active");
  });

  test("editing an unknown botId is refused, and a disabled Bot keeps its status through an edit", async () => {
    await expect(
      store.edit(
        { botId: botId("missing"), displayName: "No" },
        { userId: ADMIN.userId },
      ),
    ).rejects.toMatchObject({ status: 404 });

    const id = botId("edit-while-disabled");
    await store.register(registerBody(id), { userId: ADMIN.userId });
    await store.disable(id, { userId: ADMIN.userId });

    const edited = await store.edit(
      { botId: id, displayName: "Renamed while disabled" },
      { userId: ADMIN.userId },
    );
    expect(edited.status).toBe("disabled");
    expect(edited.displayName).toBe("Renamed while disabled");
  });

  test("an edit with nothing to change is refused rather than written", async () => {
    const id = botId("no-op-edit");
    await store.register(registerBody(id), { userId: ADMIN.userId });

    await expect(
      store.edit({ botId: id }, { userId: ADMIN.userId }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("disabling a Bot service", () => {
  test("a disabled Bot reads back as disabled, with who and when", async () => {
    const id = botId("disable-me");
    await store.register(registerBody(id), { userId: ADMIN.userId });

    const disabled = await store.disable(id, { userId: ADMIN.userId });
    expect(disabled.status).toBe("disabled");
    expect(disabled.disabledAt).toBeInstanceOf(Date);
    expect(disabled.disabledBy).toBe(ADMIN.userId);

    // The queries downstream (04.2 authentication, 03.8 capability filter) are contracted to read.
    const byId = await store.getBotService(id);
    expect(byId?.status).toBe("disabled");

    const listed = await store.listBotServices();
    const row = listed.find((record) => record.botId === id);
    expect(row?.status).toBe("disabled");
  });

  test("disabling an unknown Bot is a 404 and a second disable is a 409", async () => {
    await expect(
      store.disable(botId("ghost"), { userId: ADMIN.userId }),
    ).rejects.toMatchObject({ status: 404 });

    const id = botId("double-disable");
    await store.register(registerBody(id), { userId: ADMIN.userId });
    await store.disable(id, { userId: ADMIN.userId });
    await expect(
      store.disable(id, { userId: ADMIN.userId }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("getBotService answers null for an unknown botId", async () => {
    expect(await store.getBotService(botId("never-registered"))).toBeNull();
  });
});

describe("the audit trail", () => {
  test("register, edit and disable each leave one row naming the actor and the bot", async () => {
    const id = botId("audited");
    await store.register(registerBody(id), { userId: ADMIN.userId });
    await store.edit({ botId: id, displayName: "Audited Rename" }, {
      userId: ADMIN.userId,
    });
    await store.disable(id, { userId: ADMIN.userId });

    const rows = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, id))
      .orderBy(auditEvents.createdAt);

    expect(rows.map((row) => row.eventType)).toEqual([
      "bot_service.registered",
      "bot_service.edited",
      "bot_service.disabled",
    ]);
    for (const row of rows) {
      expect(row.actorUserId).toBe(ADMIN.userId);
      expect(row.targetType).toBe("bot_service");
      expect(row.targetId).toBe(id);
    }

    const registered = rows[0].payload as Record<string, unknown>;
    expect(registered).toMatchObject({
      displayName: "Registered Test Bot",
      kind: "external",
      capabilities: ["chat"],
    });

    const edited = rows[1].payload as Record<string, unknown>;
    expect(edited).toMatchObject({
      displayName: { from: "Registered Test Bot", to: "Audited Rename" },
    });

    const disabled = rows[2].payload as Record<string, unknown>;
    expect(disabled).toMatchObject({ status: { from: "active", to: "disabled" } });
  });
});

describe("the administrator routes", () => {
  test("a non-administrator cannot register, edit or disable", async () => {
    const id = botId("member-refused");

    const registerResponse = await memberRoutes.request(
      "http://openbot.local/api/admin/bot-services",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registerBody(id)),
      },
    );
    expect(registerResponse.status).toBe(403);
    await expect(registerResponse.json()).resolves.toEqual({
      error: "Administrator access required.",
    });
    // Nothing was written.
    expect(await store.getBotService(id)).toBeNull();

    const editResponse = await memberRoutes.request(
      `http://openbot.local/api/admin/bot-services/${id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Member Rename" }),
      },
    );
    expect(editResponse.status).toBe(403);

    const disableResponse = await memberRoutes.request(
      `http://openbot.local/api/admin/bot-services/${id}/disable`,
      { method: "POST" },
    );
    expect(disableResponse.status).toBe(403);
  });

  test("an unauthenticated caller is refused before any write", async () => {
    const response = await anonymousRoutes.request(
      "http://openbot.local/api/admin/bot-services",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registerBody(botId("anonymous-refused"))),
      },
    );
    expect(response.status).toBe(401);
  });

  test("an administrator registers, lists, reads, edits and disables over HTTP", async () => {
    const id = botId("http-flow");

    const registerResponse = await adminRoutes.request(
      "http://openbot.local/api/admin/bot-services",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          registerBody(id, { displayName: "HTTP Bot", kind: "builtin" }),
        ),
      },
    );
    expect(registerResponse.status).toBe(201);
    const created = (await registerResponse.json()) as {
      botService: Record<string, unknown>;
    };
    expect(created.botService).toMatchObject({
      botId: id,
      displayName: "HTTP Bot",
      kind: "builtin",
      status: "active",
    });
    expect(typeof created.botService.createdAt).toBe("string");

    const editResponse = await adminRoutes.request(
      `http://openbot.local/api/admin/bot-services/${id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capabilities: ["realtime"] }),
      },
    );
    expect(editResponse.status).toBe(200);
    await expect(editResponse.json()).resolves.toMatchObject({
      botService: { capabilities: ["realtime"] },
    });

    const disableResponse = await adminRoutes.request(
      `http://openbot.local/api/admin/bot-services/${id}/disable`,
      { method: "POST" },
    );
    expect(disableResponse.status).toBe(200);
    await expect(disableResponse.json()).resolves.toMatchObject({
      botService: { status: "disabled" },
    });

    const listResponse = await adminRoutes.request(
      "http://openbot.local/api/admin/bot-services",
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as {
      botServices: BotServiceRecord[];
    };
    const row = listed.botServices.find((record) => record.botId === id);
    expect(row).toMatchObject({ status: "disabled" });

    const getResponse = await adminRoutes.request(
      `http://openbot.local/api/admin/bot-services/${id}`,
    );
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      botService: { botId: id, status: "disabled" },
    });
  });

  test("input failures map to 400/404/409, and the list needs an administrator too", async () => {
    const duplicate = await adminRoutes.request(
      "http://openbot.local/api/admin/bot-services",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registerBody(botId("http-dup"))),
      },
    );
    expect(duplicate.status).toBe(201);

    const again = await adminRoutes.request(
      "http://openbot.local/api/admin/bot-services",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registerBody(botId("http-dup"))),
      },
    );
    expect(again.status).toBe(409);

    const invalid = await adminRoutes.request(
      "http://openbot.local/api/admin/bot-services",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registerBody("Not Valid")),
      },
    );
    expect(invalid.status).toBe(400);

    const missing = await adminRoutes.request(
      `http://openbot.local/api/admin/bot-services/${botId("http-missing")}/disable`,
      { method: "POST" },
    );
    expect(missing.status).toBe(404);

    const memberList = await memberRoutes.request(
      "http://openbot.local/api/admin/bot-services",
    );
    expect(memberList.status).toBe(403);
  });
});
