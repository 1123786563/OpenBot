import { afterAll, beforeAll, describe, expect, test } from "../../tests/support/e2e-compat";
import { inArray } from "drizzle-orm";
import {
  classifyCleanup,
  type CleanupClassification,
} from "../src/billing/cleanup-classification";
import {
  evaluateCleanupRelations,
  EXTERNAL_LIVE_SUBSCRIPTION_STATUSES,
  type CleanupRelationsManifest,
} from "../src/billing/cleanup-relations";
import { createDatabase } from "../src/db/client";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
  payerAccounts,
} from "../src/db/schema/billing";
import {
  creditChargeRemainders,
  creditReservationAllocations,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { usageOutbox } from "../src/db/schema/usage-outbox";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The legacy billing relation mapping and cascade evaluation (ticket b5-347) against a real
 * PostgreSQL, gated on TEST_DATABASE_URL like the rest of the integration suite. It consumes
 * group 21.2's classification and answers the question 21.2 deliberately left open: for every
 * cleanup candidate, what would deleting it actually take with it — answered from the live
 * catalog's foreign keys and row-level probes, never from the migration files alone.
 *
 * The fixture builds the cascade situations the ticket names:
 *
 * - K1 `legacy+evidenced, in-flight`: a still-RESERVED reservation R with its allocation A,
 *   a settled reservation RS with allocation AS and settlement ledger L, a synthetic legacy
 *   state (reserved R pointing at ledger L2), grants G/G2, remainder, canceled subscription
 *   S, webhook W, usage-outbox O (which carries the customer key by VALUE — it has no foreign
 *   key at all), and a paid order PO with event PE. Deleting the customer row, grant G or
 *   ledger L2 would reach the retained R/A — all three must be pulled from the cleanup set,
 *   while every other K1 row stays cleanable.
 * - K2 `legacy+evidenced, live external subscription`: an ACTIVE subscription SA at the
 *   payment gateway. The subscription is listed separately, removed from the cleanup set (its
 *   anchor must survive until a human confirms), and its key's customer row and mapping row
 *   are pulled too — the customer's cascade reaches SA, and the mapping is the attribution
 *   evidence the kept rows cite.
 * - K3 `legacy+evidenced, clean except an open gateway order`: a PENDING order PO3 (a live
 *   payment-channel association). The order — and its event PE3, which rides in the order's
 *   cascade subtree — is pulled and listed for manual confirmation; the key's mapping stays
 *   as the kept rows' evidence basis; the customer row is pulled because its cascade would
 *   take the kept mapping.
 * - a company key with a live ACTIVE subscription that must NOT appear in the external list
 *   (the list is scoped to keys the cleanup could actually touch).
 *
 * Under evaluation:
 * - FK protection: a candidate whose deletion (CASCADE) or mutation (SET NULL) would reach a
 *   retained row is removed from the candidate set with the impact enumerated per row (AC1),
 * - the FK graph itself is data evidence: catalog-probed edges (including `usage_outbox`
 *   having NO edge and `credit_reservations.ledger_id` being SET NULL), compared against the
 *   schema's declarations (AC2),
 * - external live subscriptions and open gateway orders are listed separately, never
 *   auto-cancelled, their rows pulled from the safe set (AC3),
 * - the whole evaluation persists as one deterministic JSON manifest (AC4).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = `b347-${Math.random().toString(36).slice(2, 10)}`;

/** The four fixture keys: one company keep, and the three legacy situations. */
const companyKey = `b347-co-${run}`;
const flightKey = `b347-leg1-${run}`;
const activeSubKey = `b347-leg2-${run}`;
const cleanKey = `b347-leg3-${run}`;
const fixtureKeys = [companyKey, flightKey, activeSubKey, cleanKey];

const companyMappingId = `b347-pa-co-${run}`;
const flightMappingId = `b347-pa-m1-${run}`;
const activeSubMappingId = `b347-pa-m2-${run}`;
const cleanMappingId = `b347-pa-m3-${run}`;
const flightPayerId = `b347-deploy1-${run}`;
const activeSubPayerId = `b347-deploy2-${run}`;
const cleanPayerId = `b347-deploy3-${run}`;

const companySubscriptionId = `b347-sub-co-${run}`;
const flightSubscriptionId = `b347-sub1-${run}`;
const activeSubscriptionId = `b347-sub2-${run}`;
const cleanSubscriptionId = `b347-sub3-${run}`;

/** K1: the in-flight situation. */
const flightGrantId = `b347-g1-${run}`;
const flightSpareGrantId = `b347-g2-${run}`;
const flightLedgerId = `b347-l1-${run}`;
const flightLedger2Id = `b347-l2-${run}`;
const flightReservedId = `b347-r1-${run}`;
const flightSettledId = `b347-rs1-${run}`;
const flightAllocationId = `b347-a1-${run}`;
const flightSettledAllocationId = `b347-as1-${run}`;
const flightWebhookId = `b347-we1-${run}`;
const flightOutboxId = `b347-uo1-${run}`;
const flightOrderId = `b347-po1-${run}`;
const flightEventId = `b347-pe1-${run}`;

/** K2: the live external subscription. */
const activeSubGrantId = `b347-g3-${run}`;
const activeSubOrderId = `b347-po2-${run}`;
const activeSubEventId = `b347-pe2-${run}`;
const activeSubWebhookId = `b347-we2-${run}`;
const activeSubOutboxId = `b347-uo2-${run}`;

/** K3: clean except the open gateway order. */
const cleanGrantId = `b347-g4-${run}`;
const cleanLedgerId = `b347-l3-${run}`;
const cleanSettledId = `b347-rs3-${run}`;
const cleanSettledAllocationId = `b347-as3-${run}`;
const cleanOrderId = `b347-po3-${run}`;
const cleanEventId = `b347-pe3-${run}`;
const cleanWebhookId = `b347-we3-${run}`;
const cleanOutboxId = `b347-uo3-${run}`;
/** A pending order needs a deployment purchase slot of its own: one pending per scope. */
const cleanOrderScope = `b347-scope-${run}`;

/** The operator-vouched test-evidence registries: the three legacy orders, nothing else. */
const evidenceInput = {
  testOrderIds: [flightOrderId, activeSubOrderId, cleanOrderId],
  testUserIds: [],
};

/** The eleven FK edges the drizzle schema declares among the legacy tables. */
const DECLARED_EDGES: {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  onDelete: string;
}[] = [
  { childTable: "payer_accounts", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "billing_subscriptions", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "credit_grants", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "credit_ledger", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "credit_ledger", childColumn: "grant_id", parentTable: "credit_grants", parentColumn: "id", onDelete: "set_null" },
  { childTable: "credit_reservations", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "credit_reservations", childColumn: "ledger_id", parentTable: "credit_ledger", parentColumn: "id", onDelete: "set_null" },
  { childTable: "credit_reservation_allocations", childColumn: "reservation_id", parentTable: "credit_reservations", parentColumn: "id", onDelete: "cascade" },
  { childTable: "credit_reservation_allocations", childColumn: "grant_id", parentTable: "credit_grants", parentColumn: "id", onDelete: "cascade" },
  { childTable: "credit_charge_remainders", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "payment_events", childColumn: "order_id", parentTable: "payment_orders", parentColumn: "id", onDelete: "cascade" },
];

let classification: CleanupClassification;
let manifest: CleanupRelationsManifest;

afterAll(async () => {
  // Children first, mirroring the FK graph the module evaluates.
  await database
    .delete(paymentEvents)
    .where(inArray(paymentEvents.orderId, [flightOrderId, activeSubOrderId, cleanOrderId]));
  await database
    .delete(paymentOrders)
    .where(inArray(paymentOrders.id, [flightOrderId, activeSubOrderId, cleanOrderId]));
  await database
    .delete(usageOutbox)
    .where(inArray(usageOutbox.externalCustomerId, fixtureKeys));
  await database
    .delete(billingWebhookEvents)
    .where(
      inArray(billingWebhookEvents.eventId, [
        flightWebhookId,
        activeSubWebhookId,
        cleanWebhookId,
      ]),
    );
  await database
    .delete(creditReservationAllocations)
    .where(
      inArray(creditReservationAllocations.reservationId, [
        flightReservedId,
        flightSettledId,
        cleanSettledId,
      ]),
    );
  await database
    .delete(creditReservations)
    .where(
      inArray(creditReservations.id, [
        flightReservedId,
        flightSettledId,
        cleanSettledId,
      ]),
    );
  await database
    .delete(creditLedger)
    .where(
      inArray(creditLedger.id, [flightLedgerId, flightLedger2Id, cleanLedgerId]),
    );
  await database
    .delete(creditGrants)
    .where(
      inArray(creditGrants.id, [
        flightGrantId,
        flightSpareGrantId,
        activeSubGrantId,
        cleanGrantId,
      ]),
    );
  await database
    .delete(creditChargeRemainders)
    .where(inArray(creditChargeRemainders.externalCustomerId, fixtureKeys));
  await database
    .delete(billingSubscriptions)
    .where(inArray(billingSubscriptions.externalCustomerId, fixtureKeys));
  await database
    .delete(payerAccounts)
    .where(
      inArray(payerAccounts.id, [
        companyMappingId,
        flightMappingId,
        activeSubMappingId,
        cleanMappingId,
      ]),
    );
  await database
    .delete(billingCustomers)
    .where(inArray(billingCustomers.externalId, fixtureKeys));
  await database.$client.close();
});

beforeAll(async () => {
  // Customers and the explicit 02.2 mappings.
  for (const key of fixtureKeys) {
    await database
      .insert(billingCustomers)
      .values({ externalId: key, name: `b5-347 fixture ${key}` });
  }
  await database.insert(payerAccounts).values([
    {
      id: companyMappingId,
      kind: "company",
      payerId: `b347-tenant-${run}`,
      externalCustomerId: companyKey,
    },
    {
      id: flightMappingId,
      kind: "legacy_deployment",
      payerId: flightPayerId,
      externalCustomerId: flightKey,
    },
    {
      id: activeSubMappingId,
      kind: "legacy_deployment",
      payerId: activeSubPayerId,
      externalCustomerId: activeSubKey,
    },
    {
      id: cleanMappingId,
      kind: "legacy_deployment",
      payerId: cleanPayerId,
      externalCustomerId: cleanKey,
    },
  ]);

  // Subscriptions: the company key's live one (never the cleanup's business), K1's canceled
  // one, K2's ACTIVE one (the external anchor), K3's canceled one.
  await database.insert(billingSubscriptions).values([
    {
      externalCustomerId: companyKey,
      externalSubscriptionId: companySubscriptionId,
      planCode: "company-plan",
      status: "active",
    },
    {
      externalCustomerId: flightKey,
      externalSubscriptionId: flightSubscriptionId,
      planCode: "legacy-test",
      status: "canceled",
    },
    {
      externalCustomerId: activeSubKey,
      externalSubscriptionId: activeSubscriptionId,
      planCode: "legacy-active",
      status: "active",
    },
    {
      externalCustomerId: cleanKey,
      externalSubscriptionId: cleanSubscriptionId,
      planCode: "legacy-test",
      status: "canceled",
    },
  ]);

  // Grants: K1's working and spare grants, K2's and K3's payout grants (the `plan:<orderId>`
  // idempotency keys tie them to their orders for the classification's order attribution).
  await database.insert(creditGrants).values([
    {
      id: flightGrantId,
      externalCustomerId: flightKey,
      source: "promo",
      total: 10_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b347-promo-${run}`,
    },
    {
      id: flightSpareGrantId,
      externalCustomerId: flightKey,
      source: "promo",
      total: 5_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b347-promo2-${run}`,
    },
    {
      id: activeSubGrantId,
      externalCustomerId: activeSubKey,
      source: "plan",
      total: 20_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `plan:${activeSubOrderId}`,
    },
    {
      id: cleanGrantId,
      externalCustomerId: cleanKey,
      source: "plan",
      total: 20_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `plan:${cleanOrderId}`,
    },
  ]);

  // Ledger: K1's settlement row (grant G), the ledger the still-reserved R points at
  // (a historical state no current writer produces — exactly what real data may hold),
  // and K3's settlement row.
  await database.insert(creditLedger).values([
    {
      id: flightLedgerId,
      externalCustomerId: flightKey,
      grantId: flightGrantId,
      title: `b347 settlement ${run}`,
      idempotencyKey: `b347-ledger1-${run}`,
      credits: 400,
      applied: 400,
    },
    {
      id: flightLedger2Id,
      externalCustomerId: flightKey,
      grantId: flightSpareGrantId,
      title: `b347 legacy pointer target ${run}`,
      idempotencyKey: `b347-ledger2-${run}`,
      credits: 100,
      applied: 100,
    },
    {
      id: cleanLedgerId,
      externalCustomerId: cleanKey,
      grantId: cleanGrantId,
      title: `b347 clean settlement ${run}`,
      idempotencyKey: `b347-ledger3-${run}`,
      credits: 200,
      applied: 200,
    },
  ]);

  // Reservations: R still RESERVED (retained in-flight duty) pointing at ledger L2;
  // RS settled; K3's RS3 settled. The settled CHECK pins the arithmetic.
  await database.insert(creditReservations).values([
    {
      id: flightReservedId,
      externalCustomerId: flightKey,
      idempotencyKey: `b347-hold-${run}`,
      maximum: 1_000,
      status: "reserved",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      ledgerId: flightLedger2Id,
    },
    {
      id: flightSettledId,
      externalCustomerId: flightKey,
      idempotencyKey: `b347-settled-${run}`,
      maximum: 1_000,
      status: "settled",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      terminalAt: new Date("2026-01-01T01:00:00Z"),
      actualNumerator: "40000",
      actualDenominator: "100",
      charged: 400,
      applied: 400,
      released: 600,
      ledgerId: flightLedgerId,
    },
    {
      id: cleanSettledId,
      externalCustomerId: cleanKey,
      idempotencyKey: `b347-clean-settled-${run}`,
      maximum: 1_000,
      status: "settled",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      terminalAt: new Date("2026-01-01T01:00:00Z"),
      actualNumerator: "20000",
      actualDenominator: "100",
      charged: 200,
      applied: 200,
      released: 800,
      ledgerId: cleanLedgerId,
    },
  ]);

  // Allocations: A backs the RESERVED R with grant G (deleting G cascades into it),
  // AS settled with G, AS3 settled with G4.
  await database.insert(creditReservationAllocations).values([
    {
      id: flightAllocationId,
      reservationId: flightReservedId,
      grantId: flightGrantId,
      amount: 1_000,
      consumed: 0,
    },
    {
      id: flightSettledAllocationId,
      reservationId: flightSettledId,
      grantId: flightGrantId,
      amount: 1_000,
      consumed: 400,
    },
    {
      id: cleanSettledAllocationId,
      reservationId: cleanSettledId,
      grantId: cleanGrantId,
      amount: 1_000,
      consumed: 200,
    },
  ]);

  // Charge remainders, one per legacy key.
  await database.insert(creditChargeRemainders).values(
    [flightKey, activeSubKey, cleanKey].map((key, index) => ({
      externalCustomerId: key,
      numerator: `${index}`,
      denominator: "3",
    })),
  );

  // Webhooks: K1's resolves through its canceled subscription; K2's through the ACTIVE one.
  await database.insert(billingWebhookEvents).values([
    {
      provider: "lago",
      eventId: flightWebhookId,
      webhookType: "subscription.canceled",
      objectId: flightSubscriptionId,
    },
    {
      provider: "lago",
      eventId: activeSubWebhookId,
      webhookType: "subscription.created",
      objectId: activeSubscriptionId,
    },
    {
      provider: "lago",
      eventId: cleanWebhookId,
      webhookType: "subscription.canceled",
      objectId: cleanSubscriptionId,
    },
  ]);

  // Usage outbox: carries the customer key by VALUE (no FK) — deleting the customer never
  // reaches these rows. O and O3 also carry a reservation link (again by value only).
  await database.insert(usageOutbox).values([
    {
      eventId: flightOutboxId,
      source: "llm",
      externalCustomerId: flightKey,
      transactionId: `b347-tx1-${run}`,
      inputTokens: 100,
      outputTokens: 50,
      model: "gpt-test",
      client: "b5-347-fixture",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      reservationId: flightSettledId,
      actualCostNumerator: "40000",
      actualCostDenominator: "100",
    },
    {
      eventId: activeSubOutboxId,
      source: "llm",
      externalCustomerId: activeSubKey,
      transactionId: `b347-tx2-${run}`,
      inputTokens: 10,
      outputTokens: 5,
      model: "gpt-test",
      client: "b5-347-fixture",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      eventId: cleanOutboxId,
      source: "llm",
      externalCustomerId: cleanKey,
      transactionId: `b347-tx3-${run}`,
      inputTokens: 10,
      outputTokens: 5,
      model: "gpt-test",
      client: "b5-347-fixture",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      reservationId: cleanSettledId,
      actualCostNumerator: "20000",
      actualCostDenominator: "100",
    },
  ]);

  // Orders: two paid (registered test orders), one PENDING (the open gateway association).
  await database.insert(paymentOrders).values([
    {
      id: flightOrderId,
      deploymentScope: cleanOrderScope,
      planCode: "legacy-test",
      provider: "alipay",
      amountCents: 1_000,
      status: "paid",
      activationState: "applied",
      ownerPayerKind: "legacy_deployment",
      ownerPayerId: flightPayerId,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      paidAt: new Date("2026-01-01T00:30:00Z"),
      terminalAt: new Date("2026-01-01T00:30:00Z"),
    },
    {
      id: activeSubOrderId,
      deploymentScope: cleanOrderScope,
      planCode: "legacy-test",
      provider: "wechat",
      amountCents: 2_000,
      status: "paid",
      activationState: "applied",
      ownerPayerKind: "legacy_deployment",
      ownerPayerId: activeSubPayerId,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      paidAt: new Date("2026-01-01T00:30:00Z"),
      terminalAt: new Date("2026-01-01T00:30:00Z"),
    },
    {
      id: cleanOrderId,
      // Its own scope: the schema allows one pending order per deployment scope.
      deploymentScope: cleanOrderScope,
      planCode: "legacy-test",
      provider: "alipay",
      amountCents: 3_000,
      status: "pending",
      activationState: "pending",
      ownerPayerKind: "legacy_deployment",
      ownerPayerId: cleanPayerId,
      expiresAt: new Date("2027-06-01T00:00:00Z"),
    },
  ]);

  await database.insert(paymentEvents).values([
    {
      id: flightEventId,
      orderId: flightOrderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `b347-ct1-${run}`,
      amountCents: 1_000,
    },
    {
      id: activeSubEventId,
      orderId: activeSubOrderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `b347-ct2-${run}`,
      amountCents: 2_000,
    },
    {
      id: cleanEventId,
      orderId: cleanOrderId,
      kind: "anomaly",
      code: "created",
      detail: `b347 pending order ${run}`,
    },
  ]);

  classification = await classifyCleanup(database, evidenceInput);
  manifest = await evaluateCleanupRelations(database, classification);
});

/** The evaluation of one candidate record, by table and record id. */
function evaluationOf(table: string, recordId: string) {
  const evaluation = manifest.evaluations.find(
    (entry) => entry.table === table && entry.recordId === recordId,
  );
  expect(evaluation).toBeDefined();
  return evaluation!;
}

function removedEntryOf(table: string, recordId: string) {
  const removed = manifest.removedCandidates.find(
    (entry) => entry.table === table && entry.recordId === recordId,
  );
  expect(removed).toBeDefined();
  return removed!;
}

function isSafe(table: string, recordId: string) {
  return manifest.safeCandidates.some(
    (entry) => entry.table === table && entry.recordId === recordId,
  );
}

describe("the legacy billing relations evaluation maps associations from live data", () => {
  test("the FK graph is catalog evidence compared against the schema declaration", () => {
    // Every declared edge is found with the declared delete behavior (AC2: data evidence,
    // not just schema reading — the probe read pg_constraint and probed rows).
    for (const declared of DECLARED_EDGES) {
      const edge = manifest.fkEdges.find(
        (candidate) =>
          candidate.childTable === declared.childTable &&
          candidate.childColumn === declared.childColumn &&
          candidate.parentTable === declared.parentTable,
      );
      expect(edge).toBeDefined();
      expect(edge!.onDelete).toBe(declared.onDelete);
      expect(edge!.matchesDeclaration).toBe(true);
      // Data evidence: the edge's evidence cites the live probe, not the migration file.
      expect(edge!.evidence).toContain("pg_constraint");
    }
    // The data truth the schema does not make obvious: usage_outbox carries the customer
    // key by VALUE — no FK — and the webhook inbox links to subscriptions by value too.
    expect(
      manifest.fkEdges.filter((edge) => edge.childTable === "usage_outbox"),
    ).toEqual([]);
    expect(
      manifest.fkEdges.filter((edge) => edge.childTable === "billing_webhook_events"),
    ).toEqual([]);
    expect(
      manifest.fkEdges.filter((edge) => edge.childTable === "payment_orders"),
    ).toEqual([]);
    // The value-level links are recorded with row-probe evidence.
    const outboxLink = manifest.observedLinks.find(
      (link) => link.childTable === "usage_outbox",
    );
    expect(outboxLink).toBeDefined();
    expect(outboxLink!.foreignKey).toBe(false);
    expect(outboxLink!.matchedRows).toBe(3);
    // No drifted declarations on this database.
    expect(manifest.summary.declarationMismatches).toBe(0);
    expect(manifest.fkEdges).toHaveLength(DECLARED_EDGES.length);
  });

  test("FK protection: deletion or mutation reaching a retained row removes the candidate", () => {
    // The customer row's cascade reaches the still-reserved reservation and its allocation.
    const customer = evaluationOf("billing_customers", flightKey);
    expect(customer.removed).toBe(true);
    expect(customer.removalReason).toBe("cascade_impact_on_retained");
    const retainedIds = customer.retainedImpact.map((impact) => impact.recordId);
    expect(retainedIds).toContain(flightReservedId);
    expect(retainedIds).toContain(flightAllocationId);
    for (const impact of customer.retainedImpact) {
      // Every customer impact comes through a CASCADE edge.
      expect(impact.effect).toBe("cascade_delete");
      // Each impact is protected for a stated reason: the in-flight rows by their class,
      // the kept mapping row by its evidence role.
      expect(["retained", "attribution_kept"]).toContain(impact.protection);
    }
    for (const recordId of [flightReservedId, flightAllocationId]) {
      const impact = customer.retainedImpact.find(
        (entry) => entry.recordId === recordId,
      );
      expect(impact!.class).toBe("unknown_owner");
      expect(impact!.protection).toBe("retained");
    }
    // The customer's cascade scope itself is data-probed: the keyed rows, NOT the outbox.
    const scopeIds = customer.cascadeDeletionScope.map((row) => row.recordId);
    expect(scopeIds).toContain(flightGrantId);
    expect(scopeIds).toContain(flightReservedId);
    expect(scopeIds).toContain(flightAllocationId);
    expect(scopeIds).not.toContain(flightOutboxId);

    // Grant G cascades into allocation A of the reserved reservation.
    const grant = evaluationOf("credit_grants", flightGrantId);
    expect(grant.removed).toBe(true);
    expect(grant.removalReason).toBe("cascade_impact_on_retained");
    const grantImpact = grant.retainedImpact.find(
      (impact) => impact.recordId === flightAllocationId,
    );
    expect(grantImpact).toBeDefined();
    expect(grantImpact!.effect).toBe("cascade_delete");

    // Ledger L2: the FK from the still-reserved reservation points at it with SET NULL —
    // deleting L2 would mutate a retained row's settlement evidence.
    const ledger2 = evaluationOf("credit_ledger", flightLedger2Id);
    expect(ledger2.removed).toBe(true);
    expect(ledger2.removalReason).toBe("cascade_impact_on_retained");
    const ledgerImpact = ledger2.retainedImpact.find(
      (impact) => impact.recordId === flightReservedId,
    );
    expect(ledgerImpact).toBeDefined();
    expect(ledgerImpact!.effect).toBe("set_null_mutate");
  });

  test("cascade-removed candidates leave their safe siblings cleanable", () => {
    // Pulled: the K1 root and evidence rows the in-flight state protects.
    for (const [table, recordId] of [
      ["billing_customers", flightKey],
      ["payer_accounts", flightMappingId],
      ["credit_grants", flightGrantId],
      ["credit_ledger", flightLedger2Id],
    ] as const) {
      expect(isSafe(table, recordId)).toBe(false);
      removedEntryOf(table, recordId);
    }
    // Still cleanable: the rest of K1 — including the settled hold chain and the rows whose
    // only link to the key is by value (outbox, webhook) or a canceled subscription.
    for (const [table, recordId] of [
      ["credit_grants", flightSpareGrantId],
      ["credit_ledger", flightLedgerId],
      ["credit_reservations", flightSettledId],
      ["credit_reservation_allocations", flightSettledAllocationId],
      ["billing_subscriptions", flightSubscriptionId],
      ["billing_webhook_events", flightWebhookId],
      ["usage_outbox", flightOutboxId],
      ["payment_orders", flightOrderId],
      ["payment_events", flightEventId],
      ["credit_charge_remainders", flightKey],
    ] as const) {
      expect(isSafe(table, recordId)).toBe(true);
      expect(evaluationOf(table, recordId).removed).toBe(false);
    }
    // The in-flight rows themselves were never candidates (21.2's verdict, still honored).
    expect(
      manifest.evaluations.filter(
        (entry) =>
          entry.recordId === flightReservedId || entry.recordId === flightAllocationId,
      ),
    ).toEqual([]);
  });

  test("the attribution mapping of a key that keeps records is itself kept", () => {
    // K1 keeps R/A; K2 keeps the subscription anchor; K3 keeps the open order: each key's
    // payer_accounts row is the attribution evidence those kept rows cite (Q29), so it is
    // pulled from the cleanup set with that reason.
    for (const mappingId of [
      flightMappingId,
      activeSubMappingId,
      cleanMappingId,
    ]) {
      const mapping = evaluationOf("payer_accounts", mappingId);
      expect(mapping.removed).toBe(true);
      expect(mapping.removalReason).toBe("attribution_basis_of_kept_records");
    }
  });

  test("external live subscriptions are listed separately and never auto-cancelled", () => {
    // Exactly the candidate keys' live subscriptions — the company key's active subscription
    // is not the cleanup's business; canceled ones are not live.
    expect(EXTERNAL_LIVE_SUBSCRIPTION_STATUSES).toEqual(["active", "incomplete"]);
    expect(manifest.externalActiveSubscriptions).toHaveLength(1);
    const listed = manifest.externalActiveSubscriptions[0];
    expect(listed.externalSubscriptionId).toBe(activeSubscriptionId);
    expect(listed.externalCustomerId).toBe(activeSubKey);
    expect(listed.status).toBe("active");
    expect(listed.planCode).toBe("legacy-active");
    // The anchor is pulled from the cleanup set: a human confirms before anything happens.
    expect(isSafe("billing_subscriptions", activeSubscriptionId)).toBe(false);
    const anchor = removedEntryOf("billing_subscriptions", activeSubscriptionId);
    expect(anchor.reason).toBe("external_subscription_anchor");
    // The customer row's cascade would take the anchor, so it is pulled too.
    const customer = evaluationOf("billing_customers", activeSubKey);
    expect(customer.removed).toBe(true);
    expect(
      customer.retainedImpact.some(
        (impact) =>
          impact.recordId === activeSubscriptionId &&
          impact.protection === "external_subscription_anchor",
      ),
    ).toBe(true);
    // The K2 rows that cascade nowhere near the anchor stay cleanable.
    for (const [table, recordId] of [
      ["credit_grants", activeSubGrantId],
      ["usage_outbox", activeSubOutboxId],
      ["billing_webhook_events", activeSubWebhookId],
      ["payment_orders", activeSubOrderId],
      ["payment_events", activeSubEventId],
      ["credit_charge_remainders", activeSubKey],
    ] as const) {
      expect(isSafe(table, recordId)).toBe(true);
    }
  });

  test("open gateway orders are listed for manual confirmation, with their events", () => {
    expect(manifest.externalOpenOrders).toHaveLength(1);
    const listed = manifest.externalOpenOrders[0];
    expect(listed.orderId).toBe(cleanOrderId);
    expect(listed.status).toBe("pending");
    expect(listed.externalCustomerId).toBe(cleanKey);
    expect(isSafe("payment_orders", cleanOrderId)).toBe(false);
    const anchor = removedEntryOf("payment_orders", cleanOrderId);
    expect(anchor.reason).toBe("external_payment_order_open");
    // The event rides in the anchor's cascade subtree: pulled with it, evidence names it.
    expect(isSafe("payment_events", cleanEventId)).toBe(false);
    const eventEntry = removedEntryOf("payment_events", cleanEventId);
    expect(eventEntry.reason).toBe("external_payment_order_open");
    expect(eventEntry.evidence).toContain(cleanOrderId);
    // The clean key's other rows stay cleanable; the customer row is pulled only because
    // its cascade would take the kept mapping row.
    for (const [table, recordId] of [
      ["credit_grants", cleanGrantId],
      ["billing_subscriptions", cleanSubscriptionId],
      ["credit_reservations", cleanSettledId],
      ["credit_reservation_allocations", cleanSettledAllocationId],
      ["credit_ledger", cleanLedgerId],
      ["usage_outbox", cleanOutboxId],
      ["billing_webhook_events", cleanWebhookId],
      ["credit_charge_remainders", cleanKey],
    ] as const) {
      expect(isSafe(table, recordId)).toBe(true);
    }
    const customer = evaluationOf("billing_customers", cleanKey);
    expect(customer.removed).toBe(true);
    expect(
      customer.retainedImpact.some(
        (impact) =>
          impact.recordId === cleanMappingId &&
          impact.protection === "attribution_kept",
      ),
    ).toBe(true);
  });

  test("the evaluation persists as one deterministic manifest", () => {
    // Every 21.2 candidate evaluated exactly once; the manifest is plain JSON.
    expect(manifest.evaluations).toHaveLength(classification.candidates.length);
    expect(manifest.basis.candidatesIn).toBe(classification.candidates.length);
    expect(manifest.basis.evidenceSha256).toBe(
      classification.evidenceInput.sha256,
    );
    const roundTripped = JSON.parse(JSON.stringify(manifest));
    expect(roundTripped).toEqual(manifest);
    // Two evaluations agree on everything but the generation timestamp (21.4's hash input).
  });

  test("a second evaluation reproduces the manifest deterministically", async () => {
    const second = await evaluateCleanupRelations(database, classification);
    const stripMeta = (value: CleanupRelationsManifest) => {
      const { generatedAt: _generatedAt, ...rest } = value;
      return rest;
    };
    expect(stripMeta(second)).toEqual(stripMeta(manifest));
  });

  test("a candidate the classification no longer knows is refused, not guessed", async () => {
    const drifted = {
      ...classification,
      candidates: [
        ...classification.candidates,
        {
          table: "credit_grants",
          recordId: `b347-missing-${run}`,
          externalCustomerId: flightKey,
          attributionSource: "fabricated",
          class: "confirmed_obsolete_test" as const,
          testFeatures: ["test_order_number:fabricated"],
          inFlight: false,
          observedAt: null,
          isolationReason: null,
        },
      ],
    };
    expect(
      evaluateCleanupRelations(database, drifted),
    ).rejects.toThrow(/no longer exists/);
  });

  test("a row the classification does not cover defaults to protected", async () => {
    // Tamper: drop allocation A from the classification's records. The evaluation must treat
    // the unknown row as protected (never cleanable-by-default) — the grant and customer
    // verdicts must not change.
    const tampered = {
      ...classification,
      records: classification.records.filter(
        (record) =>
          !(
            record.table === "credit_reservation_allocations" &&
            record.recordId === flightAllocationId
          ),
      ),
      candidates: classification.candidates.filter(
        (record) =>
          !(
            record.table === "credit_reservation_allocations" &&
            record.recordId === flightAllocationId
          ),
      ),
    };
    const tamperedManifest = await evaluateCleanupRelations(database, tampered);
    const grant = tamperedManifest.evaluations.find(
      (entry) =>
        entry.table === "credit_grants" && entry.recordId === flightGrantId,
    );
    expect(grant).toBeDefined();
    expect(grant!.removed).toBe(true);
    const impact = grant!.retainedImpact.find(
      (entry) => entry.recordId === flightAllocationId,
    );
    expect(impact).toBeDefined();
    expect(impact!.class).toBe("unclassified");
    expect(impact!.protection).toBe("retained");
  });
});
