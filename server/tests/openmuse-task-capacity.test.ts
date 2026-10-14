import { beforeEach, describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  ACTIVE_TASKS_PER_USER,
  TASK_LIMIT_MESSAGE,
  taskWorkerCapacity,
} from "../src/openmuse-tasks/capacity";
import { createOpenMuseTasksRoutes } from "../src/openmuse-tasks/routes";
import { createOpenMuseTaskRunner } from "../src/openmuse-tasks/runner";
import {
  createOpenMuseTaskStore,
  OPENMUSE_TASK_KIND,
  type OpenMuseTaskRows,
  type OpenMuseTaskStatus,
  type StoredOpenMuseTask,
} from "../src/openmuse-tasks/store";

/*
 * O04 (§10 rows 4–6): the Task queue's bounds. The fakes mirror the seams the
 * guards read — the queue's claim-once/oldest-due-first semantics, the rows'
 * owner-scoped list — exactly as the runner and tasks tests fake them.
 */

const actor: AuthenticatedActor = {
  id: "user-1",
  email: "one@openbot.test",
  role: "user",
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

/** The queue's claim-once contract: a key is handed out once per offer, oldest first. */
function fakeQueue() {
  const offered: string[] = [];
  const waiting = new Set<string>();
  const claims: Array<{ limit?: number }> = [];
  return {
    offered,
    claims,
    offer: async (item: { key: string }) => {
      offered.push(item.key);
      waiting.add(item.key);
      return "queued" as const;
    },
    claim: async (input: { limit?: number }) => {
      claims.push({ limit: input.limit });
      const due = [...waiting].slice(0, input.limit ?? 1);
      for (const key of due) waiting.delete(key);
      return due.map((key) => ({
        kind: OPENMUSE_TASK_KIND,
        key,
        payload: { ownerUserId: actor.id },
        attempts: 1,
      }));
    },
    finish: async () => true,
    purge: async () => 0,
  };
}

/** Only the seams the guards touch, cast whole: the capacity paths never settle rows. */
function fakeRows(): OpenMuseTaskRows & { tasks: StoredOpenMuseTask[] } {
  const tasks: StoredOpenMuseTask[] = [];
  const seed = (
    id: string,
    status: OpenMuseTaskStatus,
    ownerUserId = actor.id,
  ) => {
    const at = new Date();
    tasks.push({
      id,
      ownerUserId,
      botId: "bot-1",
      kind: "agent",
      status,
      attempts: 1,
      steps: [],
      evidence: [],
      artifactIds: [],
      createdAt: at,
      updatedAt: at,
      idempotencyKey: null,
      cancellationRequested: false,
      pauseRequested: false,
      lastRetryKey: null,
      monitorFailureStreak: 0,
    });
  };
  const reads = { lists: 0, counts: 0 };
  const rows = {
    tasks,
    seed,
    reads,
    insertTask: async (task: StoredOpenMuseTask) => {
      tasks.push({
        ...task,
        steps: [...task.steps],
        evidence: [...task.evidence],
        artifactIds: [...task.artifactIds],
      });
    },
    findTaskByIdempotencyKey: async () => null,
    getTask: async () => null,
    listByOwner: async (ownerUserId: string, page: { limit: number }) => {
      reads.lists += 1;
      return tasks
        .filter((task) => task.ownerUserId === ownerUserId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, page.limit)
        .map((task) => ({ ...task }));
    },
    countActiveByOwner: async (ownerUserId: string) => {
      reads.counts += 1;
      return tasks.filter(
        (task) =>
          task.ownerUserId === ownerUserId &&
          !["succeeded", "failed", "cancelled"].includes(task.status),
      ).length;
    },
    ownerDisabled: async () => false,
  };
  return rows as unknown as OpenMuseTaskRows & {
    tasks: StoredOpenMuseTask[];
    reads: { lists: number; counts: number };
  };
}

/** One runner whose sweeps skip claimed items (no row behind the payload). */
function fakeRunner(queue: ReturnType<typeof fakeQueue>, capacity: unknown) {
  const rows = fakeRows();
  const store = createOpenMuseTaskStore({ rows });
  const runner = createOpenMuseTaskRunner({
    queue,
    store,
    owner: "test-sweeper",
    actorFor: async () => ({}) as never,
    channels: {
      direct: async () => ({ threadId: "thread-1" }),
    },
    runTurn: async () => ({ replyText: "done" }),
    ...(capacity ? { capacity: capacity as never } : {}),
  });
  return { rows, store, runner };
}

beforeEach(() => {
  delete process.env.OPENMUSE_TASK_WORKERS;
});

describe("O04 worker capacity (§10 row 4)", () => {
  test("the guard defaults to 4: three begun leaves one slot, the fourth fills it", () => {
    const capacity = taskWorkerCapacity();
    for (let index = 0; index < 3; index += 1)
      expect(capacity.begin()).toBe(true);
    expect(capacity.claimLimit()).toBe(1);
    expect(capacity.begin()).toBe(true);
    expect(capacity.claimLimit()).toBe(0);
    expect(capacity.begin()).toBe(false);
    capacity.end();
    expect(capacity.claimLimit()).toBe(1);
  });

  test("OPENMUSE_TASK_WORKERS overrides the cap", () => {
    process.env.OPENMUSE_TASK_WORKERS = "2";
    const capacity = taskWorkerCapacity();
    expect(capacity.begin()).toBe(true);
    expect(capacity.begin()).toBe(true);
    expect(capacity.claimLimit()).toBe(0);
  });

  test("with four running, a sweep claims ZERO additional", async () => {
    const queue = fakeQueue();
    await queue.offer({ key: "openmuse-task-fifth" });
    const capacity = taskWorkerCapacity();
    for (let index = 0; index < 4; index += 1) capacity.begin();
    const { runner } = fakeRunner(queue, capacity);
    const report = await runner.sweep();
    expect(report).toEqual({ ran: [], skipped: [] });
    expect(queue.claims).toEqual([]);
  });

  test("with three running, a sweep claims exactly one", async () => {
    const queue = fakeQueue();
    await queue.offer({ key: "openmuse-task-a" });
    await queue.offer({ key: "openmuse-task-b" });
    const capacity = taskWorkerCapacity();
    for (let index = 0; index < 3; index += 1) capacity.begin();
    const { runner } = fakeRunner(queue, capacity);
    await runner.sweep();
    expect(queue.claims).toEqual([{ limit: 1 }]);
  });

  test("one sweep drains the free slots one claim at a time; the fifth waits for a freed slot", async () => {
    const queue = fakeQueue();
    for (const id of ["a", "b", "c", "d", "fifth"])
      await queue.offer({ key: `openmuse-task-${id}` });
    const { runner } = fakeRunner(queue);
    const report = await runner.sweep();
    // Four free slots, four claims — each claim limit 1, because a sweep
    // runs its claims inline and only claims when the run is next; the
    // loop gives one sweep the free-slot count, not a single item.
    expect(queue.claims).toHaveLength(4);
    expect(queue.claims.every((claim) => claim.limit === 1)).toBe(true);
    expect(report.skipped).toHaveLength(4);
    const next = await runner.sweep();
    expect(next.skipped).toHaveLength(1);
  });
});

describe("O04 per-user active cap (§10 row 5)", () => {
  const app = () => {
    const rows = fakeRows();
    const store = createOpenMuseTaskStore({ rows });
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createOpenMuseTasksRoutes({
        store,
        requireUser,
        resolvePrivateBotId: async () => "bot-1",
      }),
    );
    return { rows, app };
  };

  const create = (fixture: ReturnType<typeof app>) =>
    fixture.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1", kind: "agent", prompt: "Do it." }),
    });

  test(`the ${ACTIVE_TASKS_PER_USER + 1}th active Task answers 409 with the legacy message`, async () => {
    const fixture = app();
    fixture.rows.seed("running-1", "running");
    fixture.rows.seed("waiting-1", "waiting_input");
    for (let index = 0; index < ACTIVE_TASKS_PER_USER - 2; index += 1)
      fixture.rows.seed(`queued-${index}`, "queued");
    const response = await create(fixture);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: TASK_LIMIT_MESSAGE });
    // No silent drop and no secret create either: the row count stands.
    expect(fixture.rows.tasks).toHaveLength(ACTIVE_TASKS_PER_USER);
  });

  test("terminal Tasks do not count", async () => {
    const fixture = app();
    fixture.rows.seed("succeeded-1", "succeeded");
    fixture.rows.seed("failed-1", "failed");
    fixture.rows.seed("cancelled-1", "cancelled");
    for (let index = 0; index < ACTIVE_TASKS_PER_USER - 1; index += 1)
      fixture.rows.seed(`active-${index}`, index % 2 ? "running" : "queued");
    const response = await create(fixture);
    expect(response.status).toBe(201);
  });

  test("the cap reads a count query, never a page scan: listByOwner is untouched on create", async () => {
    const fixture = app();
    const response = await create(fixture);
    expect(response.status).toBe(201);
    // A bound check needs a number, not 20,000 rows with two jsonb columns.
    expect(fixture.rows.reads.counts).toBe(1);
    expect(fixture.rows.reads.lists).toBe(0);
  });
});

/*
 * Fairness (Task 0, recorded): work/queue.ts claims `run_at asc` — oldest due
 * first, `for update skip locked`, no owner rotation. The decision: oldest-first
 * cannot starve a user BEHIND the per-user cap this same ticket enforces — a
 * claimed item is executed and finished, never parked, and one owner holds at
 * most 100 active Tasks, so another owner's runnable Task waits a bounded number
 * of item-runs, never indefinitely. A true owner-round-robin lives in the shared
 * claim query, which O04 does not own; recorded for O05 rather than faked here.
 */
describe("O04 claim fairness (recorded: oldest-first, bounded by the per-user cap)", () => {
  test("two owners' equal-age runnable Tasks get one claim each across sweeps", async () => {
    const queue = fakeQueue();
    const rows = fakeRows();
    const store = createOpenMuseTaskStore({ rows, queue });
    const runner = createOpenMuseTaskRunner({
      queue,
      store,
      owner: "test-sweeper",
      actorFor: async () => ({}) as never,
      channels: { direct: async () => ({ threadId: "thread-1" }) },
      runTurn: async () => ({ replyText: "done" }),
    });
    await store.create({
      ownerUserId: "owner-a",
      botId: "bot-1",
      kind: "agent",
      prompt: "A",
      idempotencyKey: null,
    });
    await store.create({
      ownerUserId: "owner-b",
      botId: "bot-1",
      kind: "agent",
      prompt: "B",
      idempotencyKey: null,
    });
    // One sweep, one claim at a time (limit 1): both owners' Tasks are
    // claimed — neither owner waits behind the other's SECOND item while
    // its first runs. The drain loop may end on one empty probe claim after
    // the queue empties; it never spins.
    await runner.sweep();
    const ownerA = rows.tasks.find((task) => task.ownerUserId === "owner-a");
    const ownerB = rows.tasks.find((task) => task.ownerUserId === "owner-b");
    expect(queue.claims.slice(0, 2)).toEqual([{ limit: 1 }, { limit: 1 }]);
    expect(queue.claims.length).toBeLessThanOrEqual(3);
    expect(queue.offered).toContain(ownerA?.id);
    expect(queue.offered).toContain(ownerB?.id);
    expect(queue.offered).toHaveLength(2);
  });
});

describe("O04 visible queued state (§10 row 4 acceptance)", () => {
  test("the fifth runnable Task stays queued and listable, never dropped", async () => {
    const queue = fakeQueue();
    const capacity = taskWorkerCapacity();
    for (let index = 0; index < 4; index += 1) capacity.begin();
    const { rows, store, runner } = fakeRunner(queue, capacity);
    // Four running workers and a fifth runnable, offered to the queue.
    for (let index = 0; index < 4; index += 1)
      rows.seed(`running-${index}`, "running");
    await store.create({
      ownerUserId: actor.id,
      botId: "bot-1",
      kind: "agent",
      prompt: "The fifth",
      idempotencyKey: null,
    });
    await runner.sweep();
    const fifth = rows.tasks.find((task) => task.prompt === "The fifth");
    expect(fifth?.status).toBe("queued");
    const { tasks } = await store.list(actor.id, { limit: 25 });
    expect(tasks.map((task) => task.status)).toContain("queued");
  });
});
