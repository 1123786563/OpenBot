import { eq, inArray, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import {
  type CleanupClassification,
  classifyCleanup,
} from "../src/billing/cleanup-classification";
import { buildCleanupDryRun } from "../src/billing/cleanup-dry-run";
import { executeAuthorizedCleanup } from "../src/billing/cleanup-execution";
import { guardCleanupDeletion } from "../src/billing/cleanup-guards";
import {
  type CandidateRelationEvaluation,
  type CleanupRelationsManifest,
  EXTERNAL_LIVE_SUBSCRIPTION_STATUSES,
  evaluateCleanupRelations,
} from "../src/billing/cleanup-relations";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccountService } from "../src/billing/payer-accounts";
import { createDatabase } from "../src/db/client";
import {
  billingAccountResolutions,
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
  payerAccounts,
} from "../src/db/schema/billing";
import { billingCallAttributions } from "../src/db/schema/call-attributions";
import { users } from "../src/db/schema/core";
import {
  creditChargeRemainders,
  creditReservationAllocations,
  creditReservations,
  creditSettlementDetails,
  creditSettlementDimensionBreakdown,
} from "../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../src/db/schema/enterprise-tenancy";
import {
  billingAccountAudit,
  billingCreditAccounts,
  billingCustomerMappings,
} from "../src/db/schema/payer-accounts";
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
const resolutionKey = `b347-leg4-${run}`;
const fixtureKeys = [
  companyKey,
  flightKey,
  activeSubKey,
  cleanKey,
  resolutionKey,
];

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

/** K4: clean legacy key whose customer cascade would take a 0176 resolution row, and
 * whose settled hold stands behind a 0179 NO ACTION settlement detail row. */
const resolutionPayerId = `b347-deploy4-${run}`;
const resolutionMappingId = `b347-pa-m4-${run}`;
const resolutionOrderId = `b347-po4-${run}`;
const resolutionRowId = `b347-bar4-${run}`;
const resolutionGrantId = `b347-g5-${run}`;
const resolutionLedgerId = `b347-l4-${run}`;
const resolutionSettledId = `b347-rs4-${run}`;
const resolutionAllocationId = `b347-as4-${run}`;
/** A pending order needs a deployment purchase slot of its own: one pending per scope. */
const cleanOrderScope = `b347-scope-${run}`;

/** The operator-vouched test-evidence registries: the three legacy orders, nothing else. */
const evidenceInput = {
  testOrderIds: [
    flightOrderId,
    activeSubOrderId,
    cleanOrderId,
    resolutionOrderId,
  ],
  testUserIds: [],
};

/** The twenty-nine FK edges the drizzle schema declares around the legacy tables. */
const DECLARED_EDGES: {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  onDelete: string;
}[] = [
  {
    childTable: "payer_accounts",
    childColumn: "external_customer_id",
    parentTable: "billing_customers",
    parentColumn: "external_id",
    onDelete: "cascade",
  },
  {
    childTable: "billing_subscriptions",
    childColumn: "external_customer_id",
    parentTable: "billing_customers",
    parentColumn: "external_id",
    onDelete: "cascade",
  },
  {
    childTable: "credit_grants",
    childColumn: "external_customer_id",
    parentTable: "billing_customers",
    parentColumn: "external_id",
    onDelete: "cascade",
  },
  {
    childTable: "credit_ledger",
    childColumn: "external_customer_id",
    parentTable: "billing_customers",
    parentColumn: "external_id",
    onDelete: "cascade",
  },
  {
    childTable: "credit_ledger",
    childColumn: "grant_id",
    parentTable: "credit_grants",
    parentColumn: "id",
    onDelete: "set_null",
  },
  {
    childTable: "credit_reservations",
    childColumn: "external_customer_id",
    parentTable: "billing_customers",
    parentColumn: "external_id",
    onDelete: "cascade",
  },
  {
    childTable: "credit_reservations",
    childColumn: "ledger_id",
    parentTable: "credit_ledger",
    parentColumn: "id",
    onDelete: "set_null",
  },
  {
    childTable: "credit_reservation_allocations",
    childColumn: "reservation_id",
    parentTable: "credit_reservations",
    parentColumn: "id",
    onDelete: "cascade",
  },
  {
    childTable: "credit_reservation_allocations",
    childColumn: "grant_id",
    parentTable: "credit_grants",
    parentColumn: "id",
    onDelete: "cascade",
  },
  {
    childTable: "credit_charge_remainders",
    childColumn: "external_customer_id",
    parentTable: "billing_customers",
    parentColumn: "external_id",
    onDelete: "cascade",
  },
  {
    childTable: "payment_events",
    childColumn: "order_id",
    parentTable: "payment_orders",
    parentColumn: "id",
    onDelete: "cascade",
  },
  {
    childTable: "credit_reservation_attribution",
    childColumn: "reservation_id",
    parentTable: "credit_reservations",
    parentColumn: "id",
    onDelete: "cascade",
  },
  // 0147 (#276): 08.1's recovery item, the same one-hop shape as the attribution row above.
  {
    childTable: "credit_recovery_items",
    childColumn: "reservation_id",
    parentTable: "credit_reservations",
    parentColumn: "id",
    onDelete: "cascade",
  },
  // 0176 (BP06 #374): the resolution registry's account key, the one-hop shape again.
  {
    childTable: "billing_account_resolutions",
    childColumn: "external_customer_id",
    parentTable: "billing_customers",
    parentColumn: "external_id",
    onDelete: "cascade",
  },
  // 0163 (#436) restored the rest of the upstream children around the estate.
  {
    childTable: "billing_credit_accounts",
    childColumn: "external_customer_id",
    parentTable: "billing_customers",
    parentColumn: "external_id",
    onDelete: "cascade",
  },
  {
    childTable: "billing_customer_mappings",
    childColumn: "external_customer_id",
    parentTable: "billing_customers",
    parentColumn: "external_id",
    onDelete: "cascade",
  },
  {
    childTable: "billing_call_attributions",
    childColumn: "reservation_id",
    parentTable: "credit_reservations",
    parentColumn: "id",
    onDelete: "cascade",
  },
  // The settlement and job family: NO ACTION children, plus the dimension breakdown.
  {
    childTable: "async_jobs",
    childColumn: "reservation_id",
    parentTable: "credit_reservations",
    parentColumn: "id",
    onDelete: "no_action",
  },
  {
    childTable: "batch_jobs",
    childColumn: "reservation_id",
    parentTable: "credit_reservations",
    parentColumn: "id",
    onDelete: "no_action",
  },
  {
    childTable: "credit_settlement_details",
    childColumn: "reservation_id",
    parentTable: "credit_reservations",
    parentColumn: "id",
    onDelete: "no_action",
  },
  {
    childTable: "credit_settlement_details",
    childColumn: "ledger_id",
    parentTable: "credit_ledger",
    parentColumn: "id",
    onDelete: "no_action",
  },
  {
    childTable: "credit_async_settlement_details",
    childColumn: "reservation_id",
    parentTable: "credit_reservations",
    parentColumn: "id",
    onDelete: "no_action",
  },
  {
    childTable: "credit_async_settlement_details",
    childColumn: "ledger_id",
    parentTable: "credit_ledger",
    parentColumn: "id",
    onDelete: "no_action",
  },
  {
    childTable: "credit_speech_settlement_details",
    childColumn: "reservation_id",
    parentTable: "credit_reservations",
    parentColumn: "id",
    onDelete: "no_action",
  },
  {
    childTable: "credit_speech_settlement_details",
    childColumn: "ledger_id",
    parentTable: "credit_ledger",
    parentColumn: "id",
    onDelete: "no_action",
  },
  {
    childTable: "credit_batch_settlement_details",
    childColumn: "ledger_id",
    parentTable: "credit_ledger",
    parentColumn: "id",
    onDelete: "no_action",
  },
  {
    childTable: "realtime_units",
    childColumn: "reservation_id",
    parentTable: "credit_reservations",
    parentColumn: "id",
    onDelete: "no_action",
  },
  {
    childTable: "tool_call_charges",
    childColumn: "reservation_id",
    parentTable: "credit_reservations",
    parentColumn: "id",
    onDelete: "no_action",
  },
  {
    childTable: "credit_settlement_dimension_breakdown",
    childColumn: "ledger_id",
    parentTable: "credit_ledger",
    parentColumn: "id",
    onDelete: "cascade",
  },
];

let classification: CleanupClassification;
let manifest: CleanupRelationsManifest;

afterAll(async () => {
  // Children first, mirroring the FK graph the module evaluates.
  await database
    .delete(paymentEvents)
    .where(
      inArray(paymentEvents.orderId, [
        flightOrderId,
        activeSubOrderId,
        cleanOrderId,
      ]),
    );
  await database
    .delete(paymentOrders)
    .where(
      inArray(paymentOrders.id, [
        flightOrderId,
        activeSubOrderId,
        cleanOrderId,
      ]),
    );
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
    .delete(creditSettlementDetails)
    .where(
      inArray(creditSettlementDetails.reservationId, [resolutionSettledId]),
    );
  await database
    .delete(creditReservationAllocations)
    .where(
      inArray(creditReservationAllocations.reservationId, [
        flightReservedId,
        flightSettledId,
        cleanSettledId,
        resolutionSettledId,
      ]),
    );
  await database
    .delete(creditReservations)
    .where(
      inArray(creditReservations.id, [
        flightReservedId,
        flightSettledId,
        cleanSettledId,
        resolutionSettledId,
      ]),
    );
  await database
    .delete(creditLedger)
    .where(
      inArray(creditLedger.id, [
        flightLedgerId,
        flightLedger2Id,
        cleanLedgerId,
        resolutionLedgerId,
      ]),
    );
  await database
    .delete(creditGrants)
    .where(
      inArray(creditGrants.id, [
        flightGrantId,
        flightSpareGrantId,
        activeSubGrantId,
        cleanGrantId,
        resolutionGrantId,
      ]),
    );
  await database
    .delete(creditChargeRemainders)
    .where(inArray(creditChargeRemainders.externalCustomerId, fixtureKeys));
  await database
    .delete(billingSubscriptions)
    .where(inArray(billingSubscriptions.externalCustomerId, fixtureKeys));
  await database
    .delete(billingAccountResolutions)
    .where(inArray(billingAccountResolutions.id, [resolutionRowId]));
  await database
    .delete(payerAccounts)
    .where(
      inArray(payerAccounts.id, [
        companyMappingId,
        flightMappingId,
        activeSubMappingId,
        cleanMappingId,
        resolutionMappingId,
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
    {
      id: resolutionMappingId,
      kind: "legacy_deployment",
      payerId: resolutionPayerId,
      externalCustomerId: resolutionKey,
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

  // K4's paid, evidenced order — the test-evidence anchor that makes its key cleanable.
  await database.insert(paymentOrders).values({
    id: resolutionOrderId,
    deploymentScope: cleanOrderScope,
    planCode: "legacy-test",
    provider: "alipay",
    amountCents: 4_000,
    status: "paid",
    activationState: "applied",
    ownerPayerKind: "legacy_deployment",
    ownerPayerId: resolutionPayerId,
    expiresAt: new Date("2026-01-01T00:00:00Z"),
    paidAt: new Date("2026-01-01T00:30:00Z"),
    terminalAt: new Date("2026-01-01T00:30:00Z"),
  });

  // The 0176 registry row that key already carries: an operator's authorized disposal
  // decision, the shape billing/account-resolution.ts is the only writer of.
  await database.insert(billingAccountResolutions).values({
    id: resolutionRowId,
    externalCustomerId: resolutionKey,
    action: "refund",
    reasonCode: "paid_not_delivered",
    evidenceKind: "payment_event",
    evidenceReference: `b347-evidence-${run}`,
    operatorId: `b347-op-${run}`,
    idempotencyKey: `b347-idem-${run}`,
    amountCents: 100,
    detail: `b347 fixture resolution ${run}`,
  });

  // K4's settled hold — cleanable on its own — with its 0179 settlement detail row: the
  // NO ACTION child that makes the hold's deletion the database's to refuse.
  await database.insert(creditGrants).values({
    id: resolutionGrantId,
    externalCustomerId: resolutionKey,
    source: "promo",
    total: 5_000,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    idempotencyKey: `b347-promo3-${run}`,
  });
  await database.insert(creditLedger).values({
    id: resolutionLedgerId,
    externalCustomerId: resolutionKey,
    grantId: resolutionGrantId,
    title: `b347 blocked settlement ${run}`,
    idempotencyKey: `b347-ledger4-${run}`,
    credits: 100,
    applied: 100,
  });
  await database.insert(creditReservations).values({
    id: resolutionSettledId,
    externalCustomerId: resolutionKey,
    idempotencyKey: `b347-blocked-settled-${run}`,
    maximum: 1_000,
    status: "settled",
    expiresAt: new Date("2026-01-01T00:00:00Z"),
    terminalAt: new Date("2026-01-01T01:00:00Z"),
    actualNumerator: "10000",
    actualDenominator: "100",
    charged: 100,
    applied: 100,
    released: 900,
    ledgerId: resolutionLedgerId,
  });
  await database.insert(creditReservationAllocations).values({
    id: resolutionAllocationId,
    reservationId: resolutionSettledId,
    grantId: resolutionGrantId,
    amount: 1_000,
    consumed: 100,
  });
  await database.insert(creditSettlementDetails).values({
    reservationId: resolutionSettledId,
    ledgerId: resolutionLedgerId,
    capability: "image",
    requestedCount: 1,
    generatedCount: 1,
    unitPriceUsd: "0.01",
  });

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
      manifest.fkEdges.filter(
        (edge) => edge.childTable === "billing_webhook_events",
      ),
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
    const retainedIds = customer.retainedImpact.map(
      (impact) => impact.recordId,
    );
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
  test("the 0176 resolution registry is retained: a customer cascade into it is pulled", () => {
    // K4 is mapped and evidenced like the other legacy keys — without the resolution row,
    // every row of it would be safe. The one 0176 registry row its customer cascade would
    // delete is an operator's authorized disposal decision (the replay answer and the
    // refund ceiling's prior history — AC18's financial history), so the customer is
    // pulled by cascade impact with the row named, not silently cleaned around.
    const customer = evaluationOf("billing_customers", resolutionKey);
    expect(customer.removed).toBe(true);
    expect(customer.removalReason).toBe("cascade_impact_on_retained");
    expect(customer.evidence).toContain("billing_account_resolutions");
    const impact = customer.retainedImpact.find(
      (entry) =>
        entry.table === "billing_account_resolutions" &&
        entry.recordId === resolutionRowId,
    );
    expect(impact).toBeDefined();
    expect(impact!.effect).toBe("cascade_delete");
    expect(impact!.protection).toBe("retained");
    expect(impact!.class).toBe("unclassified");
    // The registry row rides the customer's cascade scope — probed, so the pull has data
    // behind it, and never itself a candidate the cleanup set could name.
    expect(
      customer.cascadeDeletionScope.some(
        (row) =>
          row.table === "billing_account_resolutions" &&
          row.recordId === resolutionRowId,
      ),
    ).toBe(true);
    // The pull is the resolution's alone: the key's mapping and order stay safe.
    expect(isSafe("payer_accounts", resolutionMappingId)).toBe(true);
    expect(isSafe("payment_orders", resolutionOrderId)).toBe(true);
    expect(
      manifest.safeCandidates.some(
        (entry) => entry.table === "billing_account_resolutions",
      ),
    ).toBe(false);
  });

  test("a NO ACTION settlement child pulls the hold: out-of-estate blockers are never executable", () => {
    // K4's settled hold is evidenced and terminal — cleanable on every 21.2 rule — but it
    // stands behind a 0179 settlement detail row whose FK is NO ACTION: the database
    // refuses the hold's deletion while the detail stands, and the executor deletes only
    // estate rows children-first. The hold is pulled here, with the blocker named, instead
    // of failing as an FK error mid-execution.
    const hold = evaluationOf("credit_reservations", resolutionSettledId);
    expect(hold.removed).toBe(true);
    expect(hold.removalReason).toBe("cascade_impact_on_retained");
    expect(hold.evidence).toContain("delete_blocked");
    expect(hold.evidence).toContain("credit_settlement_details");
    const impact = hold.retainedImpact.find(
      (entry) =>
        entry.table === "credit_settlement_details" &&
        entry.recordId === resolutionSettledId,
    );
    expect(impact).toBeDefined();
    expect(impact!.effect).toBe("delete_blocked");
    expect(impact!.protection).toBe("retained");
    expect(impact!.class).toBe("unclassified");
    expect(
      hold.blockedBy.some((row) => row.table === "credit_settlement_details"),
    ).toBe(true);
    // The blocker reaches up the key's chain too: the ledger line behind the same detail
    // is pulled by its own ledger_id NO ACTION reference.
    const ledger = evaluationOf("credit_ledger", resolutionLedgerId);
    expect(ledger.removed).toBe(true);
    expect(ledger.removalReason).toBe("cascade_impact_on_retained");
    expect(ledger.evidence).toContain("credit_settlement_details");
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
          entry.recordId === flightReservedId ||
          entry.recordId === flightAllocationId,
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
    expect(EXTERNAL_LIVE_SUBSCRIPTION_STATUSES).toEqual([
      "active",
      "incomplete",
    ]);
    expect(manifest.externalActiveSubscriptions).toHaveLength(1);
    const listed = manifest.externalActiveSubscriptions[0];
    expect(listed.externalSubscriptionId).toBe(activeSubscriptionId);
    expect(listed.externalCustomerId).toBe(activeSubKey);
    expect(listed.status).toBe("active");
    expect(listed.planCode).toBe("legacy-active");
    // The anchor is pulled from the cleanup set: a human confirms before anything happens.
    expect(isSafe("billing_subscriptions", activeSubscriptionId)).toBe(false);
    const anchor = removedEntryOf(
      "billing_subscriptions",
      activeSubscriptionId,
    );
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
    await expect(evaluateCleanupRelations(database, drifted)).rejects.toThrow(
      /no longer exists/,
    );
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

/*
 * R2-F1 regression (REV-2 → FIX-2b): the 0163 upstream children carry their own ownership
 * facts, and a legacy payer_accounts mapping on the parent key may never override them.
 * Both minimal reproductions from the REV-2 report are replayed end to end on the real
 * execution path — classify → relations → fresh 21.5 guard → dry-run → authorized
 * execution → post-execution data retention:
 *
 * - Path A registers, through the REAL payer-account service, a quarantined account, an
 *   active company account with its company payment mapping, an active personal account,
 *   and — the estate-semantics boundary — a personal account whose owner IS in this run's
 *   explicit test-user registry. The first three customers must be pulled from the
 *   relations manifest with the owned rows named, refused by the fresh guard, and still
 *   standing after a real authorized execution; the test-owned personal account follows
 *   the estate semantics and is really deleted with its legacy parent.
 * - Path B puts a real company call attribution (tenant/workspace/principal FKs all live)
 *   under a legacy-classified settled chain — settled hold, its ledger line and two
 *   dimension breakdown rows. The attribution is a company accounting fact: the conflict
 *   fail-closes the chain (customer, hold, ledger, breakdown rows all named and retained),
 *   the authorized execution still commits its verified scope, and the company rows are
 *   all still present afterwards.
 */
describe("R2-F1 (REV-2): 0163 ownership is verified before any legacy cascade", () => {
  const fix2b = `fix2b-${Math.random().toString(36).slice(2, 10)}`;
  const actor = `fix2b-review-${fix2b}`;

  // Path A: four evidenced legacy keys, each carrying a real 0163 registration.
  const aTenant = `${fix2b}-a-tenant`;
  const aKeys = {
    quarantined: `${fix2b}-a-q`,
    company: `${fix2b}-a-co`,
    personal: `${fix2b}-a-p`,
    personalTestOwned: `${fix2b}-a-p2`,
  } as const;
  const aPayers = {
    quarantined: `${fix2b}-a-pa-q`,
    company: `${fix2b}-a-pa-co`,
    personal: `${fix2b}-a-pa-p`,
    personalTestOwned: `${fix2b}-a-pa-p2`,
  } as const;
  const aDeploys = {
    quarantined: `${fix2b}-a-deploy-q`,
    company: `${fix2b}-a-deploy-co`,
    personal: `${fix2b}-a-deploy-p`,
    personalTestOwned: `${fix2b}-a-deploy-p2`,
  } as const;
  const aOrders = {
    quarantined: `${fix2b}-a-order-q`,
    company: `${fix2b}-a-order-co`,
    personal: `${fix2b}-a-order-p`,
    personalTestOwned: `${fix2b}-a-order-p2`,
  } as const;
  const aUserPersonal = `${fix2b}-a-user-p`;
  const aUserPersonalTest = `${fix2b}-a-user-p2`;

  // Path B: one evidenced legacy key whose settled chain carries a company attribution.
  const bTenant = `${fix2b}-b-tenant`;
  const bWorkspace = `${fix2b}-b-workspace`;
  const bPrincipal = `${fix2b}-b-principal`;
  const bUser = `${fix2b}-b-user`;
  const bKey = `${fix2b}-b-call`;
  const bPayer = `${fix2b}-b-pa`;
  const bDeploy = `${fix2b}-b-deploy`;
  const bOrder = `${fix2b}-b-order`;
  const bHold = `${fix2b}-b-hold`;
  const bLedger = `${fix2b}-b-ledger`;

  const evidenceA = {
    testOrderIds: [
      aOrders.quarantined,
      aOrders.company,
      aOrders.personal,
      aOrders.personalTestOwned,
    ],
    testUserIds: [aUserPersonalTest],
  };
  const evidenceB = { testOrderIds: [bOrder], testUserIds: [] };

  let aQuarantinedAccountId = "";
  let aCompanyAccountId = "";
  let aPersonalAccountId = "";
  let aPersonalTestAccountId = "";

  const allFix2bCustomers = [
    aKeys.quarantined,
    aKeys.company,
    aKeys.personal,
    aKeys.personalTestOwned,
    bKey,
  ];
  const allFix2bPayers = [
    aPayers.quarantined,
    aPayers.company,
    aPayers.personal,
    aPayers.personalTestOwned,
    bPayer,
  ];
  const allFix2bOrders = [
    aOrders.quarantined,
    aOrders.company,
    aOrders.personal,
    aOrders.personalTestOwned,
    bOrder,
  ];

  beforeAll(async () => {
    // Identity and tenancy the composite FKs require (0163's discipline: a forged
    // attribution row is structurally impossible, so the fixture builds the real graph).
    await database.insert(users).values([
      { id: aUserPersonal, email: `${aUserPersonal}@openbot.test` },
      { id: aUserPersonalTest, email: `${aUserPersonalTest}@openbot.test` },
      { id: bUser, email: `${bUser}@openbot.test` },
    ]);
    await database.insert(enterpriseTenants).values([
      { id: aTenant, name: `fix2b A ${fix2b}` },
      { id: bTenant, name: `fix2b B ${fix2b}` },
    ]);
    await database
      .insert(enterprisePrincipals)
      .values([{ id: bPrincipal, userId: bUser }]);
    await database
      .insert(enterpriseMemberships)
      .values([{ tenantId: bTenant, principalId: bPrincipal, role: "member" }]);
    await database
      .insert(enterpriseWorkspaces)
      .values([
        { tenantId: bTenant, id: bWorkspace, name: `fix2b B ws ${fix2b}` },
      ]);

    // Legacy estate roots: customers, legacy_deployment payer mappings, canceled orders.
    await database.insert(billingCustomers).values(
      allFix2bCustomers.map((externalId) => ({
        externalId,
        name: `fix2b fixture ${externalId}`,
      })),
    );
    await database.insert(payerAccounts).values([
      {
        id: aPayers.quarantined,
        kind: "legacy_deployment",
        payerId: aDeploys.quarantined,
        externalCustomerId: aKeys.quarantined,
      },
      {
        id: aPayers.company,
        kind: "legacy_deployment",
        payerId: aDeploys.company,
        externalCustomerId: aKeys.company,
      },
      {
        id: aPayers.personal,
        kind: "legacy_deployment",
        payerId: aDeploys.personal,
        externalCustomerId: aKeys.personal,
      },
      {
        id: aPayers.personalTestOwned,
        kind: "legacy_deployment",
        payerId: aDeploys.personalTestOwned,
        externalCustomerId: aKeys.personalTestOwned,
      },
      {
        id: bPayer,
        kind: "legacy_deployment",
        payerId: bDeploy,
        externalCustomerId: bKey,
      },
    ]);
    await database.insert(paymentOrders).values(
      (
        [
          [aOrders.quarantined, aDeploys.quarantined],
          [aOrders.company, aDeploys.company],
          [aOrders.personal, aDeploys.personal],
          [aOrders.personalTestOwned, aDeploys.personalTestOwned],
          [bOrder, bDeploy],
        ] as const
      ).map(([id, ownerPayerId], index) => ({
        id,
        deploymentScope: `${fix2b}-scope`,
        planCode: "legacy-test",
        provider: "alipay" as const,
        amountCents: 1_000 + index,
        status: "canceled" as const,
        activationState: "pending" as const,
        ownerPayerKind: "legacy_deployment" as const,
        ownerPayerId,
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        terminalAt: new Date("2026-01-01T00:30:00Z"),
      })),
    );

    // Path B's settled chain first: the attribution's FK needs the hold to stand.
    await database.insert(creditLedger).values({
      id: bLedger,
      externalCustomerId: bKey,
      title: `fix2b B settlement ${fix2b}`,
      idempotencyKey: `${fix2b}-b-ledger`,
      credits: 100,
      applied: 100,
    });
    await database.insert(creditReservations).values({
      id: bHold,
      externalCustomerId: bKey,
      idempotencyKey: `${fix2b}-b-hold`,
      maximum: 1_000,
      status: "settled",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      terminalAt: new Date("2026-01-01T01:00:00Z"),
      actualNumerator: "10000",
      actualDenominator: "100",
      charged: 100,
      applied: 100,
      released: 900,
      ledgerId: bLedger,
    });
    await database.insert(billingCallAttributions).values({
      reservationId: bHold,
      tenantId: bTenant,
      workspaceId: bWorkspace,
      principalId: bPrincipal,
      botRef: `${fix2b}-bot`,
      callKey: `${fix2b}-call`,
    });
    await database.insert(creditSettlementDimensionBreakdown).values([
      { ledgerId: bLedger, dimension: "input_tokens", units: 60 },
      { ledgerId: bLedger, dimension: "output_tokens", units: 40 },
    ]);

    // Path A's 0163 rows are written by the REAL service — the only door — exactly like
    // the REV-2 reproduction, so the regression covers the registrations as production
    // writes them, not a hand-shaped row.
    const service = createPayerAccountService(database);
    const quarantined = await service.quarantineUnknownAccount({
      externalCustomerId: aKeys.quarantined,
      reason: "ownership unresolved (R2-F1 regression)",
      actor,
    });
    aQuarantinedAccountId = quarantined.id;
    await service.bindCompanyCustomer({
      tenantId: aTenant,
      externalCustomerId: aKeys.company,
      actor,
    });
    const company = await service.registerCompanyAccount({
      tenantId: aTenant,
      actor,
    });
    aCompanyAccountId = company.id;
    const personal = await service.registerPersonalAccount({
      userId: aUserPersonal,
      externalCustomerId: aKeys.personal,
      actor,
    });
    aPersonalAccountId = personal.id;
    const personalTestOwned = await service.registerPersonalAccount({
      userId: aUserPersonalTest,
      externalCustomerId: aKeys.personalTestOwned,
      actor,
    });
    aPersonalTestAccountId = personalTestOwned.id;
  });

  afterAll(async () => {
    // Children before parents, mirroring the FK graph; rows a successful execution
    // deleted are no-ops here.
    await database
      .delete(billingCallAttributions)
      .where(eq(billingCallAttributions.reservationId, bHold));
    await database
      .delete(creditSettlementDimensionBreakdown)
      .where(eq(creditSettlementDimensionBreakdown.ledgerId, bLedger));
    await database
      .delete(billingCreditAccounts)
      .where(
        inArray(billingCreditAccounts.id, [
          aQuarantinedAccountId,
          aCompanyAccountId,
          aPersonalAccountId,
          aPersonalTestAccountId,
        ]),
      );
    await database
      .delete(billingCustomerMappings)
      .where(inArray(billingCustomerMappings.tenantId, [aTenant]));
    await database
      .delete(billingAccountAudit)
      .where(eq(billingAccountAudit.actor, actor));
    await database
      .delete(creditReservations)
      .where(inArray(creditReservations.id, [bHold]));
    await database
      .delete(creditLedger)
      .where(inArray(creditLedger.id, [bLedger]));
    await database
      .delete(payerAccounts)
      .where(inArray(payerAccounts.id, allFix2bPayers));
    await database
      .delete(paymentOrders)
      .where(inArray(paymentOrders.id, allFix2bOrders));
    await database
      .delete(billingCustomers)
      .where(inArray(billingCustomers.externalId, allFix2bCustomers));
    await database
      .delete(enterpriseWorkspaces)
      .where(eq(enterpriseWorkspaces.id, bWorkspace));
    await database
      .delete(enterpriseMemberships)
      .where(eq(enterpriseMemberships.tenantId, bTenant));
    await database
      .delete(enterprisePrincipals)
      .where(eq(enterprisePrincipals.id, bPrincipal));
    await database
      .delete(enterpriseTenants)
      .where(inArray(enterpriseTenants.id, [aTenant, bTenant]));
    await database
      .delete(users)
      .where(inArray(users.id, [aUserPersonal, aUserPersonalTest, bUser]));
  });

  /** Fresh rows of a table by identity column, for the post-execution assertions. */
  async function rowsOf(table: string, idColumn: string, ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await database.execute(
      sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.identifier(
        idColumn,
      )} = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id.replaceAll("'", "''")}'`).join(",")}]`)}) ORDER BY 1`,
    );
    return JSON.parse(JSON.stringify(rows)) as Record<string, unknown>[];
  }

  function evaluationIn(
    evaluated: CleanupRelationsManifest,
    table: string,
    recordId: string,
  ): CandidateRelationEvaluation {
    const evaluation = evaluated.evaluations.find(
      (entry) => entry.table === table && entry.recordId === recordId,
    );
    expect(evaluation).toBeDefined();
    return evaluation!;
  }

  function isSafeIn(
    evaluated: CleanupRelationsManifest,
    table: string,
    recordId: string,
  ) {
    return evaluated.safeCandidates.some(
      (entry) => entry.table === table && entry.recordId === recordId,
    );
  }

  test("R2-F1 repro A: service-registered accounts and the company mapping are verified, never cascaded away", async () => {
    // 21.2 still classifies from the legacy mapping alone: all four keys are candidates.
    const classification = await classifyCleanup(database, evidenceA);
    for (const key of Object.values(aKeys)) {
      const record = classification.records.find(
        (entry) =>
          entry.table === "billing_customers" && entry.recordId === key,
      );
      expect(record?.class).toBe("confirmed_obsolete_test");
    }

    // 21.3 verifies ownership and pulls the three keys whose 0163 rows prove a current
    // owner; the test-user-owned personal account follows the estate semantics and its
    // key stays cleanable.
    const evaluated = await evaluateCleanupRelations(database, classification);
    const quarantined = evaluationIn(
      evaluated,
      "billing_customers",
      aKeys.quarantined,
    );
    expect(quarantined.removed).toBe(true);
    expect(quarantined.removalReason).toBe("cascade_impact_on_retained");
    expect(
      quarantined.retainedImpact.some(
        (impact) =>
          impact.table === "billing_credit_accounts" &&
          impact.recordId === aQuarantinedAccountId &&
          impact.protection === "quarantined_account" &&
          impact.class === "unclassified",
      ),
    ).toBe(true);
    expect(quarantined.evidence).toContain("quarantined_account");

    const company = evaluationIn(evaluated, "billing_customers", aKeys.company);
    expect(company.removed).toBe(true);
    expect(
      company.retainedImpact.some(
        (impact) =>
          impact.table === "billing_credit_accounts" &&
          impact.recordId === aCompanyAccountId &&
          impact.protection === "company_account",
      ),
    ).toBe(true);
    expect(
      company.retainedImpact.some(
        (impact) =>
          impact.table === "billing_customer_mappings" &&
          impact.recordId === aTenant &&
          impact.protection === "company_payment_mapping",
      ),
    ).toBe(true);

    const personal = evaluationIn(
      evaluated,
      "billing_customers",
      aKeys.personal,
    );
    expect(personal.removed).toBe(true);
    expect(
      personal.retainedImpact.some(
        (impact) =>
          impact.table === "billing_credit_accounts" &&
          impact.recordId === aPersonalAccountId &&
          impact.protection === "personal_account",
      ),
    ).toBe(true);

    const testOwned = evaluationIn(
      evaluated,
      "billing_customers",
      aKeys.personalTestOwned,
    );
    expect(testOwned.removed).toBe(false);
    expect(
      isSafeIn(evaluated, "billing_customers", aKeys.personalTestOwned),
    ).toBe(true);
    for (const key of [aKeys.quarantined, aKeys.company, aKeys.personal]) {
      expect(isSafeIn(evaluated, "billing_customers", key)).toBe(false);
    }

    // The fresh 21.5 guard refuses the same three with the ownership evidence attached.
    const guard = await guardCleanupDeletion(database, evidenceA, {
      targets: [
        { table: "billing_customers", recordId: aKeys.quarantined },
        { table: "billing_customers", recordId: aKeys.company },
        { table: "billing_customers", recordId: aKeys.personal },
        { table: "billing_customers", recordId: aKeys.personalTestOwned },
      ],
    });
    expect(guard.deletable.map((target) => target.recordId)).toEqual([
      aKeys.personalTestOwned,
    ]);
    for (const key of [aKeys.quarantined, aKeys.company, aKeys.personal]) {
      const refusal = guard.refused.find(
        (entry) =>
          entry.table === "billing_customers" && entry.recordId === key,
      );
      expect(refusal).toBeDefined();
      expect(refusal!.reason).toBe("not_in_verified_deletion_scope");
      expect(refusal!.evidence).toContain("billing_credit_accounts");
    }
    expect(
      guard.refused.find(
        (entry) =>
          entry.table === "billing_customers" &&
          entry.recordId === aKeys.company,
      )!.evidence,
    ).toContain("billing_customer_mappings");

    // The real authorized execution commits its verified scope — and every ownership row
    // is still standing afterwards, while the test-owned chain is really gone.
    const dryRun = await buildCleanupDryRun(database, evidenceA);
    const report = await executeAuthorizedCleanup(database, evidenceA, {
      authorizationVersion: 1,
      authorizedBy: actor,
      authorizedAt: new Date().toISOString(),
      statement: `R2-F1 regression A on ${dryRun.binding.database}: execute the verified scope; service-registered ownership rows must survive`,
      scope: dryRun.binding,
    });
    expect(report.transaction.committed).toBe(true);
    expect(report.postVerification.passed).toBe(true);
    expect(report.accountingSmoke.passed).toBe(true);

    // The three ownership-protected customers, their accounts and the company mapping
    // survived — on disk, after the commit.
    expect(
      await rowsOf("billing_customers", "external_id", [
        aKeys.quarantined,
        aKeys.company,
        aKeys.personal,
      ]),
    ).toHaveLength(3);
    expect(
      await rowsOf("billing_credit_accounts", "id", [
        aQuarantinedAccountId,
        aCompanyAccountId,
        aPersonalAccountId,
      ]),
    ).toHaveLength(3);
    expect(
      await rowsOf("billing_customer_mappings", "tenant_id", [aTenant]),
    ).toHaveLength(1);
    // The estate-semantics arm: the test-user-owned personal account and its legacy
    // parent are really deleted (the protection is evidence-scoped, not table-wide).
    expect(
      await rowsOf("billing_customers", "external_id", [
        aKeys.personalTestOwned,
      ]),
    ).toHaveLength(0);
    expect(
      await rowsOf("billing_credit_accounts", "id", [aPersonalTestAccountId]),
    ).toHaveLength(0);
    // The legacy payer mappings and evidenced orders of the pulled keys stay cleanable —
    // they are the obsolete legacy attribution, unlike the company mapping above.
    expect(
      await rowsOf("payer_accounts", "id", allFix2bPayers.slice(0, 4)),
    ).toHaveLength(0);
    expect(
      await rowsOf("payment_orders", "id", allFix2bOrders.slice(0, 4)),
    ).toHaveLength(0);
  });

  test("R2-F1 repro B: a company call attribution fail-closes its legacy-classified settled chain", async () => {
    const classification = await classifyCleanup(database, evidenceB);
    const customerRecord = classification.records.find(
      (entry) => entry.table === "billing_customers" && entry.recordId === bKey,
    );
    expect(customerRecord?.class).toBe("confirmed_obsolete_test");

    // Relations: the attribution is protected as the company call fact it is; the hold
    // shelters it, the ledger shelters the hold, and the dimension rows are pinned with
    // the ledger — every one named.
    const evaluated = await evaluateCleanupRelations(database, classification);
    const customer = evaluationIn(evaluated, "billing_customers", bKey);
    expect(customer.removed).toBe(true);
    expect(customer.removalReason).toBe("cascade_impact_on_retained");
    expect(
      customer.retainedImpact.some(
        (impact) =>
          impact.table === "billing_call_attributions" &&
          impact.recordId === bHold &&
          impact.protection === "company_call_attribution",
      ),
    ).toBe(true);
    for (const [table, recordId] of [
      ["credit_reservations", bHold],
      ["credit_ledger", bLedger],
      ["credit_settlement_dimension_breakdown", `${bLedger}/input_tokens`],
      ["credit_settlement_dimension_breakdown", `${bLedger}/output_tokens`],
    ] as const) {
      expect(
        customer.retainedImpact.some(
          (impact) =>
            impact.table === table &&
            impact.recordId === recordId &&
            impact.protection === "protects_owned_record",
        ),
      ).toBe(true);
    }

    const hold = evaluationIn(evaluated, "credit_reservations", bHold);
    expect(hold.removed).toBe(true);
    expect(
      hold.retainedImpact.some(
        (impact) =>
          impact.table === "billing_call_attributions" &&
          impact.protection === "company_call_attribution",
      ),
    ).toBe(true);
    expect(hold.evidence).toContain("billing_call_attributions");

    const ledger = evaluationIn(evaluated, "credit_ledger", bLedger);
    expect(ledger.removed).toBe(true);
    // The hold's SET NULL link is what pulls the ledger line itself…
    expect(
      ledger.retainedImpact.some(
        (impact) =>
          impact.table === "credit_reservations" &&
          impact.recordId === bHold &&
          impact.effect === "set_null_mutate" &&
          impact.protection === "protects_owned_record",
      ),
    ).toBe(true);
    // …and the two dimension rows are named on it explicitly (点名).
    for (const dimension of ["input_tokens", "output_tokens"]) {
      expect(
        ledger.retainedImpact.some(
          (impact) =>
            impact.table === "credit_settlement_dimension_breakdown" &&
            impact.recordId === `${bLedger}/${dimension}`,
        ),
      ).toBe(true);
    }
    expect(isSafeIn(evaluated, "billing_customers", bKey)).toBe(false);
    expect(isSafeIn(evaluated, "credit_reservations", bHold)).toBe(false);
    expect(isSafeIn(evaluated, "credit_ledger", bLedger)).toBe(false);

    // Fresh guard: every chain row is refused with the attribution named upstream.
    const guard = await guardCleanupDeletion(database, evidenceB, {
      targets: [
        { table: "billing_customers", recordId: bKey },
        { table: "credit_reservations", recordId: bHold },
        { table: "credit_ledger", recordId: bLedger },
      ],
    });
    expect(guard.deletable).toEqual([]);
    expect(guard.refused).toHaveLength(3);
    for (const refusal of guard.refused) {
      expect(refusal.reason).toBe("not_in_verified_deletion_scope");
    }

    // The real authorized execution commits — and the whole company-attributed chain,
    // the attribution and the dimension details are still there afterwards.
    const dryRun = await buildCleanupDryRun(database, evidenceB);
    const report = await executeAuthorizedCleanup(database, evidenceB, {
      authorizationVersion: 1,
      authorizedBy: actor,
      authorizedAt: new Date().toISOString(),
      statement: `R2-F1 regression B on ${dryRun.binding.database}: execute the verified scope; the company-attributed chain must survive`,
      scope: dryRun.binding,
    });
    expect(report.transaction.committed).toBe(true);
    expect(report.postVerification.passed).toBe(true);
    expect(report.accountingSmoke.passed).toBe(true);

    expect(
      await rowsOf("billing_customers", "external_id", [bKey]),
    ).toHaveLength(1);
    expect(await rowsOf("credit_reservations", "id", [bHold])).toHaveLength(1);
    expect(await rowsOf("credit_ledger", "id", [bLedger])).toHaveLength(1);
    expect(
      await rowsOf("billing_call_attributions", "reservation_id", [bHold]),
    ).toHaveLength(1);
    expect(
      await rowsOf("credit_settlement_dimension_breakdown", "ledger_id", [
        bLedger,
      ]),
    ).toHaveLength(2);
    // The legacy attribution (payer mapping) and the evidenced order stay cleanable.
    expect(await rowsOf("payer_accounts", "id", [bPayer])).toHaveLength(0);
    expect(await rowsOf("payment_orders", "id", [bOrder])).toHaveLength(0);
  });
});

/*
 * R2B-F1 regression (REV-2b → FIX-4): the ownership verdict travels to the key's money.
 * A legacy-classified key that carries a protected 0163 row (company account + company
 * payment mapping, or a quarantined account) keeps its unattributed funding rows — the
 * REV-2b reproducers showed the company grant deleted while the company survived, because
 * protection followed the billing_call_attributions chain and attribution can be missing.
 * The reverse pin: a personal account whose owner IS in the test registry and a key with
 * no 0163 row at all keep the legacy cleanup semantics — their money is really deleted by
 * the same authorized execution.
 */
describe("R2B-F1 (REV-2b): funding rows follow their key's 0163 ownership verdict", () => {
  const fix4 = `fix4-${Math.random().toString(36).slice(2, 10)}`;
  const actor = `fix4-review-${fix4}`;

  const coTenant = `${fix4}-co-tenant`;
  const coKey = `${fix4}-co`;
  const quarKey = `${fix4}-q`;
  const testOwnedKey = `${fix4}-p2`;
  const legacyKey = `${fix4}-legacy`;
  const keys = [coKey, quarKey, testOwnedKey, legacyKey];
  const payers = keys.map((key) => `${key}-pa`);
  const deploys = keys.map((key) => `${key}-deploy`);
  const orders = keys.map((key) => `${key}-order`);
  const testUser = `${fix4}-user`;

  const evidence = { testOrderIds: orders, testUserIds: [testUser] };

  const coLedgerId = `${fix4}-co-ledger`;
  const coHoldId = `${fix4}-co-hold`;
  const legacyLedgerId = `${fix4}-legacy-ledger`;
  const legacyHoldId = `${fix4}-legacy-hold`;

  let coAccountId = "";
  let quarAccountId = "";
  let testOwnedAccountId = "";
  let coGrantId = "";
  let quarGrantId = "";
  let testOwnedGrantId = "";
  let legacyGrantId = "";

  beforeAll(async () => {
    await database
      .insert(users)
      .values([{ id: testUser, email: `${testUser}@openbot.test` }]);
    await database
      .insert(enterpriseTenants)
      .values([{ id: coTenant, name: `fix4 ${fix4}` }]);
    await database.insert(billingCustomers).values(
      keys.map((externalId) => ({
        externalId,
        name: `fix4 fixture ${externalId}`,
      })),
    );
    await database.insert(payerAccounts).values(
      keys.map((key, index) => ({
        id: payers[index],
        kind: "legacy_deployment",
        payerId: deploys[index],
        externalCustomerId: key,
      })),
    );
    await database.insert(paymentOrders).values(
      orders.map((id, index) => ({
        id,
        deploymentScope: `${fix4}-scope`,
        planCode: "legacy-test",
        provider: "alipay" as const,
        amountCents: 2_000 + index,
        status: "canceled" as const,
        activationState: "pending" as const,
        ownerPayerKind: "legacy_deployment" as const,
        ownerPayerId: deploys[index],
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        terminalAt: new Date("2026-01-01T00:30:00Z"),
      })),
    );

    // The 0163 rows through the REAL service: a company account with its payment mapping,
    // a quarantined account, and — the estate-semantics boundary — a personal account
    // whose owner IS in this run's test-user registry. The pure legacy key gets none.
    const service = createPayerAccountService(database);
    await service.bindCompanyCustomer({
      tenantId: coTenant,
      externalCustomerId: coKey,
      actor,
    });
    const company = await service.registerCompanyAccount({
      tenantId: coTenant,
      actor,
    });
    coAccountId = company.id;
    const quarantined = await service.quarantineUnknownAccount({
      externalCustomerId: quarKey,
      reason: "ownership unresolved (R2B-F1 regression)",
      actor,
    });
    quarAccountId = quarantined.id;
    const testOwned = await service.registerPersonalAccount({
      userId: testUser,
      externalCustomerId: testOwnedKey,
      actor,
    });
    testOwnedAccountId = testOwned.id;

    // Post-registration money through the REAL writer — no billing_call_attributions row
    // anywhere in the chain (a plan/promo allowance, not a call).
    const writer = createCreditWriter(database);
    const coGrant = await writer.grantCredits({
      externalCustomerId: coKey,
      source: "promo",
      totalCents: 60_000,
      expiresAt: new Date("2027-06-01T00:00:00Z"),
      reason: `FIX-4 company allowance ${fix4}`,
      idempotencyKey: `${fix4}-co-grant`,
    });
    coGrantId = coGrant.grant.id;
    const quarGrant = await writer.grantCredits({
      externalCustomerId: quarKey,
      source: "promo",
      totalCents: 30_000,
      expiresAt: new Date("2027-06-01T00:00:00Z"),
      reason: `FIX-4 quarantined allowance ${fix4}`,
      idempotencyKey: `${fix4}-q-grant`,
    });
    quarGrantId = quarGrant.grant.id;
    const testOwnedGrant = await writer.grantCredits({
      externalCustomerId: testOwnedKey,
      source: "promo",
      totalCents: 10_000,
      expiresAt: new Date("2027-06-01T00:00:00Z"),
      reason: `FIX-4 registry-personal allowance ${fix4}`,
      idempotencyKey: `${fix4}-p2-grant`,
    });
    testOwnedGrantId = testOwnedGrant.grant.id;
    const legacyGrant = await writer.grantCredits({
      externalCustomerId: legacyKey,
      source: "promo",
      totalCents: 20_000,
      expiresAt: new Date("2027-06-01T00:00:00Z"),
      reason: `FIX-4 legacy allowance ${fix4}`,
      idempotencyKey: `${fix4}-legacy-grant`,
    });
    legacyGrantId = legacyGrant.grant.id;

    // The other two funding tables, one settled chain per boundary key: the company key's
    // chain must shelter with it, the pure legacy key's chain must die with it.
    await database.insert(creditLedger).values([
      {
        id: coLedgerId,
        externalCustomerId: coKey,
        title: `fix4 company settlement ${fix4}`,
        idempotencyKey: `${fix4}-co-ledger`,
        credits: 100,
        applied: 100,
      },
      {
        id: legacyLedgerId,
        externalCustomerId: legacyKey,
        title: `fix4 legacy settlement ${fix4}`,
        idempotencyKey: `${fix4}-legacy-ledger`,
        credits: 100,
        applied: 100,
      },
    ]);
    await database.insert(creditReservations).values([
      {
        id: coHoldId,
        externalCustomerId: coKey,
        idempotencyKey: `${fix4}-co-hold`,
        maximum: 1_000,
        status: "settled",
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        terminalAt: new Date("2026-01-01T01:00:00Z"),
        actualNumerator: "10000",
        actualDenominator: "100",
        charged: 100,
        applied: 100,
        released: 900,
        ledgerId: coLedgerId,
      },
      {
        id: legacyHoldId,
        externalCustomerId: legacyKey,
        idempotencyKey: `${fix4}-legacy-hold`,
        maximum: 1_000,
        status: "settled",
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        terminalAt: new Date("2026-01-01T01:00:00Z"),
        actualNumerator: "10000",
        actualDenominator: "100",
        charged: 100,
        applied: 100,
        released: 900,
        ledgerId: legacyLedgerId,
      },
    ]);
  });

  afterAll(async () => {
    // Children before parents, mirroring the FK graph; rows a successful execution
    // deleted are no-ops here.
    await database
      .delete(billingCreditAccounts)
      .where(
        inArray(
          billingCreditAccounts.id,
          [coAccountId, quarAccountId, testOwnedAccountId].filter(Boolean),
        ),
      );
    await database
      .delete(billingCustomerMappings)
      .where(eq(billingCustomerMappings.tenantId, coTenant));
    await database
      .delete(billingAccountAudit)
      .where(eq(billingAccountAudit.actor, actor));
    await database
      .delete(creditReservations)
      .where(inArray(creditReservations.id, [coHoldId, legacyHoldId]));
    await database
      .delete(creditLedger)
      .where(inArray(creditLedger.id, [coLedgerId, legacyLedgerId]));
    await database
      .delete(creditGrants)
      .where(
        inArray(
          creditGrants.id,
          [coGrantId, quarGrantId, testOwnedGrantId, legacyGrantId].filter(
            Boolean,
          ),
        ),
      );
    await database
      .delete(payerAccounts)
      .where(inArray(payerAccounts.id, payers));
    await database
      .delete(paymentOrders)
      .where(inArray(paymentOrders.id, orders));
    await database
      .delete(billingCustomers)
      .where(inArray(billingCustomers.externalId, keys));
    await database
      .delete(enterpriseTenants)
      .where(eq(enterpriseTenants.id, coTenant));
    await database.delete(users).where(eq(users.id, testUser));
  });

  test("a protected key's unattributed funding rows survive; every legacy arm still cleans", async () => {
    // 21.2 still classifies all four keys from the legacy mapping alone: every money row
    // is a candidate — the shelter has to come from 21.3's ownership verification.
    const classification = await classifyCleanup(database, evidence);
    for (const key of keys) {
      const record = classification.records.find(
        (entry) =>
          entry.table === "billing_customers" && entry.recordId === key,
      );
      expect(record?.class).toBe("confirmed_obsolete_test");
    }

    // Relations: the company and quarantined keys' money is pulled with the ownership
    // verdict named on each row — grant, ledger and settled hold alike, no attribution
    // chain anywhere. The registry-personal key and the pure legacy key keep their money
    // in the safe set.
    const evaluated = await evaluateCleanupRelations(database, classification);
    for (const [table, recordId] of [
      ["credit_grants", coGrantId],
      ["credit_ledger", coLedgerId],
      ["credit_reservations", coHoldId],
      ["credit_grants", quarGrantId],
    ] as const) {
      const evaluation = evaluated.evaluations.find(
        (entry) => entry.table === table && entry.recordId === recordId,
      );
      expect(evaluation).toBeDefined();
      expect(evaluation!.removed).toBe(true);
      expect(
        evaluation!.retainedImpact.some(
          (impact) => impact.protection === "funding_of_protected_key",
        ),
      ).toBe(true);
      expect(
        evaluated.safeCandidates.some(
          (entry) => entry.table === table && entry.recordId === recordId,
        ),
      ).toBe(false);
    }
    for (const [table, recordId] of [
      ["credit_grants", testOwnedGrantId],
      ["credit_grants", legacyGrantId],
      ["credit_ledger", legacyLedgerId],
      ["credit_reservations", legacyHoldId],
    ] as const) {
      const evaluation = evaluated.evaluations.find(
        (entry) => entry.table === table && entry.recordId === recordId,
      );
      expect(evaluation).toBeDefined();
      expect(evaluation!.removed).toBe(false);
      expect(
        evaluated.safeCandidates.some(
          (entry) => entry.table === table && entry.recordId === recordId,
        ),
      ).toBe(true);
    }

    // The fresh 21.5 guard refuses the sheltered money with the same reviewable reason.
    const guard = await guardCleanupDeletion(database, evidence, {
      targets: [
        { table: "credit_grants", recordId: coGrantId },
        { table: "credit_reservations", recordId: coHoldId },
        { table: "credit_grants", recordId: legacyGrantId },
      ],
    });
    expect(guard.refused).toHaveLength(2);
    for (const refusal of guard.refused) {
      expect(refusal.reason).toBe("not_in_verified_deletion_scope");
    }
    expect(guard.deletable).toEqual([
      { table: "credit_grants", recordId: legacyGrantId },
    ]);

    // The real authorized execution commits its verified scope — the company and
    // quarantined money is still standing afterwards, the legacy arms are really gone.
    const dryRun = await buildCleanupDryRun(database, evidence);
    const report = await executeAuthorizedCleanup(database, evidence, {
      authorizationVersion: 1,
      authorizedBy: actor,
      authorizedAt: new Date().toISOString(),
      statement: `R2B-F1 regression on ${dryRun.binding.database}: execute the verified scope; protected-key money must survive`,
      scope: dryRun.binding,
    });
    expect(report.transaction.committed).toBe(true);
    expect(report.postVerification.passed).toBe(true);
    expect(report.accountingSmoke.passed).toBe(true);

    // The ownership survivors: both keys' customers/accounts, the company mapping, and
    // every unattributed funding row of both keys.
    expect(
      await database
        .select({ id: billingCustomers.externalId })
        .from(billingCustomers)
        .where(inArray(billingCustomers.externalId, [coKey, quarKey])),
    ).toHaveLength(2);
    expect(
      await database
        .select({ id: billingCreditAccounts.id })
        .from(billingCreditAccounts)
        .where(inArray(billingCreditAccounts.id, [coAccountId, quarAccountId])),
    ).toHaveLength(2);
    expect(
      await database
        .select({ id: billingCustomerMappings.tenantId })
        .from(billingCustomerMappings)
        .where(eq(billingCustomerMappings.tenantId, coTenant)),
    ).toHaveLength(1);
    expect(
      await database
        .select({ id: creditGrants.id })
        .from(creditGrants)
        .where(inArray(creditGrants.id, [coGrantId, quarGrantId])),
    ).toHaveLength(2);
    expect(
      await database
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(creditLedger.id, coLedgerId)),
    ).toHaveLength(1);
    expect(
      await database
        .select({ id: creditReservations.id })
        .from(creditReservations)
        .where(eq(creditReservations.id, coHoldId)),
    ).toHaveLength(1);

    // The cleanup line still holds, exactly as AC18's other half demands: the pure
    // legacy key is fully deleted (customer, payer, order, grant, ledger, settled hold),
    // and the registry-personal estate arm follows 21.2's semantics — account, customer
    // and money all really gone.
    expect(
      await database
        .select({ id: billingCustomers.externalId })
        .from(billingCustomers)
        .where(inArray(billingCustomers.externalId, [legacyKey, testOwnedKey])),
    ).toHaveLength(0);
    expect(
      await database
        .select({ id: billingCreditAccounts.id })
        .from(billingCreditAccounts)
        .where(eq(billingCreditAccounts.id, testOwnedAccountId)),
    ).toHaveLength(0);
    expect(
      await database
        .select({ id: creditGrants.id })
        .from(creditGrants)
        .where(inArray(creditGrants.id, [legacyGrantId, testOwnedGrantId])),
    ).toHaveLength(0);
    expect(
      await database
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(creditLedger.id, legacyLedgerId)),
    ).toHaveLength(0);
    expect(
      await database
        .select({ id: creditReservations.id })
        .from(creditReservations)
        .where(eq(creditReservations.id, legacyHoldId)),
    ).toHaveLength(0);
    expect(
      await database
        .select({ id: payerAccounts.id })
        .from(payerAccounts)
        .where(inArray(payerAccounts.id, payers)),
    ).toHaveLength(0);
    expect(
      await database
        .select({ id: paymentOrders.id })
        .from(paymentOrders)
        .where(inArray(paymentOrders.id, orders)),
    ).toHaveLength(0);
  });
});
