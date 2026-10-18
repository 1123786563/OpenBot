import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import {
  DEFAULT_CATALOG_FRESHNESS_WINDOW_MS,
  BIFROST_CATALOG_FRESHNESS_WINDOW_MS_VARIABLE,
  assertCatalogFresh,
  catalogFreshnessWindowConfig,
  createCatalogFreshnessGate,
  evaluateCatalogFreshness,
} from "../src/gateway/catalog-freshness";
import { modelRefKey } from "../src/gateway/catalog";
import {
  GATEWAY_CATALOG_SYNC_STATE_ID,
  createEnterpriseGatewayCatalogSyncStore,
} from "../src/gateway/catalog-sync";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
  mapPriceDims,
} from "../src/gateway/price-snapshot";
import {
  createCreditReserveService,
  type CreditReserveRequest,
} from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
  payerAccounts,
} from "../src/db/schema";
import { creditReservations } from "../src/db/schema/credit-reservations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost 03.6 (#228): the catalog freshness gate, on a real PostgreSQL
 * (TEST_DATABASE_URL; the dedicated 5590 verify database, never the live one).
 *
 * The gate's semantics, at three controlled-clock points and past them:
 *   - inside the window (14 min) new requests are admitted;
 *   - exactly at the cap (15 min) the catalog is still fresh (the refusal is a
 *     strict `>`);
 *   - past the cap (16 min) new requests refuse as `catalog_stale` — the reason
 *     names freshness, NEVER model-not-found (the model is open and priced;
 *     what expired is the evidence both stand on);
 *   - never-synced refuses as `catalog_never_synced`.
 * Adjusting the window applies to NEW requests immediately. Existing
 * reservations settle on the basis they locked at admission (snapshotVersion +
 * rateVersion) and are never repriced; a recovery sync releases new requests
 * with no restart.
 *
 * The clock is injectable end to end: every scenario seeds the sync state at a
 * FIXED T0 and drives the service with `now: () => atMinute(n)`, so the
 * 14/15/16-minute points are exact, not a race against Date.now().
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b5-228-${randomUUID().slice(0, 8)}`;
const fixtureCreditWriter = createCreditWriter(database);

/**
 * The fixed instant every scenario's clock is anchored to. One minute past the
 * REAL clock: the freshness math is entirely T0-relative (seeded sync time and
 * injected `now` both derive from T0, so the 14/15/16-minute points are exact,
 * not a race against Date.now()), while hold expiries — which the credit writer
 * validates against the real clock — stay future-dated for the whole run.
 */
const T0 = new Date(Date.now() + 60_000);
/** `T0 + n minutes` — the controlled clock's whole vocabulary. */
const atMinute = (minutes: number): Date =>
  new Date(T0.getTime() + minutes * 60 * 1000);

const FRESH_WINDOW_MS = DEFAULT_CATALOG_FRESHNESS_WINDOW_MS; // 15 minutes

const PRICED_RAW_ENTRY = {
  id: "fix/model",
  pricing: {
    prompt: "0.000001",
    completion: "0.000002",
    internal_reasoning: "0.000003",
    image: "0.01",
    input_cache_read: "0.0000001",
    input_cache_write: "0.0000015",
    web_search: "0.001",
    request: "0",
  },
};

/** A differently-priced v2 for the same ref: repricing bait the gate must never take. */
const V2_RAW_ENTRY = {
  id: "fix/model",
  pricing: Object.fromEntries(
    Object.entries(PRICED_RAW_ENTRY.pricing).map(([key]) => [
      key,
      key === "prompt" ? "9.999999" : "0.000002",
    ]),
  ),
};

type SeedOptions = {
  /** Seed the sync state at T0 (default); `false` leaves the deployment never-synced. */
  syncedAtT0?: boolean;
};

type SeededWorld = {
  userId: string;
  grantId: string;
  provider: string;
  model: string;
  customerKey: string;
  /** A valid request at the world's locked basis (v1). */
  request: CreditReserveRequest;
};

let seedCounter = 0;

/**
 * One complete world where a reserve SHOULD succeed: active grant + bot, a funded
 * personal payer account, an open cataloged ref with TWO price snapshots (v1 priced
 * normally, v2 repriced), and the sync state at exactly T0.
 */
async function seedWorld(options: SeedOptions = {}): Promise<SeededWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Freshness Bot ${n}`,
    kind: "external",
    capabilities: ["chat"],
    status: "active",
  });
  await database.insert(accessGrants).values({
    grantId,
    userId,
    botId,
    externalIdentity: `${prefix}:ext:${n}`,
    scope: "model-access",
    status: "active",
    revokedAt: null,
  });

  const { account } = await createPayerAccount(database, {
    kind: "personal",
    id: userId,
  });
  await fixtureCreditWriter.grantCredits({
    externalCustomerId: account.externalCustomerId,
    source: "plan",
    totalCents: 10_000_00,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-seed-grant-${n}`,
  });

  await database.insert(gatewayModelCatalogRefs).values({
    provider,
    model,
    capability: "chat",
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}` },
    configVersion: 1,
    fetchedAt: new Date(),
  });
  const store = createEnterpriseGatewayPriceSnapshotStore(database);
  await store.appendSnapshots([
    {
      ref: { provider, model, capability: "chat" },
      dims: mapPriceDims(PRICED_RAW_ENTRY),
      fetchedAt: T0.toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: null,
    },
  ]);
  // v2: the "catalog moved on" bait — a later, pricier snapshot the locked
  // reservation must never be repriced against.
  await store.appendSnapshots([
    {
      ref: { provider, model, capability: "chat" },
      dims: mapPriceDims(V2_RAW_ENTRY),
      fetchedAt: T0.toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 2,
      rateVersion: null,
    },
  ]);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "chat",
    state: "open",
    reason: "catalog-freshness-gate fixture",
    changedBy: "test",
  });

  // The freshness fact under test: the deployment's last fully successful sync,
  // pinned at exactly T0 (or absent, for the never-synced scenario).
  if (options.syncedAtT0 ?? true) {
    await database
      .insert(gatewayCatalogSyncState)
      .values({ id: GATEWAY_CATALOG_SYNC_STATE_ID, lastSuccessfulSyncAt: T0 })
      .onConflictDoUpdate({
        target: gatewayCatalogSyncState.id,
        set: { lastSuccessfulSyncAt: T0 },
      });
  } else {
    await database
      .delete(gatewayCatalogSyncState)
      .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID));
  }

  const request: CreditReserveRequest = {
    grantId,
    payer: { kind: "personal", id: userId },
    model: { provider, model, capability: "chat" },
    snapshotVersion: 1,
    rateVersion: 0,
    boundEvidence: [
      { kind: "provider_max_tokens", maximumTokens: 4096 },
      { kind: "self_enforced_input_truncation", maximumTokens: 8192 },
    ],
    maximumCredits: 500,
    idempotencyKey: `${prefix}-idem-${n}`,
  };
  return {
    userId,
    grantId,
    provider,
    model,
    customerKey: payerKey({ kind: "personal", id: userId }),
    request,
  };
}

/** The service under test with the controlled clock injected. */
function gateService(clockMinute: number, windowMs = FRESH_WINDOW_MS) {
  return createCreditReserveService({
    database,
    now: () => atMinute(clockMinute),
    catalogFreshnessWindowMs: windowMs,
  });
}

/** The reservation rows that exist for a world's customer. */
async function reservationRows(customerKey: string) {
  return database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, customerKey));
}

const whole = (n: number): { numerator: bigint; denominator: bigint } => ({
  numerator: BigInt(n),
  denominator: 1n,
});

afterAll(async () => {
  // Credit-side rows are keyed by the DERIVED account key (`openbot-personal-<prefix>…`,
  // the reserve-revalidation suite's lesson): every credit-side cleanup uses the
  // derived-key prefix; everything else cleans by its own prefix. The singleton sync
  // state row goes too — every suite owns the state it wrote.
  await database
    .delete(creditReservations)
    .where(
      like(
        creditReservations.externalCustomerId,
        `openbot-personal-${prefix}%`,
      ),
    );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database
    .delete(payerAccounts)
    .where(like(payerAccounts.payerId, `${prefix}%`));
  await database
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database
    .delete(gatewayModelOpenScopes)
    .where(like(gatewayModelOpenScopes.provider, `${prefix}%`));
  await database
    .delete(gatewayModelCatalogRefs)
    .where(like(gatewayModelCatalogRefs.provider, `${prefix}%`));
  await database
    .delete(gatewayCatalogSyncState)
    .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID));
  // gateway_price_snapshots is append-only (0133): never deleted; every scenario
  // isolates itself with its own unique provider name instead.
  await database.$client.close();
});

describe("the pure freshness verdict (controlled clock, no database)", () => {
  test("14 minutes inside the default 15-minute window is fresh", () => {
    const verdict = evaluateCatalogFreshness({
      lastSuccessfulSyncAt: T0,
      now: atMinute(14),
      windowMs: FRESH_WINDOW_MS,
    });
    expect(verdict.fresh).toBe(true);
    if (verdict.fresh) {
      expect(verdict.ageMs).toBe(14 * 60 * 1000);
      expect(verdict.windowMs).toBe(FRESH_WINDOW_MS);
    }
  });

  test("exactly 15 minutes is still fresh — the refusal is a strict >", () => {
    const verdict = evaluateCatalogFreshness({
      lastSuccessfulSyncAt: T0,
      now: atMinute(15),
      windowMs: FRESH_WINDOW_MS,
    });
    expect(verdict.fresh).toBe(true);
  });

  test("15 minutes + 1ms is stale", () => {
    const verdict = evaluateCatalogFreshness({
      lastSuccessfulSyncAt: T0,
      now: new Date(T0.getTime() + FRESH_WINDOW_MS + 1),
      windowMs: FRESH_WINDOW_MS,
    });
    expect(verdict.fresh).toBe(false);
    if (!verdict.fresh) {
      expect(verdict.reasonCode).toBe("catalog_stale");
      expect(verdict.detail.freshnessWindowMs).toBe(FRESH_WINDOW_MS);
    }
  });

  test("16 minutes is stale, carrying the freshness facts", () => {
    const verdict = evaluateCatalogFreshness({
      lastSuccessfulSyncAt: T0,
      now: atMinute(16),
      windowMs: FRESH_WINDOW_MS,
    });
    expect(verdict.fresh).toBe(false);
    if (!verdict.fresh) {
      expect(verdict.reasonCode).toBe("catalog_stale");
      expect(verdict.detail.lastSuccessfulSyncAt).toBe(T0.toISOString());
      expect(verdict.detail.ageMs).toBe(16 * 60 * 1000);
    }
  });

  test("never synced refuses as catalog_never_synced, not stale", () => {
    const verdict = evaluateCatalogFreshness({
      lastSuccessfulSyncAt: null,
      now: atMinute(0),
      windowMs: FRESH_WINDOW_MS,
    });
    expect(verdict.fresh).toBe(false);
    if (!verdict.fresh) {
      expect(verdict.reasonCode).toBe("catalog_never_synced");
    }
  });
});

describe("the freshness window configuration", () => {
  test("unset or empty answers the default 15 minutes", () => {
    expect(
      catalogFreshnessWindowConfig({ [BIFROST_CATALOG_FRESHNESS_WINDOW_MS_VARIABLE]: undefined }),
    ).toBe(15 * 60 * 1000);
    expect(catalogFreshnessWindowConfig({})).toBe(DEFAULT_CATALOG_FRESHNESS_WINDOW_MS);
    expect(
      catalogFreshnessWindowConfig({ [BIFROST_CATALOG_FRESHNESS_WINDOW_MS_VARIABLE]: "  " }),
    ).toBe(DEFAULT_CATALOG_FRESHNESS_WINDOW_MS);
  });

  test("a deployment's own cap parses through", () => {
    expect(
      catalogFreshnessWindowConfig({ [BIFROST_CATALOG_FRESHNESS_WINDOW_MS_VARIABLE]: "1800000" }),
    ).toBe(30 * 60 * 1000);
  });

  test("an invalid cap stops the caller with the variable named", () => {
    for (const bad of ["0", "-5", "1.5", "fifteen"]) {
      expect(() =>
        catalogFreshnessWindowConfig({
          [BIFROST_CATALOG_FRESHNESS_WINDOW_MS_VARIABLE]: bad,
        }),
      ).toThrow(BIFROST_CATALOG_FRESHNESS_WINDOW_MS_VARIABLE);
    }
  });
});

describe("the gate over the database", () => {
  test("stale verdict names the affected model ref, never model-not-found", async () => {
    const world = await seedWorld();
    const verdict = await assertCatalogFresh(database, {
      modelRef: { provider: world.provider, model: world.model, capability: "chat" },
      now: atMinute(16),
      windowMs: FRESH_WINDOW_MS,
    });
    expect(verdict.fresh).toBe(false);
    if (!verdict.fresh) {
      expect(verdict.reasonCode).toBe("catalog_stale");
      expect(verdict.reasonCode).not.toBe("model_not_open");
      expect(verdict.detail.modelRef).toBe(
        modelRefKey({ provider: world.provider, model: world.model, capability: "chat" }),
      );
    }
  });

  test("fresh verdict after a recovery sync, same gate instance", async () => {
    const world = await seedWorld();
    const syncStore = createEnterpriseGatewayCatalogSyncStore(database);
    await syncStore.recordSyncSuccess({ syncedAt: atMinute(17).toISOString() });
    const verdict = await assertCatalogFresh(database, {
      modelRef: { provider: world.provider, model: world.model, capability: "chat" },
      now: atMinute(18),
      windowMs: FRESH_WINDOW_MS,
    });
    expect(verdict.fresh).toBe(true);
    if (verdict.fresh) {
      expect(verdict.lastSuccessfulSyncAt).toBe(atMinute(17).toISOString());
    }
  });

  test("never synced refuses as catalog_never_synced", async () => {
    await seedWorld({ syncedAtT0: false });
    const verdict = await assertCatalogFresh(database, {
      modelRef: { provider: "p", model: "m", capability: "chat" },
      now: atMinute(0),
      windowMs: FRESH_WINDOW_MS,
    });
    expect(verdict.fresh).toBe(false);
    if (!verdict.fresh) {
      expect(verdict.reasonCode).toBe("catalog_never_synced");
    }
  });

  test("the factory's isCatalogFresh seam answers a boolean with the injected clock", async () => {
    const world = await seedWorld();
    const gate = createCatalogFreshnessGate({
      database,
      windowMs: FRESH_WINDOW_MS,
      now: () => atMinute(16),
    });
    const ref = { provider: world.provider, model: world.model, capability: "chat" };
    expect(await gate.isCatalogFresh(ref)).toBe(false);
    await createEnterpriseGatewayCatalogSyncStore(database).recordSyncSuccess({
      syncedAt: atMinute(17).toISOString(),
    });
    expect(await gate.isCatalogFresh(ref)).toBe(true);
  });
});

describe("admission under the controlled clock (reserve service integration)", () => {
  test("14 minutes: a new request is admitted", async () => {
    const world = await seedWorld();
    const outcome = await gateService(14).reserve(world.request);
    expect(outcome.status).toBe("reserved");
    if (outcome.status === "reserved") {
      expect(outcome.snapshotVersion).toBe(1);
      expect(outcome.rateVersion).toBe(0);
    }
  });

  test("exactly 15 minutes: still admitted", async () => {
    const world = await seedWorld();
    const outcome = await gateService(15).reserve(world.request);
    expect(outcome.status).toBe("reserved");
  });

  test("16 minutes: refused as catalog_stale while scope stays open and ref cataloged", async () => {
    const world = await seedWorld();
    const before = await reservationRows(world.customerKey);
    const outcome = await gateService(16).reserve(world.request);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.reasonCode).toBe("catalog_stale");
      // The trap the resume hint names: the model IS open and priced — the reason
      // must say the PRICES expired, never that the model is gone.
      expect(outcome.reasonCode).not.toBe("model_not_open");
      expect(outcome.reasonCode).not.toBe("price_basis_not_found");
      expect(outcome.detail.modelRef).toBe(
        modelRefKey({ provider: world.provider, model: world.model, capability: "chat" }),
      );
    }
    expect((await reservationRows(world.customerKey)).length).toBe(before.length);
  });

  test("a widened window applies to new requests immediately", async () => {
    const world = await seedWorld();
    // Same world, same clock instant: the deployment raised its cap to 30 minutes;
    // the very next request is judged by the new cap — no restart, no state change.
    const outcome = await gateService(16, 30 * 60 * 1000).reserve(world.request);
    expect(outcome.status).toBe("reserved");
  });

  test("never synced refuses admission as catalog_never_synced", async () => {
    const world = await seedWorld({ syncedAtT0: false });
    const outcome = await gateService(0).reserve(world.request);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.reasonCode).toBe("catalog_never_synced");
    }
  });
});

describe("existing reservations are never repriced", () => {
  test("a reservation locked fresh settles on its locked basis while the catalog is stale", async () => {
    const world = await seedWorld();
    const reserved = await gateService(1).reserve(world.request);
    if (reserved.status !== "reserved") throw new Error("fixture reserve failed");
    // The admission locked THIS basis — the outcome carries it, and settlement
    // below consumes exactly it.
    expect(reserved.snapshotVersion).toBe(1);
    expect(reserved.rateVersion).toBe(0);

    // The catalog goes stale and v2 (pricier) is already its latest snapshot.
    const stale = await gateService(16).reserve({
      ...world.request,
      snapshotVersion: 2,
      idempotencyKey: `${prefix}-idem-v2-attempt`,
    });
    expect(stale.status).toBe("refused");
    if (stale.status === "refused") {
      // v2 EXISTS — the refusal says freshness, not a missing basis.
      expect(stale.reasonCode).toBe("catalog_stale");
    }
    const rows = await reservationRows(world.customerKey);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("reserved");

    // Settlement of the held reservation runs on the caller's locked-basis math
    // (v1's prices) and succeeds WHILE the catalog is stale: the settle path
    // consults neither the freshness gate nor the latest snapshot.
    const writer = createCreditWriter(database);
    const settled = await writer.settleReservation({
      reservationId: reserved.reservationId,
      actual: whole(350), // the cost v1's exact prices produced upstream
      title: "模型调用",
    });
    expect(settled.chargedCents).toBe(350);
    const [row] = await reservationRows(world.customerKey);
    expect(row?.status).toBe("settled");
    expect(row?.charged).toBe(350);
  });

  test("after a recovery sync the locked v1 basis is admitted again — never pushed to latest", async () => {
    const world = await seedWorld();
    const reserved = await gateService(1).reserve(world.request);
    if (reserved.status !== "reserved") throw new Error("fixture reserve failed");
    expect(reserved.snapshotVersion).toBe(1);

    const syncStore = createEnterpriseGatewayCatalogSyncStore(database);
    await syncStore.recordSyncSuccess({ syncedAt: atMinute(17).toISOString() });
    // The SAME service instance (same window config, no restart), a NEW request
    // still naming the OLD locked basis v1: admitted — recovery releases new
    // requests, and v2 being latest never forced a re-lock.
    const outcome = await gateService(18).reserve({
      ...world.request,
      idempotencyKey: `${prefix}-idem-after-recovery`,
    });
    expect(outcome.status).toBe("reserved");
    if (outcome.status === "reserved") {
      expect(outcome.snapshotVersion).toBe(1);
      expect(outcome.rateVersion).toBe(0);
    }
  });

  test("a stale catalog never blocks settlement of an existing reservation", async () => {
    const world = await seedWorld();
    const reserved = await gateService(1).reserve(world.request);
    if (reserved.status !== "reserved") throw new Error("fixture reserve failed");

    // Stale the catalog deliberately, then release the hold: recovery-adjacent
    // paths work on stale state, and the gate only ever gates ADMISSION.
    await database
      .delete(gatewayCatalogSyncState)
      .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID));
    const writer = createCreditWriter(database);
    await writer.releaseReservation(reserved.reservationId, "test cleanup");
    const [row] = await reservationRows(world.customerKey);
    expect(row?.status).toBe("released");
  });
});

describe("sync recovery releases new requests without a restart", () => {
  test("refused at 16 minutes, admitted after a successful sync — the SAME service instance", async () => {
    const world = await seedWorld();
    // The instance's clock is pinned at minute 16: every process-level fact (window,
    // wiring, clock) stays exactly as it was across the whole test.
    const service = gateService(16);
    const stale = await service.reserve(world.request);
    expect(stale.status).toBe("refused");
    if (stale.status === "refused") {
      expect(stale.reasonCode).toBe("catalog_stale");
    }

    // The 03.4 scheduler recovers on its own cadence: one recordSyncSuccess, no
    // process restart, no configuration change.
    await createEnterpriseGatewayCatalogSyncStore(database).recordSyncSuccess({
      syncedAt: atMinute(17).toISOString(),
    });

    // The SAME instance now admits the next request: its clock still reads minute
    // 16, the sync time moved past it, and only the freshness fact changed.
    const admitted = await service.reserve({
      ...world.request,
      idempotencyKey: `${prefix}-idem-recovered`,
    });
    expect(admitted.status).toBe("reserved");
  });
});
