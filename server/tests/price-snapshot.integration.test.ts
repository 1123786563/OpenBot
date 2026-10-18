import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  createGatewayPriceSnapshotService,
  mapPriceDims,
  type PriceSnapshotAppendInput,
  type PriceSnapshotDims,
  type GatewayPriceSnapshotStore,
} from "../src/gateway/price-snapshot";
import type { CatalogStoredRef, ModelRef } from "../src/gateway/catalog";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost 03.2 — price snapshot persistence and versioning, on a real
 * PostgreSQL on TEST_DATABASE_URL (tests/support/database.ts refuses the
 * live database).
 *
 * What only this file can prove: the snapshot table is append-only *in the
 * database* (UPDATE, DELETE and TRUNCATE are all refused by triggers, so a
 * history the settlement path resolves against cannot be rewritten by any
 * writer), every appended snapshot carries all twelve dimensions under the
 * database's own CHECK (a missing key or a negative amount is a refusal, not
 * a silent zero), same-name models on two providers version independently,
 * and a change appends a new snapshotVersion while an unchanged re-sync
 * appends nothing.
 *
 * The table cannot be truncated by the tests either — it is append-only — so
 * every test isolates itself with unique provider names instead of
 * cleaning up.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createEnterpriseGatewayPriceSnapshotStore(database);

/**
 * One raw statement as a real promise: drizzle's execute answers a thenable
 * query builder, which expect().rejects does not accept.
 */
function rawExec(query: Parameters<typeof database.execute>[0]): Promise<unknown> {
  return (async () => database.execute(query))();
}

/**
 * Assert one raw statement is refused by the append-only triggers. Drizzle wraps the driver
 * error ("Failed query: ...") with the real refusal on `cause`, so the match goes through it.
 */
async function expectAppendOnlyRefusal(query: Parameters<typeof database.execute>[0]) {
  const error = await rawExec(query).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeDefined();
  const cause = (error as { cause?: { message?: string } }).cause;
  expect(cause?.message ?? String(error)).toMatch(/append-only/);
}

afterAll(async () => {
  await database.$client.close();
});

/** A provider name no other test (this run or any earlier run) has used. */
function uniqueProvider(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function ref(provider: string, model = "gpt-4o", capability = "chat"): ModelRef {
  return { provider, model, capability };
}

function fullyPricedDims(): PriceSnapshotDims {
  return mapPriceDims({
    id: "openai/gpt-4o",
    pricing: {
      prompt: "0.0000025000",
      completion: "0.0000100000",
      input_cache_read: "0.0000012500",
      input_cache_write: "0.0000031250",
    },
  });
}

function appendInput(
  modelRef: ModelRef,
  dims: PriceSnapshotDims,
  overrides: Partial<Omit<PriceSnapshotAppendInput, "ref" | "dims">> = {},
): PriceSnapshotAppendInput {
  return {
    ref: modelRef,
    dims,
    fetchedAt: "2026-10-17T00:00:00.000Z",
    source: "gateway:/v1/models",
    configVersion: 7,
    rateVersion: 5,
    ...overrides,
  };
}

describe("appending and reading back", () => {
  test("the first sync of a ref is version 1, and the read-back is the exact dims object", async () => {
    const provider = uniqueProvider("first");
    const dims = fullyPricedDims();
    const result = await store.appendSnapshots([
      appendInput(ref(provider), dims),
    ]);
    expect(result).toEqual({ appended: 1, skipped: 0 });

    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest).toBeDefined();
    expect(latest?.snapshotVersion).toBe(1);
    expect(latest?.ref).toEqual(ref(provider));
    expect(latest?.dims).toEqual(dims);
    expect(latest?.source).toBe("gateway:/v1/models");
    expect(latest?.configVersion).toBe(7);
    expect(latest?.rateVersion).toBe(5);
    expect(latest?.fetchedAt).toBe("2026-10-17T00:00:00.000Z");
  });

  test("a re-sync with unchanged dims appends nothing — a version is a price change, not a clock tick", async () => {
    const provider = uniqueProvider("unchanged");
    const dims = fullyPricedDims();
    await store.appendSnapshots([appendInput(ref(provider), dims)]);
    const second = await store.appendSnapshots([
      appendInput(ref(provider), dims, {
        fetchedAt: "2026-10-17T01:00:00.000Z", // a later fetch, same prices
      }),
    ]);
    expect(second).toEqual({ appended: 0, skipped: 1 });

    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest?.snapshotVersion).toBe(1);
    // The last snapshot still names the fetch its prices came from.
    expect(latest?.fetchedAt).toBe("2026-10-17T00:00:00.000Z");
  });

  test("a price change appends version 2 and history stays resolvable by version", async () => {
    const provider = uniqueProvider("versioned");
    const first = fullyPricedDims();
    await store.appendSnapshots([appendInput(ref(provider), first)]);
    const second: PriceSnapshotDims = {
      ...first,
      input: { status: "known", amount: "0.000003" },
    };
    const result = await store.appendSnapshots([
      appendInput(ref(provider), second, {
        fetchedAt: "2026-10-17T02:00:00.000Z",
      }),
    ]);
    expect(result).toEqual({ appended: 1, skipped: 0 });

    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest?.snapshotVersion).toBe(2);
    expect(latest?.dims.input).toEqual({ status: "known", amount: "0.000003" });
    expect(latest?.fetchedAt).toBe("2026-10-17T02:00:00.000Z");

    // The settlement path resolves the version that was locked, not "latest".
    const historical = await store.priceSnapshot(ref(provider), 1);
    expect(historical?.snapshotVersion).toBe(1);
    expect(historical?.dims).toEqual(first);
    expect(await store.priceSnapshot(ref(provider), 99)).toBeUndefined();
  });

  test("the same model name on two providers versions independently — never merged", async () => {
    const suffix = randomUUID().slice(0, 8);
    const openai = ref(`openai-${suffix}`);
    const azure = ref(`azure-${suffix}`);
    const dims = fullyPricedDims();
    await store.appendSnapshots([appendInput(openai, dims), appendInput(azure, dims)]);

    // A change to one provider's prices leaves the other's history alone.
    await store.appendSnapshots([
      appendInput(openai, {
        ...dims,
        output: { status: "known", amount: "0.00002" },
      }),
    ]);

    expect((await store.latestPriceSnapshot(openai))?.snapshotVersion).toBe(2);
    expect((await store.latestPriceSnapshot(azure))?.snapshotVersion).toBe(1);
    const azureHistory = await store.priceSnapshot(azure, 1);
    expect(azureHistory?.dims).toEqual(dims);
  });

  test("listLatestPriceSnapshots returns the newest version per ref", async () => {
    const provider = uniqueProvider("list");
    const dims = fullyPricedDims();
    await store.appendSnapshots([appendInput(ref(provider), dims)]);
    await store.appendSnapshots([
      appendInput(ref(provider), {
        ...dims,
        video: { status: "known", amount: "0.5" },
      }),
    ]);

    const all = await store.listLatestPriceSnapshots();
    const mine = all.filter((snapshot) => snapshot.ref.provider === provider);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.snapshotVersion).toBe(2);
  });

  test("a missing rate at sync time is recorded as NULL, never as rate 0", async () => {
    const provider = uniqueProvider("norate");
    await store.appendSnapshots([
      appendInput(ref(provider), fullyPricedDims(), { rateVersion: null }),
    ]);
    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest?.rateVersion).toBeNull();
  });

  test("concurrent syncs serialize on the advisory lock and every change lands exactly once", async () => {
    const provider = uniqueProvider("concurrent");
    const dims = fullyPricedDims();
    await store.appendSnapshots([appendInput(ref(provider), dims)]);

    // Two syncs race; each carries a distinct change, so both must append.
    const [a, b] = await Promise.all([
      store.appendSnapshots([
        appendInput(ref(provider), {
          ...dims,
          input: { status: "known", amount: "0.0000031" },
        }),
      ]),
      store.appendSnapshots([
        appendInput(ref(provider), {
          ...dims,
          input: { status: "known", amount: "0.0000032" },
        }),
      ]),
    ]);
    expect(a.appended + b.appended).toBe(2);

    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest?.snapshotVersion).toBe(3);
    const second = await store.priceSnapshot(ref(provider), 2);
    expect(second).toBeDefined();
  });
});

describe("the database carries the rules the application states", () => {
  test("a dims object missing a dimension key is refused — unknown is explicit, never absent", async () => {
    const provider = uniqueProvider("checkkeys");
    const dims = fullyPricedDims();
    const incomplete = { ...dims };
    delete (incomplete as Record<string, unknown>).audio_input;
    await expect(
      store.appendSnapshots([appendInput(ref(provider), incomplete)]),
    ).rejects.toThrow();
  });

  test("an unknown dimension recorded as a zero amount is refused", async () => {
    const provider = uniqueProvider("checkzero");
    const dims = fullyPricedDims();
    await expect(
      store.appendSnapshots([
        appendInput(ref(provider), {
          ...dims,
          audio_input: { status: "unknown", amount: "0" },
        }),
      ]),
    ).rejects.toThrow();
  });

  test("a negative or non-decimal amount is refused by the database", async () => {
    const provider = uniqueProvider("checkamount");
    const dims = fullyPricedDims();
    for (const amount of ["-0.5", "1e-5", ""]) {
      await expect(
        store.appendSnapshots([
          appendInput(ref(provider), {
            ...dims,
            input: { status: "known", amount },
          }),
        ]),
      ).rejects.toThrow();
    }
  });

  test("a capability outside the closed set is refused", async () => {
    const provider = uniqueProvider("checkcap");
    await expect(
      rawExec(
        sql`INSERT INTO gateway_price_snapshots (provider, model, capability, snapshot_version, dims, source, config_version, rate_version, fetched_at)
            VALUES (${provider}, 'gpt-4o', 'poetry', 1, ${fullyPricedDims()}, 'gateway:/v1/models', 7, 5, '2026-10-17T00:00:00Z')`,
      ),
    ).rejects.toThrow();
  });
});

describe("the sync service maps the last-good catalog and appends what changed", () => {
  function catalogEntry(provider: string, pricing: Record<string, unknown>): CatalogStoredRef {
    return {
      ref: { provider, model: "gpt-4o", capability: "chat" },
      capabilitySource: "supported_methods",
      rawEntry: { id: `${provider}/gpt-4o`, supported_methods: ["chat"], pricing },
      configVersion: 7,
      fetchedAt: "2026-10-17T03:00:00.000Z",
    };
  }

  function service(overrides: {
    listCatalogEntries?: () => Promise<CatalogStoredRef[]>;
    store?: GatewayPriceSnapshotStore;
    readRateVersion?: () => Promise<number | null>;
  }) {
    return createGatewayPriceSnapshotService({
      listCatalogEntries:
        overrides.listCatalogEntries ??
        (() => Promise.resolve([catalogEntry("sync-ok", { prompt: "0.5" })])),
      store: overrides.store ?? store,
      readRateVersion: overrides.readRateVersion ?? (() => Promise.resolve(9)),
    });
  }

  test("a sync maps every entry and records the rate version and fetch provenance", async () => {
    const provider = uniqueProvider("sync");
    const outcome = await service({
      listCatalogEntries: () =>
        Promise.resolve([catalogEntry(provider, { prompt: "0.5" })]),
    }).syncFromCatalog();
    expect(outcome).toMatchObject({
      status: "ok",
      mappedRefs: 1,
      appended: 1,
      skipped: 0,
    });
    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest?.snapshotVersion).toBe(1);
    expect(latest?.dims.input).toEqual({ status: "known", amount: "0.5" });
    expect(latest?.dims.audio_input).toEqual({
      status: "unknown",
      reason: "price_dim_no_source",
    });
    expect(latest?.rateVersion).toBe(9);
    expect(latest?.fetchedAt).toBe("2026-10-17T03:00:00.000Z");
    expect(latest?.source).toBe("gateway:/v1/models");
  });

  test("a second sync of unchanged prices skips — the cadence mints no versions", async () => {
    const provider = uniqueProvider("sync-skip");
    const entries = [catalogEntry(provider, { prompt: "0.5" })];
    const svc = service({ listCatalogEntries: () => Promise.resolve(entries) });
    await svc.syncFromCatalog();
    const outcome = await svc.syncFromCatalog();
    expect(outcome).toMatchObject({ status: "ok", appended: 0, skipped: 1 });
  });

  test("a price change lands as a new version; the locked one stays resolvable", async () => {
    const provider = uniqueProvider("sync-change");
    const svc = service({
      listCatalogEntries: () =>
        Promise.resolve([catalogEntry(provider, { prompt: "0.5" })]),
    });
    await svc.syncFromCatalog();
    const second = await service({
      listCatalogEntries: () =>
        Promise.resolve([catalogEntry(provider, { prompt: "0.75" })]),
      readRateVersion: () => Promise.resolve(10),
    }).syncFromCatalog();
    expect(second).toMatchObject({ status: "ok", appended: 1 });
    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest?.snapshotVersion).toBe(2);
    expect(latest?.dims.input).toEqual({ status: "known", amount: "0.75" });
    expect(latest?.rateVersion).toBe(10);
    const locked = await store.priceSnapshot(ref(provider), 1);
    expect(locked?.dims.input).toEqual({ status: "known", amount: "0.5" });
    expect(locked?.rateVersion).toBe(9);
  });

  test("a catalog that cannot be read fails the sync with a fixed code and keeps every version", async () => {
    const provider = uniqueProvider("sync-catalog");
    await service({
      listCatalogEntries: () =>
        Promise.resolve([catalogEntry(provider, { prompt: "0.5" })]),
    }).syncFromCatalog();
    const outcome = await service({
      listCatalogEntries: () => Promise.reject(new Error("database gone")),
    }).syncFromCatalog();
    expect(outcome).toMatchObject({
      status: "failed",
      reasonCode: "price_sync_catalog_unavailable",
    });
    expect((await store.latestPriceSnapshot(ref(provider)))?.snapshotVersion).toBe(1);
  });

  test("a broken rate state fails the sync with its own code — never a guessed zero", async () => {
    const outcome = await service({
      readRateVersion: () => Promise.reject(new Error("pointer row tampered")),
    }).syncFromCatalog();
    expect(outcome).toMatchObject({
      status: "failed",
      reasonCode: "price_sync_rate_unavailable",
    });
  });

  test("a persist failure is an outcome, not a throw — the previous versions stand", async () => {
    const outcome = await service({
      store: {
        appendSnapshots: () => Promise.reject(new Error("disk full")),
        latestPriceSnapshot: () => Promise.resolve(undefined),
        priceSnapshot: () => Promise.resolve(undefined),
        listLatestPriceSnapshots: () => Promise.resolve([]),
      },
    }).syncFromCatalog();
    expect(outcome).toMatchObject({
      status: "failed",
      reasonCode: "price_sync_persist_failed",
    });
  });

  test("a sync over an empty catalog succeeds and appends nothing", async () => {
    const outcome = await service({
      listCatalogEntries: () => Promise.resolve([]),
    }).syncFromCatalog();
    expect(outcome).toMatchObject({
      status: "ok",
      mappedRefs: 0,
      appended: 0,
      skipped: 0,
    });
  });

  test("end to end over 03.1's own store: fetch, list, map, append — the raw bytes price the model", async () => {
    const { createEnterpriseGatewayCatalogStore, GATEWAY_CATALOG_SOURCE } =
      await import("../src/gateway/catalog");
    const { gatewayModelCatalogRefs } = await import("../src/db/schema");
    const provider = uniqueProvider("e2e");
    const catalogStore = createEnterpriseGatewayCatalogStore(database);
    const rawPricing = {
      prompt: "0.0000025000",
      completion: "0.0000100000",
      request: "0.0",
      input_cache_read: "0.0000012500",
    };
    await catalogStore.replaceCatalog({
      entries: [
        {
          ref: { provider, model: "gpt-4o", capability: "chat" },
          capabilitySource: "supported_methods",
          rawEntry: {
            id: `${provider}/gpt-4o`,
            supported_methods: ["chat"],
            pricing: rawPricing,
          },
        },
      ],
      record: {
        fetchedAt: "2026-10-17T04:00:00.000Z",
        source: GATEWAY_CATALOG_SOURCE,
        rawItemCount: 1,
        configVersion: 7,
      },
    });

    const svc = createGatewayPriceSnapshotService({
      listCatalogEntries: () => catalogStore.readCatalogRefs(),
      store,
      readRateVersion: () => Promise.resolve(3),
    });
    const outcome = await svc.syncFromCatalog();
    expect(outcome).toMatchObject({ status: "ok", appended: 1 });

    const latest = await store.latestPriceSnapshot({
      provider,
      model: "gpt-4o",
      capability: "chat",
    });
    // The exact bytes the catalog kept price the model — canonicalized, not re-interpreted.
    expect(latest?.dims.input).toEqual({ status: "known", amount: "0.0000025" });
    expect(latest?.dims.output).toEqual({ status: "known", amount: "0.00001" });
    expect(latest?.dims.surcharge_per_request).toEqual({
      status: "known",
      amount: "0",
    });
    expect(latest?.dims.cache_read).toEqual({
      status: "known",
      amount: "0.00000125",
    });
    // And the catalog table the sync read from is left exactly as 03.1 wrote it.
    expect(await database.select().from(gatewayModelCatalogRefs)).toHaveLength(1);
  });
});

describe("history is append-only in the database, not merely in the application", () => {
  test("UPDATE on a recorded snapshot is refused", async () => {
    const provider = uniqueProvider("immutable-update");
    await store.appendSnapshots([
      appendInput(ref(provider), fullyPricedDims()),
    ]);
    await expectAppendOnlyRefusal(
      sql`UPDATE gateway_price_snapshots SET dims = '{"input":{"status":"known","amount":"0"}}'::jsonb WHERE provider = ${provider}`,
    );
  });

  test("DELETE on a recorded snapshot is refused", async () => {
    const provider = uniqueProvider("immutable-delete");
    await store.appendSnapshots([
      appendInput(ref(provider), fullyPricedDims()),
    ]);
    await expectAppendOnlyRefusal(
      sql`DELETE FROM gateway_price_snapshots WHERE provider = ${provider}`,
    );
  });

  test("TRUNCATE is refused too — a row-level trigger cannot see it, the statement trigger can", async () => {
    await expectAppendOnlyRefusal(sql`TRUNCATE gateway_price_snapshots`);
  });
});
