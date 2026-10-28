import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { agents, users } from "../src/db/schema/core";
import { sandboxInstances } from "../src/db/schema/sandbox-instances";
import {
  canTransition,
  createSandboxInstanceStateStore,
  reconcileSandboxInstances,
  type ContainerRuntimeView,
} from "../src/sandbox/state";

describe("the transition graph (pure logic)", () => {
  test("terminated and failed are sinks", () => {
    for (const from of ["terminated", "failed"] as const) {
      for (const to of [
        "provisioning",
        "ready",
        "sleeping",
        "terminated",
        "failed",
      ] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  test("the legal moves are exactly the designed ones", () => {
    const legal: Array<[string, string[]]> = [
      ["provisioning", ["ready", "failed", "terminated"]],
      ["ready", ["sleeping", "failed", "terminated"]],
      ["sleeping", ["ready", "failed", "terminated"]],
    ];
    for (const [from, targets] of legal) {
      for (const to of [
        "provisioning",
        "ready",
        "sleeping",
        "terminated",
        "failed",
      ] as const) {
        expect(canTransition(from, to)).toBe(targets.includes(to));
      }
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "sandbox instance state machine",
  () => {
    const database = createDatabase(testDatabaseUrl(), TEST_POOL);
    const store = createSandboxInstanceStateStore(database);
    const run = randomUUID().slice(0, 8);
    const botId = `bot-${run}`;
    const ownerUserId = `user-${run}`;
    const ids: string[] = [];

    afterAll(async () => {
      await database
        .delete(sandboxInstances)
        .where(like(sandboxInstances.botId, `bot-${run}%`));
      await database.delete(agents).where(like(agents.id, `bot-${run}%`));
      await database.delete(users).where(eq(users.id, ownerUserId));
      await database.$client.close();
    });

    async function seed() {
      await database
        .insert(users)
        .values({
          id: ownerUserId,
          email: `${run}@sandbox-test.invalid`,
          name: "sandbox state test",
        })
        .onConflictDoNothing();
      await database
        .insert(agents)
        .values({
          id: botId,
          name: "sandbox state bot",
          type: "remote_ag_ui",
          configuration: {},
        })
        .onConflictDoNothing();
    }

    /** A row driven to `ready` the short way, for the tests that need one alive. */
    async function readyRow(): Promise<string> {
      const attempt = await store.beginAttempt({ botId, ownerUserId });
      ids.push(attempt.id);
      const ok = await store.transition(attempt.id, "provisioning", "ready", {
        address: `10.0.0.${1 + (ids.length % 250)}:4300`,
      });
      if (!ok) throw new Error("seed to ready failed");
      await store.heartbeat(attempt.id, new Date());
      return attempt.id;
    }

    test("an illegal move (terminated → ready) is refused at the store", async () => {
      await seed();
      const id = await readyRow();
      expect(await store.transition(id, "ready", "terminated")).toBe(true);
      // The row is now terminal; every further move on it fails, graph-refused.
      expect(await store.transition(id, "terminated", "ready")).toBe(false);
      expect(await store.transition(id, "terminated", "failed")).toBe(false);
    });

    test("CAS: two concurrent provisions, exactly one wins", async () => {
      const [a, b] = await Promise.all([
        store.beginAttempt({ botId, ownerUserId }),
        store.beginAttempt({ botId, ownerUserId }),
      ]);
      ids.push(a.id, b.id);
      // The database's own ordering picks the single provisioning row that acts; the other
      // replica stands down without creating a container.
      expect(a.won || b.won).toBe(true);
      expect(a.won && b.won).toBe(false);
      // Both rows exist (the loser closes its own out), and the bot has live attempts recorded.
      expect(a.attemptNumber).toBeGreaterThan(0);
      expect(b.attemptNumber).toBeGreaterThan(0);
    });

    test("reconcile fails the orphan: DB live, container gone", async () => {
      const id = await readyRow();
      const runtime: ContainerRuntimeView = {
        listBotIds: async () => [], // the runtime holds nothing
        remove: async () => undefined,
        recreate: async () => undefined,
      };
      const report = await reconcileSandboxInstances(store, runtime, {
        nowMs: Date.now(),
        idleAfterMs: 60_000,
      });
      expect(report.reaped).toContain(botId);
      const row = await database
        .select({ status: sandboxInstances.status })
        .from(sandboxInstances)
        .where(eq(sandboxInstances.id, id))
        .limit(1);
      expect(row[0]?.status).toBe("failed");
    });

    test("reconcile rebuilds the lost container: runtime holds it, DB has no live row", async () => {
      // bot-2's row set: all failed (none live), runtime still lists its container.
      const bot2 = `bot-${run}-2`;
      await database
        .insert(agents)
        .values({
          id: bot2,
          name: "sandbox state bot 2",
          type: "remote_ag_ui",
          configuration: {},
        })
        .onConflictDoNothing();
      const failed = await store.beginAttempt({ botId: bot2, ownerUserId });
      ids.push(failed.id);
      await store.transition(failed.id, "provisioning", "failed");

      const recreated: string[] = [];
      const runtime: ContainerRuntimeView = {
        listBotIds: async () => [bot2],
        remove: async () => undefined,
        recreate: async (bot) => recreated.push(bot),
      };
      const report = await reconcileSandboxInstances(store, runtime, {
        nowMs: Date.now(),
        idleAfterMs: 60_000,
      });
      expect(report.rebuilt).toContain(bot2);
      expect(recreated).toEqual([bot2]);
    });

    test("a quiet ready row goes to sleeping; a fresh one stays ready", async () => {
      const quiet = await readyRow();
      // Age the heartbeat past the idle cutoff.
      await database
        .update(sandboxInstances)
        .set({ lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000) })
        .where(eq(sandboxInstances.id, quiet));
      const fresh = await readyRow();

      const runtime: ContainerRuntimeView = {
        listBotIds: async () => [botId],
        remove: async () => undefined,
        recreate: async () => undefined,
      };
      const report = await reconcileSandboxInstances(store, runtime, {
        nowMs: Date.now(),
        idleAfterMs: 5 * 60 * 1000,
      });
      expect(report.slept).toContain(botId);
      const statuses = await database
        .select({
          id: sandboxInstances.id,
          status: sandboxInstances.status,
        })
        .from(sandboxInstances)
        .where(eq(sandboxInstances.botId, botId));
      const byId = new Map(statuses.map((s) => [s.id, s.status]));
      expect(byId.get(quiet)).toBe("sleeping");
      expect(byId.get(fresh)).toBe("ready");
    });
  },
);
