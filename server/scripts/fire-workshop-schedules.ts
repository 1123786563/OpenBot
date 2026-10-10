/**
 * One workshop-schedule sweep: fire every due schedule exactly once.
 *
 * Run from a CronJob rather than a timer inside the API, for fire-routines' reason: every
 * replica would wake its own timer, and while the run row's unique key keeps the FIRING single,
 * noticing is still work best done by one scheduled process rather than N. The double-fire
 * guarantee itself lives in the database (unique(scheduleId, scheduledFor)), not here — this
 * script is only the passer-by that looks.
 *
 * Exits non-zero only when the pass itself could not run — no database, no orchestrator. A
 * single schedule that failed to fire is a row with a note, and the schedule's advanced
 * nextRunAt keeps the recurrence alive for the next sweep.
 */
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { sweepWorkshopSchedules } from "../src/workshop/schedule-executor";

const config = loadConfig(process.env);
const database = createDatabase(process.env.DATABASE_URL ?? "");

// The enqueue a firing hands the turn to: the workshop routes' own orchestrator path, reached
// through the store the server mounts. Kept as a thin import so the script stays one pass.
const { createWorkshopStore } = await import("../src/workshop/store");
const { createTurnOrchestrator } = await import("../src/workshop/orchestrator");
const { createInProcessTurnLock } = await import("../src/workshop/locks");

const store = createWorkshopStore(database);
const orchestrator = createTurnOrchestrator({
  store,
  lock: createInProcessTurnLock(),
  gatewayFor: () => {
    // A CronJob pass has no sandbox client and no gateway: the fired turn's gateway is the
    // server's own (the turn row carries the session; the runner picks it up). Returning a
    // refusing stub keeps the type honest while the enqueue path — this script's only need —
    // works through the store.
    throw new Error("The sweep script does not run turns itself.");
  },
  auditStore: undefined,
});

const report = await sweepWorkshopSchedules({
  db: database,
  enqueue: async (input) => {
    const { turnId } = await orchestrator.enqueue({
      sessionId: input.sessionId,
      prompt: input.prompt,
      actorUserId: input.actorUserId,
      botId: "workshop-schedule",
      ownerUserId: input.actorUserId,
      initiator: input.initiator,
    });
    return turnId;
  },
});

console.log(
  `workshop schedules: ${report.fired} fired, ${report.already} already claimed, ${report.refused} refused`,
);
process.exit(0);
