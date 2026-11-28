import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, auditEvents, users } from "../src/db/schema/core";
import { defaultOptOuts } from "../src/db/schema/defaults";
import { memorySources, personalMemories } from "../src/db/schema/memory";
import {
  createIntelligenceMemory,
  type IntelligenceMemoryClient,
} from "../src/memory/intelligence";
import { createMemoryRoutes } from "../src/memory/routes";
import { createMemoryStore } from "../src/memory/store";
import {
  MemoryNotFoundError,
  MemoryRefusedError,
  MemoryUnavailableError,
} from "../src/memory/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A stand-in for CopilotKit Intelligence memory: memories per user, retired rather than deleted,
 * project-scoped rows that must never reach a person, and switches for "not entitled" and
 * "unreachable". Every call is recorded so a test can assert who was asked about what.
 */
function fakeIntelligence() {
  type Row = {
    id: string;
    userId: string;
    scope: "user" | "project";
    content: string;
    invalidatedAt: string | null;
  };
  const rows: Row[] = [];
  const calls: { method: string; userId?: string; grant?: unknown }[] = [];
  const state = { entitled: true, down: false, failRemove: false };
  let next = 1;
  const fail = (status: number) =>
    Object.assign(new Error(`HTTP ${status}`), { status });
  const guard = () => {
    if (state.down) throw new TypeError("fetch failed");
    if (!state.entitled) throw fail(403);
  };
  const summary = (row: Row) => ({
    id: row.id,
    kind: "topical",
    scope: row.scope,
    content: row.content,
    sourceThreadIds: [],
    invalidatedAt: row.invalidatedAt,
  });
  const client = {
    async getRuntimeEntitlements() {
      calls.push({ method: "getRuntimeEntitlements" });
      if (state.down) throw new TypeError("fetch failed");
      return {
        status: "ready",
        entitlement: {
          active: true,
          source: "managedOrgSubscription",
          features: { memory: state.entitled },
          limits: {},
        },
      };
    },
    async listMemories(params: { userId: string; memoryGrant?: unknown }) {
      calls.push({
        method: "listMemories",
        userId: params.userId,
        grant: params.memoryGrant,
      });
      guard();
      // A platform that ignored the grant: project rows come back too, and must be filtered out.
      return {
        memories: rows
          .filter(
            (row) =>
              !row.invalidatedAt &&
              (row.userId === params.userId || row.scope === "project"),
          )
          .map(summary),
      };
    },
    async recallMemories(params: {
      userId: string;
      query: string;
      memoryGrant?: unknown;
    }) {
      calls.push({
        method: "recallMemories",
        userId: params.userId,
        grant: params.memoryGrant,
      });
      guard();
      return {
        memories: rows
          .filter(
            (row) =>
              !row.invalidatedAt &&
              (row.userId === params.userId || row.scope === "project") &&
              row.content.toLowerCase().includes(params.query.toLowerCase()),
          )
          .map((row) => ({ ...summary(row), score: 0.9 })),
      };
    },
    async createMemory(params: {
      userId: string;
      content: string;
      memoryGrant?: unknown;
    }) {
      calls.push({
        method: "createMemory",
        userId: params.userId,
        grant: params.memoryGrant,
      });
      guard();
      const row: Row = {
        id: `int-${next++}`,
        userId: params.userId,
        scope: "user",
        content: params.content,
        invalidatedAt: null,
      };
      rows.push(row);
      return { ...summary(row), absorbed: false };
    },
    async updateMemory(params: {
      userId: string;
      id: string;
      content: string;
      memoryGrant?: unknown;
    }) {
      calls.push({ method: "updateMemory", userId: params.userId });
      guard();
      const old = rows.find(
        (row) =>
          row.id === params.id &&
          row.userId === params.userId &&
          !row.invalidatedAt,
      );
      if (!old) throw fail(404);
      old.invalidatedAt = new Date().toISOString();
      const row: Row = {
        id: `int-${next++}`,
        userId: params.userId,
        scope: "user",
        content: params.content,
        invalidatedAt: null,
      };
      rows.push(row);
      return { ...summary(row), retiredId: old.id };
    },
    async removeMemory(params: { userId: string; id: string }) {
      calls.push({ method: "removeMemory", userId: params.userId });
      guard();
      // Reachable, but one retirement fails: a copy is left out there to be tried again.
      if (state.failRemove) throw fail(500);
      const row = rows.find(
        (candidate) =>
          candidate.id === params.id &&
          candidate.userId === params.userId &&
          !candidate.invalidatedAt,
      );
      if (!row) throw fail(404);
      row.invalidatedAt = new Date().toISOString();
    },
  };
  const live = (userId: string) =>
    rows.filter((row) => row.userId === userId && !row.invalidatedAt);
  const seed = (
    userId: string,
    content: string,
    scope: Row["scope"] = "user",
  ) => {
    const row: Row = {
      id: `int-${next++}`,
      userId,
      scope,
      content,
      invalidatedAt: null,
    };
    rows.push(row);
    return row.id;
  };
  return {
    client: client as unknown as IntelligenceMemoryClient,
    calls,
    state,
    live,
    seed,
  };
}

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `memint-${randomUUID()}`;
const ada = `${prefix}-ada`;
const grace = `${prefix}-grace`;
const bot = `${prefix}-bot`;
const otherBot = `${prefix}-other-bot`;

let fake: ReturnType<typeof fakeIntelligence>;
let clock = 1_000_000;
let store: ReturnType<typeof createMemoryStore>;

beforeAll(async () => {
  await database.insert(users).values([
    { id: ada, email: `${ada}@example.test` },
    { id: grace, email: `${grace}@example.test` },
  ]);
  await database.insert(agents).values([
    { id: bot, name: "Bot", type: "built_in", configuration: {} },
    { id: otherBot, name: "Other", type: "built_in", configuration: {} },
  ]);
});
beforeEach(async () => {
  await database
    .delete(personalMemories)
    .where(inArray(personalMemories.ownerUserId, [ada, grace]));
  await database
    .delete(memorySources)
    .where(inArray(memorySources.ownerUserId, [ada, grace]));
  await database
    .delete(defaultOptOuts)
    .where(inArray(defaultOptOuts.ownerUserId, [ada, grace]));
  fake = fakeIntelligence();
  clock += 10 * 60_000 + 1;
  store = createMemoryStore(database, {
    intelligence: createIntelligenceMemory({
      client: fake.client,
      now: () => clock,
      log: () => {},
    }),
  });
});
afterAll(async () => {
  await database
    .delete(personalMemories)
    .where(inArray(personalMemories.ownerUserId, [ada, grace]));
  await database
    .delete(memorySources)
    .where(inArray(memorySources.ownerUserId, [ada, grace]));
  await database
    .delete(defaultOptOuts)
    .where(inArray(defaultOptOuts.ownerUserId, [ada, grace]));
  await database.delete(agents).where(inArray(agents.id, [bot, otherBot]));
  await database.delete(users).where(inArray(users.id, [ada, grace]));
  await database.$client.end();
});

const rowOf = async (id: string) =>
  (
    await database
      .select()
      .from(personalMemories)
      .where(eq(personalMemories.id, id))
  )[0];

test("a memory the person writes is stored in Intelligence, under that person only", async () => {
  const memory = await store.create(ada, {
    content: "Prefers morning meetings",
  });
  const row = await rowOf(memory.id);
  expect(row?.intelligenceMemoryId).toBeTruthy();
  expect(fake.live(ada).map((m) => m.content)).toEqual([
    "Prefers morning meetings",
  ]);
  expect(fake.live(grace)).toEqual([]);
  const writes = fake.calls.filter((call) => call.method === "createMemory");
  expect(writes.every((call) => call.userId === ada)).toBe(true);
  expect(writes[0]?.grant).toEqual({ user: "read-write", project: "none" });
});

test("an edit supersedes the Intelligence copy, and pausing or forgetting retires it", async () => {
  const memory = await store.create(ada, { content: "Lives in Lisbon" });
  const first = (await rowOf(memory.id))?.intelligenceMemoryId;
  await store.update(ada, memory.id, { content: "Lives in Porto" });
  const edited = await rowOf(memory.id);
  expect(edited?.intelligenceMemoryId).not.toBe(first);
  expect(fake.live(ada).map((m) => m.content)).toEqual(["Lives in Porto"]);

  await store.update(ada, memory.id, { enabled: false });
  expect(fake.live(ada)).toEqual([]);
  expect((await rowOf(memory.id))?.intelligenceMemoryId).toBeNull();

  await store.update(ada, memory.id, { enabled: true });
  expect(fake.live(ada).map((m) => m.content)).toEqual(["Lives in Porto"]);

  await store.remove(ada, memory.id);
  expect(fake.live(ada)).toEqual([]);
});

test("a Bot-formed memory reaches Intelligence only once the person confirms it", async () => {
  const formed = await store.formMemory(ada, {
    agentId: bot,
    content: "Owns the billing migration",
    sourceApp: "Linear",
  });
  expect(fake.live(ada)).toEqual([]);
  await store.update(ada, formed.id, { reviewState: "confirmed" });
  expect(fake.live(ada).map((m) => m.content)).toEqual([
    "Owns the billing migration",
  ]);
});

test("not entitled: nothing is sent, the tables are the whole store, and nothing fails", async () => {
  fake.state.entitled = false;
  const memory = await store.create(ada, { content: "Allergic to peanuts" });
  expect((await rowOf(memory.id))?.intelligenceMemoryId).toBeNull();
  expect(fake.calls.some((call) => call.method === "createMemory")).toBe(false);
  expect((await store.list(ada)).map((m) => m.content)).toEqual([
    "Allergic to peanuts",
  ]);
  const recalled = await store.retrieve(ada, [], "peanuts");
  expect(recalled.map((m) => m.content)).toEqual(["Allergic to peanuts"]);
});

test("unreachable: writes stay local and the next pass backfills them once, without duplicates", async () => {
  fake.state.down = true;
  const memory = await store.create(ada, { content: "Reports to Grace" });
  expect((await rowOf(memory.id))?.intelligenceMemoryId).toBeNull();
  expect((await store.list(ada)).map((m) => m.content)).toEqual([
    "Reports to Grace",
  ]);

  fake.state.down = false;
  clock += 61_000;
  expect(await store.mirrorPending()).toBeGreaterThan(0);
  expect(fake.live(ada).map((m) => m.content)).toEqual(["Reports to Grace"]);
  await store.mirrorPending();
  expect(fake.live(ada)).toHaveLength(1);
});

test("another person's Intelligence memories never reach this person, nor do project-wide ones", async () => {
  fake.seed(grace, "Grace's private fact");
  fake.seed(grace, "Shared across the project", "project");
  const own = fake.seed(ada, "Ada likes tea");
  const listed = await store.list(ada);
  expect(listed.map((m) => m.content)).toEqual(["Ada likes tea"]);
  expect(listed[0]?.id).toBe(`intelligence:${own}`);
  expect(listed[0]?.formedBy).toBe("intelligence");
  const recalled = await store.retrieve(ada, [], "fact");
  expect(recalled).toEqual([]);
  expect(
    fake.calls
      .filter((call) => call.userId !== undefined)
      .every((call) => call.userId === ada),
  ).toBe(true);
});

test("recall keeps a Bot-formed memory to the Bot that formed it", async () => {
  const formed = await store.formMemory(ada, {
    agentId: bot,
    content: "Deploy window is Thursday",
    sourceApp: "Calendar",
    sourceRef: "calendar/read",
  });
  await store.update(ada, formed.id, { reviewState: "confirmed" });
  const forBot = await store.retrieve(ada, [], "deploy", {
    botId: bot,
    heldSourceRefs: new Set(["calendar/read"]),
  });
  expect(forBot.map((m) => m.id)).toEqual([formed.id]);
  const forOther = await store.retrieve(ada, [], "deploy", {
    botId: otherBot,
    heldSourceRefs: new Set(["calendar/read"]),
  });
  expect(forOther).toEqual([]);
});

test("a memory only Intelligence holds is the person's own: recalled, edited and forgotten here", async () => {
  const id = fake.seed(ada, "Uses vim keybindings");
  const context = await store.retrieve(ada, [], "");
  expect(context.map((m) => m.content)).toContain("Uses vim keybindings");
  const edited = await store.update(ada, `intelligence:${id}`, {
    content: "Uses emacs keybindings",
  });
  expect(fake.live(ada).map((m) => m.content)).toEqual([
    "Uses emacs keybindings",
  ]);
  await expect(
    store.update(ada, edited.id, { enabled: false }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  await store.remove(ada, edited.id);
  expect(fake.live(ada)).toEqual([]);
  // A forget the person asked for, on the trail like any other. The edit above has its own row for
  // the same memory, and the fake's memory ids are the same in every run, so the forget's rows for
  // this person are the ones read.
  const forgotten = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorUserId, ada),
        eq(auditEvents.targetType, "personal_memory"),
        eq(auditEvents.targetId, edited.id),
        sql`${auditEvents.payload}->>'change' = 'memory_deleted'`,
      ),
    );
  expect(forgotten.map((row) => [row.payload.change, row.actorUserId])).toEqual(
    [["memory_deleted", ada]],
  );
  expect(JSON.stringify(forgotten)).not.toContain("emacs keybindings");
});

test("a memory OpenBot describes cannot be forgotten through its Intelligence id", async () => {
  const memory = await store.create(ada, { content: "Has a dog" });
  const linked = (await rowOf(memory.id))?.intelligenceMemoryId;
  await expect(
    store.remove(ada, `intelligence:${linked}`),
  ).rejects.toBeInstanceOf(MemoryNotFoundError);
  expect(fake.live(ada)).toHaveLength(1);
});

test("editing an Intelligence-only memory while Intelligence is down answers unavailable, not a crash", async () => {
  const id = fake.seed(ada, "Speaks Portuguese");
  fake.state.down = true;
  clock += 10 * 60_000 + 1;
  await expect(
    store.update(ada, `intelligence:${id}`, { content: "Speaks Spanish" }),
  ).rejects.toBeInstanceOf(MemoryUnavailableError);
});

/**
 * A source whose imported fact has been accepted, so Intelligence holds a copy of it.
 *
 * The copy is the whole point: removing the source cascades the local row away, and a row that is
 * gone cannot be retried. Anything left in Intelligence is then read back as the person's own and
 * reaches every Bot of theirs, which is wider than the source ever was.
 */
async function sourceWithMirroredImport(owner: string) {
  const source = await store.createSource(owner, {
    agentId: bot,
    toolRef: "drive/search",
    title: "Receipts folder",
  });
  await store.completeSync(owner, source.id, [
    {
      externalId: "doc-1",
      digest: "digest-1",
      content: "The launch is in May",
      provenance: "Roadmap",
    },
  ]);
  const [row] = await database
    .select()
    .from(personalMemories)
    .where(eq(personalMemories.sourceId, source.id));
  if (!row) throw new Error("The imported fixture row is missing.");
  await store.update(owner, row.id, { reviewState: "confirmed" });
  const mirrored = await rowOf(row.id);
  if (!mirrored?.intelligenceMemoryId)
    throw new Error("The fixture was not mirrored to Intelligence.");
  return { source, row: mirrored };
}

const removalAudit = (owner: string, sourceId: string) =>
  database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorUserId, owner),
        eq(auditEvents.targetType, "memory_source"),
        eq(auditEvents.targetId, sourceId),
      ),
    );

test("removing a source while Intelligence is unreachable keeps the source and its memories", async () => {
  const { source, row } = await sourceWithMirroredImport(ada);
  fake.state.down = true;
  clock += 10 * 60_000 + 1;

  await expect(store.removeSource(ada, source.id)).rejects.toBeInstanceOf(
    MemoryUnavailableError,
  );

  // Nothing was removed: the source, the local row and its Intelligence link all stand.
  expect(await store.sources(ada)).toHaveLength(1);
  expect((await rowOf(row.id))?.intelligenceMemoryId).toBe(
    row.intelligenceMemoryId,
  );
  expect(fake.live(ada).map((memory) => memory.content)).toEqual([
    "The launch is in May",
  ]);
  expect(await removalAudit(ada, source.id)).toEqual([]);
});

test("a retirement that fails leaves the source in place, and retrying finishes without orphan copies", async () => {
  const { source, row } = await sourceWithMirroredImport(ada);
  fake.state.failRemove = true;

  await expect(store.removeSource(ada, source.id)).rejects.toBeInstanceOf(
    MemoryUnavailableError,
  );
  expect(await store.sources(ada)).toHaveLength(1);
  expect((await rowOf(row.id))?.intelligenceMemoryId).toBe(
    row.intelligenceMemoryId,
  );
  expect(fake.live(ada)).toHaveLength(1);

  fake.state.failRemove = false;
  await store.removeSource(ada, source.id);

  expect(await store.sources(ada)).toEqual([]);
  expect(await rowOf(row.id)).toBeUndefined();
  // No orphan: nothing is left in Intelligence for this person to reach through another Bot.
  expect(fake.live(ada)).toEqual([]);
  expect(await store.list(ada)).toEqual([]);
  expect(await removalAudit(ada, source.id)).toHaveLength(1);
});

test("removing a source writes exactly one removal Audit row, with its opt-out", async () => {
  const { source, row } = await sourceWithMirroredImport(ada);

  await store.removeSource(ada, source.id);

  const events = await removalAudit(ada, source.id);
  expect(events).toHaveLength(1);
  expect(events[0]?.eventType).toBe("configuration.changed");
  expect(events[0]?.payload).toMatchObject({ change: "memory_source_removed" });
  // The fact's own words never reach the trail.
  expect(JSON.stringify(events)).not.toContain("The launch is in May");
  expect(fake.live(ada)).toEqual([]);
  expect(await rowOf(row.id)).toBeUndefined();
  expect(
    await database
      .select()
      .from(defaultOptOuts)
      .where(eq(defaultOptOuts.ownerUserId, ada)),
  ).toMatchObject([{ agentId: bot, feature: "memory_source", scope: "drive" }]);
});

test("a source with no Intelligence copies is removed while Intelligence is unreachable", async () => {
  const source = await store.createSource(ada, {
    agentId: bot,
    toolRef: "drive/search",
    title: "Unreviewed folder",
  });
  await store.completeSync(ada, source.id, [
    {
      externalId: "doc-2",
      digest: "digest-2",
      content: "Still awaiting review",
      provenance: "Notes",
    },
  ]);
  fake.state.down = true;
  clock += 10 * 60_000 + 1;

  // Nothing was mirrored, so there is nothing to retire and no reason to refuse.
  await store.removeSource(ada, source.id);

  expect(await store.sources(ada)).toEqual([]);
  expect(await removalAudit(ada, source.id)).toHaveLength(1);
});

/*
 * The same removal through the route the browser calls, because the confirmation's Try again only
 * works if the refusal arrives as a retryable 503 rather than a 500 or a silent 204.
 */
test("the removal route answers 503 while copies remain, and 204 once a retry retires them", async () => {
  const { source, row } = await sourceWithMirroredImport(ada);
  const routes = createMemoryRoutes(
    store,
    {} as never,
    async (context, next) => {
      context.set("actor", { id: ada, email: `${ada}@example.test` } as never);
      await next();
    },
  );
  const remove = () =>
    routes.request(`/sources/${source.id}`, { method: "DELETE" });

  fake.state.failRemove = true;
  const refused = await remove();
  expect(refused.status).toBe(503);
  expect(await store.sources(ada)).toHaveLength(1);
  expect((await rowOf(row.id))?.intelligenceMemoryId).toBe(
    row.intelligenceMemoryId,
  );

  fake.state.failRemove = false;
  expect((await remove()).status).toBe(204);
  expect(await store.sources(ada)).toEqual([]);
  expect(fake.live(ada)).toEqual([]);
  expect(await removalAudit(ada, source.id)).toHaveLength(1);
});
