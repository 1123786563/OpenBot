import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { personalMemories } from "../src/db/schema/memory";
import { createMemoryStore } from "../src/memory/store";
import { MemoryNotFoundError } from "../src/memory/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Hindsight 18 (#395), the exit contract: the CopilotKit Intelligence personal-memory path is
 * gone, and these are the behaviors its removal promises.
 *
 * 1. The ids the old dual authority issued — the `intelligence:` prefixed ids it synthesized for
 *    memories only Intelligence held — resolve to nothing: not editable, not forgettable, not
 *    listed. Nothing offers to migrate or export such content; the person accepted dropping it.
 * 2. The mirroring surface is gone with the path: no `mirrorPending` for a sweep to call, and a
 *    write's effect is the row alone — there is no second authority to keep in step.
 * 3. What the exit must NOT change: confirmed OpenBot content recalls exactly as before, a
 *    candidate is invisible to every Bot-side path until the person's own stored confirmation,
 *    a Bot-formed memory stays with its Bot, and pausing or forgetting acts on the rows alone.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `memexit-${randomUUID()}`;
const ada = `${prefix}-ada`;
const bot = `${prefix}-bot`;
const otherBot = `${prefix}-other-bot`;
const store = createMemoryStore(database);

beforeAll(async () => {
  await database
    .insert(users)
    .values([{ id: ada, email: `${ada}@example.test` }]);
  await database.insert(agents).values([
    { id: bot, name: "Bot", type: "built_in", configuration: {} },
    { id: otherBot, name: "Other", type: "built_in", configuration: {} },
  ]);
});
beforeEach(async () => {
  await database
    .delete(personalMemories)
    .where(inArray(personalMemories.ownerUserId, [ada]));
});
afterAll(async () => {
  await database
    .delete(personalMemories)
    .where(inArray(personalMemories.ownerUserId, [ada]));
  await database.delete(agents).where(inArray(agents.id, [bot, otherBot]));
  await database.delete(users).where(inArray(users.id, [ada]));
  await database.$client.end();
});

test("an intelligence: id resolves to nothing: not listed, not editable, not forgettable", async () => {
  const kept = await store.create(ada, { content: "Prefers morning meetings" });
  const listed = await store.list(ada);
  // The list is the rows and only the rows; an Intelligence-only memory has no row, so it cannot
  // appear, and there is no code left that could synthesize one.
  expect(listed.map((memory) => memory.id)).toEqual([kept.id]);

  await expect(
    store.update(ada, "intelligence:int-7", { content: "Anything at all" }),
  ).rejects.toBeInstanceOf(MemoryNotFoundError);
  await expect(
    store.update(ada, "intelligence:int-7", { enabled: false }),
  ).rejects.toBeInstanceOf(MemoryNotFoundError);
  await expect(store.remove(ada, "intelligence:int-7")).rejects.toBeInstanceOf(
    MemoryNotFoundError,
  );
  // The refusal touched nothing.
  expect((await store.list(ada)).map((memory) => memory.content)).toEqual([
    "Prefers morning meetings",
  ]);
});

test("the mirroring surface is gone: nothing to sweep, and a write's effect is the row alone", async () => {
  expect((store as Record<string, unknown>).mirrorPending).toBeUndefined();

  const memory = await store.create(ada, { content: "Lives in Lisbon" });
  expect((await store.list(ada)).map((m) => m.content)).toEqual([
    "Lives in Lisbon",
  ]);
  const recalled = await store.retrieve(ada, [], "lisbon");
  expect(recalled.map((m) => m.id)).toEqual([memory.id]);
});

test("confirmed content and the review gate behave exactly as before the exit", async () => {
  const confirmed = await store.create(ada, { content: "Runs on Thursdays" });
  const candidate = await store.formMemory(ada, {
    agentId: bot,
    content: "Owns the billing migration",
    sourceApp: "Linear",
  });
  // A candidate is invisible on every Bot-side path until the person's own confirmation — the
  // reviewState the row stores is the only thing that can promote it, and nothing forges one.
  const before = await store.retrieve(ada, [], "", {
    botId: bot,
    heldServerIds: new Set(),
  });
  expect(before.map((m) => m.id)).toEqual([confirmed.id]);
  expect((await store.list(ada)).map((m) => m.reviewState).sort()).toEqual([
    "confirmed",
    "unreviewed",
  ]);

  await store.update(ada, candidate.id, { reviewState: "confirmed" });
  const forBot = await store.retrieve(ada, [], "", {
    botId: bot,
    heldServerIds: new Set(),
  });
  expect(forBot.map((m) => m.id).sort()).toEqual(
    [candidate.id, confirmed.id].sort(),
  );
  // A Bot-formed memory stays with the Bot that formed it.
  const forOther = await store.retrieve(ada, [], "", {
    botId: otherBot,
    heldServerIds: new Set(),
  });
  expect(forOther.map((m) => m.id)).toEqual([confirmed.id]);
});

test("pausing and forgetting act on the rows alone", async () => {
  const memory = await store.create(ada, { content: "Speaks Portuguese" });
  await store.update(ada, memory.id, { enabled: false });
  expect(await store.retrieve(ada, [], "portuguese")).toEqual([]);
  expect((await store.list(ada)).map((m) => m.enabled)).toEqual([false]);

  await store.remove(ada, memory.id);
  expect(await store.list(ada)).toEqual([]);
  expect(await store.retrieve(ada, [], "portuguese")).toEqual([]);
});
