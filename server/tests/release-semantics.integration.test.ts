import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
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
  RELEASE_NO_CHARGE_EVIDENCE_KINDS,
  RELEASE_REFUSAL_REASONS,
  createCreditReleaseService,
  creditReleaseEndpoints,
} from "../src/billing/credit-release";
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
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "../src/billing/credits-writer";
import {
  CONFIRMED_NO_COST_REASONS,
  isConfirmedNoCost,
} from "../src/billing/usage-evidence";
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
import { creditReservations } from "../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { deriveGrantStatus } from "../src/billing/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #262 (06.11): the Release protocol surface — release ONLY on confirmed
 * no-charge, and a release never revives an expired grant's quota, on a real
 * PostgreSQL (TEST_DATABASE_URL; the dedicated 5594 verify database, never the live
 * one).
 *
 * THE CONTRACT UNDER TEST. The Release request carries { reservationId, reason,
 * noChargeEvidence }; evidence outside the closed no-charge vocabulary refuses, so
 * "the client hung up", a stream error, a timeout, a cancellation and a missing usage
 * report can never dress a guess up as a confirmed no-cost (the resume hint: a
 * disconnect is NOT no-charge evidence — the same discipline the internal failure
 * path already keeps through isConfirmedNoCost). An `unknown` hold refuses release
 * with a stable kind: only 08.x's recovery flow may dispose of it. A settled hold
 * refuses release too — a charge exists, and a release arriving after it cannot
 * stand. A release of a released hold answers the FIRST terminal result (idempotent,
 * no additional effect). And the capacity a release hands back stays subject to the
 * grant's own clock: once the grant has lapsed, the released quota is dead — it never
 * returns to the spendable balance and no new request can take it (06.10 pinned the
 * read side; this pins the release face to the same truth).
 *
 * Isolation mirrors #260/#261: unique provider/bot/user prefixes per world (price
 * snapshots and rate versions are append-only), credit/payer/grant fixtures deleted
 * by the DERIVED account-key prefix in afterAll. The clock is advanced by moving the
 * grant's own `expires_at` into the past — the exact field the capacity computation
 * and every expiry path read — so no test waits on a wall clock.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b5-262-${randomUUID().slice(0, 8)}`;
/** Fixture-side writer: seeds grants, and drives holds to unknown/terminal states. */
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
const releaseService = createCreditReleaseService({ database });

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
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
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
    displayName: `Release-semantics Bot ${n}`,
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
    reason: "release-semantics fixture",
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
      // The hold ceiling the version-1 basis certifies for the bound quantities above;
      // the same numbers the settle-side tests certify.
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
    surcharge_tool_call: 0,
    surcharge_a2a_call: 0,
  };
  for (const [dimension, quantity] of Object.entries(named)) {
    usage[dimension] = quantity;
  }
  return usage;
}

/** A valid settle message against a reservation: the 06.9 request contract as the wire carries it. */
function settleRequestOf(reservationId: string, usage: Record<string, number>) {
  return {
    reservationId,
    actualUsage: usageOf(usage),
    evidence: {
      kind: "provider_usage_report",
      reference: `${prefix}-usage-${reservationId}`,
    },
    settledBy: `${prefix}-bifrost-admission`,
    idempotencyKey: `${prefix}-settle-${reservationId}`,
  };
}

/**
 * A valid release message against a reservation: the 06.11 request contract as the
 * wire carries it — { reservationId, reason, noChargeEvidence }.
 */
function releaseRequestOf(reservationId: string, reason = "provider refused before dispatch") {
  return {
    reservationId,
    reason,
    noChargeEvidence: {
      kind: "provider_error",
      reference: `${prefix}-nodispatch-${reservationId}`,
    },
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
 * The clock, advanced: the grant's one expiry field moved into the past — the field
 * the capacity read and every expiry path filter on. The hold and its allocations are
 * already on disk, so this is exactly the 11:59→12:01 step with no wall wait.
 */
async function expireGrant(grantKey: string) {
  const grant = await grantRowOf(grantKey);
  await database
    .update(creditGrants)
    .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
    .where(eq(creditGrants.id, grant.id));
  return grant;
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

// ── Refusal class 1: release without no-charge evidence ─────────────────────────────

test("a release without noChargeEvidence refuses and leaves the hold reserved", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  for (const evidence of [undefined, null, "provider said so", 42, {}]) {
    const outcome = await releaseService.release({
      ...(releaseRequestOf(reservationId) as Record<string, unknown>),
      noChargeEvidence: evidence,
    });
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(RELEASE_REFUSAL_REASONS).toContain(outcome.reasonCode);
    expect(outcome.reasonCode).toBe("request_invalid");
  }

  // None of the malformed attempts moved the hold.
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("reserved");
  expect(row.terminalAt).toBeNull();
});

test.each(["client_disconnected", "stream_error", "cancelled", "timeout", "usage_missing", "key_expired"])(
  "a release standing on %s refuses: it is not no-charge evidence",
  async (kind) => {
    const world = await seedWorld();
    const reservationId = await reserveOrFail(world);

    const outcome = await releaseService.release({
      ...releaseRequestOf(reservationId),
      noChargeEvidence: { kind, reference: `${prefix}-not-evidence` },
    });
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("request_invalid");

    // The hold keeps occupying: a non-evidence reason released nothing.
    const row = await reservationRowOf(world.request.idempotencyKey);
    expect(row.status).toBe("reserved");
    expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
      1_000_000 - world.request.maximumCredits,
    );
  },
);

test("a release with an empty or oversized reason refuses as request_invalid", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  for (const reason of ["", "   ", `x`.repeat(513)]) {
    const outcome = await releaseService.release({
      ...releaseRequestOf(reservationId),
      reason,
    });
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("request_invalid");
  }
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("reserved");
});

test("a release naming a payment account refuses as payer_conflict — accounts are never client input", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  const topLevel = await releaseService.release({
    ...releaseRequestOf(reservationId),
    [RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS[0]]: world.customerKey,
  });
  expect(topLevel.status).toBe("refused");
  if (topLevel.status !== "refused") return;
  expect(topLevel.reasonCode).toBe("payer_conflict");

  const nested = await releaseService.release({
    ...releaseRequestOf(reservationId),
    noChargeEvidence: {
      kind: "provider_error",
      externalCustomerId: world.customerKey,
    },
  });
  expect(nested.status).toBe("refused");
  if (nested.status !== "refused") return;
  expect(nested.reasonCode).toBe("payer_conflict");
  expect((nested.detail as { field?: string }).field).toBe(
    `noChargeEvidence.${RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS[1]}`,
  );

  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("reserved");
});

// ── Refusal class 2: an unknown hold is never ordinary-release evidence ─────────────

test("an unknown hold refuses release with a stable kind and keeps occupying capacity", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  await fixtureCreditWriter.markReservationUnknown(
    reservationId,
    "stream_error",
  );
  const occupied = await fixtureCreditWriter.availableBalance(world.customerKey);

  const outcome = await releaseService.release(releaseRequestOf(reservationId));
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("release_conflict");
  expect((outcome.detail as { kind?: string }).kind).toBe("reservation_unknown");

  // The hold is still unknown, still occupying (Q12/AC15): only 08.x's recovery flow
  // may dispose of it, through releaseUnknownReservation — never this door.
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("unknown");
  expect(row.terminalAt).toBeNull();
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    occupied,
  );
});

test("the writer's ordinary release refuses an unknown hold with the same stable kind", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  await fixtureCreditWriter.markReservationUnknown(
    reservationId,
    "usage_missing",
  );

  try {
    await fixtureCreditWriter.releaseReservation(reservationId, "provider_error");
    throw new Error("expected the unknown release to be refused");
  } catch (error) {
    expect(error).toBeInstanceOf(CreditReservationConflictError);
    expect((error as CreditReservationConflictError).conflictKind).toBe(
      "reservation_unknown",
    );
  }

  // 06.8's own door still disposes of the hold on evidence (the only path).
  await fixtureCreditWriter.releaseUnknownReservation(
    reservationId,
    "recovery: evidenced no-cost disposal",
  );
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("released");
});

// ── The release itself: confirmed no-cost releases a plain hold ─────────────────────

test("a confirmed no-cost release frees the held capacity and records the reason", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const maximum = world.request.maximumCredits;
  const before = await fixtureCreditWriter.availableBalance(world.customerKey);
  expect(before).toBe(1_000_000 - maximum);

  const outcome = await releaseService.release(releaseRequestOf(reservationId));
  expect(outcome.status).toBe("released");
  if (outcome.status !== "released") return;
  expect(outcome.reservationId).toBe(reservationId);
  expect(outcome.releasedCredits).toBe(maximum);
  expect(outcome.attemptId).toBe(`att-${reservationId.slice("cr-".length)}`);

  // The full hold is back, the row is terminal with the caller's reason on it.
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    1_000_000,
  );
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("released");
  expect(row.applied).toBe(0);
  expect(row.released).toBe(maximum);
  expect(row.releaseReason).toBe("provider refused before dispatch");
  expect(row.terminalAt).not.toBeNull();
});

test("a replay of the identical release message answers the first result with no additional effect", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  const first = await releaseService.release(releaseRequestOf(reservationId));
  expect(first.status).toBe("released");
  if (first.status !== "released") return;
  const [rowAfterFirst] = await database
    .select({ terminalAt: creditReservations.terminalAt })
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId))
    .limit(1);

  // The replay is the SAME MESSAGE on the wire — parsed again from JSON.
  const replay = await releaseService.release(
    JSON.parse(JSON.stringify(releaseRequestOf(reservationId))),
  );
  expect(replay.status).toBe("released");
  if (replay.status !== "released") return;
  expect(replay.releasedCredits).toBe(first.releasedCredits);
  expect(replay.reservationId).toBe(first.reservationId);
  expect(replay.attemptId).toBe(first.attemptId);

  // The first terminal fact stands untouched: no second terminal write.
  const [rowAfterReplay] = await database
    .select({ terminalAt: creditReservations.terminalAt })
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId))
    .limit(1);
  expect(rowAfterReplay?.terminalAt?.toISOString()).toBe(
    rowAfterFirst?.terminalAt?.toISOString(),
  );
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    1_000_000,
  );
});

test("concurrent replays of the same release answer released exactly once", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  const [a, b] = await Promise.all([
    releaseService.release(JSON.parse(JSON.stringify(releaseRequestOf(reservationId)))),
    releaseService.release(JSON.parse(JSON.stringify(releaseRequestOf(reservationId)))),
  ]);
  expect(a.status).toBe("released");
  expect(b.status).toBe("released");
  if (a.status !== "released" || b.status !== "released") return;
  expect(b.releasedCredits).toBe(a.releasedCredits);
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    1_000_000,
  );
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("released");
  expect(row.released).toBe(world.request.maximumCredits);
});

test("releasing a settled hold refuses: the charge stands, a release cannot follow it", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  // 1 000 input tokens → $0.001 → 0.1 credits → 10 scaled units.
  const settled = await settleService.settle(
    settleRequestOf(reservationId, { input: 1000 }),
  );
  expect(settled.status).toBe("settled");
  if (settled.status !== "settled") return;

  const outcome = await releaseService.release(releaseRequestOf(reservationId));
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("release_conflict");
  expect((outcome.detail as { kind?: string }).kind).toBe("reservation_settled");

  // The settlement stands untouched: the ledger keeps its one row, the row stays settled.
  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows.length).toBe(1);
  expect(ledgerRows[0]?.credits).toBe(settled.chargedCredits);
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("settled");
  expect(row.releaseReason).toBeNull();
});

test("a settle and a release racing the same hold produce exactly one terminal fact", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  const [settleOutcome, releaseOutcome] = await Promise.all([
    settleService.settle(settleRequestOf(reservationId, { input: 1000 })),
    releaseService.release(JSON.parse(JSON.stringify(releaseRequestOf(reservationId)))),
  ]);

  // Exactly one of the two wins; the loser's answer names the winner's terminal fact
  // with its stable kind — never two outcomes, never a silent no-op on the wire.
  if (settleOutcome.status === "settled") {
    expect(releaseOutcome.status).toBe("refused");
    if (releaseOutcome.status !== "refused") return;
    expect(releaseOutcome.reasonCode).toBe("release_conflict");
    expect((releaseOutcome.detail as { kind?: string }).kind).toBe(
      "reservation_settled",
    );
    expect((await ledgerRowsOf(world.customerKey)).length).toBe(1);
  } else {
    expect(releaseOutcome.status).toBe("released");
    expect(settleOutcome.status).toBe("refused");
    if (settleOutcome.status !== "refused") return;
    expect(settleOutcome.reasonCode).toBe("settlement_conflict");
    expect((settleOutcome.detail as { kind?: string }).kind).toBe(
      "reservation_released",
    );
    expect((await ledgerRowsOf(world.customerKey)).length).toBe(0);
  }
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe(
    settleOutcome.status === "settled" ? "settled" : "released",
  );
});

test("releasing a reservation that does not exist conflicts without writing anything", async () => {
  const outcome = await releaseService.release(
    releaseRequestOf(`cr-${randomUUID().slice(0, 8).padEnd(16, "0")}`),
  );
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("release_conflict");
  expect((outcome.detail as { kind?: string }).kind).toBe("no_such_reservation");
});

// ── Expired grants: the released quota never revives ────────────────────────────────

test("a release after the grant lapsed hands back quota that stays dead: no balance, no new hold", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const maximum = world.request.maximumCredits;

  // 12:00 passes while the hold is outstanding; 12:01 the confirmed no-cost arrives.
  const grant = await expireGrant(world.seedGrantKey);
  expect(deriveGrantStatus(grant, Date.now())).toBe("active"); // sanity: the fixture seized a live grant
  const [lapsed] = await database
    .select({ expiresAt: creditGrants.expiresAt })
    .from(creditGrants)
    .where(eq(creditGrants.id, grant.id));
  expect(deriveGrantStatus({ ...grant, expiresAt: lapsed!.expiresAt }, Date.now())).toBe(
    "expired",
  );

  const outcome = await releaseService.release(releaseRequestOf(reservationId));
  expect(outcome.status).toBe("released");
  if (outcome.status !== "released") return;
  expect(outcome.releasedCredits).toBe(maximum);

  // The hand-back is dead on arrival: the lapsed grant's unused share never returns
  // to the spendable balance, and a new request cannot take the very capacity the
  // release handed back.
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(0);
  const freshRequest = await fixtureCreditWriter.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-after-rel-exp-${seedCounter}`,
    maximumCents: 100,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  expect(freshRequest).toEqual({ reserved: false, availableCents: 0 });

  // The release is still a terminal fact: the expired hold settles nothing either.
  const settleOutcome = await settleService.settle(
    settleRequestOf(reservationId, { input: 1000 }),
  );
  expect(settleOutcome.status).toBe("refused");
  if (settleOutcome.status !== "refused") return;
  expect(settleOutcome.reasonCode).toBe("settlement_conflict");
  expect((settleOutcome.detail as { kind?: string }).kind).toBe(
    "reservation_released",
  );

  // No ledger row exists at all: a release never charges.
  expect((await ledgerRowsOf(world.customerKey)).length).toBe(0);
});

test("a release while the grant is still live hands the capacity back for use until expiry", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  const outcome = await releaseService.release(releaseRequestOf(reservationId));
  expect(outcome.status).toBe("released");

  // The live grant's capacity is fully back and usable again — the release face
  // behaves exactly like the writer face #261 pinned; only expiry kills quota.
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    1_000_000,
  );
  const fresh = await fixtureCreditWriter.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-live-rel-${seedCounter}`,
    maximumCents: 100,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  expect(fresh.reserved).toBe(true);
});

// ── Vocabulary coherence: the two faces of "confirmed no-cost" cannot drift ─────────

test("the release evidence vocabulary is exactly the confirmed-no-cost vocabulary", () => {
  expect(RELEASE_NO_CHARGE_EVIDENCE_KINDS.length).toBe(
    CONFIRMED_NO_COST_REASONS.size,
  );
  for (const kind of RELEASE_NO_CHARGE_EVIDENCE_KINDS) {
    expect(isConfirmedNoCost(kind)).toBe(true);
  }
  // And every internal confirmed-no-cost reason is receivable on the wire.
  for (const reason of CONFIRMED_NO_COST_REASONS) {
    expect(RELEASE_NO_CHARGE_EVIDENCE_KINDS).toContain(reason);
  }
});

// ── The wire: the release surface lives inside the 06.1 guard ───────────────────────

const encryptionKey = randomUUID().replaceAll("-", "");
const credentialStore = createCredentialStore(database);
const auditStore = createAuditStore(database);
const authenticate = createCreditServiceAuthenticator({
  encryptionKey,
  credentialStore,
});

/** The protocol surface: the 06.1 guard with Reserve, Settle AND Release composed inside. */
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
      endpoints.route("/", creditReleaseEndpoints({ service: releaseService }));
      return endpoints;
    })(),
  }),
);

let gatewaySecret: string | null = null;

test("the deployment's trusted credential is issued for the release surface", async () => {
  const issued = await issueCreditServiceCredential({
    encryptionKey,
    credentialStore,
  });
  gatewaySecret = issued.secret;
  expect(gatewaySecret).toBeTruthy();
});

test("the release route refuses an unauthenticated call with the uniform 401", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const response = await protocolApp.request("/api/credit-protocol/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(releaseRequestOf(reservationId)),
  });
  expect(response.status).toBe(401);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe("credit_service_auth_failed");
  // The unauthenticated call released nothing.
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("reserved");
});

test("the release route answers 200 on release and replay, and 422 with the code on refusal", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  const request = releaseRequestOf(reservationId);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${gatewaySecret}`,
  };

  const firstResponse = await protocolApp.request("/api/credit-protocol/release", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as Record<string, unknown>;
  expect(first.status).toBe("released");
  expect(first.releasedCredits).toBe(world.request.maximumCredits);

  const replayResponse = await protocolApp.request("/api/credit-protocol/release", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  expect(replayResponse.status).toBe(200);
  const replay = (await replayResponse.json()) as Record<string, unknown>;
  expect(replay).toEqual(first);

  // A release without evidence is one 422 naming the refusal.
  const noEvidenceResponse = await protocolApp.request(
    "/api/credit-protocol/release",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        reservationId,
        reason: "client went away",
      }),
    },
  );
  expect(noEvidenceResponse.status).toBe(422);
  const noEvidence = (await noEvidenceResponse.json()) as { code?: string };
  expect(noEvidence.code).toBe("request_invalid");

  // A release standing on a disconnect is refused on the wire too.
  const disconnectResponse = await protocolApp.request(
    "/api/credit-protocol/release",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...request,
        reservationId: await reserveOrFail({
          ...world,
          request: {
            ...world.request,
            idempotencyKey: `${world.request.idempotencyKey}-wire2`,
          },
        }),
        noChargeEvidence: { kind: "client_disconnected" },
      }),
    },
  );
  expect(disconnectResponse.status).toBe(422);
  const disconnect = (await disconnectResponse.json()) as { code?: string };
  expect(disconnect.code).toBe("request_invalid");

  // Still exactly one terminal write on the original reservation.
  const row = await reservationRowOf(world.request.idempotencyKey);
  expect(row.status).toBe("released");
});

test("a release route body that is not JSON refuses as request_invalid", async () => {
  const response = await protocolApp.request("/api/credit-protocol/release", {
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
