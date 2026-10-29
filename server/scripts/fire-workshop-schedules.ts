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
import { createDatabase } from "../src/db/client";
import { sweepWorkshopSchedules } from "../src/workshop/schedule-executor";

const database = createDatabase(process.env.DATABASE_URL ?? "");

// The enqueue a firing hands the turn to: the turn row, reached through the store the server
// mounts. NOT the orchestrator — its enqueue starts the run fire-and-forget, and this pass has
// no gateway, so the run would fail the turn the moment it was created. The queued row is
// picked up by the server's runner, which is the only party that owns a gateway.
const { createWorkshopStore } = await import("../src/workshop/store");

const store = createWorkshopStore(database);

const report = await sweepWorkshopSchedules({
  db: database,
  enqueue: async (input) => {
    const row = await store.enqueueTurn({
      sessionId: input.sessionId,
      prompt: input.prompt,
      // The orchestrator's own mapping: a routine initiator is a machine's turn.
      initiator: "headless",
    });
    return row.id;
  },
});

console.log(
  `workshop schedules: ${report.fired} fired, ${report.already} already claimed, ${report.refused} refused`,
);
process.exit(0);
