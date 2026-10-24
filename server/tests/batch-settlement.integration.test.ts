import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createBatchSubmitService } from "../src/billing/batch-submit";
import {
  createBatchSettleService,
  readBatchSettlementDetails,
} from "../src/billing/batch-settlement";
import { createCreditReserveService } from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { resolveLockedReservationBasis } from "../src/billing/reserve-bound";
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
  batchJobs,
  creditBatchSettlementDetails,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 18.2 (#334) — per-item settlement of a terminal batch, on a real PostgreSQL
 * (TEST_DATABASE_URL).
 *
 *   AC-1  every item settles on its REAL usage, priced on its own cell at the batch's
 *         locked versions, and the amount traces to the item;
 *   AC-2  the per-item amounts' sum never exceeds the whole-batch reservation cap;
 *   AC-3  the unused share of the hold hands back — the available balance recovers;
 *   AC-4  the consumption detail attributes at BOTH levels: the batch (one ledger row)
 *         and every item (its own line, the same ledger id).
 *
 * Plus the money fence the credit protocol owns: a replayed report settles once (the
 * reservation's own settle fence replays the first result), an amended report refuses as
 * a conflict (never a top-up), and a report that does not cover every item of the batch
 * refuses — partiality is 18.3's slice, never a guessed settlement.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b18-334-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE = { numerator: 100n, denominator: 1n };

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});

const A_AMOUNTS = {
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
  video_input: "0",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
};
const B_AMOUNTS = { ...A_AMOUNTS, video: "0.02", cache_read: "0.0000002" };

function dimsOf(amounts: Record<string, string>) {
  const dims: Record<string, { status: "known"; amount: string }> = {};
  for (const [dimension, amount] of Object.entries(amounts)) {
    dims[dimension] = { status: "known", amount };
  }
  return dims;
}

let dispatchCounter = 0;
const dispatch = async () =>
  ({ kind: "answered", providerBatchId: `prov-batch-${++dispatchCounter}` }) as const;

async function resolveBasis(basis: {
  provider: string;
  model: string;
  capability: string;
  snapshotVersion: number;
  rateVersion: number;
}) {
  const resolved = await resolveLockedReservationBasis(
    { database, environmentRate: ENVIRONMENT_RATE },
    basis,
  );
  return resolved.resolved
    ? { ok: true as const, dims: resolved.dims, rate: resolved.rate }
    : { ok: false as const, reason: resolved.reason };
}

/** The audit spy — the over-cap anomaly's trail, counted not inspected. */
function makeAudit() {
  const events: { eventType: string; targetId?: string }[] = [];
  return {
    events,
    store: {
      insert: async (event: { eventType: string; targetId?: string }) => {
        events.push({ eventType: event.eventType, targetId: event.targetId });
      },
    },
  };
}

const submitService = createBatchSubmitService({
  database,
  reserve: (request) => reserveService.reserve(request),
  dispatch,
  resolveBasis,
});

const settleService = createBatchSettleService({
  database,
  environmentRate: ENVIRONMENT_RATE,
});

type World = {
  userId: string;
  grantId: string;
  provider: string;
  modelA: string;
  modelB: string;
  customerKey: string;
  batchId: string;
  reservationId: string;
  cap: number;
  balanceBefore: number;
};

let seedCounter = 0;

/** Submit the standard 3-item mixed-model batch and return the world it lives in. */
async function seedSettledWorld(
  options: { balanceCents?: number } = {},
): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const modelA = `model-a-${n}`;
  const modelB = `model-b-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Batch Bot ${n}`,
    kind: "external",
    capabilities: ["async"],
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
    totalCents: options.balanceCents ?? 10_000_00,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-seed-grant-${n}`,
  });

  const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
  for (const [model, amounts, capability] of [
    [modelA, A_AMOUNTS, "video"],
    [modelB, B_AMOUNTS, "chat"],
  ] as const) {
    await database.insert(gatewayModelCatalogRefs).values({
      provider,
      model,
      capability,
      capabilitySource: "supported_methods",
      rawEntry: { id: `${provider}/${model}` },
      configVersion: 1,
      fetchedAt: new Date(),
    });
    await snapshotStore.appendSnapshots([
      {
        ref: { provider, model, capability },
        dims: dimsOf(amounts) as never,
        fetchedAt: new Date().toISOString(),
        source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
        configVersion: 1,
        rateVersion: null,
      },
    ]);
    await database.insert(gatewayModelOpenScopes).values({
      provider,
      model,
      capability,
      state: "open",
      reason: "batch-settlement fixture",
      changedBy: "test",
    });
  }
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

  const balanceBefore = await fixtureWriter.availableBalance(
    payerKey({ kind: "personal", id: userId }),
  );
  const submitted = await submitService.submit({
    submitIdempotencyKey: `${prefix}-submit-${n}`,
    grantId,
    payer: { kind: "personal", id: userId },
    snapshotVersion: 1,
    rateVersion: 0,
    items: [
      {
        customId: "req-1",
        model: { provider, model: modelA, capability: "video" },
        quantities: { video: 60, surcharge_per_request: 1 },
      },
      {
        customId: "req-2",
        model: { provider, model: modelB, capability: "chat" },
        quantities: { video: 30 },
      },
      {
        customId: "req-3",
        model: { provider, model: modelA, capability: "video" },
        quantities: { image: 2 },
      },
    ],
  });
  if (submitted.status !== "submitted") throw new Error("fixture submit failed");

  return {
    userId,
    grantId,
    provider,
    modelA,
    modelB,
    customerKey: payerKey({ kind: "personal", id: userId }),
    batchId: submitted.batchId,
    reservationId: submitted.reservationId,
    cap: submitted.maximumCredits,
    balanceBefore,
  };
}

/** The terminal report fixture: every item terminal with real, per-item usage. */
const terminalReport = () => ({
  batchId: "" as string,
  source: "poll" as const,
  items: [
    { customId: "req-1", terminalState: "completed" as const, usage: { video: 30 } },
    { customId: "req-2", terminalState: "completed" as const, usage: { video: 10 } },
    { customId: "req-3", terminalState: "failed" as const, usage: { image: 1 } },
  ],
});

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_batch_settlement_details WHERE batch_id IN (SELECT batch_id FROM batch_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database.execute(
    sql`DELETE FROM batch_items WHERE batch_id IN (SELECT batch_id FROM batch_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database
    .delete(batchJobs)
    .where(like(batchJobs.grantId, `${prefix}%`));
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

// ── AC-1/AC-2: per-item real-usage settlement ───────────────────────────────────────

describe("18.2 AC-1/AC-2 — every item settles on its real usage", () => {
  test("per-item amounts are exact, attributable, and their sum stays under the cap", async () => {
    const world = await seedSettledWorld();
    const report = terminalReport();
    report.batchId = world.batchId;
    const outcome = await settleService.settleBatch(report);
    expect(outcome.status).toBe("settled");
    if (outcome.status !== "settled") return;

    // req-1 (cell A): 30×$0.01 = $0.30 → 3000 scaled exact.
    // req-2 (cell B): 10×$0.02 = $0.20 → 2000 scaled exact (B's own price).
    // req-3 (cell A): 1×$0.01  = $0.01 → 1000/10 → 100 scaled exact.
    expect(outcome.itemCosts).toEqual([
      { customId: "req-1", exact: { numerator: "3000", denominator: "1" } },
      { customId: "req-2", exact: { numerator: "2000", denominator: "1" } },
      { customId: "req-3", exact: { numerator: "100", denominator: "1" } },
    ]);
    // Σ exact = 5100 ≤ the whole-batch cap (12201).
    expect(outcome.actualCost).toEqual({ numerator: "5100", denominator: "1" });
    expect(BigInt(outcome.actualCost.numerator)).toBeLessThanOrEqual(
      BigInt(world.cap),
    );
    expect(outcome.chargedCredits).toBe(5100);
  });

  test("the ledger carries ONE row for the batch, named by the batch id", async () => {
    const world = await seedSettledWorld();
    const report = terminalReport();
    report.batchId = world.batchId;
    await settleService.settleBatch(report);

    const rows = await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.requestId, world.batchId));
    expect(rows.length).toBe(1);
    expect(rows[0].credits).toBe(5100);
    expect(rows[0].idempotencyKey).toBe(`reservation:${world.reservationId}`);
  });
});

// ── AC-3: the unused share hands back ───────────────────────────────────────────────

describe("18.2 AC-3 — the unused share of the hold hands back", () => {
  test("released = cap − charged, and the available balance recovers to seed − charged", async () => {
    const world = await seedSettledWorld();
    const report = terminalReport();
    report.batchId = world.batchId;
    const outcome = await settleService.settleBatch(report);
    if (outcome.status !== "settled") throw new Error("settle failed");

    expect(outcome.releasedCredits).toBe(world.cap - 5100);

    const balanceAfter = await fixtureWriter.availableBalance(world.customerKey);
    expect(balanceAfter).toBe(world.balanceBefore - 5100);

    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, world.reservationId));
    expect(hold.status).toBe("settled");
    expect(hold.charged).toBe(5100);
    expect(hold.released).toBe(world.cap - 5100);
  });
});

// ── AC-4: two-level attribution ─────────────────────────────────────────────────────

describe("18.2 AC-4 — consumption detail at both levels", () => {
  test("one batch level (the ledger row) and one item level per line, same ledger id", async () => {
    const world = await seedSettledWorld();
    const report = terminalReport();
    report.batchId = world.batchId;
    const outcome = await settleService.settleBatch(report);
    if (outcome.status !== "settled") throw new Error("settle failed");

    const details = await readBatchSettlementDetails(database, world.batchId);
    expect(details.length).toBe(3);
    expect(details[0].ledgerId).toBe(details[1].ledgerId);
    expect(details[1].ledgerId).toBe(details[2].ledgerId);

    const byCustom = new Map(details.map((d) => [d.customId, d]));
    const first = byCustom.get("req-1");
    if (!first) throw new Error("req-1 detail missing");
    expect(first.batchId).toBe(world.batchId);
    expect(first.model).toBe(world.modelA);
    expect(first.terminalState).toBe("completed");
    expect(first.actualUsage.video).toBe(30);
    expect(first.exactCost).toEqual({ numerator: "3000", denominator: "1" });

    const second = byCustom.get("req-2");
    if (!second) throw new Error("req-2 detail missing");
    expect(second.model).toBe(world.modelB);
    expect(second.terminalState).toBe("completed");

    const third = byCustom.get("req-3");
    if (!third) throw new Error("req-3 detail missing");
    expect(third.terminalState).toBe("failed");
    expect(third.exactCost).toEqual({ numerator: "100", denominator: "1" });

    // Every item line joins the ONE ledger row of the batch.
    const ledgerRows = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.requestId, world.batchId));
    expect(ledgerRows.length).toBe(1);
    for (const detail of details) {
      expect(detail.ledgerId).toBe(ledgerRows[0].id);
    }
  });
});

// ── The money fence: settle once, refuse amendments and partial reports ─────────────

describe("18.2 — the settle fence", () => {
  test("a replayed identical report settles once — same answer, no second ledger row", async () => {
    const world = await seedSettledWorld();
    const report = terminalReport();
    report.batchId = world.batchId;
    const first = await settleService.settleBatch(report);
    if (first.status !== "settled") throw new Error("first settle failed");
    const second = await settleService.settleBatch(report);

    expect(second.status).toBe("settled");
    if (second.status !== "settled") return;
    expect(second.chargedCredits).toBe(first.chargedCredits);
    expect(second.releasedCredits).toBe(first.releasedCredits);

    const ledgerRows = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(creditLedger)
      .where(eq(creditLedger.requestId, world.batchId));
    expect(ledgerRows[0].count).toBe(1);
    const detailRows = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(creditBatchSettlementDetails)
      .where(eq(creditBatchSettlementDetails.batchId, world.batchId));
    expect(detailRows[0].count).toBe(3);
  });

  test("an amended report (different usage) refuses as a conflict, never a top-up", async () => {
    const world = await seedSettledWorld();
    const report = terminalReport();
    report.batchId = world.batchId;
    await settleService.settleBatch(report);

    const amended = terminalReport();
    amended.batchId = world.batchId;
    amended.items[0] = {
      customId: "req-1",
      terminalState: "completed",
      usage: { video: 40 },
    };
    const outcome = await settleService.settleBatch(amended);
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("settlement_conflict");

    const ledgerRows = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(creditLedger)
      .where(eq(creditLedger.requestId, world.batchId));
    expect(ledgerRows[0].count).toBe(1);
  });

  test("a report naming an item the batch never had refuses", async () => {
    const world = await seedSettledWorld();
    const report = terminalReport();
    report.batchId = world.batchId;
    report.items[2] = {
      customId: "req-999",
      terminalState: "completed",
      usage: { image: 1 },
    };
    const outcome = await settleService.settleBatch(report);
    expect(outcome.status).toBe("refused");
  });

  test("a report that does not cover every item refuses — partiality is 18.3's, never a guess", async () => {
    const world = await seedSettledWorld();
    const report = terminalReport();
    report.batchId = world.batchId;
    report.items = report.items.slice(0, 2);
    const outcome = await settleService.settleBatch(report);
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("items_incomplete");

    // Nothing settled, nothing written: the hold is untouched.
    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, world.reservationId));
    expect(hold.status).toBe("reserved");
  });

  test("settling by providerBatchId resolves the same batch (the notification lane)", async () => {
    const world = await seedSettledWorld();
    const [batch] = await database
      .select()
      .from(batchJobs)
      .where(eq(batchJobs.batchId, world.batchId));
    const report = terminalReport();
    delete (report as { batchId?: string }).batchId;
    const outcome = await settleService.settleBatch({
      ...report,
      providerBatchId: batch.providerBatchId ?? undefined,
      source: "notification",
    });
    expect(outcome.status).toBe("settled");
  });
});

// ── The over-cap anomaly, out loud ──────────────────────────────────────────────────

describe("18.2 — over-cap terminal costs", () => {
  test("a terminal above the cap charges in full (held capacity applied), names the overage, audits", async () => {
    const world = await seedSettledWorld();
    const audit = makeAudit();
    const scoped = createBatchSettleService({
      database,
      environmentRate: ENVIRONMENT_RATE,
      audit: audit.store,
    });
    const report = terminalReport();
    report.batchId = world.batchId;
    // req-1 (cell A, video $0.01/unit): 20000 units = $200 = 2,000,000 scaled — far
    // above the whole-batch cap of 12201. The certifying bound is exceeded out loud.
    report.items[0] = {
      customId: "req-1",
      terminalState: "completed",
      usage: { video: 20_000 },
    };
    const outcome = await scoped.settleBatch(report);
    expect(outcome.status).toBe("settled");
    if (outcome.status !== "settled") return;
    expect(outcome.overCap).toBeDefined();
    if (outcome.overCap !== undefined) {
      expect(outcome.overCap.maximumCredits).toBe(world.cap);
      // 2,000,000 (req-1) + 2,000 (req-2) + 100 (req-3) — the exact terminal cost.
      expect(BigInt(outcome.overCap.actualCost.numerator)).toBe(2_002_100n);
    }
    expect(
      audit.events.filter(
        (event) => event.eventType === "billing.batch_settle_over_cap",
      ).length,
    ).toBe(1);

    // The ledger records the real cost in full; the hold caps what was applied.
    const [row] = await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.requestId, world.batchId));
    expect(row.credits).toBe(2_002_100);
    expect(row.applied).toBe(world.cap);
  });
});
