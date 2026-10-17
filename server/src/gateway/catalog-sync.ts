/**
 * The automatic catalog/price sync (Bifrost 03.4, AC10/design Q17).
 *
 * ONE TASK, TWO LAYERS, ONE STATE ROW. Q17's cadence — "每 5 分钟从 Bifrost 同步
 * 目录及价格" — is this module's reason to exist: a periodic task that runs
 * 03.1's `fetchCatalog()` and then 03.2's `syncFromCatalog()`, and keeps one
 * singleton state row so a restart (or 03.5's administrator, or 01.8's status
 * screen, or 03.10's picker) can answer "when did this last fully succeed, and
 * how many times in a row has it failed since, and why". Every attempt's own
 * detail already lives in an append-only home (the fetch log, the versioned
 * snapshots); the state row is the pointer between runs, deliberately mutable,
 * deliberately one row.
 *
 * LAST-GOOD IS KEPT BY THE LAYERS, COUNTED HERE. A failed sync never writes a
 * partial anything: 03.1 keeps the last-good catalog on a failed fetch and
 * 03.2 keeps the last versions on a failed append — both answer outcomes, and
 * neither throws. What this module adds is the sync-level truth: only a run
 * where BOTH layers succeeded moves `lastSuccessfulSyncAt` (a catalog that
 * fetched but whose prices could not persist is a failed sync — the two must
 * land together or the "last good" a freshness gate trusts is a lie), and
 * every failure increments `consecutiveFailures` atomically and records the
 * layer's own fixed reason code — never a message, never upstream bytes, never
 * an address, so the reason is displayable on any screen.
 *
 * ONE SYNC AT A TIME, SHARED WITH EVERY CALLER. Concurrent `runSync()` calls —
 * the timer firing while 03.5's administrator clicks, two ticks overlapping a
 * slow gateway — share the one in-flight run and its one outcome; nobody
 * starts a second sync, so the gateway is dialed once and the snapshot
 * versions are appended once. (The deeper backstop is 03.2's own advisory
 * lock: even cross-replica, an unchanged re-append writes nothing, so no
 * racing trigger can mint a duplicate version.) The in-flight promise is
 * process state by design — a crashed process leaves nothing to clean up.
 *
 * WHO CALLS THIS. The deployment wiring starts the scheduler (default five
 * minutes, `BIFROST_CATALOG_SYNC_INTERVAL_MS` to change — a configuration,
 * never a constant in a timer); 03.5's manual trigger calls the same
 * `runSync()` through the installed instance, so the administrator's click
 * gets the same failure protection and the same single-flight; 03.6's
 * freshness gate and 01.8/03.10's surfaces read `readSyncStatus()`.
 */
import { eq, sql } from "drizzle-orm";
import type { Logger } from "../../../shared/logger";
import { getLogger } from "../../../shared/logger";
import { enterpriseControls } from "../admin/controls";
import type { Database } from "../db/client";
import { gatewayCatalogSyncState } from "../db/schema";
import {
  type CatalogFetchFailureReasonCode,
  type CatalogFetchOutcome,
  type CatalogFetchRecord,
  type GatewayCatalogService,
  gatewayCatalogControls,
} from "./catalog";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  createGatewayPriceSnapshotService,
  type GatewayPriceSnapshotService,
  gatewayPriceSnapshotControls,
  installGatewayPriceSnapshotService,
  type PriceSnapshotSyncFailureReasonCode,
  type PriceSnapshotSyncOutcome,
  readCurrentRateVersion,
} from "./price-snapshot";

/**
 * The cadence Q17 names: one sync every five minutes, unless this deployment
 * says otherwise.
 */
export const DEFAULT_CATALOG_SYNC_INTERVAL_MS = 300_000;

/** The variable a deployment sets to change the cadence; validated, never guessed. */
export const BIFROST_CATALOG_SYNC_INTERVAL_MS_VARIABLE =
  "BIFROST_CATALOG_SYNC_INTERVAL_MS";

/**
 * Read the sync interval from the deployment environment, or answer the
 * default. A set-but-invalid value stops the caller (the deployment wiring,
 * at boot) with the variable named — a silent fallback to five minutes would
 * have a deployment running the cadence it refused.
 */
export function gatewayCatalogSyncIntervalConfig(
  environment: Record<string, string | undefined>,
): number {
  const raw = environment[BIFROST_CATALOG_SYNC_INTERVAL_MS_VARIABLE]?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_CATALOG_SYNC_INTERVAL_MS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new Error(
      `${BIFROST_CATALOG_SYNC_INTERVAL_MS_VARIABLE} must be a positive whole number of milliseconds, got "${raw}".`,
    );
  }
  return value;
}

/**
 * Why a sync failed: the reason code of whichever layer refused — 03.1's
 * `catalog_fetch_*` or 03.2's `price_sync_*`. Both vocabularies are fixed,
 * sanitized by construction, and the state row stores nothing else.
 */
export type CatalogSyncFailureReasonCode =
  | CatalogFetchFailureReasonCode
  | PriceSnapshotSyncFailureReasonCode;

/** What one sync attempt left behind (the singleton row, read back). */
export type GatewayCatalogSyncStateRow = {
  /** When the last fully successful sync completed; null before the first one. */
  lastSuccessfulSyncAt: string | null;
  /** Failures in a row since the last success; zeroed by the next success. */
  consecutiveFailures: number;
  /** The last failure's fixed reason code; present exactly when the last attempt failed. */
  lastFailureReasonCode: CatalogSyncFailureReasonCode | null;
  /** When the last failure was classified. */
  lastFailureAt: string | null;
  /** When the last attempt of either outcome completed. */
  lastAttemptAt: string | null;
  /** The last attempt's outcome. */
  lastAttemptStatus: "ok" | "failed" | null;
};

/** The sync state's fixed singleton id — one state row per deployment. */
export const GATEWAY_CATALOG_SYNC_STATE_ID = "gateway_catalog_sync";

const NEVER_SYNCED: GatewayCatalogSyncStateRow = {
  lastSuccessfulSyncAt: null,
  consecutiveFailures: 0,
  lastFailureReasonCode: null,
  lastFailureAt: null,
  lastAttemptAt: null,
  lastAttemptStatus: null,
};

/**
 * Where the sync state persists. Transitions are single atomic statements —
 * an upsert whose DO UPDATE computes the failure count from the row itself,
 * so two syncs racing the singleton cannot lose an increment and no
 * read-modify-write window exists.
 */
export type GatewayCatalogSyncStore = {
  /** The state as of now; the never-synced answer before the first attempt. */
  readSyncState(): Promise<GatewayCatalogSyncStateRow>;
  /** Record a fully successful sync: success time moves, failures zero, reason clears. */
  recordSyncSuccess(args: { syncedAt: string }): Promise<void>;
  /** Record a failed attempt: the count increments atomically, the reason lands. */
  recordSyncFailure(args: {
    reasonCode: CatalogSyncFailureReasonCode;
    failedAt: string;
  }): Promise<void>;
};

/** Read one stored row into the shape the module answers; absent means never synced. */
function syncStateFromRow(row: {
  lastSuccessfulSyncAt: Date | null;
  consecutiveFailures: number;
  lastFailureReasonCode: string | null;
  lastFailureAt: Date | null;
  lastAttemptAt: Date | null;
  lastAttemptStatus: string | null;
}): GatewayCatalogSyncStateRow {
  const lastAttemptStatus =
    row.lastAttemptStatus === "ok" || row.lastAttemptStatus === "failed"
      ? row.lastAttemptStatus
      : null;
  return {
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    // The reason code is stored as written and read back as the union — the
    // column carries no enum CHECK of its own, so this cast is the reader
    // trusting the writer: only this module's two layers' fixed codes are
    // ever recorded, and nothing here invents a reason for one it does not
    // recognize.
    lastFailureReasonCode:
      row.lastFailureReasonCode as CatalogSyncFailureReasonCode | null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastAttemptStatus,
  };
}

/** The sync state store over the singleton table — the sibling of the probe store. */
export function createEnterpriseGatewayCatalogSyncStore(
  database: Database,
): GatewayCatalogSyncStore {
  return {
    async readSyncState() {
      const [row] = await database
        .select({
          lastSuccessfulSyncAt: gatewayCatalogSyncState.lastSuccessfulSyncAt,
          consecutiveFailures: gatewayCatalogSyncState.consecutiveFailures,
          lastFailureReasonCode: gatewayCatalogSyncState.lastFailureReasonCode,
          lastFailureAt: gatewayCatalogSyncState.lastFailureAt,
          lastAttemptAt: gatewayCatalogSyncState.lastAttemptAt,
          lastAttemptStatus: gatewayCatalogSyncState.lastAttemptStatus,
        })
        .from(gatewayCatalogSyncState)
        .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID))
        .limit(1);
      return row === undefined ? NEVER_SYNCED : syncStateFromRow(row);
    },

    async recordSyncSuccess({ syncedAt }) {
      await database
        .insert(gatewayCatalogSyncState)
        .values({
          id: GATEWAY_CATALOG_SYNC_STATE_ID,
          lastSuccessfulSyncAt: new Date(syncedAt),
          consecutiveFailures: 0,
          lastAttemptAt: new Date(syncedAt),
          lastAttemptStatus: "ok",
        })
        .onConflictDoUpdate({
          target: gatewayCatalogSyncState.id,
          set: {
            // Only this statement writes the success column: a failure that
            // lands after it cannot move the success time backwards.
            lastSuccessfulSyncAt: new Date(syncedAt),
            consecutiveFailures: 0,
            lastFailureReasonCode: null,
            lastFailureAt: null,
            lastAttemptAt: new Date(syncedAt),
            lastAttemptStatus: "ok",
            updatedAt: new Date(),
          },
        });
    },

    async recordSyncFailure({ reasonCode, failedAt }) {
      await database
        .insert(gatewayCatalogSyncState)
        .values({
          id: GATEWAY_CATALOG_SYNC_STATE_ID,
          consecutiveFailures: 1,
          lastFailureReasonCode: reasonCode,
          lastFailureAt: new Date(failedAt),
          lastAttemptAt: new Date(failedAt),
          lastAttemptStatus: "failed",
        })
        .onConflictDoUpdate({
          target: gatewayCatalogSyncState.id,
          set: {
            // The count is computed from the row itself, so two syncs racing
            // the singleton serialize on the row lock and neither loses one.
            consecutiveFailures: sql`${gatewayCatalogSyncState.consecutiveFailures} + 1`,
            lastFailureReasonCode: reasonCode,
            lastFailureAt: new Date(failedAt),
            lastAttemptAt: new Date(failedAt),
            lastAttemptStatus: "failed",
            updatedAt: new Date(),
          },
        });
    },
  };
}

/** What {@link GatewayCatalogSyncService.runSync} answers — never a throw. */
export type CatalogSyncOutcome =
  | {
      status: "ok";
      /** 03.1's fetch record — the audit the snapshot layers re-check against. */
      record: CatalogFetchRecord;
      /** Refs whose dims changed and got a new price version. */
      appended: number;
      /** Refs whose dims matched and got nothing new. */
      skipped: number;
      /** When the sync completed, ISO 8601 — the moment the state row records. */
      syncedAt: string;
    }
  | {
      status: "failed";
      /** Which layer refused: the catalog fetch or the price append. */
      stage: "catalog" | "prices";
      /** The layer's own fixed, displayable reason code. */
      reasonCode: CatalogSyncFailureReasonCode;
      /** When the failure was classified, ISO 8601. */
      failedAt: string;
    };

/** What a status surface (03.5's result, 01.8's screen, 03.10's picker) reads. */
export type CatalogSyncStatus = {
  /** Whether a sync is running in this process right now. */
  inFlight: boolean;
  /** The persisted state between runs — success time, failure count, reason. */
  state: GatewayCatalogSyncStateRow;
};

/** The two layers a sync composes — the interfaces this module consumes and tests inject. */
export type GatewayCatalogSyncDeps = {
  /** 03.1's fetch — the gate, the dial, the last-good replacement. */
  catalog: Pick<GatewayCatalogService, "fetchCatalog">;
  /** 03.2's price mapping — the versioned append over the last-good catalog. */
  prices: Pick<GatewayPriceSnapshotService, "syncFromCatalog">;
  store: GatewayCatalogSyncStore;
  /** Injectable clock for tests. */
  now?: () => Date;
  log?: Logger;
};

export type GatewayCatalogSyncService = {
  /**
   * Run one sync now: fetch the catalog, append the prices, record the state.
   * Concurrent callers join the run already in flight and share its outcome —
   * one dial, one append, one state transition. A failed run keeps the
   * last-good snapshot and the last success time, counts the failure, and
   * records the reason; a broken state write is logged, not unmade.
   */
  runSync: () => Promise<CatalogSyncOutcome>;
  /** The status a surface displays: in-flight plus the persisted state. */
  readSyncStatus: () => Promise<CatalogSyncStatus>;
};

export function createGatewayCatalogSyncService(
  deps: GatewayCatalogSyncDeps,
): GatewayCatalogSyncService {
  const log = deps.log ?? getLogger("server");
  const now = deps.now ?? (() => new Date());
  // The single-flight cell: the in-flight run's promise while one runs,
  // undefined otherwise. Concurrent callers await the same promise and share
  // the same settled outcome object.
  let inFlight: Promise<CatalogSyncOutcome> | undefined;

  async function runOnce(): Promise<CatalogSyncOutcome> {
    // LAYER 1: the catalog. The gate's refusal, the network's refusal and the
    // persist's refusal all arrive as the one failed outcome — the last-good
    // catalog was already kept by 03.1, so only the state remains to write.
    const catalogOutcome: CatalogFetchOutcome =
      await deps.catalog.fetchCatalog();
    if (catalogOutcome.status === "failed") {
      return recordFailure("catalog", catalogOutcome.reasonCode, now);
    }

    // LAYER 2: the prices. The catalog is now the fresh last-good one 03.1
    // just wrote; 03.2 maps and appends what changed under its own lock.
    const priceOutcome: PriceSnapshotSyncOutcome =
      await deps.prices.syncFromCatalog();
    if (priceOutcome.status === "failed") {
      return recordFailure("prices", priceOutcome.reasonCode, now);
    }

    // BOTH LANDED. Only now does the success time move — "last good" means
    // catalog AND prices proven together, or a freshness gate trusts a lie.
    const syncedAt = now().toISOString();
    try {
      await deps.store.recordSyncSuccess({ syncedAt });
    } catch (error) {
      log.error(
        {
          type: "gateway-catalog-sync-state-persist-failed",
          errorName: error instanceof Error ? error.name : String(typeof error),
        },
        "The sync succeeded but its state could not be recorded; the next sync will retry the write.",
      );
    }
    return {
      status: "ok",
      record: catalogOutcome.record,
      appended: priceOutcome.appended,
      skipped: priceOutcome.skipped,
      syncedAt,
    };
  }

  async function recordFailure(
    stage: "catalog" | "prices",
    reasonCode: CatalogSyncFailureReasonCode,
    at: () => Date,
  ): Promise<CatalogSyncOutcome> {
    const failedAt = at().toISOString();
    try {
      await deps.store.recordSyncFailure({ reasonCode, failedAt });
    } catch (error) {
      // The outcome is already in hand; a broken state row must not unmake it
      // (the probe's persist rule). The count repairs at the next attempt.
      log.error(
        {
          type: "gateway-catalog-sync-failure-persist-failed",
          reasonCode,
          errorName: error instanceof Error ? error.name : String(typeof error),
        },
        "The sync failure could not be recorded in the state row.",
      );
    }
    return { status: "failed", stage, reasonCode, failedAt };
  }

  return {
    runSync() {
      if (inFlight !== undefined) {
        return inFlight;
      }
      inFlight = runOnce().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },

    async readSyncStatus() {
      return {
        inFlight: inFlight !== undefined,
        state: await deps.store.readSyncState(),
      };
    },
  };
}

/**
 * The running sync service, installed once so 03.5's trigger and the timer
 * share one single-flight cell (two instances would run two syncs). Internal
 * consumers read it back through {@link gatewayCatalogSyncControls};
 * `undefined` uninstalls (tests).
 */
let installed: GatewayCatalogSyncService | undefined;

export function installGatewayCatalogSyncService(
  service: GatewayCatalogSyncService | undefined,
) {
  installed = service;
}

/** The installed sync service, or undefined in a process that never installed one. */
export function gatewayCatalogSyncControls():
  | GatewayCatalogSyncService
  | undefined {
  return installed;
}

/**
 * The timer seam the scheduler runs on. Injectable so a test advances the
 * clock by hand; the production answer is setTimeout/clearTimeout, unref'd —
 * housekeeping must not hold the process open.
 */
export type SyncSchedulerTimer = {
  schedule(run: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
};

export function defaultSyncSchedulerTimer(): SyncSchedulerTimer {
  return {
    schedule(run, delayMs) {
      const handle = setTimeout(run, delayMs);
      handle.unref?.();
      return handle;
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

export type GatewayCatalogSyncScheduler = {
  /**
   * Begin the cadence: the first sync fires one full period from now (a
   * rolling deployment does not need every replica dialing the gateway in the
   * same second), then one sync per period. Starting a started scheduler is a
   * logged no-op — one timer, not two.
   */
  start(): void;
  /** Stop the cadence. Idempotent; a stopped scheduler fires nothing further. */
  stop(): void;
  /** The configured period, for the status surfaces. */
  readonly intervalMs: number;
};

export function createGatewayCatalogSyncScheduler(options: {
  service: GatewayCatalogSyncService;
  intervalMs: number;
  timer?: SyncSchedulerTimer;
  log?: Logger;
}): GatewayCatalogSyncScheduler {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error(
      `The catalog sync interval must be a positive whole number of milliseconds, got ${String(options.intervalMs)}.`,
    );
  }
  const log = options.log ?? getLogger("server");
  const timer = options.timer ?? defaultSyncSchedulerTimer();
  let handle: unknown;
  let started = false;

  const tick = () => {
    // Reschedule first, then fire: the cadence stays fixed (one sync per
    // period, not per completed sync), a dying sync cannot stop the chain,
    // and an overlap is harmless — the service single-flights concurrent runs
    // into the in-flight one. The outcome is logged; nothing here can throw.
    if (started) handle = timer.schedule(tick, options.intervalMs);
    void options.service
      .runSync()
      .then((outcome) => {
        if (outcome.status === "ok") {
          log.info(
            {
              type: "gateway-catalog-sync-ok",
              appended: outcome.appended,
              skipped: outcome.skipped,
              syncedAt: outcome.syncedAt,
            },
            "The automatic catalog sync completed.",
          );
          return;
        }
        // The fixed reason code only — the failure's message, if any, never
        // leaves the layer that classified it.
        log.warn(
          {
            type: "gateway-catalog-sync-failed",
            stage: outcome.stage,
            reasonCode: outcome.reasonCode,
            failedAt: outcome.failedAt,
          },
          "The automatic catalog sync failed; the last-good snapshot is kept.",
        );
      })
      .catch((error: unknown) => {
        // Unreachable — a sync answers outcomes and records its own broken
        // state writes — but a scheduler that dies silently is worse than a
        // redundant log line.
        log.error(
          {
            type: "gateway-catalog-sync-unexpected-error",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The automatic catalog sync failed unexpectedly.",
        );
      });
  };

  return {
    get intervalMs() {
      return options.intervalMs;
    },
    start() {
      if (started) {
        log.warn(
          { type: "gateway-catalog-sync-scheduler-already-started" },
          "The catalog sync scheduler was started twice; the first timer stays.",
        );
        return;
      }
      started = true;
      handle = timer.schedule(tick, options.intervalMs);
    },
    stop() {
      started = false;
      if (handle !== undefined) {
        timer.cancel(handle);
        handle = undefined;
      }
    },
  };
}

/**
 * Assemble the sync service from the installed enterprise controls and start
 * its scheduler — the deployment wiring's whole job here. The service is
 * installed first, so 03.5's routes (and any surface) resolve the very
 * instance whose single-flight cell the timer uses. Answers the sweeper (to
 * `stop()` on shutdown), or undefined when this process has no enterprise
 * controls or no catalog service — a test or script that never wired the
 * gateway has nothing to schedule, and saying so beats a timer that refuses
 * on every tick.
 */
export function startGatewayCatalogSyncScheduler(options: {
  /** Pass when the caller already holds the instance (tests); otherwise assembled from the installed controls. */
  service?: GatewayCatalogSyncService;
  /** Overrides the default five minutes; validated like the environment value. */
  intervalMs?: number;
  /** Injectable timer for tests. */
  timer?: SyncSchedulerTimer;
  /** The environment conversion rate, when the deployment configured one. */
  environmentRate?: Parameters<typeof readCurrentRateVersion>[1];
  log?: Logger;
}):
  | {
      stop(): void;
    }
  | undefined {
  const log = options.log ?? getLogger("server");
  let service = options.service;
  if (service === undefined) {
    const controls = enterpriseControls();
    const catalog = gatewayCatalogControls();
    if (!controls || !catalog) {
      log.info(
        { type: "gateway-catalog-sync-scheduler-absent" },
        "No enterprise controls or no catalog service installed; the automatic catalog sync is not scheduled.",
      );
      return undefined;
    }
    const prices =
      gatewayPriceSnapshotControls() ??
      createGatewayPriceSnapshotService({
        listCatalogEntries: () => catalog.listCatalogEntries(),
        store: createEnterpriseGatewayPriceSnapshotStore(
          controls.deps.database,
        ),
        readRateVersion: () =>
          readCurrentRateVersion(
            controls.deps.database,
            options.environmentRate,
          ),
        log,
      });
    // The price service this scheduler assembled is the one downstream
    // tickets read: installing it here is the wiring 03.2's install hook
    // reserved for the cadence that first runs it.
    if (!gatewayPriceSnapshotControls()) {
      installGatewayPriceSnapshotService(prices);
    }
    service = createGatewayCatalogSyncService({
      catalog,
      prices,
      store: createEnterpriseGatewayCatalogSyncStore(controls.deps.database),
      log,
    });
  }
  installGatewayCatalogSyncService(service);
  // The cadence is configuration: an explicit option wins, otherwise the
  // environment answers (default five minutes, the variable validated in
  // one place — a deployment that misspells the value stops here, loudly).
  const intervalMs =
    options.intervalMs ?? gatewayCatalogSyncIntervalConfig(process.env);
  const scheduler = createGatewayCatalogSyncScheduler({
    service,
    intervalMs,
    ...(options.timer === undefined ? {} : { timer: options.timer }),
    log,
  });
  scheduler.start();
  log.info(
    { type: "gateway-catalog-sync-scheduler-started", intervalMs },
    "The automatic catalog sync is scheduled.",
  );
  return {
    stop: () => scheduler.stop(),
  };
}
