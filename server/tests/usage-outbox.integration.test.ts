import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import {
  createCreditReserveService,
  creditProtocolEndpoints,
  type CreditReserveRequest,
} from "../src/billing/credit-reserve";
import {
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
 * Bifrost #271 (07.8): the settle consumption face of the gateway's result outbox, on a
 * real PostgreSQL (TEST_DATABASE_URL; the dedicated 5594 verify database, never the live
 * one).
 *
 * WHAT ARRIVES HERE. The Bifrost governance plugin persists each attempt's actual usage
 * into its result outbox BEFORE the user response ends, and delivers from there to this
 * deployment's Settle surface. This file holds the consumption side to the message the
 * outbox actually sends: the reservation named by id (never an account — the account is
 * the reservation's), the actual usage in the closed twelve-dimension vocabulary (zero
 * where nothing was consumed), the provider_usage_report evidence referenced to the
 * gateway request, `bifrost-governance` as the settling party, and the gateway attempt
 * identity (bfat-…) as the message's retry key. NO price fields: the amount is converted
 * through the LOCKED basis the reservation recorded at admission (06.5), server-side.
 *
 * THE DELIVERY CONTRACT UNDER TEST. A redelivery — the outbox retrying after a lost
 * acknowledgement — replays the same bytes under the same idempotency key and must
 * converge on the FIRST result without a second charge (the ledger's `reservation:<id>`
 * fence); a corrupted retry carrying different usage conflicts instead of topping up.
 *
 * Isolation mirrors #260: unique provider/bot/user prefixes per world (price snapshots
 * and rate versions are append-only), credit/payer/grant fixtures deleted by the DERIVED
 * account-key prefix in afterAll.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b5-271-${randomUUID().slice(0, 8)}`;
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
  video_input: "0.0001",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
} as const;

/** The hold ceiling the version-1 basis certifies for the bound quantities below. */
const HOLD_CEILING = 59_141;

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
  seedGrantKey: string;
  request: CreditReserveRequest;
};

/** One world where a reserve succeeds, priced against version 1 of everything. */
async function seedWorld(): Promise<SeededWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Outbox-consume Bot ${n}`,
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
    reason: "outbox-consume fixture",
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
      maximumCredits: HOLD_CEILING,
      idempotencyKey: `${prefix}-idem-${n}`,
    } satisfies CreditReserveRequest,
  };
}

/**
 * The usage the gateway's outbox sends, as the Go stage maps it: every dimension of the
 * closed vocabulary present, zero where nothing was consumed. The four quantities here
 * mirror the extraction test on the gateway side: 600 prompt tokens (100 cache reads,
 * 50 cache writes) and 400 completion tokens.
 */
function gatewayUsageOf(named: Record<string, number>): Record<string, number> {
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
    video_input: 0,
    surcharge_web_search: 0,
    surcharge_per_request: 0,
    surcharge_tool_call: 0,
    surcharge_a2a_call: 0,
  };
  for (const [dimension, quantity] of Object.entries(named)) {
    usage[dimension] = quantity;
  }
  return usage;
}

/**
 * The settle message exactly as the gateway's outbox builds it (settlementoutbox.go's
 * settleRequestFor): bfat- attempt identity as the retry key, the request id as the
 * evidence reference, `bifrost-governance` as the settling party, and NO account and NO
 * price anywhere.
 */
function gatewaySettleMessage(
  reservationId: string,
  usage: Record<string, number>,
  attemptId: string,
  requestId = "req-reserve-1",
) {
  return {
    reservationId,
    actualUsage: usage,
    evidence: {
      kind: "provider_usage_report",
      reference: requestId,
    },
    settledBy: "bifrost-governance",
    idempotencyKey: attemptId,
  };
}

/** A bfat- attempt identity as the gateway mints them: prefix plus 32 bytes of hex. */
const bfatAttemptId = (n: number) =>
  `bfat-${(n.toString(16).padStart(64, "a")).slice(0, 64)}`;

/**
 * The exact scaled-unit cost of a usage at the version-1 basis, as BigInt rationals —
 * computed HERE independently of the service, the same arithmetic the locked-basis
 * settlement must answer with (Σ quantity × price, × rate × CREDIT_SCALE, reduced).
 */
function expectedExactScaledUnits(usage: Record<string, number>): {
  numerator: bigint;
  denominator: bigint;
} {
  const amounts: Record<string, [bigint, bigint]> = {
    input: [1n, 1_000_000n],
    output: [2n, 1_000_000n],
    reasoning: [3n, 1_000_000n],
    image: [1n, 100n],
    image_output: [1n, 50n],
    audio_input: [1n, 10_000n],
    audio_output: [1n, 5_000n],
    cache_read: [1n, 10_000_000n],
    cache_write: [15n, 10_000_000n],
    video: [1n, 100n],
    surcharge_web_search: [1n, 1_000n],
    surcharge_per_request: [1n, 10_000n],
  };
  let numerator = 0n;
  let denominator = 1n;
  for (const [dimension, [amountN, amountD]] of Object.entries(amounts)) {
    numerator =
      numerator * amountD + BigInt(usage[dimension] ?? 0) * amountN * denominator;
    denominator *= amountD;
  }
  // USD → credits (×100/1) → scaled units (×CREDIT_SCALE=100).
  const scaledNumerator = numerator * 100n * 100n;
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const divisor = gcd(
    scaledNumerator < 0n ? -scaledNumerator : scaledNumerator,
    denominator,
  );
  return { numerator: scaledNumerator / divisor, denominator: denominator / divisor };
}

async function reserveOrFail(world: SeededWorld): Promise<string> {
  const outcome = await reserveService.reserve(world.request);
  if (outcome.status !== "reserved") {
    throw new Error(`fixture reserve refused: ${JSON.stringify(outcome)}`);
  }
  return outcome.reservationId;
}

async function ledgerRowsOf(customerKey: string) {
  return database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey));
}

async function remainderRowOf(customerKey: string) {
  const [row] = await database
    .select()
    .from(creditChargeRemainders)
    .where(eq(creditChargeRemainders.externalCustomerId, customerKey))
    .limit(1);
  return row;
}

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

// ── The guarded route the outbox delivers to ────────────────────────────────────────

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

test("the deployment's trusted credential is issued for the outbox's deliveries", async () => {
  const issued = await issueCreditServiceCredential({
    encryptionKey,
    credentialStore,
  });
  gatewaySecret = issued.secret;
  expect(gatewaySecret).toBeTruthy();
});

// ── The gateway message settles at the locked basis ─────────────────────────────────

test("the gateway outbox message settles through the guarded route at the locked basis", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  // The usage the gateway extracted: 600 prompt (100 cache-read, 50 cache-write),
  // 400 completion. Version-1 USD: 0.00045 + 0.0008 + 0.00001 + 0.000075 = 0.001335
  // → ×100 credits/USD = 0.1335 → scaled 13.35 = 267/20; floored: 13 charged, 7/20 owed.
  const message = gatewaySettleMessage(
    reservationId,
    gatewayUsageOf({ input: 450, output: 400, cache_read: 100, cache_write: 50 }),
    bfatAttemptId(1),
  );
  const exact = expectedExactScaledUnits(message.actualUsage);
  expect(exact.numerator).toBe(267n);
  expect(exact.denominator).toBe(20n);

  const response = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewaySecret}`,
    },
    body: JSON.stringify(message),
  });
  expect(response.status).toBe(200);
  const outcome = (await response.json()) as Record<string, unknown>;
  expect(outcome.status).toBe("settled");
  expect(outcome.chargedCredits).toBe(13);
  expect(outcome.appliedCredits).toBe(13);
  expect(outcome.releasedCredits).toBe(HOLD_CEILING - 13);
  expect(outcome.actualCost).toEqual({ numerator: "267", denominator: "20" });
  expect(outcome.remainder).toEqual({ numerator: "7", denominator: "20" });
  expect(outcome.attemptId).toBe(`att-${reservationId.slice("cr-".length)}`);

  // The ledger carries one settlement row, fenced on the reservation.
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
  expect(ledgerRows[0]?.credits).toBe(13);
  expect(ledgerRows[0]?.idempotencyKey).toBe(`reservation:${reservationId}`);

  // The account carries the fraction for the next settlement to complete (06.6).
  const carried = await remainderRowOf(world.customerKey);
  expect(carried?.numerator).toBe("7");
  expect(carried?.denominator).toBe("20");
});

test("a redelivery of the same outbox message after a lost acknowledgement converges on the first result", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  // 1 000 000 input + 100 000 output → $1.00 + $0.20 = $1.20 → 12 000 scaled units.
  const message = gatewaySettleMessage(
    reservationId,
    gatewayUsageOf({ input: 1_000_000, output: 100_000 }),
    bfatAttemptId(2),
  );
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${gatewaySecret}`,
  };

  const firstResponse = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as Record<string, unknown>;
  expect(first.chargedCredits).toBe(12_000);

  // The outbox's retry: the SAME bytes, parsed again from JSON — the ack was lost, the
  // delivery was not. The first result comes back; no second charge exists.
  const redeliveryResponse = await protocolApp.request(
    "/api/credit-protocol/settle",
    { method: "POST", headers, body: JSON.stringify(JSON.parse(JSON.stringify(message))) },
  );
  expect(redeliveryResponse.status).toBe(200);
  const redelivery = (await redeliveryResponse.json()) as Record<string, unknown>;
  expect(redelivery).toEqual(first);

  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
  expect(ledgerRows[0]?.credits).toBe(12_000);
  const [grant] = await database
    .select({ used: creditGrants.used })
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, world.seedGrantKey));
  expect(grant?.used).toBe(12_000);
});

test("a zero-usage delivery settles the reservation free and hands back the whole hold", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  // The provider reported a usage object of zeros: known-free, delivered, released —
  // not an unknown (an unknown never leaves the gateway as zeros).
  const response = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewaySecret}`,
    },
    body: JSON.stringify(
      gatewaySettleMessage(reservationId, gatewayUsageOf({}), bfatAttemptId(3)),
    ),
  });
  expect(response.status).toBe(200);
  const outcome = (await response.json()) as Record<string, unknown>;
  expect(outcome.status).toBe("settled");
  expect(outcome.chargedCredits).toBe(0);
  expect(outcome.appliedCredits).toBe(0);
  expect(outcome.releasedCredits).toBe(HOLD_CEILING);

  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("settled");
  expect(row.charged).toBe(0);
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
  expect(ledgerRows[0]?.credits).toBe(0);
});

// ── The shape boundary: what the outbox can never sneak through ─────────────────────

test("a dimension outside the closed vocabulary is refused at the shape boundary", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  const drifted = {
    ...gatewaySettleMessage(
      reservationId,
      gatewayUsageOf({ input: 10 }),
      bfatAttemptId(4),
    ),
    actualUsage: { ...gatewayUsageOf({ input: 10 }), tokens: 5 },
  };
  const response = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewaySecret}`,
    },
    body: JSON.stringify(drifted),
  });
  expect(response.status).toBe(422);
  const refusal = (await response.json()) as { code?: string; detail?: { dimension?: string } };
  expect(refusal.code).toBe("request_invalid");
  expect(refusal.detail?.dimension).toBe("tokens");

  // The drifted message settled nothing.
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("reserved");
  expect((await ledgerRowsOf(world.customerKey)).length).toBe(0);
});

test("a message naming an account key is refused, though the gateway never sends one", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  const withAccount = {
    ...gatewaySettleMessage(
      reservationId,
      gatewayUsageOf({ input: 10 }),
      bfatAttemptId(5),
    ),
    payerId: world.userId,
  };
  const response = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewaySecret}`,
    },
    body: JSON.stringify(withAccount),
  });
  expect(response.status).toBe(422);
  const refusal = (await response.json()) as { code?: string };
  expect(refusal.code).toBe("payer_conflict");
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("reserved");
});
