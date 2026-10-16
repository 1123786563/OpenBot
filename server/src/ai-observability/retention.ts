/**
 * Retention policy and real deletion for observation data (Issue #41 / DAG T35).
 *
 * Three moving parts, in the order data meets them:
 *
 *  - THE POLICY. Deployment-wide defaults from env, per-scope overrides in a table, folded
 *    per category — null in an override means "no opinion", never "the default written
 *    down as a row". The fold lives in one pure function (`effectiveRetention`) and its
 *    SQL mirror in discovery's `coalesce`, and the expiry boundary is `<=` so
 *    exactly-retention-days-old IS expired.
 *
 *  - THE OFFER. Discovery sweeps the four tables (run bindings, datasets, experiments,
 *    export jobs) and inserts one deletion record per expired target, unique on
 *    (kind, target) so a target is offered exactly once however often discovery runs.
 *    The record freezes everything a retry needs after the target row is gone: the
 *    locator, the upstream reference, and the policy that expired it. Datasets that a
 *    not-yet-expired experiment still pins are not offered — the pin is discovered, not
 *    crashed into; the foreign key stays as the backstop and maps to
 *    RETENTION_TARGET_PINNED when something forces the order anyway.
 *
 *  - THE DELETION. A worker claims tickets off the shared work queue under lease (the
 *    T34 pattern: `for update skip locked`, renewed while running, so two replicas never
 *    hold one target), deletes the upstream copy first through the only sanctioned port
 *    (`pending` → `upstream_done`, the T19 sync-state discipline: an upstream failure
 *    parks in `failed` with the row intact and the ticket released for an honest retry —
 *    never a faked success), then deletes the local row through the sanctioned channels
 *    (the 0124 dataset_cleanup and 0126 experiment_cleanup flags, plain DELETE for the
 *    guardless tables), then marks `deleted` with `deleted_at` and writes an audit row of
 *    references and counts. Deletion is REAL: rows go away, versions cascade, artifacts
 *    vanish with their job row, and a fresh connection cannot read any of it back.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { getLogger } from "../../../shared/logger";
import { workOwner } from "../../../shared/work-owner";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { workItems } from "../db/schema";
import {
  type AiObservationDeletionKind,
  type AiObservationDeletionState,
  aiObservationRetentionDeletions,
  aiObservationRetentionOverrides,
} from "../db/schema/ai-observability-retention";
import { type Repeating, repeatAfterEach } from "../work/loop";
import { createWorkQueue, type WorkQueue } from "../work/queue";
import type { OpikConfig } from "./config";
import type { ObservationScope } from "./contracts";
import {
  createObservationExportStore,
  type ObservationExportStore,
} from "./exports";
import { type OpikPort, OpikPortError, type OpikPortResult } from "./opik-port";
import { assertObservationScope } from "./scope";

/*
 * Deployment bounds. Days, per category, fail-closed: an unparsable, zero, negative or
 * over-max env value keeps the default rather than being guessed at.
 */
export const DEFAULT_RETENTION_RUNS_DAYS = 7;
export const DEFAULT_RETENTION_DATASETS_DAYS = 30;
export const DEFAULT_RETENTION_EXPERIMENTS_DAYS = 30;
export const DEFAULT_RETENTION_EXPORTS_DAYS = 7;
export const MAX_RETENTION_DAYS = 3_650;

export type RetentionDays = Readonly<{
  runs: number;
  datasets: number;
  experiments: number;
  exports: number;
}>;

const RETENTION_ENV: Readonly<Record<keyof RetentionDays, string>> = {
  runs: "OPIK_RETENTION_RUNS_DAYS",
  datasets: "OPIK_RETENTION_DATASETS_DAYS",
  experiments: "OPIK_RETENTION_EXPERIMENTS_DAYS",
  exports: "OPIK_RETENTION_EXPORTS_DAYS",
};

const RETENTION_DEFAULTS: Readonly<Record<keyof RetentionDays, number>> = {
  runs: DEFAULT_RETENTION_RUNS_DAYS,
  datasets: DEFAULT_RETENTION_DATASETS_DAYS,
  experiments: DEFAULT_RETENTION_EXPERIMENTS_DAYS,
  exports: DEFAULT_RETENTION_EXPORTS_DAYS,
};

/** One bounded day count, or the default — never a guess at what the value "meant". */
function retentionDay(
  env: Readonly<Record<string, string | undefined>>,
  category: keyof RetentionDays,
): number {
  const raw = (env[RETENTION_ENV[category]] ?? "").trim();
  // Number, not parseInt: "1.5" is not one-and-a-half days of policy, it is no policy.
  const parsed = raw === "" ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_RETENTION_DAYS
    ? parsed
    : RETENTION_DEFAULTS[category];
}

/** The deployment's global retention, from four env names, fail-closed per category. */
export function resolveRetentionDays(
  env: Readonly<Record<string, string | undefined>>,
): RetentionDays {
  return {
    runs: retentionDay(env, "runs"),
    datasets: retentionDay(env, "datasets"),
    experiments: retentionDay(env, "experiments"),
    exports: retentionDay(env, "exports"),
  };
}

/** The expiry boundary: `<=`, so a record exactly retention-days old IS expired. */
export function isExpired(input: {
  asOf: Date;
  createdAt: Date;
  days: number;
}): boolean {
  return (
    input.createdAt.getTime() <= input.asOf.getTime() - input.days * 86_400_000
  );
}

/** One scope's say per category; null is the honest "no opinion". */
export type RetentionOverride = Readonly<{
  runs: number | null;
  datasets: number | null;
  experiments: number | null;
  exports: number | null;
}>;

/** The policy fold: an override field answers only where it has an opinion. */
export function effectiveRetention(
  global: RetentionDays,
  override: RetentionOverride,
): RetentionDays {
  return {
    runs: override.runs ?? global.runs,
    datasets: override.datasets ?? global.datasets,
    experiments: override.experiments ?? global.experiments,
    exports: override.exports ?? global.exports,
  };
}

/** The work-queue kind a deletion's claim ticket rides on. */
export const RETENTION_WORK_KIND = "opik.retention";

/**
 * The visibility half of the deletion precondition (M1a): a target with a deletion
 * record is already gone to readers — from discovery on, however long the upstream
 * half then parks in `failed`. Reader paths append this to their WHERE clause with
 * the target's id column; it answers "no deletion record exists for this target
 * of this kind" through the (kind, target) unique index.
 */
export function notPendingDeletion(
  kind: AiObservationDeletionKind,
  target: PgColumn,
): SQL {
  return sql`not exists (select 1 from ai_observation_retention_deletions d where d.kind = ${kind} and d.target_id = ${target})`;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_CONCURRENCY = 2;
/** Discovery stays bounded per pass: the sweep is a loop, not a lock-in. */
const DISCOVERY_BATCH = 500;

/** Governance counts answer for every kind and state, zeros included. */
export type RetentionDeletionCounts = Readonly<
  Record<
    AiObservationDeletionKind,
    Readonly<Record<AiObservationDeletionState, number>>
  >
>;

/** The stored failure vocabulary. Body-free codes, never upstream text. */
const RETENTION_ERROR_CODES = [
  "CAPABILITY_MISSING",
  "RETENTION_TARGET_PINNED",
  "OPIK_TIMEOUT",
  "OPIK_UNREACHABLE",
  "OPIK_UPSTREAM_ERROR",
  "OPIK_CLIENT_ERROR",
  "OPIK_MALFORMED_RESPONSE",
  "OPIK_OWNERSHIP_DRIFT",
] as const;

export type RetentionErrorCode = (typeof RETENTION_ERROR_CODES)[number];

/** Internal: a deletion pass failed, with the code the record will carry. */
class RetentionFailure extends Error {
  constructor(public code: RetentionErrorCode) {
    super(code);
  }
}

export type ObservationRetentionStore = {
  /** Replace this scope's override. Unspecified categories go back to "no opinion". */
  setOverride(
    scope: ObservationScope,
    values: {
      runs?: number | null;
      datasets?: number | null;
      experiments?: number | null;
      exports?: number | null;
    },
  ): Promise<void>;
  /**
   * `pending` → `upstream_done`, only from pending: the crash-recovery seam between the
   * upstream and local halves of a deletion. Null when the record has moved on — first
   * terminal write wins, and a second settle of the same record is refused.
   */
  markUpstreamDone(
    id: string,
  ): Promise<typeof aiObservationRetentionDeletions.$inferSelect | null>;
  /** Deletion records by kind and state, zeros included — the governance surface. */
  deletionCounts(): Promise<RetentionDeletionCounts>;
};

export function createObservationRetentionStore(
  db: Database,
): ObservationRetentionStore {
  return {
    async setOverride(scope, values) {
      assertObservationScope(scope);
      const next = {
        runsDays: values.runs ?? null,
        datasetsDays: values.datasets ?? null,
        experimentsDays: values.experiments ?? null,
        exportsDays: values.exports ?? null,
        updatedAt: new Date(),
      };
      await db
        .insert(aiObservationRetentionOverrides)
        .values({ scopeKey: scope.key, ...next })
        .onConflictDoUpdate({
          target: aiObservationRetentionOverrides.scopeKey,
          set: next,
        });
    },

    async markUpstreamDone(id) {
      const rows = await db
        .update(aiObservationRetentionDeletions)
        // lastError rides only with 'failed' (the table's own check), so the
        // transition out of a failed retry clears it here.
        .set({ state: "upstream_done", lastError: null, updatedAt: new Date() })
        .where(
          and(
            eq(aiObservationRetentionDeletions.id, id),
            inArray(aiObservationRetentionDeletions.state, [
              "pending",
              "failed",
            ]),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async deletionCounts() {
      const rows = await db
        .select({
          kind: aiObservationRetentionDeletions.kind,
          state: aiObservationRetentionDeletions.state,
          total: sql<number>`count(*)::int`,
        })
        .from(aiObservationRetentionDeletions)
        .groupBy(
          aiObservationRetentionDeletions.kind,
          aiObservationRetentionDeletions.state,
        );
      const counts: Record<
        AiObservationDeletionKind,
        Record<AiObservationDeletionState, number>
      > = {
        run: { pending: 0, upstream_done: 0, deleted: 0, failed: 0 },
        dataset: { pending: 0, upstream_done: 0, deleted: 0, failed: 0 },
        experiment: { pending: 0, upstream_done: 0, deleted: 0, failed: 0 },
        export: { pending: 0, upstream_done: 0, deleted: 0, failed: 0 },
      };
      for (const row of rows) {
        counts[row.kind][row.state] = row.total;
      }
      return counts;
    },
  };
}

/** One discovered target, as discovery freezes it into the record. */
type DiscoveredTarget = {
  id: string;
  scope_key: string;
  actor_id: string;
  bot_id: string;
  retention_days: number;
  opik_trace_id?: string | null;
  locator_workspace?: string | null;
  locator_project?: string | null;
  opik_dataset_id?: string | null;
  sync_state?: string | null;
};

export type ObservationRetentionWorker = {
  /** Offer expired targets once: insert deletion records and their claim tickets. */
  discover(): Promise<void>;
  /** Discovery, then one bounded pass over claimable tickets. */
  sweep(): Promise<void>;
  /** Poll-driven scheduling on the house loop. Tests drive `sweep` directly. */
  start(): Repeating;
};

export type ObservationRetentionWorkerDeps = Readonly<{
  database: Database;
  config: () => OpikConfig;
  /**
   * The verified port, or null when no verified contract backs this deployment. Purely
   * local deletions proceed regardless; an upstream-carrying record without a port fails
   * CAPABILITY_MISSING rather than deleting only half the world's copy.
   */
  port: OpikPort | null;
  /** The deployment's global retention; scope overrides fold on top per category. */
  retention: () => RetentionDays;
  /** Where the deletion audit rows go. */
  audit: AuditStore;
  /**
   * The stop half of the deletion precondition (M1b): the store whose queued/running
   * exports are cancelled before the scope's data face changes under a fetch in
   * flight. Defaults to one built on the same database.
   */
  exportStore?: ObservationExportStore;
  /**
   * The cache half of the deletion precondition (M1c): an explicit invalidation
   * call point per deletion. Wiring (T33) points this at the read surfaces' caches
   * (the T11 window cache); until then the default is the honest no-op.
   */
  invalidateReads?: (input: {
    scopeKey: string;
    kind: AiObservationDeletionKind;
  }) => Promise<void> | void;
  owner?: string;
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  queue?: WorkQueue;
}>;

export function createObservationRetentionWorker(
  deps: ObservationRetentionWorkerDeps,
): ObservationRetentionWorker {
  const log = getLogger("server");
  const db = deps.database;
  const store = createObservationRetentionStore(db);
  const exportStore = deps.exportStore ?? createObservationExportStore(db);
  const queue = deps.queue ?? createWorkQueue(deps.database);
  const owner = deps.owner ?? workOwner("opik-retention");
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  let sweeping = false;

  /**
   * The T09 gate, upstream half only: a record that names an upstream copy needs the
   * integration on and a verified port behind it. Local-only deletions never pass here.
   */
  const gate = (): OpikPort => {
    const config = deps.config();
    if (!config.enabled || deps.port === null) {
      throw new RetentionFailure("CAPABILITY_MISSING");
    }
    return deps.port;
  };

  /** Port failure onto the stored vocabulary; the outcome is what failed. */
  const failureCode = (result: OpikPortResult<never>): RetentionErrorCode => {
    if (result.outcome === "ok") return "OPIK_UPSTREAM_ERROR";
    return result.outcome === "ownership_drift"
      ? "OPIK_OWNERSHIP_DRIFT"
      : result.code;
  };

  const discover = async (): Promise<void> => {
    const global = deps.retention();

    /*
     * Each query folds the policy in SQL — coalesce(override, default) decides the cutoff
     * per row, which is the same fold `effectiveRetention` states in TypeScript. `limit`
     * keeps one pass bounded; the poll loop behind `sweep` eats the rest.
     */
    const runs = await db.$client<DiscoveredTarget[]>`
      select b.id, b.scope_key, b.actor_id, b.bot_id, b.opik_trace_id,
             b.locator_workspace, b.locator_project,
             coalesce(o.runs_days, ${global.runs}) as retention_days
      from ai_observation_bindings b
      left join ai_observation_retention_overrides o on o.scope_key = b.scope_key
      where b.state <> 'running'
        and b.created_at <= now() - make_interval(days => coalesce(o.runs_days, ${global.runs}))
      limit ${DISCOVERY_BATCH}`;

    const datasets = await db.$client<DiscoveredTarget[]>`
      select d.id, d.scope_key, d.actor_id, d.bot_id, d.opik_dataset_id, d.sync_state,
             coalesce(o.datasets_days, ${global.datasets}) as retention_days
      from ai_observation_datasets d
      left join ai_observation_retention_overrides o on o.scope_key = d.scope_key
      where d.created_at <= now() - make_interval(days => coalesce(o.datasets_days, ${global.datasets}))
        and not exists (
          select 1
          from ai_observation_experiments e
          left join ai_observation_retention_overrides oe on oe.scope_key = e.scope_key
          where e.dataset_version_id in (
            select v.id from ai_observation_dataset_versions v where v.dataset_id = d.id
          )
          and e.created_at > now() - make_interval(days => coalesce(oe.experiments_days, ${global.experiments}))
        )
      limit ${DISCOVERY_BATCH}`;

    const experiments = await db.$client<DiscoveredTarget[]>`
      select e.id, e.scope_key, e.actor_id, e.bot_id,
             coalesce(o.experiments_days, ${global.experiments}) as retention_days
      from ai_observation_experiments e
      left join ai_observation_retention_overrides o on o.scope_key = e.scope_key
      where e.created_at <= now() - make_interval(days => coalesce(o.experiments_days, ${global.experiments}))
      limit ${DISCOVERY_BATCH}`;

    const exports = await db.$client<DiscoveredTarget[]>`
      select j.id, j.scope_key, j.actor_id, j.bot_id,
             coalesce(o.exports_days, ${global.exports}) as retention_days
      from ai_observation_export_jobs j
      left join ai_observation_retention_overrides o on o.scope_key = j.scope_key
      where j.state = 'completed' and j.settled_at is not null
        and j.settled_at <= now() - make_interval(days => coalesce(o.exports_days, ${global.exports}))
      limit ${DISCOVERY_BATCH}`;

    /**
     * One offer: records and tickets in one transaction, both idempotent. The
     * ticket insert covers EVERY non-terminal record in the batch, not only the
     * freshly inserted ones — a ticket a purge removed while its record parks in
     * pending/failed is invisible to the record insert (the (kind, target)
     * conflict is a no-op), and without this re-offer that target would never be
     * retried. Terminal records are excluded: their work is done, and their
     * source rows no longer surface in discovery anyway.
     */
    const offer = async (
      kind: AiObservationDeletionKind,
      targets: readonly DiscoveredTarget[],
      record: (
        target: DiscoveredTarget,
      ) => Omit<
        typeof aiObservationRetentionDeletions.$inferInsert,
        "id" | "kind"
      >,
    ) => {
      if (targets.length === 0) return;
      await db.transaction(async (tx) => {
        await tx
          .insert(aiObservationRetentionDeletions)
          .values(
            targets.map((target) => ({
              ...record(target),
              id: randomUUID(),
              kind,
            })),
          )
          .onConflictDoNothing();
        const wantsWork = await tx
          .select({ id: aiObservationRetentionDeletions.id })
          .from(aiObservationRetentionDeletions)
          .where(
            and(
              eq(aiObservationRetentionDeletions.kind, kind),
              inArray(
                aiObservationRetentionDeletions.targetId,
                targets.map((target) => target.id),
              ),
              ne(aiObservationRetentionDeletions.state, "deleted"),
            ),
          );
        if (wantsWork.length > 0) {
          await tx
            .insert(workItems)
            .values(
              wantsWork.map(({ id }) => ({
                kind: RETENTION_WORK_KIND,
                key: id,
              })),
            )
            .onConflictDoNothing();
        }
      });
    };

    await offer("run", runs, (t) => ({
      scopeKey: t.scope_key,
      actorId: t.actor_id,
      botId: t.bot_id,
      targetId: t.id,
      locatorWorkspace: t.locator_workspace ?? null,
      locatorProject: t.locator_project ?? null,
      upstreamKind: t.opik_trace_id ? "trace" : null,
      upstreamId: t.opik_trace_id ?? null,
      retentionDays: t.retention_days,
    }));

    await offer("dataset", datasets, (t) => ({
      scopeKey: t.scope_key,
      actorId: t.actor_id,
      botId: t.bot_id,
      targetId: t.id,
      upstreamKind:
        t.sync_state === "synced" && t.opik_dataset_id ? "dataset" : null,
      upstreamId:
        t.sync_state === "synced" && t.opik_dataset_id
          ? t.opik_dataset_id
          : null,
      retentionDays: t.retention_days,
    }));

    await offer("experiment", experiments, (t) => ({
      scopeKey: t.scope_key,
      actorId: t.actor_id,
      botId: t.bot_id,
      targetId: t.id,
      retentionDays: t.retention_days,
    }));

    await offer("export", exports, (t) => ({
      scopeKey: t.scope_key,
      actorId: t.actor_id,
      botId: t.bot_id,
      targetId: t.id,
      retentionDays: t.retention_days,
    }));
  };

  /** The local half: real row deletion through each table's sanctioned channel. */
  const deleteLocal = async (
    record: typeof aiObservationRetentionDeletions.$inferSelect,
  ): Promise<void> => {
    switch (record.kind) {
      case "run":
        // Bindings have no delete guard: the binding table's own write path is the channel.
        await db.execute(
          sql`delete from ai_observation_bindings where id = ${record.targetId} and scope_key = ${record.scopeKey}`,
        );
        return;
      case "dataset":
        try {
          // 0124's flag channel, the same one T20's cleanup API opens: the versions'
          // delete guard refuses every other DELETE, and the cascade removes them here.
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('ai_observation.dataset_cleanup', 'on', true)`,
            );
            await tx.execute(
              sql`delete from ai_observation_datasets where id = ${record.targetId} and scope_key = ${record.scopeKey}`,
            );
          });
        } catch (error) {
          if (pgCode(error) === "23503") {
            // An experiment still pins a version: the pin is a fact to surface, not
            // a constraint to route around.
            throw new RetentionFailure("RETENTION_TARGET_PINNED");
          }
          throw error;
        }
        return;
      case "experiment":
        // 0126 shipped this channel for exactly this ticket; there is no flagless path.
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('ai_observation.experiment_cleanup', 'on', true)`,
          );
          await tx.execute(
            sql`delete from ai_observation_experiments where id = ${record.targetId} and scope_key = ${record.scopeKey}`,
          );
        });
        return;
      case "export":
        // The artifact is a column of the job row: deleting the row deletes it, file
        // and canary and all, which is the whole point.
        await db.execute(
          sql`delete from ai_observation_export_jobs where id = ${record.targetId} and scope_key = ${record.scopeKey}`,
        );
        return;
    }
  };

  /** Park in `failed` with the code, conditional on not being terminal already. */
  const markFailed = async (id: string, code: RetentionErrorCode) => {
    await db
      .update(aiObservationRetentionDeletions)
      .set({ state: "failed", lastError: code, updatedAt: new Date() })
      .where(
        and(
          eq(aiObservationRetentionDeletions.id, id),
          ne(aiObservationRetentionDeletions.state, "deleted"),
        ),
      );
  };

  /** Terminal, exactly once: only a non-deleted row can become deleted. */
  const markDeleted = async (
    id: string,
  ): Promise<typeof aiObservationRetentionDeletions.$inferSelect | null> => {
    const rows = await db
      .update(aiObservationRetentionDeletions)
      .set({
        state: "deleted",
        deletedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiObservationRetentionDeletions.id, id),
          ne(aiObservationRetentionDeletions.state, "deleted"),
        ),
      )
      .returning();
    return rows[0] ?? null;
  };

  const runOne = async (id: string): Promise<void> => {
    const found = await db
      .select()
      .from(aiObservationRetentionDeletions)
      .where(eq(aiObservationRetentionDeletions.id, id));
    const record = found[0];
    const finish = () =>
      queue.finish({ kind: RETENTION_WORK_KIND, key: id, owner });
    if (!record || record.state === "deleted") {
      // Already someone's completed truth, or nothing left to do.
      await finish();
      return;
    }

    // This pass counts, including the ones that will fail.
    await db
      .update(aiObservationRetentionDeletions)
      .set({
        attempts: sql`${aiObservationRetentionDeletions.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(aiObservationRetentionDeletions.id, id));

    try {
      /*
       * The M1 precondition sequence, before any deletion I/O: (a) visibility is
       * already revoked — `notPendingDeletion` makes every reader treat a target
       * with a deletion record as gone, from discovery on, however long the
       * upstream half then parks in failed; (b) stop the affected work: a run's
       * data face is what the scope's queued/running exports fetch, so they are
       * settled cancelled before the deletion changes it under them; (c) drop the
       * read caches, so no projection keeps serving what readers can no longer
       * see. All three are idempotent — a retry pass runs the sequence again
       * harmlessly.
       */
      if (record.kind === "run") {
        await exportStore.cancelForScope(record.scopeKey);
      }
      await deps.invalidateReads?.({
        scopeKey: record.scopeKey,
        kind: record.kind,
      });
      if (record.upstreamKind !== null && record.state !== "upstream_done") {
        const port = gate();
        const locator = Object.freeze({
          scopeKey: record.scopeKey,
          workspace: record.locatorWorkspace ?? "",
          project: record.locatorProject ?? "",
        });
        const result =
          record.upstreamKind === "trace"
            ? await port.deleteTraces(locator, {
                traceIds: [record.upstreamId ?? ""],
              })
            : await port.deleteDataset(locator, {
                datasetId: record.upstreamId ?? "",
              });
        if (result.outcome !== "ok") {
          throw new RetentionFailure(
            failureCode(result as OpikPortResult<never>),
          );
        }
        const moved = await store.markUpstreamDone(id);
        if (moved === null) {
          // Another pass settled this record while we held the upstream call. The
          // truth is theirs; ours is only to finish the ticket.
          await finish();
          return;
        }
      }

      await deleteLocal(record);

      const done = await markDeleted(id);
      if (done) {
        // References and counts, never content: nothing a deleted artifact held can
        // be read back out of the trail.
        await recordAuditEvent(deps.audit, {
          eventType: "opik.retention_deleted",
          targetType: `ai_observation_${record.kind}`,
          targetId: record.targetId,
          initiator: { kind: "deployment" },
          payload: {
            kind: record.kind,
            retentionDays: record.retentionDays,
            attempts: record.attempts + 1,
          },
        });
      }
      await finish();
    } catch (error) {
      const code =
        error instanceof RetentionFailure
          ? error.code
          : error instanceof OpikPortError
            ? "CAPABILITY_MISSING"
            : pgCode(error) === "23503"
              ? "RETENTION_TARGET_PINNED"
              : "OPIK_UPSTREAM_ERROR";
      await markFailed(id, code);
      // The work still wants doing — just not by this pass. Released, not finished,
      // so the next sweep retries with everything the record froze.
      await queue.release({
        kind: RETENTION_WORK_KIND,
        key: id,
        owner,
        delayMs: 0,
        reason: code,
      });
    }
  };

  const sweep = async (): Promise<void> => {
    // Never overlapping with itself on this replica: a second pass would claim a
    // second batch and the bound would be the backlog, not the configuration.
    if (sweeping) return;
    sweeping = true;
    try {
      await discover();
      const items = await queue.claim({
        kind: RETENTION_WORK_KIND,
        owner,
        leaseMs,
        limit: concurrency,
      });
      await Promise.all(
        items.map((item) =>
          runOne(item.key).catch((error) => {
            // The record keeps its own truth; a runner crash must not take the
            // poll loop down with it.
            log.warn(
              { type: "opik-retention-run-failed", key: item.key },
              "opik-retention-run-failed",
            );
            void error;
          }),
        ),
      );
    } finally {
      sweeping = false;
    }
  };

  return {
    discover,
    sweep,
    start: () =>
      repeatAfterEach(async () => {
        try {
          await sweep();
        } catch (error) {
          log.warn(
            { type: "opik-retention-sweep-failed", error: String(error) },
            "opik-retention-sweep-failed",
          );
        }
      }, deps.pollMs ?? DEFAULT_POLL_MS),
  };
}

/** A Postgres SQLSTATE off any wrapper the driver stack might hand back. */
function pgCode(error: unknown): string | undefined {
  let candidate = error as
    | {
        errno?: unknown;
        code?: unknown;
        cause?: unknown;
      }
    | undefined;
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    // Bun's PostgresError puts the SQLSTATE in errno; drizzle's wrapper carries the
    // original as cause. Whichever layer is on top, the five-char code is the fact.
    for (const field of ["errno", "code"] as const) {
      const value = candidate[field];
      if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)) {
        return value;
      }
    }
    candidate = candidate.cause as typeof candidate;
  }
  return undefined;
}
