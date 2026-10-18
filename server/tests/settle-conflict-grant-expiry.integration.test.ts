import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import {
  RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS,
  createCreditReserveService,
  type CreditReserveRequest,
} from "../src/billing/credit-reserve";
import {
  SETTLE_REFUSAL_REASONS,
  createCreditSettleService,
} from "../src/billing/credit-settle";
import { createCreditWriter } from "../src/billing/credits-writer";
import { deriveGrantStatus } from "../src/billing/credits";
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
import { creditReservations } from "../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #261 (06.10): settle conflicts and grant mid-flight expiry, on a real PostgreSQL
 * (TEST_DATABASE_URL; the dedicated 5594 verify database, never the live one).
 *
 * THE CONTRACT UNDER TEST. Three conflict classes each answer with an explicit, stable
 * marker and never silently overwrite: a settle that names ANOTHER payment account is the
 * tamper shape (`payer_conflict` — the account is fixed by the reservation, never client
 * input); a duplicate settle with a DIFFERENT amount conflicts
 * (`settlement_conflict`, kind `settled_with_different_actual`); a settle against a
 * RELEASED hold conflicts (`settlement_conflict`, kind `reservation_released`).
 *
 * THE EXPIRY SEMANTICS (Q24 — deliberately NOT "expired means refuse"): a grant that
 * expires while a request is in flight still settles the ADMITTED work against that very
 * grant (11:59 admission, 12:01 settlement — the charge lands, losing it would erase a
 * cost that was really incurred), and the unused portion the settlement hands back is dead
 * the moment its grant has lapsed: it never returns to the spendable balance, and a new
 * request after the expiry cannot use it. The same holds for an ordinary release.
 *
 * Isolation mirrors #260: unique provider/bot/user prefixes per world (price snapshots and
 * rate versions are append-only), credit/payer/grant fixtures deleted by the DERIVED
 * account-key prefix in afterAll. The clock is advanced by moving the grant's own
 * `expires_at` into the past — the exact field the capacity computation and every expiry
 * path read — so no test waits on a wall clock.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b5-261-${randomUUID().slice(0, 8)}`;
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
const rateStore = createConversionRateStore({
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

/** The fully-known dims of one amounts map — the shape appendSnapshots persists. */
function dimsOf(amounts: Record<string, string>) {
  const dims: Record<string, { status: "known"; amount: string }> = {};
  for (const [dimension, amount] of Object.entries(amounts)) {
    dims[dimension] = { status: "known", amount };
  }
  return dims;
}

const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);

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
    displayName: `Settle-conflict Bot ${n}`,
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
    reason: "settle-conflict fixture",
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

/** The world's grant row, by its idempotency key. */
async function grantRowOf(idempotencyKey: string) {
  const [row] = await database
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, idempotencyKey))
    .limit(1);
  expect(row).toBeDefined();
  return row as typeof creditGrants.$inferSelect;
}

async function ledgerRowsOf(customerKey: string) {
  return database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey));
}

/**
 * The clock, advanced: the grant's one expiry field moved into the past — the field the
 * capacity read and every expiry path filter on. Admission already happened (the hold and
 * its allocations are on disk), so this is exactly the 11:59→12:01 step with no wall wait.
 */
async function expireGrant(grantKey: string) {
  const grant = await grantRowOf(grantKey);
  await database
    .update(creditGrants)
    .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
    .where(eq(creditGrants.id, grant.id));
  return grant;
}

/**
 * A hold written straight through the writer with an explicit locked basis: the fixture
 * for expiry scenarios that need an exact hold size rather than the reserve surface's
 * evidence-derived ceiling. The basis resolves (version 1 + environment rate), so the
 * settlement prices exactly as an admitted hold would.
 */
async function reserveWriterHold(input: {
  customerKey: string;
  provider: string;
  model: string;
  maximumCents: number;
  key: string;
}): Promise<string> {
  const result = await fixtureCreditWriter.reserveCredits({
    externalCustomerId: input.customerKey,
    idempotencyKey: input.key,
    maximumCents: input.maximumCents,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lockedBasis: {
      provider: input.provider,
      model: input.model,
      capability: "chat",
      snapshotVersion: 1,
      rateVersion: 0,
    },
  });
  if (!result.reserved) {
    throw new Error(`fixture reserve refused: ${JSON.stringify(result)}`);
  }
  return result.reservationId;
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
  // world isolates itself with its own unique provider prefix, and rate-version reads
  // capture the exact version numbers their saves produced.
  await database.$client.close();
});

// ── Conflict class 1: another payer's account never redirects a settlement ─────────

test("a settle naming another payment account refuses as payer_conflict and never redirects the charge", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  // The only shape a payer mismatch can take on the wire: a self-reported account field.
  // The account is fixed by the reservation server-side; naming another one — at the top
  // level or inside the evidence — is the tamper attempt, refused before any read.
  const topLevel = await settleService.settle({
    ...settleRequestOf(reservationId, { input: 1000 }, `${prefix}-settle-pay-1`),
    [RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS[0]]: "openbot-personal-someone-else",
  });
  expect(topLevel.status).toBe("refused");
  if (topLevel.status !== "refused") return;
  expect(SETTLE_REFUSAL_REASONS).toContain(topLevel.reasonCode);
  expect(topLevel.reasonCode).toBe("payer_conflict");
  expect((topLevel.detail as { field?: string }).field).toBe(
    RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS[0],
  );

  const nested = await settleService.settle({
    ...settleRequestOf(reservationId, { input: 1000 }, `${prefix}-settle-pay-2`),
    evidence: {
      kind: "provider_usage_report",
      externalCustomerId: world.customerKey,
    },
  });
  expect(nested.status).toBe("refused");
  if (nested.status !== "refused") return;
  expect(nested.reasonCode).toBe("payer_conflict");
  expect((nested.detail as { field?: string }).field).toBe(
    "evidence.externalCustomerId",
  );

  // The hold is untouched: a refused redirect settled nothing.
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("reserved");
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(0);
});

// ── Conflict class 2: a duplicate settle with a different amount ────────────────────

test("a duplicate settle with a different amount conflicts with a stable kind and leaves the first charge standing", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  // First settlement: 1 000 000 input + 100 000 output → $1.20 → 12 000 scaled units.
  const first = await settleService.settle(
    settleRequestOf(reservationId, { input: 1_000_000, output: 100_000 }, `${prefix}-settle-amt-1`),
  );
  expect(first.status).toBe("settled");
  if (first.status !== "settled") return;
  expect(first.chargedCredits).toBe(12_000);

  // The duplicate names the SAME reservation with a DIFFERENT amount: a conflict with a
  // stable, machine-readable kind — never a top-up, never a second charge.
  const second = await settleService.settle(
    settleRequestOf(reservationId, { input: 2_000_000, output: 100_000 }, `${prefix}-settle-amt-2`),
  );
  expect(second.status).toBe("refused");
  if (second.status !== "refused") return;
  expect(second.reasonCode).toBe("settlement_conflict");
  expect((second.detail as { kind?: string }).kind).toBe(
    "settled_with_different_actual",
  );

  // The FIRST result stands, byte for byte: one ledger row, the first amounts, the first
  // exact actual on the reservation row.
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
  expect(ledgerRows[0]?.credits).toBe(first.chargedCredits);
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("settled");
  expect(row.charged).toBe(first.chargedCredits);
  expect(row.actualNumerator).toBe(first.actualCost.numerator);
  expect(row.actualDenominator).toBe(first.actualCost.denominator);

  // And the identical first message still replays to the first result afterwards — the
  // conflict changed nothing about idempotency.
  const replay = await settleService.settle(
    settleRequestOf(reservationId, { input: 1_000_000, output: 100_000 }, `${prefix}-settle-amt-1`),
  );
  expect(replay.status).toBe("settled");
  if (replay.status !== "settled") return;
  expect(replay.chargedCredits).toBe(first.chargedCredits);
});

// ── Conflict class 3: a settle against a released hold ──────────────────────────────

test("a settle against a released hold conflicts with a stable kind and the capacity stands released", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const maximum = world.request.maximumCredits;

  await fixtureCreditWriter.releaseReservation(reservationId, "test: released before settle");
  const balanceAfterRelease = await fixtureCreditWriter.availableBalance(
    world.customerKey,
  );

  const outcome = await settleService.settle(
    settleRequestOf(reservationId, { input: 1000 }, `${prefix}-settle-rel`),
  );
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("settlement_conflict");
  expect((outcome.detail as { kind?: string }).kind).toBe("reservation_released");

  // The refusal charged nothing and vacated nothing further: the released hold's capacity
  // is exactly where release left it.
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    balanceAfterRelease,
  );
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(0);
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("released");
  expect(row.released).toBe(maximum);
  expect(row.applied).toBe(0);
});

// ── Grant mid-flight expiry: the 11:59 admission, 12:01 settlement scenario ─────────

test("a grant that expires mid-request still settles the admitted work against that grant", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const maximum = world.request.maximumCredits;

  // 12:00 passes while the request is in flight: the grant lapses AFTER the hold and its
  // allocations were written, BEFORE the settlement arrives.
  const grant = await expireGrant(world.seedGrantKey);
  expect(
    deriveGrantStatus(grant, Date.now()),
  ).toBe("active"); // sanity before the clock move: the fixture seized a live grant

  // 12:01: the settlement arrives. The admitted work is billed — refusing it would erase
  // a cost that was really incurred. The charge lands on the very grant that lapsed.
  const outcome = await settleService.settle(
    settleRequestOf(reservationId, { input: 1_000_000, output: 100_000 }, `${prefix}-settle-exp`),
  );
  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  expect(outcome.chargedCredits).toBe(12_000);
  expect(outcome.appliedCredits).toBe(12_000);
  expect(outcome.releasedCredits).toBe(maximum - 12_000);

  // The lapsed grant absorbed the charge (the hold keeps its grants even if one lapsed
  // since: the work was admitted while it was live), and the row's derived life is now
  // `expired` — the settled charge does not resurrect it.
  const [after] = await database
    .select({ used: creditGrants.used, total: creditGrants.total, expiresAt: creditGrants.expiresAt })
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, world.seedGrantKey));
  expect(after?.used).toBe(12_000);
  expect(deriveGrantStatus(after!, Date.now())).toBe("expired");

  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
  expect(ledgerRows[0]?.credits).toBe(12_000);
  expect(ledgerRows[0]?.applied).toBe(12_000);

  // The unused portion the settlement released is dead on arrival: its grant has lapsed,
  // so it never returns to the spendable balance, and a new request cannot use it.
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(0);
  const freshRequest = await fixtureCreditWriter.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-after-expiry-${seedCounter}`,
    maximumCents: 100,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  expect(freshRequest).toEqual({ reserved: false, availableCents: 0 });
});

test("a hold spread across two grants still bills the lapsed grant's admitted share", async () => {
  const world = await seedWorld();
  // A second, later-expiring grant: the hold allocates soonest-expiry-first, so the
  // sooner grant takes the front of the hold and the later one the rest.
  await fixtureCreditWriter.grantCredits({
    externalCustomerId: world.customerKey,
    source: "promo",
    totalCents: 1_000_000, // 1 000 000 scaled units
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-second-grant-${seedCounter}`,
  });
  const secondGrantKey = `${prefix}-second-grant-${seedCounter}`;

  // A 500 000-unit hold over a 300 000-unit front grant and a 1 000 000-unit back grant:
  // the front (sooner-expiring) grant's allocation is 300 000, the back one's 200 000.
  const soonGrant = await grantRowOf(world.seedGrantKey);
  await database
    .update(creditGrants)
    .set({ expiresAt: new Date(Date.now() + 2 * 60 * 1000) })
    .where(eq(creditGrants.id, soonGrant.id));
  const totalBefore = soonGrant.total; // 1 000 000 units from seedWorld
  expect(totalBefore).toBe(1_000_000);
  await database
    .update(creditGrants)
    .set({ total: 300_000 })
    .where(eq(creditGrants.id, soonGrant.id));

  const reservationId = await reserveWriterHold({
    customerKey: world.customerKey,
    provider: world.provider,
    model: world.model,
    maximumCents: 500_000,
    key: `${prefix}-two-grant-${seedCounter}`,
  });

  // The front grant lapses after admission.
  await expireGrant(world.seedGrantKey);

  // 40 000 000 input tokens → $40 → 4 000 credits → 400 000 scaled units. The applied
  // draw walks the allocations in expiry order: the LAPSED front grant absorbs its
  // admitted 300 000, the live back grant the remaining 100 000.
  const outcome = await settleService.settle(
    settleRequestOf(reservationId, { input: 40_000_000 }, `${prefix}-settle-two`),
  );
  expect(outcome.status).toBe("settled");
  if (outcome.status !== "settled") return;
  expect(outcome.chargedCredits).toBe(400_000);
  expect(outcome.appliedCredits).toBe(400_000);
  expect(outcome.releasedCredits).toBe(100_000);

  const [front] = await database
    .select({ used: creditGrants.used, expiresAt: creditGrants.expiresAt })
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, world.seedGrantKey));
  expect(front?.used).toBe(300_000);
  expect(deriveGrantStatus(front!, Date.now())).toBe("expired");
  const [back] = await database
    .select({ used: creditGrants.used, expiresAt: creditGrants.expiresAt })
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, secondGrantKey));
  expect(back?.used).toBe(100_000);
  expect(deriveGrantStatus(back!, Date.now())).toBe("active");

  // The live back grant keeps its remainder (its released 100 000 came back); the lapsed
  // front grant's unused share is gone from the spendable balance either way.
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    900_000,
  );
});

// ── Released-then-expired: the balance never revives ────────────────────────────────

test("capacity a release hands back stays dead once its grant expires: new requests cannot use it", async () => {
  const world = await seedWorld();
  const maximum = 100_000;
  const reservationId = await reserveWriterHold({
    customerKey: world.customerKey,
    provider: world.provider,
    model: world.model,
    maximumCents: maximum,
    key: `${prefix}-rel-exp-${seedCounter}`,
  });

  // 11:59: the hold is released while the grant is still live — the full balance returns.
  await fixtureCreditWriter.releaseReservation(reservationId, "test: released while live");
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    1_000_000,
  );

  // 12:00: the grant expires. 12:01: a new request asks for the very capacity the
  // release handed back — it must not get it.
  await expireGrant(world.seedGrantKey);
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(0);
  const freshRequest = await fixtureCreditWriter.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-after-rel-${seedCounter}`,
    maximumCents: maximum,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  expect(freshRequest).toEqual({ reserved: false, availableCents: 0 });

  const grant = await grantRowOf(world.seedGrantKey);
  expect(deriveGrantStatus(grant, Date.now())).toBe("expired");
  // The released hold stays released: the expiry did not reopen it into anything
  // settleable either.
  const settleOutcome = await settleService.settle(
    settleRequestOf(reservationId, { input: 1000 }, `${prefix}-settle-relexp`),
  );
  expect(settleOutcome.status).toBe("refused");
  if (settleOutcome.status !== "refused") return;
  expect(settleOutcome.reasonCode).toBe("settlement_conflict");
  expect((settleOutcome.detail as { kind?: string }).kind).toBe(
    "reservation_released",
  );
});

// ── review-260 finding #1: a non-zero locked rate version decides the amount ────────

test("a reservation locked to a non-zero administrator rate version settles at that version's rate", async () => {
  const world = await seedWorld();

  // Two administrator rates, recorded in order: version N at 50 credits/USD, version
  // N+1 at 300. The reservation locks version N — a NON-ZERO version, the recorded
  // history — not the environment rate (version 0) and never "whatever is newest".
  const savedFirst = await rateStore.save({ numerator: "50", denominator: "1" }, `${prefix} admin v1`);
  expect(savedFirst.ok).toBe(true);
  if (!savedFirst.ok) return;
  const lockedVersion = savedFirst.rateVersion;
  expect(lockedVersion).toBeGreaterThanOrEqual(1);

  const outcome0 = await reserveService.reserve({
    ...world.request,
    rateVersion: lockedVersion,
  });
  expect(outcome0.status).toBe("reserved");
  if (outcome0.status !== "reserved") return;
  expect(outcome0.rateVersion).toBe(lockedVersion);

  // The lock is on the row, non-zero, before the world moves on.
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.rateVersion).toBe(lockedVersion);
  expect(row.rateVersion).toBeGreaterThanOrEqual(1);

  // A NEWER administrator rate lands after admission; the newest rate would bill 36 000,
  // the environment rate 12 000 — the locked version N bills $1.20 × 50 credits/USD =
  // 60 credits = 6 000 scaled units, and that is what the settlement must charge.
  const savedSecond = await rateStore.save({ numerator: "300", denominator: "1" }, `${prefix} admin v2`);
  expect(savedSecond.ok).toBe(true);
  if (!savedSecond.ok) return;
  expect(savedSecond.rateVersion).toBe(lockedVersion + 1);

  const settled = await settleService.settle(
    settleRequestOf(outcome0.reservationId, { input: 1_000_000, output: 100_000 }, `${prefix}-settle-rate`),
  );
  expect(settled.status).toBe("settled");
  if (settled.status !== "settled") return;
  expect(settled.chargedCredits).toBe(6_000);
  expect(settled.chargedCredits).not.toBe(12_000); // not the environment rate
  expect(settled.chargedCredits).not.toBe(36_000); // not the newest rate
  expect(settled.actualCost).toEqual({ numerator: "6000", denominator: "1" });

  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
  expect(ledgerRows[0]?.credits).toBe(6_000);
});
