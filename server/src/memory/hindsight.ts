import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  personalMemories,
  hindsightMemoryProjections as projections,
} from "../db/schema/memory";

type MemoryRow = typeof personalMemories.$inferSelect;
type Version = Pick<MemoryRow, "id" | "version">;

const bank = (owner: string) =>
  `openbot-memory-${createHash("sha256").update(owner).digest("hex")}`;
const tag = (row: Version) => `openbot:${row.id}:${row.version}`;
const eligible = and(
  eq(personalMemories.enabled, true),
  isNull(personalMemories.deletedAt),
  inArray(personalMemories.reviewState, ["confirmed", "edited"]),
  ne(personalMemories.content, ""),
);
const checkIntervalMs = 60_000;
const retirementGraceMs = 10 * checkIntervalMs;
const rawTypes = ["world", "experience"] as const;
const recallResponse = z.object({
  results: z.array(
    z.object({
      document_id: z.string(),
      metadata: z.object({ openbot_version: z.uuid() }),
      type: z.enum(rawTypes),
    }),
  ),
});
const successResponse = z.object({ success: z.literal(true) });

export type HindsightConfig = { url: URL; apiKey?: string };

export function createHindsight({
  database,
  url,
  apiKey,
  recallTimeoutMs = 750,
  now = Date.now,
}: HindsightConfig & {
  database: Database;
  recallTimeoutMs?: number;
  now?: () => number;
}) {
  async function request(
    owner: string,
    path: string,
    options: { method: "POST"; body: unknown } | { method: "DELETE" },
    timeout: number,
  ) {
    return fetch(new URL(`/v1/default/banks/${bank(owner)}/${path}`, url), {
      method: options.method,
      headers: {
        ...("body" in options ? { "Content-Type": "application/json" } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: "body" in options ? JSON.stringify(options.body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  }

  return {
    async recall(owner: string, query: string, candidates: Version[]) {
      if (!candidates.length) return [];
      try {
        const response = await request(
          owner,
          "memories/recall",
          {
            method: "POST",
            body: {
              query,
              types: rawTypes,
              budget: "low",
              max_tokens: 2048,
              tags: candidates.map(tag),
              tags_match: "any_strict",
            },
          },
          recallTimeoutMs,
        );
        if (!response.ok) return [];
        const parsed = recallResponse.safeParse(await response.json());
        if (!parsed.success) return [];
        const sent = new Map(candidates.map((row) => [row.id, row.version]));
        return parsed.data.results.flatMap(({ document_id, metadata }) =>
          sent.get(document_id) === metadata.openbot_version
            ? [{ id: document_id, version: metadata.openbot_version }]
            : [],
        );
      } catch {
        return [];
      }
    },
    async sync(canProject: (row: MemoryRow) => Promise<boolean>) {
      const startedAt = new Date(now());
      // Commit the cleanup ledger before sending content. It also covers writes
      // whose acknowledgement was lost and records removed by a cascade.
      await database
        .insert(projections)
        .select(
          database
            .select({
              memoryId: personalMemories.id,
              ownerUserId: personalMemories.ownerUserId,
              projectedVersion: sql<null>`null::uuid`.as("projected_version"),
              firstDeletedAt: sql<null>`null::timestamptz`.as(
                "first_deleted_at",
              ),
              nextCheckAt:
                sql<Date>`${startedAt.toISOString()}::timestamptz`.as(
                  "next_check_at",
                ),
            })
            .from(personalMemories)
            .leftJoin(
              projections,
              eq(projections.memoryId, personalMemories.id),
            )
            .where(and(eligible, isNull(projections.memoryId)))
            .orderBy(asc(personalMemories.createdAt), asc(personalMemories.id))
            .limit(40),
        )
        .onConflictDoNothing();

      const due = await database
        .select({ id: projections.memoryId })
        .from(projections)
        .leftJoin(
          personalMemories,
          eq(personalMemories.id, projections.memoryId),
        )
        .where(
          or(
            lte(projections.nextCheckAt, startedAt),
            and(
              sql`${projections.projectedVersion} IS NOT NULL`,
              sql`${personalMemories.version} IS DISTINCT FROM ${projections.projectedVersion}`,
            ),
          ),
        )
        .orderBy(asc(projections.nextCheckAt), asc(projections.memoryId))
        .limit(40);

      for (const { id } of due) {
        const healthy = await database.transaction(async (tx) => {
          const [job] = await tx
            .select()
            .from(projections)
            .where(eq(projections.memoryId, id))
            .for("update", { skipLocked: true });
          if (!job) return;
          const [row] = await tx
            .select()
            .from(personalMemories)
            .where(eq(personalMemories.id, id));
          const allowed =
            row?.enabled &&
            !row.deletedAt &&
            row.reviewState !== "unreviewed" &&
            !!row.content &&
            (await canProject(row));
          let projectedVersion = job.projectedVersion;
          let firstDeletedAt = job.firstDeletedAt;
          let failed = false;
          try {
            if (allowed && projectedVersion !== row.version) {
              const response = await request(
                job.ownerUserId,
                "memories",
                {
                  method: "POST",
                  body: {
                    items: [
                      {
                        content: row.content,
                        document_id: row.id,
                        metadata: { openbot_version: row.version },
                        tags: [tag(row)],
                      },
                    ],
                  },
                },
                5000,
              );
              if (!response.ok) throw new Error("Hindsight retain failed");
              successResponse.parse(await response.json());
              projectedVersion = row.version;
              firstDeletedAt = null;
            } else if (
              !allowed &&
              (!firstDeletedAt ||
                now() - firstDeletedAt.getTime() >= retirementGraceMs)
            ) {
              const response = await request(
                job.ownerUserId,
                `documents/${encodeURIComponent(id)}`,
                {
                  method: "DELETE",
                },
                5000,
              );
              if (!response.ok && response.status !== 404)
                throw new Error("Hindsight delete failed");
              if (response.ok) successResponse.parse(await response.json());
              if ((!row || row.deletedAt) && firstDeletedAt) {
                await tx
                  .delete(projections)
                  .where(eq(projections.memoryId, id));
                return;
              }
              // A retain may finish after its HTTP acknowledgement times out.
              // Keep the ledger for a second delete after the grace period.
              firstDeletedAt = new Date(now());
              projectedVersion = null;
            }
          } catch {
            // Retry by due time even if open connections are failing for the whole batch.
            projectedVersion = null;
            failed = true;
          }
          await tx
            .update(projections)
            .set({
              projectedVersion,
              firstDeletedAt,
              nextCheckAt: new Date(now() + checkIntervalMs),
            })
            .where(eq(projections.memoryId, id));
          return !failed;
        });
        if (healthy === false)
          throw new Error("Hindsight projection reconciliation failed");
      }
    },
  };
}

export type Hindsight = ReturnType<typeof createHindsight>;
