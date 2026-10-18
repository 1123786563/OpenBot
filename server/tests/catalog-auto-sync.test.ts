import { afterAll, beforeEach, describe, expect, test } from "../../tests/support/e2e-compat";
import { and, eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  gatewayCatalogFetches,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayPriceSnapshots,
} from "../src/db/schema";
import {
  type CatalogFetchOutcome,
  createEnterpriseGatewayCatalogStore,
  createGatewayCatalogService,
  type GatewayCatalogStore,
} from "../src/gateway/catalog";
import {
  BIFROST_CATALOG_SYNC_INTERVAL_MS_VARIABLE,
  createEnterpriseGatewayCatalogSyncStore,
  createGatewayCatalogSyncScheduler,
  createGatewayCatalogSyncService,
  DEFAULT_CATALOG_SYNC_INTERVAL_MS,
  type GatewayCatalogSyncStateRow,
  type GatewayCatalogSyncStore,
  gatewayCatalogSyncControls,
  gatewayCatalogSyncIntervalConfig,
  installGatewayCatalogSyncService,
  type SyncSchedulerTimer,
} from "../src/gateway/catalog-sync";
import type { GatewayEndpointConfig } from "../src/gateway/endpoint-config";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  createGatewayPriceSnapshotService,
  type GatewayPriceSnapshotStore,
} from "../src/gateway/price-snapshot";
import type { GatewayReadiness } from "../src/gateway/readiness";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { type FakeGateway, startFakeGateway } from "./support/fake-gateway";

/*
 * Bifrost 03.4 — the automatic catalog/price sync (AC10, design Q17) on a real
 * PostgreSQL on TEST_DATABASE_URL (tests/support/database.ts refuses the live
 * database), against the same programmable fake gateway the 03.1 suite uses.
 *
 * What only this file can prove: the periodic task fires exactly once per
 * configured period on a controllable clock (and not before, and not twice),
 * a failed sync keeps the last-good catalog AND price snapshots while the
 * last successful sync time stays put and the consecutive failure count and
 * sanitized reason become queryable state, concurrent triggers share one
 * running sync (one dial, no duplicate snapshot versions), and the state row
 * survives the service that wrote it (03.5/01.8/03.10 read it back).
 *
 * The `gateway_catalog_fetches` and `gateway_price_snapshots` tables are
 * append-only — nobody can delete rows — so this suite attributes its rows
 * the way the 03.1/03.2 suites do: a monotonic test clock for the fetch log
 * and unique provider names for price snapshots. The sync *state* row is a
 * mutable singleton by design and is reset between tests.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const catalogStore: GatewayCatalogStore =
  createEnterpriseGatewayCatalogStore(database);
const priceStore: GatewayPriceSnapshotStore =
  createEnterpriseGatewayPriceSnapshotStore(database);
const syncStore: GatewayCatalogSyncStore =
  createEnterpriseGatewayCatalogSyncStore(database);

/** A green gate: ready, version 7 — the answer every success presumes. */
function readyReadiness(): GatewayReadiness {
  return {
    ready: true,
    blockingReasons: [],
    configVersion: 7,
    checkedAt: "2026-10-17T00:00:00.000Z",
  };
}

function catalogModelBody(entries: unknown[]) {
  return JSON.stringify({ object: "list", data: entries });
}

/**
 * Monotonic test clock, the 03.1 suite's rule: every fetch stamps a strictly
 * later completion time than the one before, and each test pushes the clock
 * past the log's newest row first, so stale rows can never outrank fresh ones
 * in the append-only fetch log.
 */
let tick = Date.now();

async function advanceClockPastLog() {
  const [row] = await database
    .select({
      newest: sql<Date | null>`max(${gatewayCatalogFetches.fetchedAt})`,
    })
    .from(gatewayCatalogFetches);
  const newest = row?.newest ? new Date(row.newest).getTime() : 0;
  if (newest >= tick) tick = newest + 60_000;
}

/** Providers are unique per run: the price snapshot table is append-only. */
const PROVIDER = `sync-${randomSuffix()}`;

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function manifestBody(): string {
  return catalogModelBody([
    {
      id: `${PROVIDER}/gpt-4o`,
      supported_methods: ["chat"],
      pricing: { prompt: "0.0000025", completion: "0.00001" },
    },
  ]);
}

/** The same model with a changed price — the next sync must mint version 2. */
function changedManifestBody(): string {
  return catalogModelBody([
    {
      id: `${PROVIDER}/gpt-4o`,
      supported_methods: ["chat"],
      pricing: { prompt: "0.0000030", completion: "0.00001" },
    },
  ]);
}

/** One endpoint pointing at the fake gateway (flipped per test as needed). */
let endpoint: GatewayEndpointConfig = {
  baseUrl: "http://127.0.0.1:1",
  requestTimeoutMs: 5_000,
  configVersion: 7,
};

function catalogService() {
  return createGatewayCatalogService({
    assertGatewayReady: async () => readyReadiness(),
    readGatewayEndpoint: async () => endpoint,
    resolveGatewayAdminCredential: async () => ({ adminKey: "admin-key" }),
    store: catalogStore,
    now: () => {
      tick += 1000;
      return new Date(tick);
    },
  });
}

function priceService() {
  return createGatewayPriceSnapshotService({
    listCatalogEntries: () => catalogStore.readCatalogRefs(),
    store: priceStore,
    readRateVersion: async () => null,
    now: () => new Date(tick),
  });
}

function syncService() {
  return createGatewayCatalogSyncService({
    catalog: catalogService(),
    prices: priceService(),
    store: syncStore,
    now: () => {
      tick += 1000;
      return new Date(tick);
    },
  });
}

async function storedRefs(): Promise<
  { provider: string; model: string; capability: string }[]
> {
  return database
    .select({
      provider: gatewayModelCatalogRefs.provider,
      model: gatewayModelCatalogRefs.model,
      capability: gatewayModelCatalogRefs.capability,
    })
    .from(gatewayModelCatalogRefs)
    .orderBy(
      gatewayModelCatalogRefs.provider,
      gatewayModelCatalogRefs.model,
      gatewayModelCatalogRefs.capability,
    );
}

beforeEach(async () => {
  // The sync state is a mutable singleton row by design — the one gateway
  // table this suite may clear.
  await database.delete(gatewayCatalogSyncState);
  await database.delete(gatewayModelCatalogRefs);
  await advanceClockPastLog();
});

afterAll(async () => {
  await database.$client.close();
});

describe("the sync interval is configuration, not a constant", () => {
  test("unset means the default five minutes", () => {
    expect(
      gatewayCatalogSyncIntervalConfig(
        {} as Record<string, string | undefined>,
      ),
    ).toBe(DEFAULT_CATALOG_SYNC_INTERVAL_MS);
    expect(DEFAULT_CATALOG_SYNC_INTERVAL_MS).toBe(300_000);
  });

  test("a valid override is honored", () => {
    expect(
      gatewayCatalogSyncIntervalConfig({
        [BIFROST_CATALOG_SYNC_INTERVAL_MS_VARIABLE]: "60000",
      }),
    ).toBe(60_000);
  });

  test.each(["0", "-1000", "1.5", "five"])(
    "an invalid override (%s) refuses with the variable named",
    (value) => {
      expect(() =>
        gatewayCatalogSyncIntervalConfig({
          [BIFROST_CATALOG_SYNC_INTERVAL_MS_VARIABLE]: value,
        }),
      ).toThrow(BIFROST_CATALOG_SYNC_INTERVAL_MS_VARIABLE);
    },
  );

  test("an empty value reads as unset, the house convention of the endpoint config", () => {
    expect(
      gatewayCatalogSyncIntervalConfig({
        [BIFROST_CATALOG_SYNC_INTERVAL_MS_VARIABLE]: "",
      }),
    ).toBe(DEFAULT_CATALOG_SYNC_INTERVAL_MS);
  });
});

describe("the periodic task fires once per period on a controllable clock", () => {
  /**
   * A timer the test drives: scheduled callbacks fire only when the test
   * advances virtual time, so "the clock advanced five minutes" is an
   * assertion about exactly the inputs the AC names.
   */
  function controllableTimer(): SyncSchedulerTimer & {
    advance(ms: number): void;
    pendingCount(): number;
  } {
    let virtualNow = 0;
    let nextId = 1;
    const pending = new Map<number, { run: () => void; due: number }>();
    return {
      schedule(run, delayMs) {
        const id = nextId++;
        pending.set(id, { run, due: virtualNow + delayMs });
        return id;
      },
      cancel(handle) {
        pending.delete(handle as number);
      },
      advance(ms) {
        const target = virtualNow + ms;
        for (;;) {
          const due = [...pending.entries()]
            .filter(([, item]) => item.due <= target)
            .sort((a, b) => a[1].due - b[1].due)[0];
          if (due === undefined) break;
          pending.delete(due[0]);
          virtualNow = due[1].due;
          due[1].run();
        }
        virtualNow = target;
      },
      pendingCount() {
        return pending.size;
      },
    };
  }

  /** A stub run counter at the service seam (scheduling, not SQL, is under test here). */
  function countingService() {
    let runs = 0;
    return {
      get runCount() {
        return runs;
      },
      runSync: async () => {
        runs += 1;
        return {
          status: "ok" as const,
          record: {
            fetchedAt: new Date().toISOString(),
            source: "gateway:/v1/models",
            rawItemCount: 1,
            configVersion: 7,
          },
          appended: 0,
          skipped: 0,
          syncedAt: new Date().toISOString(),
        };
      },
      readSyncStatus: async () => ({
        inFlight: false,
        state: {
          lastSuccessfulSyncAt: null,
          consecutiveFailures: 0,
          lastFailureReasonCode: null,
          lastFailureAt: null,
          lastAttemptAt: null,
          lastAttemptStatus: null,
        },
      }),
    };
  }

  test("one period advance triggers exactly one sync; the next period one more", () => {
    const timer = controllableTimer();
    const service = countingService();
    const scheduler = createGatewayCatalogSyncScheduler({
      service,
      intervalMs: 300_000,
      timer,
    });
    scheduler.start();

    timer.advance(299_999);
    expect(service.runCount).toBe(0);
    timer.advance(1);
    expect(service.runCount).toBe(1);
    // Exactly one, not two: the +5min boundary fired a single callback.
    timer.advance(0);
    expect(service.runCount).toBe(1);

    timer.advance(300_000);
    expect(service.runCount).toBe(2);
    scheduler.stop();
    timer.advance(300_000);
    expect(service.runCount).toBe(2);
    expect(timer.pendingCount()).toBe(0);
  });

  test("the period is the configured one, not the default", () => {
    const timer = controllableTimer();
    const service = countingService();
    const scheduler = createGatewayCatalogSyncScheduler({
      service,
      intervalMs: 60_000,
      timer,
    });
    scheduler.start();
    timer.advance(60_000);
    expect(service.runCount).toBe(1);
    timer.advance(60_000);
    expect(service.runCount).toBe(2);
    scheduler.stop();
  });
});

describe("a successful sync writes the snapshot and the success time", () => {
  let gateway: FakeGateway;

  afterAll(async () => {
    await gateway?.stop();
  });

  test("catalog refs, price snapshot v1 and the state row land together", async () => {
    gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: manifestBody(),
    });
    endpoint = {
      baseUrl: gateway.baseUrl,
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };

    const outcome = await syncService().runSync();

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.record.rawItemCount).toBe(1);
      expect(outcome.appended).toBe(1);
    }
    expect(await storedRefs()).toEqual([
      { provider: PROVIDER, model: "gpt-4o", capability: "chat" },
    ]);

    const status = await syncStore.readSyncState();
    expect(status.lastSuccessfulSyncAt).not.toBeNull();
    expect(status.consecutiveFailures).toBe(0);
    expect(status.lastFailureReasonCode).toBeNull();
    expect(status.lastAttemptStatus).toBe("ok");
    const snapshot = await priceStore.latestPriceSnapshot({
      provider: PROVIDER,
      model: "gpt-4o",
      capability: "chat",
    });
    expect(snapshot?.snapshotVersion).toBe(1);
  });
});

describe("a failed sync keeps last-good and the success time", () => {
  let gateway: FakeGateway;

  afterAll(async () => {
    await gateway?.stop();
  });

  test("an unreachable gateway: refs, prices and lastSuccessfulSyncAt stay put, failures count up", async () => {
    gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: manifestBody(),
    });
    endpoint = {
      baseUrl: gateway.baseUrl,
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };

    const first = await syncService().runSync();
    expect(first.status).toBe("ok");
    const successAt = (await syncStore.readSyncState()).lastSuccessfulSyncAt;
    expect(successAt).not.toBeNull();

    // The gateway goes away: the dial refuses (fast, deterministic), the sync
    // must fail without touching the last-good snapshot.
    endpoint = {
      baseUrl: "http://127.0.0.1:1",
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };

    const second = await syncService().runSync();
    expect(second.status).toBe("failed");
    if (second.status === "failed") {
      expect(second.stage).toBe("catalog");
      expect(second.reasonCode).toBe("catalog_fetch_unreachable");
    }

    expect(await storedRefs()).toEqual([
      { provider: PROVIDER, model: "gpt-4o", capability: "chat" },
    ]);
    const snapshot = await priceStore.latestPriceSnapshot({
      provider: PROVIDER,
      model: "gpt-4o",
      capability: "chat",
    });
    expect(snapshot?.snapshotVersion).toBe(1);

    const state = await syncStore.readSyncState();
    expect(state.lastSuccessfulSyncAt).toBe(successAt);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastFailureReasonCode).toBe("catalog_fetch_unreachable");
    expect(state.lastFailureAt).not.toBeNull();
    expect(state.lastAttemptStatus).toBe("failed");

    // The next failure counts up; the success time still does not move.
    const third = await syncService().runSync();
    expect(third.status).toBe("failed");
    const afterTwo = await syncStore.readSyncState();
    expect(afterTwo.consecutiveFailures).toBe(2);
    expect(afterTwo.lastSuccessfulSyncAt).toBe(successAt);
  });

  test("a refused readiness gate records the gate's reason code", async () => {
    const { GatewayNotReadyError } = await import("../src/gateway/readiness");
    const readiness: GatewayReadiness = {
      ready: false,
      blockingReasons: ["gateway_readiness_probe_not_ok"],
      configVersion: 7,
      checkedAt: "2026-10-17T00:00:00.000Z",
    };
    const service = createGatewayCatalogSyncService({
      catalog: createGatewayCatalogService({
        assertGatewayReady: async () => {
          throw new GatewayNotReadyError(readiness, [
            {
              reason: "gateway_readiness_probe_not_ok",
              message: "The probe did not pass.",
            },
          ]);
        },
        readGatewayEndpoint: async () => endpoint,
        resolveGatewayAdminCredential: async () => ({ adminKey: "k" }),
        store: catalogStore,
        now: () => new Date(tick),
      }),
      prices: priceService(),
      store: syncStore,
      now: () => new Date(tick),
    });

    const outcome = await service.runSync();
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.stage).toBe("catalog");
      expect(outcome.reasonCode).toBe("catalog_fetch_gate_not_ready");
    }
    const state = await syncStore.readSyncState();
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastFailureReasonCode).toBe("catalog_fetch_gate_not_ready");
    expect(state.lastSuccessfulSyncAt).toBeNull();
  });

  test("a price-sync failure also refuses to move the success time", async () => {
    gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: manifestBody(),
    });
    endpoint = {
      baseUrl: gateway.baseUrl,
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };

    const service = createGatewayCatalogSyncService({
      catalog: catalogService(),
      prices: {
        // The 03.2 seam answers its own outcome shape; the failure it reports
        // must fail the whole sync exactly as a catalog failure would.
        syncFromCatalog: async () => ({
          status: "failed" as const,
          reasonCode: "price_sync_persist_failed" as const,
          failedAt: new Date().toISOString(),
        }),
      },
      store: syncStore,
      now: () => new Date(tick),
    });

    const outcome = await service.runSync();
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.stage).toBe("prices");
      expect(outcome.reasonCode).toBe("price_sync_persist_failed");
    }
    const state = await syncStore.readSyncState();
    expect(state.lastSuccessfulSyncAt).toBeNull();
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastFailureReasonCode).toBe("price_sync_persist_failed");
    // 03.1's own last-good rule is untouched: the fetch half still wrote the
    // catalog it proved; the *sync's* success time is what stayed put.
    expect(await storedRefs()).toEqual([
      { provider: PROVIDER, model: "gpt-4o", capability: "chat" },
    ]);
  });

  test("the next success resets the failure count and clears the reason", async () => {
    gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: manifestBody(),
    });
    endpoint = {
      baseUrl: gateway.baseUrl,
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };

    const broken = endpoint;
    endpoint = {
      baseUrl: "http://127.0.0.1:1",
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };
    await syncService().runSync();
    const failed = await syncStore.readSyncState();
    expect(failed.consecutiveFailures).toBe(1);

    endpoint = broken;
    const outcome = await syncService().runSync();
    expect(outcome.status).toBe("ok");
    const state = await syncStore.readSyncState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastFailureReasonCode).toBeNull();
    expect(state.lastFailureAt).toBeNull();
    expect(state.lastSuccessfulSyncAt).not.toBeNull();
  });
});

describe("concurrent triggers share one sync", () => {
  let gateway: FakeGateway;

  afterAll(async () => {
    await gateway?.stop();
  });

  test("callers joining a running sync get its outcome; the layer runs once", async () => {
    // A deferred catalog fetch the test releases by hand: the overlap is
    // deterministic (no timing race), the price and state layers stay real.
    let entered = 0;
    let releaseFetch: (outcome: CatalogFetchOutcome) => void = () => {};
    const deferredFetch = () =>
      new Promise<CatalogFetchOutcome>((resolve) => {
        entered += 1;
        releaseFetch = resolve;
      });
    const service = createGatewayCatalogSyncService({
      catalog: { fetchCatalog: deferredFetch },
      prices: priceService(),
      store: syncStore,
      now: () => new Date(tick),
    });

    const first = service.runSync();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(1);
    expect((await service.readSyncStatus()).inFlight).toBe(true);

    const joiners = Promise.all([
      service.runSync(),
      service.runSync(),
      service.runSync(),
      service.runSync(),
    ]);
    releaseFetch({
      status: "ok",
      record: {
        fetchedAt: new Date(tick).toISOString(),
        source: "gateway:/v1/models",
        rawItemCount: 0,
        configVersion: 7,
      },
      entries: [],
      issueCount: 0,
      duplicateCount: 0,
    });

    const outcome = await first;
    const joined = await joiners;
    expect(outcome.status).toBe("ok");
    for (const result of joined) {
      // Every caller shares the one run's answer — one outcome object.
      expect(result).toBe(outcome);
    }
    expect(entered).toBe(1);
    expect((await service.readSyncStatus()).inFlight).toBe(false);

    const state = await syncStore.readSyncState();
    expect(state.lastSuccessfulSyncAt).not.toBeNull();
    expect(state.consecutiveFailures).toBe(0);
  });

  test("a burst of overlapping triggers mints no duplicate snapshot versions", async () => {
    gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: manifestBody(),
    });
    endpoint = {
      baseUrl: gateway.baseUrl,
      requestTimeoutMs: 5_000,
      configVersion: 7,
    };

    // One sync to establish version 1.
    await syncService().runSync();
    const dialedBeforeBurst = gateway.requests.length;

    // The gateway now serves a changed price; a storm of overlapping triggers
    // must land exactly one new version, not one per trigger.
    gateway.respondWith({
      kind: "response",
      status: 200,
      body: changedManifestBody(),
    });

    const service = syncService();
    const outcomes = await Promise.all([
      service.runSync(),
      service.runSync(),
      service.runSync(),
      service.runSync(),
      service.runSync(),
    ]);
    const ok = outcomes.filter((outcome) => outcome.status === "ok");
    expect(ok.length).toBeGreaterThan(0);
    if (ok[0].status === "ok") {
      expect(ok[0].appended).toBe(1);
    }
    // Five triggers, one shared run: the gateway is dialed exactly once more.
    expect(gateway.requests.length - dialedBeforeBurst).toBe(1);

    const versions = await database
      .select({ v: gatewayPriceSnapshots.snapshotVersion })
      .from(gatewayPriceSnapshots)
      .where(
        and(
          eq(gatewayPriceSnapshots.provider, PROVIDER),
          eq(gatewayPriceSnapshots.model, "gpt-4o"),
          eq(gatewayPriceSnapshots.capability, "chat"),
        ),
      )
      .orderBy(gatewayPriceSnapshots.snapshotVersion);
    expect(versions.map((row) => row.v)).toEqual([1, 2]);
  });

  test("the status read answers in-flight while a sync runs", async () => {
    let releaseFetch: (outcome: CatalogFetchOutcome) => void = () => {};
    const service = createGatewayCatalogSyncService({
      catalog: {
        fetchCatalog: () =>
          new Promise<CatalogFetchOutcome>((resolve) => {
            releaseFetch = resolve;
          }),
      },
      prices: priceService(),
      store: syncStore,
      now: () => new Date(tick),
    });

    const running = service.runSync();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await service.readSyncStatus()).inFlight).toBe(true);
    releaseFetch({
      status: "ok",
      record: {
        fetchedAt: new Date(tick).toISOString(),
        source: "gateway:/v1/models",
        rawItemCount: 0,
        configVersion: 7,
      },
      entries: [],
      issueCount: 0,
      duplicateCount: 0,
    });
    await running;
    expect((await service.readSyncStatus()).inFlight).toBe(false);
  });
});

describe("the installed service is the one instance 03.5 will reuse", () => {
  test("install, read back the same instance, uninstall", () => {
    const service = {
      runSync: async () => {
        throw new Error("not under test");
      },
      readSyncStatus: async () => ({
        inFlight: false,
        state: {
          lastSuccessfulSyncAt: null,
          consecutiveFailures: 0,
          lastFailureReasonCode: null,
          lastFailureAt: null,
          lastAttemptAt: null,
          lastAttemptStatus: null,
        } satisfies GatewayCatalogSyncStateRow,
      }),
    };
    expect(gatewayCatalogSyncControls()).toBeUndefined();
    installGatewayCatalogSyncService(service);
    expect(gatewayCatalogSyncControls()).toBe(service);
    installGatewayCatalogSyncService(undefined);
    expect(gatewayCatalogSyncControls()).toBeUndefined();
  });
});
