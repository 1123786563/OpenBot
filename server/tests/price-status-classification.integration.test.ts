import { afterAll, describe, expect, test } from "../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  mapPriceDims,
  type PriceSnapshotAppendInput,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import type { ModelRef } from "../src/gateway/catalog";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost 03.3 — the known/free/unknown classification, persisted, on a real
 * PostgreSQL on TEST_DATABASE_URL (tests/support/database.ts refuses the live
 * database).
 *
 * What only this file can prove: the classification a snapshot carries is the
 * classification its own dims classify to (the database CHECK
 * `classify_gateway_price_status` refuses anything else, so a stored status
 * can never drift from its price basis), `free` and `unknown` are distinct
 * persisted states — an all-zero snapshot is free, an all-zero-but-one-
 * unpriced snapshot is unknown, never a zero cost — and the classification is
 * bound to the snapshot version: a price change re-classifies the new version
 * while the old version keeps its own status, and the latest view never shows
 * a stale classification.
 *
 * The table cannot be truncated by the tests either — it is append-only — so
 * every test isolates itself with unique provider names instead of cleaning
 * up.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createEnterpriseGatewayPriceSnapshotStore(database);

afterAll(async () => {
  await database.$client.close();
});

/** A provider name no other test (this run or any earlier run) has used. */
function uniqueProvider(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function ref(
  provider: string,
  model = "gpt-4o",
  capability = "chat",
): ModelRef {
  return { provider, model, capability };
}

function allZeroPricedDims(): PriceSnapshotDims {
  return mapPriceDims({
    id: "openai/oss-20b",
    pricing: {
      prompt: "0.0",
      completion: "0.0",
      request: "0.0",
      image: "0.0",
      web_search: "0.0",
      internal_reasoning: "0.0",
      input_cache_read: "0.0",
      input_cache_write: "0.0",
    },
  });
}

function inputUnpricedDims(): PriceSnapshotDims {
  return mapPriceDims({
    id: "openai/gpt-4o",
    pricing: {
      completion: "0.0",
      request: "0.0",
      image: "0.0",
      web_search: "0.0",
      internal_reasoning: "0.0",
      input_cache_read: "0.0",
      input_cache_write: "0.0",
    },
  });
}

function appendInput(
  modelRef: ModelRef,
  dims: PriceSnapshotDims,
): PriceSnapshotAppendInput {
  return {
    ref: modelRef,
    dims,
    fetchedAt: "2026-10-17T00:00:00.000Z",
    source: "gateway:/v1/models",
    configVersion: 7,
    rateVersion: 5,
  };
}

/** A raw statement as a real promise (drizzle's execute answers a thenable). */
function rawExec(
  query: Parameters<typeof database.execute>[0],
): Promise<unknown> {
  return (async () => database.execute(query))();
}

/** Assert one raw statement is refused by a named-layer check, and say which. */
async function expectRefusal(
  query: Parameters<typeof database.execute>[0],
  pattern: RegExp,
) {
  const error = await rawExec(query).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeDefined();
  const cause = (error as { cause?: { message?: string } }).cause;
  expect(cause?.message ?? String(error)).toMatch(pattern);
}

/** A valid dims jsonb literal for hand-built INSERT statements. */
function dimsLiteral(dims: PriceSnapshotDims) {
  // The jsonb rides as text with an explicit cast (see the store's insert);
  // these fixtures carry only [a-z_] codes, so the literal needs no quoting.
  return sql`${JSON.stringify(dims)}::text::jsonb`;
}

describe("persisting the classification", () => {
  test("an all-zero snapshot persists as free — a price state, with no other fields", async () => {
    const provider = uniqueProvider("free");
    const result = await store.appendSnapshots([
      appendInput(ref(provider), allZeroPricedDims()),
    ]);
    expect(result).toEqual({ appended: 1, skipped: 0 });

    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest?.snapshotVersion).toBe(1);
    expect(latest?.classification).toEqual({ status: "free" });
  });

  test("a snapshot with an unpriced necessary dimension persists as unknown with its reasons", async () => {
    const provider = uniqueProvider("unknown");
    await store.appendSnapshots([
      appendInput(ref(provider), inputUnpricedDims()),
    ]);

    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest?.classification).toEqual({
      status: "unknown",
      reasonCode: "price_status_dims_missing",
      missingDimensions: [
        { dimension: "input", reason: "price_dim_no_source" },
      ],
    });
  });

  test("all-zero pricing plus one unpriced dimension is unknown, never a persisted zero cost", async () => {
    const provider = uniqueProvider("zero-but-unknown");
    const dims = allZeroPricedDims();
    dims.input = { status: "unknown", reason: "price_dim_no_source" };
    await store.appendSnapshots([appendInput(ref(provider), dims)]);

    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest?.classification.status).toBe("unknown");
    expect(latest?.classification.status).not.toBe("free");
  });
});

describe("re-classifying across snapshot versions", () => {
  test("a price change re-classifies the new version; the old version keeps its own status", async () => {
    const provider = uniqueProvider("reclassify");
    await store.appendSnapshots([
      appendInput(ref(provider), allZeroPricedDims()),
    ]);

    const changed = allZeroPricedDims();
    changed.input = { status: "known", amount: "0.0000025" };
    const second = await store.appendSnapshots([
      appendInput(ref(provider), changed),
    ]);
    expect(second).toEqual({ appended: 1, skipped: 0 });

    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest?.snapshotVersion).toBe(2);
    expect(latest?.classification).toEqual({ status: "known" });

    // The version a request locked stays exactly what it was — the free price
    // basis of version 1 is still free, forever resolvable.
    const locked = await store.priceSnapshot(ref(provider), 1);
    expect(locked?.snapshotVersion).toBe(1);
    expect(locked?.classification).toEqual({ status: "free" });
  });

  test("the latest view never shows a stale classification", async () => {
    const provider = uniqueProvider("latest-view");
    await store.appendSnapshots([
      appendInput(ref(provider), inputUnpricedDims()),
    ]);

    const changed = inputUnpricedDims();
    changed.input = { status: "known", amount: "0.0000025" };
    await store.appendSnapshots([appendInput(ref(provider), changed)]);

    const all = await store.listLatestPriceSnapshots();
    const mine = all.filter((snapshot) => snapshot.ref.provider === provider);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.snapshotVersion).toBe(2);
    expect(mine[0]?.classification).toEqual({ status: "known" });
    expect(mine[0]?.classification.status).not.toBe("unknown");
  });
});

describe("the database refuses a classification that is not the dims' own", () => {
  test("a hand-inserted known status over unpriced dims is refused", async () => {
    const provider = uniqueProvider("tamper-known");
    await expectRefusal(
      sql`insert into gateway_price_snapshots (provider, model, capability, snapshot_version, dims, price_status, price_status_reason, price_status_missing_dims, source, config_version, rate_version, fetched_at)
          values (${provider}, 'gpt-4o', 'chat', 1, ${dimsLiteral(inputUnpricedDims())}, 'known', null, null, 'gateway:/v1/models', 7, 5, now())`,
      /status_matches_dims/,
    );
  });

  test("a hand-inserted free status carrying unknown details is refused", async () => {
    const provider = uniqueProvider("tamper-free");
    await expectRefusal(
      sql`insert into gateway_price_snapshots (provider, model, capability, snapshot_version, dims, price_status, price_status_reason, price_status_missing_dims, source, config_version, rate_version, fetched_at)
          values (${provider}, 'gpt-4o', 'chat', 1, ${dimsLiteral(allZeroPricedDims())}, 'free', 'price_status_dims_missing', '[]'::text::jsonb, 'gateway:/v1/models', 7, 5, now())`,
      /status_details_consistent/,
    );
  });

  test("an unknown status without its reason is refused", async () => {
    const provider = uniqueProvider("tamper-noreason");
    await expectRefusal(
      sql`insert into gateway_price_snapshots (provider, model, capability, snapshot_version, dims, price_status, price_status_reason, price_status_missing_dims, source, config_version, rate_version, fetched_at)
          values (${provider}, 'gpt-4o', 'chat', 1, ${dimsLiteral(inputUnpricedDims())}, 'unknown', null, ${JSON.stringify(
            [{ dimension: "input", reason: "price_dim_no_source" }],
          )}::text::jsonb, 'gateway:/v1/models', 7, 5, now())`,
      /status_details_consistent/,
    );
  });

  test("a status outside the closed set is refused", async () => {
    const provider = uniqueProvider("tamper-bogus");
    await expectRefusal(
      sql`insert into gateway_price_snapshots (provider, model, capability, snapshot_version, dims, price_status, price_status_reason, price_status_missing_dims, source, config_version, rate_version, fetched_at)
          values (${provider}, 'gpt-4o', 'chat', 1, ${dimsLiteral(allZeroPricedDims())}, 'cheap', null, null, 'gateway:/v1/models', 7, 5, now())`,
      /status_allowed/,
    );
  });

  test("an unknown status with an empty missing-dimension list is refused", async () => {
    const provider = uniqueProvider("tamper-empty");
    await expectRefusal(
      sql`insert into gateway_price_snapshots (provider, model, capability, snapshot_version, dims, price_status, price_status_reason, price_status_missing_dims, source, config_version, rate_version, fetched_at)
          values (${provider}, 'gpt-4o', 'chat', 1, ${dimsLiteral(inputUnpricedDims())}, 'unknown', 'price_status_dims_missing', '[]'::text::jsonb, 'gateway:/v1/models', 7, 5, now())`,
      /status_missing_dims_valid/,
    );
  });

  test("a missing-dimension entry outside the fixed vocabularies is refused", async () => {
    const provider = uniqueProvider("tamper-bogus-entry");
    await expectRefusal(
      sql`insert into gateway_price_snapshots (provider, model, capability, snapshot_version, dims, price_status, price_status_reason, price_status_missing_dims, source, config_version, rate_version, fetched_at)
          values (${provider}, 'gpt-4o', 'chat', 1, ${dimsLiteral(inputUnpricedDims())}, 'unknown', 'price_status_dims_missing', ${JSON.stringify(
            [{ dimension: "not_a_dim", reason: "price_dim_no_source" }],
          )}::text::jsonb, 'gateway:/v1/models', 7, 5, now())`,
      /status_missing_dims_valid/,
    );
  });

  test("an exactly-app-shaped unknown row is accepted — the constraints refuse only defects", async () => {
    const provider = uniqueProvider("hand-unknown");
    await rawExec(
      sql`insert into gateway_price_snapshots (provider, model, capability, snapshot_version, dims, price_status, price_status_reason, price_status_missing_dims, source, config_version, rate_version, fetched_at)
          values (${provider}, 'gpt-4o', 'chat', 1, ${dimsLiteral(inputUnpricedDims())}, 'unknown', 'price_status_dims_missing', ${JSON.stringify(
            [{ dimension: "input", reason: "price_dim_no_source" }],
          )}::text::jsonb, 'gateway:/v1/models', 7, 5, now())`,
    );
    const latest = await store.latestPriceSnapshot(ref(provider));
    expect(latest?.classification).toEqual({
      status: "unknown",
      reasonCode: "price_status_dims_missing",
      missingDimensions: [
        { dimension: "input", reason: "price_dim_no_source" },
      ],
    });
  });
});

describe("the classification is as immutable as the price basis", () => {
  test("rewriting a recorded status in place is refused by the append-only rule", async () => {
    const provider = uniqueProvider("immutable");
    await store.appendSnapshots([
      appendInput(ref(provider), allZeroPricedDims()),
    ]);
    await expectRefusal(
      sql`update gateway_price_snapshots set price_status = 'known' where provider = ${provider}`,
      /append-only/,
    );
  });
});
