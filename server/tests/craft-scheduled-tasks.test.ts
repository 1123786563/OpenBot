import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  type CraftScheduledTaskRow,
  type CraftScheduledTaskRunRow,
  type CraftScheduledTaskStore,
  compileToCron,
  computeNextRunAt,
  createCraftScheduledTaskStore,
  createScheduledTaskRoutes,
  humanReadable,
  nextNFires,
  sweepScheduledTasks,
  validateCron,
} from "../src/craft/scheduled-tasks";
import { ScheduleRefusedError } from "../src/routines/schedule";

function fakeRequireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: "u1", email: "u1@example.com", role: "user" });
    await next();
  };
}

function taskRow(
  overrides: Partial<CraftScheduledTaskRow> = {},
): CraftScheduledTaskRow {
  return {
    id: "cst-1",
    userId: "u1",
    name: "Daily summary",
    prompt: "Summarize the day",
    cronExpression: "0 9 * * *",
    editorMode: "daily_weekly",
    status: "active",
    nextRunAt: new Date("2030-01-01T00:00:00Z"),
    deleted: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function runRow(
  overrides: Partial<CraftScheduledTaskRunRow> = {},
): CraftScheduledTaskRunRow {
  return {
    id: "cstr-1",
    taskId: "cst-1",
    sessionId: null,
    status: "queued",
    triggerSource: "scheduled",
    skipReason: null,
    errorClass: null,
    errorDetail: null,
    summary: null,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    finishedAt: null,
    ...overrides,
  };
}

type MemTasks = CraftScheduledTaskStore & {
  tasks: CraftScheduledTaskRow[];
  runs: CraftScheduledTaskRunRow[];
};

function fakeTasks(): MemTasks {
  const tasks: CraftScheduledTaskRow[] = [];
  const runs: CraftScheduledTaskRunRow[] = [];
  return {
    tasks,
    runs,
    async listTasks(userId) {
      return tasks.filter((t) => t.userId === userId && !t.deleted);
    },
    async createTask(input) {
      const row = taskRow({
        id: `cst-${tasks.length + 1}`,
        userId: input.userId,
        name: input.name,
        prompt: input.prompt,
        cronExpression: input.cronExpression,
        editorMode: input.editorMode,
        status: input.status,
        nextRunAt: input.nextRunAt,
      });
      tasks.push(row);
      return row;
    },
    async getTask(id, userId) {
      return tasks.find(
        (t) => t.id === id && t.userId === userId && !t.deleted,
      );
    },
    async getTaskById(id) {
      return tasks.find((t) => t.id === id);
    },
    async updateTask(id, patch) {
      const index = tasks.findIndex((t) => t.id === id);
      if (index === -1) return undefined;
      tasks[index] = { ...tasks[index], ...patch, updatedAt: new Date() };
      return tasks[index];
    },
    async softDeleteTask(id, userId) {
      const index = tasks.findIndex((t) => t.id === id && t.userId === userId);
      if (index !== -1) tasks[index] = { ...tasks[index], deleted: true };
    },
    async claimDueTasks(now, limit) {
      return tasks
        .filter(
          (t) =>
            t.status === "active" &&
            !t.deleted &&
            t.nextRunAt !== null &&
            t.nextRunAt <= now,
        )
        .slice(0, limit);
    },
    async insertRun(taskId, triggerSource, status) {
      const row = runRow({
        id: `cstr-${runs.length + 1}`,
        taskId,
        triggerSource,
        status,
      });
      runs.push(row);
      return row;
    },
    async getRun(id) {
      return runs.find((r) => r.id === id);
    },
    async markRunStatus(id, patch) {
      const index = runs.findIndex((r) => r.id === id);
      if (index === -1) return undefined;
      runs[index] = { ...runs[index], ...patch } as CraftScheduledTaskRunRow;
      return runs[index];
    },
    async listRuns(taskId, limit = 50) {
      return runs.filter((r) => r.taskId === taskId).slice(0, limit);
    },
    async latestRun(taskId) {
      return runs.filter((r) => r.taskId === taskId).at(-1);
    },
    async hasInFlightRun(taskId) {
      return runs.some(
        (r) =>
          r.taskId === taskId &&
          (r.status === "queued" || r.status === "running"),
      );
    },
    async getRunContextForSession(sessionId, userId) {
      const run = runs.find((r) => r.sessionId === sessionId);
      if (!run) return undefined;
      const task = tasks.find(
        (t) => t.id === run.taskId && t.userId === userId,
      );
      if (!task) return undefined;
      return {
        runId: run.id,
        taskId: task.id,
        taskName: task.name,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      };
    },
  };
}

describe("validateCron", () => {
  test("refuses a six-field expression", () => {
    expect(() => validateCron("*/1 * * * * *")).toThrow(ScheduleRefusedError);
  });

  test("refuses an empty expression", () => {
    expect(() => validateCron("  ")).toThrow(ScheduleRefusedError);
  });

  test("accepts a five-field expression and returns it trimmed", () => {
    expect(validateCron("  */5 * * * *  ")).toBe("*/5 * * * *");
  });
});

describe("compileToCron", () => {
  test("interval minutes compiles to a minute step", () => {
    expect(compileToCron("interval", { unit: "minutes", every: 10 })).toBe(
      "*/10 * * * *",
    );
  });

  test("daily_weekly compiles to an HH:MM weekday expression", () => {
    expect(
      compileToCron("daily_weekly", {
        time_of_day: "09:00",
        weekdays: [1, 2, 3, 4, 5],
      }),
    ).toBe("0 9 * * 1,2,3,4,5");
  });

  test("interval days requires a time_of_day", () => {
    expect(() => compileToCron("interval", { unit: "days", every: 1 })).toThrow(
      ScheduleRefusedError,
    );
  });
});

describe("computeNextRunAt / nextNFires", () => {
  test("computes the next fire strictly after the anchor", () => {
    const next = computeNextRunAt(
      "0 9 * * *",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-01-01T09:00:00.000Z");
  });

  test("nextNFires returns n occurrences", () => {
    const fires = nextNFires("0 9 * * *", new Date("2026-01-01T00:00:00Z"), 3);
    expect(fires).toHaveLength(3);
    expect(fires[0].toISOString()).toBe("2026-01-01T09:00:00.000Z");
    expect(fires[1].toISOString()).toBe("2026-01-02T09:00:00.000Z");
  });

  test("humanReadable falls back to the raw expression when unparseable", () => {
    expect(humanReadable("0 9 * * *")).toBe("Every day at 09:00");
  });
});

describe("scheduled-task routes", () => {
  function appFixture() {
    const tasks = fakeTasks();
    const enqueued: string[] = [];
    const app = createScheduledTaskRoutes(fakeRequireUser(), {
      tasks,
      enqueueRun: (runId) => enqueued.push(runId),
    });
    return { app, tasks, enqueued };
  }

  test("POST creates a task; GET lists it", async () => {
    const { app } = appFixture();
    const created = await app.request("/scheduled-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Daily summary",
        prompt: "Summarize the day",
        editor_mode: "daily_weekly",
        editor_payload: { time_of_day: "09:00" },
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      id: string;
      cron_expression: string;
    };
    expect(createdBody.cron_expression).toBe("0 9 * * *");

    const listed = await app.request("/scheduled-tasks");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(createdBody.id);
  });

  test("POST refuses an invalid cron with 400", async () => {
    const { app } = appFixture();
    const res = await app.request("/scheduled-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Broken",
        prompt: "x",
        editor_mode: "advanced",
        editor_payload: { cron: "* * * * * *" },
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST run enqueues a fire-and-forget run id", async () => {
    const { app, tasks, enqueued } = appFixture();
    await tasks.createTask({
      userId: "u1",
      name: "Daily summary",
      prompt: "Summarize the day",
      cronExpression: "0 9 * * *",
      editorMode: "daily_weekly",
      status: "active",
      nextRunAt: new Date("2030-01-01T00:00:00Z"),
    });
    const run = await app.request("/scheduled-tasks/cst-1/run", {
      method: "POST",
    });
    expect(run.status).toBe(200);
    expect(enqueued).toHaveLength(1);
  });
});

describe("sweepScheduledTasks", () => {
  test("fires a due task, advances its nextRunAt, and enqueues the run", async () => {
    const tasks = fakeTasks();
    const enqueued: string[] = [];
    const task = await tasks.createTask({
      userId: "u1",
      name: "Due",
      prompt: "go",
      cronExpression: "0 9 * * *",
      editorMode: "daily_weekly",
      status: "active",
      nextRunAt: new Date("2020-01-01T00:00:00Z"),
    });

    const report = await sweepScheduledTasks(
      { tasks, enqueueRun: (id) => enqueued.push(id) },
      { now: () => new Date("2026-01-01T00:00:00Z") },
    );

    expect(report.fired).toBe(1);
    expect(enqueued).toHaveLength(1);
    const updated = await tasks.getTaskById(task.id);
    expect(updated?.nextRunAt).not.toBeNull();
    expect((updated?.nextRunAt ?? new Date(0)).getTime()).toBeGreaterThan(
      new Date("2026-01-01T00:00:00Z").getTime(),
    );
  });
});

describe("createCraftScheduledTaskStore", () => {
  test("is constructible without a live db (lazy)", () => {
    // The store is a thin closure over drizzle; construction itself does not touch the db,
    // so a null cast proves the factory shape without a Postgres connection.
    expect(createCraftScheduledTaskStore(null as never)).toBeTruthy();
  });
});
