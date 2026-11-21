import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  personalWorkspaceClosures,
  personalWorkspaces,
} from "../db/schema/personal-saas";

import { cleanupSteps, onlineCleanupSteps } from "./closure-cleanup-contract";

export async function workspaceClosure(
  database: Pick<Database, "select">,
  accountId: string,
) {
  const [record] = await database
    .select({ closure: personalWorkspaceClosures })
    .from(personalWorkspaceClosures)
    .leftJoin(personalWorkspaces, eq(personalWorkspaces.ownerId, accountId))
    .where(
      and(
        eq(personalWorkspaceClosures.accountId, accountId),
        or(
          isNull(personalWorkspaces.id),
          eq(personalWorkspaceClosures.workspaceId, personalWorkspaces.id),
        ),
      ),
    )
    .orderBy(
      desc(personalWorkspaceClosures.acceptedAt),
      desc(personalWorkspaceClosures.id),
    )
    .limit(1);
  return record?.closure;
}

export function cleanupConfirmed(
  record: typeof personalWorkspaceClosures.$inferSelect,
) {
  // PostgreSQL cleanup requires drained work, and volume cleanup requires
  // observed Computer exit. Preserve the original cutoff deadline outcome.
  return Boolean(
    record.workCutoff &&
      record.computerCutoff &&
      cleanupSteps.every(
        (step) => record.cleanup[step]?.status === "confirmed",
      ),
  );
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
    onlineCleanup: Object.fromEntries(
      onlineCleanupSteps.map((step) => [
        step,
        record.cleanup[step] ?? { status: "pending" },
      ]),
    ),
    remoteRevocation: record.cleanup.connections ?? { status: "pending" },
    backups: record.backupSchedule
      ? { status: "scheduled", stores: record.backupSchedule }
      : { status: "pending", stores: [] },
  };
}
