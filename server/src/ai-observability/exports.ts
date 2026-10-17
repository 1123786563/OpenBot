/**
 * Bounded asynchronous export of run observation data, with immediate revocation
 * (Issue #40 / DAG T34).
 *
 * An export is a job row, not a request-thread activity: enqueue writes one
 * queued row (plus its claim ticket on the shared work queue, in the same
 * transaction) and answers immediately, so no request ever waits on upstream
 * I/O. A background worker claims tickets under lease, re-derives the scope
 * from LIVE authorization, fetches this scope's traces through the only
 * sanctioned port, projects every row through T05, and settles the job.
 *
 * Bounded twice over, both bounds explicit rather than silent: the worker runs
 * at most `concurrency` jobs at once (extra jobs stay queued), and a job that
 * would need more rows than its `row_limit` fails with EXPORT_ROW_LIMIT_EXCEEDED
 * instead of handing over a truncated artifact that looks whole.
 *
 * Revocation is immediate because it is never a race the artifact can win: the
 * cancel seam settles every queued/running job of the actor on the spot, the
 * worker's completion write is conditional on still running, and the database
 * itself refuses an artifact on anything but `completed` (migration 0125) — so
 * a job cancelled mid-fetch drops its product at the last write, and a worker
 * that re-authorizes after the revoke never fetches at all.
 *
 * State vocabulary is the T10 discipline: queued/running end only on an actual
 * outcome (completed/failed/cancelled), first terminal write wins, and a stored
 * value outside the vocabulary is refused (`parseExportJobState`) rather than
 * mapped onto a guess.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { REDACTION_POLICY_VERSION } from "../../../shared/ai-observability";
import { getLogger } from "../../../shared/logger";
import { workOwner } from "../../../shared/work-owner";
import type { Database } from "../db/client";
import { aiObservationBindings } from "../db/schema/ai-observability-bindings";
import { aiObservationExportJobs } from "../db/schema/ai-observability-exports";
import { workItems } from "../db/schema/work";
import { type Repeating, repeatAfterEach } from "../work/loop";
import { createWorkQueue, type WorkQueue } from "../work/queue";
import type { OpikConfig } from "./config";
import type { ObservationScope } from "./contracts";
import type { OpikPort, OpikPortResult, OpikTraceRow } from "./opik-port";
import { projectRow, type RunSummary } from "./queries/runs";
import { notPendingDeletion } from "./retention";
import { assertObservationScope, resolveStorageLocator } from "./scope";

/** One exported row: the T11 projection of one upstream trace, nothing raw. */
export type ExportedRunRow = RunSummary;

export type ExportJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** The codes a settled-failed job may carry. The code is the contract. */
export const EXPORT_JOB_ERROR_CODES = [
  "CAPABILITY_MISSING",
  "EXPORT_ROW_LIMIT_EXCEEDED",
  "OPIK_TIMEOUT",
  "OPIK_UNREACHABLE",
  "OPIK_UPSTREAM_ERROR",
  "OPIK_CLIENT_ERROR",
  "OPIK_MALFORMED_RESPONSE",
  "OPIK_OWNERSHIP_DRIFT",
] as const;

export type ExportJobErrorCode = (typeof EXPORT_JOB_ERROR_CODES)[number];

export type ExportErrorCode =
  | "EXPORT_INPUT_INVALID"
  | "EXPORT_NOT_FOUND"
  | "EXPORT_STATE_INVALID"
  /**
   * The T34 hardening (T35): this scope already holds `maxActive` queued or running
   * exports. An explicit 429 refusal, never a silent unbounded backlog.
   */
  | "EXPORT_ENQUEUE_LIMIT"
  /** The T09 gate: the integration is off, unconfigured, or no verified port backs it. */
  | "CAPABILITY_MISSING";

export class ExportError extends Error {
  constructor(
    public code: ExportErrorCode,
    public status: 400 | 404 | 429 | 500 | 503,
  ) {
    super(code);
  }
}

/** The row cap refused this job. Settles as EXPORT_ROW_LIMIT_EXCEEDED. */
export class ExportRowLimitExceeded extends Error {}

/** The page envelope lied (drift, ran out early, duplicate ids). Settles as OPIK_MALFORMED_RESPONSE. */
export class MalformedExportPage extends Error {}

/** Internal: a port failure carrying the stored vocabulary code. */
class ExportUpstreamFailure extends Error {
  constructor(public code: ExportJobErrorCode) {
    super(code);
  }
}

/** Internal: the work-item lease was taken over; another owner owns the truth now. */
class ExportLeaseLost extends Error {}

const EXPORT_STATES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * A stored state onto the vocabulary, fail closed: a value the database check
 * should have refused is a defect to surface, never a state to echo or guess.
 */
export function parseExportJobState(value: unknown): ExportJobState {
  if (typeof value === "string" && EXPORT_STATES.has(value)) {
    return value as ExportJobState;
  }
  throw new ExportError("EXPORT_STATE_INVALID", 500);
}

/** Whether a state is one the job cannot leave. */
export function isTerminalExportJobState(state: ExportJobState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

/*
 * Deployment bounds. Conservative defaults on purpose: two exports at a time
 * and a thousand rows per export is what a deployment that has thought about
 * nothing gets, and both knobs are env-configurable for one that has.
 */
export const DEFAULT_EXPORT_CONCURRENCY = 2;
export const MAX_EXPORT_CONCURRENCY = 16;
export const DEFAULT_EXPORT_MAX_ROWS = 1_000;
export const MAX_EXPORT_MAX_ROWS = 100_000;
/**
 * How many queued/running exports one scope may hold (T34 review hardening, merged into
 * Issue #41): generous enough that a healthy deployment never meets it, finite enough
 * that a runaway producer cannot enqueue without bound.
 */
export const DEFAULT_EXPORT_MAX_ACTIVE = 1_000;
export const MAX_EXPORT_MAX_ACTIVE = 100_000;
/** The page size the verified trace-query contract observed (T04/T08). */
export const EXPORT_PAGE_SIZE = 100;

export type ExportLimits = Readonly<{
  concurrency: number;
  maxRows: number;
  maxActive: number;
}>;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  // Canonical decimal digits only, in the retentionDay Number() precedent's spirit
  // (R2-42): Number.parseInt silently read "1e3" as 1000, "1.5" as 1, "1_000" as 1
  // and "2500x" as 2500 — a bound the operator never wrote is a bound no one can
  // audit, so anything that is not a plain integer literal keeps the default.
  const raw = (value ?? "").trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max
    ? parsed
    : fallback;
}

/**
 * The export knobs, read from exactly three env names and clamped: an unparsable
 * or out-of-range value keeps the conservative default rather than being
 * guessed at (the T09 config parsing precedent).
 */
export function resolveExportLimits(
  env: Readonly<Record<string, string | undefined>>,
): ExportLimits {
  return {
    concurrency: boundedInteger(
      env.OPIK_EXPORT_CONCURRENCY,
      DEFAULT_EXPORT_CONCURRENCY,
      MAX_EXPORT_CONCURRENCY,
    ),
    maxRows: boundedInteger(
      env.OPIK_EXPORT_MAX_ROWS,
      DEFAULT_EXPORT_MAX_ROWS,
      MAX_EXPORT_MAX_ROWS,
    ),
    maxActive: boundedInteger(
      env.OPIK_EXPORT_MAX_ACTIVE,
      DEFAULT_EXPORT_MAX_ACTIVE,
      MAX_EXPORT_MAX_ACTIVE,
    ),
  };
}

/** The work-queue kind an export's claim ticket rides on. */
export const EXPORT_WORK_KIND = "opik.export";
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_MS = 2_000;

export type ObservationExportJob = typeof aiObservationExportJobs.$inferSelect;

/**
 * The list face's row (R3-33): every fact about the job, never the artifact.
 * A completed job's artifact is the rows themselves — a jsonbArray up to the
 * row cap — and the list is what the 5-second poll reads, so the column is
 * projected away in the query itself and the detail endpoint (`get`) remains
 * the artifact's only carrier.
 */
export type ObservationExportJobListItem = Omit<
  ObservationExportJob,
  "artifact"
>;

export type ObservationExportStore = {
  /**
   * Queue one export of this scope's run observation data. One transaction
   * writes the job row and its claim ticket, so a queued job without a ticket
   * (or a ticket without a job) cannot exist. The caller contributes nothing
   * but the scope; the row limit is the deployment's, snapshotted onto the job.
   */
  enqueue(
    scope: ObservationScope,
    rowLimit: number,
    /**
     * The active-backlog cap for this call (T34 hardening). Omitted means the
     * deployment's `OPIK_EXPORT_MAX_ACTIVE` default. Terminal jobs never count:
     * the cap bounds work, not history.
     */
    options?: { maxActive?: number },
  ): Promise<ObservationExportJob>;
  /** Read one job inside the caller's scope. Another scope's id is simply not found. */
  get(
    scope: ObservationScope,
    id: string,
  ): Promise<ObservationExportJob | null>;
  /**
   * This scope's jobs, newest first. The artifact column is projected away in
   * the query itself (R3-33 — see `ObservationExportJobListItem`), and a
   * `page` applies limit/offset in SQL: the pagination contract's numbers are
   * answered by the database, not by materializing this scope's whole history
   * to slice it in memory. No page means every row — the shape the
   * worker-side and scope-isolation reads have always used.
   */
  list(
    scope: ObservationScope,
    page?: { limit: number; offset: number },
  ): Promise<readonly ObservationExportJobListItem[]>;
  /**
   * The page envelope's `total`, counted under the same scope filter `list`
   * answers. Its own query, because the page and the total are two questions
   * and neither should force the other to materialize rows (R3-33).
   */
  count(scope: ObservationScope): Promise<number>;
  /**
   * The revocation seam: settle every queued or running job of one actor as
   * cancelled. Takes the actor id, not a scope, because it runs exactly when
   * the actor's authorization is gone — there is no scope left to present, and
   * the only thing this write can do is remove work, never read or produce
   * data. Already-terminal jobs are untouched: first terminal write wins.
   */
  cancelForActor(actorId: string): Promise<number>;
  /**
   * The retention precondition's stop: settle every queued or running job of one
   * scope as cancelled, before the retention worker deletes that scope's data out
   * from under a fetch in flight. Scope-keyed, not actor-keyed, because one scope
   * expiring never gets to stop the same actor's work in another scope.
   */
  cancelForScope(scopeKey: string): Promise<number>;
  /**
   * Worker-side read by claim-ticket key. Trust is the lease the worker holds,
   * not a scope; the worker re-derives authorization itself before acting.
   */
  loadById(id: string): Promise<ObservationExportJob | null>;
  /** queued (or lease-orphaned running) → running. Null when the job is gone or already terminal. */
  markRunning(id: string): Promise<ObservationExportJob | null>;
  /**
   * The one place an artifact lands: conditional on still running, so a
   * cancellation that landed mid-fetch wins the row and the product is
   * dropped — here in code, and again in the database (artifact-completed
   * check) for any path that might forget.
   */
  settleCompleted(
    id: string,
    artifact: readonly ExportedRunRow[],
  ): Promise<ObservationExportJob | null>;
  /** Record why a job failed. Conditional on still running, like completion. */
  settleFailed(
    id: string,
    code: ExportJobErrorCode,
  ): Promise<ObservationExportJob | null>;
  /** Cancel one job outright (the authorization-gone path the worker takes). */
  settleCancelled(id: string): Promise<ObservationExportJob | null>;
};

/** A non-empty opaque reference. Values are stored as-is; only emptiness is refused. */
function reference(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExportError("EXPORT_INPUT_INVALID", 400);
  }
  return value;
}

export function createObservationExportStore(
  db: Database,
): ObservationExportStore {
  const settle = (
    id: string,
    values: Partial<typeof aiObservationExportJobs.$inferInsert>,
  ) =>
    db
      .update(aiObservationExportJobs)
      .set({ ...values, updatedAt: new Date(), settledAt: new Date() })
      // Only a running job settles. A cancelled row refuses this write, which
      // is exactly the race revocation must win.
      .where(
        and(
          eq(aiObservationExportJobs.id, id),
          eq(aiObservationExportJobs.state, "running"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

  return {
    async enqueue(scope, rowLimit, options) {
      assertObservationScope(scope);
      if (!Number.isInteger(rowLimit) || rowLimit < 1) {
        throw new ExportError("EXPORT_INPUT_INVALID", 400);
      }
      if (
        options?.maxActive !== undefined &&
        (!Number.isInteger(options.maxActive) || options.maxActive < 1)
      ) {
        throw new ExportError("EXPORT_INPUT_INVALID", 400);
      }
      const maxActive =
        options?.maxActive ?? resolveExportLimits(process.env).maxActive;
      const locator = resolveStorageLocator(scope);
      const id = randomUUID();
      return db.transaction(async (tx) => {
        // The cap is counted and written as one step, under the scope's own advisory
        // lock: concurrent enqueues for one scope otherwise each read a count taken
        // before any of the others wrote, and all pass a cap of two.
        const lockKey = `opik-export-enqueue:${scope.key}`;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`,
        );
        const [active] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(aiObservationExportJobs)
          .where(
            and(
              eq(aiObservationExportJobs.scopeKey, scope.key),
              inArray(aiObservationExportJobs.state, ["queued", "running"]),
            ),
          );
        if ((active?.total ?? 0) >= maxActive) {
          throw new ExportError("EXPORT_ENQUEUE_LIMIT", 429);
        }
        const [job] = await tx
          .insert(aiObservationExportJobs)
          .values({
            id,
            scopeKey: scope.key,
            actorId: scope.actorId,
            botId: scope.botId,
            state: "queued",
            rowLimit,
            redactionPolicyVersion: REDACTION_POLICY_VERSION,
            locatorWorkspace: locator.workspace,
            locatorProject: locator.project,
          })
          .returning();
        if (!job) {
          throw new Error("enqueue inserted a row it cannot read back");
        }
        // The claim ticket, in the same transaction: a queued job always has
        // one and a ticket always has its job. Idempotent on (kind, key) like
        // every offer; the key is the job id, so it never collides.
        await tx
          .insert(workItems)
          .values({ kind: EXPORT_WORK_KIND, key: job.id })
          .onConflictDoNothing();
        return job;
      });
    },

    async get(scope, id) {
      assertObservationScope(scope);
      reference(id);
      const rows = await db
        .select()
        .from(aiObservationExportJobs)
        .where(
          and(
            eq(aiObservationExportJobs.id, id),
            eq(aiObservationExportJobs.scopeKey, scope.key),
            // M1a on the export surface too (OCR m140): a discovered-but-not-yet-
            // deleted job is already gone to readers, artifact and all — however
            // long the local delete then parks.
            notPendingDeletion("export", aiObservationExportJobs.id),
          ),
        );
      return rows[0] ?? null;
    },

    async list(scope, page) {
      assertObservationScope(scope);
      // R3-33: the explicit column projection — every job fact, never the
      // artifact — and the order is total (created_at desc, then id desc), so
      // LIMIT/OFFSET pages cannot overlap or drop a row when two jobs share a
      // created_at.
      const query = db
        .select({
          id: aiObservationExportJobs.id,
          scopeKey: aiObservationExportJobs.scopeKey,
          actorId: aiObservationExportJobs.actorId,
          botId: aiObservationExportJobs.botId,
          state: aiObservationExportJobs.state,
          rowLimit: aiObservationExportJobs.rowLimit,
          rowCount: aiObservationExportJobs.rowCount,
          errorCode: aiObservationExportJobs.errorCode,
          redactionPolicyVersion:
            aiObservationExportJobs.redactionPolicyVersion,
          locatorWorkspace: aiObservationExportJobs.locatorWorkspace,
          locatorProject: aiObservationExportJobs.locatorProject,
          createdAt: aiObservationExportJobs.createdAt,
          updatedAt: aiObservationExportJobs.updatedAt,
          startedAt: aiObservationExportJobs.startedAt,
          settledAt: aiObservationExportJobs.settledAt,
        })
        .from(aiObservationExportJobs)
        .where(
          and(
            eq(aiObservationExportJobs.scopeKey, scope.key),
            notPendingDeletion("export", aiObservationExportJobs.id),
          ),
        )
        .orderBy(
          desc(aiObservationExportJobs.createdAt),
          desc(aiObservationExportJobs.id),
        );
      return page ? query.limit(page.limit).offset(page.offset) : query;
    },

    async count(scope) {
      assertObservationScope(scope);
      const [row] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(aiObservationExportJobs)
        .where(
          and(
            eq(aiObservationExportJobs.scopeKey, scope.key),
            notPendingDeletion("export", aiObservationExportJobs.id),
          ),
        );
      return row?.total ?? 0;
    },

    async cancelForActor(actorId) {
      reference(actorId);
      const cancelled = await db
        .update(aiObservationExportJobs)
        .set({
          state: "cancelled",
          updatedAt: new Date(),
          settledAt: new Date(),
        })
        .where(
          and(
            eq(aiObservationExportJobs.actorId, actorId),
            inArray(aiObservationExportJobs.state, ["queued", "running"]),
          ),
        )
        .returning({ id: aiObservationExportJobs.id });
      return cancelled.length;
    },

    async cancelForScope(scopeKey) {
      reference(scopeKey);
      // The retention precondition's stop (M1b): the scope's data face is about
      // to change under every queued or running fetch, so they are settled as
      // cancelled first. Same conditional write as cancelForActor — terminal
      // jobs are untouched, and a worker whose fetch already landed drops its
      // artifact at the conditional settle.
      const cancelled = await db
        .update(aiObservationExportJobs)
        .set({
          state: "cancelled",
          updatedAt: new Date(),
          settledAt: new Date(),
        })
        .where(
          and(
            eq(aiObservationExportJobs.scopeKey, scopeKey),
            inArray(aiObservationExportJobs.state, ["queued", "running"]),
          ),
        )
        .returning({ id: aiObservationExportJobs.id });
      return cancelled.length;
    },

    async loadById(id) {
      reference(id);
      const rows = await db
        .select()
        .from(aiObservationExportJobs)
        .where(eq(aiObservationExportJobs.id, id));
      return rows[0] ?? null;
    },

    async markRunning(id) {
      reference(id);
      // A lease-orphaned running job is claimable again: the work-item lease
      // the caller holds is the proof the previous owner is gone, and the
      // conditional settle writes keep a takeover from double-landing data.
      const rows = await db
        .update(aiObservationExportJobs)
        .set({
          state: "running",
          startedAt: sql`coalesce(${aiObservationExportJobs.startedAt}, now())`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiObservationExportJobs.id, id),
            inArray(aiObservationExportJobs.state, ["queued", "running"]),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async settleCompleted(id, artifact) {
      reference(id);
      return settle(id, {
        state: "completed",
        artifact,
        rowCount: artifact.length,
      });
    },

    async settleFailed(id, code) {
      reference(id);
      if (!(EXPORT_JOB_ERROR_CODES as readonly string[]).includes(code)) {
        // The stored failure vocabulary is closed: an unknown code on a job row
        // is a lie future readers would trust, so it is refused here too.
        throw new ExportError("EXPORT_STATE_INVALID", 500);
      }
      return settle(id, { state: "failed", errorCode: code });
    },

    async settleCancelled(id) {
      reference(id);
      // Both not-yet-terminal states: the worker cancels a job it has only
      // just claimed (still queued) exactly like one it is running.
      const rows = await db
        .update(aiObservationExportJobs)
        .set({
          state: "cancelled",
          updatedAt: new Date(),
          settledAt: new Date(),
        })
        .where(
          and(
            eq(aiObservationExportJobs.id, id),
            inArray(aiObservationExportJobs.state, ["queued", "running"]),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
  };
}

/**
 * Fold upstream pages under a row cap. Pure: the caller supplies the page
 * fetcher, this supplies the honesty.
 *
 *  - `total` above the cap fails EXPORT_ROW_LIMIT_EXCEEDED before any further
 *    fetch — an export that cannot be whole does not ship half and call itself
 *    done.
 *  - Pages that run out before `total`, drift their total, or repeat a trace id
 *    are malformed, never a short-but-successful export.
 *  - Accumulating past the cap anyway (a hostile upstream that under-reports
 *    its total) fails the cap rather than trusting the envelope.
 */
export async function foldExportPages<T>(
  cap: number,
  fetchPage: (
    page: number,
  ) => Promise<{ total: number; content: readonly T[] }>,
): Promise<readonly T[]> {
  const first = await fetchPage(0);
  if (first.total > cap) {
    throw new ExportRowLimitExceeded();
  }
  const rows = [...first.content];
  // The first page itself is inside the cap contract too (OCR m139): an upstream
  // that over-ships its first page (under-reported total, oversized content) fails
  // the cap here rather than shipping an over-limit export as a success.
  if (rows.length > cap) {
    throw new ExportRowLimitExceeded();
  }
  let page = 0;
  while (rows.length < first.total) {
    page += 1;
    const next = await fetchPage(page);
    if (next.total !== first.total) {
      throw new MalformedExportPage();
    }
    if (next.content.length === 0) {
      throw new MalformedExportPage();
    }
    rows.push(...next.content);
    if (rows.length > cap) {
      throw new ExportRowLimitExceeded();
    }
  }
  const ids = new Set(rows.map((row) => (row as { id?: unknown }).id ?? null));
  if (ids.size !== rows.length) {
    // The same trace twice is not two observations; an export that counted it
    // as two would be double-reporting what it claims to be a copy of.
    throw new MalformedExportPage();
  }
  return rows;
}

/** Live authorization for a job's actor and bot, or null when it is gone. */
export type ExportReauthorization = (input: {
  actorId: string;
  botId: string;
}) => Promise<ObservationScope | null>;

export type ObservationExportWorker = {
  /** One pass: claim up to the concurrency bound and run the batch to completion. */
  sweep(): Promise<void>;
  /** Poll-driven scheduling on the house loop. Tests drive `sweep` directly. */
  start(): Repeating;
};

export type ObservationExportWorkerDeps = Readonly<{
  database: Database;
  config: () => OpikConfig;
  /** The verified port, or null when no verified contract backs this deployment. */
  port: OpikPort | null;
  /**
   * The scope is re-derived from live authorization for every execution — the
   * T06 obligation for background workers. Null means revoked: the job is
   * cancelled and no upstream call is made at all. Wiring builds this from the
   * same seam the T11 routes use per request (bot management check, ownership,
   * live epoch), so a transfer, revocation or epoch bump is effective on the
   * next execution, not the next enqueue.
   */
  reauthorize: ExportReauthorization;
  store?: ObservationExportStore;
  queue?: WorkQueue;
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  owner?: string;
  pageSize?: number;
}>;

/** Port failure codes onto the stored vocabulary; the outcome is what failed. */
function exportJobErrorCode(result: OpikPortResult<never>): ExportJobErrorCode {
  if (result.outcome === "ok") {
    // Unreachable by construction: only failure results are handed here.
    return "OPIK_UPSTREAM_ERROR";
  }
  return result.outcome === "ownership_drift"
    ? "OPIK_OWNERSHIP_DRIFT"
    : result.code;
}

export function createObservationExportWorker(
  deps: ObservationExportWorkerDeps,
): ObservationExportWorker {
  const log = getLogger("server");
  const store = deps.store ?? createObservationExportStore(deps.database);
  const queue = deps.queue ?? createWorkQueue(deps.database);
  const concurrency =
    deps.concurrency ?? resolveExportLimits(process.env).concurrency;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const owner = deps.owner ?? workOwner("opik-export");
  const pageSize = deps.pageSize ?? EXPORT_PAGE_SIZE;
  let sweeping = false;

  /** The T09 gate: off, unconfigured or portless deployments fail, not export emptily. */
  const gate = (): OpikPort => {
    const config = deps.config();
    if (!config.enabled || config.baseUrl === null || deps.port === null) {
      throw new ExportError("CAPABILITY_MISSING", 503);
    }
    return deps.port;
  };

  /** Unwrap a port result, throwing the port's code for the settle path. */
  const unwrap = <T>(result: OpikPortResult<T>): T => {
    switch (result.outcome) {
      case "ok":
        return result.value;
      default:
        throw new ExportUpstreamFailure(
          exportJobErrorCode(result as OpikPortResult<never>),
        );
    }
  };

  const run = async (key: string, renew: () => Promise<boolean>) => {
    const finish = () => queue.finish({ kind: EXPORT_WORK_KIND, key, owner });
    const job = await store.loadById(key);
    if (!job || isTerminalExportJobState(parseExportJobState(job.state))) {
      // A ticket whose job is gone or settled: nothing to run, nothing to
      // reschedule. (A cancelled job's ticket lands here on its next claim.)
      await finish();
      return;
    }

    /*
     * Re-derive the scope from live authorization. A revoked actor, a
     * transferred bot or a bumped epoch answers differently than the scope the
     * job was enqueued under — including null — and every one of those answers
     * cancels the job before a single upstream byte is fetched.
     */
    const scope = await deps.reauthorize({
      actorId: job.actorId,
      botId: job.botId,
    });
    if (scope === null) {
      await store.settleCancelled(job.id);
      await finish();
      return;
    }
    const locator = resolveStorageLocator(scope);
    if (
      locator.workspace !== job.locatorWorkspace ||
      locator.project !== job.locatorProject
    ) {
      // The scope the world would issue now points somewhere else than the
      // locator this job froze: ownership moved underneath the job.
      await store.settleCancelled(job.id);
      await finish();
      return;
    }
    const claimed = await store.markRunning(job.id);
    if (!claimed) {
      // Cancelled between the read and the claim of running.
      await finish();
      return;
    }

    try {
      const port = gate();
      const project = unwrap(await port.retrieveProject(scope));
      const rows: readonly OpikTraceRow[] =
        project === null
          ? // The verified 404 on the scope's own project: no records exist.
            // A truthful empty export, the one empty that is not a disguise.
            []
          : await foldExportPages(job.rowLimit, async (page) => {
              if (!(await renew())) {
                throw new ExportLeaseLost();
              }
              const result = unwrap(
                await port.listTraces(scope, {
                  projectId: project.id,
                  size: Math.min(job.rowLimit, pageSize),
                  page,
                }),
              );
              return { total: result.total, content: result.content };
            });
      // The rows are projected exactly as the query surface would have (m143):
      // the capability verdict joined from this scope's own bindings — an unbound
      // trace stays the honest "unavailable" — never a flat constant.
      const ids = rows.map((row) => row.id);
      const verdicts = new Map<string, string>();
      if (ids.length > 0) {
        const bound = await deps.database
          .select({
            opikTraceId: aiObservationBindings.opikTraceId,
            capability: aiObservationBindings.capability,
          })
          .from(aiObservationBindings)
          .where(
            and(
              eq(aiObservationBindings.scopeKey, scope.key),
              inArray(aiObservationBindings.opikTraceId, ids),
            ),
          );
        for (const row of bound) {
          if (row.opikTraceId !== null)
            verdicts.set(row.opikTraceId, row.capability);
        }
      }
      const artifact = rows.map((row) =>
        projectRow(
          row,
          (verdicts.get(row.id) ?? "unavailable") as Parameters<
            typeof projectRow
          >[1],
        ),
      );
      // Null when revocation won the row while the fetch ran: the artifact is
      // dropped right here, and the database check would refuse it anyway.
      await store.settleCompleted(job.id, artifact);
    } catch (error) {
      if (error instanceof ExportLeaseLost) {
        // Another owner holds the ticket; the truth is theirs to write.
        return;
      }
      if (error instanceof ExportRowLimitExceeded) {
        await store.settleFailed(job.id, "EXPORT_ROW_LIMIT_EXCEEDED");
      } else if (error instanceof MalformedExportPage) {
        await store.settleFailed(job.id, "OPIK_MALFORMED_RESPONSE");
      } else if (error instanceof ExportError) {
        await store.settleFailed(job.id, "CAPABILITY_MISSING");
      } else if (error instanceof ExportUpstreamFailure) {
        await store.settleFailed(job.id, error.code);
      } else {
        await store.settleFailed(job.id, "OPIK_UPSTREAM_ERROR");
      }
    }
    await finish();
  };

  const sweep = async () => {
    // Never overlapping: a second pass while one runs would claim a second
    // batch and the bound would be the backlog, not the configuration.
    if (sweeping) return;
    sweeping = true;
    try {
      const items = await queue.claim({
        kind: EXPORT_WORK_KIND,
        owner,
        leaseMs,
        limit: concurrency,
      });
      await Promise.all(
        items.map((item) =>
          run(item.key, () =>
            queue.renew({
              kind: EXPORT_WORK_KIND,
              key: item.key,
              owner,
              leaseMs,
            }),
          ).catch((error) => {
            // The job row keeps its own truth; a runner crash must not take
            // the sweep (and the poll loop behind it) down with it.
            log.warn(
              { type: "opik-export-run-failed", key: item.key },
              "opik-export-run-failed",
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
    sweep,
    start: () =>
      repeatAfterEach(async () => {
        try {
          await sweep();
        } catch (error) {
          log.warn(
            { type: "opik-export-sweep-failed", error: String(error) },
            "opik-export-sweep-failed",
          );
        }
      }, deps.pollMs ?? DEFAULT_POLL_MS),
  };
}
