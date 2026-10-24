/**
 * Hindsight 14 (#391): the cleanup evidence chain — what may honestly be claimed as
 * “受控副本清除完成”, and the three legs of actual evidence that claim rests on.
 *
 * The handoff rule this module is shaped by: 删除证明不能只依赖一次 API 成功或配置的过期
 * 天数. A 2xx on one delete call is the service's answer to ONE request; a retention number in
 * a config file is a promise, not an observation. So each leg is built on observed facts:
 *
 *   - Active data (活跃文档及相关观察): every ledger document of this person is
 *     deletion-confirmed AND verified absent — the verification is an independent probe
 *     (the document answers 404, and the memory units the document seeded answer empty), not
 *     the delete's own receipt. `verifyActiveDataCleanup` is the ops sweep that records
 *     those probes on the ledger rows; by default the status RE-PROBES when it composes the
 *     claim, because a stored `absent` is evidence of a past moment and an unmarked restore
 *     would leave it stale with nothing to contradict. The person's own status route asks for
 *     the pure-read form instead (`reprobe: false`): it writes nothing and answers from the
 *     recorded observations, with `observedAt` saying when they were made.
 *   - Finished task payloads (已结束任务载荷): the service is ASKED, now, whether any
 *     terminal operation (completed/failed/cancelled) older than the declared retention
 *     window still exists in the affected banks. None found = evidence; a declared number
 *     alone proves nothing, and a check that could not run (unreachable, undeclared) is
 *     reported as unevidenced, never as cleared.
 *   - Controlled backups (受控备份): the registry of controlled copies (backup.sh's archives,
 *     registered as they are taken) must show a purge for every copy taken before the
 *     deletion confirmation of content it could contain. An EMPTY registry is not "no
 *     backups" — the backup job runs outside OpenBot — it is no evidence, and the leg stays
 *     uncleared while anything stands deleted. Purge evidence is never a one-shot latch: a
 *     reconcile pass that finds a purged copy's archive present again withdraws the record
 *     (`withdrawControlledBackupPurged`), so the leg follows what the declared directory
 *     shows now instead of a moment the deployment may have moved past.
 *
 * External model logs (外部模型日志) are carried as a SEPARATE, fixed note: they are not
 * controlled copies of this deployment, their retention is verified elsewhere, and nothing in
 * this module's vocabulary may fold them into the claim. The claim itself is a constant the
 * surface echoes verbatim, exactly like STOPPED_USING_SUMMARY (#390): the person-facing
 * wording is pinned so no caller can reword evidence into an assertion.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  hindsightBackupRestores,
  hindsightControlledBackups,
} from "../db/schema/hindsight-restore";
import { hindsightRevocations } from "../db/schema/hindsight-revocations";
import {
  backgroundTaskBankScope,
  type HindsightBankGrant,
  mintBankScopeAssertion,
} from "./bank-scope";
import type { PreferenceRecallServiceConfig } from "./preference-recall";
import type { RevocationBankKind } from "./revocation-ledger";

/** The pinned claim; shown verbatim only when all three legs hold actual evidence. */
export const CONTROLLED_COPIES_CLEARED_SUMMARY =
  "All controlled copies are cleared: active data deleted and verified absent, finished task payloads past their retention window, and controlled backups purged. Logs kept by external model providers are not part of this claim.";

/** The separate note the spec demands for external model logs; never merged into the claim. */
export const EXTERNAL_MODEL_LOGS_NOTE =
  "Logs kept by external model providers and gateways are not controlled copies of this deployment. Their retention is verified separately and is never claimed cleared here.";

/** How long one minted assertion stays valid; each probe mints fresh. */
const ASSERTION_TTL_MS = 60_000;
/** The pinned deployment is single-tenant on the service side; the segment is a constant. */
const HINDSIGHT_TENANT_SEGMENT = "default";
/** One verification sweep probes at most this many documents, oldest block first. */
const VERIFY_BATCH = 100;
/** The operations probe pages at the service's own per-request maximum. */
const OPERATIONS_PAGE = 100;
/** ...and stops after this many pages per (bank, status): beyond it the leg is unevidenced. */
const OPERATIONS_PAGE_CAP = 10;
/** The terminal statuses whose payloads the retention window governs. */
const TERMINAL_OPERATION_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;

/** The active-data leg: what the ledger's own rows say, deletion plus verification. */
export type ActiveDataCleanupEvidence = {
  cleared: boolean;
  /** Ledger documents of this person in this company. */
  documents: number;
  /** Deletion not confirmed by the service (pending or failed). */
  outstanding: number;
  /** Not verified absent by THIS status's own probes — unreachable included; one API success is not proof. */
  unverified: number;
  /** Verified PRESENT: the document answered 200 after its deletion (a restore resurrects). */
  resurrected: number;
  /**
   * When the observation `cleared` stands on was recorded. On a re-probing call this is the
   * moment of the probes; on a pure read it is the newest stored verification, so a surface
   * cannot present an old verdict as a fresh look.
   */
  observedAt: Date | null;
  /** An open backup-restore gate: verification cannot be trusted until the replay lands. */
  blockedByOpenRestore: boolean;
};

/** The finished-payload leg: a runtime observation, or the honest absence of one. */
export type FinishedTaskPayloadEvidence = {
  cleared: boolean;
  /** Whether the observation could actually be made this time. */
  checked: boolean;
  /** The declared retention window the ages were measured against; never evidence alone. */
  retentionDays: number | null;
  banksChecked: number;
  /** Terminal operations older than the window the service still holds; null when unchecked. */
  beyondWindow: number | null;
  reason: string | null;
};

/** The controlled-backup leg: registry evidence, with the empty registry named as no evidence. */
export type ControlledBackupEvidence = {
  cleared: boolean;
  registered: number;
  /** Copies taken before a confirmed deletion that lack purge evidence; null = unevidenced. */
  outstanding: number | null;
  oldestOutstandingTakenAt: Date | null;
};

/** The composed answer: the claim, the legs it stands on, and the separate external note. */
export type CleanupEvidenceStatus = {
  controlledCopiesCleared: boolean;
  /** CONTROLLED_COPIES_CLEARED_SUMMARY when the claim holds, else null — never a rewording. */
  summary: typeof CONTROLLED_COPIES_CLEARED_SUMMARY | null;
  externalModelLogs: {
    coveredByThisClaim: false;
    note: typeof EXTERNAL_MODEL_LOGS_NOTE;
  };
  activeData: ActiveDataCleanupEvidence;
  finishedTaskPayloads: FinishedTaskPayloadEvidence;
  controlledBackups: ControlledBackupEvidence;
  computedAt: string;
};

/** What one document's verification probe found; recorded onto the ledger row either way. */
export type DocumentVerifyOutcome = {
  documentId: string;
  state: "absent" | "present" | "unreachable";
  error: string | null;
};

/** One bank to probe, with the identity of a ledger row that names it (assertions need one). */
type BankProbe = {
  bankId: string;
  bankKind: RevocationBankKind;
  tenantId: string;
  principalId: string;
};

type VerifyRow = typeof hindsightRevocations.$inferSelect;

export function createCleanupEvidenceService(
  database: Database,
  config: PreferenceRecallServiceConfig,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const doFetch =
    config.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));

  /**
   * The confirmed rows a sweep probes, in one place: (blockedAt, id) is a total order even
   * for the whole block sets one authorization revocation writes with a shared blockedAt, so
   * offset paging between two sweeps cannot skip or repeat documents.
   */
  async function selectConfirmedRows(input: {
    tenantId: string;
    principalId?: string;
    limit?: number;
    offset?: number;
  }) {
    return database
      .select()
      .from(hindsightRevocations)
      .where(
        and(
          eq(hindsightRevocations.tenantId, input.tenantId),
          input.principalId
            ? eq(hindsightRevocations.principalId, input.principalId)
            : undefined,
          eq(hindsightRevocations.deletionState, "confirmed"),
        ),
      )
      .orderBy(
        asc(hindsightRevocations.blockedAt),
        asc(hindsightRevocations.id),
      )
      .limit(input.limit ?? VERIFY_BATCH)
      .offset(input.offset ?? 0);
  }

  /**
   * Probe one row and record the outcome — the shared step of the ops sweep and the status's
   * own re-probe (a stored `absent` is evidence of a past moment, and the claim may not rest
   * on a past moment: an unmarked restore would leave it stale with nothing to contradict).
   */
  async function probeAndRecord(
    row: VerifyRow,
  ): Promise<DocumentVerifyOutcome> {
    const outcome = await verifyDocument(row);
    await database
      .update(hindsightRevocations)
      .set({
        verifyState: outcome.state,
        verifiedAt: now(),
        verifyError: outcome.error,
        updatedAt: now(),
      })
      .where(
        and(
          eq(hindsightRevocations.tenantId, row.tenantId),
          eq(hindsightRevocations.documentId, row.documentId),
        ),
      );
    return outcome;
  }

  /** One authenticated GET into the shared service, minted like every background call. */
  async function hindsightGet(
    identity: { tenantId: string; principalId: string },
    bank: HindsightBankGrant,
    path: string,
  ): Promise<Response> {
    const token = mintBankScopeAssertion(
      backgroundTaskBankScope(identity, bank),
      {
        secret: config.assertionSecret,
        ttlMs: ASSERTION_TTL_MS,
        now: now(),
      },
    );
    return doFetch(`${config.apiUrl}${path}`, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.serviceApiKey}`,
        "x-openbot-bank-scope": token,
      },
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? 5000),
    });
  }

  /**
   * Verify ONE ledger document's absence: the document itself must answer 404, and the
   * memory units it seeded (Hindsight extracts them at retain; the document delete cascades
   * onto them) must answer empty. Either probe failing means the copy is NOT proven gone —
   * a 404 alone was never enough, because the units could outlive a botched delete.
   */
  async function verifyDocument(
    row: VerifyRow,
  ): Promise<DocumentVerifyOutcome> {
    const identity = { tenantId: row.tenantId, principalId: row.principalId };
    const bank = { id: row.bankId, kind: row.bankKind };
    try {
      const document = await hindsightGet(
        identity,
        bank,
        `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${row.bankId}/documents/${encodeURIComponent(row.documentId)}`,
      );
      if (document.ok) {
        return {
          documentId: row.documentId,
          state: "present",
          error: "document answered 200 after its deletion",
        };
      }
      if (document.status !== 404) {
        return {
          documentId: row.documentId,
          state: "unreachable",
          error: `document probe answered ${document.status}`,
        };
      }
      const units = await hindsightGet(
        identity,
        bank,
        `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${row.bankId}/memories/list?document_id=${encodeURIComponent(row.documentId)}&limit=1`,
      );
      if (!units.ok) {
        return {
          documentId: row.documentId,
          state: "unreachable",
          error: `memory-unit probe answered ${units.status}`,
        };
      }
      const payload = (await units.json().catch(() => null)) as {
        items?: unknown[];
      } | null;
      const remaining = payload?.items?.length ?? 0;
      if (remaining > 0) {
        return {
          documentId: row.documentId,
          state: "present",
          error: `${remaining} memory unit(s) still reference the deleted document`,
        };
      }
      return { documentId: row.documentId, state: "absent", error: null };
    } catch (error) {
      return {
        documentId: row.documentId,
        state: "unreachable",
        error:
          error instanceof Error
            ? error.message
            : "service could not be reached",
      };
    }
  }

  /**
   * The verification sweep: every confirmed deletion of this person (tenant-pinned, oldest
   * block first — `id` breaks the ties a block set shares, so paging is deterministic),
   * probed and RECORDED. The probe is independent of the delete call's own receipt — that is
   * the whole point. Rows whose deletion never confirmed are not probed (there is nothing to
   * verify; they stay outstanding until the retry drain confirms them).
   */
  async function verifyActiveDataCleanup(input: {
    tenantId: string;
    principalId?: string;
    limit?: number;
    offset?: number;
  }): Promise<DocumentVerifyOutcome[]> {
    const rows = await selectConfirmedRows(input);
    const outcomes: DocumentVerifyOutcome[] = [];
    for (const row of rows) {
      outcomes.push(await probeAndRecord(row));
    }
    return outcomes;
  }

  /**
   * The finished-payload leg's observation: for each affected bank, ask the service NOW for
   * terminal operations older than the declared window. The service's retention job is what
   * removes them; this probe is what proves it ran — a number in a config file never was.
   */
  async function observeFinishedTaskPayloads(input: {
    banks: readonly BankProbe[];
    retentionDays: number | null;
  }): Promise<FinishedTaskPayloadEvidence> {
    if (input.retentionDays === null) {
      return {
        cleared: false,
        checked: false,
        retentionDays: null,
        banksChecked: 0,
        beyondWindow: null,
        reason:
          "operation retention window not declared; a number is not evidence",
      };
    }
    const cutoff = now().getTime() - input.retentionDays * 24 * 60 * 60 * 1000;
    let beyondWindow = 0;
    for (const probe of input.banks) {
      for (const status of TERMINAL_OPERATION_STATUSES) {
        let offset = 0;
        for (let page = 0; ; page++) {
          if (page >= OPERATIONS_PAGE_CAP) {
            return unevidenced(
              input.retentionDays,
              "operations probe exceeded its paging cap",
            );
          }
          let response: Response;
          try {
            response = await hindsightGet(
              { tenantId: probe.tenantId, principalId: probe.principalId },
              { id: probe.bankId, kind: probe.bankKind },
              `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${probe.bankId}/operations?status=${status}&limit=${OPERATIONS_PAGE}&offset=${offset}`,
            );
          } catch {
            return unevidenced(
              input.retentionDays,
              "service could not be reached for the operations probe",
            );
          }
          if (response.status === 404) {
            // A bank the service has never seen holds no payloads — observed, not assumed.
            break;
          }
          if (!response.ok) {
            return unevidenced(
              input.retentionDays,
              `operations probe answered ${response.status}`,
            );
          }
          const payload = (await response.json().catch(() => null)) as {
            operations?: { created_at?: string }[];
            total?: number;
          } | null;
          const entries = payload?.operations ?? [];
          for (const entry of entries) {
            const created = entry.created_at
              ? new Date(entry.created_at).getTime()
              : Number.NaN;
            if (!Number.isNaN(created) && created < cutoff) beyondWindow++;
          }
          const total = payload?.total ?? entries.length;
          offset += entries.length;
          if (entries.length === 0 || offset >= total) break;
        }
      }
    }
    return {
      cleared: beyondWindow === 0,
      checked: true,
      retentionDays: input.retentionDays,
      banksChecked: input.banks.length,
      beyondWindow,
      reason: null,
    };
  }

  /**
   * The composed status. The claim holds only when all three legs hold observed evidence;
   * anything unknown reports uncleared with the reason inside the leg, never a partial claim.
   */
  async function cleanupEvidenceStatus(input: {
    tenantId: string;
    principalId?: string;
    /** The DECLARED operation retention window; used as the measurement, never as the proof. */
    operationRetentionDays: number | null;
    /**
     * Whether this call re-probes the confirmed documents and records what it finds. Default
     * true — the claim must not stand on a stored `absent` alone, because an unmarked restore
     * would leave it stale with nothing to contradict. `false` answers from the rows' LAST
     * recorded observations and writes nothing: the pure read the person's status route
     * serves (RA2-5), with the explicit verify action as the one that probes.
     */
    reprobe?: boolean;
  }): Promise<CleanupEvidenceStatus> {
    const rows = await database
      .select()
      .from(hindsightRevocations)
      .where(
        and(
          eq(hindsightRevocations.tenantId, input.tenantId),
          input.principalId
            ? eq(hindsightRevocations.principalId, input.principalId)
            : undefined,
        ),
      );
    const [openRestore] = await database
      .select({ state: hindsightBackupRestores.state })
      .from(hindsightBackupRestores)
      .where(eq(hindsightBackupRestores.state, "open"))
      .limit(1);
    const outstandingRows = rows.filter(
      (row) => row.deletionState !== "confirmed",
    );
    // The claim usually re-probes the confirmed rows itself: a stored `absent` is evidence of
    // the moment it was recorded, and an unmarked restore would leave it stale with nothing to
    // contradict. Each probe is recorded too, so the durable trail tracks what the status
    // actually stood on. A `reprobe: false` call (the person's status READ, RA2-5) writes
    // nothing and answers from those recorded observations instead. Unreachable probes count
    // as unverified — never as cleared.
    const freshOutcomes: DocumentVerifyOutcome[] = [];
    if (input.reprobe !== false) {
      for (const row of rows) {
        if (row.deletionState === "confirmed") {
          freshOutcomes.push(await probeAndRecord(row));
        }
      }
    } else {
      for (const row of rows) {
        if (row.deletionState !== "confirmed") continue;
        freshOutcomes.push({
          documentId: row.documentId,
          state:
            row.verifyState === "absent"
              ? "absent"
              : row.verifyState === "present"
                ? "present"
                : "unreachable",
          error: null,
        });
      }
    }
    const resurrected = freshOutcomes.filter(
      (outcome) => outcome.state === "present",
    ).length;
    const unverified = freshOutcomes.filter(
      (outcome) => outcome.state !== "absent",
    ).length;
    const lastVerifiedAt = rows.reduce<number | null>(
      (latest, row) =>
        row.verifiedAt && (latest === null || row.verifiedAt.getTime() > latest)
          ? row.verifiedAt.getTime()
          : latest,
      null,
    );
    const observedAt =
      input.reprobe === false
        ? lastVerifiedAt === null
          ? null
          : new Date(lastVerifiedAt)
        : rows.some((row) => row.deletionState === "confirmed")
          ? now()
          : null;
    const blockedByOpenRestore = openRestore !== undefined;
    const activeData: ActiveDataCleanupEvidence = {
      // A person with no revocations makes no claim: an empty ledger is nothing to have
      // cleared, and "cleared" over zero documents would be a word with no work behind it.
      cleared:
        rows.length > 0 &&
        outstandingRows.length === 0 &&
        unverified === 0 &&
        resurrected === 0 &&
        !blockedByOpenRestore,
      documents: rows.length,
      outstanding: outstandingRows.length,
      unverified,
      resurrected,
      observedAt,
      blockedByOpenRestore,
    };

    // The finished-payload probe asks each bank some ledger document of this person named.
    const banksByBank = new Map<string, BankProbe>();
    for (const row of rows) {
      if (!banksByBank.has(row.bankId)) {
        banksByBank.set(row.bankId, {
          bankId: row.bankId,
          bankKind: row.bankKind,
          tenantId: row.tenantId,
          principalId: row.principalId,
        });
      }
    }
    const finishedTaskPayloads = await observeFinishedTaskPayloads({
      banks: [...banksByBank.values()],
      retentionDays: input.operationRetentionDays,
    });

    // The backup leg: a copy taken BEFORE a deletion's confirmation may contain that content;
    // every such copy needs purge evidence. Copies taken after every confirmation cannot
    // contain any of it. An empty registry with confirmed deletions is NO evidence (the
    // backup job runs outside OpenBot), not a shortcut to cleared.
    const confirmations = rows
      .filter((row) => row.deletionState === "confirmed")
      .map(
        (row) => row.deletionAttemptedAt?.getTime() ?? Number.POSITIVE_INFINITY,
      );
    const earliestConfirmed = confirmations.length
      ? Math.min(...confirmations)
      : null;
    const anythingConfirmed = earliestConfirmed !== null;
    const backups = await database
      .select()
      .from(hindsightControlledBackups)
      .orderBy(asc(hindsightControlledBackups.takenAt));
    // `purgedAt` is the last reconcile pass's observation, not a tombstone: a pass that sees a
    // purged archive come back clears the flag again (see withdrawControlledBackupPurged), so
    // this read answers what the declared directory showed most recently.
    const unPurgedBeforeDeletion = anythingConfirmed
      ? backups.filter(
          (backup) =>
            backup.purgedAt === null &&
            backup.takenAt.getTime() < earliestConfirmed,
        )
      : [];
    const controlledBackups: ControlledBackupEvidence = {
      cleared: anythingConfirmed
        ? backups.length > 0 && unPurgedBeforeDeletion.length === 0
        : true,
      registered: backups.length,
      outstanding:
        backups.length === 0 && anythingConfirmed
          ? null
          : unPurgedBeforeDeletion.length,
      oldestOutstandingTakenAt: unPurgedBeforeDeletion[0]?.takenAt ?? null,
    };

    const cleared =
      activeData.cleared &&
      finishedTaskPayloads.cleared &&
      controlledBackups.cleared;
    return {
      controlledCopiesCleared: cleared,
      summary: cleared ? CONTROLLED_COPIES_CLEARED_SUMMARY : null,
      externalModelLogs: {
        coveredByThisClaim: false,
        note: EXTERNAL_MODEL_LOGS_NOTE,
      },
      activeData,
      finishedTaskPayloads,
      controlledBackups,
      computedAt: now().toISOString(),
    };
  }

  return {
    verifyActiveDataCleanup,
    cleanupEvidenceStatus,
    recordControlledBackup,
    noteControlledBackupPurged,
    withdrawControlledBackupPurged,
  };

  /** Register one controlled copy as taken; a repeated registration changes nothing. */
  async function recordControlledBackup(input: {
    backupId: string;
    takenAt: Date;
  }): Promise<{ noted: boolean }> {
    const at = now();
    const inserted = await database
      .insert(hindsightControlledBackups)
      .values({
        id: randomUUID(),
        backupId: input.backupId,
        takenAt: input.takenAt,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing({
        target: hindsightControlledBackups.backupId,
      })
      .returning();
    return { noted: inserted.length > 0 };
  }

  /** Record a copy's actual purge; the only fact that can clear the backup leg. */
  async function noteControlledBackupPurged(input: {
    backupId: string;
    purgedAt?: Date;
    /** How the purge was established (which sweep, whose attestation) — a fact, not a credential. */
    evidence: string;
  }): Promise<{ noted: boolean }> {
    const updated = await database
      .update(hindsightControlledBackups)
      .set({
        purgedAt: input.purgedAt ?? now(),
        purgeEvidence: input.evidence,
        updatedAt: now(),
      })
      .where(eq(hindsightControlledBackups.backupId, input.backupId))
      .returning();
    return { noted: updated.length > 0 };
  }

  /**
   * Withdraw a purge record whose copy was re-observed present in the declared directory.
   * The registry's purge column is evidence of an observation, not a tombstone: an archive
   * that is back (a partially mounted volume, a copy restored from cold storage) may hold the
   * content the leg claims cleared, so the record returns to outstanding and the leg follows
   * the current state. Both the instant and its evidence text go with it — a text describing
   * a purge that no longer stands would be the next reader's false claim.
   */
  async function withdrawControlledBackupPurged(input: {
    backupId: string;
  }): Promise<{ withdrawn: boolean }> {
    const updated = await database
      .update(hindsightControlledBackups)
      .set({ purgedAt: null, purgeEvidence: null, updatedAt: now() })
      .where(
        and(
          eq(hindsightControlledBackups.backupId, input.backupId),
          isNotNull(hindsightControlledBackups.purgedAt),
        ),
      )
      .returning();
    return { withdrawn: updated.length > 0 };
  }
}

function unevidenced(
  retentionDays: number,
  reason: string,
): FinishedTaskPayloadEvidence {
  return {
    cleared: false,
    checked: false,
    retentionDays,
    banksChecked: 0,
    beyondWindow: null,
    reason,
  };
}

export type CleanupEvidenceService = ReturnType<
  typeof createCleanupEvidenceService
>;
