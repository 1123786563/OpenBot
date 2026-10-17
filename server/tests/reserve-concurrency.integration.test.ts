import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import {
  createCreditReserveService,
  reserveCreditInTransaction,
  type CreditReserveOutcome,
  type CreditReserveRequest,
} from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
  mapPriceDims,
} from "../src/gateway/price-snapshot";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  billingCustomers,
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
 * Bifrost #254 (06.3): the Reserve write path's ACCOUNT-level atomicity, proven on a real
 * PostgreSQL (TEST_DATABASE_URL; the dedicated 5590 verify database, never the live one).
 *
 * THE INVARIANT (ADR 0003, parent spec Q5): every Bot key that resolves to one payer account
 * competes for the SAME spendable balance. With balance 10 and two concurrent holds of 8,
 * exactly ONE request reserves and the provider behind it is dispatched once; the loser is
 * refused with the balance AS IT STOOD WHEN IT EVALUATED (2, after the winner's hold) and
 * writes nothing. A per-key or per-grant balance would admit both and overspend the account.
 *
 * HOW CONCURRENCY IS PROVEN, WITHOUT SLEEP LUCK. Two complementary choreographies:
 * - Natural race: two `service.reserve` calls via `Promise.all`, each on its own pool
 *   connection, its own transaction. Under a correct account lock exactly one wins; with the
 *   lock removed both read balance 10 and both reserve — the assertions below fail.
 * - Deterministic interleaving: T1 runs `reserveCreditInTransaction` inside an explicit
 *   transaction that, after the writer returns (account row lock HELD, reservation written
 *   but uncommitted), signals and parks on a gate. A third connection probes the
 *   `billing_customers` row with `FOR UPDATE NOWAIT`: before T1 the probe must succeed
 *   (self-proving the probe query is valid), while T1 is gated it must fail — the account
 *   lock is demonstrably held at that instant. Only then does T2 start and the gate release,
 *   so T2's capacity read provably happens after T1's commit. No timing assumptions.
 *
 * Isolation: gateway tables are append-only or shared singletons (mirrors #253 — unique
 * provider per world; the sync-state singleton is upserted fresh by every world). Credit,
 * payer, grant and bot fixtures are deleted by prefix in afterAll: the credit-side columns
 * carry the DERIVED account key (`openbot-personal-<prefix>…`, review-253 F1), so those
 * cleanups use the derived-key prefix — and prove it by counting rows before deleting.
 */

const FRESH_WINDOW_MS = 15 * 60 * 1000;
/**
 * The concurrency file's own pool: T1 + T2 + the NOWAIT probe + main-thread assertions must
 * coexist while T1 is gated. (support/database.ts: a file with special connection needs asks
 * for its own pool; TEST_POOL's max 2 is the default, not a cap.)
 */
const database = createDatabase(testDatabaseUrl(), { max: 6, ...TEST_POOL });
/** Single connection reserved for `FOR UPDATE NOWAIT` lock probes. */
const probeDb = createDatabase(testDatabaseUrl(), { max: 1 });

const prefix = `b5-254-${randomUUID().slice(0, 8)}`;
/** Fixture-side writer: seeds credit grants only; the unit under test builds its own over the transaction. */
const fixtureCreditWriter = createCreditWriter(database);

const service = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: FRESH_WINDOW_MS,
});

/** The transaction environment every explicit T1 choreography passes to the reserve core. */
const ENV = {
  now: () => new Date(),
  catalogFreshnessWindowMs: FRESH_WINDOW_MS,
};

/** A priced catalog entry fixture: every wire-priced dimension carries an exact amount. */
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

type WorldOptions = {
  /** Whole credits deposited (×100 on the way in). */
  credits?: number;
  /** How many bot+grant pairs share the world's ONE payer account. */
  grants?: number;
};

type ReservedWorld = {
  userId: string;
  customerKey: string;
  grantIds: string[];
  request: CreditReserveRequest;
};

let worldCounter = 0;

/**
 * One complete world where a reserve SHOULD succeed: `grants` active bots holding active
 * grants for one user, a personal payer account carrying `credits`, an open cataloged ref
 * whose latest price snapshot is fully known, and a fresh catalog sync. Every request names
 * its own grant and idempotency key; the account key is shared by construction.
 */
async function seedWorld(options: WorldOptions = {}): Promise<ReservedWorld> {
  const n = ++worldCounter;
  const credits = options.credits ?? 10;
  const grantCount = options.grants ?? 1;
  const userId = `${prefix}-user-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;

  await createPayerAccount(database, {
    kind: "personal",
    id: userId,
  });
  const customerKey = payerKey({ kind: "personal", id: userId });
  if (credits > 0) {
    await fixtureCreditWriter.grantCredits({
      externalCustomerId: customerKey,
      source: "plan",
      totalCents: credits * 100,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      idempotencyKey: `${prefix}-seed-${n}`,
    });
  }

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
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: null,
    },
  ]);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "chat",
    state: "open",
    reason: "reserve-concurrency fixture",
    changedBy: "test",
  });
  await database
    .insert(gatewayCatalogSyncState)
    .values({
      id: GATEWAY_CATALOG_SYNC_STATE_ID,
      lastSuccessfulSyncAt: new Date(Date.now() - 60 * 1000),
    })
    .onConflictDoUpdate({
      target: gatewayCatalogSyncState.id,
      set: { lastSuccessfulSyncAt: new Date(Date.now() - 60 * 1000) },
    });

  const grantIds: string[] = [];
  for (let i = 0; i < grantCount; i++) {
    const botId = `${prefix}-bot-${n}-${i}`;
    const grantId = `${prefix}-grant-${n}-${i}`;
    grantIds.push(grantId);
    await database.insert(botServices).values({
      botId,
      displayName: `Concurrency Bot ${n}-${i}`,
      kind: "external",
      capabilities: ["chat"],
      status: "active",
    });
    await database.insert(accessGrants).values({
      grantId,
      userId,
      botId,
      externalIdentity: `${prefix}:ext:${n}:${i}`,
      scope: "model-access",
      status: "active",
      revokedAt: null,
    });
  }

  const request: CreditReserveRequest = {
    grantId: grantIds[0],
    payer: { kind: "personal", id: userId },
    model: { provider, model, capability: "chat" },
    snapshotVersion: 1,
    rateVersion: 0,
    boundEvidence: [
      { kind: "provider_max_tokens", maximumTokens: 4096 },
      { kind: "self_enforced_input_truncation", maximumTokens: 8192 },
    ],
    maximumCredits: 500,
    idempotencyKey: `${prefix}-idem-${n}-0`,
  };
  return { userId, customerKey, grantIds, request };
}

/** A copy of a world's request with its own retry identity and hold ceiling. */
function requestLike(
  world: ReservedWorld,
  grantIndex: number,
  tag: string,
  maximumCredits: number,
): CreditReserveRequest {
  return {
    ...world.request,
    grantId: world.grantIds[grantIndex] ?? world.request.grantId,
    maximumCredits,
    idempotencyKey: `${world.request.idempotencyKey}-${tag}`,
  };
}

/** Reservation rows held against accounts whose derived key matches the pattern. */
async function reservationsOf(customerKey: string) {
  return database
    .select({
      id: creditReservations.id,
      idempotencyKey: creditReservations.idempotencyKey,
      status: creditReservations.status,
      maximum: creditReservations.maximum,
    })
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, customerKey));
}

async function reservationsLike(pattern: string) {
  return database
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(like(creditReservations.externalCustomerId, pattern));
}

/**
 * `FOR NO KEY UPDATE NOWAIT` against the account's billing_customers row: false = the
 * write lock is free, true = some transaction holds it. Deliberately NO KEY UPDATE, not
 * FOR UPDATE: an uncommitted reservation insert only holds a foreign-key FOR KEY SHARE on
 * this row, which NO KEY UPDATE deliberately tolerates — so this probe reports exactly the
 * account-serializing write lock (`lockCustomer`'s FOR UPDATE), never the mere existence of
 * the reservation row. Only meaningful after the probe has succeeded once on the same row
 * (self-proving the query itself is valid).
 */
async function accountLockHeld(customerKey: string): Promise<boolean> {
  try {
    await probeDb.execute(
      sql`select external_id from billing_customers where external_id = ${customerKey} for no key update nowait`,
    );
    return false;
  } catch {
    return true;
  }
}

/** The deterministic T1: reserve inside an explicit transaction, signal, park on a gate. */
function gatedReserve(
  request: CreditReserveRequest,
  ready: () => void,
  gate: Promise<void>,
) {
  return database.transaction(async (tx) => {
    const outcome = await reserveCreditInTransaction(tx, request, ENV);
    // The writer has returned: the account row lock is HELD and the reservation row is
    // written but invisible outside this transaction.
    ready();
    await gate;
    return outcome;
  });
}

/**
 * Run one gated choreography with a guaranteed gate release: a failed assertion must not
 * orphan T1's open transaction on its pool connection (it would poison every later test).
 * The callback receives the gate T1 parks on and the release that resolves it.
 */
async function choreograph<T>(
  run: (gate: Promise<void>, release: () => void) => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    return await run(gate, release);
  } finally {
    release();
  }
}

/** Assert the losing side of a race: refused, the standing balance, no residue of its own. */
function expectLoser(
  outcome: CreditReserveOutcome,
  request: CreditReserveRequest,
): void {
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("insufficient_credits");
  // The balance AS IT STOOD when the loser evaluated: the winner's 8 is already held.
  expect(outcome.detail).toMatchObject({ availableCredits: 2 });
  // The refusal carries no reservation identity — there is nothing to dispatch against.
  expect(outcome.detail.reservationId).toBeUndefined();
  expect(request.idempotencyKey).toBeTruthy();
}

afterAll(async () => {
  // Prove the derived-key patterns match real rows BEFORE deleting (a silent zero-match
  // cleanup is exactly the review-253 F1 defect), then prove nothing remains.
  const derived = `openbot-personal-${prefix}%`;
  expect((await reservationsLike(derived)).length).toBeGreaterThan(0);
  expect(
    (
      await database
        .select({ id: creditGrants.id })
        .from(creditGrants)
        .where(like(creditGrants.externalCustomerId, derived))
    ).length,
  ).toBeGreaterThan(0);
  expect(
    (
      await database
        .select({ externalId: billingCustomers.externalId })
        .from(billingCustomers)
        .where(like(billingCustomers.externalId, derived))
    ).length,
  ).toBeGreaterThan(0);
  expect(
    (
      await database
        .select({ id: payerAccounts.id })
        .from(payerAccounts)
        .where(like(payerAccounts.payerId, `${prefix}%`))
    ).length,
  ).toBeGreaterThan(0);

  // Credit-side tables are keyed by the DERIVED account key (F1 lesson).
  await database
    .delete(creditReservations)
    .where(like(creditReservations.externalCustomerId, derived));
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${derived}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${derived}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${derived}`,
  );
  await database.delete(payerAccounts).where(like(payerAccounts.payerId, `${prefix}%`));
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${derived}`,
  );
  // Access, bot and gateway fixtures key on raw ids, so the raw prefix is correct here.
  await database.delete(accessGrants).where(like(accessGrants.grantId, `${prefix}%`));
  await database.delete(botServices).where(like(botServices.botId, `${prefix}%`));
  await database
    .delete(gatewayModelOpenScopes)
    .where(like(gatewayModelOpenScopes.provider, `${prefix}%`));
  await database
    .delete(gatewayModelCatalogRefs)
    .where(like(gatewayModelCatalogRefs.provider, `${prefix}%`));
  // gateway_price_snapshots is append-only (0133); every world isolates itself by provider.

  expect(await reservationsLike(derived)).toHaveLength(0);
  expect(
    await database
      .select({ id: creditGrants.id })
      .from(creditGrants)
      .where(like(creditGrants.externalCustomerId, derived)),
  ).toHaveLength(0);
  expect(
    await database
      .select({ externalId: billingCustomers.externalId })
      .from(billingCustomers)
      .where(like(billingCustomers.externalId, derived)),
  ).toHaveLength(0);
  await database.$client.close();
  await probeDb.$client.close();
});

// ── AC1: balance 10, two concurrent holds of 8 → one reservation, one dispatch ──────

test("two concurrent limit-8 reserves against balance 10: one wins, one sees 2, one row", async () => {
  const world = await seedWorld({ credits: 10 });
  const first = requestLike(world, 0, "a1", 800);
  const second = requestLike(world, 0, "a2", 800);

  const [left, right] = await Promise.all([
    service.reserve(first),
    service.reserve(second),
  ]);
  const outcomes = [left, right];
  const winners = outcomes.filter(
    (outcome): outcome is Extract<CreditReserveOutcome, { status: "reserved" }> =>
      outcome.status === "reserved",
  );
  const losers = outcomes.filter(
    (outcome): outcome is Extract<CreditReserveOutcome, { status: "refused" }> =>
      outcome.status === "refused",
  );

  // Exactly one admitted — downstream, that is exactly one provider dispatch.
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0].reasonCode).toBe("insufficient_credits");
  expect(losers[0].detail).toMatchObject({ availableCredits: 2 });

  const rows = await reservationsOf(world.customerKey);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("reserved");
  expect(rows[0].maximum).toBe(800);
  expect(rows[0].id).toBe(winners[0].reservationId);
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(200);
});

// ── AC1/AC4: the same race with the interleaving nailed down deterministically ──────

test("deterministic interleaving: T2 evaluates only after T1's hold commits", async () => {
  const world = await seedWorld({ credits: 10 });
  // The probe query must prove itself on an unlocked row before it may serve as evidence.
  expect(await accountLockHeld(world.customerKey)).toBe(false);

  await choreograph(async (gate, release) => {
    let ready!: () => void;
    const t1Ready = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const t1Request = requestLike(world, 0, "b1", 800);
    const t1Promise = gatedReserve(t1Request, ready, gate);
    await t1Ready;

    // While T1 is gated mid-reserve, the account row write lock is demonstrably held by the
    // production path: NOWAIT cannot take it. (Program order: T2 is only ever started AFTER
    // T1's writer returned, so under a correct lock T2's capacity read can only happen after
    // T1's commit — the gate removes the race the natural tests tolerate.)
    expect(await accountLockHeld(world.customerKey)).toBe(true);

    // T2 starts only now, so its capacity read cannot precede T1's uncommitted hold — and
    // it cannot complete until the gate releases T1's commit.
    const t2Request = requestLike(world, 0, "b2", 800);
    const t2Promise = service.reserve(t2Request);
    release();

    const [t1, t2] = await Promise.all([t1Promise, t2Promise]);
    expect(t1.status).toBe("reserved");
    expectLoser(t2, t2Request);

    const rows = await reservationsOf(world.customerKey);
    expect(rows).toHaveLength(1);
    if (t1.status !== "reserved") return;
    expect(rows[0].id).toBe(t1.reservationId);
    expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(200);
  });
});

// ── AC2: two different bots' keys compete for ONE account, never one each ───────────

test("deterministic cross-key race: bot B's key waits on bot A's hold of the same account", async () => {
  const world = await seedWorld({ credits: 10, grants: 2 });
  expect(await accountLockHeld(world.customerKey)).toBe(false);

  await choreograph(async (gate, release) => {
    let ready!: () => void;
    const t1Ready = new Promise<void>((resolve) => {
      ready = resolve;
    });

    // T1 holds the account through bot A's grant…
    const t1Request = requestLike(world, 0, "c1", 800);
    const t1Promise = gatedReserve(t1Request, ready, gate);
    await t1Ready;
    expect(await accountLockHeld(world.customerKey)).toBe(true);

    // …and bot B's key can only have drawn from the same pool: it finds 2, not its own 10.
    const t2Request = requestLike(world, 1, "c2", 800);
    const t2Promise = service.reserve(t2Request);
    release();

    const [t1, t2] = await Promise.all([t1Promise, t2Promise]);
    expect(t1.status).toBe("reserved");
    expectLoser(t2, t2Request);

    // ONE reservation on the shared account — a per-key balance would have produced two.
    const rows = await reservationsOf(world.customerKey);
    expect(rows).toHaveLength(1);
    if (t1.status !== "reserved") return;
    expect(rows[0].id).toBe(t1.reservationId);
    expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(200);
  });
});

test("natural cross-key race: two bots, one account, one winner", async () => {
  const world = await seedWorld({ credits: 10, grants: 2 });
  const [left, right] = await Promise.all([
    service.reserve(requestLike(world, 0, "d1", 800)),
    service.reserve(requestLike(world, 1, "d2", 800)),
  ]);
  const outcomes = [left, right];
  expect(outcomes.filter((outcome) => outcome.status === "reserved")).toHaveLength(1);
  const losers = outcomes.filter(
    (outcome): outcome is Extract<CreditReserveOutcome, { status: "refused" }> =>
      outcome.status === "refused",
  );
  expect(losers[0].reasonCode).toBe("insufficient_credits");
  expect(losers[0].detail).toMatchObject({ availableCredits: 2 });
  expect(await reservationsOf(world.customerKey)).toHaveLength(1);
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(200);
});

// ── AC3: the failed request writes nothing and answers the standing balance ─────────

test("the losing reserve leaves zero writes and never occupied capacity", async () => {
  const world = await seedWorld({ credits: 10 });
  expect(await accountLockHeld(world.customerKey)).toBe(false);

  await choreograph(async (gate, release) => {
    let ready!: () => void;
    const t1Ready = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const t1Request = requestLike(world, 0, "e1", 800);
    const t1Promise = gatedReserve(t1Request, ready, gate);
    await t1Ready;

    const t2Request = requestLike(world, 0, "e2", 800);
    const t2Promise = service.reserve(t2Request);
    release();

    const [t1, t2] = await Promise.all([t1Promise, t2Promise]);
    expect(t1.status).toBe("reserved");
    expectLoser(t2, t2Request);

    // The loser's retry identity owns no reservation row, and the account's ledger is empty:
    // nothing was written for the failed request.
    const loserRows = await database
      .select({ id: creditReservations.id })
      .from(creditReservations)
      .where(eq(creditReservations.idempotencyKey, t2Request.idempotencyKey));
    expect(loserRows).toHaveLength(0);
    const ledgerRows = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    expect(ledgerRows).toHaveLength(0);

    // The only hold on the account is the winner's. Releasing it returns the FULL balance —
    // proof the loser never occupied anything.
    const rows = await reservationsOf(world.customerKey);
    expect(rows).toHaveLength(1);
    if (t1.status !== "reserved") return;
    await fixtureCreditWriter.releaseReservation(t1.reservationId, "b5-254 test release");
    expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(1000);
  });
});
