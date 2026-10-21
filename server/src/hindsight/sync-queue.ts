/**
 * Hindsight 07 (#384): the durable, idempotent sync queue for confirmed personal memories.
 *
 * A confirmation (or edit, or correction) records its intent durably — a work row carrying the
 * digest of the content AS CONFIRMED — and the retain itself may fail without failing the
 * person's decision: the row simply stays pending, and this queue drains it later. The queue
 * is the spec's "persistent background task" identity: it never holds a session scope, and it
 * never chooses a bank — every placement is derived from the row's own attribution through
 * bank-scope.ts (the user bank for preferences, the restriction's bank for source-bound
 * rows), which is why a work row stores principal and tenant but no bank and no document id.
 *
 * The three clauses the ticket names, and where they live:
 *
 *   - Duplicate tasks: the storage layer allows one pending row per subject, so a re-enqueue
 *     refreshes the digest rather than adding a second task; a drain that finds the row
 *     already holds the current digest marks the work done WITHOUT a remote call.
 *   - Stale edit tasks: the drain compares the work's expected digest against the row's
 *     CURRENT content; an edit that landed in between supersedes the old work, and only the
 *     newer content is ever retained — an old task cannot overwrite a newer active version.
 *   - Transient remote failures: a failed retain leaves the work pending with the error
 *     recorded; the next drain after recovery completes it (自动补同步).
 *
 * Re-verification is at task time, not enqueue time: the drain re-loads the authority row
 * under its own tenant pin and re-checks the principal (归属重核), and for source-bound rows
 * re-reads the restriction's CURRENT authorization — only confirmed, enabled, un-forgotten
 * and currently-authorized content is ever sent. The status surface answers from the same
 * facts: "indexed" requires the row's retained digest to equal its current content; pending
 * and failed are reported as exactly that, never as indexed.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { genericPersonalPreferences } from "../db/schema/hindsight-preferences";
import { sourceBoundMemories } from "../db/schema/hindsight-source-bound";
import { hindsightSyncWork } from "../db/schema/hindsight-sync";
import {
  backgroundTaskBankScope,
  type HindsightBankGrant,
  type HindsightBankScope,
  mintBankScopeAssertion,
  userBankFor,
} from "./bank-scope";
import type { PreferenceRecallServiceConfig } from "./preference-recall";
import {
  bankGrantForRestriction,
  type SourceBoundAuthorizationStore,
  type SourceBoundRecordRow,
} from "./scoped-recall";

/** The subjects this queue drains; one authority table per type. */
export type SyncSubjectType = "preference" | "source_bound";

/** What a confirm/edit/correction hands the queue; structural, so both services satisfy it. */
export interface HindsightSyncWorkRecorder {
  record(input: {
    subjectType: SyncSubjectType;
    tenantId: string;
    subjectId: string;
    principalId: string;
    contentDigest: string;
  }): Promise<void>;
}

/** What one drain pass did, by outcome; the report a background scheduler logs. */
export type SyncDrainReport = {
  considered: number;
  synced: number;
  /** The row already held this exact content; marked done with no remote call. */
  alreadyIndexed: number;
  /** A newer edit superseded the work; the newer content owns the truth now. */
  superseded: number;
  /** Nothing to send: row gone, unreviewed, paused or forgotten. */
  nothingToDo: number;
  /** Currently unauthorized (source-bound restriction); stays pending, retried later. */
  deferred: number;
  /** The remote refused or could not be reached; stays pending with the error recorded. */
  failed: number;
};

/** The status surface: what the person or an operator may truthfully be told. */
export type SyncStatus =
  | { state: "indexed"; syncedAt: Date | null }
  | { state: "pending"; attempts: number }
  | {
      state: "failed";
      attempts: number;
      lastError: string | null;
      /** A failed drain is still a pending retry; the flag keeps the wording honest. */
      willRetry: true;
    }
  | { state: "unknown-subject" };

/** How long one minted assertion stays valid; the drain mints fresh per retain. */
const ASSERTION_TTL_MS = 60_000;
/** The pinned deployment is single-tenant on the service side; the segment is a constant. */
const HINDSIGHT_TENANT_SEGMENT = "default";
/** One drain pass touches at most this many work rows, oldest first. */
const DRAIN_BATCH = 100;

const digestOf = (content: string) =>
  createHash("sha256").update(content).digest("hex");

/**
 * Whether an insert failed on a unique constraint. Drivers wrap the server's error (drizzle's
 * DrizzleQueryError carries it on `cause`; Bun's PostgresError then names the SQLSTATE in
 * `errno` while `code` stays generic), so the chain is walked and both spellings accepted.
 * Exported because the derived-judgment seam (#388) folds replayed leads the same way this
 * queue folds duplicate work — on the storage layer's own word, not a read-then-insert race.
 */
export function isUniqueViolation(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate; depth++) {
    if (typeof candidate === "object" && candidate !== null) {
      const record = candidate as { code?: unknown; errno?: unknown };
      if (record.code === "23505" || record.errno === "23505") return true;
    }
    candidate =
      typeof candidate === "object" &&
      candidate !== null &&
      "cause" in candidate
        ? (candidate as { cause?: unknown }).cause
        : null;
  }
  return false;
}

/** The authority rows this queue reads, unified over the two subject tables. */
type AuthorityRow = {
  principalId: string;
  content: string;
  reviewState: "unreviewed" | "confirmed" | "edited";
  enabled: boolean;
  deletedAt: Date | null;
  hindsightDocumentId: string;
  syncedContentDigest: string | null;
  syncedAt: Date | null;
  updatedAt: Date;
};

type WorkRow = typeof hindsightSyncWork.$inferSelect;

export function createHindsightSyncQueue(
  database: Database,
  config: PreferenceRecallServiceConfig,
  options: {
    now?: () => Date;
    /** Source-bound rows re-verify their restriction here at task time. */
    authorizations?: SourceBoundAuthorizationStore;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const doFetch =
    options.fetch ??
    ((input: string, init?: RequestInit) => fetch(input, init));

  async function loadPreference(
    tenantId: string,
    subjectId: string,
  ): Promise<AuthorityRow | null> {
    const [row] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, tenantId),
          eq(genericPersonalPreferences.id, subjectId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  return {
    /** The recorder both recall services accept; enqueue is idempotent per pending work. */
    async record(input: {
      subjectType: SyncSubjectType;
      tenantId: string;
      subjectId: string;
      principalId: string;
      contentDigest: string;
    }): Promise<void> {
      const id = randomUUID();
      try {
        await database.insert(hindsightSyncWork).values({
          tenantId: input.tenantId,
          id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          principalId: input.principalId,
          expectedDigest: input.contentDigest,
          state: "pending",
          attempts: 0,
        });
      } catch (error) {
        // One pending row per subject: a re-enqueue refreshes what the work stands for
        // (the newest content digest) instead of piling up a second task.
        if (isUniqueViolation(error)) {
          await database
            .update(hindsightSyncWork)
            .set({
              expectedDigest: input.contentDigest,
              principalId: input.principalId,
              updatedAt: now(),
            })
            .where(
              and(
                eq(hindsightSyncWork.tenantId, input.tenantId),
                eq(hindsightSyncWork.subjectType, input.subjectType),
                eq(hindsightSyncWork.subjectId, input.subjectId),
                eq(hindsightSyncWork.state, "pending"),
              ),
            );
          return;
        }
        throw error;
      }
    },

    /** Drain pending work oldest-first; every outcome is reported, none is silent. */
    async drain(input: { limit?: number } = {}): Promise<SyncDrainReport> {
      const report: SyncDrainReport = {
        considered: 0,
        synced: 0,
        alreadyIndexed: 0,
        superseded: 0,
        nothingToDo: 0,
        deferred: 0,
        failed: 0,
      };
      const limit = input.limit ?? DRAIN_BATCH;
      const pending = await database
        .select()
        .from(hindsightSyncWork)
        .where(eq(hindsightSyncWork.state, "pending"))
        .orderBy(asc(hindsightSyncWork.createdAt))
        .limit(limit);
      for (const work of pending) {
        report.considered++;
        const outcome = await processWork(work);
        report[outcome]++;
      }
      return report;
    },

    /**
     * The truthful status of one subject: "indexed" only when the row's retained digest
     * equals its current content (and the row is still eligible); pending and failed are
     * reported as exactly that. A missing row answers unknown-subject, never indexed.
     */
    async syncStatus(
      tenantId: string,
      subjectType: SyncSubjectType,
      subjectId: string,
    ): Promise<SyncStatus> {
      const row = await loadSubject(tenantId, subjectType, subjectId);
      if (!row) return { state: "unknown-subject" };
      const [work] = await database
        .select()
        .from(hindsightSyncWork)
        .where(
          and(
            eq(hindsightSyncWork.tenantId, tenantId),
            eq(hindsightSyncWork.subjectType, subjectType),
            eq(hindsightSyncWork.subjectId, subjectId),
          ),
        )
        .orderBy(desc(hindsightSyncWork.createdAt))
        .limit(1);
      const eligible =
        row.deletedAt === null &&
        row.enabled &&
        (row.reviewState === "confirmed" || row.reviewState === "edited");
      if (
        eligible &&
        row.content !== "" &&
        row.syncedContentDigest === digestOf(row.content)
      ) {
        return { state: "indexed", syncedAt: row.syncedAt };
      }
      if (work && work.state === "pending" && work.attempts > 0) {
        return {
          state: "failed",
          attempts: work.attempts,
          lastError: work.lastError,
          willRetry: true,
        };
      }
      return { state: "pending", attempts: work?.attempts ?? 0 };
    },
  };

  /** Load a subject row from its own table, tenant-pinned. */
  async function loadSubject(
    tenantId: string,
    subjectType: SyncSubjectType,
    subjectId: string,
  ): Promise<
    | (AuthorityRow & { restriction?: SourceBoundRecordRow["restriction"] })
    | null
  > {
    if (subjectType === "preference") {
      return loadPreference(tenantId, subjectId);
    }
    const row = await loadSourceBoundRow(tenantId, subjectId);
    return row;
  }

  async function loadSourceBoundRow(
    tenantId: string,
    subjectId: string,
  ): Promise<SourceBoundRecordRow | null> {
    const rows = await database
      .select()
      .from(sourceBoundMemories)
      .where(
        and(
          eq(sourceBoundMemories.tenantId, tenantId),
          eq(sourceBoundMemories.id, subjectId),
        ),
      )
      .limit(1);
    return (rows[0] as SourceBoundRecordRow | undefined) ?? null;
  }

  /** One retain into the row's own bank; the wire contract preference-recall.ts pins. */
  async function retain(
    grant: HindsightBankScope,
    bankId: string,
    documentId: string,
    content: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const token = mintBankScopeAssertion(grant, {
      secret: config.assertionSecret,
      ttlMs: ASSERTION_TTL_MS,
      now: now(),
    });
    try {
      const response = await doFetch(
        `${config.apiUrl}/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${bankId}/memories`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.serviceApiKey}`,
            "x-openbot-bank-scope": token,
          },
          body: JSON.stringify({
            items: [
              {
                content,
                document_id: documentId,
                update_mode: "replace",
              },
            ],
          }),
          signal: AbortSignal.timeout(config.requestTimeoutMs ?? 5000),
        },
      );
      if (!response.ok) {
        return { ok: false, reason: `service answered ${response.status}` };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof Error
            ? error.message
            : "service could not be reached",
      };
    }
  }

  async function finishWork(
    work: WorkRow,
    state: "done" | "superseded",
    error: string | null,
  ): Promise<void> {
    await database
      .update(hindsightSyncWork)
      .set({
        state,
        attempts: work.attempts + 1,
        lastAttemptAt: now(),
        lastError: error,
        updatedAt: now(),
      })
      .where(
        and(
          eq(hindsightSyncWork.tenantId, work.tenantId),
          eq(hindsightSyncWork.id, work.id),
        ),
      );
  }

  async function failWork(work: WorkRow, reason: string): Promise<void> {
    await database
      .update(hindsightSyncWork)
      .set({
        attempts: work.attempts + 1,
        lastAttemptAt: now(),
        lastError: reason,
        updatedAt: now(),
      })
      .where(
        and(
          eq(hindsightSyncWork.tenantId, work.tenantId),
          eq(hindsightSyncWork.id, work.id),
        ),
      );
  }

  async function deferWork(work: WorkRow, reason: string): Promise<void> {
    await database
      .update(hindsightSyncWork)
      .set({
        lastAttemptAt: now(),
        lastError: reason,
        updatedAt: now(),
      })
      .where(
        and(
          eq(hindsightSyncWork.tenantId, work.tenantId),
          eq(hindsightSyncWork.id, work.id),
        ),
      );
  }

  async function markRowSynced(
    subjectType: SyncSubjectType,
    tenantId: string,
    subjectId: string,
    digest: string,
  ): Promise<void> {
    if (subjectType === "preference") {
      await database
        .update(genericPersonalPreferences)
        .set({ syncedContentDigest: digest, syncedAt: now(), updatedAt: now() })
        .where(
          and(
            eq(genericPersonalPreferences.tenantId, tenantId),
            eq(genericPersonalPreferences.id, subjectId),
          ),
        );
      return;
    }
    await database
      .update(sourceBoundMemories)
      .set({ syncedContentDigest: digest, syncedAt: now(), updatedAt: now() })
      .where(
        and(
          eq(sourceBoundMemories.tenantId, tenantId),
          eq(sourceBoundMemories.id, subjectId),
        ),
      );
  }

  /** Process one work row; returns the report bucket the outcome belongs to. */
  async function processWork(
    work: WorkRow,
  ): Promise<keyof Omit<SyncDrainReport, "considered">> {
    // The subject row is re-loaded under the work's own tenant pin — ownership is
    // re-verified at task time, not trusted from enqueue time.
    const row = await loadSubject(
      work.tenantId,
      work.subjectType,
      work.subjectId,
    );
    if (!row) {
      await finishWork(work, "done", null);
      return "nothingToDo";
    }
    if (row.principalId !== work.principalId) {
      // The row moved to another principal (or the work was miscast): refuse to send.
      await finishWork(work, "done", "subject ownership mismatch");
      return "nothingToDo";
    }
    if (
      row.deletedAt !== null ||
      !row.enabled ||
      row.reviewState === "unreviewed"
    ) {
      // Only confirmed, un-paused, un-forgotten content is ever sent.
      await finishWork(work, "done", null);
      return "nothingToDo";
    }
    const currentDigest = digestOf(row.content);
    if (currentDigest !== work.expectedDigest) {
      // A newer edit/correction landed between enqueue and now; its own work owns the
      // truth. This task must not overwrite the newer active version.
      await finishWork(work, "superseded", null);
      return "superseded";
    }
    const bank = await bankFor(work.subjectType, row);
    if ("deferred" in bank) {
      await deferWork(work, bank.reason);
      return "deferred";
    }
    if (row.syncedContentDigest === currentDigest) {
      // Already indexed exactly this content: idempotent no-op, no remote call.
      await finishWork(work, "done", null);
      return "alreadyIndexed";
    }
    const outcome = await retain(
      backgroundTaskBankScope(
        { tenantId: work.tenantId, principalId: row.principalId },
        bank.grant,
      ),
      bank.grant.id,
      row.hindsightDocumentId,
      row.content,
    );
    if (!outcome.ok) {
      await failWork(work, outcome.reason);
      return "failed";
    }
    await markRowSynced(
      work.subjectType,
      work.tenantId,
      work.subjectId,
      currentDigest,
    );
    await finishWork(work, "done", null);
    return "synced";
  }

  /**
   * The bank this row's content belongs in, derived from the row's own attribution. A
   * source-bound row's restriction is re-authorized HERE — at task time — and an
   * unauthorized restriction defers the work (it is never sent while unauthorized).
   */
  async function bankFor(
    subjectType: SyncSubjectType,
    row: NonNullable<Awaited<ReturnType<typeof loadSubject>>>,
  ): Promise<
    { grant: HindsightBankGrant } | { deferred: true; reason: string }
  > {
    if (subjectType === "preference") {
      return {
        grant: { id: userBankFor(row.principalId), kind: "user" },
      };
    }
    const bound = row as SourceBoundRecordRow;
    const authorizations = options.authorizations;
    if (!authorizations) {
      return {
        deferred: true,
        reason: "no authorization store configured for source-bound work",
      };
    }
    if (bound.restriction === "team") {
      const active = await authorizations.workspaceMembershipActive(
        bound.tenantId,
        bound.principalId,
        bound.workspaceId ?? "",
      );
      if (!active) {
        return {
          deferred: true,
          reason: "team restriction not currently authorized",
        };
      }
      return {
        grant: bankGrantForRestriction({
          kind: "team",
          workspaceId: bound.workspaceId ?? "",
        }),
      };
    }
    if (bound.restriction === "source") {
      const sources = await authorizations.enabledSourceIds(
        bound.tenantId,
        bound.principalId,
      );
      if (!sources.includes(bound.sourceId ?? "")) {
        return {
          deferred: true,
          reason: "source restriction not currently authorized",
        };
      }
      return {
        grant: bankGrantForRestriction({
          kind: "source",
          sourceId: bound.sourceId ?? "",
        }),
      };
    }
    const authorized = await authorizations.botAuthorized(
      bound.tenantId,
      bound.principalId,
      bound.agentId ?? "",
    );
    if (!authorized) {
      return {
        deferred: true,
        reason: "bot restriction not currently authorized",
      };
    }
    return {
      grant: bankGrantForRestriction({
        kind: "bot",
        agentId: bound.agentId ?? "",
      }),
    };
  }
}

export type HindsightSyncQueue = ReturnType<typeof createHindsightSyncQueue>;
