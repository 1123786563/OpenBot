import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createBatchSubmitService } from "../src/billing/batch-submit";
import { createBatchPartialSettleService } from "../src/billing/batch-partial";
import {
  createBatchCancelService,
  readBatchCancelView,
} from "../src/billing/batch-cancel";
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
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 18.4 (#336) — a partial cancellation neither loses a charge nor double-charges,
 * on a real PostgreSQL (TEST_DATABASE_URL). This is group 18's seam stitch: submit →
 * whole-batch hold → partial success AND partial cancellation → two-level detail, end to
 * end.
 *
 *   AC-1  a cancelled item WITH unbilled evidence releases;
 *   AC-2  an executed item's cost settles in full — including an executed-and-then-
 *         cancelled item (丢账 is the lost half of the ticket's own name);
 *   AC-3  the same item never settles twice — the itemId is the idempotency key (the
 *         outcome row's own PK and the reservation's one-settle fence, both asserted on
 *         a duplicated final report AND a duplicated cancellation notification);
 *   AC-4  cancel and failure are DISTINCT in the view, and every cancellation carries an
 *         audit row with its evidence.
 *
 * The stitch fixture: 6 items — 2 completed, 1 billed failure, 1 not-dispatched (evidence),
 * 2 cancelled (1 unbilled with evidence, 1 executed with real usage). Every billed item's
 * exact cost must land on the ONE ledger row (不丢账), and nothing may land twice (不重扣).
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b18-336-${randomUUID().slice(0, 8)}`;
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

/** The audit spy — cancellation trails, collected for counting and payload checks. */
function makeAudit() {
  const events: {
    eventType: string;
    targetId?: string;
    payload: Record<string, unknown>;
  }[] = [];
  return {
    events,
    store: {
      insert: async (event: {
        eventType: string;
        targetId?: string;
        payload: Record<string, unknown>;
      }) => {
        events.push({
          eventType: event.eventType,
          targetId: event.targetId,
          payload: event.payload,
        });
      },
    },
  };
}

const audit = makeAudit();
const partialService = createBatchPartialSettleService({
  database,
  environmentRate: ENVIRONMENT_RATE,
});
const cancelService = createBatchCancelService({
  database,
  environmentRate: ENVIRONMENT_RATE,
  audit: audit.store,
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

/** Submit the 6-item single-cell stitch fixture: each item certified {video: 10} → cap 6000. */
async function seedCancelWorld(): Promise<World> {
  const n = ++seedCounter;
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
    reason: "batch-cancel fixture",
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
  const items = Array.from({ length: 6 }, (_, index) => ({
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

/**
 * The stitch report: 2 completed, 1 billed failure, 1 not-dispatched (evidence),
 * 2 cancelled — one unbilled with evidence, one EXECUTED with real usage.
 */
const stitchReports = () => [
  { kind: "terminal" as const, customId: "req-1", terminalState: "completed" as const, usage: { video: 4 } },
  { kind: "terminal" as const, customId: "req-2", terminalState: "completed" as const, usage: { video: 4 } },
  { kind: "terminal" as const, customId: "req-3", terminalState: "failed" as const, usage: { video: 2 } },
  {
    kind: "absent" as const,
    customId: "req-4",
    evidence: { kind: "not_dispatched" as const, reference: "provider-batch-status:request_counts.total=5" },
  },
  {
    kind: "cancelled" as const,
    customId: "req-5",
    evidence: { kind: "cancelled_unbilled" as const, reference: "provider-cancel-ack:req-5" },
  },
  // The executed cancellation: the provider ran 6 units, then the cancel landed — the
  // cost is real and must settle (不丢账), never release.
  { kind: "cancelled" as const, customId: "req-6", usage: { video: 6 } },
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

// ── The seam stitch: 不丢账 AND 不重扣, both directions at once ─────────────────────

describe("18.4 — the group's seam stitch", () => {
  test("a mixed batch with cancellations settles every executed item and releases only the evidenced", async () => {
    const world = await seedCancelWorld();
    // The cancellations arrive through the cancel lane FIRST (the notification order the
    // provider's own event stream produces), the rest through the settle report.
    const cancelOutcome = await cancelService.reportBatchCancellations({
      batchId: world.batchId,
      cancellations: stitchReports().filter(
        (report): report is Extract<typeof report, { kind: "cancelled" }> =>
          report.kind === "cancelled",
      ),
      source: "notification",
    });
    expect(cancelOutcome.status).toBe("pending_unknown");

    const outcome = await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports: stitchReports(),
      source: "poll",
    });
    expect(outcome.status).toBe("settled");
    if (outcome.status !== "settled") return;

    // 不丢账: 2×400 (completed) + 200 (billed failure) + 600 (EXECUTED cancellation) =
    // 1600 — every executed item's exact cost is on the ledger.
    expect(outcome.chargedCredits).toBe(1600);
    // The released share: cap 6000 − 1600 = 4400 — the unbilled cancellation and the
    // not-dispatched item released ON their evidence, never the whole batch.
    expect(outcome.releasedCredits).toBe(world.cap - 1600);

    const balanceAfter = await fixtureWriter.availableBalance(world.customerKey);
    expect(balanceAfter).toBe(world.balanceBefore - 1600);

    // The detail lines carry exactly the 4 billed items (incl. the executed cancel).
    const details = await database
      .select({ customId: creditBatchSettlementDetails.customId })
      .from(creditBatchSettlementDetails)
      .where(eq(creditBatchSettlementDetails.batchId, world.batchId))
      .orderBy(creditBatchSettlementDetails.customId);
    expect(details.map((d) => d.customId)).toEqual([
      "req-1",
      "req-2",
      "req-3",
      "req-6",
    ]);
  });

  test("不重扣: a duplicated final report settles once — same ledger, same counts", async () => {
    const world = await seedCancelWorld();
    await cancelService.reportBatchCancellations({
      batchId: world.batchId,
      cancellations: stitchReports().filter(
        (report): report is Extract<typeof report, { kind: "cancelled" }> =>
          report.kind === "cancelled",
      ),
      source: "notification",
    });
    const first = await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports: stitchReports(),
      source: "poll",
    });
    if (first.status !== "settled") throw new Error("first settle failed");
    const second = await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports: stitchReports(),
      source: "notification",
    });
    expect(second.status).toBe("settled");
    if (second.status !== "settled") return;
    expect(second.chargedCredits).toBe(first.chargedCredits);

    const ledgerRows = await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.requestId, world.batchId));
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].credits).toBe(1600);
    const detailCount = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(creditBatchSettlementDetails)
      .where(eq(creditBatchSettlementDetails.batchId, world.batchId));
    expect(detailCount[0].count).toBe(4);
  });

  test("不重扣: a duplicated CANCELLATION notification counts, never re-charges or re-audits", async () => {
    const world = await seedCancelWorld();
    const cancellations = stitchReports().filter(
      (report): report is Extract<typeof report, { kind: "cancelled" }> =>
        report.kind === "cancelled",
    );
    await cancelService.reportBatchCancellations({
      batchId: world.batchId,
      cancellations,
      source: "notification",
    });
    await cancelService.reportBatchCancellations({
      batchId: world.batchId,
      cancellations,
      source: "poll",
    });
    // The outcome row counted both notifications for each cancelled item…
    const outcomes = await database
      .select()
      .from(batchItemOutcomes)
      .where(eq(batchItemOutcomes.batchId, world.batchId));
    expect(outcomes.length).toBe(2);
    for (const row of outcomes) {
      expect(row.reports).toBe(2);
    }
    // …and the audit carries ONE row per cancelled item — the fact, not the noise.
    const cancelAudits = audit.events.filter(
      (event) => event.eventType === "billing.batch_item_cancelled",
    );
    const forThisBatch = cancelAudits.filter(
      (event) => event.payload.batchId === world.batchId,
    );
    expect(forThisBatch.length).toBe(2);
    const unbilled = forThisBatch.find(
      (event) => event.payload.customId === "req-5",
    );
    if (!unbilled) throw new Error("req-5 audit missing");
    expect(unbilled.payload.evidence).toEqual({
      kind: "cancelled_unbilled",
      reference: "provider-cancel-ack:req-5",
    });

    // And the money still settles exactly once afterwards.
    const outcome = await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports: stitchReports(),
      source: "poll",
    });
    expect(outcome.status).toBe("settled");
    if (outcome.status !== "settled") return;
    expect(outcome.chargedCredits).toBe(1600);
  });
});

// ── AC-1/AC-2: the cancellation's two money shapes ─────────────────────────────────

describe("18.4 AC-1/AC-2 — cancelled items release on evidence, settle on execution", () => {
  test("a cancellation without evidence and without usage is unknown — no release", async () => {
    const world = await seedCancelWorld();
    const outcome = await cancelService.reportBatchCancellations({
      batchId: world.batchId,
      cancellations: [
        { kind: "cancelled", customId: "req-1", reason: "client_asked" },
      ],
      source: "notification",
    });
    expect(outcome.status).toBe("pending_unknown");
    const [row] = await database
      .select()
      .from(batchItemOutcomes)
      .where(eq(batchItemOutcomes.batchId, world.batchId));
    expect(row.classification).toBe("unknown");
    // The hold keeps its full cap — a client's cancel wish is not no-charge evidence.
    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, world.reservationId));
    expect(hold.status).toBe("reserved");
  });

  test("a cancellation claiming unbilled evidence while reporting usage refuses", async () => {
    const world = await seedCancelWorld();
    const outcome = await cancelService.reportBatchCancellations({
      batchId: world.batchId,
      cancellations: [
        {
          kind: "cancelled",
          customId: "req-1",
          usage: { video: 3 },
          evidence: { kind: "cancelled_unbilled", reference: "x" },
        },
      ],
      source: "notification",
    });
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("request_invalid");
  });
});

// ── AC-4: cancel and failure are distinct in the view ──────────────────────────────

describe("18.4 AC-4 — the view distinguishes cancellation from failure", () => {
  test("classifications, terminal states and counts separate the two, per item", async () => {
    const world = await seedCancelWorld();
    await cancelService.reportBatchCancellations({
      batchId: world.batchId,
      cancellations: stitchReports().filter(
        (report): report is Extract<typeof report, { kind: "cancelled" }> =>
          report.kind === "cancelled",
      ),
      source: "notification",
    });
    await partialService.settlePartialBatch({
      batchId: world.batchId,
      reports: stitchReports(),
      source: "poll",
    });

    const view = await readBatchCancelView(database, world.batchId);
    if (view === undefined) throw new Error("cancel view missing");
    const failed = view.items.find((item) => item.customId === "req-3");
    const cancelledUnbilled = view.items.find((item) => item.customId === "req-5");
    const cancelledBilled = view.items.find((item) => item.customId === "req-6");
    if (!failed || !cancelledUnbilled || !cancelledBilled) {
      throw new Error("view items missing");
    }
    expect(failed.classification).toBe("failed_billable");
    expect(failed.terminalState).toBe("failed");
    expect(cancelledUnbilled.classification).toBe("cancelled");
    expect(cancelledUnbilled.terminalState).toBe("cancelled");
    expect(cancelledUnbilled.releasedOnEvidence).toBe(true);
    expect(cancelledBilled.classification).toBe("cancelled");
    expect(cancelledBilled.billed).toBe(true);
    expect(view.counts.cancelled).toBe(2);
    expect(view.counts.failedBillable).toBe(1);
    expect(view.batch.state).toBe("partial");
  });
});
