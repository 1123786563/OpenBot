import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import {
  computeReservationCeiling,
  lockedBasisOfReservation,
  resolveLockedReservationBasis,
  type ReservationBoundQuantities,
  type ReservationLockedBasis,
} from "../src/billing/reserve-bound";
import {
  createCreditReserveService,
  type CreditReserveRequest,
} from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import { createConversionRateStore } from "../src/gateway/conversion-rate-store";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
} from "../src/gateway/price-snapshot";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
  payerAccounts,
} from "../src/db/schema";
import {
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #256 (06.5): the version lock, on a real PostgreSQL (TEST_DATABASE_URL; the
 * dedicated 5590 verify database, never the live one).
 *
 * A reservation records the pricing basis it was admitted against — the model ref, the
 * snapshotVersion and the rateVersion — and settlement resolves that recorded combination,
 * never the latest one. The proof below reserves against version 1 of both, then CHANGES the
 * world (a version-2 price snapshot with different prices; an administrator's rate save), and
 * shows: the lock still resolves the original basis; the ceiling over the locked basis still
 * equals the ceiling that was admitted; and the hold settles at the exact amount the locked
 * basis prices the actual usage — with the latest basis demonstrably different the whole time.
 *
 * Isolation mirrors #253/#254: unique provider/bot/user prefixes per world (price snapshots
 * are append-only), credit/payer/grant fixtures deleted by the DERIVED account-key prefix in
 * afterAll.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b5-256-${randomUUID().slice(0, 8)}`;
const fixtureCreditWriter = createCreditWriter(database);

/** The deployment's environment rate: version 0, 100 credits per USD. */
const ENVIRONMENT_RATE: ConversionRate = { numerator: 100n, denominator: 1n };

const FRESH_WINDOW_MS = 15 * 60 * 1000;

const service = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: FRESH_WINDOW_MS,
});

/** Version 1 prices: every dimension of the vocabulary priced and known. */
const V1_AMOUNTS = {
  input: "0.000001",
  output: "0.000002",
  reasoning: "0.000003",
  image: "0.01",
  image_output: "0.02",
  audio_input: "0.0001",
  audio_output: "0.0002",
  cache_read: "0.0000001",
  cache_write: "0.0000015",
  video: "0.01",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
} as const;

/** Version 2 prices: input and output quadruple (the world changes after the lock). */
const V2_AMOUNTS = { ...V1_AMOUNTS, input: "0.000004", output: "0.000006" } as const;

/** The per-dimension maximum quantities the admitted bound evidence certifies. */
const QUANTITIES: ReservationBoundQuantities = {
  input: 2_000_000,
  output: 1_000_000,
  reasoning: 500_000,
  image: 3,
  image_output: 1,
  audio_input: 60,
  audio_output: 30,
  cache_read: 1_000_000,
  cache_write: 100_000,
  video: 10,
  surcharge_web_search: 2,
  surcharge_per_request: 1,
};

/** The fully-known dims of one amounts map — the shape appendSnapshots persists. */
function dimsOf(amounts: Record<string, string>) {
  const dims: Record<string, { status: "known"; amount: string }> = {};
  for (const [dimension, amount] of Object.entries(amounts)) {
    dims[dimension] = { status: "known", amount };
  }
  return dims;
}

const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
const rateStore = createConversionRateStore({
  database,
  environmentRate: ENVIRONMENT_RATE,
});

let seedCounter = 0;

type SeededWorld = {
  userId: string;
  grantId: string;
  provider: string;
  model: string;
  customerKey: string;
  request: CreditReserveRequest;
};

/** One world where a reserve SHOULD succeed, priced against version 1 of everything. */
async function seedWorld(): Promise<SeededWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Version-lock Bot ${n}`,
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
  await snapshotStore.appendSnapshots([
    {
      ref: { provider, model, capability: "chat" },
      dims: dimsOf(V1_AMOUNTS) as never,
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: 0,
    },
  ]);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "chat",
    state: "open",
    reason: "version-lock fixture",
    changedBy: "test",
  });
  await database
    .insert(gatewayCatalogSyncState)
    .values({
      id: GATEWAY_CATALOG_SYNC_STATE_ID,
      lastSuccessfulSyncAt: new Date(),
    })
    .onConflictDoUpdate({
      target: gatewayCatalogSyncState.id,
      set: { lastSuccessfulSyncAt: new Date() },
    });

  // The hold the pure conversion certifies for this world: $5.9141 → 59 141 scaled units.
  const ceiling = computeReservationCeiling({
    dims: dimsOf(V1_AMOUNTS) as never,
    quantities: QUANTITIES,
    rate: ENVIRONMENT_RATE,
  });
  expect(ceiling.ok).toBe(true);
  if (!ceiling.ok) throw new Error("fixture ceiling refused");
  const maximumCredits = ceiling.maximumCredits;

  return {
    userId,
    grantId,
    provider,
    model,
    customerKey: payerKey({ kind: "personal", id: userId }),
    request: {
      grantId,
      payer: { kind: "personal", id: userId },
      model: { provider, model, capability: "chat" },
      snapshotVersion: 1,
      rateVersion: 0,
      boundEvidence: [
        { kind: "provider_max_tokens", maximumTokens: 1_500_000 },
        { kind: "self_enforced_input_truncation", maximumTokens: 3_000_000 },
      ],
      maximumCredits,
      idempotencyKey: `${prefix}-idem-${n}`,
    },
  };
}

/** The reservation row of a world's last reserve, by its idempotency key. */
async function reservationRowOf(
  idempotencyKey: string,
): Promise<typeof creditReservations.$inferSelect> {
  const [row] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.idempotencyKey, idempotencyKey))
    .limit(1);
  expect(row).toBeDefined();
  return row as typeof creditReservations.$inferSelect;
}

afterAll(async () => {
  // Credit-side columns carry the DERIVED account key (`openbot-personal-<prefix>…`).
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
  await database
    .delete(payerAccounts)
    .where(like(payerAccounts.payerId, `${prefix}%`));
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
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
  // gateway_price_snapshots and gateway_rate_versions are append-only by trigger; every
  // world isolates itself with its own unique provider prefix instead.
  await database.$client.close();
});

// ── The reservation record locks the basis it was admitted against ─────────────────

test("a reserved hold persists the model ref, snapshotVersion and rateVersion it locked", async () => {
  const world = await seedWorld();
  const outcome = await service.reserve(world.request);
  expect(outcome.status).toBe("reserved");
  if (outcome.status !== "reserved") return;
  expect(outcome.snapshotVersion).toBe(1);
  expect(outcome.rateVersion).toBe(0);

  const row = await reservationRowOf(world.request.idempotencyKey);
  const basis = lockedBasisOfReservation(row);
  expect(basis).toEqual({
    provider: world.provider,
    model: world.model,
    capability: "chat",
    snapshotVersion: 1,
    rateVersion: 0,
  });
});

test("a reservation written without a lock (the pre-06.5 shape) carries no basis, and stays legal", async () => {
  const customerKey = payerKey({ kind: "personal", id: (await seedWorld()).userId });
  await fixtureCreditWriter.reserveCredits({
    externalCustomerId: customerKey,
    idempotencyKey: `${prefix}-legacy-${++seedCounter}`,
    maximumCents: 500,
    expiresAt: new Date(Date.now() + 60 * 1000),
  });
  const [row] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, customerKey))
    .limit(1);
  expect(row.snapshotVersion).toBeNull();
  expect(row.rateVersion).toBeNull();
  expect(lockedBasisOfReservation(row)).toBeNull();
});

// ── The lock survives a changed world: settlement prices the locked combination ─────

test("after the price and the rate both change, the locked basis still resolves version 1 of each", async () => {
  const world = await seedWorld();
  const outcome = await service.reserve(world.request);
  expect(outcome.status).toBe("reserved");
  const row = await reservationRowOf(world.request.idempotencyKey);
  const basis = lockedBasisOfReservation(row);

  // The ceiling the lock certified at admission time.
  const admitted = computeReservationCeiling({
    dims: dimsOf(V1_AMOUNTS) as never,
    quantities: QUANTITIES,
    rate: ENVIRONMENT_RATE,
  });
  expect(admitted.ok && admitted.maximumCredits).toBe(world.request.maximumCredits);

  // The world changes: version 2 of the price snapshot, and an administrator's new rate.
  await snapshotStore.appendSnapshots([
    {
      ref: { provider: world.provider, model: world.model, capability: "chat" },
      dims: dimsOf(V2_AMOUNTS) as never,
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: 1,
    },
  ]);
  const saved = await rateStore.save(
    { numerator: "200", denominator: "1" },
    `${prefix} admin`,
  );
  expect(saved.ok).toBe(true);

  // The latest reads demonstrably changed — the lock is what keeps the promise, not silence.
  const latest = await snapshotStore.latestPriceSnapshot({
    provider: world.provider,
    model: world.model,
    capability: "chat",
  });
  expect(latest?.snapshotVersion).toBe(2);
  expect(latest?.dims.input.status === "known" && latest.dims.input.amount).toBe(
    "0.000004",
  );
  const currentRate = await rateStore.readConversionRate();
  expect(currentRate.configured && currentRate.rateVersion).toBe(saved.ok ? saved.rateVersion : null);

  // The LOCKED basis resolves the original combination, exactly as admitted.
  expect(basis).not.toBeNull();
  if (basis === null) return;
  const resolved = await resolveLockedReservationBasis(
    { database, environmentRate: ENVIRONMENT_RATE },
    basis,
  );
  expect(resolved.resolved).toBe(true);
  if (!resolved.resolved) return;
  expect(resolved.snapshotVersion).toBe(1);
  expect(resolved.rateVersion).toBe(0);
  expect(
    resolved.dims.input.status === "known" && resolved.dims.input.amount,
  ).toBe("0.000001");
  expect(resolved.rate).toEqual(ENVIRONMENT_RATE);

  // Pricing the SAME quantities through the locked basis still certifies the admitted hold;
  // through the LATEST basis it would be a different number — which is exactly why the
  // settlement path must read the lock, never the latest.
  const stillAdmitted = computeReservationCeiling({
    dims: resolved.dims,
    quantities: QUANTITIES,
    rate: resolved.rate,
  });
  expect(stillAdmitted.ok && stillAdmitted.maximumCredits).toBe(
    world.request.maximumCredits,
  );
  const throughLatest = computeReservationCeiling({
    dims: dimsOf(V2_AMOUNTS) as never,
    quantities: QUANTITIES,
    rate: { numerator: 200n, denominator: 1n },
  });
  expect(throughLatest.ok && throughLatest.maximumCredits).not.toBe(
    world.request.maximumCredits,
  );
});

test("a settled hold prices its actual usage with the locked basis and keeps the lock on the row", async () => {
  const world = await seedWorld();
  const outcome = await service.reserve(world.request);
  expect(outcome.status).toBe("reserved");
  if (outcome.status !== "reserved") return;
  const row = await reservationRowOf(world.request.idempotencyKey);
  const basis = lockedBasisOfReservation(row);

  // The world changes before settlement: version 2 prices quadruple input/output.
  await snapshotStore.appendSnapshots([
    {
      ref: { provider: world.provider, model: world.model, capability: "chat" },
      dims: dimsOf(V2_AMOUNTS) as never,
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: 1,
    },
  ]);

  // Actual usage: 1 000 000 input tokens, 100 000 output tokens — priced by the LOCKED
  // version-1 basis: $1 input + $0.2 output = $1.2 → 120 credits → exactly 12 000 units.
  expect(basis).not.toBeNull();
  if (basis === null) return;
  const locked = await resolveLockedReservationBasis(
    { database, environmentRate: ENVIRONMENT_RATE },
    basis,
  );
  expect(locked.resolved).toBe(true);

  // (The latest basis would price the same usage at $4 + $0.6 = 46 000 units — different.)
  const settleWriter = createCreditWriter(database);
  const settled = await settleWriter.settleReservation({
    reservationId: outcome.reservationId,
    actual: { numerator: 12_000n, denominator: 1n },
    title: "b5-256 version-locked settlement",
  });
  expect(settled.chargedCents).toBe(12_000);
  expect(settled.appliedCents).toBe(12_000);
  expect(settled.releasedCents).toBe(world.request.maximumCredits - 12_000);

  // The lock survives settlement: the terminal row still carries the same basis.
  const settledRow = await reservationRowOf(world.request.idempotencyKey);
  expect(lockedBasisOfReservation(settledRow)).toEqual(basis);
});

// ── Resolution refusals: a lock that cannot resolve says so, never guesses ──────────

test("a locked snapshot version nobody recorded resolves as not found, never a neighbor's prices", async () => {
  const world = await seedWorld();
  await service.reserve(world.request);
  const outcome = await resolveLockedReservationBasis(
    { database, environmentRate: ENVIRONMENT_RATE },
    {
      provider: world.provider,
      model: world.model,
      capability: "chat",
      snapshotVersion: 99,
      rateVersion: 0,
    },
  );
  expect(outcome.resolved).toBe(false);
  if (outcome.resolved) return;
  expect(outcome.reason).toBe("snapshot_not_found");
});

test("a locked rate version nobody recorded resolves as not found", async () => {
  const world = await seedWorld();
  await service.reserve(world.request);
  const outcome = await resolveLockedReservationBasis(
    { database, environmentRate: ENVIRONMENT_RATE },
    {
      provider: world.provider,
      model: world.model,
      capability: "chat",
      snapshotVersion: 1,
      rateVersion: 7,
    },
  );
  expect(outcome.resolved).toBe(false);
  if (outcome.resolved) return;
  expect(outcome.reason).toBe("rate_not_found");
});

test("rate version 0 without a configured environment rate resolves as not configured", async () => {
  const world = await seedWorld();
  await service.reserve(world.request);
  const outcome = await resolveLockedReservationBasis(
    { database }, // no environmentRate: nothing backs version 0
    {
      provider: world.provider,
      model: world.model,
      capability: "chat",
      snapshotVersion: 1,
      rateVersion: 0,
    },
  );
  expect(outcome.resolved).toBe(false);
  if (outcome.resolved) return;
  expect(outcome.reason).toBe("rate_not_configured");
});

/*
 * A half-lock is not a basis anyone can price from, so the reader refuses it in memory — and the
 * table's completeness CHECK refuses to let one be WRITTEN at all. The test after this one pins
 * that refusal at the database level, against a row inserted straight into the table.
 */
test("a half-locked reservation row is a thrown defect, and the table CHECK makes such rows unwritable", async () => {
  expect(() =>
    lockedBasisOfReservation({
      provider: "p",
      model: null,
      capability: "chat",
      snapshotVersion: 1,
      rateVersion: 0,
    }),
  ).toThrow(TypeError);
});

// ── The locked basis type the settlement contract carries ───────────────────────────

/**
 * The completeness CHECK, proven where it lives: in the database, against SQL that bypasses every
 * writer. The CHECK is NULL-safe all-or-nothing — the five basis fields are all NULL (a pre-06.5
 * row) or all valid together — because an all-or-nothing phrasing that lets SQL's three-valued
 * logic answer `NULL` for a partial row lets the half-lock LAND. review-256 caught exactly that:
 * a row with some basis fields present and others null inserted successfully. Each shape below
 * must be rejected with the constraint named, and both edges of the CHECK (all-NULL, full lock)
 * must stay open.
 */
test("the table's completeness CHECK refuses a half-locked row at the database level (direct INSERT)", async () => {
  /** Which constraint a rejected write tripped. See the same helper in the bot-service suite. */
  const violation = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => {
        throw new Error("expected the write to be rejected");
      },
      (caught: unknown) => caught,
    );
    const driver = (error as { cause?: unknown }).cause ?? error;
    const { errno, constraint } = driver as {
      errno?: unknown;
      constraint?: unknown;
    };
    return { sqlState: errno, constraint };
  };

  // One real customer so the foreign key holds; everything else about these rows is scaffolding.
  const { account } = await createPayerAccount(database, {
    kind: "personal",
    id: `${prefix}-chk-user`,
  });
  const customerKey = account.externalCustomerId;

  let probe = 0;
  const insertWithBasis = async (basis: {
    provider: string | null;
    model: string | null;
    capability: string | null;
    snapshotVersion: number | null;
    rateVersion: number | null;
  }) => {
    const n = ++probe;
    // The insert builder, not the writer: no lockedBasis, no billing logic — the only thing
    // standing between this row and the table is the constraint itself. (Drizzle's bun-sql
    // `execute(sql\`...\`)` resolves even when the statement fails, so the builder is also how
    // the rejection actually surfaces; see the same choice in the bot-service suite.)
    await database.insert(creditReservations).values({
      id: `${prefix}-chk-${n}`,
      externalCustomerId: customerKey,
      idempotencyKey: `${prefix}-chk-idem-${n}`,
      maximum: 100,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      provider: basis.provider,
      model: basis.model,
      capability: basis.capability,
      snapshotVersion: basis.snapshotVersion,
      rateVersion: basis.rateVersion,
    });
  };

  // The both edges that must stay OPEN: no lock at all (the pre-06.5 shape) and a full lock.
  await insertWithBasis({
    provider: null,
    model: null,
    capability: null,
    snapshotVersion: null,
    rateVersion: null,
  });
  await insertWithBasis({
    provider: `${prefix}-chk-prov`,
    model: "chk-model",
    capability: "chat",
    snapshotVersion: 1,
    rateVersion: 0,
  });

  // Partial locks, every one of which must die on credit_reservations_lock_completeness_check.
  const halfLocks: Array<Parameters<typeof insertWithBasis>[0]> = [
    { provider: `${prefix}-chk-prov`, model: null, capability: null, snapshotVersion: null, rateVersion: null },
    { provider: `${prefix}-chk-prov`, model: "chk-model", capability: "chat", snapshotVersion: null, rateVersion: null },
    { provider: null, model: null, capability: null, snapshotVersion: 1, rateVersion: 0 },
    // The shape three-valued logic defeats most quietly: the provider absent, the rest present.
    { provider: null, model: "chk-model", capability: "chat", snapshotVersion: 1, rateVersion: 0 },
  ];
  for (const basis of halfLocks) {
    expect(await violation(insertWithBasis(basis))).toEqual({
      sqlState: "23514",
      constraint: "credit_reservations_lock_completeness_check",
    });
  }
});

test("ReservationLockedBasis is the complete five-field basis (ref + both versions)", () => {
  const basis: ReservationLockedBasis = {
    provider: "prov",
    model: "model",
    capability: "chat",
    snapshotVersion: 1,
    rateVersion: 0,
  };
  expect(Object.keys(basis).sort()).toEqual([
    "capability",
    "model",
    "provider",
    "rateVersion",
    "snapshotVersion",
  ]);
});
