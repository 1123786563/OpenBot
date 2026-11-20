import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { personalWorkspaceClosures } from "../db/schema/personal-saas";

export async function workspaceClosure(
  database: Pick<Database, "select">,
  accountId: string,
) {
  const [record] = await database
    .select()
    .from(personalWorkspaceClosures)
    .where(eq(personalWorkspaceClosures.accountId, accountId));
  return record;
}

export function closureProgress(
  record: typeof personalWorkspaceClosures.$inferSelect,
) {
  return {
    operationId: record.id,
    cutoffDeadline: record.cutoffDeadline,
    executionCutoff: {
      sessions: "revoked",
      work: record.workCutoff ?? "pending",
      computer: record.computerCutoff ?? "pending",
    },
    onlineCleanup: "pending",
    remoteRevocation: "pending",
    backups: "pending",
  };
}
