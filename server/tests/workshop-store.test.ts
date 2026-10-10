import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { agents, channels, users } from "../src/db/schema/core";
import { workshopSessions } from "../src/db/schema/workshop";
import { createWorkshopStore, newWorkshopId } from "../src/workshop/store";

/*
 * Row-level behaviour needs the four workshop tables, which migration 0066 creates — the test
 * database carries the whole chain (0000→0066), the same assumption the code-run store's suite
 * makes about 0062. FK targets (user/bot/channel) are seeded minimally but legitimately: real
 * rows in their real tables, deleted again in `afterAll` before the pool closes.
 */

describe("newWorkshopId", () => {
  test("ids are prefixed, fixed-length hex, distinct per call", () => {
    for (const prefix of ["ws", "wt", "we", "wa"] as const) {
      const id = newWorkshopId(prefix);
      expect(id).toMatch(new RegExp(`^${prefix}-[0-9a-f]{24}$`));
      expect(newWorkshopId(prefix)).not.toBe(id);
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("workshop store", () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const store = createWorkshopStore(database);
  const run = randomUUID().slice(0, 8);

  const channelId = `ch-${run}`;
  const botId = `bot-${run}`;
  const ownerUserId = `user-${run}`;
  let sessionId = "";

  afterAll(async () => {
    // workshop rows cascade from the session; the session row itself is deleted first so the
    // channel/bot/user deletes below cannot be blocked by a dangling reference.
    await database.delete(workshopSessions).where(eq(workshopSessions.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
    await database.delete(agents).where(eq(agents.id, botId));
    await database.delete(users).where(eq(users.id, ownerUserId));
    await database.$client.close();
  });

  async function seedFkRows() {
    await database.insert(users).values({
      id: ownerUserId,
      email: `${run}@workshop-test.invalid`,
      name: "workshop store test",
    });
    await database.insert(agents).values({
      id: botId,
      name: "workshop test bot",
      type: "remote_ag_ui",
      configuration: {},
    });
    await database.insert(channels).values({
      id: channelId,
      name: "workshop test channel",
      description: "created by workshop-store.test.ts",
    });
  }

  test("getOrCreateSession is idempotent per channel", async () => {
    await seedFkRows();
    const first = await store.getOrCreateSession({ channelId, botId, ownerUserId });
    const second = await store.getOrCreateSession({ channelId, botId, ownerUserId });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("active");
    expect(second.visibility).toBe("private");
    sessionId = first.id;
  });

  test("enqueueTurn takes consecutive turn indexes; markRunning only from queued", async () => {
    const t1 = await store.enqueueTurn({ sessionId, prompt: "第一轮" });
    const t2 = await store.enqueueTurn({ sessionId, prompt: "第二轮" });
    expect(t1.turnIndex).toBe(0);
    expect(t2.turnIndex).toBe(1);

    expect(await store.markRunning(t1.id)).toBe(true);
    // A second writer on a row already running: the queued guard is gone, nothing updates.
    expect(await store.markRunning(t1.id)).toBe(false);
    expect((await store.getTurn(t1.id))?.status).toBe("running");
  });

  test("settle transitions are guarded by the current status", async () => {
    const queued = await store.enqueueTurn({ sessionId, prompt: "取消路径" });
    expect(await store.markCancelled(queued.id)).toBe(true);
    // Already terminal: a late failure write must not resurrect or overwrite it.
    expect(await store.markFailed(queued.id, "late")).toBe(false);

    const running = await store.enqueueTurn({ sessionId, prompt: "失败路径" });
    await store.markRunning(running.id);
    expect(await store.markFailed(running.id, "gateway refused")).toBe(true);
    expect(await store.markSucceeded(running.id, {})).toBe(false);

    const ok = await store.enqueueTurn({ sessionId, prompt: "成功路径" });
    await store.markRunning(ok.id);
    expect(
      await store.markSucceeded(ok.id, { usage: { inputTokens: 3, outputTokens: 5 } }),
    ).toBe(true);
    const settled = await store.getTurn(ok.id);
    expect(settled?.status).toBe("succeeded");
    expect((settled?.usage as { inputTokens?: number }).inputTokens).toBe(3);
  });

  test("heartbeat updates the runner liveness column", async () => {
    const turn = await store.enqueueTurn({ sessionId, prompt: "心跳" });
    await store.markRunning(turn.id);
    const at = new Date("2026-01-01T00:00:00Z");
    await store.heartbeat(turn.id, at);
    expect((await store.getTurn(turn.id))?.runnerHeartbeatAt?.toISOString()).toBe(
      at.toISOString(),
    );
  });

  test("recoverStale settles only quiet running turns, exactly once", async () => {
    const stale = await store.enqueueTurn({ sessionId, prompt: "stale" });
    await store.markRunning(stale.id, new Date(0));

    const fresh = await store.enqueueTurn({ sessionId, prompt: "fresh" });
    await store.markRunning(fresh.id, new Date(10 * 60 * 1000));

    const now = 12 * 60 * 1000; // fresh's heartbeat is 2 minutes old, stale's is 12 minutes
    const settled = await store.recoverStale(now, 5 * 60 * 1000);
    expect(settled.map((s) => s.turnId)).toContain(stale.id);
    expect(settled.map((s) => s.turnId)).not.toContain(fresh.id);
    expect((await store.getTurn(stale.id))?.status).toBe("failed");
    expect((await store.getTurn(fresh.id))?.status).toBe("running");

    // Second sweep: the guard already moved the row out of running, so nothing settles twice.
    const again = await store.recoverStale(now, 5 * 60 * 1000);
    expect(again.map((s) => s.turnId)).not.toContain(stale.id);
  });

  test("appendEvent assigns dense per-turn seq; readEventsSince replays in order", async () => {
    const turn = await store.enqueueTurn({ sessionId, prompt: "事件流" });
    await store.markRunning(turn.id);

    const first = await store.appendEvent({
      turnId: turn.id,
      type: "message_chunk",
      payload: { text: "a" },
    });
    const second = await store.appendEvent({
      turnId: turn.id,
      type: "progress",
      payload: { label: "b" },
    });
    const third = await store.appendEvent({
      turnId: turn.id,
      type: "message_chunk",
      payload: { text: "c" },
    });
    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);

    const replay = await store.readEventsSince(turn.id, 1);
    expect(replay.map((event) => event.seq)).toEqual([2, 3]);
  });

  test("artifacts insert and list in creation order", async () => {
    await store.insertArtifact({
      sessionId,
      type: "csv",
      name: "out.csv",
      path: "out.csv",
      sizeBytes: 12,
      visibility: "private",
    });
    await store.insertArtifact({
      sessionId,
      type: "chart",
      name: "plot.png",
      path: "plot.png",
      sizeBytes: 40,
      visibility: "public",
    });
    const all = await store.listArtifacts(sessionId);
    expect(all.map((a) => a.name)).toEqual(["out.csv", "plot.png"]);
  });
});
