/**
 * Observation-data retention: expiry by configured window, then real deletion
 * (Issue #41 / DAG T35).
 *
 * Retention is governance, not authorization. The sweep deletes by the window a
 * scope is governed by — deployment default, or the scope's override row —
 * whether or not the actor still holds any permission, so nothing here re-derives
 * authorization or asks a user: the windows say when data dies, and the sweep is
 * the thing that dies with them.
 *
 * Deletion is real, in both places, in the only safe order:
 *
 *  - UPSTREAM FIRST, LOCAL LAST. The local row is the record of "an upstream
 *    copy still exists"; deleting it first would orphan a trace nobody can find
 *    again. A failure between the two leaves the row behind, which is exactly
 *    the retry the next sweep performs — upstream deletion is idempotent (204
 *    for ids it no longer has), so a crash after the upstream call settles on
 *    the retry instead of leaking.
 *  - The immutable tables open only through their transaction-local cleanup
 *    flags: dataset versions through `ai_observation.dataset_cleanup` (0124),
 *    experiments through `ai_observation.experiment_cleanup` (0126). No sweep
 *    path bypasses the guards; the flags are the sanctioned channel, the same
 *    seam T20's dataset cleanup uses.
 *  - Frozen experiments pin dataset versions (0124's point), so a version whose
 *    dataset is expired but still pinned is skipped, and the experiment sweep
 *    runs BEFORE the dataset sweep: expired experiments unpin first, and the
 *    pinned remainder is the truly-not-yet-expired set.
 *
 * The sweep itself is bounded on the T34 lease pattern: one claim per time
 * bucket on the shared work queue, so N replicas produce one sweep per bucket
 * rather than N (the lease is the anti-double-delete record; a takeover after
 * a lost lease re-runs idempotent deletes, never concurrent ones), and each
 * category processes at most `batchSize` rows per pass — the backlog is work
 * for the next bucket, never an unbounded transaction.
 *
 * The audit row carries the bucket and the counts, never the content: what was
 * deleted is gone, and the trail must not become the place a copy of it
 * survives.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { getLogger } from "../../../shared/logger";
import { workOwner } from "../../../shared/work-owner";
import type { AuditStore } from "../audit";
import type { Database } from "../db/client";
import { aiObservationBindings } from "../db/schema/ai-observability-bindings";
import { aiObservationDatasets } from "../db/schema/ai-observability-datasets";
import { aiObservationExperiments } from "../db/schema/ai-observability-experiments";
import { aiObservationExportJobs } from "../db/schema/ai-observability-exports";
import { aiObservationRetentionPolicies } from "../db/schema/ai-observability-retention";
import { type Repeating, repeatAfterEach } from "../work/loop";
import { createWorkQueue, type WorkQueue } from "../work/queue";
import type { OpikConfig } from "./config";
import type { ObservationScope } from "./contracts";
import type { OpikPort, OpikPortResult } from "./opik-port";
import { resolveObservationScope } from "./scope";

/** The spec's proposed first defaults (§10): run traces 7 days, evaluations 30. */
export const DEFAULT_RETENTION_RUNS_DAYS = 7;
export const DEFAULT_RETENTION_DATASETS_DAYS = 30;
/** The ceiling a configured window may reach; "forever" has its own spelling (0). */
export const MAX_RETENTION_DAYS = 3_650;
/** The deliberate off answer: keep this category forever, sweep must respect it. */
export const RETENTION_KEEP_FOREVER = 0;

export type RetentionPolicy = Readonly<{
  runsDays: number;
  datasetsDays: number;
}>;

function windowDays(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (
    Number.isInteger(parsed) &&
    parsed >= RETENTION_KEEP_FOREVER &&
    parsed <= MAX_RETENTION_DAYS
  ) {
    return parsed;
  }
  return fallback;
}

/**
 * The deployment's default windows, from exactly two env names. Unparsable or
 * out-of-range values keep the conservative default rather than being guessed
 * at (the T09 config precedent).
 */
export function resolveRetentionDefaults(
  env: Readonly<Record<string, string | undefined>>,
): RetentionPolicy {
  return {
    runsDays: windowDays(env.OPIK_RETENTION_RUNS_DAYS, DEFAULT_RETENTION_RUNS_DAYS),
    datasetsDays: windowDays(
      env.OPIK_RETENTION_DATASETS_DAYS,
      DEFAULT_RETENTION_DATASETS_DAYS,
    ),
  };
}

/**
 * Whether `anchor` has outlived `days` at `now`. The edge is inclusive: a row
 * whose window closes exactly now is expired, and `days <= 0` is keep-forever,
 * never "expired since before it was written".
 */
export function isExpired(anchor: Date, days: number, now: Date): boolean {
  if (!Number.isInteger(days) || days <= RETENTION_KEEP_FOREVER) return false;
  return anchor.getTime() + days * 86_400_000 <= now.getTime();
}

/*
 * Rebuilding a scope from a stored scope key (the length-prefixed join T06
 * writes onto every observation row). This is the governance exception to "no
 * scope without live authorization": retention must delete an actor's data
 * precisely when the actor no longer exists to authorize anything, and the key
 * itself is the identity the tables already hold. The ownership answer does not
 * participate in the key, so any authorized spelling re-issues the same key.
 * Anything that is not a workbench key is refused — a future kind's keys are
 * not guessed at, they are skipped and counted.
 */
export function scopeFromStoredKey(key: string): ObservationScope | null {
  const parts = key.split("|");
  if (parts.length !== 4 || parts[0] !== "wb") return null;
  const read = (segment: string): string | null => {
    const at = segment.indexOf(":");
    if (at <= 0) return null;
    const length = Number(segment.slice(0, at));
    const value = segment.slice(at + 1);
    if (!Number.isInteger(length) || length < 1 || value.length !== length) {
      return null;
    }
    return value;
  };
  const actorId = read(parts[1]);
  const botId = read(parts[2]);
  const epochText = read(parts[3]);
  if (actorId === null || botId === null || epochText === null) return null;
  const epoch = Number(epochText);
  if (!Number.isInteger(epoch) || epoch < 0 || String(epoch) !== epochText) {
    return null;
  }
  try {
    return resolveObservationScope({
      actorId,
      botId,
      ownership: "owner",
      epoch,
    });
  } catch {
    // A key this process refuses to re-issue (the dev placeholder, an empty
    // field) is not a scope; the sweep skips and counts it rather than deleting
    // upstream state it cannot name.
    return null;
  }
}

export type RetentionErrorCode =
  | "RETENTION_INPUT_INVALID"
  | "RETENTION_POLICY_INVALID";

export class RetentionError extends Error {
  constructor(
    public code: RetentionErrorCode,
    public status: 400,
  ) {
    super(code);
  }
}

function policyDays(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_RETENTION_DAYS) {
    throw new RetentionError("RETENTION_POLICY_INVALID", 400);
  }
  return value;
}

export type ObservationRetentionStore = {
  /**
   * Set this scope's retention override. The operator seam behind the
   * deployment's retention posture: no request body reaches here, and the row
   * is upserted whole so a scope's two windows are always one decision.
   */
  setPolicy(
    scope: ObservationScope,
    policy: RetentionPolicy,
  ): Promise<RetentionPolicy>;
};

export function createObservationRetentionStore(
  db: Database,
): ObservationRetentionStore {
  return {
    async setPolicy(scope, policy) {
      const runsDays = policyDays(policy.runsDays);
      const datasetsDays = policyDays(policy.datasetsDays);
      const row = {
        scopeKey: scope.key,
        runsDays,
        datasetsDays,
        updatedAt: new Date(),
      };
      const [written] = await db
        .insert(aiObservationRetentionPolicies)
        .values(row)
        .onConflictDoUpdate({
          target: aiObservationRetentionPolicies.scopeKey,
          set: row,
        })
        .returning();
      if (!written) {
        throw new Error("setPolicy upserted a row it cannot read back");
      }
      return { runsDays: written.runsDays, datasetsDays: written.datasetsDays };
    },
  };
}

/** The work-queue kind a retention sweep's claim ticket rides on. */
export const RETENTION_WORK_KIND = "opik.retention";
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_MS = 60_000;
/** Rows per category per pass: the backlog belongs to the next bucket. */
export const DEFAULT_RETENTION_BATCH = 200;

export type RetentionCategoryReport = Readonly<{
  expired: number;
  deleted: number;
  skipped: number;
  failed: number;
}>;

export type RetentionSweepReport = Readonly<{
  bucket: string;
  experiments: RetentionCategoryReport;
  datasets: RetentionCategoryReport;
  runs: RetentionCategoryReport;
  exports: RetentionCategoryReport;
}>;

/** One expired row as the sweep reads it: identity plus what upstream deletion needs. */
type ExpiredBinding = {
  id: string;
  scope_key: string;
  opik_trace_id: string | null;
};
type ExpiredDataset = {
  id: string;
  scope_key: string;
  sync_state: string;
  opik_dataset_id: string | null;
};
type ExpiredId = { id: string; scope_key: string };

export type ObservationRetentionWorker = {
  /** One pass, under a lease on the current bucket. Returns the report it acted on. */
  sweep(): Promise<RetentionSweepReport | null>;
  /** Poll-driven scheduling on the house loop. Tests drive `sweep` directly. */
  start(): Repeating;
};

export type ObservationRetentionWorkerDeps = Readonly<{
  database: Database;
  config: () => OpikConfig;
  /** The verified port, or null when no verified contract backs this deployment. */
  port: OpikPort | null;
  /** Where the audit row lands. */
  audit: AuditStore;
  retention?: () => RetentionPolicy;
  queue?: WorkQueue;
  batchSize?: number;
  leaseMs?: number;
  pollMs?: number;
  owner?: string;
}>;

/**
 * The expiry window for one scope, as one SQL expression: the override row when
 * present, the deployment default otherwise. Used twice per category (the guard
 * and the cutoff) with the same arguments, so the two cannot disagree.
 */
const effectiveDays = (
  column: "runs_days" | "datasets_days",
  fallback: number,
) => sql`coalesce(p.${sql.raw(column)}, ${fallback})`;

export function createObservationRetentionWorker(
  deps: ObservationRetentionWorkerDeps,
): ObservationRetentionWorker {
  const log = getLogger("server");
  const queue = deps.queue ?? createWorkQueue(deps.database);
  const retention = deps.retention ?? (() => resolveRetentionDefaults(process.env));
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const owner = deps.owner ?? workOwner("opik-retention");
  const batch = deps.batchSize ?? DEFAULT_RETENTION_BATCH;
  let sweeping = false;

  /** The T09 gate: an off or portless deployment sweeps nothing, ever. */
  const gate = (): OpikPort => {
    const config = deps.config();
    if (!config.enabled || config.baseUrl === null || deps.port === null) {
      throw new RetentionError("RETENTION_INPUT_INVALID", 400);
    }
    return deps.port;
  };

  const unwrap = <T>(result: OpikPortResult<T>): T | null => {
    if (result.outcome === "ok") return result.value;
    // Every failure is the row's reason to stay: deleted counts as failed this
    // pass and retries next bucket — never a silent local-only deletion.
    return null;
  };

  /** Delete expired frozen experiments through 0126's cleanup flag, as one batch. */
  const sweepExperiments = async (
    days: number,
  ): Promise<RetentionCategoryReport> => {
    const expired = (await deps.database.$client`
      select e.id, e.scope_key from ai_observation_experiments e
      left join ai_observation_retention_policies p on p.scope_key = e.scope_key
      where e.state = 'frozen'
        and ${effectiveDays("datasets_days", days)} > 0
        and e.frozen_at <= now() - make_interval(days => ${effectiveDays("datasets_days", days)})
      order by e.frozen_at asc
      limit ${batch}
    `) as readonly ExpiredId[];
    let deleted = 0;
    if (expired.length > 0) {
      const gone = await deps.database.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('ai_observation.experiment_cleanup', 'on', true)`,
        );
        return tx
          .delete(aiObservationExperiments)
          .where(
            inArray(
              aiObservationExperiments.id,
              expired.map((row) => row.id),
            ),
          )
          .returning({ id: aiObservationExperiments.id });
      });
      deleted = gone.length;
    }
    return {
      expired: expired.length,
      deleted,
      // Experiments have no upstream copy and no dependents; nothing is skipped.
      skipped: 0,
      failed: expired.length - deleted,
    };
  };

  /**
   * Delete expired dataset subjects, upstream first. A subject is expired when
   * its youngest version is (the last activity rule): a dataset still being
   * frozen into has a future, and deleting it mid-stream would strand the
   * pipeline's upstream copy of versions local rows still reference.
   */
  const sweepDatasets = async (
    port: OpikPort,
    days: number,
  ): Promise<RetentionCategoryReport> => {
    const expired = (await deps.database.$client`
      select d.id, d.scope_key, d.sync_state, d.opik_dataset_id
      from ai_observation_datasets d
      left join ai_observation_retention_policies p on p.scope_key = d.scope_key
      where ${effectiveDays("datasets_days", days)} > 0
        and coalesce(
          (select max(v.created_at) from ai_observation_dataset_versions v
            where v.dataset_id = d.id),
          d.created_at
        ) <= now() - make_interval(days => ${effectiveDays("datasets_days", days)})
      order by d.created_at asc
      limit ${batch}
    `) as readonly ExpiredDataset[];
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    for (const dataset of expired) {
      if (dataset.sync_state === "syncing") {
        // A push is in flight; its settle decides the upstream state. Not this pass.
        skipped += 1;
        continue;
      }
      if (dataset.sync_state === "synced" && dataset.opik_dataset_id) {
        const scope = scopeFromStoredKey(dataset.scope_key);
        if (scope === null) {
          skipped += 1;
          continue;
        }
        const upstream = unwrap(
          await port.deleteDataset(scope, { datasetId: dataset.opik_dataset_id }),
        );
        if (upstream === null) {
          // Local row stays as the retry record; it is not deleted, so it is
          // never reported as deleted.
          failed += 1;
          continue;
        }
      }
      const gone = await deps.database.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('ai_observation.dataset_cleanup', 'on', true)`,
        );
        return tx
          .delete(aiObservationDatasets)
          .where(eq(aiObservationDatasets.id, dataset.id))
          .returning({ id: aiObservationDatasets.id });
      });
      if (gone.length > 0) {
        deleted += 1;
      } else {
        skipped += 1;
      }
    }
    return {
      expired: expired.length,
      deleted,
      skipped,
      failed,
    };
  };

  /**
   * Delete expired run bindings, upstream traces first, one upstream round per
   * scope (the delete API is batched; the project id is per scope).
   */
  const sweepRuns = async (
    port: OpikPort,
    days: number,
  ): Promise<RetentionCategoryReport> => {
    const expired = (await deps.database.$client`
      select b.id, b.scope_key, b.opik_trace_id from ai_observation_bindings b
      left join ai_observation_retention_policies p on p.scope_key = b.scope_key
      where ${effectiveDays("runs_days", days)} > 0
        and b.created_at <= now() - make_interval(days => ${effectiveDays("runs_days", days)})
      order by b.created_at asc
      limit ${batch}
    `) as readonly ExpiredBinding[];
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    const byScope = new Map<string, ExpiredBinding[]>();
    for (const row of expired) {
      const group = byScope.get(row.scope_key) ?? [];
      group.push(row);
      byScope.set(row.scope_key, group);
    }
    for (const [scopeKey, group] of byScope) {
      const scope = scopeFromStoredKey(scopeKey);
      if (scope === null) {
        skipped += group.length;
        continue;
      }
      const withTrace = group.filter((row) => row.opik_trace_id !== null);
      if (withTrace.length > 0) {
        const project = await port.retrieveProject(scope);
        if (project.outcome !== "ok") {
          failed += group.length;
          continue;
        }
        if (project.value !== null) {
          const deletion = await port.deleteTraces(scope, {
            projectId: project.value.id,
            traceIds: withTrace.map((row) => row.opik_trace_id as string),
          });
          if (deletion.outcome !== "ok") {
            // Upstream copy still stands; the local rows stay as the retry record
            // and nothing is counted as deleted.
            failed += group.length;
            continue;
          }
        }
        // A verified null project means no upstream records exist for this scope
        // at all: the local-only deletion below is the truthful completion.
      }
      const gone = await deps.database
        .delete(aiObservationBindings)
        .where(
          inArray(
            aiObservationBindings.id,
            group.map((row) => row.id),
          ),
        )
        .returning({ id: aiObservationBindings.id });
      deleted += gone.length;
    }
    return { expired: expired.length, deleted, skipped, failed };
  };

  /** Delete expired export artifacts — terminal jobs whose settled_at outlived the runs window. */
  const sweepExports = async (
    days: number,
  ): Promise<RetentionCategoryReport> => {
    const expired = (await deps.database.$client`
      select j.id, j.scope_key from ai_observation_export_jobs j
      left join ai_observation_retention_policies p on p.scope_key = j.scope_key
      where j.state in ('completed', 'failed', 'cancelled')
        and ${effectiveDays("runs_days", days)} > 0
        and j.settled_at <= now() - make_interval(days => ${effectiveDays("runs_days", days)})
      order by j.settled_at asc
      limit ${batch}
    `) as readonly ExpiredId[];
    let deleted = 0;
    if (expired.length > 0) {
      const gone = await deps.database
        .delete(aiObservationExportJobs)
        .where(
          inArray(
            aiObservationExportJobs.id,
            expired.map((row) => row.id),
          ),
        )
        .returning({ id: aiObservationExportJobs.id });
      deleted = gone.length;
    }
    return {
      expired: expired.length,
      deleted,
      skipped: 0,
      // A deletion that returned fewer rows than it selected is a defect, not a
      // policy answer; it surfaces as failed rather than being folded into skipped.
      failed: expired.length - deleted,
    };
  };

  /**
   * The UTC minute a sweep belongs to. Two replicas sweeping in the same minute
   * collide on one ticket and one wins; the next minute is a fresh ticket, so a
   * busy deployment sweeps once per minute at most.
   */
  const bucketKey = (now: Date) =>
    `bucket:${now.toISOString().slice(0, 16)}`;

  const sweep = async (): Promise<RetentionSweepReport | null> => {
    if (sweeping) return null;
    sweeping = true;
    try {
      const port = gate();
      const windows = retention();
      const bucket = bucketKey(new Date());
      await queue.offer({ kind: RETENTION_WORK_KIND, key: bucket });
      const claimed = await queue.claim({
        kind: RETENTION_WORK_KIND,
        owner,
        leaseMs,
        limit: 1,
      });
      if (claimed.length === 0 || claimed[0].key !== bucket) {
        // Another replica holds this bucket (or already ran it): its report is
        // the one that exists.
        return null;
      }
      const ours = () =>
        queue.renew({ kind: RETENTION_WORK_KIND, key: bucket, owner, leaseMs });
      // Experiments first: their deletion unpins dataset versions this pass.
      const experiments = await sweepExperiments(windows.datasetsDays);
      const datasets = await sweepDatasets(port, windows.datasetsDays);
      if (!(await ours())) {
        // The lease was taken over mid-sweep; the new owner's sweep is the
        // truth. Whatever this pass already deleted stays deleted (it was
        // idempotent), but no audit row reports this half-run as a whole one.
        return null;
      }
      const runs = await sweepRuns(port, windows.runsDays);
      const exports = (await ours()) ? await sweepExports(windows.runsDays) : null;
      if (exports === null) {
        return null;
      }
      const report: RetentionSweepReport = {
        bucket,
        experiments,
        datasets,
        runs,
        exports,
      };
      await deps.audit.insert({
        eventType: "opik.retention_swept",
        targetType: "ai_observability",
        initiator: { kind: "deployment" },
        payload: { ...report },
      });
      await queue.finish({ kind: RETENTION_WORK_KIND, key: bucket, owner });
      return report;
    } finally {
      sweeping = false;
    }
  };

  return {
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
