/**
 * Craft scheduled tasks — ported from onyx `scheduled_tasks/{schedule,api}.py` and the headless
 * `executor.py`.
 *
 * The shape is the workshop's register: the pure cron compiler + resolver live here (stateless),
 * a deliberately-boring store owns the two rows, the routes own the invariants, and the headless
 * runner drives `manager.yieldSandboxEvents` + `persistSandboxEvent` + `finalizePersist` — the
 * one-for-one layering the interactive path already uses, so a scheduled run's transcript is
 * byte-identical to an interactive one.
 *
 * Differences from onyx (documented, kept narrow):
 *   - onyx evaluates cron in UTC always; OpenBot does too (no per-task timezone field).
 *   - onyx gates pre-approved external-app / MCP-server targets through a `gated_app` egress
 *     model OpenBot has no equivalent of; here the pre-approval columns are not ported.
 *   - onyx's dispatcher uses `SELECT FOR UPDATE SKIP LOCKED` under a Celery beat; OpenBot's
 *     sweeper is a single-process interval (the idle reaper's shape) — no multi-replica claim.
 *   - onyx's CronExpression is validated with `croniter.is_valid` + `cron-descriptor`; OpenBot
 *     reuses `routines/schedule.ts` (`ScheduleRefusedError`, the five-field contract) and its
 *     battle-tested `describeCron` for the human-readable form.
 */

import { CronExpressionParser } from "cron-parser";
import { and, asc, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  type CraftScheduledTaskEditorMode,
  type CraftScheduledTaskRunStatus,
  type CraftScheduledTaskStatus,
  type CraftScheduledTaskTriggerSource,
  craftScheduledTaskRuns,
  craftScheduledTasks,
} from "../db/schema/craft";
import { describeCron, ScheduleRefusedError } from "../routines/schedule";
import type { CraftConfig } from "./config";
import { isBuildPacket } from "./events/packets";
import {
  isKeepalive,
  isPromptResponse,
  isSandboxError,
  type SandboxError,
} from "./events/types";
import type { CraftSessionManager } from "./manager";
import { type CraftStore, newCraftId } from "./store";
import { eventToSse, SSE_KEEPALIVE } from "./streaming";
import { CRAFT_SSE_HEADERS } from "./turn-routes";

const logger = getLogger("server");

// ---------------------------------------------------------------------------
// Pure cron compile / resolve / describe (onyx schedule.py)
// ---------------------------------------------------------------------------

export type CraftEditorMode = CraftScheduledTaskEditorMode;
export type IntervalUnit = "minutes" | "hours" | "days";

/** onyx's `<input type="time">` shape: 24-hour HH:MM. */
const HH_MM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export type IntervalPayload = {
  unit: IntervalUnit;
  every: number;
  /** Required when unit === "days". */
  time_of_day?: string | null;
};

export type DailyWeeklyPayload = {
  time_of_day: string;
  /** Cron weekday convention (0=Sunday..6=Saturday); empty means every day. */
  weekdays?: number[];
};

export type AdvancedPayload = {
  cron: string;
};

export type EditorPayload =
  | IntervalPayload
  | DailyWeeklyPayload
  | AdvancedPayload;

function splitHHMM(value: string): [number, number] {
  const [hour, minute] = value.split(":");
  return [
    Number.parseInt(hour as string, 10),
    Number.parseInt(minute as string, 10),
  ];
}

/**
 * The five-field contract + parseability, restated locally so the check cannot drift behind an
 * import. `ScheduleRefusedError` is the shared refusal the routes translate to a 400.
 */
export function validateCron(cron: string): string {
  const trimmed = cron.trim();
  if (!trimmed) throw new ScheduleRefusedError("Cron expression is empty");
  if (trimmed.split(/\s+/).length !== 5) {
    throw new ScheduleRefusedError(
      "Cron expression must have exactly 5 fields",
    );
  }
  try {
    CronExpressionParser.parse(trimmed, { tz: "UTC" });
  } catch {
    throw new ScheduleRefusedError(`Invalid cron expression: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Compile a validated editor payload into the canonical five-field cron (onyx `compile_to_cron`).
 * Out-of-range `every` for the sub-day units falls back to the next-coarser default, exactly as
 * onyx does; the payload's invariants are checked here (no Pydantic layer to do it for us).
 */
export function compileToCron(
  editorMode: CraftEditorMode,
  payload: EditorPayload,
): string {
  let cron: string;

  if (editorMode === "advanced") {
    const advanced = payload as AdvancedPayload;
    if (typeof advanced.cron !== "string") {
      throw new ScheduleRefusedError("cron must be a string");
    }
    cron = validateCron(advanced.cron);
  } else if (editorMode === "interval") {
    const interval = payload as IntervalPayload;
    const every = interval.every;
    if (!Number.isInteger(every) || every < 1) {
      throw new ScheduleRefusedError("every must be a positive integer");
    }
    if (interval.unit === "minutes") {
      cron = every > 59 ? "0 * * * *" : `*/${every} * * * *`;
    } else if (interval.unit === "hours") {
      cron = every > 23 ? "0 0 * * *" : `0 */${every} * * *`;
    } else if (interval.unit === "days") {
      if (
        interval.time_of_day == null ||
        !HH_MM_RE.test(interval.time_of_day)
      ) {
        throw new ScheduleRefusedError(
          "time_of_day (HH:MM) is required when unit is 'days'",
        );
      }
      const [hour, minute] = splitHHMM(interval.time_of_day);
      cron = `${minute} ${hour} */${every} * *`;
    } else {
      throw new ScheduleRefusedError("unit must be minutes, hours, or days");
    }
  } else {
    const daily = payload as DailyWeeklyPayload;
    if (
      typeof daily.time_of_day !== "string" ||
      !HH_MM_RE.test(daily.time_of_day)
    ) {
      throw new ScheduleRefusedError("time_of_day must be in HH:MM form");
    }
    const [hour, minute] = splitHHMM(daily.time_of_day);
    const weekdays = [...new Set(daily.weekdays ?? [])].sort((a, b) => a - b);
    for (const day of weekdays) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new ScheduleRefusedError(
          "weekdays must be ints in 0..6 (0=Sunday)",
        );
      }
    }
    const weekdayField = weekdays.length > 0 ? weekdays.join(",") : "*";
    cron = `${minute} ${hour} * * ${weekdayField}`;
  }

  return cron;
}

/** The next UTC fire strictly after `after` (onyx `compute_next_run_at`). */
export function computeNextRunAt(cron: string, after: Date): Date {
  validateCron(cron);
  try {
    const iterator = CronExpressionParser.parse(cron, {
      tz: "UTC",
      currentDate: after,
    });
    return iterator.next().toDate();
  } catch {
    throw new ScheduleRefusedError(
      `Cron expression has no future fire: ${cron}`,
    );
  }
}

/** The next `n` UTC fire times (the UI preview endpoint). */
export function nextNFires(cron: string, after: Date, n: number): Date[] {
  if (!Number.isInteger(n) || n <= 0) {
    throw new ScheduleRefusedError("n must be a positive integer");
  }
  validateCron(cron);
  const iterator = CronExpressionParser.parse(cron, {
    tz: "UTC",
    currentDate: after,
  });
  const fires: Date[] = [];
  for (let index = 0; index < n; index += 1) {
    try {
      fires.push(iterator.next().toDate());
    } catch {
      throw new ScheduleRefusedError(
        `Cron expression has no future fire: ${cron}`,
      );
    }
  }
  return fires;
}

/** Human-readable schedule via the house formatter; raw cron when it cannot render it. */
export function humanReadable(cron: string): string {
  validateCron(cron);
  try {
    return describeCron(cron);
  } catch {
    return cron;
  }
}

// ---------------------------------------------------------------------------
// Store (onyx db/scheduled_task.py)
// ---------------------------------------------------------------------------

export type CraftScheduledTaskRow = typeof craftScheduledTasks.$inferSelect;
export type CraftScheduledTaskRunRow =
  typeof craftScheduledTaskRuns.$inferSelect;

export type CraftScheduledTaskStore = {
  // ── tasks ──────────────────────────────────────────────────────────────────
  listTasks(userId: string): Promise<CraftScheduledTaskRow[]>;
  createTask(input: {
    userId: string;
    name: string;
    prompt: string;
    cronExpression: string;
    editorMode: CraftScheduledTaskEditorMode;
    status: CraftScheduledTaskStatus;
    nextRunAt: Date | null;
  }): Promise<CraftScheduledTaskRow>;
  /** Non-deleted task owned by `userId` — the routes' ownership check. */
  getTask(
    id: string,
    userId: string,
  ): Promise<CraftScheduledTaskRow | undefined>;
  /** Unscoped (used by the executor to resolve a run's task even after soft delete). */
  getTaskById(id: string): Promise<CraftScheduledTaskRow | undefined>;
  updateTask(
    id: string,
    patch: {
      name?: string;
      prompt?: string;
      cronExpression?: string;
      editorMode?: CraftScheduledTaskEditorMode;
      status?: CraftScheduledTaskStatus;
      nextRunAt?: Date | null;
      deleted?: boolean;
    },
  ): Promise<CraftScheduledTaskRow | undefined>;
  softDeleteTask(id: string, userId: string): Promise<void>;
  /** Due tasks for one dispatcher pass: active, not deleted, next_run_at ≤ now. */
  claimDueTasks(now: Date, limit: number): Promise<CraftScheduledTaskRow[]>;

  // ── runs ───────────────────────────────────────────────────────────────────
  insertRun(
    taskId: string,
    triggerSource: CraftScheduledTaskTriggerSource,
    status: CraftScheduledTaskRunStatus,
  ): Promise<CraftScheduledTaskRunRow>;
  getRun(id: string): Promise<CraftScheduledTaskRunRow | undefined>;
  markRunStatus(
    id: string,
    patch: {
      status?: CraftScheduledTaskRunStatus;
      sessionId?: string | null;
      skipReason?: string | null;
      errorClass?: string | null;
      errorDetail?: string | null;
      summary?: string | null;
    },
  ): Promise<CraftScheduledTaskRunRow | undefined>;
  /** Newest first. */
  listRuns(taskId: string, limit?: number): Promise<CraftScheduledTaskRunRow[]>;
  latestRun(taskId: string): Promise<CraftScheduledTaskRunRow | undefined>;
  hasInFlightRun(taskId: string): Promise<boolean>;
  /**
   * The newest run linked to a session, with its task's name — the session-view banner's one
   * lookup (onyx `get_scheduled_run_context`). Scoped by the task's owner: a run another user's
   * task produced is invisible, exactly as onyx's join does.
   */
  getRunContextForSession(
    sessionId: string,
    userId: string,
  ): Promise<ScheduledRunContext | undefined>;
};

/** onyx's `ScheduledRunContextResponse` row: what the banner renders. */
export type ScheduledRunContext = {
  runId: string;
  taskId: string;
  taskName: string;
  status: CraftScheduledTaskRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
};

export function createCraftScheduledTaskStore(
  db: Database,
): CraftScheduledTaskStore {
  return {
    async listTasks(userId) {
      return db
        .select()
        .from(craftScheduledTasks)
        .where(
          and(
            eq(craftScheduledTasks.userId, userId),
            eq(craftScheduledTasks.deleted, false),
          ),
        )
        .orderBy(desc(craftScheduledTasks.createdAt));
    },

    async createTask(input) {
      const rows = await db
        .insert(craftScheduledTasks)
        .values({
          id: newCraftId("cst"),
          userId: input.userId,
          name: input.name,
          prompt: input.prompt,
          cronExpression: input.cronExpression,
          editorMode: input.editorMode,
          status: input.status,
          nextRunAt: input.nextRunAt,
        })
        .returning();
      return rows[0];
    },

    async getTask(id, userId) {
      const rows = await db
        .select()
        .from(craftScheduledTasks)
        .where(
          and(
            eq(craftScheduledTasks.id, id),
            eq(craftScheduledTasks.userId, userId),
            eq(craftScheduledTasks.deleted, false),
          ),
        )
        .limit(1);
      return rows[0];
    },

    async getTaskById(id) {
      const rows = await db
        .select()
        .from(craftScheduledTasks)
        .where(eq(craftScheduledTasks.id, id))
        .limit(1);
      return rows[0];
    },

    async updateTask(id, patch) {
      const rows = await db
        .update(craftScheduledTasks)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(craftScheduledTasks.id, id))
        .returning();
      return rows[0];
    },

    async softDeleteTask(id, userId) {
      await db
        .update(craftScheduledTasks)
        .set({ deleted: true, nextRunAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(craftScheduledTasks.id, id),
            eq(craftScheduledTasks.userId, userId),
          ),
        );
    },

    async claimDueTasks(now, limit) {
      return db
        .select()
        .from(craftScheduledTasks)
        .where(
          and(
            eq(craftScheduledTasks.status, "active"),
            eq(craftScheduledTasks.deleted, false),
            isNotNull(craftScheduledTasks.nextRunAt),
            lte(craftScheduledTasks.nextRunAt, now),
          ),
        )
        .orderBy(asc(craftScheduledTasks.nextRunAt))
        .limit(limit);
    },

    async insertRun(taskId, triggerSource, status) {
      const rows = await db
        .insert(craftScheduledTaskRuns)
        .values({
          id: newCraftId("cstr"),
          taskId,
          triggerSource,
          status,
        })
        .returning();
      return rows[0];
    },

    async getRun(id) {
      const rows = await db
        .select()
        .from(craftScheduledTaskRuns)
        .where(eq(craftScheduledTaskRuns.id, id))
        .limit(1);
      return rows[0];
    },

    async markRunStatus(id, patch) {
      const rows = await db
        .update(craftScheduledTaskRuns)
        .set({
          ...patch,
          ...((patch.status === "succeeded" ||
            patch.status === "failed" ||
            patch.status === "skipped") && { finishedAt: new Date() }),
        })
        .where(eq(craftScheduledTaskRuns.id, id))
        .returning();
      return rows[0];
    },

    async listRuns(taskId, limit = 50) {
      return db
        .select()
        .from(craftScheduledTaskRuns)
        .where(eq(craftScheduledTaskRuns.taskId, taskId))
        .orderBy(desc(craftScheduledTaskRuns.startedAt))
        .limit(limit);
    },

    async latestRun(taskId) {
      const rows = await db
        .select()
        .from(craftScheduledTaskRuns)
        .where(eq(craftScheduledTaskRuns.taskId, taskId))
        .orderBy(desc(craftScheduledTaskRuns.startedAt))
        .limit(1);
      return rows[0];
    },

    async hasInFlightRun(taskId) {
      const rows = await db
        .select({ one: craftScheduledTaskRuns.id })
        .from(craftScheduledTaskRuns)
        .where(
          and(
            eq(craftScheduledTaskRuns.taskId, taskId),
            inArray(craftScheduledTaskRuns.status, ["queued", "running"]),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async getRunContextForSession(sessionId, userId) {
      const rows = await db
        .select({ run: craftScheduledTaskRuns, task: craftScheduledTasks })
        .from(craftScheduledTaskRuns)
        .innerJoin(
          craftScheduledTasks,
          eq(craftScheduledTaskRuns.taskId, craftScheduledTasks.id),
        )
        .where(
          and(
            eq(craftScheduledTaskRuns.sessionId, sessionId),
            eq(craftScheduledTasks.userId, userId),
          ),
        )
        .orderBy(desc(craftScheduledTaskRuns.startedAt))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return {
        runId: row.run.id,
        taskId: row.task.id,
        taskName: row.task.name,
        status: row.run.status,
        startedAt: row.run.startedAt,
        finishedAt: row.run.finishedAt,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Headless executor (onyx executor.py)
// ---------------------------------------------------------------------------

const SUMMARY_MAX_CHARS = 120;

function clipSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  let clipped = text.slice(0, SUMMARY_MAX_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace > SUMMARY_MAX_CHARS / 2) clipped = clipped.slice(0, lastSpace);
  return `${clipped.trimEnd()}…`;
}

async function summaryFromSessionMessages(
  store: CraftStore,
  sessionId: string,
): Promise<string> {
  const rows = await store.getMessages(sessionId);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const meta = rows[index]?.messageMetadata as
      | { type?: unknown; content?: unknown }
      | undefined;
    if (!meta || typeof meta !== "object") continue;
    if (meta.type !== "agent_message") continue;
    const content = meta.content as
      | { type?: unknown; text?: unknown }
      | undefined;
    if (
      content &&
      typeof content === "object" &&
      content.type === "text" &&
      typeof content.text === "string" &&
      content.text.trim()
    ) {
      return clipSummary(content.text.trim());
    }
  }
  return "";
}

export type ScheduledTaskExecutorDeps = {
  db: Database;
  config: CraftConfig;
  store: CraftStore;
  tasks: CraftScheduledTaskStore;
  manager: CraftSessionManager;
  /** Resolves the Bot whose sandbox hosts the run's session. */
  botIdFor: (sessionId: string) => Promise<string | null>;
};

/**
 * Fire-and-forget enqueue: the run route persists the run row and returns at once; the headless
 * drive runs detached (the interactive turn runner's shape) so the HTTP response never waits on
 * the agent.
 */
export function fireAndForgetRun(
  deps: ScheduledTaskExecutorDeps,
): (runId: string) => void {
  return (runId) => {
    void runScheduledTask(deps, runId).catch((error) => {
      logger.error(
        { runId, error },
        "[craft] scheduled-task run failed unexpectedly",
      );
    });
  };
}

/**
 * Execute one scheduled-task run end-to-end, owning the run-status state machine. Always returns
 * cleanly — exceptions inside the agent drive become a FAILED row, never a re-raise (no retries,
 * matching onyx's V1 contract).
 */
export async function runScheduledTask(
  deps: ScheduledTaskExecutorDeps,
  runId: string,
): Promise<void> {
  const run = await deps.tasks.getRun(runId);
  if (run?.status !== "queued") return; // idempotent: a retry/sweeper beat us here

  const task = await deps.tasks.getTaskById(run.taskId);
  if (!task) {
    await deps.tasks.markRunStatus(runId, {
      status: "failed",
      errorClass: "task_missing",
      errorDetail: "Scheduled task row no longer exists",
    });
    return;
  }

  await deps.tasks.markRunStatus(runId, { status: "running" });

  const state = new (await import("./streaming")).BuildStreamingState(0);
  let sessionId: string | null = null;
  try {
    // Create the session (SCHEDULED origin keeps it off the craft sidebar) and persist the
    // prompt as turn 0 so the transcript matches an interactive run exactly.
    const session = await deps.manager.createSession(deps.db, {
      userId: task.userId,
      name: `Scheduled: ${task.name}`,
      headless: true,
      origin: "SCHEDULED",
    });
    sessionId = session.id;
    await deps.store.createMessage({
      sessionId,
      type: "user",
      turnIndex: 0,
      messageMetadata: {
        type: "user_message",
        content: { type: "text", text: task.prompt },
      },
    });
    await deps.tasks.markRunStatus(runId, { sessionId });

    const botId = await deps.botIdFor(sessionId);
    if (!botId) {
      throw new Error("No sandbox configured for this session");
    }

    const budgetMs = deps.config.interactiveTurnHardCapSeconds * 1000;
    const deadlineAt = Date.now() + budgetMs;

    let gotPromptResponse = false;
    let cancelled = false;
    let terminalError: SandboxError | null = null;

    const eventStream = deps.manager.yieldSandboxEvents(
      {
        sessionId,
        botId,
        userMessageContent: task.prompt,
        opencodeSessionId: null,
        shouldInterrupt: () => Date.now() > deadlineAt,
        shouldAbortOnTeardown: () => true,
        turnTimeoutMs: budgetMs,
      },
      async (newId) => {
        await deps.store.persistOpencodeSessionId(session.id, newId);
      },
    );

    for await (const event of eventStream) {
      if (isKeepalive(event)) continue;

      if (isPromptResponse(event)) {
        if (event.stopReason === "cancelled") cancelled = true;
        gotPromptResponse = true;
        break;
      }

      if (!isBuildPacket(event) && isSandboxError(event)) {
        terminalError = event;
        break;
      }

      // Budget check before persistence so a runaway agent stops growing the transcript.
      if (Date.now() > deadlineAt) {
        await deps.manager.finalizePersist(sessionId, state);
        await deps.tasks.markRunStatus(runId, {
          status: "failed",
          errorClass: "timeout",
          errorDetail: `budget exceeded (${deps.config.interactiveTurnHardCapSeconds}s)`,
        });
        return;
      }

      await deps.manager.persistSandboxEvent(sessionId, state, event);
    }

    await deps.manager.finalizePersist(sessionId, state);

    if (terminalError || cancelled || !gotPromptResponse) {
      const errorClass = "agent_exception";
      const errorDetail = terminalError
        ? terminalError.message
        : cancelled
          ? "agent turn was aborted before completion"
          : "agent stream ended without a completion response";
      await deps.tasks.markRunStatus(runId, {
        status: "failed",
        errorClass,
        errorDetail: errorDetail.slice(0, 1000),
      });
      return;
    }

    await deps.tasks.markRunStatus(runId, {
      status: "succeeded",
      summary:
        (await summaryFromSessionMessages(deps.store, sessionId)) || null,
    });
  } catch (error) {
    if (sessionId) {
      await deps.manager
        .finalizePersist(sessionId, state)
        .catch(() => undefined);
    }
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    await deps.tasks.markRunStatus(runId, {
      status: "failed",
      errorClass: "executor_error",
      errorDetail: `${name}: ${message}`.slice(0, 1000),
    });
  }
}

// ---------------------------------------------------------------------------
// Dispatcher (onyx's Celery beat, reshaped as a single-process interval sweep)
// ---------------------------------------------------------------------------

export type ScheduledTaskSweepDeps = {
  tasks: CraftScheduledTaskStore;
  enqueueRun: (runId: string) => void;
};

export type ScheduledTaskSweepReport = { fired: number };

/**
 * One dispatcher pass: every due task gets one scheduled run and advances its nextRunAt. The
 * single-process shape (the idle reaper's setInterval) has no multi-replica claim — documented as
 * a port difference, not a defect.
 */
export async function sweepScheduledTasks(
  deps: ScheduledTaskSweepDeps,
  options: { now?: () => Date; limit?: number } = {},
): Promise<ScheduledTaskSweepReport> {
  const now = options.now ?? (() => new Date());
  const limit = options.limit ?? 20;
  const due = await deps.tasks.claimDueTasks(now(), limit);
  let fired = 0;
  for (const task of due) {
    // Advance BEFORE the run row so a failed enqueue does not wedge the recurrence; the run
    // row records the attempt.
    const next = computeNextRunAt(task.cronExpression, now());
    await deps.tasks.updateTask(task.id, { nextRunAt: next });
    // A run that outlives its recurrence interval must not stack: the previous run is still
    // queued or running, so this sweep records a skipped run (onyx's shape) instead of
    // firing a second concurrent headless turn with real side effects.
    if (await deps.tasks.hasInFlightRun(task.id)) {
      const skipped = await deps.tasks.insertRun(task.id, "scheduled", "skipped");
      await deps.tasks.markRunStatus(skipped.id, {
        status: "skipped",
        skipReason: "A previous run is still in flight.",
      });
      continue;
    }
    const run = await deps.tasks.insertRun(task.id, "scheduled", "queued");
    deps.enqueueRun(run.id);
    fired += 1;
  }
  return { fired };
}

export function startCraftScheduledTaskSweeper(
  deps: ScheduledTaskSweepDeps,
  options: { intervalMs?: number } = {},
): { stop: () => void; sweepOnce: () => Promise<ScheduledTaskSweepReport> } {
  const intervalMs = options.intervalMs ?? 30_000;
  // A pass slower than the interval must not overlap itself: two sweeps would claim
  // the same due tasks and race their nextRunAt writes.
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweepScheduledTasks(deps)
      .catch((error) => {
        logger.error({ error }, "[craft] scheduled-task sweeper failed");
      })
      .finally(() => {
        sweeping = false;
      });
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    sweepOnce: () => sweepScheduledTasks(deps),
  };
}

// ---------------------------------------------------------------------------
// Routes (onyx scheduled_tasks/api.py)
// ---------------------------------------------------------------------------

const NEXT_RUNS_PREVIEW_COUNT = 3;
const RUNS_DEFAULT_PAGE_SIZE = 50;

function runResponse(run: CraftScheduledTaskRunRow): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    trigger_source: run.triggerSource,
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt ? run.finishedAt.toISOString() : null,
    session_id: run.sessionId,
    summary: run.summary,
    skip_reason: run.skipReason,
    error_class: run.errorClass,
  };
}

function taskDetail(
  task: CraftScheduledTaskRow,
  lastRun: CraftScheduledTaskRunRow | undefined,
): Record<string, unknown> {
  const nextRuns =
    task.status === "active" && task.nextRunAt
      ? (() => {
          try {
            return nextNFires(
              task.cronExpression,
              new Date(),
              NEXT_RUNS_PREVIEW_COUNT,
            ).map((date) => date.toISOString());
          } catch {
            return [];
          }
        })()
      : [];
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    human_readable_schedule: humanReadable(task.cronExpression),
    cron_expression: task.cronExpression,
    editor_mode: task.editorMode,
    status: task.status,
    next_run_at: task.nextRunAt ? task.nextRunAt.toISOString() : null,
    next_runs: nextRuns,
    last_run: lastRun ? runResponse(lastRun) : null,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
  };
}

export type ScheduledTaskRoutesDeps = {
  tasks: CraftScheduledTaskStore;
  /** Fire-and-forget the headless run (the run row is already persisted). */
  enqueueRun: (runId: string) => void;
};

export function createScheduledTaskRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: ScheduledTaskRoutesDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  function actorId(context: { var: AppVariables }): string {
    return context.var.actor.id;
  }

  async function resolveTask(
    context: { var: AppVariables },
    id: string,
  ): Promise<CraftScheduledTaskRow | undefined> {
    return deps.tasks.getTask(id, actorId(context));
  }

  // ── GET /scheduled-tasks ──────────────────────────────────────────────────
  app.get("/scheduled-tasks", async (context) => {
    const tasks = await deps.tasks.listTasks(actorId(context));
    // Independent rows: one round of parallel reads instead of one per task.
    const lastRuns = await Promise.all(
      tasks.map((task) => deps.tasks.latestRun(task.id)),
    );
    const items: Record<string, unknown>[] = [];
    for (const [index, task] of tasks.entries()) {
      const lastRun = lastRuns[index];
      items.push({
        id: task.id,
        name: task.name,
        human_readable_schedule: humanReadable(task.cronExpression),
        cron_expression: task.cronExpression,
        editor_mode: task.editorMode,
        status: task.status,
        next_run_at: task.nextRunAt ? task.nextRunAt.toISOString() : null,
        last_run: lastRun ? runResponse(lastRun) : null,
        created_at: task.createdAt.toISOString(),
        updated_at: task.updatedAt.toISOString(),
      });
    }
    return context.json({ items });
  });

  // ── POST /scheduled-tasks ─────────────────────────────────────────────────
  app.post("/scheduled-tasks", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      name?: unknown;
      prompt?: unknown;
      editor_mode?: unknown;
      editor_payload?: unknown;
      status?: unknown;
      run_immediately?: unknown;
    };

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return context.json({ error: "name is required" }, 400);
    }
    if (body.name.length > 200) {
      return context.json(
        { error: "name must be at most 200 characters" },
        400,
      );
    }
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
      return context.json({ error: "prompt is required" }, 400);
    }
    if (
      body.editor_mode !== "interval" &&
      body.editor_mode !== "daily_weekly" &&
      body.editor_mode !== "advanced"
    ) {
      return context.json(
        { error: "editor_mode must be interval, daily_weekly, or advanced" },
        400,
      );
    }
    if (
      body.status !== undefined &&
      body.status !== "active" &&
      body.status !== "paused"
    ) {
      return context.json({ error: "status must be active or paused" }, 400);
    }

    let cronExpression: string;
    try {
      cronExpression = compileToCron(
        body.editor_mode,
        body.editor_payload as EditorPayload,
      );
    } catch (error) {
      if (error instanceof ScheduleRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }

    const status = (body.status ?? "active") as CraftScheduledTaskStatus;
    const nextRunAt =
      status === "active" ? computeNextRunAt(cronExpression, new Date()) : null;

    const task = await deps.tasks.createTask({
      userId: actorId(context),
      name: body.name.trim(),
      prompt: body.prompt.trim(),
      cronExpression,
      editorMode: body.editor_mode,
      status,
      nextRunAt,
    });

    if (body.run_immediately === true) {
      const run = await deps.tasks.insertRun(
        task.id,
        "manual_run_now",
        "queued",
      );
      deps.enqueueRun(run.id);
    }

    return context.json(taskDetail(task, undefined), 201);
  });

  // ── GET /scheduled-tasks/:id ──────────────────────────────────────────────
  app.get("/scheduled-tasks/:id", async (context) => {
    const task = await resolveTask(context, context.req.param("id"));
    if (!task) return context.json({ error: "Scheduled task not found" }, 404);
    const lastRun = await deps.tasks.latestRun(task.id);
    return context.json(taskDetail(task, lastRun));
  });

  // ── PUT /scheduled-tasks/:id ──────────────────────────────────────────────
  app.put("/scheduled-tasks/:id", async (context) => {
    const task = await resolveTask(context, context.req.param("id"));
    if (!task) return context.json({ error: "Scheduled task not found" }, 404);

    const body = (await context.req.json().catch(() => ({}))) as {
      name?: unknown;
      prompt?: unknown;
      editor_mode?: unknown;
      editor_payload?: unknown;
      status?: unknown;
    };

    const patch: Parameters<CraftScheduledTaskStore["updateTask"]>[1] = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return context.json({ error: "name is required" }, 400);
      }
      if (body.name.length > 200) {
        return context.json(
          { error: "name must be at most 200 characters" },
          400,
        );
      }
      patch.name = body.name.trim();
    }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
        return context.json({ error: "prompt is required" }, 400);
      }
      patch.prompt = body.prompt.trim();
    }

    // editor_mode and editor_payload must be supplied together (onyx _editor_pair_consistency).
    if (
      (body.editor_mode === undefined) !==
      (body.editor_payload === undefined)
    ) {
      return context.json(
        { error: "editor_mode and editor_payload must be supplied together" },
        400,
      );
    }
    if (body.editor_mode !== undefined) {
      if (
        body.editor_mode !== "interval" &&
        body.editor_mode !== "daily_weekly" &&
        body.editor_mode !== "advanced"
      ) {
        return context.json(
          { error: "editor_mode must be interval, daily_weekly, or advanced" },
          400,
        );
      }
      try {
        patch.cronExpression = compileToCron(
          body.editor_mode,
          body.editor_payload as EditorPayload,
        );
      } catch (error) {
        if (error instanceof ScheduleRefusedError) {
          return context.json({ error: error.message }, 400);
        }
        throw error;
      }
      patch.editorMode = body.editor_mode;
    }

    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "paused") {
        return context.json({ error: "status must be active or paused" }, 400);
      }
      patch.status = body.status;
    }

    // Recompute nextRunAt per onyx's rules: schedule/recurrence changed or becoming active.
    const effectiveStatus = patch.status ?? task.status;
    const cronChanged =
      patch.cronExpression !== undefined &&
      patch.cronExpression !== task.cronExpression;
    if (patch.status === "paused") {
      patch.nextRunAt = null;
    } else if (
      patch.status === "active" ||
      (cronChanged && effectiveStatus === "active")
    ) {
      const cron = patch.cronExpression ?? task.cronExpression;
      try {
        patch.nextRunAt = computeNextRunAt(cron, new Date());
      } catch (error) {
        if (error instanceof ScheduleRefusedError) {
          return context.json({ error: error.message }, 400);
        }
        throw error;
      }
    }

    const updated = await deps.tasks.updateTask(task.id, patch);
    if (!updated)
      return context.json({ error: "Scheduled task not found" }, 404);
    const lastRun = await deps.tasks.latestRun(task.id);
    return context.json(taskDetail(updated, lastRun));
  });

  // ── DELETE /scheduled-tasks/:id ───────────────────────────────────────────
  app.delete("/scheduled-tasks/:id", async (context) => {
    await deps.tasks.softDeleteTask(context.req.param("id"), actorId(context));
    return context.body(null, 204);
  });

  // ── POST /scheduled-tasks/:id/run(+/run-now) ──────────────────────────────
  // One handler, two names: onyx's verb is `/{task_id}/run-now`; `/run` is this port's
  // earlier name, kept answering so existing clients do not break on the rename.
  app.on(
    "POST",
    ["/scheduled-tasks/:id/run", "/scheduled-tasks/:id/run-now"],
    async (context) => {
      const task = await resolveTask(context, context.req.param("id"));
      if (!task)
        return context.json({ error: "Scheduled task not found" }, 404);
      const run = await deps.tasks.insertRun(
        task.id,
        "manual_run_now",
        "queued",
      );
      deps.enqueueRun(run.id);
      return context.json({ run_id: run.id, status: run.status });
    },
  );

  // ── GET /scheduled-tasks/:id/runs ─────────────────────────────────────────
  app.get("/scheduled-tasks/:id/runs", async (context) => {
    const task = await resolveTask(context, context.req.param("id"));
    if (!task) return context.json({ error: "Scheduled task not found" }, 404);
    const limitParam = Number.parseInt(context.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(limitParam, 1), 100)
      : RUNS_DEFAULT_PAGE_SIZE;
    const runs = await deps.tasks.listRuns(task.id, limit);
    return context.json({ items: runs.map(runResponse) });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Scheduled-run observation routes (onyx session/api.py:838-983)
// ---------------------------------------------------------------------------

/** The data frames that end the stream, byte-identical to the turn SSE contract. */
const TERMINAL_STREAM_EVENT_TYPES = new Set(["prompt_response", "error"]);

function formatStreamError(detail: string): string {
  const payload = {
    type: "error",
    message: detail,
    timestamp: new Date().toISOString(),
  };
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ScheduledRunRoutesDeps = {
  tasks: CraftScheduledTaskStore;
  /** Session reads WITHOUT the activity bump — the poll must not feed the idle clock. */
  store: CraftStore;
  config: CraftConfig;
  manager: CraftSessionManager;
  /** Resolves the Bot whose sandbox hosts the session (live attach routing). */
  botIdFor: (sessionId: string) => Promise<string | null>;
};

/**
 * The two session-scoped observation endpoints a scheduled run's viewer uses, mounted beside the
 * task routes under the same `enableScheduledTasks` gate:
 *
 * - `GET /sessions/:sessionId/scheduled-run-context` — the banner's one read. 404 means "this
 *   session is not a scheduled run, behave normally" (onyx's exact contract).
 * - `GET /sessions/:sessionId/scheduled-run-events` — the live attach. Same wire as the turn SSE
 *   (`event: message` frames, keepalive comments, terminal close): poll until the run's session
 *   carries an opencode id, then subscribe to the same bus stream the executor drives —
 *   translate-only, never persisting (the durable rows are the executor's, onyx §7.3-8).
 */
export function createScheduledRunRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: ScheduledRunRoutesDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  // ── GET /sessions/:sessionId/scheduled-run-context ────────────────────────
  app.get("/sessions/:sessionId/scheduled-run-context", async (context) => {
    const runContext = await deps.tasks.getRunContextForSession(
      context.req.param("sessionId"),
      context.var.actor.id,
    );
    if (!runContext) {
      return context.json(
        { error: "Session has no scheduled-run context" },
        404,
      );
    }
    return context.json({
      run_id: runContext.runId,
      task_id: runContext.taskId,
      task_name: runContext.taskName,
      status: runContext.status,
      started_at: runContext.startedAt.toISOString(),
      finished_at: runContext.finishedAt
        ? runContext.finishedAt.toISOString()
        : null,
    });
  });

  // ── GET /sessions/:sessionId/scheduled-run-events ─────────────────────────
  app.get("/sessions/:sessionId/scheduled-run-events", async (context) => {
    const userId = context.var.actor.id;
    const sessionId = context.req.param("sessionId");

    const runContext = await deps.tasks.getRunContextForSession(
      sessionId,
      userId,
    );
    if (!runContext) {
      return context.json(
        { error: "Session has no scheduled-run context" },
        404,
      );
    }
    if (runContext.status !== "running") {
      // onyx: CONFLICT — a queued/succeeded/failed run has no live stream to attach to.
      return context.json({ error: "Scheduled run is not running" }, 409);
    }
    const runId = runContext.runId;

    // The flag lives outside `start` so `cancel` (client disconnect) reaches it too;
    // otherwise the attach loop and its live subscription run on for the whole run.
    let live = true;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        live = false;
      },
      start(controller) {
        const encoder = new TextEncoder();
        const guard = (text: string) => {
          if (!live) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // Client gone; the abort path closes us out.
          }
        };

        void (async () => {
          try {
            // Phase 1: the executor links run.session_id just before it resolves and persists
            // the session's opencode id — keep the stream alive across that short handoff so a
            // fast click from the run table attaches without a visible error (onyx's loop).
            let session: Awaited<ReturnType<typeof deps.store.findSession>>;
            for (;;) {
              if (!live) return;
              const run = await deps.tasks.getRun(runId);
              if (run?.status !== "running") return; // resolved mid-poll; rows are the truth
              session = await deps.store.findSession(sessionId, userId);
              if (!session) {
                guard(formatStreamError("Session not found"));
                return;
              }
              if (session.opencodeSessionId) break;
              guard(SSE_KEEPALIVE);
              await sleep(deps.config.pollIntervalSeconds * 1000);
            }

            // Live attach: translate-only forwarding over the same bus the executor drives.
            const botId = await deps.botIdFor(sessionId);
            if (!botId) {
              guard(
                formatStreamError("No sandbox configured for this session."),
              );
              return;
            }
            const events = deps.manager.subscribeToExistingSessionEvents({
              session,
              botId,
              keepaliveSeconds: deps.config.sseKeepaliveIntervalSeconds,
            });
            for await (const event of events) {
              if (!live) return;
              const frame = eventToSse(event);
              guard(frame);
              const chunkType = isKeepalive(event)
                ? null
                : isBuildPacket(event)
                  ? event.type
                  : isPromptResponse(event)
                    ? "prompt_response"
                    : isSandboxError(event)
                      ? "error"
                      : "unknown";
              if (
                chunkType !== null &&
                TERMINAL_STREAM_EVENT_TYPES.has(chunkType)
              ) {
                return;
              }
              // The run resolved without a terminal frame (executor crashed mid-drive): end
              // cleanly — the messages endpoint holds the durable truth (onyx's per-chunk check).
              const run = await deps.tasks.getRun(runId);
              if (run?.status !== "running") return;
            }
          } catch (error) {
            guard(formatStreamError(String(error)));
          } finally {
            live = false;
            try {
              controller.close();
            } catch {
              // Already closed by client disconnect.
            }
          }
        })();
      },
    });

    return new Response(stream, { status: 200, headers: CRAFT_SSE_HEADERS });
  });

  return app;
}
