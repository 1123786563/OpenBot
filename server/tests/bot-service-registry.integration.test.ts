import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { count, eq, like } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { botServiceAdminRoutes } from "../src/bot-services/routes";
import { createBotServiceStore } from "../src/bot-services/store";
import {
  BotServiceConflictError,
  BotServiceInputError,
  BotServiceNotFoundError,
} from "../src/bot-services/types";
import { createDatabase } from "../src/db/client";
import { auditEvents, botServices, credentials } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost #234 (04.1): the bot service registry, on a real PostgreSQL.
 *
 * Every question here is the ticket's own: a botId is registered once and never reused, only an
 * administrator's route reaches the table, a disabled bot reads back disabled so downstream can
 * refuse it, and registering produces no credential, grant or credit of any kind.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createBotServiceStore(database);
const auditStore = createAuditStore(database);
const prefix = `b5-234-${randomUUID()}`;

afterAll(async () => {
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  // The audit rows the route-level test writes are left in place: audit_events is append-only
  // (a trigger refuses every mutation), which is the trail working as designed. Each run names
  // its own botIds, so rows from an earlier run can never answer a later assertion.
  await database.$client.close();
});

/** A botId under this file's prefix, so afterAll can remove exactly this file's rows. */
const botId = (suffix = randomUUID()) => `${prefix}-${suffix}`;

/**
 * Which constraint a rejected write tripped. Drizzle wraps the driver error, so SQLSTATE and
 * constraint name sit on `cause`. A bare `rejects.toThrow()` would pass on any failure at all.
 */
async function violation(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (caught: unknown) => caught,
  );
  const driver = (error as { cause?: unknown }).cause ?? error;
  const { errno, constraint } = driver as {
    errno?: unknown;
    constraint?: unknown;
  };
  return { sqlState: errno, constraint };
}

test("register creates the record with a unique service identity", async () => {
  const record = await store.register({
    botId: botId("builtin"),
    displayName: "Workbench Bot",
    kind: "builtin",
    capabilities: ["embedding", "chat"],
  });
  expect(record).toMatchObject({
    botId: botId("builtin"),
    displayName: "Workbench Bot",
    kind: "builtin",
    status: "active",
  });
  // The declaration is stored in the registry's canonical order, deduplicated.
  expect(record.capabilities).toEqual(["chat", "embedding"]);
  expect(record.createdAt).toBeInstanceOf(Date);
  // The full record carries no credential material of any kind.
  expect(JSON.stringify(record)).not.toMatch(/credential|secret|token|key/i);
});

test("a duplicate botId is refused, including after the bot was disabled", async () => {
  const id = botId("dup");
  await store.register({
    botId: id,
    displayName: "First",
    kind: "external",
    capabilities: ["chat"],
  });
  await expect(
    store.register({
      botId: id,
      displayName: "Second",
      kind: "external",
      capabilities: ["chat"],
    }),
  ).rejects.toBeInstanceOf(BotServiceConflictError);

  await store.disable(id);
  await expect(
    store.register({
      botId: id,
      displayName: "Third",
      kind: "builtin",
      capabilities: ["chat"],
    }),
  ).rejects.toBeInstanceOf(BotServiceConflictError);
});

test("concurrent registrations of one botId: exactly one wins", async () => {
  const id = botId("race");
  const results = await Promise.allSettled([
    store.register({
      botId: id,
      displayName: "A",
      kind: "external",
      capabilities: ["chat"],
    }),
    store.register({
      botId: id,
      displayName: "B",
      kind: "external",
      capabilities: ["chat"],
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected");
  expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
    BotServiceConflictError,
  );
});

test("registration writes no credentials and no grants", async () => {
  const before = await database.select({ n: count() }).from(credentials);
  await store.register({
    botId: botId("nocreds"),
    displayName: "No Credentials",
    kind: "external",
    capabilities: ["chat"],
  });
  const after = await database.select({ n: count() }).from(credentials);
  expect(after[0]?.n).toBe(before[0]?.n);
});

test("the table itself refuses what the store refuses", async () => {
  await database.insert(botServices).values({
    botId: botId("schema"),
    displayName: "Schema",
    kind: "builtin",
    capabilities: ["chat"],
  });
  expect(
    await violation(
      database
        .insert(botServices)
        .values({
          botId: botId("schema"),
          displayName: "Duplicate",
          kind: "builtin",
          capabilities: ["chat"],
        })
        .execute(),
    ),
  ).toEqual({ sqlState: "23505", constraint: "bot_services_pkey" });
  expect(
    await violation(
      database
        .insert(botServices)
        .values({
          botId: botId("schema"),
          displayName: "Bad kind",
          kind: "mystery" as never,
          capabilities: ["chat"],
        })
        .execute(),
    ),
  ).toEqual({ sqlState: "23514", constraint: "bot_services_kind_check" });
  expect(
    await violation(
      database
        .insert(botServices)
        .values({
          botId: botId("schema"),
          displayName: "Bad status",
          kind: "builtin",
          capabilities: ["chat"],
          status: "gone" as never,
        })
        .execute(),
    ),
  ).toEqual({ sqlState: "23514", constraint: "bot_services_status_check" });
  expect(
    await violation(
      database
        .insert(botServices)
        .values({
          botId: botId("schema"),
          displayName: "Bad capability",
          kind: "builtin",
          capabilities: ["telepathy"],
        })
        .execute(),
    ),
  ).toEqual({
    sqlState: "23514",
    constraint: "bot_services_capabilities_check",
  });
});

test("update changes the declaration, never the identity", async () => {
  const id = botId("edit");
  await store.register({
    botId: id,
    displayName: "Before",
    kind: "external",
    capabilities: ["chat"],
  });
  const updated = await store.update(id, {
    displayName: "After",
    capabilities: ["chat", "image"],
  });
  expect(updated).toMatchObject({
    botId: id,
    displayName: "After",
    kind: "external",
    capabilities: ["chat", "image"],
    status: "active",
  });
  await expect(
    store.update(botId("unknown"), { displayName: "No such bot" }),
  ).rejects.toBeInstanceOf(BotServiceNotFoundError);
});

test("disable is visible to every reader downstream, enable restores", async () => {
  const id = botId("lifecycle");
  await store.register({
    botId: id,
    displayName: "Lifecycle",
    kind: "external",
    capabilities: ["chat"],
  });
  const disabled = await store.disable(id);
  expect(disabled.status).toBe("disabled");
  // The two reads downstream (04.2 auth, 05.3 key issuance) actually make.
  expect((await store.getBotService(id))?.status).toBe("disabled");
  expect(
    (await store.listBotServices()).find((record) => record.botId === id)
      ?.status,
  ).toBe("disabled");
  // Disabling twice is the same state, not an error.
  expect((await store.disable(id)).status).toBe("disabled");
  const enabled = await store.enable(id);
  expect(enabled.status).toBe("active");
  expect((await store.getBotService(id))?.status).toBe("active");
  await expect(store.enable(botId("unknown"))).rejects.toBeInstanceOf(
    BotServiceNotFoundError,
  );
  await expect(store.disable(botId("unknown"))).rejects.toBeInstanceOf(
    BotServiceNotFoundError,
  );
});

test("unknown botIds read as null, not errors", async () => {
  expect(await store.getBotService(botId("missing"))).toBeNull();
});

test("malformed registrations are refused before any query", async () => {
  const cases: unknown[] = [
    { botId: "", displayName: "x", kind: "external", capabilities: ["chat"] },
    {
      botId: " padded ",
      displayName: "x",
      kind: "external",
      capabilities: ["chat"],
    },
    {
      botId: "UPPER",
      displayName: "x",
      kind: "external",
      capabilities: ["chat"],
    },
    {
      botId: `${"a".repeat(129)}`,
      displayName: "x",
      kind: "external",
      capabilities: ["chat"],
    },
    {
      botId: botId(),
      displayName: "",
      kind: "external",
      capabilities: ["chat"],
    },
    {
      botId: botId(),
      displayName: "x",
      kind: "unknown",
      capabilities: ["chat"],
    },
    { botId: botId(), displayName: "x", kind: "external", capabilities: [] },
    {
      botId: botId(),
      displayName: "x",
      kind: "external",
      capabilities: ["chat", "chat"],
    },
    {
      botId: botId(),
      displayName: "x",
      kind: "external",
      capabilities: "chat",
    },
    { botId: botId(), displayName: "x", kind: "external" },
    { displayName: "x", kind: "external", capabilities: ["chat"] },
  ];
  for (const input of cases) {
    await expect(store.register(input as never)).rejects.toBeInstanceOf(
      BotServiceInputError,
    );
  }
});

/**
 * The admin surface over the real store and the real audit trail: the route a deployment actually
 * mounts, writing the rows a reader of the trail actually sees.
 */
const admin: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "admin-person",
    email: "admin@example.com",
    role: "admin",
  } as never);
  await next();
};

test("an administrator's registration lands in the registry and on the trail", async () => {
  const app = botServiceAdminRoutes(admin, store, auditStore);
  const id = botId("route");
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      botId: id,
      displayName: "Routed",
      kind: "builtin",
      capabilities: ["chat"],
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    botService: Record<string, unknown>;
  };
  expect(body.botService).toMatchObject({
    botId: id,
    kind: "builtin",
    status: "active",
  });

  await store.disable(id);
  const disable = await app.request(`/${id}/disable`, { method: "POST" });
  expect(disable.status).toBe(200);

  const rows = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, id));
  expect(rows.map((row) => row.eventType).sort()).toEqual([
    "bot_service.disabled",
    "bot_service.registered",
  ]);
  for (const row of rows) {
    expect(row.actorUserId).toBe("admin-person");
    expect(row.targetType).toBe("bot_service");
  }
});
