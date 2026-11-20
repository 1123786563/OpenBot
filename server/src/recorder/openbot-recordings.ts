import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type RecordingDetail,
  type RecordingEvent,
  type RecordingRow,
  type RecordingsPage,
  recordingIdSchema,
} from "@openbot/shared/recorder-api";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import {
  recorderConnections as connections,
  recorderRecordingEvents as events,
  recorderRecordings as recordings,
  recorderCaptureTrajectories as trajectories,
} from "../db/schema/recorder";
import { withdrawLearningEvidence } from "../learning/evidence";
import { decodeCursor, encodeCursor } from "./trajectory-bindings";

const GRANT_LIFETIME = 5 * 60_000;
const PAGE_SIZE = 50;
const DETAIL_PAGE_SIZE = 100;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Scope = { userId: string; connectionId: string; trajectoryId: string };

function toRow(record: typeof recordings.$inferSelect): RecordingRow {
  return {
    id: record.id,
    title: record.title,
    recordedAt: record.createdAt.toISOString(),
    ended:
      record.outcome ??
      (Date.now() - record.createdAt.getTime() < 10 * 60_000
        ? "sending"
        : "unknown"),
    reason: record.reason,
  };
}

function visible(userId: string) {
  return and(
    eq(recordings.userId, userId),
    isNull(recordings.deletedAt),
    isNotNull(recordings.outcomeSeq),
  );
}

export function createOpenBotRecordings(database: Database, secret: string) {
  function signature(scope: Scope, expiresAt: number) {
    return createHmac("sha256", secret)
      .update(
        JSON.stringify([
          "openbot-recorder-grant-v1",
          scope.userId,
          scope.connectionId,
          scope.trajectoryId,
          expiresAt,
        ]),
      )
      .digest("base64url");
  }

  function authenticatedExpiry(scope: Scope, token: string) {
    const [expiry, mac, extra] = token.split(".");
    const expiresAt = Number(expiry);
    if (!mac || extra !== undefined || !Number.isSafeInteger(expiresAt))
      return null;
    const expected = Buffer.from(signature(scope, expiresAt));
    const provided = Buffer.from(mac);
    return provided.length === expected.length &&
      timingSafeEqual(provided, expected)
      ? expiresAt
      : null;
  }

  async function liveConnection(tx: Transaction, scope: Scope) {
    const [row] = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.id, scope.connectionId),
          eq(connections.userId, scope.userId),
          isNull(connections.revokedAt),
        ),
      )
      .for("share");
    return row !== undefined;
  }

  async function purge(tx: Transaction, id: string, userId: string) {
    await withdrawLearningEvidence(tx, userId, { kind: "recording", id });
    await tx.delete(events).where(eq(events.recordingId, id));
    // The retained row is both the revocation marker and the completion record for the online content copy.
    await tx
      .update(recordings)
      .set({
        title: null,
        reason: null,
        outcome: null,
        outcomeSeq: null,
        deletedAt: sql`now()`,
        cleanupCompletedAt: sql`now()`,
      })
      .where(eq(recordings.id, id));
  }

  return {
    async grant(scope: Scope, recordingId: string) {
      const result = await database.transaction(async (tx) => {
        if (!(await liveConnection(tx, scope))) return "signed-out";
        const [existing] = await tx
          .select()
          .from(trajectories)
          .where(eq(trajectories.id, scope.trajectoryId));
        if (existing && existing.recordingId !== recordingId)
          return "not-found";
        await tx
          .insert(recordings)
          .values({ id: recordingId, userId: scope.userId })
          .onConflictDoNothing();
        const [owned] = await tx
          .select()
          .from(recordings)
          .where(
            and(
              eq(recordings.id, recordingId),
              eq(recordings.userId, scope.userId),
              isNull(recordings.deletedAt),
            ),
          )
          .for("update");
        if (!owned) return "not-found";
        await tx
          .insert(trajectories)
          .values({ id: scope.trajectoryId, recordingId })
          .onConflictDoNothing();
        const [bound] = await tx
          .select()
          .from(trajectories)
          .where(eq(trajectories.id, scope.trajectoryId));
        return bound?.recordingId === recordingId ? "granted" : "not-found";
      });
      if (result !== "granted") return { kind: result };
      const expiresAt = Date.now() + GRANT_LIFETIME;
      return {
        kind: "openbot" as const,
        token: `${expiresAt}.${signature(scope, expiresAt)}`,
      };
    },

    async submit(scope: Scope, captureToken: string, batch: RecordingEvent[]) {
      const expiresAt = authenticatedExpiry(scope, captureToken);
      if (expiresAt === null) return { kind: "invalid-grant" as const };
      return database.transaction(async (tx) => {
        if (!(await liveConnection(tx, scope)))
          return { kind: "signed-out" as const };
        const [record] = await tx
          .select({ id: recordings.id, outcomeSeq: recordings.outcomeSeq })
          .from(trajectories)
          .innerJoin(recordings, eq(recordings.id, trajectories.recordingId))
          .where(
            and(
              eq(trajectories.id, scope.trajectoryId),
              eq(recordings.userId, scope.userId),
              isNull(recordings.deletedAt),
            ),
          )
          .for("update", { of: recordings });
        if (expiresAt <= Date.now()) return { kind: "expired-grant" as const };
        if (!record) return { kind: "not-found" as const };
        const inserted =
          batch.length === 0
            ? []
            : await tx
                .insert(events)
                .values(
                  batch.map((event) => ({
                    recordingId: record.id,
                    seq: event.value.seq,
                    event,
                  })),
                )
                .onConflictDoNothing()
                .returning({ event: events.event });
        const latest = inserted
          .map(({ event }) => event)
          .filter(
            (event) =>
              event.name === "outcome" &&
              event.value.seq > (record.outcomeSeq ?? 0),
          )
          .sort((a, b) => b.value.seq - a.value.seq)
          .find(
            ({ value }) =>
              typeof value.workflow === "string" &&
              ["started", "succeeded", "failed"].some(
                (phase) => phase === value.phase,
              ),
          );
        if (latest) {
          const { seq, workflow, phase, reason } = latest.value;
          if (
            phase === "failed" &&
            (reason === "discarded" || reason === "restarted")
          ) {
            await purge(tx, record.id, scope.userId);
          } else {
            await tx
              .update(recordings)
              .set({
                title:
                  typeof workflow === "string" ? workflow.slice(0, 200) : null,
                outcome:
                  phase === "succeeded"
                    ? "succeeded"
                    : phase === "failed"
                      ? "stopped"
                      : null,
                reason:
                  phase === "failed" && typeof reason === "string"
                    ? reason.slice(0, 200)
                    : null,
                outcomeSeq: seq,
              })
              .where(eq(recordings.id, record.id));
          }
        }
        return {
          kind: "accepted" as const,
          ack: {
            accepted: batch.length,
            rejected: 0,
            highestSeq: batch.length
              ? Math.max(...batch.map((event) => event.value.seq))
              : null,
          },
        };
      });
    },

    async list(userId: string, cursor: string | null): Promise<RecordingsPage> {
      const after = cursor === null ? undefined : decodeCursor(cursor);
      const rows = await database
        .select()
        .from(recordings)
        .where(
          and(
            visible(userId),
            after &&
              sql`(${recordings.createdAt}, ${recordings.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.trajectoryId}::uuid)`,
          ),
        )
        .orderBy(desc(recordings.createdAt), desc(recordings.id))
        .limit(PAGE_SIZE + 1);
      const last = rows[PAGE_SIZE - 1];
      return {
        canManage: true,
        recordings: rows.slice(0, PAGE_SIZE).map(toRow),
        nextCursor:
          rows.length > PAGE_SIZE && last
            ? encodeCursor({ createdAt: last.createdAt, trajectoryId: last.id })
            : null,
      };
    },

    async detail(
      userId: string,
      id: string,
      after: number,
    ): Promise<RecordingDetail | null> {
      return database.transaction(async (tx) => {
        const [record] = await tx
          .select()
          .from(recordings)
          .where(and(visible(userId), eq(recordings.id, id)))
          .for("share");
        if (!record) return null;
        const rows = await tx
          .select()
          .from(events)
          .where(and(eq(events.recordingId, id), gt(events.seq, after)))
          .orderBy(asc(events.seq))
          .limit(DETAIL_PAGE_SIZE + 1);
        return {
          ...toRow(record),
          events: rows.slice(0, DETAIL_PAGE_SIZE).map(({ event }) => event),
          nextSeq:
            rows.length > DETAIL_PAGE_SIZE
              ? (rows[DETAIL_PAGE_SIZE - 1]?.seq ?? null)
              : null,
        };
      });
    },

    async remove(userId: string, id: string) {
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: recordings.id })
          .from(recordings)
          .where(and(visible(userId), eq(recordings.id, id)))
          .for("update");
        if (!row) return false;
        await purge(tx, id, userId);
        return true;
      });
    },

    async recordingTitles(userId: string, ids: string[]) {
      const candidates = ids.flatMap((id) => {
        const parsed = recordingIdSchema.safeParse(id);
        return parsed.success ? [parsed.data] : [];
      });
      if (candidates.length === 0) return new Map<string, string | null>();
      const rows = await database
        .select({ id: recordings.id, title: recordings.title })
        .from(recordings)
        .where(
          and(
            visible(userId),
            inArray(recordings.id, candidates),
            isNotNull(recordings.outcome),
          ),
        );
      return new Map(rows.map(({ id, title }) => [id, title]));
    },
  };
}
