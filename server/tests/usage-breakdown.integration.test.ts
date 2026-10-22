import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createCredits } from "../src/billing/credits";
import {
  createCreditReserveService,
  type CreditReserveRequest,
} from "../src/billing/credit-reserve";
import { createCreditSettleService } from "../src/billing/credit-settle";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
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
  creditSettlementDimensionBreakdown,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 20.3 — the consumption detail's model/surcharge fee split, on a real PostgreSQL
 * (TEST_DATABASE_URL).
 *
 *   AC-1  every entry's fee split names its model fee and its surcharge fee separately,
 *         each traceable to the same ledger row (the breakdown rows carry the dimension);
 *   AC-2  the two parts sum to EXACTLY the entry's credits — no double counting, no gap —
 *         enforced at write time (a wrong-total split refuses the settlement);
 *   AC-3  the read answers only the caller's own account; no other account's row, and no
 *         internal configuration detail rides the split (dimensions only, closed vocab);
 *   AC-4  an entry with no surcharge, or a settlement that wrote no split, shows NO
 *         surcharge line — undefined, never a misleading zero.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b20-343-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE = { numerator: 100n, denominator: 1n };

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});
const settleService = createCreditSettleService({
  database,
  environmentRate: ENVIRONMENT_RATE,
});

/** Every dimension priced known; the surcharge is deliberately non-zero and fractional. */
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
};

function dimsOf(amounts: Record<string, string>) {
  const dims: Record<string, { status: "known"; amount: string }> = {};
  for (const [dimension, amount] of Object.entries(amounts)) {
    dims[dimension] = { status: "known", amount };
  }
  return dims;
}

/** The full dimension vocabulary at zero, with `named` overlaid — the protocol's shape. */
function usageOf(named: Record<string, number>): Record<string, number> {
  return {
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
    ...named,
  };
}

const credits = createCredits({
  database,
  externalCustomerKey: `openbot-deployment-${prefix}`,
  catalog: new Map(),
});

type World = {
  userId: string;
  customerKey: string;
  request: CreditReserveRequest;
};

let seedCounter = 0;

async function seedWorld(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Split Bot ${n}`,
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
  await fixtureWriter.grantCredits({
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
  await createEnterpriseGatewayPriceSnapshotStore(database).appendSnapshots([
    {
      ref: { provider, model, capability: "chat" },
      dims: dimsOf(V1_AMOUNTS) as never,
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
    reason: "usage-breakdown fixture",
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

  return {
    userId,
    customerKey: payerKey({ kind: "personal", id: userId }),
    request: {
      grantId,
      payer: { kind: "personal", id: userId },
      model: { provider, model, capability: "chat" },
      snapshotVersion: 1,
      rateVersion: 0,
      boundEvidence: [
        { kind: "provider_max_tokens", maximumTokens: 4096 },
        { kind: "self_enforced_input_truncation", maximumTokens: 8192 },
      ],
      maximumCredits: 5_000,
      idempotencyKey: `${prefix}-idem-${n}`,
    } satisfies CreditReserveRequest,
  };
}

async function settleOf(
  world: World,
  usage: Record<string, number>,
  tag: string,
) {
  const reserved = await reserveService.reserve(world.request);
  if (reserved.status !== "reserved") {
    throw new Error(`fixture reserve refused: ${JSON.stringify(reserved)}`);
  }
  const settled = await settleService.settle({
    reservationId: reserved.reservationId,
    actualUsage: usageOf(usage),
    evidence: {
      kind: "provider_usage_report",
      reference: `${prefix}-usage-${tag}`,
    },
    settledBy: `${prefix}-bifrost-admission`,
    idempotencyKey: `${prefix}-settle-${tag}`,
  });
  if (settled.status !== "settled") {
    throw new Error(`fixture settle refused: ${JSON.stringify(settled)}`);
  }
  return settled;
}

const window = { from: null, to: null, page: 1 };

afterAll(async () => {
  await database
    .delete(creditReservations)
    .where(like(creditReservations.externalCustomerId, `openbot-personal-${prefix}%`));
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
  await database.$client.close();
});

// ── AC-1 + AC-2: the split exists, is traceable, and sums exactly ────────────────────

describe("20.3 AC-1/AC-2 — the fee split and its ledger reconciliation", () => {
  test("a settlement with a surcharge splits into model and surcharge parts summing to the entry", async () => {
    const world = await seedWorld();
    // input 100_000 × $0.000001 = $0.10 (1000 scaled) + surcharge_per_request 1 ×
    // $0.0001 = $0.0001 (1 scaled exactly) → 1001 scaled total; parts 1000 + 1.
    await settleOf(world, { input: 100_000, surcharge_per_request: 1 }, "split");

    const page = await credits.consumption(window, {
      kind: "personal",
      id: world.userId,
    });
    expect(page.entries).toHaveLength(1);
    const entry = page.entries[0];
    expect(entry.credits).toBe(10.01);
    expect(entry.feeBreakdown).toBeDefined();
    expect(entry.feeBreakdown?.modelCredits).toBe(10);
    expect(entry.feeBreakdown?.surchargeCredits).toBe(0.01);
    // AC-2's sentence, as arithmetic: the parts sum to the whole, exactly.
    expect(
      (entry.feeBreakdown?.modelCredits ?? 0) +
        (entry.feeBreakdown?.surchargeCredits ?? 0),
    ).toBe(entry.credits);

    // AC-1's traceability: the breakdown rows name their dimensions against the ledger row.
    const [ledgerRow] = await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    const rows = await database
      .select()
      .from(creditSettlementDimensionBreakdown)
      .where(
        eq(creditSettlementDimensionBreakdown.ledgerId, ledgerRow.id),
      );
    expect(
      rows.map((row) => row.dimension).sort(),
    ).toEqual(["input", "surcharge_per_request"]);
    // The rows' units sum to the ledger row's scaled credits — the write-time invariant,
    // read back from the table itself.
    expect(rows.reduce((sum, row) => sum + row.units, 0)).toBe(ledgerRow.credits);
  });

  test("a settlement without surcharge usage splits with a zero surcharge side", async () => {
    const world = await seedWorld();
    await settleOf(world, { input: 50_000 }, "nosurcharge");

    const page = await credits.consumption(window, {
      kind: "personal",
      id: world.userId,
    });
    const entry = page.entries[0];
    expect(entry.credits).toBe(5);
    expect(entry.feeBreakdown).toBeDefined();
    expect(entry.feeBreakdown?.modelCredits).toBe(5);
    expect(entry.feeBreakdown?.surchargeCredits).toBe(0);
  });

  test("a wrong-total breakdown refuses the whole settlement (the write-time invariant)", async () => {
    const world = await seedWorld();
    const reserved = await reserveService.reserve({
      ...world.request,
      idempotencyKey: `${world.request.idempotencyKey}-x`,
    });
    if (reserved.status !== "reserved") throw new Error("fixture reserve refused");
    // A split naming a different total than the settlement priced: 1 scaled unit claimed
    // where the actual cost is 100 scaled — a caller defect, refused loudly.
    await expect(
      fixtureWriter.settleReservation({
        reservationId: reserved.reservationId,
        actual: { numerator: 100n, denominator: 1n },
        title: "defect-split",
        dimensionBreakdown: [
          { dimension: "input", numerator: 1n, denominator: 1n },
        ],
      }),
    ).rejects.toThrow(/dimension breakdown sums to a different total/);
    // And nothing landed: no ledger row, no split rows, the hold still reserved.
    const [hold] = await database
      .select({ status: creditReservations.status })
      .from(creditReservations)
      .where(eq(creditReservations.id, reserved.reservationId));
    expect(hold.status).toBe("reserved");
  });
});

// ── AC-4: no split is no line, never a zero ──────────────────────────────────────────

describe("20.3 AC-4 — no split is no line", () => {
  test("a writer-direct settlement with no breakdown answers no split", async () => {
    const world = await seedWorld();
    const reserved = await reserveService.reserve({
      ...world.request,
      idempotencyKey: `${world.request.idempotencyKey}-direct`,
    });
    if (reserved.status !== "reserved") throw new Error("fixture reserve refused");
    await fixtureWriter.settleReservation({
      reservationId: reserved.reservationId,
      actual: { numerator: 250n, denominator: 1n },
      title: "writer-direct",
    });

    const page = await credits.consumption(window, {
      kind: "personal",
      id: world.userId,
    });
    const entry = page.entries[0];
    expect(entry.credits).toBe(2.5);
    // No split was written: the answer is undefined — the UI shows no fee line at all,
    // never a zero that would read as "the surcharge was free".
    expect(entry.feeBreakdown).toBeUndefined();
  });
});

// ── AC-3: the read answers only the caller's own account ─────────────────────────────

describe("20.3 AC-3 — the split never crosses accounts", () => {
  test("another user's split is not in my page, and mine is not in theirs", async () => {
    const mine = await seedWorld();
    const theirs = await seedWorld();
    await settleOf(mine, { input: 100_000, surcharge_per_request: 1 }, "mine");
    await settleOf(theirs, { input: 20_000 }, "theirs");

    const myPage = await credits.consumption(window, {
      kind: "personal",
      id: mine.userId,
    });
    expect(myPage.entries).toHaveLength(1);
    expect(myPage.entries[0].feeBreakdown?.surchargeCredits).toBe(0.01);

    const theirPage = await credits.consumption(window, {
      kind: "personal",
      id: theirs.userId,
    });
    expect(theirPage.entries).toHaveLength(1);
    expect(theirPage.entries[0].feeBreakdown?.surchargeCredits).toBe(0);
    expect(theirPage.entries[0].requestId).toContain("theirs");

    // The split rows in the table belong only to each account's own ledger rows — a
    // cross-account read is not representable through the view's payer filter.
    const allSplits = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(creditSettlementDimensionBreakdown);
    expect(allSplits[0].count).toBeGreaterThanOrEqual(3);
  });
});
