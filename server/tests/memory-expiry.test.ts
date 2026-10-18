import { afterAll, beforeAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { personalMemories } from "../src/db/schema/memory";
import { createMemoryStore } from "../src/memory/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `expiry-${randomUUID()}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
const store = createMemoryStore(database);

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await database.insert(users).values({
    id: owner,
    email: `${owner}@example.test`,
  });
  await database.insert(agents).values({
    id: bot,
    name: "Expiry Bot",
    type: "built_in",
    configuration: {},
  });
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner]));
  await database.delete(agents).where(inArray(agents.id, [bot]));
  await database.$client.close();
});

async function insert(values: {
  id: string;
  content: string;
  reviewState: "unreviewed" | "confirmed" | "edited";
  updatedAt: Date;
  formedBy?: "person" | "import" | "bot";
  deletedAt?: Date | null;
}) {
  await database.insert(personalMemories).values({
    ownerUserId: owner,
    provenance: "Test fixture",
    ...(values.formedBy === "bot" ? { formedByAgentId: bot } : {}),
    ...values,
  });
}
async function rowOf(id: string) {
  const [row] = await database
    .select()
    .from(personalMemories)
    .where(eq(personalMemories.id, id));
  return row;
}

test("expiry tombstones only unhandled candidates past 30 days", async () => {
  const now = new Date();
  const stale = new Date(now.getTime() - THIRTY_DAYS - 60_000);
  const staleCandidate = randomUUID();
  const freshCandidate = randomUUID();
  const oldConfirmed = randomUUID();
  const oldEdited = randomUUID();
  const oldDeletedCandidate = randomUUID();
  await insert({
    id: staleCandidate,
    content: "Stale unreviewed candidate",
    reviewState: "unreviewed",
    updatedAt: stale,
    formedBy: "bot",
  });
  await insert({
    id: freshCandidate,
    content: "Fresh unreviewed candidate",
    reviewState: "unreviewed",
    updatedAt: now,
    formedBy: "bot",
  });
  await insert({
    id: oldConfirmed,
    content: "Confirmed memory nobody touched for months",
    reviewState: "confirmed",
    updatedAt: stale,
  });
  await insert({
    id: oldEdited,
    content: "Edited memory nobody touched for months",
    reviewState: "edited",
    updatedAt: stale,
  });
  await insert({
    id: oldDeletedCandidate,
    content: "",
    reviewState: "unreviewed",
    updatedAt: stale,
    formedBy: "bot",
    deletedAt: stale,
  });

  expect(await store.expireStaleCandidates(now)).toBe(1);

  const expired = await rowOf(staleCandidate);
  expect(expired?.deletedAt).toEqual(now);
  expect(expired?.enabled).toBe(false);
  expect(expired?.content).toBe("");
  expect(expired?.reviewState).toBe("unreviewed");
  // A candidate still in its window, and every reviewed memory, are untouched.
  const fresh = await rowOf(freshCandidate);
  expect(fresh?.deletedAt).toBeNull();
  expect(fresh?.content).toBe("Fresh unreviewed candidate");
  const confirmed = await rowOf(oldConfirmed);
  expect(confirmed?.deletedAt).toBeNull();
  expect(confirmed?.content).toBe("Confirmed memory nobody touched for months");
  expect(confirmed?.reviewState).toBe("confirmed");
  const edited = await rowOf(oldEdited);
  expect(edited?.deletedAt).toBeNull();
  expect(edited?.content).toBe("Edited memory nobody touched for months");
  const alreadyDeleted = await rowOf(oldDeletedCandidate);
  expect(alreadyDeleted?.deletedAt).toEqual(stale);
});

test("repeated expiry runs delete nothing more and are safe to schedule often", async () => {
  const now = new Date();
  const stale = new Date(now.getTime() - THIRTY_DAYS - 3_600_000);
  const candidate = randomUUID();
  await insert({
    id: candidate,
    content: "Another stale candidate",
    reviewState: "unreviewed",
    updatedAt: stale,
    formedBy: "bot",
  });
  expect(await store.expireStaleCandidates(now)).toBe(1);
  expect(await store.expireStaleCandidates(now)).toBe(0);
  expect(
    await store.expireStaleCandidates(new Date(now.getTime() + 3_600_000)),
  ).toBe(0);
  expect((await rowOf(candidate))?.deletedAt).toEqual(now);
});

test("an expired candidate leaves the person's list and cannot be re-formed", async () => {
  const content = `Expired observation ${randomUUID()}`;
  const formed = await store.formMemory(owner, {
    agentId: bot,
    content,
    sourceApp: "Docs",
    sourceRef: `${prefix}/read_documents`,
  });
  const now = new Date();
  await database
    .update(personalMemories)
    .set({ updatedAt: new Date(now.getTime() - THIRTY_DAYS - 60_000) })
    .where(eq(personalMemories.id, formed.id));
  expect(await store.expireStaleCandidates(now)).toBe(1);
  expect((await store.list(owner)).some((row) => row.id === formed.id)).toBe(
    false,
  );
  // Reading the same record again tomorrow does not resurrect it, the way forgetting does not.
  const again = await store.formMemory(owner, {
    agentId: bot,
    content,
    sourceApp: "Docs",
    sourceRef: `${prefix}/read_documents`,
  });
  expect(again).toEqual({
    id: formed.id,
    duplicate: true,
    forgotten: true,
  });
});
