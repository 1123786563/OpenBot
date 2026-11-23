import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../src/db/client";
import {
  responsibilities,
  responsibilityRuns,
  workItems,
} from "../../src/db/schema";
import { RESPONSIBILITY_RUN_KIND } from "../../src/responsibilities/engine";

/**
 * Remove the work items the given people's Approvals and goal runs queued.
 *
 * The queue hands a due item to whichever sweep asks next, whatever owner queued it, and a sweep
 * takes the oldest few. A test that leaves items behind therefore has the next file's sweep run
 * them first and run out of room for its own: call this before the fixture's rows go.
 */
export async function forgetWorkItemsOf(
  database: Database,
  ...owners: string[]
): Promise<void> {
  const runs = database
    .select({ id: responsibilityRuns.id })
    .from(responsibilityRuns)
    .innerJoin(
      responsibilities,
      eq(responsibilityRuns.responsibilityId, responsibilities.id),
    )
    .where(inArray(responsibilities.ownerUserId, owners));
  // A run's items are keyed by more than the run: `<run>:resume:<id>` is a later turn of the same run.
  await database
    .delete(workItems)
    .where(
      and(
        eq(workItems.kind, RESPONSIBILITY_RUN_KIND),
        inArray(sql`${workItems.payload}->>'runId'`, runs),
      ),
    );
  // Read from the item, not the Approval: a fixture that has already removed its people has taken
  // their Approvals with it.
  await database
    .delete(workItems)
    .where(
      and(
        eq(workItems.kind, "approval.resume"),
        inArray(sql`${workItems.payload}->>'ownerUserId'`, owners),
      ),
    );
}
