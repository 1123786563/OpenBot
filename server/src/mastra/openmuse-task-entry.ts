/**
 * ME12 (#484): the OpenMuse Task queue entry on the governed headless turn.
 *
 * The OpenMuse Task runner (openmuse-tasks/runner.ts) is the ONE main-repo
 * assembled OpenMuse call that runs an OpenBot Bot turn: a claimed Task row
 * runs ONE headless turn for the owner's private OpenMuse Bot. This adapter
 * gives that entry the SAME record authority every other unattended entry
 * runs under: the TASK ROW is re-read at the moment of running — a settled,
 * cancelled-by-CAS or deleted row refuses by name before anything is
 * admitted, and a queue payload is a claim about the row, never a
 * substitute for it.
 *
 * The instruction is the row's own words: the Task prompt, or — for a plan
 * — the title of the step the claim's queued→running CAS marked (the graph's
 * own words for what this turn does; a plan without a running step is not a
 * runnable claim). The identity is the row's owner and Bot, and the
 * conversation is the owner's own thread with that Bot — resolved by the
 * injected channel seam, the SAME resolution the legacy runner applies.
 * Budget, scope re-signing, the admission intent, the lease, the settlement
 * and the model route are the shared governed base; the entry contributes
 * nothing of its own. The cancel/pause flags stay OFF the record gate: a
 * cancel that lands mid-turn settles at the turn's end (the sweep's safe
 * boundary), exactly as it always has — refusing the turn here would land
 * the row failed instead of cancelled-with-note.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { openmuseTasks } from "../db/schema/openmuse";
import type { OpenMuseTaskStep } from "../openmuse-tasks/public";
import type { GovernedSchedulingRecord } from "./headless";

/** The routineId prefix the Task runner names every turn with. */
export const OPENMUSE_TASK_ROUTINE_PREFIX = "openmuse-task:";

export function openMuseTaskSchedulingRecordFor(options: {
  database: Pick<Database, "select">;
  /**
   * The owner's own conversation thread with this Bot — the same
   * get-or-create resolution the legacy runner applies before every Task
   * turn. Null (a gone channel) is a gone record.
   */
  channelThreadIdFor: (input: {
    ownerUserId: string;
    botId: string;
  }) => Promise<string | null>;
}): (routineId: string) => Promise<GovernedSchedulingRecord | null> {
  return async (routineId) => {
    if (!routineId.startsWith(OPENMUSE_TASK_ROUTINE_PREFIX)) return null;
    const taskId = routineId.slice(OPENMUSE_TASK_ROUTINE_PREFIX.length);
    if (!taskId) return null;
    const [row] = await options.database
      .select({
        ownerUserId: openmuseTasks.ownerUserId,
        botId: openmuseTasks.botId,
        kind: openmuseTasks.kind,
        status: openmuseTasks.status,
        prompt: openmuseTasks.prompt,
        steps: openmuseTasks.steps,
      })
      .from(openmuseTasks)
      .where(eq(openmuseTasks.id, taskId))
      .limit(1);
    // A row that is not RUNNING is not a live claim: settled rows are done,
    // queued/scheduled rows belong to a claim that has not taken the
    // status CAS yet. The runner's own generation CAS made it running.
    if (row?.status !== "running") return null;
    let instruction = row.prompt ?? "";
    if (row.kind === "plan") {
      const running = ((row.steps as unknown[]) ?? []).find(
        (step) => (step as OpenMuseTaskStep | undefined)?.status === "running",
      ) as OpenMuseTaskStep | undefined;
      if (!running) return null;
      instruction = running.title;
    }
    const threadId = await options.channelThreadIdFor({
      ownerUserId: row.ownerUserId,
      botId: row.botId,
    });
    if (!threadId) return null;
    return {
      agentId: row.botId,
      threadId,
      instruction,
      enabled: true,
    };
  };
}
