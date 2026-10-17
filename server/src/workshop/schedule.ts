import { CronExpressionParser } from "cron-parser";

/**
 * The workshop's schedule compiler and CRUD rules (B17).
 *
 * ONE REPRESENTATION, ALREADY LANDED. The `workshop_schedules` table (B16, 0069) carries its
 * recurrence as TEXT in an `rrule` column, and the repository's proven recurrence machinery —
 * cron-parser, the five-field contract, the 15-minute floor, timezone vetting — speaks
 * five-field CRON, not RFC 5545. Rather than add an RRULE library or reshape the column, this
 * compiler WRITES five-field cron text into that column: the field is "the machine-readable
 * recurrence, as text", and cron is this repository's dialect of it. (The routines floor does
 * not apply here — a workshop may fire hourly — but the parser, the field-count contract and
 * the timezone check are reused whole; only the minimum-interval refusal is not inherited.)
 *
 * THREE MODES, ONE OUTPUT: interval (every N minutes/hours/days), daily (a wall-clock time on
 * chosen weekdays, every day by default), and advanced (the caller's own five-field cron,
 * validated before it lands). The compiled string is what the executor and the UI both read;
 * the modes exist only to make the common cases un-typeable-wrong.
 *
 * PREAPPROVAL IS A PROMISE THE EXECUTOR CASHES: the jsonb shape below is written at creation
 * and consumed by the executor (B18) as the boundary of what a fired turn may do unasked —
 * tool calls outside it still route through approval, and the agent layer holds that line.
 */
export const WORKSHOP_MIN_INTERVAL_MS = 60 * 1000;

export class WorkshopScheduleRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkshopScheduleRefusedError";
  }
}

const UNREADABLE = "That schedule could not be read.";
const UNKNOWN_ZONE = "That is not a timezone I know.";
const TOO_FREQUENT = "Workshop schedules may run at most once a minute.";
const BAD_TIME = "A daily time is HH:MM on a 24-hour clock.";

export type IntervalUnit = "minutes" | "hours" | "days";

/** Every N of one unit. The every-N shape cron spells with a step on the right field. */
export function compileInterval(input: {
  every: number;
  unit: IntervalUnit;
}): string {
  // A fractional every is a refusal, not a floor: "every 3.7 hours" is a caller who means
  // something the composer cannot say, and guessing which side of 3.7 they meant is worse
  // than asking.
  const every = input.every;
  if (
    !Number.isFinite(every) ||
    !Number.isInteger(every) ||
    every < 1 ||
    every > 10_000
  ) {
    throw new WorkshopScheduleRefusedError(UNREADABLE);
  }
  switch (input.unit) {
    case "minutes":
      return `*/${every} * * * *`;
    case "hours":
      return `0 */${every} * * *`;
    case "days":
      return `0 0 */${every} * *`;
    default:
      throw new WorkshopScheduleRefusedError(UNREADABLE);
  }
}

const WEEKDAY_CRON = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayInput = (typeof WEEKDAY_CRON)[number];

/**
 * A wall-clock time, on chosen weekdays (or every day when `days` is absent or empty). The
 * week spells itself in cron's own names — `mon-fri`, `sat,sun` — because a day list is
 * clearer to a reader than a bitmask and the parser accepts both.
 */
export function compileDaily(input: {
  time: string;
  days?: WeekdayInput[];
}): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.time.trim());
  if (!match) throw new WorkshopScheduleRefusedError(BAD_TIME);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new WorkshopScheduleRefusedError(BAD_TIME);
  }
  const days = [...new Set(input.days ?? [])].sort(
    (a, b) => WEEKDAY_CRON.indexOf(a) - WEEKDAY_CRON.indexOf(b),
  );
  const dayField = days.length > 0 && days.length < 7 ? days.join(",") : "*";
  return `${minutes} ${hours} * * ${dayField}`;
}

/** The caller's own five-field cron, validated (field count, parseability, zone) before landing. */
export function compileAdvanced(cron: string, timezone: string): string {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new WorkshopScheduleRefusedError(UNREADABLE);
  }
  // Validate by computing a real next occurrence — the same path the executor walks — with
  // the floor check disabled by asking from a fixed past moment (the routines floor does not
  // apply; see the file's head).
  nextRunAt(cron, timezone, new Date("2024-01-01T00:00:00Z").getTime());
  return cron.trim();
}

/**
 * The next firing after `fromMs`. cron-parser is strict-after `currentDate`, so a schedule
 * firing at 09:00 asked about at 09:00 answers 09:00 TOMORROW — exactly the executor's need
 * (the firing at 09:00 belongs to the pass that noticed it, not the one after).
 */
export function nextRunAt(
  cron: string,
  timezone: string,
  fromMs: number,
): Date {
  // The five-field contract, restated locally so the check cannot drift behind an import.
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new WorkshopScheduleRefusedError(UNREADABLE);
  }
  let zoneKnown = true;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    zoneKnown = false;
  }
  if (!zoneKnown) throw new WorkshopScheduleRefusedError(UNKNOWN_ZONE);

  let fired: Date;
  try {
    const expression = CronExpressionParser.parse(cron, {
      tz: timezone,
      currentDate: new Date(fromMs),
    });
    fired = expression.next().toDate();
  } catch {
    throw new WorkshopScheduleRefusedError(UNREADABLE);
  }
  // The floor reads the EXPRESSION, not the measured gap: a */2 schedule asked about at an
  // odd second fires in under a minute from "now", and measuring would refuse a legal
  // expression because of when the question was asked. Only every-minute shapes are sub-floor.
  const minuteField = cron.trim().split(/\s+/)[0] ?? "";
  if (minuteField === "*" || minuteField === "*/1") {
    throw new WorkshopScheduleRefusedError(TOO_FREQUENT);
  }
  return fired;
}

/**
 * The preapproval shape: what a fired turn may do WITHOUT asking. Written at creation,
 * consumed by the executor as a boundary, and enforced beyond it by the agent layer's
 * approval routing (see schedule-executor.ts's boundary note).
 */
export type SchedulePreapproval = {
  /** File path prefixes a fired turn may read/write without approval. */
  paths: string[];
  /** Tool names a fired turn may call without approval. */
  tools: string[];
  /** The ceiling on turns per firing; over it, the firing stops rather than asks. */
  maxTurnsPerRun: number;
};

export function parsePreapproval(raw: unknown): SchedulePreapproval {
  const source = (raw ?? {}) as Partial<SchedulePreapproval>;
  const paths = Array.isArray(source.paths)
    ? source.paths.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
  const tools = Array.isArray(source.tools)
    ? source.tools.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
  const maxTurnsPerRun =
    typeof source.maxTurnsPerRun === "number" &&
    Number.isFinite(source.maxTurnsPerRun)
      ? Math.max(1, Math.min(Math.floor(source.maxTurnsPerRun), 20))
      : 3;
  return { paths, tools, maxTurnsPerRun };
}

/**
 * The CRUD rules every route applies: what may change, and what a change recomputes. The
 * store owns the rows; this owns the INVARIANTS — nextRunAt is never stale after a write,
 * disabled schedules hold no due moment, and the recurrence is compiled or refused before it
 * ever reaches the database.
 */
export type ScheduleDraft = {
  prompt: string;
  rrule: string;
  timezone: string;
  status: "enabled" | "paused";
  preapproval: SchedulePreapproval;
};

export function draftForCreate(input: {
  prompt: string;
  mode:
    | { kind: "interval"; every: number; unit: IntervalUnit }
    | { kind: "daily"; time: string; days?: WeekdayInput[] }
    | { kind: "advanced"; cron: string };
  timezone: string;
  preapproval?: unknown;
}): ScheduleDraft {
  if (!input.prompt.trim()) {
    throw new WorkshopScheduleRefusedError(
      "A schedule needs a prompt to fire.",
    );
  }
  const rrule =
    input.mode.kind === "interval"
      ? compileInterval(input.mode)
      : input.mode.kind === "daily"
        ? compileDaily(input.mode)
        : compileAdvanced(input.mode.cron, input.timezone);
  // The first due moment is validated here so a refused recurrence never reaches the store;
  // the writer recomputes it at insert time so it is never a stale sentence about the past.
  nextRunAt(rrule, input.timezone, Date.now());
  return {
    prompt: input.prompt.trim(),
    rrule,
    timezone: input.timezone,
    status: "enabled",
    preapproval: parsePreapproval(input.preapproval),
  };
}
