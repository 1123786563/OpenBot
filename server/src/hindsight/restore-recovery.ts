/**
 * Hindsight 14 (#391): the backup-restore recovery gate and its replay procedure.
 *
 * A backup restore is the one event that can undo BOTH halves of a revocation at once: an
 * OpenBot-database restore resurrects authority rows and grants (the local blocks), a
 * Hindsight-database restore resurrects documents this ledger had already seen confirmed
 * (the remote deletions). #390's replayRevocations re-applies the local half; what it could
 * not express is the ORDERING the spec pins — 恢复备份后，先重放遗忘与撤权记录再开放召回.
 * Between the restore and the replay there is a window, and in that window every recall
 * entry would happily answer from resurrected rows (the SQL degradation path most of all,
 * because it reads exactly the rows a restore brought back).
 *
 * The marker is the gate, and it fails closed:
 *
 *   - `noteBackupRestored` lands one open row BEFORE the restored data is trusted (the safe
 *     direction: written early it only closes recall a little longer; written late it leaks
 *     the window). `restoreKey` dedups: the same restore event noted twice opens one gate,
 *     and re-noting it after the replay does NOT close recall again — a different restore
 *     (a different key) opens its own.
 *   - While any marker is open, every recall seam answers empty BEFORE any remote call
 *     (the pause-controls position), so the seam never raises its unavailability signal and
 *     the SQL degradation path never runs either — the facade stays empty, not degraded.
 *   - `replayBackupRestore` runs the ordered procedure: re-apply every local block, then
 *     re-issue the remote delete for EVERY ledger document (confirmed ones included — a 404
 *     re-confirms as cheaply as a fresh delete confirms), then flip the markers to replayed
 *     with the evidence recorded. A failure before the flip leaves the gate closed.
 *
 * Remote failures do NOT keep the gate closed: the local block is what makes recall safe to
 * re-open (the queue refuses blocked documents, the seams re-load authority rows), and the
 * remote cleanup continues through the ordinary retry drain — the same outage discipline
 * #390 set: Hindsight being down delays cleanup, never the person's stop of use.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import type { HindsightReplayEvidence } from "../db/schema/hindsight-restore";
import { hindsightBackupRestores } from "../db/schema/hindsight-restore";

/** One replay pass re-issues deletions in pages of this size, through to the ledger's end. */
const REISSUE_PAGE = 100;

/** The local half the replay re-applies; the revocation service (#390) owns it. */
export interface RevocationReplayPort {
  replayRevocations(input: { tenantId?: string }): Promise<{
    memoryRows: number;
    reappliedMemoryBlocks: number;
    authorizationTargets: number;
    reappliedAuthorizationBlocks: number;
  }>;
  retryOutstandingDeletions(input: {
    tenantId?: string;
    limit?: number;
    offset?: number;
    includeConfirmed?: boolean;
  }): Promise<{
    considered: number;
    confirmed: number;
    stillOutstanding: number;
  }>;
}

/** The read-only half the recall seams consume; absence of a gate means nothing is restored. */
export interface HindsightRecoveryGate {
  /** False exactly while a backup restore awaits its replay — recall stays closed. */
  recallOpen(): Promise<boolean>;
}

/** What noting a restore answered: the dedup decision is explicit, never silent. */
export type BackupRestoreNote = {
  restoreKey: string;
  restoredAt: Date;
  /** False when this key was already known (the same restore noted again). */
  noted: boolean;
  state: "open" | "replayed";
};

/** The operator-visible recovery picture: how many gates are open and since when. */
export type RecoveryGateStatus = {
  recallOpen: boolean;
  openRestores: number;
  /** The oldest unrestored-to-replay marker; null when every restore is replayed. */
  oldestRestoredAt: Date | null;
};

export function createRestoreRecoveryService(
  database: Database,
  revocations: RevocationReplayPort,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());

  /**
   * Land one restore marker. The insert conflicts on restore_key and does NOTHING there —
   * the existing row (open or replayed) is the answer — so a retried or duplicated note of
   * the SAME restore cannot stack a second gate, and a note arriving after the replay
   * cannot re-close recall. Distinct restores carry distinct keys and each opens its own.
   */
  async function noteBackupRestored(input: {
    restoreKey: string;
    restoredAt?: Date;
  }): Promise<BackupRestoreNote> {
    const restoredAt = input.restoredAt ?? now();
    const id = randomUUID();
    const at = now();
    const [row] = await database
      .insert(hindsightBackupRestores)
      .values({
        id,
        restoreKey: input.restoreKey,
        restoredAt,
        state: "open",
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing({
        target: hindsightBackupRestores.restoreKey,
      })
      .returning();
    if (row) {
      return {
        restoreKey: row.restoreKey,
        restoredAt: row.restoredAt,
        noted: true,
        state: row.state,
      };
    }
    const [existing] = await database
      .select()
      .from(hindsightBackupRestores)
      .where(eq(hindsightBackupRestores.restoreKey, input.restoreKey))
      .limit(1);
    if (!existing) {
      throw new Error(
        "restore marker insert conflicted but the existing row could not be read back",
      );
    }
    return {
      restoreKey: existing.restoreKey,
      restoredAt: existing.restoredAt,
      noted: false,
      state: existing.state,
    };
  }

  async function gateStatus(): Promise<RecoveryGateStatus> {
    const open = await database
      .select({ restoredAt: hindsightBackupRestores.restoredAt })
      .from(hindsightBackupRestores)
      .where(eq(hindsightBackupRestores.state, "open"))
      .orderBy(asc(hindsightBackupRestores.restoredAt));
    const oldest = open.at(0)?.restoredAt ?? null;
    return {
      recallOpen: open.length === 0,
      openRestores: open.length,
      oldestRestoredAt: oldest,
    };
  }

  /**
   * The ordered replay: local blocks re-applied FIRST, remote deletions re-issued SECOND,
   * and only then the markers flipped. Every open marker flips in the same write with the
   * same evidence, so the gate is all-or-nothing per replay pass. Re-running a fully
   * replayed state is a reported no-op (replayed: false), never a re-close.
   */
  async function replayBackupRestore(): Promise<{
    replayed: boolean;
    evidence: HindsightReplayEvidence | null;
  }> {
    const open = await database
      .select({ id: hindsightBackupRestores.id })
      .from(hindsightBackupRestores)
      .where(eq(hindsightBackupRestores.state, "open"));
    if (!open.length) return { replayed: false, evidence: null };
    const localBlocks = await revocations.replayRevocations({});
    // The re-issue pages through the WHOLE ledger (confirmed rows included): a partial page
    // would leave resurrected-confirmed documents behind with no later pass to catch them —
    // the routine drain skips confirmed rows by design. Updates during the pass cannot
    // reorder it: neither the delete outcome nor the verify columns touch blocked_at.
    let considered = 0;
    let confirmed = 0;
    let stillOutstanding = 0;
    for (let offset = 0; ; offset += REISSUE_PAGE) {
      const page = await revocations.retryOutstandingDeletions({
        includeConfirmed: true,
        limit: REISSUE_PAGE,
        offset,
      });
      considered += page.considered;
      confirmed += page.confirmed;
      stillOutstanding += page.stillOutstanding;
      if (page.considered < REISSUE_PAGE) break;
    }
    const remoteDeletions = { considered, confirmed, stillOutstanding };
    const evidence: HindsightReplayEvidence = {
      localBlocks,
      remoteDeletions,
      finishedAt: now().toISOString(),
    };
    const at = now();
    for (const marker of open) {
      await database
        .update(hindsightBackupRestores)
        .set({
          state: "replayed",
          replayedAt: at,
          replayEvidence: evidence,
          updatedAt: at,
        })
        .where(
          and(
            eq(hindsightBackupRestores.id, marker.id),
            // Only still-open rows flip: a concurrent note racing this pass keeps its own
            // gate open rather than being swept into a replay it postdates.
            eq(hindsightBackupRestores.state, "open"),
          ),
        );
    }
    return { replayed: true, evidence };
  }

  const gate: HindsightRecoveryGate = {
    async recallOpen() {
      const [row] = await database
        .select({ state: hindsightBackupRestores.state })
        .from(hindsightBackupRestores)
        .where(eq(hindsightBackupRestores.state, "open"))
        .limit(1);
      return row === undefined;
    },
  };

  return {
    noteBackupRestored,
    gateStatus,
    replayBackupRestore,
    gate,
  };
}

export type RestoreRecoveryService = ReturnType<
  typeof createRestoreRecoveryService
>;

/**
 * Apply the recovery gate at one recall seam's entry: no gate configured means nothing is
 * restored (the seam is built without recovery wiring only where no restore can happen);
 * a configured gate is read live so a note landing mid-request is honored by the next one.
 */
export async function recallOpenFor(
  recovery: HindsightRecoveryGate | undefined,
): Promise<boolean> {
  if (!recovery) return true;
  return recovery.recallOpen();
}
