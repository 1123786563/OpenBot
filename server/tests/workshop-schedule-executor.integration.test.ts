import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  channels,
  users,
  agents,
  workshopScheduleRuns,
  workshopSchedules,
  workshopSessions,
  workshopTurns,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  composeFiringPrompt,
  sweepWorkshopSchedules,
} from "../src/workshop/schedule-executor";

/**
 * The executor against a real PostgreSQL: the unique(scheduleId, scheduledFor) constraint is
 * the double-fire story, and a constraint is a promise only the database can make — a stub
 * that remembered its own inserts would pass everything while production fired twice.
 *
 * Each case seeds one due schedule (a nextRunAt in the past), runs one pass, and reads the
 * run rows and the enqueue calls back. The enqueue is a recorder: the orchestrator's own
 * behavior is its file's subject, not this one's.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const seeded: { userId: string; channelId: string; sessionId: string } = {
  userId: "sch-test-user",
  channelId: "sch-test-channel",
  sessionId: "sch-test-session",
};

beforeEach(async () => {
  await database.delete(workshopScheduleRuns);
  await database.delete(workshopSchedules);
  await database
    .delete(workshopSessions)
    .where(eq(workshopSessions.id, seeded.sessionId));
  await database.delete(channels).where(eq(channels.id, seeded.channelId));
  await database.delete(users).where(eq(users.id, seeded.userId));
  await database.insert(users).values({
    id: seeded.userId,
    email: "sch-test@openbot.invalid",
    name: "SCH",
  });
  await database.delete(agents).where(eq(agents.id, "sch-test-bot"));
  await database.insert(agents).values({
    id: "sch-test-bot",
    name: "sch bot",
    type: "remote_ag_ui",
    configuration: {},
  });
  await database.insert(channels).values({
    id: seeded.channelId,
    name: "sch",
    description: "schedule test",
  });
  await database.insert(workshopSessions).values({
    id: seeded.sessionId,
    channelId: seeded.channelId,
    botId: "sch-test-bot",
    ownerUserId: seeded.userId,
    status: "active",
  });
});

afterAll(async () => {
  await database.delete(workshopScheduleRuns);
  await database.delete(workshopSchedules);
  await database
    .delete(workshopSessions)
    .where(eq(workshopSessions.id, seeded.sessionId));
  await database.delete(channels).where(eq(channels.id, seeded.channelId));
  await database.delete(agents).where(eq(agents.id, "sch-test-bot"));
  await database.delete(users).where(eq(users.id, seeded.userId));
});

async function seedSchedule(input: {
  id: string;
  status?: string;
  nextRunAt: Date | null;
  preapproved?: unknown;
  prompt?: string;
}) {
  await database.insert(workshopSchedules).values({
    id: input.id,
    sessionId: seeded.sessionId,
    createdBy: seeded.userId,
    prompt: input.prompt ?? "跑一遍",
    rrule: "*/5 * * * *",
    timezone: "UTC",
    status: input.status ?? "enabled",
    nextRunAt: input.nextRunAt,
    preapproved: input.preapproved ?? null,
  });
}

function recorder() {
  const enqueued: Array<{
    sessionId: string;
    prompt: string;
    actorUserId: string;
    initiator: { kind: "routine"; id: string };
  }> = [];
  return {
    enqueued,
    enqueue: async (input: {
      sessionId: string;
      prompt: string;
      actorUserId: string;
      initiator: { kind: "routine"; id: string };
    }) => {
      enqueued.push(input);
      // A REAL turn row, not a made-up id: the run's turn_id carries a foreign key, and a
      // recorder that mints phantom ids keeps the FK untested while looking green.
      const id = `sch-turn-${enqueued.length}`;
      await database.insert(workshopTurns).values({
        id,
        sessionId: input.sessionId,
        prompt: input.prompt.slice(0, 60),
        status: "queued",
        turnIndex: enqueued.length - 1,
        usage: {},
        initiator: "headless",
      });
      return id;
    },
  };
}

const PAST = new Date("2026-06-01T00:00:00Z");
const SWEEP_AT = new Date("2026-06-01T00:01:00Z");

describe("the workshop schedule executor (B18)", () => {
  test("a due schedule fires once: one run row, one enqueue, initiator = its schedule", async () => {
    await seedSchedule({ id: "sch-1", nextRunAt: PAST });
    const { enqueued, enqueue } = recorder();
    const report = await sweepWorkshopSchedules(
      { db: database, enqueue },
      { now: () => SWEEP_AT },
    );
    expect(report).toMatchObject({ fired: 1, already: 0, refused: 0 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      sessionId: seeded.sessionId,
      actorUserId: seeded.userId,
      initiator: { kind: "routine", id: "sch-1" },
    });
    const runs = await database.select().from(workshopScheduleRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.turnId).toBe("sch-turn-1"); // The recorder's REAL turn row, not a phantom id.
    // And the schedule advanced: nextRunAt moved past the sweep moment.
    const schedule = (
      await database
        .select()
        .from(workshopSchedules)
        .where(eq(workshopSchedules.id, "sch-1"))
    )[0];
    expect(schedule?.nextRunAt?.getTime()).toBeGreaterThan(SWEEP_AT.getTime());
  });

  test("two passes over the same due moment fire once — the unique key arbitrates", async () => {
    await seedSchedule({ id: "sch-2", nextRunAt: PAST });
    const first = recorder();
    const second = recorder();
    // Same sweep moment: both replicas see the same due schedule and race the insert.
    await sweepWorkshopSchedules(
      { db: database, enqueue: first.enqueue },
      { now: () => SWEEP_AT },
    );
    await sweepWorkshopSchedules(
      { db: database, enqueue: second.enqueue },
      { now: () => SWEEP_AT },
    );
    expect(first.enqueued).toHaveLength(1);
    expect(second.enqueued).toHaveLength(0); // The second pass found the winner's row.
    const runs = await database.select().from(workshopScheduleRuns);
    expect(runs).toHaveLength(1);
  });

  test("a paused schedule is not the sweep's business — no run, no enqueue", async () => {
    await seedSchedule({ id: "sch-3", status: "paused", nextRunAt: PAST });
    const { enqueued, enqueue } = recorder();
    const report = await sweepWorkshopSchedules(
      { db: database, enqueue },
      { now: () => SWEEP_AT },
    );
    expect(report).toMatchObject({ fired: 0, already: 0, refused: 0 });
    expect(enqueued).toHaveLength(0);
    expect(await database.select().from(workshopScheduleRuns)).toHaveLength(0);
  });

  test("an enqueue failure keeps the recurrence alive and records the failure", async () => {
    await seedSchedule({ id: "sch-4", nextRunAt: PAST });
    const report = await sweepWorkshopSchedules(
      {
        db: database,
        enqueue: async () => {
          throw new Error("orchestrator refused");
        },
      },
      { now: () => SWEEP_AT },
    );
    expect(report).toMatchObject({ fired: 0, refused: 1 });
    const run = (await database.select().from(workshopScheduleRuns))[0];
    expect(run?.status).toBe("failed");
    expect(run?.note).toContain("orchestrator refused");
    // The recurrence advanced anyway: the next pass fires the NEXT occurrence, not this one again.
    const schedule = (
      await database
        .select()
        .from(workshopSchedules)
        .where(eq(workshopSchedules.id, "sch-4"))
    )[0];
    expect(schedule?.nextRunAt?.getTime()).toBeGreaterThan(SWEEP_AT.getTime());
  });

  test("the firing prompt carries the preapproval boundary, stated to the model", async () => {
    await seedSchedule({
      id: "sch-5",
      nextRunAt: PAST,
      preapproved: { paths: ["out/"], tools: ["python"], maxTurnsPerRun: 2 },
      prompt: "更新报表",
    });
    const { enqueued, enqueue } = recorder();
    await sweepWorkshopSchedules(
      { db: database, enqueue },
      { now: () => SWEEP_AT },
    );
    expect(enqueued[0]?.prompt).toContain("out/");
    expect(enqueued[0]?.prompt).toContain("python");
    expect(enqueued[0]?.prompt).toContain("2 轮");
    expect(enqueued[0]?.prompt).toContain("更新报表");
    // And the boundary statement itself, so the shape is pinned:
    expect(
      composeFiringPrompt({
        prompt: "x",
        preapproval: { paths: [], tools: [], maxTurnsPerRun: 3 },
      }),
    ).toContain("边界之外的操作必须等待审批");
  });
});
