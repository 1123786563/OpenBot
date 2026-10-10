import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createWorkshopRoutes } from "../src/workshop/routes";
import type { WorkshopStore } from "../src/workshop/store";
import type { AppVariables } from "../src/auth/guards";

/**
 * The schedules CRUD behind the gate: the routes' own invariants — gate first, validated
 * recurrence second, nextRunAt recomputed on every write — against an in-memory store.
 */
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: "user_1" } as never);
  await next();
};

function fakeStore() {
  type ScheduleRow = {
    id: string;
    sessionId: string;
    createdBy: string;
    prompt: string;
    rrule: string;
    timezone: string;
    status: string;
    preapproved: unknown;
    lastRunAt: Date | null;
    nextRunAt: Date | null;
    createdAt: Date;
  };
  const schedules = new Map<string, ScheduleRow>();
  const store = {
    sessionByChannel: async (channelId: string) =>
      channelId === "ch_1"
        ? {
            id: "ws_1",
            channelId,
            botId: "bot_1",
            ownerUserId: "user_1",
            status: "active",
            opencodeSessionId: null,
            webappPort: null,
            createdAt: new Date(),
            lastActivityAt: new Date(),
            visibility: "private",
            shareTokenHash: null,
            shareScope: "preview",
            shareExpiresAt: null,
            shareRevokedAt: null,
            shareCreatedBy: null,
            shareCreatedAt: null,
          }
        : undefined,
    listSchedules: async (sessionId: string) =>
      [...schedules.values()].filter(
        (row) => row.sessionId === sessionId && row.status !== "deleted",
      ),
    createSchedule: async (input: Omit<ScheduleRow, "status" | "lastRunAt" | "createdAt">) => {
      schedules.set(input.id, {
        ...input,
        status: "enabled",
        lastRunAt: null,
        createdAt: new Date(),
      });
    },
    scheduleById: async (id: string, sessionId: string) => {
      const row = schedules.get(id);
      return row && row.sessionId === sessionId
        ? {
            id: row.id,
            prompt: row.prompt,
            rrule: row.rrule,
            timezone: row.timezone,
            status: row.status,
            preapproved: row.preapproved,
            nextRunAt: row.nextRunAt,
          }
        : undefined;
    },
    updateSchedule: async (id: string, patch: Partial<ScheduleRow>) => {
      const row = schedules.get(id);
      if (row) Object.assign(row, patch);
    },
    deleteSchedule: async (id: string) => {
      const row = schedules.get(id);
      if (row) {
        row.status = "deleted";
        row.nextRunAt = null;
      }
    },
    listScheduleRuns: async () => [],
  } as unknown as WorkshopStore;
  return { store, schedules };
}

function makeApp(allowBot = true) {
  const { store, schedules } = fakeStore();
  const app = createWorkshopRoutes({
    requireUser,
    canUseBot: (async () => allowBot) as never,
    deps: {
      store,
      bus: {
        subscribe: () => () => undefined,
        publish: () => undefined,
      } as never,
      orchestrator: {
        enqueue: async () => ({ turnId: "wt_x" }),
        cancel: async () => true,
      } as never,
      clientFor: () => null,
    },
  });
  // Mounted as the app mounts it: /api/workshop → the routes.
  const mounted = new Hono();
  mounted.route("/api/workshop", app);
  return { app: mounted, schedules };
}

const POST = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("schedule CRUD routes (B17b)", () => {
  test("the gate holds: a Bot the caller may not use answers 403 before anything", async () => {
    const { app } = makeApp(false);
    const response = await app.request(
      "http://x/api/workshop/ch_1/schedules",
      POST({ prompt: "x", mode: { kind: "daily", time: "09:00" } }),
    );
    expect(response.status).toBe(403);
  });

  test("an illegal recurrence is a 400 that never lands in the store", async () => {
    const { app, schedules } = makeApp();
    const response = await app.request(
      "http://x/api/workshop/ch_1/schedules",
      POST({ prompt: "x", mode: { kind: "advanced", cron: "not cron" } }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBeDefined();
    expect(schedules.size).toBe(0);
  });

  test("create then disable: a paused schedule holds no due moment; enable recomputes one", async () => {
    const { app, schedules } = makeApp();
    const created = await app.request(
      "http://x/api/workshop/ch_1/schedules",
      POST({
        prompt: "每天跑",
        mode: { kind: "daily", time: "09:00" },
        timezone: "UTC",
      }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(schedules.get(id)?.nextRunAt).not.toBeNull();

    const paused = await app.request(`http://x/api/workshop/ch_1/schedules/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(paused.status).toBe(200);
    expect(schedules.get(id)?.status).toBe("paused");
    expect(schedules.get(id)?.nextRunAt).toBeNull();

    const resumed = await app.request(`http://x/api/workshop/ch_1/schedules/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(resumed.status).toBe(200);
    expect(schedules.get(id)?.status).toBe("enabled");
    expect(schedules.get(id)?.nextRunAt).not.toBeNull();
  });

  test("the list answers both shapes: schedules with their clocks, and the run history", async () => {
    const { app } = makeApp();
    await app.request(
      "http://x/api/workshop/ch_1/schedules",
      POST({ prompt: "x", mode: { kind: "interval", every: 30, unit: "minutes" } }),
    );
    const listed = await app.request("http://x/api/workshop/ch_1/schedules");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      schedules: Array<{ id: string; rrule: string; status: string; nextRunAt: string | null }>;
      runs: unknown[];
    };
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0]?.rrule).toBe("*/30 * * * *");
    expect(body.schedules[0]?.status).toBe("enabled");
    expect(body.schedules[0]?.nextRunAt).not.toBeNull();
    expect(Array.isArray(body.runs)).toBe(true);
  });

  test("delete is soft: the row stays under status=deleted with no due moment", async () => {
    const { app, schedules } = makeApp();
    const created = await app.request(
      "http://x/api/workshop/ch_1/schedules",
      POST({ prompt: "x", mode: { kind: "daily", time: "09:00" } }),
    );
    const { id } = (await created.json()) as { id: string };
    const removed = await app.request(`http://x/api/workshop/ch_1/schedules/${id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(schedules.get(id)?.status).toBe("deleted");
    expect(schedules.get(id)?.nextRunAt).toBeNull();
    // And the list no longer shows it.
    const listed = await app.request("http://x/api/workshop/ch_1/schedules");
    expect(((await listed.json()) as { schedules: unknown[] }).schedules).toHaveLength(0);
  });
});
