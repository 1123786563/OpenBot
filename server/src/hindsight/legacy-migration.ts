/**
 * Hindsight 16 (#394): the one-way migration of historically confirmed OpenBot memories into
 * the enterprise personal-memory domain.
 *
 * The old system (`personal_memories`) is global-user-scoped: `owner_user_id` names a person
 * across the whole deployment, with no company column. The new domain is tenant-scoped to its
 * bones — every table is pinned to (tenant, principal), and the bank derivations follow. The
 * migration's whole honesty problem is that join, and its rules are the ticket's acceptance
 * clauses:
 *
 *   - WHAT migrates: old rows that HAVE an OpenBot record, are confirmed or edited, and are
 *     alive (enabled, not deleted). Unreviewed rows stay pending — they are counted and left
 *     in the old table for the person's review, never silently confirmed by the migration.
 *     Rows that exist only in Intelligence never had an OpenBot record and are not scanned at
 *     all (the scan source IS the OpenBot table; nothing is read from Intelligence).
 *   - WHERE they land: the owner's enterprise principal, exactly when company attribution is
 *     PROVABLE — one active membership, and only one. Zero active memberships, no principal,
 *     or membership in several companies quarantines the row (reason recorded, content never
 *     copied — the isolation list must not become a shadow memory store). A global user id
 *     never names a tenant; the migration does not guess one from it, ever.
 *   - HOW permissions carry: `formedBy 'person'` rows become general personal preferences
 *     (the old audience — the person's own Bots — maps to the same company's authorized
 *     Bots); `formedBy 'bot'` rows become Bot-restricted source-bound memories (the old rule
 *     — visible to the forming Bot only — maps to the Bot bank), seeding the Bot's grant row
 *     so the restriction has an authorization to check; import rows (`sourceId` set) become
 *     source-restricted rows, and the old source's `enabled` flag seeds the person's source
 *     grant the same way. Both seedings are revocable later through #390's revocation.
 *     A shape the new tables cannot reproduce is never silently reclassified into a wider
 *     audience: a Bot row without its agent id, an import row without its source id, a
 *     formed_by value outside the three mapped shapes, and a Bot row whose source_ref
 *     narrowed recall to the forming Bot's still-held source app are each quarantined with
 *     their own reason — the row stays in the old table, reference intact, unmigrated.
 *   - HOW it resumes: the run row's cursor advances with every processed old record, so a
 *     failed run resumes strictly after it; the new record id IS the old id (globally unique
 *     in the old table, tenant-pinned in the new one), so re-processing an already-migrated
 *     row conflicts on the primary key and does nothing — no second active copy, ever. The
 *     remote indexing is NOT done here: each migrated row enqueues sync work the #384 queue
 *     drains under its own idempotency, which is the pattern this ticket was told to follow.
 *   - HOW it reconciles: `reconcile` answers, from both sides of the move, the counts the
 *     ticket names — old-side classification totals, new-side rows per subject type, the
 *     quarantine list — and `sampleRows` hands out a bounded sample of migrated content for
 *     recall verification through the real seams, which the integration test drives.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  enterpriseMemberships,
  enterprisePrincipals,
} from "../db/schema/enterprise-tenancy";
import {
  hindsightMigrationMap,
  hindsightMigrationQuarantine,
  hindsightMigrationRuns,
} from "../db/schema/hindsight-legacy-migration";
import { genericPersonalPreferences } from "../db/schema/hindsight-preferences";
import {
  hindsightMemoryGrants,
  sourceBoundMemories,
} from "../db/schema/hindsight-source-bound";
import { memorySources, personalMemories } from "../db/schema/memory";
import { preferenceDocumentIdFor } from "./preference-recall";
import { sourceBoundDocumentIdFor } from "./scoped-recall";
import type { HindsightSyncWorkRecorder, SyncSubjectType } from "./sync-queue";

/**
 * Why one old record could not be placed in the new domain: its company attribution could not
 * be proven, or its permission shape is one the new tables cannot reproduce without widening
 * who may see it.
 */
export type QuarantineReason =
  | "no-principal"
  | "no-active-membership"
  | "ambiguous-company"
  | "unmappable-permission-shape"
  | "source-ref-narrowing";

/** What one run pass did; the counters mirror the run row's durable columns. */
export type MigrationRunReport = {
  runId: string;
  considered: number;
  migrated: number;
  skippedPendingReview: number;
  skippedInactive: number;
  quarantined: number;
  alreadyMigrated: number;
  completed: boolean;
};

/** The before/after reconciliation the ticket's third clause asks for. */
export type MigrationReconciliation = {
  oldSide: {
    total: number;
    confirmedAlive: number;
    pendingReview: number;
    inactive: number;
    byFormedBy: Record<string, number>;
  };
  newSide: {
    migrated: number;
    bySubjectType: Record<string, number>;
  };
  quarantined: { total: number; byReason: Record<string, number> };
  /** Every confirmed-alive old record is a migration or a quarantine, not fewer. */
  balanced: boolean;
};

/** One batch of old records this migrator looks at per query inside a pass. */
const QUERY_BATCH = 100;
/** A whole pass's ceiling when the caller does not name one. */
const DEFAULT_PASS_LIMIT = 500;

const digestOf = (content: string) =>
  createHash("sha256").update(content).digest("hex");

export function createLegacyMemoryMigrator(
  database: Database,
  options: {
    now?: () => Date;
    /** The #384 work recorder migrated rows enqueue through; the queue owns remote indexing. */
    work?: HindsightSyncWorkRecorder;
  } = {},
) {
  const now = options.now ?? (() => new Date());

  /**
   * The provable attribution of one global user: their principal, and the single company an
   * ACTIVE membership names — or why that is not provable. Never a guess: two active
   * memberships answer ambiguous, not "the first one"; a global user id never names a tenant.
   */
  async function attributionOf(
    ownerUserId: string,
  ): Promise<
    | { proven: true; tenantId: string; principalId: string }
    | { proven: false; reason: QuarantineReason }
  > {
    const [principal] = await database
      .select({ id: enterprisePrincipals.id })
      .from(enterprisePrincipals)
      .where(eq(enterprisePrincipals.userId, ownerUserId))
      .limit(1);
    if (!principal) return { proven: false, reason: "no-principal" };
    const memberships = await database
      .select({ tenantId: enterpriseMemberships.tenantId })
      .from(enterpriseMemberships)
      .where(
        and(
          eq(enterpriseMemberships.principalId, principal.id),
          eq(enterpriseMemberships.status, "active"),
        ),
      );
    if (memberships.length === 0) {
      return { proven: false, reason: "no-active-membership" };
    }
    if (memberships.length > 1) {
      return { proven: false, reason: "ambiguous-company" };
    }
    return {
      proven: true,
      tenantId: memberships[0].tenantId,
      principalId: principal.id,
    };
  }

  return {
    /**
     * Start (or resume) one migration run. Old records are processed in id order strictly
     * after the run row's durable cursor; every outcome advances the cursor and its counter
     * in the same write, so an interrupted run resumes without duplicating active content.
     * `limit` bounds the pass (the resume shape the failure test drives); a pass that
     * reaches the old table's end marks the run succeeded. `owners` scopes the scan to
     * specific global users — the per-wave shape an operator may choose; unscoped is the
     * whole-table default.
     */
    async run(
      input: {
        runId?: string;
        limit?: number;
        owners?: readonly string[];
      } = {},
    ): Promise<MigrationRunReport> {
      const runId = input.runId ?? randomUUID();
      const limit = input.limit ?? DEFAULT_PASS_LIMIT;
      let [runRow] = await database
        .select()
        .from(hindsightMigrationRuns)
        .where(eq(hindsightMigrationRuns.id, runId))
        .limit(1);
      if (!runRow) {
        await database.insert(hindsightMigrationRuns).values({
          id: runId,
          state: "running",
        });
        runRow = {
          id: runId,
          state: "running",
          cursorOldId: null,
          processed: 0,
          migrated: 0,
          skippedPendingReview: 0,
          skippedInactive: 0,
          quarantined: 0,
          lastError: null,
          startedAt: now(),
          finishedAt: null,
          updatedAt: now(),
        };
      }
      const report: MigrationRunReport = {
        runId,
        considered: 0,
        migrated: 0,
        skippedPendingReview: 0,
        skippedInactive: 0,
        quarantined: 0,
        alreadyMigrated: 0,
        completed: false,
      };
      const counters = () => ({
        processed: runRow.processed + report.considered,
        migrated: runRow.migrated + report.migrated,
        skippedPendingReview:
          runRow.skippedPendingReview + report.skippedPendingReview,
        skippedInactive: runRow.skippedInactive + report.skippedInactive,
        quarantined: runRow.quarantined + report.quarantined,
      });
      let cursor = runRow.cursorOldId;
      let completed = false;
      while (report.considered < limit) {
        const take = Math.min(limit - report.considered, QUERY_BATCH);
        const batch = await database
          .select()
          .from(personalMemories)
          .where(
            and(
              cursor ? gt(personalMemories.id, cursor) : undefined,
              input.owners?.length
                ? inArray(personalMemories.ownerUserId, [...input.owners])
                : undefined,
            ),
          )
          .orderBy(asc(personalMemories.id))
          .limit(take);
        if (!batch.length) {
          completed = true;
          break;
        }
        for (const old of batch) {
          report.considered++;
          const outcome = await migrateOne(old, runId);
          if (outcome.migrated) report.migrated++;
          else if (outcome.bucket === "pending-review") {
            report.skippedPendingReview++;
          } else if (outcome.bucket === "inactive") report.skippedInactive++;
          else if (outcome.bucket === "quarantined") report.quarantined++;
          else report.alreadyMigrated++;
          // The durable step: the cursor advances with the record, not the batch.
          await database
            .update(hindsightMigrationRuns)
            .set({
              cursorOldId: old.id,
              ...counters(),
              updatedAt: now(),
            })
            .where(eq(hindsightMigrationRuns.id, runId));
          cursor = old.id;
        }
        if (batch.length < take) {
          completed = true;
          break;
        }
      }
      await database
        .update(hindsightMigrationRuns)
        .set({
          state: completed ? "succeeded" : "running",
          ...counters(),
          finishedAt: completed ? now() : null,
          updatedAt: now(),
        })
        .where(eq(hindsightMigrationRuns.id, runId));
      report.completed = completed;
      return report;
    },

    /**
     * The before/after reconciliation: old-side classification (what the old table holds),
     * new-side rows (what the migration produced, by subject type), and the quarantine list.
     * `balanced` is the accountability check: every confirmed-alive old record appears as a
     * migration or a quarantine, never fewer (leftovers mean a run is still resuming).
     */
    async reconcile(
      input: { owners?: readonly string[] } = {},
    ): Promise<MigrationReconciliation> {
      const oldRows = await database
        .select()
        .from(personalMemories)
        .where(
          input.owners?.length
            ? inArray(personalMemories.ownerUserId, [...input.owners])
            : undefined,
        );
      const byFormedBy: Record<string, number> = {};
      let confirmedAlive = 0;
      let pendingReview = 0;
      let inactive = 0;
      for (const row of oldRows) {
        byFormedBy[row.formedBy] = (byFormedBy[row.formedBy] ?? 0) + 1;
        const reviewed =
          row.reviewState === "confirmed" || row.reviewState === "edited";
        const alive =
          row.enabled && row.deletedAt === null && row.content !== "";
        if (reviewed && alive) confirmedAlive++;
        else if (!reviewed) pendingReview++;
        else inactive++;
      }
      const mapRows = await database
        .select()
        .from(hindsightMigrationMap)
        .where(
          input.owners?.length
            ? inArray(hindsightMigrationMap.ownerUserId, [...input.owners])
            : undefined,
        );
      const bySubjectType: Record<string, number> = {};
      for (const row of mapRows) {
        bySubjectType[row.subjectType] =
          (bySubjectType[row.subjectType] ?? 0) + 1;
      }
      const quarantineRows = await database
        .select()
        .from(hindsightMigrationQuarantine)
        .where(
          input.owners?.length
            ? inArray(hindsightMigrationQuarantine.ownerUserId, [
                ...input.owners,
              ])
            : undefined,
        );
      const byReason: Record<string, number> = {};
      for (const row of quarantineRows) {
        byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
      }
      return {
        oldSide: {
          total: oldRows.length,
          confirmedAlive,
          pendingReview,
          inactive,
          byFormedBy,
        },
        newSide: { migrated: mapRows.length, bySubjectType },
        quarantined: { total: quarantineRows.length, byReason },
        balanced: confirmedAlive >= mapRows.length + quarantineRows.length,
      };
    },

    /**
     * A bounded sample of migrated rows' subject type, id and content, for recall
     * verification through the real seams — the migration itself never claims indexed; the
     * sample says "here is what should recall", the caller proves it does.
     */
    async sampleRows(
      tenantId: string,
      limit = 5,
    ): Promise<
      { subjectType: SyncSubjectType; id: string; content: string }[]
    > {
      const mapRows = await database
        .select()
        .from(hindsightMigrationMap)
        .where(eq(hindsightMigrationMap.tenantId, tenantId))
        .limit(limit);
      const samples: {
        subjectType: SyncSubjectType;
        id: string;
        content: string;
      }[] = [];
      for (const map of mapRows) {
        if (map.subjectType === "preference") {
          const [row] = await database
            .select({ content: genericPersonalPreferences.content })
            .from(genericPersonalPreferences)
            .where(
              and(
                eq(genericPersonalPreferences.tenantId, map.tenantId),
                eq(genericPersonalPreferences.id, map.newRecordId),
              ),
            )
            .limit(1);
          if (row) {
            samples.push({
              subjectType: "preference",
              id: map.newRecordId,
              content: row.content,
            });
          }
          continue;
        }
        const [row] = await database
          .select({ content: sourceBoundMemories.content })
          .from(sourceBoundMemories)
          .where(
            and(
              eq(sourceBoundMemories.tenantId, map.tenantId),
              eq(sourceBoundMemories.id, map.newRecordId),
            ),
          )
          .limit(1);
        if (row) {
          samples.push({
            subjectType: "source_bound",
            id: map.newRecordId,
            content: row.content,
          });
        }
      }
      return samples;
    },

    /** The durable state of one run — what a resume reads before deciding anything. */
    async runState(runId: string) {
      const [row] = await database
        .select()
        .from(hindsightMigrationRuns)
        .where(eq(hindsightMigrationRuns.id, runId))
        .limit(1);
      return row ?? null;
    },
  };

  /** One old record's disposition; every branch is durable before it answers. */
  async function migrateOne(
    old: typeof personalMemories.$inferSelect,
    runId: string,
  ): Promise<
    | { bucket: "migrated"; migrated: true }
    | {
        bucket: "pending-review" | "inactive" | "already" | "quarantined";
        migrated: false;
      }
  > {
    const reviewed =
      old.reviewState === "confirmed" || old.reviewState === "edited";
    if (!reviewed) {
      // 未审核记录仍待审：counted, left in the old table, never silently confirmed.
      return { bucket: "pending-review", migrated: false };
    }
    const alive = old.enabled && old.deletedAt === null && old.content !== "";
    if (!alive) return { bucket: "inactive", migrated: false };
    const [mapped] = await database
      .select({ oldRecordId: hindsightMigrationMap.oldRecordId })
      .from(hindsightMigrationMap)
      .where(eq(hindsightMigrationMap.oldRecordId, old.id))
      .limit(1);
    if (mapped) {
      /*
       * FIX-OCR2 (O2-M4): already mapped ⇒ not isolated, on THIS path too. The cleanup used
       * to hang only off the fresh migration below, so an isolation row 0211 pre-wrote (or a
       * #394 pass wrote before the attribution drifted and came back) survived this early
       * return forever — reconcile's balanced check kept counting the record on both sides
       * and the isolation list kept reporting a migrated record as quarantined.
       */
      await clearQuarantine(old.id);
      return { bucket: "already", migrated: false };
    }
    const attribution = await attributionOf(old.ownerUserId);
    if (!attribution.proven) {
      await quarantineOne(old, attribution.reason, runId);
      return { bucket: "quarantined", migrated: false };
    }
    const { tenantId, principalId } = attribution;
    const reviewedState = old.reviewState === "edited" ? "edited" : "confirmed";

    // The permission shape, decided BEFORE any mapping: a record whose old-side restriction
    // the new tables cannot reproduce is quarantined, never reclassified. The fallback this
    // replaces let anything that missed the two restricted shapes silently become a general
    // preference — widening a Bot-restricted or source-restricted row to every authorized
    // Bot of the person. Historical rows cannot be trusted to hold the shape the branches
    // below name (the old table has no CHECK on formed_by, and a 'bot' row may lack its
    // agent id), so each branch is earned explicitly:
    //   - a Bot row needs its agent id (the restriction has no target without it);
    //   - a Bot row must carry no source_ref: the old rule additionally narrowed recall to
    //     "only while the forming Bot still holds the source app"
    //     (split_part(source_ref, '/', 1) ∈ the Bot's held server ids), and the new domain
    //     has no column to carry that clause — the row stays in the old table, reference
    //     intact, rather than migrate into a wider audience;
    //   - an import row needs its source id (its restriction IS the source);
    //   - only a person-formed row reaches the general preference the mapping names.
    if (old.formedBy === "bot" && !old.formedByAgentId) {
      await quarantineOne(old, "unmappable-permission-shape", runId);
      return { bucket: "quarantined", migrated: false };
    }
    if (old.formedBy === "bot" && old.sourceRef !== null) {
      await quarantineOne(old, "source-ref-narrowing", runId);
      return { bucket: "quarantined", migrated: false };
    }
    if (old.formedBy === "import" && !old.sourceId) {
      await quarantineOne(old, "unmappable-permission-shape", runId);
      return { bucket: "quarantined", migrated: false };
    }
    if (
      old.formedBy !== "person" &&
      old.formedBy !== "bot" &&
      old.formedBy !== "import"
    ) {
      // formed_by has no CHECK in the old table; a historical row may hold a value this
      // migration has no mapping for. Not mapping it is the only honest answer.
      await quarantineOne(old, "unmappable-permission-shape", runId);
      return { bucket: "quarantined", migrated: false };
    }

    if (old.formedBy === "bot" && old.formedByAgentId) {
      // The old rule: a Bot-formed fact is the forming Bot's alone — exactly the Bot bank's
      // restriction. The grant row is seeded so the restriction has an authorization to
      // check (the old system's standing; revocable later through #390's revocation).
      const agentId = old.formedByAgentId;
      await database
        .insert(hindsightMemoryGrants)
        .values({
          tenantId,
          principalId,
          kind: "bot",
          targetId: agentId,
          enabled: true,
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoNothing();
      await database
        .insert(sourceBoundMemories)
        .values({
          tenantId,
          id: old.id,
          principalId,
          restriction: "bot",
          workspaceId: null,
          sourceId: null,
          agentId,
          content: old.content,
          provenance: old.provenance,
          reviewState: reviewedState,
          enabled: true,
          deletedAt: null,
          formedAt: old.observedAt ?? old.createdAt,
          hindsightDocumentId: sourceBoundDocumentIdFor(tenantId, old.id),
          syncedContentDigest: null,
          syncedAt: null,
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoNothing();
      await recordMap(old, tenantId, principalId, "source_bound", runId);
      if (options.work) {
        await options.work.record({
          subjectType: "source_bound",
          tenantId,
          subjectId: old.id,
          principalId,
          contentDigest: digestOf(old.content),
        });
      }
      return { bucket: "migrated", migrated: true };
    }

    if (old.formedBy === "import" && old.sourceId) {
      // An import row's restriction is its source; the old source's enabled flag seeds the
      // grant, so a disabled old source stays disabled in the new domain.
      const [source] = await database
        .select({ enabled: memorySources.enabled })
        .from(memorySources)
        .where(eq(memorySources.id, old.sourceId))
        .limit(1);
      await database
        .insert(hindsightMemoryGrants)
        .values({
          tenantId,
          principalId,
          kind: "source",
          targetId: old.sourceId,
          enabled: source?.enabled ?? true,
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoNothing();
      await database
        .insert(sourceBoundMemories)
        .values({
          tenantId,
          id: old.id,
          principalId,
          restriction: "source",
          workspaceId: null,
          sourceId: old.sourceId,
          agentId: null,
          content: old.content,
          provenance: old.provenance,
          reviewState: reviewedState,
          enabled: true,
          deletedAt: null,
          formedAt: old.observedAt ?? old.createdAt,
          hindsightDocumentId: sourceBoundDocumentIdFor(tenantId, old.id),
          syncedContentDigest: null,
          syncedAt: null,
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoNothing();
      await recordMap(old, tenantId, principalId, "source_bound", runId);
      if (options.work) {
        await options.work.record({
          subjectType: "source_bound",
          tenantId,
          subjectId: old.id,
          principalId,
          contentDigest: digestOf(old.content),
        });
      }
      return { bucket: "migrated", migrated: true };
    }

    // A person-formed confirmed fact: the general personal preference of the one company the
    // attribution proved. The old audience (the person's own Bots) maps to the same company's
    // authorized Bots; the validity window opens at the old record's last review act — its
    // OpenBot birth is the one start this migration can honestly claim.
    await database
      .insert(genericPersonalPreferences)
      .values({
        tenantId,
        id: old.id,
        principalId,
        content: old.content,
        provenance: old.provenance,
        reviewState: reviewedState,
        enabled: true,
        deletedAt: null,
        markedGenericAt: old.updatedAt,
        hindsightDocumentId: preferenceDocumentIdFor(tenantId, old.id),
        syncedContentDigest: null,
        syncedAt: null,
        effectiveFrom: old.updatedAt,
        effectiveUntil: null,
        supersededBy: null,
        supersededTimeUnknown: false,
        correctedAt: null,
        createdAt: now(),
        updatedAt: now(),
      })
      .onConflictDoNothing();
    await recordMap(old, tenantId, principalId, "preference", runId);
    if (options.work) {
      await options.work.record({
        subjectType: "preference",
        tenantId,
        subjectId: old.id,
        principalId,
        contentDigest: digestOf(old.content),
      });
    }
    return { bucket: "migrated", migrated: true };
  }

  /**
   * Hold one old record back: the isolation list keeps the old id, owner and reason —
   * content never, and the old row itself is left exactly as it was.
   *
   * FIX-OCR3 (O3-M3): a later re-scan refreshes, never duplicates — the column contract the
   * schema comment states. The same old id can be re-judged after membership drift (a
   * `no-principal` that became `ambiguous-company`, an attribution that narrowed), and the
   * isolation list must answer WHY it is held NOW: `onConflictDoNothing` kept the first
   * verdict forever, so the list and reconcile's byReason read stale long after the facts
   * moved. The run moves with the verdict — the newest judgement owns the row, and reconcile
   * counts live rows, never a snapshot.
   */
  async function quarantineOne(
    old: typeof personalMemories.$inferSelect,
    reason: QuarantineReason,
    runId: string,
  ): Promise<void> {
    await database
      .insert(hindsightMigrationQuarantine)
      .values({
        oldRecordId: old.id,
        ownerUserId: old.ownerUserId,
        reason,
        quarantinedAt: now(),
        runId,
      })
      .onConflictDoUpdate({
        target: hindsightMigrationQuarantine.oldRecordId,
        set: { reason, quarantinedAt: now(), runId },
      });
  }

  /**
   * The map row is the durable fact; whatever an earlier isolation verdict left beside the
   * same old id goes. Both paths that decide "this record is mapped" run it — the fresh
   * migration in recordMap, and migrateOne's mapped early-return — so "in the map ⇒ not in
   * the isolation list" holds no matter which pass a record arrived by (FIX-OCR2 O2-M4).
   */
  async function clearQuarantine(oldRecordId: string): Promise<void> {
    await database
      .delete(hindsightMigrationQuarantine)
      .where(eq(hindsightMigrationQuarantine.oldRecordId, oldRecordId));
  }

  async function recordMap(
    old: typeof personalMemories.$inferSelect,
    tenantId: string,
    principalId: string,
    subjectType: "preference" | "source_bound",
    runId: string,
  ) {
    await database
      .insert(hindsightMigrationMap)
      .values({
        oldRecordId: old.id,
        ownerUserId: old.ownerUserId,
        tenantId,
        principalId,
        subjectType,
        newRecordId: old.id,
        runId,
        migratedAt: now(),
      })
      .onConflictDoNothing();
    /*
     * A row that migrates is no longer isolated, whatever an earlier pass decided: the
     * quarantine rows 0211 pre-wrote and a #394 pass of its own both key the same old id, and
     * one left behind here would keep the reconcile's balanced check reading "still a
     * breakpoint to run" forever, and tell the isolation list a migrated record is still
     * quarantined. The map row above is the durable fact; this deletes whatever the old
     * attribution verdict left beside it.
     */
    await clearQuarantine(old.id);
  }
}

export type LegacyMemoryMigrator = ReturnType<
  typeof createLegacyMemoryMigrator
>;
