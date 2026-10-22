import { and, eq, isNotNull, lte } from "drizzle-orm";
import { getLogger } from "../../../shared/logger";
import type { Database } from "../db/client";
import { workshopScheduleRuns, workshopSchedules } from "../db/schema/workshop";
import { nextRunAt, parsePreapproval } from "./schedule";

/**
 * The workshop's schedule executor (B18): what fires when a schedule comes due.
 *
 * TWO TABLES, ONE IDENTITY. A due schedule (B16's partial index: enabled + nextRunAt set and
 * past) gets ONE run row per firing, and the database's unique(scheduleId, scheduledFor) is
 * the whole double-fire story: two replicas racing to notice the same due moment both try the
 * insert, exactly one wins, the loser reads the winner's row and stands down. That is the
 * same shape the routines sweep gets from its offer key, expressed as a constraint instead of
 * a queue — the workshop already HAS an executor (the turn orchestrator), so there is no
 * dispatch to offer: the row IS the claim.
 *
 * THE TURN RUNS AS ITS CREATOR, MARKED. The enqueue carries the schedule's created_by as the
 * actor (whose authority the audit borrows) and a routine-initiator with the schedule id —
 * the audit vocabulary's word for "a recurrence did this"; a dedicated `schedule` kind is a
 * vocabulary change this batch does not make on its own. The turn row lands `initiator =
 * 'headless'` by B11's existing mapping.
 *
 * THE PREAPPROVAL BOUNDARY IS STATED, NOT ENFORCED, HERE. The prompt handed to the turn
 * carries the schedule's preapproval (paths, tools, ceiling) as its operating boundary; the
 * APPROVAL ROUTING that holds tool calls outside that boundary is the agent layer's, and no
 * sentence in this module can substitute for it. The boundary note below is a contract with
 * the agent layer, not a claim of enforcement.
 */

export type ScheduleRunOutcome =
  | { kind: "fired"; runId: string; turnId: string }
  | { kind: "already"; runId: string }
  | { kind: "refused"; reason: string };

export type ScheduleSweepOptions = {
  now?: () => Date;
  /** How many due schedules one pass considers. A pass has to end. */
  limit?: number;
  logger?: ReturnType<typeof getLogger>;
};

export type ScheduleSweepReport = {
  fired: number;
  already: number;
  refused: number;
};

/** Read the due set through B16's partial index shape (the query it exists to serve). */
function dueSchedules(db: Database, now: Date, limit: number) {
  return db
    .select({
      id: workshopSchedules.id,
      sessionId: workshopSchedules.sessionId,
      createdBy: workshopSchedules.createdBy,
      prompt: workshopSchedules.prompt,
      rrule: workshopSchedules.rrule,
      timezone: workshopSchedules.timezone,
      nextRunAt: workshopSchedules.nextRunAt,
      preapproved: workshopSchedules.preapproved,
    })
    .from(workshopSchedules)
    .where(
      and(
        eq(workshopSchedules.status, "enabled"),
        isNotNull(workshopSchedules.nextRunAt),
        lte(workshopSchedules.nextRunAt, now),
      ),
    )
    .limit(limit);
}

/**
 * The headless-turn prompt a firing sends: the schedule's ask, prefixed with its operating
 * boundary. The prefix is prose to the model AND a contract with the agent layer: tools and
 * paths outside the preapproval must still route through approval there, and a turn that
 * would exceed the ceiling should stop, not ask.
 */
export function composeFiringPrompt(input: {
  prompt: string;
  preapproval: { paths: string[]; tools: string[]; maxTurnsPerRun: number };
}): string {
  const { paths, tools, maxTurnsPerRun } = input.preapproval;
  return [
    "这是一次定时运行（workshop schedule）。",
    `本次运行的预授权边界：可写路径前缀 [${paths.join(", ") || "无"}]；`,
    `可免审批工具 [${tools.join(", ") || "无"}]；最多 ${maxTurnsPerRun} 轮。`,
    "边界之外的操作必须等待审批；接近轮次上限时应收尾并汇报，而不是继续。",
    input.prompt,
  ].join("\n");
}

/**
 * One pass: every due schedule gets exactly one firing. Returns the counts a caller's log
 * wants; never throws for a single schedule's refusal — a schedule that cannot fire this
 * pass keeps its nextRunAt (recomputed on the write path) and tries again.
 */
export async function sweepWorkshopSchedules(
  deps: {
    db: Database;
    enqueue: (input: {
      sessionId: string;
      prompt: string;
      actorUserId: string;
      initiator: { kind: "routine"; id: string };
    }) => Promise<string>;
  },
  options: ScheduleSweepOptions = {},
): Promise<ScheduleSweepReport> {
  const now = options.now ?? (() => new Date());
  const limit = options.limit ?? 50;
  const logger = options.logger ?? getLogger("server");
  const report: ScheduleSweepReport = { fired: 0, already: 0, refused: 0 };

  const due = await dueSchedules(deps.db, now(), limit);
  for (const schedule of due) {
    const scheduledFor = schedule.nextRunAt ?? now();
    // The claim: one run row per (schedule, moment). The unique constraint arbitrates
    // between replicas; the loser reads the winner's row and counts it "already".
    const runId = `wsr-${schedule.id}-${scheduledFor.getTime().toString(36)}`;
    const inserted = await deps.db
      .insert(workshopScheduleRuns)
      .values({
        id: runId,
        scheduleId: schedule.id,
        scheduledFor,
        status: "planned",
      })
      .onConflictDoNothing({
        target: [
          workshopScheduleRuns.scheduleId,
          workshopScheduleRuns.scheduledFor,
        ],
      })
      .returning({ id: workshopScheduleRuns.id })
      .catch(() => [] as Array<{ id: string }>);
    if (inserted.length === 0) {
      report.already += 1;
      continue;
    }

    // Advance the schedule BEFORE the turn: a firing whose enqueue throws has still fired —
    // the run row records the attempt, and lastRunAt/nextRunAt move so a failure does not
    // become an outage of the recurrence itself.
    const advanced = await advanceSchedule(
      deps.db,
      schedule.id,
      schedule.rrule,
      schedule.timezone ?? "UTC",
      now().getTime(),
    ).catch(() => null);
    if (!advanced) {
      // The schedule's recurrence stopped parsing (an edit raced the sweep): mark the run
      // skipped with the reason and stand down — the write path's recompute owns recovery.
      await deps.db
        .update(workshopScheduleRuns)
        .set({
          status: "skipped",
          note: "The recurrence stopped parsing at fire time.",
        })
        .where(eq(workshopScheduleRuns.id, runId))
        .catch(() => undefined);
      report.refused += 1;
      continue;
    }

    try {
      const turnId = await deps.enqueue({
        sessionId: schedule.sessionId,
        prompt: composeFiringPrompt({
          prompt: schedule.prompt,
          // The row's boundary, parsed with the same clamps the writer applied — the
          // executor trusts the shape's own normalization, never the raw jsonb.
          preapproval: parsePreapproval(schedule.preapproved),
        }),
        actorUserId: schedule.createdBy,
        initiator: { kind: "routine", id: schedule.id },
      });
      await deps.db
        .update(workshopScheduleRuns)
        .set({ status: "running", turnId, startedAt: now() })
        .where(eq(workshopScheduleRuns.id, runId));
      report.fired += 1;
    } catch (error) {
      // The firing failed to start; the run row keeps the failure for the history, and the
      // schedule's nextRunAt (already advanced) keeps the recurrence alive.
      await deps.db
        .update(workshopScheduleRuns)
        .set({
          status: "failed",
          note: error instanceof Error ? error.message : String(error),
          finishedAt: now(),
        })
        .where(eq(workshopScheduleRuns.id, runId));
      report.refused += 1;
      logger.warn(
        {
          scheduleId: schedule.id,
          runId,
          error: error instanceof Error ? error.message : String(error),
        },
        "workshop schedule firing failed",
      );
    }
  }
  return report;
}

/** Recompute a schedule's nextRunAt and stamp lastRunAt, on every write path. */
export async function advanceSchedule(
  db: Database,
  scheduleId: string,
  rrule: string,
  timezone: string,
  fromMs: number,
): Promise<Date | null> {
  try {
    const next = nextRunAt(rrule, timezone, fromMs);
    await db
      .update(workshopSchedules)
      .set({ lastRunAt: new Date(fromMs), nextRunAt: next })
      .where(eq(workshopSchedules.id, scheduleId));
    return next;
  } catch {
    return null;
  }
}
