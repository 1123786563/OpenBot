import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditReader } from "../src/audit";
import { createRoleRepository } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { auditEvents, userRoles, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * The Audit page's text search across the whole trail, asked of the database that answers it.
 *
 * The box used to filter only the rows already in the browser, so a word on an older page was never
 * found. `q` is a condition beside the columns already there, so it reaches every row the view
 * matches, not only the newest page. These drive the real reader rather than a stub, because a stub
 * cannot show that the SQL matches the stored text it is given.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const reader = createAuditReader(database);

const TARGET_TYPE = "audit_search_test";

function unique(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function seed(
  targetId: string,
  rows: { at: string; payload: Record<string, unknown> }[],
) {
  await database.insert(auditEvents).values(
    rows.map(({ at, payload }) => ({
      eventType: "configuration.changed",
      targetType: TARGET_TYPE,
      targetId,
      payload,
      createdAt: new Date(at),
    })),
  );
}

afterAll(async () => {
  await database.$client.close();
});

describe("the trail's text search", () => {
  test("finds a word on an older row that the newest page does not hold", async () => {
    const targetId = unique("search-older");
    await seed(targetId, [
      {
        at: "2026-01-01T00:00:00.000Z",
        payload: { note: "the needle word is here" },
      },
      { at: "2026-01-02T00:00:00.000Z", payload: { note: "one" } },
      { at: "2026-01-03T00:00:00.000Z", payload: { note: "two" } },
    ]);

    // The newest two rows do not mention "needle", so a search of loaded rows alone would miss it.
    const newest = await reader.list({ targetId, limit: 2 });
    expect(newest.events).toHaveLength(2);
    expect(
      newest.events.some((event) =>
        JSON.stringify(event.payload).includes("needle"),
      ),
    ).toBe(false);

    // Asked of the whole trail, the older row is found.
    const found = await reader.list({ targetId, limit: 2, q: "needle" });
    expect(found.events.map((event) => event.payload.note)).toEqual([
      "the needle word is here",
    ]);
  });

  test("every word must appear, so a phrase narrows to the rows carrying all of them", async () => {
    const targetId = unique("search-words");
    await seed(targetId, [
      { at: "2026-02-01T00:00:00.000Z", payload: { note: "alpha beta" } },
      { at: "2026-02-02T00:00:00.000Z", payload: { note: "alpha only" } },
      { at: "2026-02-03T00:00:00.000Z", payload: { note: "beta only" } },
    ]);

    const both = await reader.list({ targetId, limit: 10, q: "alpha beta" });
    expect(both.events.map((event) => event.payload.note)).toEqual([
      "alpha beta",
    ]);
  });

  test("matches the row's columns too, not only its payload", async () => {
    const targetId = unique("search-target");
    const otherId = unique("search-other");
    // The unique word is the target id, which lives in a column the payload does not hold. Both
    // rows share the type the query filters by, so only `q` can tell them apart.
    await seed(targetId, [{ at: "2026-03-01T00:00:00.000Z", payload: {} }]);
    await seed(otherId, [{ at: "2026-03-02T00:00:00.000Z", payload: {} }]);

    const found = await reader.list({
      targetType: TARGET_TYPE,
      limit: 10,
      q: targetId,
    });
    expect(found.events.map((event) => event.targetId)).toEqual([targetId]);
  });

  test("a word no row carries finds nothing", async () => {
    const targetId = unique("search-none");
    await seed(targetId, [
      { at: "2026-04-01T00:00:00.000Z", payload: { note: "hay" } },
    ]);

    const found = await reader.list({
      targetId,
      limit: 10,
      q: "zzz-no-such-word",
    });
    expect(found.events).toEqual([]);
  });

  test("% and _ are literal, so a search for them does not match everything", async () => {
    const targetId = unique("search-like");
    await seed(targetId, [
      { at: "2026-05-01T00:00:00.000Z", payload: { note: "100%" } },
      { at: "2026-05-02T00:00:00.000Z", payload: { note: "plain" } },
    ]);

    const percent = await reader.list({ targetId, limit: 10, q: "100%" });
    expect(percent.events.map((event) => event.payload.note)).toEqual(["100%"]);
  });
});

test("Audit lists and exports the same older match and honors a role downgrade", async () => {
  const id = unique("audit-admin");
  const user = { id, email: `${id}@openbot.test` };
  const targetId = unique("audit-http-search");
  const term = "papertrail";
  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user }) },
    },
    createRoleRepository(database),
    reader,
  );

  const path = `/api/admin/audit-events?targetId=${targetId}&limit=1`;
  const search = `${path}&q=${term}`;
  const exportUrl = `${search}&format=csv`;
  try {
    await database
      .insert(users)
      .values({ ...user, name: "Audit administrator" });
    await database.insert(userRoles).values({ userId: id, role: "admin" });
    await seed(targetId, [
      { at: "2026-06-01T00:00:00Z", payload: { note: term } },
      { at: "2026-06-02T00:00:00Z", payload: { note: "newest-other-row" } },
    ]);

    const newest = await app.request(path);
    expect(newest.status).toBe(200);
    const page = await newest.text();
    expect(page).toContain("newest-other-row");
    expect(page).not.toContain(term);

    const matching = await app.request(search);
    expect(matching.status).toBe(200);
    const json = await matching.text();
    expect(json).toContain(term);
    expect(json).not.toContain("newest-other-row");

    const exported = await app.request(exportUrl);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/csv");
    const csv = await exported.text();
    expect(csv).toContain(term);
    expect(csv).not.toContain("newest-other-row");

    await database
      .update(userRoles)
      .set({ role: "user" })
      .where(eq(userRoles.userId, id));
    for (const route of [search, exportUrl]) {
      const denied = await app.request(route);
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain(term);
    }
  } finally {
    await database.delete(users).where(eq(users.id, id));
  }
});
