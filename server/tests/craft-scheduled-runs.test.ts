import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import { SSEKeepalive } from "../src/craft/events/types";
import type { CraftSessionManager } from "../src/craft/manager";
import {
  type CraftScheduledTaskRow,
  type CraftScheduledTaskRunRow,
  type CraftScheduledTaskStore,
  createScheduledRunRoutes,
  createScheduledTaskRoutes,
  type ScheduledRunContext,
} from "../src/craft/scheduled-tasks";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";

/**
 * The scheduled-run observation surface: the task detail's `next_runs` preview, the `run-now`
 * alias, and the two session-scoped endpoints (context + live SSE) that drive the UI banner.
 * The executor is a fixture concern only — these tests pin the HTTP contract.
 */

function fakeRequireUser(
  userId = "u1",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: userId,
      email: `${userId}@example.com`,
      role: "user",
    });
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
      } satisfies ScheduledRunContext;
    },
  };
}

function sessionRow(overrides: Partial<CraftSessionRow> = {}): CraftSessionRow {
  return {
    id: "cs-1",
    userId: "u1",
    name: "Scheduled: Daily summary",
    status: "active",
    lastActivityAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    nextjsPort: null,
    sharingScope: "private",
    origin: "SCHEDULED",
    opencodeSessionId: "oc-1",
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task detail: next_runs
// ---------------------------------------------------------------------------

describe("GET /scheduled-tasks/:id next_runs", () => {
  function appFixture() {
    const tasks = fakeTasks();
    const enqueued: string[] = [];
    const app = createScheduledTaskRoutes(fakeRequireUser(), {
      tasks,
      enqueueRun: (runId) => enqueued.push(runId),
    });
    return { app, tasks, enqueued };
  }

  test("an active daily task previews the next 3 future 09:00 UTC fires", async () => {
    const { app, tasks } = appFixture();
    await tasks.createTask({
      userId: "u1",
      name: "Daily summary",
      prompt: "Summarize the day",
      cronExpression: "0 9 * * *",
      editorMode: "daily_weekly",
      status: "active",
      nextRunAt: new Date("2030-01-01T00:00:00Z"),
    });

    const res = await app.request("/scheduled-tasks/cst-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { next_runs: string[] };
    expect(body.next_runs).toHaveLength(3);

    const now = Date.now();
    const fires = body.next_runs.map((iso) => new Date(iso).getTime());
    for (const fire of fires) {
      expect(fire).toBeGreaterThan(now);
      expect(new Date(fire).toISOString()).toMatch(/T09:00:00\.000Z$/);
    }
    expect(fires[1]).toBeGreaterThan(fires[0]);
    expect(fires[2]).toBeGreaterThan(fires[1]);
  });

  test("a paused task previews no future fires", async () => {
    const { app, tasks } = appFixture();
    await tasks.createTask({
      userId: "u1",
      name: "Paused",
      prompt: "x",
      cronExpression: "0 9 * * *",
      editorMode: "daily_weekly",
      status: "paused",
      nextRunAt: null,
    });

    const res = await app.request("/scheduled-tasks/cst-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { next_runs: string[] };
    expect(body.next_runs).toEqual([]);
  });

  test("run-now is an alias of run: both enqueue a manual fire", async () => {
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

    const alias = await app.request("/scheduled-tasks/cst-1/run-now", {
      method: "POST",
    });
    expect(alias.status).toBe(200);
    const aliasBody = (await alias.json()) as { run_id: string };
    expect(aliasBody.run_id).toBeTruthy();
    expect(enqueued).toEqual([aliasBody.run_id]);

    const legacy = await app.request("/scheduled-tasks/cst-1/run", {
      method: "POST",
    });
    expect(legacy.status).toBe(200);
    expect(enqueued).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Scheduled-run context + events
// ---------------------------------------------------------------------------

/** The session-side reads the events route touches — findSession only, never the activity bump. */
function fakeStore(session: CraftSessionRow | undefined): CraftStore {
  return {
    async findSession(id, userId) {
      return id === session?.id && userId === session?.userId
        ? session
        : undefined;
    },
  } as unknown as CraftStore;
}

/** A manager whose subscribe is a canned event list — the bus, scripted. */
function fakeManager(
  script: () => Promise<Array<object>>,
): CraftSessionManager {
  return {
    async *subscribeToExistingSessionEvents() {
      for (const event of await script()) {
        yield event as never;
      }
    },
  } as unknown as CraftSessionManager;
}

function runRoutesFixture(input: {
  runStatus: CraftScheduledTaskRunRow["status"];
  session?: CraftSessionRow;
  script?: () => Promise<Array<object>>;
  userId?: string;
}) {
  const tasks = fakeTasks();
  tasks.tasks.push(taskRow({ id: "cst-1", userId: input.userId ?? "u1" }));
  tasks.runs.push(
    runRow({
      id: "cstr-1",
      taskId: "cst-1",
      sessionId: input.session?.id ?? "cs-1",
      status: input.runStatus,
    }),
  );
  const manager = fakeManager(input.script ?? (async () => []));
  const app = createScheduledRunRoutes(fakeRequireUser(input.userId ?? "u1"), {
    tasks,
    store: fakeStore(input.session ?? sessionRow()),
    config: loadCraftConfig({}),
    manager,
    botIdFor: async () => "bot-1",
  });
  return { app, tasks };
}

/** Drain an SSE Response to its full text — the reader ends when the route closes the stream. */
async function sseText(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("GET /sessions/:id/scheduled-run-context", () => {
  test("answers the banner row for the session's newest run", async () => {
    const { app } = runRoutesFixture({ runStatus: "running" });
    const res = await app.request("/sessions/cs-1/scheduled-run-context");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      run_id: "cstr-1",
      task_id: "cst-1",
      task_name: "Daily summary",
      status: "running",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: null,
    });
  });

  test("404 when the session has no scheduled run", async () => {
    const { app } = runRoutesFixture({ runStatus: "succeeded" });
    const res = await app.request("/sessions/unknown/scheduled-run-context");
    expect(res.status).toBe(404);
  });

  test("404 when the owning task belongs to another user", async () => {
    // The run + session exist for u1's task; u2 asks and must see nothing.
    const tasks = fakeTasks();
    tasks.tasks.push(taskRow({ userId: "u1" }));
    tasks.runs.push(runRow({ sessionId: "cs-1", status: "succeeded" }));
    const app = createScheduledRunRoutes(fakeRequireUser("u2"), {
      tasks,
      store: fakeStore(sessionRow({ userId: "u1" })),
      config: loadCraftConfig({}),
      manager: fakeManager(async () => []),
      botIdFor: async () => "bot-1",
    });
    const res = await app.request("/sessions/cs-1/scheduled-run-context");
    expect(res.status).toBe(404);
  });
});

describe("GET /sessions/:id/scheduled-run-events", () => {
  test("404 when the session has no scheduled-run context", async () => {
    const { app } = runRoutesFixture({ runStatus: "succeeded" });
    const res = await app.request("/sessions/unknown/scheduled-run-events");
    expect(res.status).toBe(404);
  });

  test("409 when the run exists but is not RUNNING (onyx CONFLICT)", async () => {
    const { app } = runRoutesFixture({ runStatus: "succeeded" });
    const res = await app.request("/sessions/cs-1/scheduled-run-events");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Scheduled run is not running");
  });

  test("streams bus events in the turn-SSE wire and closes on prompt_response", async () => {
    const { app } = runRoutesFixture({
      runStatus: "running",
      script: async () => [
        new SSEKeepalive(),
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        },
        { stopReason: "end_turn" },
      ],
    });

    const res = await app.request("/sessions/cs-1/scheduled-run-events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const text = await sseText(res);
    // Keepalive rides the comment line; events ride `event: message` data frames.
    expect(text).toContain(": keepalive\n\n");
    expect(text).toContain(
      'event: message\ndata: {"sessionUpdate":"agent_message_chunk"',
    );
    // The terminal frame closes the stream — nothing after prompt_response.
    const terminalIndex = text.indexOf('"type":"prompt_response"');
    expect(terminalIndex).toBeGreaterThan(0);
    expect(text.slice(terminalIndex)).not.toContain("agent_message_chunk");
  });

  test("closes the stream when the run resolves without a terminal frame", async () => {
    const { app, tasks } = runRoutesFixture({
      runStatus: "running",
      script: async () => [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "one" },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "two" },
        },
        { stopReason: "end_turn" },
      ],
    });
    // Flip the run row to its terminal state after the phase-1 read, so the
    // FIRST per-event check (which follows chunk "one") sees a resolved run and
    // ends the stream — chunk "two" and the prompt_response never go out.
    let reads = 0;
    tasks.getRun = async () => {
      reads += 1;
      if (reads >= 2) tasks.runs[0].status = "succeeded";
      return tasks.runs[0];
    };

    const res = await app.request("/sessions/cs-1/scheduled-run-events");
    expect(res.status).toBe(200);
    const text = await sseText(res);
    expect(text).toContain('"text":"one"');
    expect(text).not.toContain('"text":"two"');
    expect(text).not.toContain('"type":"prompt_response"');
  });
});
