import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import {
  RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS,
  createCreditReserveService,
  creditProtocolEndpoints,
  type CreditReserveRequest,
} from "../src/billing/credit-reserve";
import {
  SETTLE_REFUSAL_REASONS,
  createCreditSettleService,
  creditSettleEndpoints,
} from "../src/billing/credit-settle";
import {
  createCreditServiceAuthenticator,
  creditProtocolRoutes,
  issueCreditServiceCredential,
  type CreditServiceVariables,
} from "../src/billing/credit-service-auth";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import { createConversionRateStore } from "../src/gateway/conversion-rate-store";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
} from "../src/gateway/price-snapshot";
import { createCredentialStore } from "../src/credentials";
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
  creditChargeRemainders,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #260 (06.9): settle idempotency, on a real PostgreSQL (TEST_DATABASE_URL; the
 * dedicated 5594 verify database, never the live one).
 *
 * THE CONTRACT UNDER TEST. The trusted admission extension settles a reservation with the
 * actual billed usage; the settlement message may be retried any number of times before its
 * acknowledgement is durable (07.8's outbox), and every retry must answer the FIRST result
 * without a second charge. The priced identity is the reservation itself: the settle request
 * carries NO price fields at all — the actual usage is converted through the LOCKED basis
 * the reservation recorded at admission (06.5), never the latest prices or rate, and the
 * credit writer's settleReservation fences a double settle on `reservation:<id>` in the
 * ledger. Unused hold capacity is released in the same transaction; every amount is an
 * exact rational end to end — no float anywhere.
 *
 * Isolation mirrors #256/#258: unique provider/bot/user prefixes per world (price snapshots
 * and rate versions are append-only), credit/payer/grant fixtures deleted by the DERIVED
 * account-key prefix in afterAll.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b5-260-${randomUUID().slice(0, 8)}`;
/** Fixture-side writer: seeds grants, and drives holds straight to terminal states. */
const fixtureCreditWriter = createCreditWriter(database);

/** The deployment's environment rate: version 0, 100 credits per USD. */
const ENVIRONMENT_RATE: ConversionRate = { numerator: 100n, denominator: 1n };

const FRESH_WINDOW_MS = 15 * 60 * 1000;

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: FRESH_WINDOW_MS,
});
const settleService = createCreditSettleService({
  database,
  environmentRate: ENVIRONMENT_RATE,
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
  /** The world's grant's idempotency key — the deterministic handle for grant assertions. */
  seedGrantKey: string;
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
    displayName: `Settle-idempotency Bot ${n}`,
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
    reason: "settle-idempotency fixture",
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

  return {
    userId,
    grantId,
    provider,
    model,
    customerKey: payerKey({ kind: "personal", id: userId }),
    seedGrantKey: `${prefix}-seed-grant-${n}`,
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
      // The hold ceiling the version-1 basis certifies for the bound quantities below;
      // the same arithmetic the settlement side must stay consistent with.
      maximumCredits: 59_141,
      idempotencyKey: `${prefix}-idem-${n}`,
    } satisfies CreditReserveRequest,
  };
}

/** All twelve dimensions, everything but the named ones zero — the settle usage shape. */
function usageOf(named: Record<string, number>): Record<string, number> {
  const usage: Record<string, number> = {
    input: 0,
    output: 0,
    reasoning: 0,
    image: 0,
    image_output: 0,
    audio_input: 0,
    audio_output: 0,
    cache_read: 0,
    cache_write: 0,
    video: 0,
    surcharge_web_search: 0,
    surcharge_per_request: 0,
  };
  for (const [dimension, quantity] of Object.entries(named)) {
    usage[dimension] = quantity;
  }
  return usage;
}

/** A valid settle message against a reservation: the ticket's request contract as the wire carries it. */
function settleRequestOf(
  reservationId: string,
  usage: Record<string, number>,
  idempotencyKey = `${prefix}-settle-${seedCounter}`,
) {
  return {
    reservationId,
    actualUsage: usageOf(usage),
    evidence: {
      kind: "provider_usage_report",
      reference: `${prefix}-usage-${idempotencyKey}`,
    },
    settledBy: `${prefix}-bifrost-admission`,
    idempotencyKey,
  };
}

async function reserveOrFail(world: SeededWorld): Promise<string> {
  const outcome = await reserveService.reserve(world.request);
  if (outcome.status !== "reserved") {
    throw new Error(`fixture reserve refused: ${JSON.stringify(outcome)}`);
  }
  return outcome.reservationId;
}

/**
 * A second, INDEPENDENT reservation in the same world — same payer, own idempotency key:
 * the account-level carried remainder (06.6) is what its settlement completes.
 */
async function reserveAnother(
  world: SeededWorld,
): Promise<{ reservationId: string; idempotencyKey: string }> {
  const idempotencyKey = `${world.request.idempotencyKey}-again-${++seedCounter}`;
  const outcome = await reserveService.reserve({ ...world.request, idempotencyKey });
  if (outcome.status !== "reserved") {
    throw new Error(`fixture reserve refused: ${JSON.stringify(outcome)}`);
  }
  return { reservationId: outcome.reservationId, idempotencyKey };
}

/** The reservation row of a world's reserve, by its idempotency key. */
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

async function ledgerRowsOf(customerKey: string) {
  return database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey));
}

/** The customer's single carried-remainder row, as the DB stores it. */
async function remainderRowOf(customerKey: string) {
  const [row] = await database
    .select()
    .from(creditChargeRemainders)
    .where(eq(creditChargeRemainders.externalCustomerId, customerKey))
    .limit(1);
  return row;
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

// ── Replay idempotency: the same settle message answers the first result ───────────

test("a replay of the identical settle message returns the first result and charges exactly once", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const maximum = world.request.maximumCredits;

  // Actual usage: 1 000 000 input + 100 000 output tokens → version-1 pricing
  // $1.00 + $0.20 = $1.20 → 120 credits → exactly 12 000 scaled units (×100).
  const request = settleRequestOf(reservationId, {
    input: 1_000_000,
    output: 100_000,
  });

  const first = await settleService.settle(request);
  expect(first.status).toBe("settled");
  if (first.status !== "settled") return;
  expect(first.chargedCredits).toBe(12_000);
  expect(first.appliedCredits).toBe(12_000);
  expect(first.releasedCredits).toBe(maximum - 12_000);
  expect(first.remainder).toEqual({ numerator: "0", denominator: "1" });
  expect(first.attemptId).toBe(`att-${reservationId.slice("cr-".length)}`);

  // The replay is the SAME MESSAGE on the wire — parsed again from JSON, byte-equal facts.
  const replay = await settleService.settle(JSON.parse(JSON.stringify(request)));
  expect(replay.status).toBe("settled");
  if (replay.status !== "settled") return;
  // The FIRST result, verbatim — not a recomputed or a second charge.
  expect(replay.chargedCredits).toBe(first.chargedCredits);
  expect(replay.appliedCredits).toBe(first.appliedCredits);
  expect(replay.releasedCredits).toBe(first.releasedCredits);
  expect(replay.remainder).toEqual(first.remainder);
  expect(replay.actualCost).toEqual(first.actualCost);
  expect(replay.reservationId).toBe(first.reservationId);
  expect(replay.attemptId).toBe(first.attemptId);

  // One ledger row, one charge: `reservation:<id>` fenced the double settle.
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
  expect(ledgerRows[0]?.credits).toBe(12_000);
  expect(ledgerRows[0]?.applied).toBe(12_000);
  expect(ledgerRows[0]?.idempotencyKey).toBe(`reservation:${reservationId}`);

  // The grants absorbed the charge exactly once — THIS world's grant, by its key.
  const [grant] = await database
    .select({ used: creditGrants.used })
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, world.seedGrantKey));
  expect(grant?.used).toBe(12_000);

  // The reservation is settled exactly once, with the exact actual on the row.
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("settled");
  expect(row.actualNumerator).toBe("12000");
  expect(row.actualDenominator).toBe("1");
  expect(row.charged).toBe(12_000);
  expect(row.applied).toBe(12_000);
  expect(row.released).toBe(maximum - 12_000);
});

test("a settle by attemptId and a settle by reservationId are the same settlement: both replays answer the first result", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const usage = { input: 500_000, output: 250_000 };

  const byReservation = await settleService.settle(
    settleRequestOf(reservationId, usage, `${prefix}-settle-both-1`),
  );
  expect(byReservation.status).toBe("settled");
  if (byReservation.status !== "settled") return;

  // The attempt id names the same reservation (06.7's identity): a settle message that
  // names it instead is the SAME settlement — the first result, never a second charge.
  const byAttempt = await settleService.settle({
    ...(settleRequestOf(reservationId, usage, `${prefix}-settle-both-1`) as Record<string, unknown>),
    reservationId: undefined,
    attemptId: byReservation.attemptId,
  });
  expect(byAttempt.status).toBe("settled");
  if (byAttempt.status !== "settled") return;
  expect(byAttempt.reservationId).toBe(reservationId);
  expect(byAttempt.chargedCredits).toBe(byReservation.chargedCredits);
  expect(byAttempt.remainder).toEqual(byReservation.remainder);

  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
});

test("concurrent replays of the same settle message charge once and both answer the first result", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const request = settleRequestOf(reservationId, {
    input: 1_000_000,
    output: 100_000,
  }, `${prefix}-settle-race`);

  const [a, b] = await Promise.all([
    settleService.settle(JSON.parse(JSON.stringify(request))),
    settleService.settle(JSON.parse(JSON.stringify(request))),
  ]);
  expect(a.status).toBe("settled");
  expect(b.status).toBe("settled");
  if (a.status !== "settled" || b.status !== "settled") return;
  expect(b.chargedCredits).toBe(a.chargedCredits);
  expect(b.releasedCredits).toBe(a.releasedCredits);
  expect(b.remainder).toEqual(a.remainder);

  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
  const [grant] = await database
    .select({ used: creditGrants.used })
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, world.seedGrantKey));
  expect(grant?.used).toBe(a.chargedCredits);
});

// ── Conflict: a replay with a different amount is refused, never re-charged ─────────

test("a replay with a different actual usage conflicts and leaves the first charge standing", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  const first = await settleService.settle(
    settleRequestOf(reservationId, { input: 1_000_000, output: 100_000 }, `${prefix}-settle-diff`),
  );
  expect(first.status).toBe("settled");
  if (first.status !== "settled") return;

  // The same reservation, a different amount: a CONFLICT, never a top-up or a second row.
  const second = await settleService.settle(
    settleRequestOf(reservationId, { input: 2_000_000, output: 100_000 }, `${prefix}-settle-diff`),
  );
  expect(second.status).toBe("refused");
  if (second.status !== "refused") return;
  expect(SETTLE_REFUSAL_REASONS).toContain(second.reasonCode);
  expect(second.reasonCode).toBe("settlement_conflict");

  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
  expect(ledgerRows[0]?.credits).toBe(first.chargedCredits);
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("settled");
  expect(row.charged).toBe(first.chargedCredits);
});

test("settling a released hold conflicts: the first terminal fact stands", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  await fixtureCreditWriter.releaseReservation(reservationId, "test: released before settle");

  const outcome = await settleService.settle(
    settleRequestOf(reservationId, { input: 1000 }, `${prefix}-settle-rel`),
  );
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("settlement_conflict");
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(0);
});

test("settling a reservation that does not exist conflicts without writing anything", async () => {
  const outcome = await settleService.settle(
    settleRequestOf(`cr-${randomUUID().slice(0, 8).padEnd(16, "0")}`, { input: 1000 }, `${prefix}-settle-missing`),
  );
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("settlement_conflict");
});

// ── The locked versions decide the amount: never the latest prices or rate ─────────

test("settlement converts actual usage through the reservation's locked snapshot and rate versions", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  // The world changes AFTER admission: version-2 prices (input ×4, output ×3) and a
  // doubled administrator rate. A settlement that read either would bill money nobody
  // agreed to — the lock is what stands between the two.
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
  const saved = await rateStore.save({ numerator: "200", denominator: "1" }, `${prefix} admin`);
  expect(saved.ok).toBe(true);

  // Latest basis would price the same usage at $4.00 + $0.60 = $4.60 → 46 000 units
  // (at the doubled rate: 92 000). The locked version-1 basis prices $1.20 → 12 000.
  const outcome = await settleService.settle(
    settleRequestOf(reservationId, { input: 1_000_000, output: 100_000 }, `${prefix}-settle-lock`),
  );
  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  expect(outcome.chargedCredits).toBe(12_000);
  expect(outcome.actualCost).toEqual({ numerator: "12000", denominator: "1" });
});

// ── Unused hold capacity is released at settlement ──────────────────────────────────

test("settlement releases the unused hold capacity in the same transaction", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const maximum = world.request.maximumCredits;

  const before = await fixtureCreditWriter.availableBalance(world.customerKey);

  // A small actual: 500 000 input tokens → $0.50 → 50 credits → 5 000 units.
  const outcome = await settleService.settle(
    settleRequestOf(reservationId, { input: 500_000 }, `${prefix}-settle-relcap`),
  );
  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  expect(outcome.chargedCredits).toBe(5_000);
  expect(outcome.appliedCredits).toBe(5_000);
  expect(outcome.releasedCredits).toBe(maximum - 5_000);

  // The hold is gone: the released capacity returned to the balance (available = free −
  // holds, so the applied share moved from hold to used), minus any unfunded shortfall.
  const after = await fixtureCreditWriter.availableBalance(world.customerKey);
  expect(after).toBe(
    before +
      outcome.releasedCredits -
      (outcome.chargedCredits - outcome.appliedCredits),
  );

  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("settled");
  expect(row.released).toBe(maximum - 5_000);
  expect(row.applied).toBe(5_000);
});

// ── Exact money: fractional rates carry the remainder, no float ever ────────────────

test("fractional charges settle to exact rationals: the carried remainder completes the unit later", async () => {
  const world = await seedWorld();

  // One input token prices 0.000001 USD × 100 credits/USD = 0.0001 credits = 1/100 of a
  // scaled unit: floor 0, the fraction carried on the account.
  const firstReservation = await reserveOrFail(world);
  const first = await settleService.settle(
    settleRequestOf(firstReservation, { input: 1 }, `${prefix}-settle-frac-1`),
  );
  expect(first.status).toBe("settled");
  if (first.status !== "settled") return;
  expect(first.chargedCredits).toBe(0);
  expect(first.actualCost).toEqual({ numerator: "1", denominator: "100" });
  expect(first.remainder).toEqual({ numerator: "1", denominator: "100" });

  // A second reservation's settlement carries the fraction: 99 tokens price 99/100,
  // plus the owed 1/100 → exactly one whole unit charged, nothing left over.
  const second = await reserveAnother(world);
  const secondSettle = await settleService.settle(
    settleRequestOf(second.reservationId, { input: 99 }, `${prefix}-settle-frac-2`),
  );
  expect(secondSettle.status).toBe("settled");
  if (secondSettle.status !== "settled") return;
  expect(secondSettle.chargedCredits).toBe(1);
  expect(secondSettle.remainder).toEqual({ numerator: "0", denominator: "1" });

  // The ledger holds the whole truth in integers; the reservation rows hold the exact
  // rationals as strings — nothing anywhere passed through a float.
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(2);
  const credits = ledgerRows.map((row) => row.credits).sort((a, b) => a - b);
  expect(credits).toEqual([0, 1]);

  const firstRow = await reservationRowOf(world.request.idempotencyKey);
  expect(firstRow.actualNumerator).toBe("1");
  expect(firstRow.actualDenominator).toBe("100");
  expect(firstRow.charged).toBe(0);
  expect(firstRow.remainderNumerator).toBe("1");
  expect(firstRow.remainderDenominator).toBe("100");
  const secondRow = await reservationRowOf(second.idempotencyKey);
  expect(secondRow.actualNumerator).toBe("99");
  expect(secondRow.actualDenominator).toBe("100");
  expect(secondRow.charged).toBe(1);
  expect(secondRow.remainderNumerator).toBe("0");
  expect(secondRow.remainderDenominator).toBe("1");

  const carried = await remainderRowOf(world.customerKey);
  expect(carried?.numerator).toBe("0");
  expect(carried?.denominator).toBe("1");
});

// ── A reservation without a locked basis cannot be settled by the protocol ──────────

test("a hold written without a locked basis refuses settlement instead of guessing a price", async () => {
  const world = await seedWorld();
  // The pre-06.5 shape: a hold with no lock, written straight through the writer.
  await fixtureCreditWriter.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-nolock-${seedCounter}`,
    maximumCents: 5_000,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const [row] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.idempotencyKey, `${prefix}-nolock-${seedCounter}`))
    .limit(1);
  expect(row).toBeDefined();

  const outcome = await settleService.settle(
    settleRequestOf(row!.id, { input: 1000 }, `${prefix}-settle-nolock`),
  );
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("price_basis_not_found");
  // Nothing moved.
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(0);
});

test("a locked rate version that no longer resolves refuses settlement, never re-prices", async () => {
  const world = await seedWorld();
  await reserveOrFail(world);
  // A hold whose lock names an unrecorded rate version, written directly with the writer:
  // the settlement refuses rather than falling back to the environment rate or the latest.
  await fixtureCreditWriter.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-badrate-${seedCounter}`,
    maximumCents: 5_000,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lockedBasis: {
      provider: world.provider,
      model: world.model,
      capability: "chat",
      snapshotVersion: 1,
      rateVersion: 424_242,
    },
  });
  const [row] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.idempotencyKey, `${prefix}-badrate-${seedCounter}`))
    .limit(1);
  expect(row).toBeDefined();

  const outcome = await settleService.settle(
    settleRequestOf(row!.id, { input: 1000 }, `${prefix}-settle-badrate`),
  );
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("price_basis_not_found");
  expect(String((outcome.detail as { reason?: string }).reason)).toContain("rate");
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(0);
});

test("an actual usage whose priced cost exceeds the 32-bit ledger column refuses, never truncates", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  // 10^15 input tokens price $10^9 → 10^13 scaled units — beyond what the ledger column
  // can hold. The settlement refuses with its own code instead of writing a wrong amount.
  const outcome = await settleService.settle(
    settleRequestOf(reservationId, { input: 10 ** 15 }, `${prefix}-settle-huge`),
  );
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("charge_exceeds_ledger");
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(0);
});

// ── The shape boundary: malformed settle messages refuse with zero reads ────────────

test("a settle message naming an account refuses as payer_conflict — accounts are never client input", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const outcome = await settleService.settle({
    ...settleRequestOf(reservationId, { input: 1000 }, `${prefix}-settle-payer`),
    externalCustomerId: world.customerKey,
  });
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("payer_conflict");
});

test.each([
  {
    name: "both reservationId and attemptId",
    mutate: (request: Record<string, unknown>) => ({
      ...request,
      attemptId: `att-${String(request.reservationId).slice("cr-".length)}`,
    }),
  },
  {
    name: "neither reservationId nor attemptId",
    mutate: (request: Record<string, unknown>) => ({
      ...request,
      reservationId: undefined,
    }),
  },
  {
    name: "a malformed reservationId",
    mutate: (request: Record<string, unknown>) => ({
      ...request,
      reservationId: "not-a-reservation-id",
    }),
  },
  {
    name: "a malformed attemptId",
    mutate: (request: Record<string, unknown>) => ({
      ...request,
      reservationId: undefined,
      attemptId: "att-nothex",
    }),
  },
  {
    name: "actualUsage missing a dimension",
    mutate: (request: Record<string, unknown>) => ({
      ...request,
      actualUsage: { input: 10 },
    }),
  },
  {
    name: "actualUsage with a negative quantity",
    mutate: (request: Record<string, unknown>) => ({
      ...request,
      actualUsage: { ...usageOf({ input: 10 }), output: -1 },
    }),
  },
  {
    name: "actualUsage with a fractional quantity",
    mutate: (request: Record<string, unknown>) => ({
      ...request,
      actualUsage: { ...usageOf({ input: 10 }), audio_input: 1.5 },
    }),
  },
  {
    name: "an unknown evidence kind",
    mutate: (request: Record<string, unknown>) => ({
      ...request,
      evidence: { kind: "operator_guess" },
    }),
  },
  {
    name: "evidence that is not an object",
    mutate: (request: Record<string, unknown>) => ({ ...request, evidence: "report" }),
  },
  {
    name: "an empty settledBy",
    mutate: (request: Record<string, unknown>) => ({ ...request, settledBy: "" }),
  },
  {
    name: "an empty idempotencyKey",
    mutate: (request: Record<string, unknown>) => ({ ...request, idempotencyKey: "" }),
  },
  {
    name: "actualUsage that is not an object",
    mutate: (request: Record<string, unknown>) => ({ ...request, actualUsage: 42 }),
  },
])("a settle message with $name refuses as request_invalid", async ({ mutate }) => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const outcome = await settleService.settle(
    mutate(settleRequestOf(reservationId, { input: 10 }, `${prefix}-settle-shape`) as Record<string, unknown>),
  );
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("request_invalid");
  // A shape refusal did not touch the hold.
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("reserved");
});

// ── The wire: the settle surface lives inside the 06.1 guard ────────────────────────

const encryptionKey = randomUUID().replaceAll("-", "");
const credentialStore = createCredentialStore(database);
const auditStore = createAuditStore(database);
const authenticate = createCreditServiceAuthenticator({
  encryptionKey,
  credentialStore,
});

/** The protocol surface: the 06.1 guard with Reserve AND Settle composed inside. */
const protocolApp = new Hono<{ Variables: CreditServiceVariables }>();
protocolApp.route(
  "/api/credit-protocol",
  creditProtocolRoutes({
    authenticate,
    auditStore,
    endpoints: (() => {
      const endpoints = new Hono<{ Variables: CreditServiceVariables }>();
      endpoints.route("/", creditProtocolEndpoints({ service: reserveService }));
      endpoints.route("/", creditSettleEndpoints({ service: settleService }));
      return endpoints;
    })(),
  }),
);

let gatewaySecret: string | null = null;

test("the deployment's trusted credential is issued for the protocol surface", async () => {
  const issued = await issueCreditServiceCredential({
    encryptionKey,
    credentialStore,
  });
  gatewaySecret = issued.secret;
  expect(gatewaySecret).toBeTruthy();
});

test("the settle route refuses an unauthenticated call with the uniform 401", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const response = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      settleRequestOf(reservationId, { input: 10 }, `${prefix}-settle-401`),
    ),
  });
  expect(response.status).toBe(401);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe("credit_service_auth_failed");
  // The unauthenticated call settled nothing.
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("reserved");
});

test("the settle route answers 200 with the first result on replay and 422 with the reason on refusal", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const request = settleRequestOf(reservationId, { input: 1_000_000, output: 100_000 }, `${prefix}-settle-route`);

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${gatewaySecret}`,
  };

  const firstResponse = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as Record<string, unknown>;
  expect(first.status).toBe("settled");
  expect(first.chargedCredits).toBe(12_000);

  const replayResponse = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  expect(replayResponse.status).toBe(200);
  const replay = (await replayResponse.json()) as Record<string, unknown>;
  expect(replay).toEqual(first);

  // A replay with a different amount is one 422 naming the conflict.
  const conflictResponse = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...request, actualUsage: usageOf({ input: 2_000_000 }) }),
  });
  expect(conflictResponse.status).toBe(422);
  const conflict = (await conflictResponse.json()) as { code?: string };
  expect(conflict.code).toBe("settlement_conflict");

  // A self-reported account field is refused at the shape boundary, on the wire too.
  const payerResponse = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...request, [RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS[0]]: "x" }),
  });
  expect(payerResponse.status).toBe(422);
  const payer = (await payerResponse.json()) as { code?: string };
  expect(payer.code).toBe("payer_conflict");

  // Still exactly one charge.
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
});

test("a settle route body that is not JSON refuses as request_invalid", async () => {
  const response = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewaySecret}`,
    },
    body: "not json",
  });
  expect(response.status).toBe(422);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe("request_invalid");
});
