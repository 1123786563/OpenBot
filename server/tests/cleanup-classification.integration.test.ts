import { createHash } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import {
  classifyCleanup,
  reclassifyFromManifest,
  type ClassifiedRecord,
  type CleanupClassification,
} from "../src/billing/cleanup-classification";
import { enumerateCleanupManifest } from "../src/billing/cleanup-manifest";
import { createDatabase } from "../src/db/client";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
  payerAccounts,
} from "../src/db/schema/billing";
import {
  creditChargeRemainders,
} from "../src/db/schema/credit-reservations";
import { creditGrants } from "../src/db/schema/credits";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { usageOutbox } from "../src/db/schema/usage-outbox";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The legacy billing classification (ticket b5-346) against a real PostgreSQL, gated on
 * TEST_DATABASE_URL like the rest of the integration suite. It sits on top of group 21.1's
 * enumeration (the same READ ONLY transaction fence, the same documented attribution
 * linkages) and answers the question 21.1 deliberately left open: for every legacy billing
 * record, may it ever be cleaned — with reviewable evidence, never a naming guess.
 *
 * The fixture builds all four verdict classes the ticket names:
 *
 * - a company key whose history must be kept: one of its orders carries BOTH test markers
 *   (its id is in the test-order registry AND it was created by a registered test user) —
 *   and the classification must still keep every company record out of the candidate set,
 * - a personal key with a grant and a still-open reservation: kept,
 * - a legacy_deployment key WITH explicit test evidence: a registry-listed paid order
 *   (attributed through the `plan:<orderId>` payout-grant linkage), a second order created
 *   by a registered test user (attributed through the 10.1 owner pair), subscription,
 *   webhook (one resolving through the subscription, one resolving to nothing), a promo
 *   grant, a settled reservation with its allocation, a usage-outbox row and a charge
 *   remainder — all candidates — plus a still-RESERVED reservation with its allocation,
 *   which stays quarantined as in-flight responsibility,
 * - a legacy_deployment key with NO test evidence anywhere: every record it owns is
 *   unknown_owner (insufficient evidence), never a candidate,
 * - an explicitly quarantined unknown_owner key and a key with no payer mapping at all.
 *
 * Under classification:
 * - candidates are exactly the confirmed_obsolete_test records, each carrying non-empty
 *   attribution evidence AND non-empty test-data evidence (AC2),
 * - company records never appear among candidates, whatever their rows also match (AC1),
 * - insufficient evidence isolates: unknown attribution, evidence-less legacy keys and
 *   in-flight reservations are unknown_owner, never candidates (AC3),
 * - the rules, the evidence registries (with their hash) and every record's evidence are
 *   persisted in the manifest, and `reclassifyFromManifest` re-derives the whole verdict —
 *   matching the honest manifest and detecting a tampered one (AC4).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const run = `b346-${randomId()}`;

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

/** The six fixture keys: one per verdict the classification must keep apart. */
const personalKey = `b346-per-${run}`;
const companyKey = `b346-co-${run}`;
const legacyTestKey = `b346-leg-test-${run}`;
const legacyPlainKey = `b346-leg-plain-${run}`;
const unknownKey = `b346-unk-${run}`;
const unmappedKey = `b346-map-${run}`;
const fixtureKeys = [
  personalKey,
  companyKey,
  legacyTestKey,
  legacyPlainKey,
  unknownKey,
  unmappedKey,
];

const legacyDeploymentId = `b346-deploy-${run}`;
const testUser = `b346-test-user-${run}`;
const legacyTestIdOrder = `b346-po-registered-${run}`;
const legacyOrderByUser = `b346-po-byuser-${run}`;
const companyOrderId = `b346-po-company-${run}`;
const legacySubscriptionId = `b346-sub-${run}`;
const webhookHitId = `b346-we-hit-${run}`;
const webhookMissId = `b346-we-miss-${run}`;
const legacyOutboxId = `b346-uo-${run}`;

/** The operator-vouched test-evidence registries: the ONLY test-data evidence there is.
 * The company order is deliberately registered too — the loudest marker a company record
 * can carry, which must still never make it a candidate. */
const evidenceInput = {
  testOrderIds: [legacyTestIdOrder, companyOrderId],
  testUserIds: [testUser],
};

afterAll(async () => {
  // Children first: payment rows and outbox/webhook rows have no customer FK to cascade for.
  await database
    .delete(paymentEvents)
    .where(eq(paymentEvents.orderId, legacyTestIdOrder));
  await database
    .delete(paymentOrders)
    .where(
      inArray(paymentOrders.id, [
        legacyTestIdOrder,
        legacyOrderByUser,
        companyOrderId,
      ]),
    );
  await database
    .delete(usageOutbox)
    .where(inArray(usageOutbox.externalCustomerId, fixtureKeys));
  await database
    .delete(billingWebhookEvents)
    .where(inArray(billingWebhookEvents.eventId, [webhookHitId, webhookMissId]));
  // billing_customers cascades to payer_accounts, subscriptions, grants, ledger,
  // reservations (and their allocations) and remainders.
  await database
    .delete(billingCustomers)
    .where(inArray(billingCustomers.externalId, fixtureKeys));
  await database.$client.close();
});

/** Every classified record attributed to one external customer key. */
function recordsOf(
  classification: CleanupClassification,
  key: string | null,
): ClassifiedRecord[] {
  return classification.records.filter(
    (record) => record.externalCustomerId === key,
  );
}

describe("the legacy billing classification separates keep, candidate and quarantine", () => {
  test("seeding: every verdict class carries its own billing objects", async () => {
    for (const key of fixtureKeys) {
      await database
        .insert(billingCustomers)
        .values({ externalId: key, name: `b5-346 fixture ${key}` });
    }
    // Explicit payer mappings for five of the six keys; the sixth stays unmapped.
    await database.insert(payerAccounts).values([
      {
        id: `b346-pa-per-${run}`,
        kind: "personal",
        payerId: `b346-user-${run}`,
        externalCustomerId: personalKey,
      },
      {
        id: `b346-pa-co-${run}`,
        kind: "company",
        payerId: `b346-tenant-${run}`,
        externalCustomerId: companyKey,
      },
      {
        id: `b346-pa-leg-test-${run}`,
        kind: "legacy_deployment",
        payerId: legacyDeploymentId,
        externalCustomerId: legacyTestKey,
      },
      {
        id: `b346-pa-leg-plain-${run}`,
        kind: "legacy_deployment",
        payerId: `b346-deploy-plain-${run}`,
        externalCustomerId: legacyPlainKey,
      },
      {
        id: `b346-pa-unk-${run}`,
        kind: "unknown_owner",
        payerId: unknownKey,
        externalCustomerId: unknownKey,
      },
    ]);

    // Personal: a grant and a still-open reservation (kept, with its in-flight flag honest).
    await writer.grantCredits({
      externalCustomerId: personalKey,
      source: "plan",
      totalCents: 50_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-346 fixture ${run}`,
      idempotencyKey: `b346-per-grant-${run}`,
    });
    const personalHold = await writer.reserveCredits({
      externalCustomerId: personalKey,
      idempotencyKey: `b346-per-hold-${run}`,
      maximumCents: 800,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    if (!personalHold.reserved) throw new Error("fixture personal hold was refused");

    // Company: a grant and one order that carries BOTH test markers — its id is in the
    // test-order registry and it was created by the registered test user. Company history
    // must stay kept even under the loudest test markers there are.
    await writer.grantCredits({
      externalCustomerId: companyKey,
      source: "promo",
      totalCents: 20_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-346 fixture ${run}`,
      idempotencyKey: `b346-co-grant-${run}`,
    });
    await database.insert(paymentOrders).values({
      id: companyOrderId,
      planCode: "plan-pro",
      provider: "alipay",
      amountCents: 1000,
      status: "pending",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      createdBy: testUser,
      ownerPayerKind: "company",
      ownerPayerId: `b346-tenant-${run}`,
    });

    // Legacy deployment WITH test evidence: the full old stack.
    await database.insert(billingSubscriptions).values({
      externalCustomerId: legacyTestKey,
      externalSubscriptionId: legacySubscriptionId,
      planCode: "plan-pro",
      status: "active",
    });
    await database.insert(billingWebhookEvents).values([
      {
        provider: "lago",
        eventId: webhookHitId,
        webhookType: "subscription.updated",
        objectId: legacySubscriptionId,
      },
      {
        provider: "lago",
        eventId: webhookMissId,
        webhookType: "invoice.created",
        objectId: `b346-lago-nope-${run}`,
      },
    ]);
    await writer.grantCredits({
      externalCustomerId: legacyTestKey,
      source: "promo",
      totalCents: 5_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-346 fixture ${run}`,
      idempotencyKey: `b346-leg-promo-${run}`,
    });
    // The registry-listed paid order: attributed through its `plan:<orderId>` payout grant.
    await database.insert(paymentOrders).values({
      id: legacyTestIdOrder,
      planCode: "plan-pro",
      provider: "alipay",
      amountCents: 1000,
      status: "paid",
      activationState: "applied",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      paidAt: new Date(),
      terminalAt: new Date(),
      createdBy: `b346-real-user-${run}`,
    });
    await database.insert(paymentEvents).values({
      id: `b346-pe-${run}`,
      orderId: legacyTestIdOrder,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `b346-ch-${run}`,
      amountCents: 1000,
      detail: "",
    });
    await writer.grantCredits({
      externalCustomerId: legacyTestKey,
      source: "plan",
      totalCents: 10_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-346 fixture paid order ${legacyTestIdOrder}`,
      idempotencyKey: `plan:${legacyTestIdOrder}`,
    });
    // A second legacy order: created by the registered test user, attributed through the
    // 10.1 owner pair, NOT itself listed in the order registry.
    await database.insert(paymentOrders).values({
      id: legacyOrderByUser,
      planCode: "plan-pro",
      provider: "wechat",
      amountCents: 500,
      status: "expired",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      terminalAt: new Date(),
      createdBy: testUser,
      ownerPayerKind: "legacy_deployment",
      ownerPayerId: legacyDeploymentId,
    });
    await database.insert(creditChargeRemainders).values({
      externalCustomerId: legacyTestKey,
      numerator: "1",
      denominator: "3",
    });
    await database.insert(usageOutbox).values({
      eventId: legacyOutboxId,
      source: "code_run",
      externalCustomerId: legacyTestKey,
      transactionId: `b346-tx-${run}`,
      inputTokens: 10,
      outputTokens: 5,
      model: "gpt-test",
      client: "cli",
      occurredAt: new Date(),
    });
    // One settled legacy reservation (its responsibility closed — cleanable with the key)
    // and one still-reserved (in-flight responsibility — never a candidate).
    const settledHold = await writer.reserveCredits({
      externalCustomerId: legacyTestKey,
      idempotencyKey: `b346-leg-hold-settled-${run}`,
      maximumCents: 800,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    if (!settledHold.reserved) throw new Error("fixture settled hold was refused");
    await writer.settleReservation({
      reservationId: settledHold.reservationId,
      actual: { numerator: 250n, denominator: 1n },
      title: "b5-346 fixture legacy settled call",
    });
    const openHold = await writer.reserveCredits({
      externalCustomerId: legacyTestKey,
      idempotencyKey: `b346-leg-hold-open-${run}`,
      maximumCents: 300,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    if (!openHold.reserved) throw new Error("fixture open hold was refused");

    // Legacy deployment WITHOUT any test evidence: a grant nobody may clean on a guess.
    await writer.grantCredits({
      externalCustomerId: legacyPlainKey,
      source: "promo",
      totalCents: 2_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-346 fixture ${run}`,
      idempotencyKey: `b346-legplain-grant-${run}`,
    });

    // Unknown owner: quarantined by 02.2, still holding a grant nobody may move.
    await writer.grantCredits({
      externalCustomerId: unknownKey,
      source: "signin",
      totalCents: 1_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-346 fixture ${run}`,
      idempotencyKey: `b346-unk-grant-${run}`,
    });

    // Unmapped: billing rows but no payer_accounts row at all.
    await writer.grantCredits({
      externalCustomerId: unmappedKey,
      source: "promo",
      totalCents: 2_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-346 fixture ${run}`,
      idempotencyKey: `b346-map-grant-${run}`,
    });

    for (const key of fixtureKeys) {
      const rows = await database
        .select({ id: creditGrants.id })
        .from(creditGrants)
        .where(eq(creditGrants.externalCustomerId, key));
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  test("company history is kept and never a cleanup candidate, however loud the test markers", async () => {
    const classification = await classifyCleanup(database, evidenceInput);

    // Every company record is company_history.
    const companyRecords = recordsOf(classification, companyKey);
    expect(companyRecords.length).toBeGreaterThanOrEqual(3); // customer, payer mapping, grant, order
    for (const record of companyRecords) {
      expect(record.class).toBe("company_history");
      expect(record.isolationReason).toBeNull();
    }

    // The company order carries BOTH test markers as recorded evidence...
    const companyOrder = companyRecords.find(
      (record) => record.recordId === companyOrderId,
    );
    expect(companyOrder).toBeDefined();
    expect(companyOrder?.testFeatures).toContain(
      `test_order_number:${companyOrderId}`,
    );
    expect(companyOrder?.testFeatures).toContain(`test_user_marker:${testUser}`);

    // ...and is still not a candidate: rule R1 outranks any test marker.
    const candidateIds = new Set(
      classification.candidates.map((record) => record.recordId),
    );
    expect(candidateIds.has(companyOrderId)).toBe(false);
    for (const record of companyRecords) {
      expect(candidateIds.has(record.recordId)).toBe(false);
    }
    // No company record anywhere in the candidate set, and none marked in-flight-quarantined
    // into unknown_owner either.
    for (const candidate of classification.candidates) {
      expect(candidate.externalCustomerId).not.toBe(companyKey);
    }
  });

  test("legacy test evidence makes exactly the evidenced key's closed records candidates", async () => {
    const classification = await classifyCleanup(database, evidenceInput, {
      enumeration: await enumerateCleanupManifest(database),
    });

    // The evidenced legacy key's closed billing footprint is candidates.
    const legacyRecords = recordsOf(classification, legacyTestKey);
    const expectedCandidateIds = [
      legacyTestKey, // the billing_customers row the key cascades from
      `b346-pa-leg-test-${run}`, // the payer mapping row
      legacySubscriptionId, // subscription
      webhookHitId, // the resolving webhook
      legacyTestIdOrder, // the registry-listed order
      legacyOrderByUser, // the test-user-created order
      `b346-pe-${run}`, // the order's payment event
      legacyOutboxId, // usage outbox row
      legacyTestKey, // the charge remainder (same id as the customer row's key)
    ];
    for (const id of expectedCandidateIds) {
      const record = legacyRecords.find((entry) => entry.recordId === id);
      expect(record, `expected candidate record ${id}`).toBeDefined();
      expect(record?.class).toBe("confirmed_obsolete_test");
    }
    // The grants (promo + the paid order's payout grant) are writer-id'd, not key-named:
    // every grant under the evidenced key is a candidate.
    const legacyGrants = legacyRecords.filter(
      (record) => record.table === "credit_grants",
    );
    expect(legacyGrants.length).toBeGreaterThanOrEqual(2);
    for (const grant of legacyGrants) {
      expect(grant.class).toBe("confirmed_obsolete_test");
      expect(grant.testFeatures.length).toBeGreaterThan(0);
    }

    // AC2: every candidate carries reviewable attribution AND test-data evidence.
    expect(classification.candidates.length).toBeGreaterThanOrEqual(
      expectedCandidateIds.length,
    );
    for (const candidate of classification.candidates) {
      expect(candidate.class).toBe("confirmed_obsolete_test");
      expect(candidate.attributionSource.length).toBeGreaterThan(0);
      expect(candidate.testFeatures.length).toBeGreaterThan(0);
      expect(candidate.inFlight).toBe(false);
      expect(candidate.isolationReason).toBeNull();
    }

    // The attribution evidence names the linkage it rode in on.
    const grantLinked = classification.candidates.find(
      (record) => record.recordId === legacyTestIdOrder,
    );
    expect(grantLinked?.attributionSource).toContain(`plan:${legacyTestIdOrder}`);
    const ownerPaired = classification.candidates.find(
      (record) => record.recordId === legacyOrderByUser,
    );
    expect(ownerPaired?.attributionSource).toContain("owner pair");
    const webhookRide = classification.candidates.find(
      (record) => record.recordId === webhookHitId,
    );
    expect(webhookRide?.attributionSource).toContain(legacySubscriptionId);

    // The settled reservation closed its responsibility, so it is a candidate; its
    // allocation too. The still-reserved hold and its allocation are not (tested below).
    const legacyCandidates = classification.candidates.filter(
      (record) => record.externalCustomerId === legacyTestKey,
    );
    const legacyAllocations = legacyRecords.filter(
      (record) => record.table === "credit_reservation_allocations",
    );
    expect(
      legacyAllocations.filter(
        (record) => record.class === "confirmed_obsolete_test",
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      legacyCandidates.filter(
        (record) => record.table === "credit_reservations",
      ).length,
    ).toBeGreaterThanOrEqual(1);

    // candidates are EXACTLY the confirmed_obsolete_test records — no second path in.
    expect(classification.candidates).toEqual(
      classification.records.filter(
        (record) => record.class === "confirmed_obsolete_test",
      ),
    );

    // The per-class summary partitions the records and carries the class's time range.
    const summarySum =
      classification.summary.company_history.count +
      classification.summary.personal_records.count +
      classification.summary.confirmed_obsolete_test.count +
      classification.summary.unknown_owner.count;
    expect(summarySum).toBe(classification.records.length);
    expect(classification.summary.confirmed_obsolete_test.count).toBe(
      classification.candidates.length,
    );
    expect(
      classification.summary.confirmed_obsolete_test.timeRange.min,
    ).toBeString();
  });

  test("insufficient evidence quarantines as unknown_owner and never reaches candidates", async () => {
    const classification = await classifyCleanup(database, evidenceInput);

    // A legacy key with no test evidence anywhere: unknown_owner, insufficient evidence.
    const plainGrant = recordsOf(classification, legacyPlainKey).find(
      (record) => record.table === "credit_grants",
    );
    expect(plainGrant?.class).toBe("unknown_owner");
    expect(plainGrant?.isolationReason).toBe("insufficient_test_evidence");
    expect(plainGrant?.testFeatures).toEqual([]);

    // The 02.2 quarantine and the no-mapping key: unknown attribution.
    const unknownGrant = recordsOf(classification, unknownKey).find(
      (record) => record.table === "credit_grants",
    );
    expect(unknownGrant?.class).toBe("unknown_owner");
    expect(unknownGrant?.isolationReason).toBe("unknown_attribution");
    const unmappedGrant = recordsOf(classification, unmappedKey).find(
      (record) => record.table === "credit_grants",
    );
    expect(unmappedGrant?.class).toBe("unknown_owner");
    expect(unmappedGrant?.isolationReason).toBe("unknown_attribution");

    // The webhook that resolves to nothing is not guessed into any attribution.
    const webhookMiss = classification.records.find(
      (record) => record.recordId === webhookMissId,
    );
    expect(webhookMiss?.class).toBe("unknown_owner");
    expect(webhookMiss?.isolationReason).toBe("unknown_attribution");
    expect(webhookMiss?.externalCustomerId).toBeNull();

    // In-flight responsibility of the EVIDENCED legacy key stays quarantined: the open
    // reservation and its allocation are unknown_owner with the in-flight reason.
    const openReservation = classification.records.find(
      (record) =>
        record.table === "credit_reservations" &&
        record.externalCustomerId === legacyTestKey &&
        record.inFlight,
    );
    expect(openReservation?.class).toBe("unknown_owner");
    expect(openReservation?.isolationReason).toBe("in_flight_reservation");
    const openAllocation = classification.records.find(
      (record) =>
        record.table === "credit_reservation_allocations" &&
        record.inFlight &&
        record.externalCustomerId === legacyTestKey,
    );
    expect(openAllocation?.class).toBe("unknown_owner");
    expect(openAllocation?.isolationReason).toBe("in_flight_reservation");

    // The personal open reservation is kept (personal_records) with its in-flight flag honest.
    const personalOpen = classification.records.find(
      (record) =>
        record.table === "credit_reservations" &&
        record.externalCustomerId === personalKey,
    );
    expect(personalOpen?.class).toBe("personal_records");
    expect(personalOpen?.inFlight).toBe(true);

    // None of the quarantined records reached the candidate set.
    const candidateIds = new Set(
      classification.candidates.map((record) => record.recordId),
    );
    for (const record of classification.records) {
      if (record.class === "unknown_owner") {
        expect(candidateIds.has(record.recordId)).toBe(false);
      }
    }

    // unknownOwners are EXACTLY the unknown_owner records.
    expect(classification.unknownOwners).toEqual(
      classification.records.filter(
        (record) => record.class === "unknown_owner",
      ),
    );
  });

  test("rules, registries and evidence persist in the manifest and survive re-derivation", async () => {
    const classification = await classifyCleanup(database, evidenceInput);

    // The four rules are recorded, each with its stated scope.
    expect(classification.rules.map((rule) => rule.id)).toEqual([
      "R1-company-history-kept",
      "R2-personal-records-kept",
      "R3-confirmed-obsolete-test",
      "R4-unknown-owner-isolated",
    ]);
    for (const rule of classification.rules) {
      expect(rule.description.length).toBeGreaterThan(0);
    }

    // The registries are recorded normalized, with the hash an independent reviewer re-derives.
    expect(classification.evidenceInput.testOrderIds).toEqual(
      [...evidenceInput.testOrderIds].sort(),
    );
    expect(classification.evidenceInput.testUserIds).toEqual(
      [...evidenceInput.testUserIds].sort(),
    );
    expect(classification.evidenceInput.sha256).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            testOrderIds: [...evidenceInput.testOrderIds].sort(),
            testUserIds: [...evidenceInput.testUserIds].sort(),
          }),
        )
        .digest("hex"),
    );

    // The classification covers exactly the enumerated legacy table set (the 21.1 contract).
    const enumeration = await enumerateCleanupManifest(database);
    expect(new Set(classification.records.map((record) => record.table))).toEqual(
      new Set(enumeration.tables.map((table) => table.table)),
    );

    // AC4: an honest manifest re-derives to itself.
    const verdict = await reclassifyFromManifest(database, classification);
    expect(verdict.matches).toBe(true);
    expect(verdict.differences).toEqual([]);

    // A tampered manifest — the executor's imagined one-record adjustment — is DETECTED.
    const tampered: CleanupClassification = structuredClone(classification);
    const victim = tampered.records.find(
      (record) => record.class === "confirmed_obsolete_test",
    );
    expect(victim).toBeDefined();
    victim.class = "unknown_owner";
    const detection = await reclassifyFromManifest(database, tampered);
    expect(detection.matches).toBe(false);
    expect(detection.differences.length).toBeGreaterThan(0);

    // Two classifications of the same data agree on everything but the timestamp.
    const second = await classifyCleanup(database, evidenceInput);
    const stable = (manifest: CleanupClassification) =>
      JSON.stringify({
        rules: manifest.rules,
        evidenceInput: manifest.evidenceInput,
        records: manifest.records,
        summary: manifest.summary,
      });
    expect(stable(second)).toBe(stable(classification));
  });

  test("classification refuses to run where the enumeration never enumerated", async () => {
    // A manifest naming a table the classifier does not cover is drift between the two
    // contracts — refuse loudly instead of classifying a shrinking scope.
    const enumeration = await enumerateCleanupManifest(database);
    const drifted = structuredClone(enumeration);
    drifted.tables.push({
      table: "not_a_legacy_table",
      schema: "public",
      exists: true,
      rowCount: 1,
      idRange: { min: "x", max: "x" },
      attribution: {
        personal: 0,
        company: 0,
        legacyDeployment: 0,
        unknownOwner: 0,
        unmapped: 1,
      },
      attributionBasis: "fabricated",
    });
    await expect(
      classifyCleanup(database, evidenceInput, { enumeration: drifted }),
    ).rejects.toThrow();
  });
});
