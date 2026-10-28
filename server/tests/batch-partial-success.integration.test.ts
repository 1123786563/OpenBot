import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createBatchSubmitService } from "../src/billing/batch-submit";
import {
  createBatchPartialSettleService,
  readBatchStatusView,
} from "../src/billing/batch-partial";
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
  batchItemOutcomes,
  batchJobs,
  creditBatchSettlementDetails,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 18.3 (#335) — partial success settles the items that ran and releases only the
 * share that carries no-charge evidence, on a real PostgreSQL (TEST_DATABASE_URL).
 *
 *   AC-1  completed items settle on their actual costs;
 *   AC-2  failed-but-billed items settle their actual costs too (a failure the provider
 *         billed is a cost, not a gift);
 *   AC-3  not-dispatched items release ONLY on evidence — an absent item without evidence
 *         is `unknown` and keeps the hold (the whole-batch release is the shortcut this
 *         ticket exists to refuse);
 *   AC-4  the batch's status names partiality and every class's count is queryable.
 *
 * The ticket's own acceptance shape: 5 items — 3 completed, 1 billed failure, 1
 * not-dispatched — settle 4, release 1.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b18-335-${randomUUID().slice(0, 8)}`;
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

const submitService = createBatchSubmitService({
  database,
  reserve: (request) => reserveService.reserve(request),
  dispatch,
  resolveBasis,
});

const partialService = createBatchPartialSettleService({
  database,
  environmentRate: ENVIRONMENT_RATE,
});

type World = {
  userId: string;
  grantId: string;
  customerKey: string;
  batchId: string;
  reservationId: string;
  cap: number;
  balanceBefore: number;
};

let seedCounter = 0;

/**
 * Submit the standard 5-item single-cell batch: every item certified {video: 10} at
 * $0.01/unit → each item's exact worst case 1000 scaled, the whole-batch cap 5000.
 */
async function seedPartialWorld(
  options: { itemCount?: number } = {},
): Promise<World> {
  const n = ++seedCounter;
  const itemCount = options.itemCount ?? 5;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
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
    totalCents: 10_000_00,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-seed-grant-${n}`,
  });

  await database.insert(gatewayModelCatalogRefs).values({
    provider,
    model,
    capability: "video",
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}` },
    configVersion: 1,
    fetchedAt: new Date(),
  });
  await createEnterpriseGatewayPriceSnapshotStore(database).appendSnapshots([
    {
      ref: { provider, model, capability: "video" },
      dims: dimsOf(A_AMOUNTS) as never,
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: null,
    },
  ]);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "video",
    state: "open",
    reason: "batch-partial fixture",
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

  const balanceBefore = await fixtureWriter.availableBalance(
    payerKey({ kind: "personal", id: userId }),
  );
  const items = Array.from({ length: itemCount }, (_, index) => ({
    customId: `req-${index + 1}`,
    model: { provider, model, capability: "video" },
    quantities: { video: 10 },
  }));
  const submitted = await submitService.submit({
    submitIdempotencyKey: `${prefix}-submit-${n}`,
    grantId,
    payer: { kind: "personal", id: userId },
    snapshotVersion: 1,
    rateVersion: 0,
    items,
  });
  if (submitted.status !== "submitted") throw new Error("fixture submit failed");

  return {
    userId,
    grantId,
    customerKey: payerKey({ kind: "personal", id: userId }),
    batchId: submitted.batchId,
    reservationId: submitted.reservationId,
    cap: submitted.maximumCredits,
    balanceBefore,
  };
}

/** The ticket's own shape: 3 completed, 1 billed failure, 1 not-dispatched with evidence. */
const partialReport = () => [
  { kind: "terminal" as const, customId: "req-1", terminalState: "completed" as const, usage: { video: 4 } },
  { kind: "terminal" as const, customId: "req-2", terminalState: "completed" as const, usage: { video: 4 } },
  { kind: "terminal" as const, customId: "req-3", terminalState: "completed" as const, usage: { video: 4 } },
  { kind: "terminal" as const, customId: "req-4", terminalState: "failed" as const, usage: { video: 2 } },
  {
    kind: "absent" as const,
    customId: "req-5",
    evidence: {
      kind: "not_dispatched" as const,
      reference: "provider-batch-status:request_counts.total=4",
    },
  },
];

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_batch_settlement_details WHERE batch_id IN (SELECT batch_id FROM batch_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database.execute(
    sql`DELETE FROM batch_item_outcomes WHERE batch_id IN (SELECT batch_id FROM batch_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
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

// ── AC-1/AC-2: completed and billed-failed items settle ─────────────────────────────

describe("18.3 AC-1/AC-2 — the ticket's own shape settles 4 and releases 1", () => {
  test("3 completed + 1 billed failure settle; the not-dispatched item releases on evidence", async () => {
    const world = await seedPartialWorld();
    const outcome = await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports: partialReport(),
      source: "poll",
    });
    expect(outcome.status).toBe("settled");
    if (outcome.status !== "settled") return;

    // 3 × (4 × $0.01 → 400) + 1 × (2 × $0.01 → 200) = 1400 charged.
    expect(outcome.chargedCredits).toBe(1400);
    // The not-dispatched item's certified share (1000) hands back WITH the settle, on its
    // evidence: released = cap 5000 − 1400 = 3600.
    expect(outcome.releasedCredits).toBe(world.cap - 1400);

    const balanceAfter = await fixtureWriter.availableBalance(world.customerKey);
    expect(balanceAfter).toBe(world.balanceBefore - 1400);

    // The detail lines carry ONLY the 4 billed items (the released item has no charge).
    const details = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(creditBatchSettlementDetails)
      .where(eq(creditBatchSettlementDetails.batchId, world.batchId));
    expect(details[0].count).toBe(4);
  });

  test("the outcome rows classify every item, evidence and all", async () => {
    const world = await seedPartialWorld();
    await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports: partialReport(),
      source: "poll",
    });
    const outcomes = await database
      .select()
      .from(batchItemOutcomes)
      .where(eq(batchItemOutcomes.batchId, world.batchId));
    expect(outcomes.length).toBe(5);
    const byClassification = new Map(
      outcomes.map((row) => [row.customId, row.classification]),
    );
    expect(byClassification.get("req-1")).toBe("completed");
    expect(byClassification.get("req-4")).toBe("failed_billable");
    expect(byClassification.get("req-5")).toBe("not_dispatched");
    const released = outcomes.find((row) => row.customId === "req-5");
    if (!released) throw new Error("req-5 outcome missing");
    expect(released.evidence).toEqual({
      kind: "not_dispatched",
      reference: "provider-batch-status:request_counts.total=4",
    });
  });
});

// ── AC-3: no evidence, no release ───────────────────────────────────────────────────

describe("18.3 AC-3 — an absent item without evidence is unknown and keeps the hold", () => {
  test("the batch does NOT settle while an item is unknown — no whole-batch release", async () => {
    const world = await seedPartialWorld();
    const reports = partialReport();
    // The not-dispatched item arrives WITHOUT its evidence: the provider's status never
    // named the item, so nothing proves it did not run.
    reports[4] = { kind: "unknown", customId: "req-5", reason: "no_result_row" };
    const outcome = await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports,
      source: "poll",
    });
    expect(outcome.status).toBe("pending_unknown");
    if (outcome.status !== "pending_unknown") return;
    expect(outcome.unknownItems).toEqual(["req-5"]);

    // Nothing settled, nothing released: the hold keeps the WHOLE cap occupied.
    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, world.reservationId));
    expect(hold.status).toBe("reserved");
    expect(hold.maximum).toBe(world.cap);
    const ledgerCount = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(creditBatchSettlementDetails)
      .where(eq(creditBatchSettlementDetails.batchId, world.batchId));
    expect(ledgerCount[0].count).toBe(0);
    // The billable items' outcomes are still recorded — the classification stands.
    const outcomes = await database
      .select()
      .from(batchItemOutcomes)
      .where(eq(batchItemOutcomes.batchId, world.batchId));
    expect(outcomes.length).toBe(5);
  });

  test("the evidence arriving later settles the batch — the recovery shape", async () => {
    const world = await seedPartialWorld();
    const reports = partialReport();
    reports[4] = { kind: "unknown", customId: "req-5", reason: "no_result_row" };
    const pending = await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports,
      source: "poll",
    });
    expect(pending.status).toBe("pending_unknown");

    const resolved = await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports: partialReport(),
      source: "notification",
    });
    expect(resolved.status).toBe("settled");
    if (resolved.status !== "settled") return;
    expect(resolved.chargedCredits).toBe(1400);
  });

  test("a sparse recovery report settles earlier persisted billable outcomes", async () => {
    const world = await seedPartialWorld();
    const initialReports = partialReport();
    initialReports[4] = {
      kind: "unknown",
      customId: "req-5",
      reason: "no_result_row",
    };
    const pending = await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports: initialReports,
      source: "poll",
    });
    expect(pending.status).toBe("pending_unknown");

    const resolved = await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports: [
        {
          kind: "absent",
          customId: "req-5",
          evidence: {
            kind: "not_dispatched",
            reference: "provider-batch-status:request_counts.total=4",
          },
        },
      ],
      source: "notification",
    });

    expect(resolved.status).toBe("settled");
    if (resolved.status !== "settled") return;
    expect(resolved.chargedCredits).toBe(1400);
    const details = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(creditBatchSettlementDetails)
      .where(eq(creditBatchSettlementDetails.batchId, world.batchId));
    expect(details[0].count).toBe(4);
  });
});

// ── AC-4: the batch status names partiality and the counts ──────────────────────────

describe("18.3 AC-4 — the batch status and per-class counts are queryable", () => {
  test("a mixed batch is marked partial with every class counted", async () => {
    const world = await seedPartialWorld();
    await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports: partialReport(),
      source: "poll",
    });
    const view = await readBatchStatusView(database, world.batchId);
    if (view === undefined) throw new Error("status view missing");
    expect(view.batch.state).toBe("partial");
    expect(view.counts).toEqual({
      completed: 3,
      failedBillable: 1,
      released: 1,
      unknown: 0,
      cancelled: 0,
    });
    expect(view.batch.settledAt).not.toBeNull();
    const req5 = view.items.find((item) => item.customId === "req-5");
    if (!req5) throw new Error("req-5 missing from view");
    expect(req5.classification).toBe("not_dispatched");
  });

  test("an all-completed batch is marked completed, not partial", async () => {
    const world = await seedPartialWorld();
    const reports = partialReport();
    reports[3] = {
      kind: "terminal",
      customId: "req-4",
      terminalState: "completed",
      usage: { video: 2 },
    };
    reports[4] = {
      kind: "terminal",
      customId: "req-5",
      terminalState: "completed",
      usage: { video: 2 },
    };
    const outcome = await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports,
      source: "poll",
    });
    expect(outcome.status).toBe("settled");
    const view = await readBatchStatusView(database, world.batchId);
    if (view === undefined) throw new Error("status view missing");
    expect(view.batch.state).toBe("completed");
    expect(view.counts).toEqual({
      completed: 5,
      failedBillable: 0,
      released: 0,
      unknown: 0,
      cancelled: 0,
    });
  });
});
