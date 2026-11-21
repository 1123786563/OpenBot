import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  opikEvaluations as evaluations,
  opikEvaluationGrants as grants,
} from "../db/schema";
import { type OpikConfig, opikFetch } from "./client";

const retryMs = 60_000;
const lateWriteGraceMs = 10 * retryMs;

type Destination = {
  target: string | null;
  workspace: string | null;
  project: string;
};

export function matchesEvaluationDestination(
  config: OpikConfig,
  row: Destination,
) {
  return (
    row.target === config.apiUrl.href &&
    row.workspace === (config.workspace ?? null) &&
    row.project === config.project
  );
}

export async function deleteEvaluationCopy(config: OpikConfig, id: string) {
  const request = opikFetch(config, 5000);
  const path = `traces/${encodeURIComponent(id)}`;
  const removed = await request(path, "DELETE");
  await removed.body?.cancel();
  if (!removed.ok && removed.status !== 404)
    throw new Error("Opik deletion failed");
  const checked = await request(path, "GET");
  await checked.body?.cancel();
  if (checked.status !== 404)
    throw new Error("Opik deletion has not been verified");
}

export async function sweepEvaluationCleanup(
  database: Database,
  config: OpikConfig,
  now = Date.now,
) {
  for (let count = 0; count < 100; count++) {
    const checked = await database.transaction(async (tx) => {
      const at = new Date(now());
      const [job] = await tx
        .select({
          id: evaluations.id,
          firstDeletedAt: evaluations.cleanupFirstDeletedAt,
        })
        .from(evaluations)
        .innerJoin(grants, eq(evaluations.requestId, grants.id))
        .where(
          and(
            eq(evaluations.kind, "real"),
            eq(evaluations.target, config.apiUrl.href),
            eq(evaluations.project, config.project),
            sql`${evaluations.workspace} is not distinct from ${config.workspace ?? null}::text`,
            isNotNull(grants.revokedAt),
            isNull(evaluations.cleanupCompletedAt),
            or(
              isNull(evaluations.cleanupDueAt),
              lte(evaluations.cleanupDueAt, at),
            ),
          ),
        )
        .orderBy(
          asc(evaluations.cleanupDueAt),
          asc(grants.revokedAt),
          asc(evaluations.id),
        )
        .limit(1)
        .for("update", { of: evaluations, skipLocked: true });
      if (!job) return false;

      try {
        await deleteEvaluationCopy(config, job.id);
        const deletedAt = new Date(now());
        await tx
          .update(evaluations)
          .set(
            job.firstDeletedAt
              ? { cleanupCompletedAt: deletedAt }
              : {
                  cleanupFirstDeletedAt: deletedAt,
                  cleanupDueAt: new Date(
                    deletedAt.getTime() + lateWriteGraceMs,
                  ),
                },
          )
          .where(eq(evaluations.id, job.id));
      } catch {
        await tx
          .update(evaluations)
          .set({ cleanupDueAt: new Date(now() + retryMs) })
          .where(eq(evaluations.id, job.id));
        console.warn(
          JSON.stringify({
            type: "opik_evaluation_cleanup_retry",
            traceId: job.id,
          }),
        );
      }
      return true;
    });
    if (!checked) return;
  }
}
