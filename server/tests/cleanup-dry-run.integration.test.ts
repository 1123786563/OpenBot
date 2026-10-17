import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import {
  classifyCleanup,
  type CleanupClassification,
} from "../src/billing/cleanup-classification";
import {
  evaluateCleanupRelations,
  type CleanupRelationsManifest,
} from "../src/billing/cleanup-relations";
import {
  assembleCleanupDryRunReport,
  buildCleanupDryRun,
  computeCleanupScopeHash,
  DEFAULT_SAMPLE_LIMIT,
  verifyCleanupScopeConfirmation,
  type CleanupDryRunReport,
} from "../src/billing/cleanup-dry-run";
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
 * The legacy billing cleanup dry-run (ticket b5-348) against a real PostgreSQL, gated on
 * TEST_DATABASE_URL like the rest of the integration suite. It consumes group 21.2's
 * classification and group 21.3's relation evaluation and produces the admin-reviewable
 * report: the three lists (to-delete / to-retain / quarantine) with row counts and
 * deterministic samples, the external anchors carried for human confirmation, and a scope
 * hash bound to the full manifest content and versions.
 *
 * The four acceptance criteria, made mechanical here:
 *
 * - AC1 (read-only, repeatable): a full dump of all twelve legacy tables is deep-equal
 *   before and after two dry-runs, and the two reports agree byte for byte except their
 *   generation timestamps — the scope hash is strictly identical.
 * - AC2 (three lists with row counts): to-delete ≡ 21.3's safe candidates, to-retain =
 *   the kept classes plus the candidates 21.3 pulled (with their reasons), quarantine =
 *   21.2's unknown_owner records by isolation reason; the three totals partition every
 *   classified record.
 * - AC3 (hash bound to manifest version): unchanged data re-verifies a taken confirmation;
 *   a new candidate row, a registry change, a manifest version bump or a foreign database
 *   each invalidate it with a named difference; generation timestamps never enter the hash.
 * - AC4 (no credentials or sensitive personal details): the seeded checkout payload, Lago
 *   unique key, personal payer id and amounts must not appear anywhere in the serialized
 *   report — and the hash's coverage is proven with an unsampled row: a change no sample
 *   shows must still change the hash.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = `b348-${Math.random().toString(36).slice(2, 10)}`;

/** The seven fixture keys: two keeps, one quarantine-only, and the four legacy situations. */
const companyKey = `b348-co-${run}`;
const personalKey = `b348-per-${run}`;
const cleanKey = `b348-clean-${run}`;
const unknownKey = `b348-unk-${run}`;
const flightKey = `b348-flt-${run}`;
const activeSubKey = `b348-act-${run}`;
const openOrderKey = `b348-open-${run}`;
const fixtureKeys = [
  companyKey,
  personalKey,
  cleanKey,
  unknownKey,
  flightKey,
  activeSubKey,
  openOrderKey,
];

const companyMappingId = `b348-pa-co-${run}`;
const personalMappingId = `b348-pa-per-${run}`;
const cleanMappingId = `b348-pa-clean-${run}`;
const unknownMappingId = `b348-pa-unk-${run}`;
const flightMappingId = `b348-pa-flt-${run}`;
const activeSubMappingId = `b348-pa-act-${run}`;
const openOrderMappingId = `b348-pa-open-${run}`;

/** Payer subjects: the personal one doubles as the sensitive-marker assertion target. */
const companyPayerId = `b348-co-tenant-${run}`;
const personalPayerMarker = `b348-personal-user-${run}`;
const cleanPayerId = `b348-dep-clean-${run}`;
const unknownPayerId = `b348-dep-unk-${run}`;
const flightPayerId = `b348-dep-flt-${run}`;
const activeSubPayerId = `b348-dep-act-${run}`;
const openOrderPayerId = `b348-dep-open-${run}`;

const companySubscriptionId = `b348-sub-co-${run}`;
const cleanSubscriptionId = `b348-sub-clean-${run}`;
const activeSubscriptionId = `b348-sub-act-${run}`;

const companyGrantId = `b348-g-co-${run}`;
const personalGrantId = `b348-g-per-${run}`;
const cleanGrantId = `b348-g-clean-${run}`;
/** Spare grants pad the clean key's delete group past the sample limit. */
const cleanSpareGrantIds = [1, 2, 3, 4, 5].map(
  (n) => `b348-g-clean-spare-${n}-${run}`,
);
const unknownGrantId = `b348-g-unk-${run}`;
const flightGrantId = `b348-g-flt-${run}`;

const companyLedgerId = `b348-l-co-${run}`;
const cleanLedgerId = `b348-l-clean-${run}`;
const flightLedgerId = `b348-l-flt-${run}`;

const companySettledId = `b348-r-co-${run}`;
const cleanSettledId = `b348-r-clean-${run}`;
const flightReservedId = `b348-r-flt-${run}`;

const companyAllocationId = `b348-a-co-${run}`;
const cleanAllocationId = `b348-a-clean-${run}`;
const flightAllocationId = `b348-a-flt-${run}`;

const cleanWebhookId = `b348-we-clean-${run}`;
const activeSubWebhookId = `b348-we-act-${run}`;

const cleanOutboxId = `b348-uo-clean-${run}`;
const activeSubOutboxId = `b348-uo-act-${run}`;
const openOutboxId = `b348-uo-open-${run}`;

const cleanOrderId = `b348-po-clean-${run}`;
const flightOrderId = `b348-po-flt-${run}`;
const activeSubOrderId = `b348-po-act-${run}`;
const openOrderId = `b348-po-open-${run}`;
/** A pending order needs a deployment purchase slot of its own: one pending per scope. */
const openOrderScope = `b348-scope-open-${run}`;

const cleanEventId = `b348-pe-clean-${run}`;
const flightEventId = `b348-pe-flt-${run}`;
const activeSubEventId = `b348-pe-act-${run}`;
const openEventId = `b348-pe-open-${run}`;

/** Sensitive markers seeded into the estate; none may surface in the report. */
const checkoutSecretMarker = `qr-secret-${run}`;
const lagoSecretMarker = `lago-unique-secret-${run}`;
/** A distinctive amount no legitimate count could collide with. */
const amountMarker = 987654321;

/** The operator-vouched registries: the four legacy orders, nothing else. */
const evidenceInput = {
  testOrderIds: [
    cleanOrderId,
    flightOrderId,
    activeSubOrderId,
    openOrderId,
  ],
  testUserIds: [],
};

/** The twelve legacy tables, in the classification's fixed order — the invariance surface. */
const LEGACY_TABLES = [
  "billing_customers",
  "payer_accounts",
  "billing_subscriptions",
  "billing_webhook_events",
  "credit_grants",
  "credit_ledger",
  "credit_reservations",
  "credit_reservation_allocations",
  "credit_charge_remainders",
  "payment_orders",
  "payment_events",
  "usage_outbox",
] as const;

/** Full dump of every legacy table, JSON-normalized for a stable deep comparison. */
async function dumpLegacyTables(): Promise<Record<string, unknown>> {
  const dumps: Record<string, unknown> = {};
  for (const table of LEGACY_TABLES) {
    const rows = await database.execute(sql.raw(`SELECT * FROM ${table}`));
    dumps[table] = JSON.parse(JSON.stringify(rows));
  }
  return dumps;
}

/** The report without its volatile metadata: the repeatability comparison form. */
function stripVolatile(report: CleanupDryRunReport) {
  const { generatedAt: _generatedAt, basis, ...rest } = report;
  const { classificationGeneratedAt: _c, relationsGeneratedAt: _r, ...basisRest } =
    basis;
  return { ...rest, basis: basisRest };
}

let classification: CleanupClassification;
let relations: CleanupRelationsManifest;
let report: CleanupDryRunReport;

afterAll(async () => {
  // Children first, mirroring the FK graph the modules evaluate.
  await database
    .delete(paymentEvents)
    .where(
      inArray(paymentEvents.orderId, [
        cleanOrderId,
        flightOrderId,
        activeSubOrderId,
        openOrderId,
      ]),
    );
  await database.delete(paymentOrders).where(
    inArray(paymentOrders.id, [
      cleanOrderId,
      flightOrderId,
      activeSubOrderId,
      openOrderId,
    ]),
  );
  await database.delete(usageOutbox).where(
    inArray(usageOutbox.eventId, [
      cleanOutboxId,
      activeSubOutboxId,
      openOutboxId,
    ]),
  );
  await database.delete(billingWebhookEvents).where(
    inArray(billingWebhookEvents.eventId, [cleanWebhookId, activeSubWebhookId]),
  );
  await database
    .delete(creditReservationAllocations)
    .where(
      inArray(creditReservationAllocations.reservationId, [
        companySettledId,
        cleanSettledId,
        flightReservedId,
      ]),
    );
  await database
    .delete(creditReservations)
    .where(
      inArray(creditReservations.id, [
        companySettledId,
        cleanSettledId,
        flightReservedId,
      ]),
    );
  await database.delete(creditLedger).where(
    inArray(creditLedger.id, [companyLedgerId, cleanLedgerId, flightLedgerId]),
  );
  await database.delete(creditGrants).where(
    inArray(creditGrants.id, [
      companyGrantId,
      personalGrantId,
      cleanGrantId,
      ...cleanSpareGrantIds,
      unknownGrantId,
      flightGrantId,
    ]),
  );
  await database.delete(creditChargeRemainders).where(
    inArray(creditChargeRemainders.externalCustomerId, fixtureKeys),
  );
  await database.delete(billingSubscriptions).where(
    inArray(billingSubscriptions.externalCustomerId, fixtureKeys),
  );
  await database.delete(payerAccounts).where(
    inArray(payerAccounts.id, [
      companyMappingId,
      personalMappingId,
      cleanMappingId,
      unknownMappingId,
      flightMappingId,
      activeSubMappingId,
      openOrderMappingId,
    ]),
  );
  await database
    .delete(billingCustomers)
    .where(inArray(billingCustomers.externalId, fixtureKeys));
  await database.$client.close();
});

beforeAll(async () => {
  // Customers and the explicit 02.2 mappings, one per key.
  for (const key of fixtureKeys) {
    await database
      .insert(billingCustomers)
      .values({ externalId: key, name: `b5-348 fixture ${key}` });
  }
  await database.insert(payerAccounts).values([
    {
      id: companyMappingId,
      kind: "company",
      payerId: companyPayerId,
      externalCustomerId: companyKey,
    },
    {
      id: personalMappingId,
      kind: "personal",
      payerId: personalPayerMarker,
      externalCustomerId: personalKey,
    },
    {
      id: cleanMappingId,
      kind: "legacy_deployment",
      payerId: cleanPayerId,
      externalCustomerId: cleanKey,
    },
    {
      id: unknownMappingId,
      kind: "legacy_deployment",
      payerId: unknownPayerId,
      externalCustomerId: unknownKey,
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
      id: openOrderMappingId,
      kind: "legacy_deployment",
      payerId: openOrderPayerId,
      externalCustomerId: openOrderKey,
    },
  ]);

  // Subscriptions: the company key's live one (never the cleanup's business), the clean
  // key's canceled one, and the ACTIVE one that anchors the activesub key.
  await database.insert(billingSubscriptions).values([
    {
      externalCustomerId: companyKey,
      externalSubscriptionId: companySubscriptionId,
      planCode: "company-plan",
      status: "active",
    },
    {
      externalCustomerId: cleanKey,
      externalSubscriptionId: cleanSubscriptionId,
      planCode: "legacy-test",
      status: "canceled",
    },
    {
      externalCustomerId: activeSubKey,
      externalSubscriptionId: activeSubscriptionId,
      planCode: "legacy-active",
      status: "active",
    },
  ]);

  // Grants: the keeps, the evidenced clean chain (a payout grant + five spares, so the
  // delete group exceeds the sample limit), the unevidenced quarantine grant, and the
  // in-flight key's grant.
  await database.insert(creditGrants).values([
    {
      id: companyGrantId,
      externalCustomerId: companyKey,
      source: "promo",
      total: 10_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b348-promo-co-${run}`,
    },
    {
      id: personalGrantId,
      externalCustomerId: personalKey,
      source: "promo",
      total: 10_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b348-promo-per-${run}`,
    },
    {
      id: cleanGrantId,
      externalCustomerId: cleanKey,
      source: "plan",
      total: 20_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `plan:${cleanOrderId}`,
    },
    ...cleanSpareGrantIds.map((id, index) => ({
      id,
      externalCustomerId: cleanKey,
      source: "promo",
      total: 1_000 + index,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b348-promo-spare-${index}-${run}`,
    })),
    {
      id: unknownGrantId,
      externalCustomerId: unknownKey,
      source: "promo",
      total: 5_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b348-promo-unk-${run}`,
    },
    {
      id: flightGrantId,
      externalCustomerId: flightKey,
      source: "promo",
      total: 10_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b348-promo-flt-${run}`,
    },
  ]);

  // Ledger: the keeps' settlement rows and the ledger the RESERVED flight reservation
  // points at (deleting it would SET NULL a retained row's pointer).
  await database.insert(creditLedger).values([
    {
      id: companyLedgerId,
      externalCustomerId: companyKey,
      grantId: companyGrantId,
      title: `b348 company settlement ${run}`,
      idempotencyKey: `b348-ledger-co-${run}`,
      credits: 400,
      applied: 400,
    },
    {
      id: cleanLedgerId,
      externalCustomerId: cleanKey,
      grantId: cleanGrantId,
      title: `b348 clean settlement ${run}`,
      idempotencyKey: `b348-ledger-clean-${run}`,
      credits: 200,
      applied: 200,
    },
    {
      id: flightLedgerId,
      externalCustomerId: flightKey,
      grantId: flightGrantId,
      title: `b348 flight pointer target ${run}`,
      idempotencyKey: `b348-ledger-flt-${run}`,
      credits: 100,
      applied: 100,
    },
  ]);

  // Reservations: the keeps settle; the flight key's hold is still RESERVED (in-flight
  // responsibility — quarantined, and it pulls its evidence chain out of the cleanup).
  await database.insert(creditReservations).values([
    {
      id: companySettledId,
      externalCustomerId: companyKey,
      idempotencyKey: `b348-settled-co-${run}`,
      maximum: 1_000,
      status: "settled",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      terminalAt: new Date("2026-01-01T01:00:00Z"),
      actualNumerator: "40000",
      actualDenominator: "100",
      charged: 400,
      applied: 400,
      released: 600,
      ledgerId: companyLedgerId,
    },
    {
      id: cleanSettledId,
      externalCustomerId: cleanKey,
      idempotencyKey: `b348-settled-clean-${run}`,
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
    {
      id: flightReservedId,
      externalCustomerId: flightKey,
      idempotencyKey: `b348-hold-flt-${run}`,
      maximum: 1_000,
      status: "reserved",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      ledgerId: flightLedgerId,
    },
  ]);

  await database.insert(creditReservationAllocations).values([
    {
      id: companyAllocationId,
      reservationId: companySettledId,
      grantId: companyGrantId,
      amount: 1_000,
      consumed: 400,
    },
    {
      id: cleanAllocationId,
      reservationId: cleanSettledId,
      grantId: cleanGrantId,
      amount: 1_000,
      consumed: 200,
    },
    {
      id: flightAllocationId,
      reservationId: flightReservedId,
      grantId: flightGrantId,
      amount: 1_000,
      consumed: 0,
    },
  ]);

  // Charge remainders: one per legacy key (company/personal need none — they are keeps).
  await database.insert(creditChargeRemainders).values(
    [cleanKey, unknownKey, flightKey, activeSubKey, openOrderKey].map(
      (key, index) => ({
        externalCustomerId: key,
        numerator: `${index}`,
        denominator: "3",
      }),
    ),
  );

  // Webhooks: the clean key's resolves through its canceled subscription; the activesub
  // key's through the ACTIVE one. The clean one carries the Lago unique-key secret.
  await database.insert(billingWebhookEvents).values([
    {
      provider: "lago",
      eventId: cleanWebhookId,
      lagoUniqueKey: lagoSecretMarker,
      webhookType: "subscription.canceled",
      objectId: cleanSubscriptionId,
    },
    {
      provider: "lago",
      eventId: activeSubWebhookId,
      webhookType: "subscription.created",
      objectId: activeSubscriptionId,
    },
  ]);

  // Usage outbox: carries the customer key by VALUE (no FK).
  await database.insert(usageOutbox).values([
    {
      eventId: cleanOutboxId,
      source: "llm",
      externalCustomerId: cleanKey,
      transactionId: `b348-tx-clean-${run}`,
      inputTokens: 10,
      outputTokens: 5,
      model: "gpt-test",
      client: "b5-348-fixture",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      reservationId: cleanSettledId,
      actualCostNumerator: "20000",
      actualCostDenominator: "100",
    },
    {
      eventId: activeSubOutboxId,
      source: "llm",
      externalCustomerId: activeSubKey,
      transactionId: `b348-tx-act-${run}`,
      inputTokens: 10,
      outputTokens: 5,
      model: "gpt-test",
      client: "b5-348-fixture",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      eventId: openOutboxId,
      source: "llm",
      externalCustomerId: openOrderKey,
      transactionId: `b348-tx-open-${run}`,
      inputTokens: 10,
      outputTokens: 5,
      model: "gpt-test",
      client: "b5-348-fixture",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    },
  ]);

  // Orders: three paid (registered test orders — one carries the checkout secret and the
  // distinctive amount), one PENDING (the open gateway association).
  await database.insert(paymentOrders).values([
    {
      id: cleanOrderId,
      deploymentScope: openOrderScope,
      planCode: "legacy-test",
      provider: "alipay",
      amountCents: amountMarker,
      checkoutPayload: checkoutSecretMarker,
      status: "paid",
      activationState: "applied",
      ownerPayerKind: "legacy_deployment",
      ownerPayerId: cleanPayerId,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      paidAt: new Date("2026-01-01T00:30:00Z"),
      terminalAt: new Date("2026-01-01T00:30:00Z"),
    },
    {
      id: flightOrderId,
      deploymentScope: openOrderScope,
      planCode: "legacy-test",
      provider: "wechat",
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
      deploymentScope: openOrderScope,
      planCode: "legacy-test",
      provider: "alipay",
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
      id: openOrderId,
      deploymentScope: openOrderScope,
      planCode: "legacy-test",
      provider: "alipay",
      amountCents: 3_000,
      status: "pending",
      activationState: "pending",
      ownerPayerKind: "legacy_deployment",
      ownerPayerId: openOrderPayerId,
      expiresAt: new Date("2027-06-01T00:00:00Z"),
    },
  ]);

  await database.insert(paymentEvents).values([
    {
      id: cleanEventId,
      orderId: cleanOrderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `b348-ct-clean-${run}`,
      amountCents: amountMarker,
    },
    {
      id: flightEventId,
      orderId: flightOrderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `b348-ct-flt-${run}`,
      amountCents: 1_000,
    },
    {
      id: activeSubEventId,
      orderId: activeSubOrderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `b348-ct-act-${run}`,
      amountCents: 2_000,
    },
    {
      id: openEventId,
      orderId: openOrderId,
      kind: "anomaly",
      code: "created",
      detail: `b348 pending order ${run}`,
    },
  ]);

  classification = await classifyCleanup(database, evidenceInput);
  relations = await evaluateCleanupRelations(database, classification);
  report = await buildCleanupDryRun(database, evidenceInput);
});

/** The report's to-delete group for one table. */
function deleteGroupOf(table: string) {
  const group = report.toDelete.byTable.find(
    (entry) => entry.table === table,
  );
  expect(group).toBeDefined();
  return group!;
}

describe("the cleanup dry-run is read-only and repeatable", () => {
  test("running the dry-run leaves every legacy table byte-identical", async () => {
    const before = await dumpLegacyTables();
    await buildCleanupDryRun(database, evidenceInput);
    await buildCleanupDryRun(database, evidenceInput);
    const after = await dumpLegacyTables();
    expect(after).toEqual(before);
  });

  test("two runs on unchanged data produce the same report and the same hash", async () => {
    const second = await buildCleanupDryRun(database, evidenceInput);
    expect(stripVolatile(second)).toEqual(stripVolatile(report));
    // The strictest form: the binding hashes identically, timestamps excluded by design.
    expect(second.binding.scopeHash).toBe(report.binding.scopeHash);
    expect(second.binding.scopeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the recorded binding is exactly what the manifests hash to", () => {
    expect(report.binding.scopeHash).toBe(
      computeCleanupScopeHash(classification, relations),
    );
  });
});

describe("the dry-run report carries the three review lists with row counts", () => {
  test("to-delete is exactly 21.3's safe candidate set, grouped and counted", () => {
    expect(report.toDelete.totalRows).toBe(27);
    expect(report.toDelete.records).toHaveLength(relations.safeCandidates.length);
    expect([...report.toDelete.records].sort(JSONTextOrder)).toEqual(
      [...relations.safeCandidates]
        .map((entry) => ({
          table: entry.table,
          recordId: entry.recordId,
          externalCustomerId: classification.candidates.find(
            (candidate) =>
              candidate.table === entry.table &&
              candidate.recordId === entry.recordId,
          )!.externalCustomerId,
        }))
        .sort(JSONTextOrder),
    );
    // Per-table counts: the six grant rows (payout + five spares) prove grouping.
    expect(deleteGroupOf("credit_grants").rows).toBe(6);
    expect(deleteGroupOf("payment_orders").rows).toBe(3);
    expect(deleteGroupOf("billing_customers").rows).toBe(1);
    // The clean key's whole chain is deletable, keyed footprint grouped per key.
    const cleanFootprint = report.toDelete.byExternalCustomer.find(
      (entry) => entry.externalCustomerId === cleanKey,
    );
    expect(cleanFootprint!.rows).toBe(17);
    expect(
      report.toDelete.byExternalCustomer.map((entry) => entry.rows).sort((a, b) => a - b),
    ).toEqual([2, 3, 5, 17]);
    // Samples are deterministic: sorted prefixes of the group, bounded by the limit.
    const grantGroup = deleteGroupOf("credit_grants");
    expect(grantGroup.sampleRecordIds).toHaveLength(DEFAULT_SAMPLE_LIMIT);
    expect(grantGroup.sampleRecordIds).toEqual(
      [...grantGroup.sampleRecordIds].sort(),
    );
  });

  test("to-retain counts the kept classes and the candidates 21.3 pulled, with reasons", () => {
    expect(report.toRetain.totalRows).toBe(21);
    expect(report.toRetain.keptByClass).toEqual([
      {
        class: "company_history",
        rows: 7,
        byTable: [
          { table: "billing_customers", rows: 1, sampleRecordIds: [companyKey] },
          { table: "payer_accounts", rows: 1, sampleRecordIds: [companyMappingId] },
          {
            table: "billing_subscriptions",
            rows: 1,
            sampleRecordIds: [companySubscriptionId],
          },
          { table: "credit_grants", rows: 1, sampleRecordIds: [companyGrantId] },
          { table: "credit_ledger", rows: 1, sampleRecordIds: [companyLedgerId] },
          {
            table: "credit_reservations",
            rows: 1,
            sampleRecordIds: [companySettledId],
          },
          {
            table: "credit_reservation_allocations",
            rows: 1,
            sampleRecordIds: [companyAllocationId],
          },
        ],
      },
      {
        class: "personal_records",
        rows: 3,
        byTable: [
          { table: "billing_customers", rows: 1, sampleRecordIds: [personalKey] },
          { table: "payer_accounts", rows: 1, sampleRecordIds: [personalMappingId] },
          { table: "credit_grants", rows: 1, sampleRecordIds: [personalGrantId] },
        ],
      },
    ]);
    expect(report.toRetain.pulledCandidates.total).toBe(
      relations.removedCandidates.length,
    );
    expect(report.toRetain.pulledCandidates.byReason).toEqual({
      cascade_impact_on_retained: 5,
      attribution_basis_of_kept_records: 3,
      external_subscription_anchor: 1,
      external_payment_order_open: 2,
      deletion_blocked_by_retained_reference: 0,
    });
    // The pulled sample names each pulled candidate's reason, in review order.
    for (const pulled of report.toRetain.pulledCandidates.sample) {
      const removed = relations.removedCandidates.find(
        (entry) =>
          entry.table === pulled.table && entry.recordId === pulled.recordId,
      );
      expect(removed).toBeDefined();
      expect(pulled.reason).toBe(removed!.reason);
    }
  });

  test("quarantine counts the unknown_owner records by isolation reason", () => {
    expect(report.quarantine.totalRows).toBe(6);
    expect(report.quarantine.byIsolationReason).toEqual([
      {
        reason: "unknown_attribution",
        rows: 0,
        byTable: [],
      },
      {
        reason: "insufficient_test_evidence",
        rows: 4,
        byTable: [
          {
            table: "billing_customers",
            rows: 1,
            sampleRecordIds: [unknownKey],
          },
          {
            table: "payer_accounts",
            rows: 1,
            sampleRecordIds: [unknownMappingId],
          },
          { table: "credit_grants", rows: 1, sampleRecordIds: [unknownGrantId] },
          {
            table: "credit_charge_remainders",
            rows: 1,
            sampleRecordIds: [unknownKey],
          },
        ],
      },
      {
        reason: "in_flight_reservation",
        rows: 2,
        byTable: [
          {
            table: "credit_reservations",
            rows: 1,
            sampleRecordIds: [flightReservedId],
          },
          {
            table: "credit_reservation_allocations",
            rows: 1,
            sampleRecordIds: [flightAllocationId],
          },
        ],
      },
    ]);
  });

  test("the three lists partition every classified record", () => {
    expect(
      report.toDelete.totalRows +
        report.toRetain.totalRows +
        report.quarantine.totalRows,
    ).toBe(classification.records.length);
    expect(report.summary.recordsTotal).toBe(classification.records.length);
  });

  test("external anchors are carried for human confirmation, never disposed", () => {
    expect(
      report.externalAnchors.activeSubscriptions.sample.map(
        (entry) => entry.externalSubscriptionId,
      ),
    ).toEqual([activeSubscriptionId]);
    expect(
      report.externalAnchors.openOrders.sample.map((entry) => entry.orderId),
    ).toEqual([openOrderId]);
    // Scoped to the cleanup's keys: the company key's live subscription is not listed.
    expect(
      JSON.stringify(report.externalAnchors),
    ).not.toContain(companySubscriptionId);
  });
});

describe("the scope hash is bound to the manifest content and versions", () => {
  test("an unchanged manifest re-verifies a taken confirmation", async () => {
    const fresh = await buildCleanupDryRun(database, evidenceInput);
    const verdict = verifyCleanupScopeConfirmation(report.binding, fresh);
    expect(verdict.valid).toBe(true);
    expect(verdict.differences).toEqual([]);
  });

  test("a new candidate row invalidates every prior confirmation", async () => {
    const before = await buildCleanupDryRun(database, evidenceInput);
    // An extra evidenced grant sorts after every sampled id: no sample, group count or
    // anything human-readable changes except the counts — but the scope grows.
    const driftGrantId = `zzzz-drift-${run}`;
    await database.insert(creditGrants).values({
      id: driftGrantId,
      externalCustomerId: cleanKey,
      source: "promo",
      total: 1,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b348-promo-drift-${run}`,
    });
    try {
      const drifted = await buildCleanupDryRun(database, evidenceInput);
      expect(drifted.toDelete.totalRows).toBe(before.toDelete.totalRows + 1);
      // The grant group's sample is unchanged — the new row sorts beyond it.
      expect(
        drifted.toDelete.byTable.find((entry) => entry.table === "credit_grants")
          ?.sampleRecordIds,
      ).toEqual(
        before.toDelete.byTable.find((entry) => entry.table === "credit_grants")
          ?.sampleRecordIds,
      );
      // ...yet the hash moves: coverage is the full manifests, never the samples.
      expect(drifted.binding.scopeHash).not.toBe(before.binding.scopeHash);
      const verdict = verifyCleanupScopeConfirmation(before.binding, drifted);
      expect(verdict.valid).toBe(false);
      expect(verdict.differences.join("\n")).toMatch(/scope hash/i);
    } finally {
      await database.delete(creditGrants).where(eq(creditGrants.id, driftGrantId));
    }
  });

  test("a registry change invalidates prior confirmations without touching data", async () => {
    const drifted = await buildCleanupDryRun(database, {
      testOrderIds: [...evidenceInput.testOrderIds, `b348-unregistered-${run}`],
      testUserIds: [],
    });
    expect(drifted.binding.scopeHash).not.toBe(report.binding.scopeHash);
    const verdict = verifyCleanupScopeConfirmation(report.binding, drifted);
    expect(verdict.valid).toBe(false);
    expect(verdict.differences.join("\n")).toMatch(/scope hash/i);
  });

  test("a manifest version bump invalidates confirmations by name", () => {
    // Simulate the next relations contract version on otherwise identical content.
    const bumped = {
      ...relations,
      relationsVersion: 2 as unknown as 1,
    };
    const hash = computeCleanupScopeHash(classification, bumped);
    expect(hash).not.toBe(report.binding.scopeHash);
    const verdict = verifyCleanupScopeConfirmation(
      { ...report.binding, scopeHash: hash, manifestVersions: { ...report.binding.manifestVersions, relations: 2 as unknown as 1 } },
      report,
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.differences.join("\n")).toMatch(/relations version/i);
  });

  test("a confirmation never verifies across databases", () => {
    const foreign = { ...report.binding, database: "some-other-db" };
    const verdict = verifyCleanupScopeConfirmation(foreign, report);
    expect(verdict.valid).toBe(false);
    expect(verdict.differences.join("\n")).toMatch(/database/i);
    // The database is inside the hash too: the same content elsewhere hashes differently.
    expect(
      computeCleanupScopeHash(classification, {
        ...relations,
        database: "some-other-db",
      }),
    ).not.toBe(report.binding.scopeHash);
  });

  test("generation timestamps never enter the hash", () => {
    const shiftedClassification = {
      ...classification,
      generatedAt: "2030-01-01T00:00:00.000Z",
    };
    const shiftedRelations = {
      ...relations,
      generatedAt: "2030-01-01T00:00:00.000Z",
      basis: {
        ...relations.basis,
        classificationGeneratedAt: "2030-01-01T00:00:00.000Z",
      },
    };
    expect(
      computeCleanupScopeHash(shiftedClassification, shiftedRelations),
    ).toBe(report.binding.scopeHash);
  });
});

describe("the report is safe to hand to an administrator", () => {
  test("no credential, amount or personal payer identifier surfaces anywhere", () => {
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(checkoutSecretMarker);
    expect(serialized).not.toContain(lagoSecretMarker);
    expect(serialized).not.toContain(personalPayerMarker);
    expect(serialized).not.toContain(String(amountMarker));
    // The sensitive field names themselves have no path into the report.
    for (const forbidden of [
      "amountCents",
      "checkoutPayload",
      "lagoUniqueKey",
      "bodyHash",
      "channelTransactionId",
      "payerId",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("delete-list entries carry only the review identifiers", () => {
    for (const record of report.toDelete.records) {
      expect(Object.keys(record).sort()).toEqual([
        "externalCustomerId",
        "recordId",
        "table",
      ]);
    }
  });

  test("a mismatched classification/relations pair is refused, not hashed", () => {
    const tampered = {
      ...classification,
      evidenceInput: {
        ...classification.evidenceInput,
        sha256: "0".repeat(64),
      },
    };
    expect(() =>
      assembleCleanupDryRunReport(tampered, relations),
    ).toThrow(/evidence sha256/i);
  });

  test("the sample limit is honored", async () => {
    const tiny = await buildCleanupDryRun(database, evidenceInput, {
      sampleLimit: 1,
    });
    for (const group of tiny.toDelete.byTable) {
      expect(group.sampleRecordIds.length).toBeLessThanOrEqual(1);
    }
  });
});

/** Lexicographic order over JSON-encoded rows — a stable total order for record lists. */
function JSONTextOrder(a: unknown, b: unknown) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

