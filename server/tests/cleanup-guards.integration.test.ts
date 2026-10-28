import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  type ClassifiedRecord,
  type CleanupClassification,
  classifyCleanup,
} from "../src/billing/cleanup-classification";
import {
  assertCleanupDeletionAllowed,
  type DeletionRefusal,
  type GuardedDeleteTarget,
  guardCleanupDeletion,
} from "../src/billing/cleanup-guards";
import { evaluateCleanupRelations } from "../src/billing/cleanup-relations";
import { createCreditWriter } from "../src/billing/credits-writer";
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
 * The cleanup deletion guards (ticket b5-349, group 21.5) against a real PostgreSQL, gated on
 * TEST_DATABASE_URL like the rest of the integration suite. This is the safety gate between
 * 21.4's reviewed dry-run and any future execution (21.6/21.7): the constraints live in the
 * program, not in operator care (resume hint) —
 *
 * - In-flight responsibility never enters the cleanup scope: a still-reserved hold and — the
 *   06.8 semantics this ticket folds into the scope producers — an UNKNOWN hold (a provider
 *   call whose result never arrived; the clock is not release evidence) and their allocations
 *   are quarantined, and every row whose deletion would cascade into them (the customer row,
 *   the grant an allocation rides) is pulled, at classification time, at relations time AND
 *   again by the guard's own fresh probe that trusts no manifest.
 * - The hard no-delete wall: only the twelve legacy billing tables may ever be named. Users,
 *   bots, sessions, knowledge-base objects and every other application table are refused
 *   before any row is probed; company billing history (ADR 0004) is refused by class however
 *   loud its test markers.
 * - unknown_owner records stay isolated: the guard refuses them by class, and the default
 *   deletion scope cannot contain one.
 *
 * Fixture: four keys. A company key carrying the loudest test markers there are (its order id
 * is in the registry AND its creator is the registered test user) — kept. A fully evidenced
 * legacy key with a SETTLED hold (safe), a RESERVED hold (in-flight) and an UNKNOWN hold
 * (in-flight per 06.8). A second evidenced legacy key whose ONLY in-flight object is an
 * unknown hold — the sharpest probe of the 06.8 widening, because everything else about the
 * key looks cleanable. An explicitly quarantined unknown_owner key. The fixtures are deleted
 * children-first in afterAll; no scenario mutates another's rows.
 *
 * Runner note: this suite registers with `bun:test`, like the workspace's newest DB
 * integration suite (settle-idempotency), because the dedicated verify database is driven by
 * `bun test` (TEST_DATABASE_URL); the server's db client imports the `bun` package, which the
 * e2e (Node) runner cannot resolve, so `bun test` is the only runner that can execute it.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const run = `b349-${randomUUID().slice(0, 8)}`;

const companyKey = `b349-co-${run}`;
const companyPayerId = `b349-tenant-${run}`;
const legacyKey = `b349-leg-${run}`;
const legacyDeploymentId = `b349-deploy-${run}`;
const flightKey = `b349-flight-${run}`;
const flightDeploymentId = `b349-deploy-flight-${run}`;
const unknownKey = `b349-unk-${run}`;
const fixtureKeys = [companyKey, legacyKey, flightKey, unknownKey];

const testUser = `b349-test-user-${run}`;
const companyOrderId = `b349-po-company-${run}`;
const legacyPaidOrderId = `b349-po-leg-${run}`;
const flightPaidOrderId = `b349-po-flight-${run}`;
const legacySubscriptionId = `b349-sub-${run}`;
const webhookHitId = `b349-we-hit-${run}`;
const webhookMissId = `b349-we-miss-${run}`;
const legacyOutboxId = `b349-uo-leg-${run}`;
const flightOutboxId = `b349-uo-flight-${run}`;

const companyMappingId = `b349-pa-co-${run}`;
const legacyMappingId = `b349-pa-leg-${run}`;
const flightMappingId = `b349-pa-flight-${run}`;
const unknownMappingId = `b349-pa-unk-${run}`;

/** The operator-vouched test-evidence registries: both company markers are deliberate. */
const evidenceInput = {
  testOrderIds: [companyOrderId, legacyPaidOrderId, flightPaidOrderId],
  testUserIds: [testUser],
};

/** Fresh manifests for assertions that inspect the scope producers directly. */
async function freshClassification(): Promise<CleanupClassification> {
  return classifyCleanup(database, evidenceInput);
}

function recordsOf(
  classification: CleanupClassification,
  key: string,
  table: string,
): ClassifiedRecord[] {
  return classification.records.filter(
    (record) => record.externalCustomerId === key && record.table === table,
  );
}

function refusalOf(
  refused: DeletionRefusal[],
  target: GuardedDeleteTarget,
): DeletionRefusal {
  const hit = refused.find(
    (entry) =>
      entry.table === target.table && entry.recordId === target.recordId,
  );
  if (!hit) {
    throw new Error(
      `expected a refusal for ${target.table}/${target.recordId}, got none`,
    );
  }
  return hit;
}

/** The reservation/allocation ids the writer created for one hold, by idempotency key. */
async function holdIds(idempotencyKey: string): Promise<{
  reservationId: string;
  allocationId: string;
}> {
  const [reservation] = await database
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(eq(creditReservations.idempotencyKey, idempotencyKey))
    .limit(1);
  if (!reservation) throw new Error(`fixture hold ${idempotencyKey} missing`);
  const [allocation] = await database
    .select({ id: creditReservationAllocations.id })
    .from(creditReservationAllocations)
    .where(eq(creditReservationAllocations.reservationId, reservation.id))
    .limit(1);
  if (!allocation)
    throw new Error(`fixture hold ${idempotencyKey} has no allocation`);
  return { reservationId: reservation.id, allocationId: allocation.id };
}

// The hold and grant ids are resolved once during the seeding test; later tests read them.
// (Grant ids are random `cg-<hex>`; the idempotency key is the stable handle.)
let settledHold: { reservationId: string; allocationId: string };
let reservedHold: { reservationId: string; allocationId: string };
let unknownHold: { reservationId: string; allocationId: string };
let flightUnknownHold: { reservationId: string; allocationId: string };
let companyGrantId: string;
let unknownGrantId: string;
let flightPlanGrantId: string;

/** The id of the grant one idempotency key names. */
async function grantIdOf(idempotencyKey: string): Promise<string> {
  const [grant] = await database
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(eq(creditGrants.idempotencyKey, idempotencyKey))
    .limit(1);
  if (!grant) throw new Error(`fixture grant ${idempotencyKey} missing`);
  return grant.id;
}

afterAll(async () => {
  // Children first: payment rows and outbox/webhook rows have no customer FK to cascade for.
  await database
    .delete(paymentEvents)
    .where(
      inArray(paymentEvents.orderId, [
        companyOrderId,
        legacyPaidOrderId,
        flightPaidOrderId,
      ]),
    );
  await database
    .delete(paymentOrders)
    .where(
      inArray(paymentOrders.id, [
        companyOrderId,
        legacyPaidOrderId,
        flightPaidOrderId,
      ]),
    );
  await database
    .delete(usageOutbox)
    .where(inArray(usageOutbox.externalCustomerId, [legacyKey, flightKey]));
  await database
    .delete(billingWebhookEvents)
    .where(
      inArray(billingWebhookEvents.eventId, [webhookHitId, webhookMissId]),
    );
  // billing_customers cascades to payer_accounts, subscriptions, grants, ledger,
  // reservations (and their allocations) and remainders.
  await database
    .delete(billingCustomers)
    .where(inArray(billingCustomers.externalId, fixtureKeys));
  await database.$client.close();
});

async function seedFixture(): Promise<void> {
  for (const key of fixtureKeys) {
    await database
      .insert(billingCustomers)
      .values({ externalId: key, name: `b5-349 fixture ${key}` });
  }
  await database.insert(payerAccounts).values([
    {
      id: companyMappingId,
      kind: "company",
      payerId: companyPayerId,
      externalCustomerId: companyKey,
    },
    {
      id: legacyMappingId,
      kind: "legacy_deployment",
      payerId: legacyDeploymentId,
      externalCustomerId: legacyKey,
    },
    {
      id: flightMappingId,
      kind: "legacy_deployment",
      payerId: flightDeploymentId,
      externalCustomerId: flightKey,
    },
    {
      id: unknownMappingId,
      kind: "unknown_owner",
      payerId: unknownKey,
      externalCustomerId: unknownKey,
    },
  ]);

  // Company: grant + one pending order carrying BOTH test markers (registered order id and
  // registered creator) — company history must stay undeletable under the loudest markers.
  await writer.grantCredits({
    externalCustomerId: companyKey,
    source: "promo",
    totalCents: 20_000,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    reason: `b5-349 fixture ${run}`,
    idempotencyKey: `b349-co-grant-${run}`,
  });
  await database.insert(paymentOrders).values({
    id: companyOrderId,
    planCode: "plan-pro",
    provider: "alipay",
    amountCents: 1000,
    status: "pending",
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    createdBy: testUser,
    ownerPayerKind: "company",
    ownerPayerId: companyPayerId,
  });
  await database.insert(paymentEvents).values({
    id: `b349-pe-company-${run}`,
    orderId: companyOrderId,
    kind: "fact",
    code: "created",
    state: "pending",
    channelTransactionId: `b349-ch-company-${run}`,
    amountCents: 1000,
    detail: "",
  });

  // The fully evidenced legacy key: the full old stack.
  await database.insert(billingSubscriptions).values({
    externalCustomerId: legacyKey,
    externalSubscriptionId: legacySubscriptionId,
    planCode: "plan-pro",
    status: "canceled",
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
      objectId: `b349-lago-nope-${run}`,
    },
  ]);
  await writer.grantCredits({
    externalCustomerId: legacyKey,
    source: "promo",
    totalCents: 5_000,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    reason: `b5-349 fixture ${run}`,
    idempotencyKey: `b349-leg-promo-${run}`,
  });
  await database.insert(paymentOrders).values({
    id: legacyPaidOrderId,
    planCode: "plan-pro",
    provider: "alipay",
    amountCents: 1000,
    status: "paid",
    activationState: "applied",
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    paidAt: new Date(),
    terminalAt: new Date(),
    createdBy: `b349-real-user-${run}`,
  });
  await database.insert(paymentEvents).values({
    id: `b349-pe-leg-${run}`,
    orderId: legacyPaidOrderId,
    kind: "fact",
    code: "paid",
    state: "paid",
    channelTransactionId: `b349-ch-leg-${run}`,
    amountCents: 1000,
    detail: "",
  });
  await writer.grantCredits({
    externalCustomerId: legacyKey,
    source: "plan",
    totalCents: 10_000,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    reason: `b5-349 fixture paid order ${legacyPaidOrderId}`,
    idempotencyKey: `plan:${legacyPaidOrderId}`,
  });
  await database.insert(usageOutbox).values({
    eventId: legacyOutboxId,
    source: "code_run",
    externalCustomerId: legacyKey,
    transactionId: `b349-tx-leg-${run}`,
    inputTokens: 10,
    outputTokens: 5,
    model: "gpt-test",
    client: "cli",
    occurredAt: new Date(),
  });

  // The three holds: settled (responsibility closed — cleanable with the key), reserved
  // (in-flight), unknown (in-flight per 06.8 — the clock is never release evidence).
  const settled = await writer.reserveCredits({
    externalCustomerId: legacyKey,
    idempotencyKey: `b349-leg-hold-settled-${run}`,
    maximumCents: 800,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
  });
  if (!settled.reserved) throw new Error("fixture settled hold was refused");
  await writer.settleReservation({
    reservationId: settled.reservationId,
    actual: { numerator: 250n, denominator: 1n },
    title: "b5-349 fixture legacy settled call",
  });
  const reserved = await writer.reserveCredits({
    externalCustomerId: legacyKey,
    idempotencyKey: `b349-leg-hold-reserved-${run}`,
    maximumCents: 300,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
  });
  if (!reserved.reserved) throw new Error("fixture reserved hold was refused");
  const unknown = await writer.reserveCredits({
    externalCustomerId: legacyKey,
    idempotencyKey: `b349-leg-hold-unknown-${run}`,
    maximumCents: 200,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
  });
  if (!unknown.reserved) throw new Error("fixture unknown hold was refused");
  await writer.markReservationUnknown(
    unknown.reservationId,
    "b5-349 fixture: provider result never arrived",
  );

  // The flight key: everything about it looks cleanable except its one UNKNOWN hold.
  await database.insert(paymentOrders).values({
    id: flightPaidOrderId,
    planCode: "plan-pro",
    provider: "alipay",
    amountCents: 1000,
    status: "paid",
    activationState: "applied",
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    paidAt: new Date(),
    terminalAt: new Date(),
    createdBy: `b349-real-user-${run}`,
  });
  await database.insert(paymentEvents).values({
    id: `b349-pe-flight-${run}`,
    orderId: flightPaidOrderId,
    kind: "fact",
    code: "paid",
    state: "paid",
    channelTransactionId: `b349-ch-flight-${run}`,
    amountCents: 1000,
    detail: "",
  });
  await writer.grantCredits({
    externalCustomerId: flightKey,
    source: "plan",
    totalCents: 10_000,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    reason: `b5-349 fixture paid order ${flightPaidOrderId}`,
    idempotencyKey: `plan:${flightPaidOrderId}`,
  });
  await database.insert(usageOutbox).values({
    eventId: flightOutboxId,
    source: "code_run",
    externalCustomerId: flightKey,
    transactionId: `b349-tx-flight-${run}`,
    inputTokens: 7,
    outputTokens: 3,
    model: "gpt-test",
    client: "cli",
    occurredAt: new Date(),
  });
  const flightUnknown = await writer.reserveCredits({
    externalCustomerId: flightKey,
    idempotencyKey: `b349-flight-hold-unknown-${run}`,
    maximumCents: 150,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
  });
  if (!flightUnknown.reserved)
    throw new Error("fixture flight hold was refused");
  await writer.markReservationUnknown(
    flightUnknown.reservationId,
    "b5-349 fixture: flight key unknown result",
  );

  // The quarantined unknown_owner key keeps a grant nobody may move.
  await writer.grantCredits({
    externalCustomerId: unknownKey,
    source: "signin",
    totalCents: 1_000,
    expiresAt: new Date("2027-06-01T00:00:00Z"),
    reason: `b5-349 fixture ${run}`,
    idempotencyKey: `b349-unk-grant-${run}`,
  });

  settledHold = await holdIds(`b349-leg-hold-settled-${run}`);
  reservedHold = await holdIds(`b349-leg-hold-reserved-${run}`);
  unknownHold = await holdIds(`b349-leg-hold-unknown-${run}`);
  flightUnknownHold = await holdIds(`b349-flight-hold-unknown-${run}`);
  companyGrantId = await grantIdOf(`b349-co-grant-${run}`);
  unknownGrantId = await grantIdOf(`b349-unk-grant-${run}`);
  flightPlanGrantId = await grantIdOf(`plan:${flightPaidOrderId}`);
}

describe("cleanup deletion guards (21.5) keep in-flight, company and unknown rows untouchable", () => {
  test("seeding: four keys, one carrying a reserved and an unknown hold, one only an unknown hold", async () => {
    await seedFixture();
  });

  test("the classification quarantines an unknown hold as in-flight responsibility", async () => {
    const classification = await freshClassification();

    const reservation = recordsOf(
      classification,
      flightKey,
      "credit_reservations",
    )[0];
    expect(reservation).toBeDefined();
    expect(reservation!.inFlight).toBe(true);
    expect(reservation!.class).toBe("unknown_owner");
    expect(reservation!.isolationReason).toBe("in_flight_reservation");
    expect(classification.candidates).not.toContain(reservation);

    const allocation = recordsOf(
      classification,
      flightKey,
      "credit_reservation_allocations",
    )[0];
    expect(allocation).toBeDefined();
    expect(allocation!.inFlight).toBe(true);
    expect(allocation!.class).toBe("unknown_owner");
    expect(allocation!.isolationReason).toBe("in_flight_reservation");

    // The legacy key's reserved hold: the original in-flight semantics, still holding.
    const reservedReservation = recordsOf(
      classification,
      legacyKey,
      "credit_reservations",
    ).find((record) => record.recordId === reservedHold.reservationId);
    expect(reservedReservation).toBeDefined();
    expect(reservedReservation!.inFlight).toBe(true);
    expect(reservedReservation!.class).toBe("unknown_owner");
    expect(reservedReservation!.isolationReason).toBe("in_flight_reservation");

    // And the unknown hold of the legacy key — same quarantine.
    const unknownReservation = recordsOf(
      classification,
      legacyKey,
      "credit_reservations",
    ).find((record) => record.recordId === unknownHold.reservationId);
    expect(unknownReservation).toBeDefined();
    expect(unknownReservation!.inFlight).toBe(true);
    expect(unknownReservation!.isolationReason).toBe("in_flight_reservation");
  });

  test("the relations evaluation pulls every estate row whose deletion reaches the unknown hold", async () => {
    const classification = await freshClassification();
    const relations = await evaluateCleanupRelations(database, classification);

    const pulled = new Set(
      relations.removedCandidates.map(
        (removed) => `${removed.table}/${removed.recordId}`,
      ),
    );
    // The customer row's cascade would delete the unknown reservation itself.
    expect(pulled.has(`billing_customers/${flightKey}`)).toBe(true);
    // The mapping is the kept quarantine's attribution evidence.
    expect(pulled.has(`payer_accounts/${flightMappingId}`)).toBe(true);
    // Deleting the plan grant cascades into the unknown hold's allocation.
    expect(pulled.has(`credit_grants/${flightPlanGrantId}`)).toBe(true);
    // The hold and its allocation are quarantined upstream (never candidates at all).
    expect(
      pulled.has(`credit_reservations/${flightUnknownHold.reservationId}`),
    ).toBe(false);

    const safe = new Set(
      relations.safeCandidates.map((safe) => `${safe.table}/${safe.recordId}`),
    );
    // The cleanable rest of the flight key: its paid order, event and outbox row.
    expect(safe.has(`payment_orders/${flightPaidOrderId}`)).toBe(true);
    expect(safe.has(`usage_outbox/${flightOutboxId}`)).toBe(true);
    // No safe candidate may be an in-flight reservation or allocation of one.
    expect(
      safe.has(`credit_reservations/${flightUnknownHold.reservationId}`),
    ).toBe(false);
    expect(
      safe.has(
        `credit_reservation_allocations/${flightUnknownHold.allocationId}`,
      ),
    ).toBe(false);
  });

  test("the guard's default scope is exactly the fresh safe candidates and touches nothing protected", async () => {
    const report = await guardCleanupDeletion(database, evidenceInput);

    expect(report.guardsVersion).toBe(1);
    expect(report.refused).toEqual([]);
    const classification = await freshClassification();
    const relations = await evaluateCleanupRelations(database, classification);
    expect(report.deletable).toEqual(relations.safeCandidates);

    const deletable = new Set(
      report.deletable.map((entry) => `${entry.table}/${entry.recordId}`),
    );
    // The settled hold and its allocation are cleanable.
    expect(
      deletable.has(`credit_reservations/${settledHold.reservationId}`),
    ).toBe(true);
    expect(
      deletable.has(
        `credit_reservation_allocations/${settledHold.allocationId}`,
      ),
    ).toBe(true);
    // Nothing protected appears: no company row, no unknownOwner row, no in-flight row,
    // none of the flight key's pulled estate.
    const forbidden = [
      `billing_customers/${companyKey}`,
      `payer_accounts/${companyMappingId}`,
      `credit_grants/${companyGrantId}`,
      `payment_orders/${companyOrderId}`,
      `billing_customers/${unknownKey}`,
      `payer_accounts/${unknownMappingId}`,
      `credit_grants/${unknownGrantId}`,
      `billing_customers/${flightKey}`,
      `payer_accounts/${flightMappingId}`,
      `credit_reservations/${reservedHold.reservationId}`,
      `credit_reservations/${unknownHold.reservationId}`,
      `credit_reservations/${flightUnknownHold.reservationId}`,
      `credit_reservation_allocations/${reservedHold.allocationId}`,
      `credit_reservation_allocations/${unknownHold.allocationId}`,
      `credit_reservation_allocations/${flightUnknownHold.allocationId}`,
    ];
    for (const key of forbidden) {
      expect(deletable.has(key)).toBe(false);
    }

    // The report records every in-flight row the fresh probe found, with status.
    const recorded = report.inFlight.reservations.map(
      (reservation) => reservation.reservationId,
    );
    expect(recorded).toContain(reservedHold.reservationId);
    expect(recorded).toContain(unknownHold.reservationId);
    expect(recorded).toContain(flightUnknownHold.reservationId);
    for (const reservation of report.inFlight.reservations) {
      expect(["reserved", "unknown"]).toContain(reservation.status);
    }
    const allocationIds = report.inFlight.allocations.map(
      (allocation) => allocation.allocationId,
    );
    expect(allocationIds).toContain(reservedHold.allocationId);
    expect(allocationIds).toContain(unknownHold.allocationId);
    expect(allocationIds).toContain(flightUnknownHold.allocationId);
  });

  test("the estate wall refuses every table outside the legacy billing estate before probing rows", async () => {
    const targets: GuardedDeleteTarget[] = [
      { table: "users", recordId: `b349-user-${run}` },
      { table: "bot_services", recordId: `b349-bot-${run}` },
      { table: "access_grants", recordId: `b349-grant-${run}` },
      { table: "enterprise_conversations", recordId: `b349-session-${run}` },
      { table: "kb_documents", recordId: `b349-kb-${run}` },
    ];
    const report = await guardCleanupDeletion(database, evidenceInput, {
      targets,
    });
    expect(report.deletable).toEqual([]);
    expect(report.refused.length).toBe(targets.length);
    for (const target of targets) {
      expect(refusalOf(report.refused, target).reason).toBe(
        "table_outside_cleanup_estate",
      );
    }
    const evidence = refusalOf(report.refused, targets[0]).evidence;
    expect(evidence).toContain("legacy billing estate");
  });

  test("company billing history is refused by class, however loud its test markers", async () => {
    const targets: GuardedDeleteTarget[] = [
      { table: "billing_customers", recordId: companyKey },
      { table: "payer_accounts", recordId: companyMappingId },
      { table: "credit_grants", recordId: companyGrantId },
      { table: "payment_orders", recordId: companyOrderId },
    ];
    const report = await guardCleanupDeletion(database, evidenceInput, {
      targets,
    });
    expect(report.deletable).toEqual([]);
    for (const target of targets) {
      const refusal = refusalOf(report.refused, target);
      expect(refusal.reason).toBe("company_billing_history");
      expect(refusal.evidence).toContain("company_history");
    }
  });

  test("unknown_owner records stay isolated and are refused on direct targeting", async () => {
    const targets: GuardedDeleteTarget[] = [
      { table: "payer_accounts", recordId: unknownMappingId },
      { table: "credit_grants", recordId: unknownGrantId },
      { table: "billing_customers", recordId: unknownKey },
    ];
    const report = await guardCleanupDeletion(database, evidenceInput, {
      targets,
    });
    expect(report.deletable).toEqual([]);
    for (const target of targets) {
      const refusal = refusalOf(report.refused, target);
      expect(refusal.reason).toBe("unknown_owner_isolated");
      expect(refusal.evidence).toContain("unknown_owner");
    }
  });

  test("the fresh in-flight probe refuses holds, their allocations and the rows whose deletion reaches them, trusting no manifest", async () => {
    const targets: GuardedDeleteTarget[] = [
      { table: "credit_reservations", recordId: reservedHold.reservationId },
      { table: "credit_reservations", recordId: unknownHold.reservationId },
      {
        table: "credit_reservations",
        recordId: flightUnknownHold.reservationId,
      },
      {
        table: "credit_reservation_allocations",
        recordId: reservedHold.allocationId,
      },
      {
        table: "credit_reservation_allocations",
        recordId: unknownHold.allocationId,
      },
      {
        table: "credit_reservation_allocations",
        recordId: flightUnknownHold.allocationId,
      },
    ];
    const report = await guardCleanupDeletion(database, evidenceInput, {
      targets,
    });
    expect(report.deletable).toEqual([]);
    for (const target of targets) {
      const refusal = refusalOf(report.refused, target);
      expect(refusal.reason).toBe("in_flight_responsibility");
    }
    // The refusal evidence names the in-flight reservation it protects.
    const direct = refusalOf(report.refused, {
      table: "credit_reservations",
      recordId: flightUnknownHold.reservationId,
    });
    expect(direct.evidence).toContain(flightUnknownHold.reservationId);
    expect(direct.evidence).toContain("unknown");

    // Transitive reach: deleting the customer or the plan grant would cascade into the
    // unknown hold's reservation or allocation — refused by the fresh probe even though a
    // stale manifest might still call them safe.
    const transitives: GuardedDeleteTarget[] = [
      { table: "billing_customers", recordId: flightKey },
      { table: "credit_grants", recordId: flightPlanGrantId },
    ];
    const transitReport = await guardCleanupDeletion(database, evidenceInput, {
      targets: transitives,
    });
    for (const target of transitives) {
      const refusal = refusalOf(transitReport.refused, target);
      expect(refusal.reason).toBe("in_flight_responsibility");
      expect(refusal.evidence).toContain(flightUnknownHold.reservationId);
    }

    // Contrast: the settled hold's ledger row carries no in-flight duty. It stays deletable
    // by class and scope — the fresh probe refuses only live responsibility.
    const settledReport = await guardCleanupDeletion(database, evidenceInput, {
      targets: [
        { table: "credit_reservations", recordId: settledHold.reservationId },
        {
          table: "credit_reservation_allocations",
          recordId: settledHold.allocationId,
        },
      ],
    });
    expect(settledReport.refused).toEqual([]);
    expect(settledReport.deletable.length).toBe(2);
  });

  test("a record the classification never named is refused as never-a-candidate", async () => {
    const target: GuardedDeleteTarget = {
      table: "billing_customers",
      recordId: `b349-ghost-${run}`,
    };
    const report = await guardCleanupDeletion(database, evidenceInput, {
      targets: [target],
    });
    expect(report.deletable).toEqual([]);
    expect(refusalOf(report.refused, target).reason).toBe(
      "not_a_classification_candidate",
    );
  });

  test("assertCleanupDeletionAllowed throws a reason-naming error on refusals and passes a clean report", async () => {
    const clean = await guardCleanupDeletion(database, evidenceInput, {
      targets: [
        { table: "credit_reservations", recordId: settledHold.reservationId },
      ],
    });
    expect(() => assertCleanupDeletionAllowed(clean)).not.toThrow();

    const refused = await guardCleanupDeletion(database, evidenceInput, {
      targets: [
        { table: "users", recordId: `b349-user-${run}` },
        { table: "billing_customers", recordId: companyKey },
        { table: "credit_reservations", recordId: unknownHold.reservationId },
      ],
    });
    let thrown: unknown;
    try {
      assertCleanupDeletionAllowed(refused);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("table_outside_cleanup_estate");
    expect(message).toContain("company_billing_history");
    expect(message).toContain("in_flight_responsibility");
    expect(message).toContain(companyKey);
  });

  test("the guard is read-only and deterministic: two runs agree modulo generatedAt and the data does not move", async () => {
    const legacyTables = {
      billing_customers: billingCustomers,
      payer_accounts: payerAccounts,
      billing_subscriptions: billingSubscriptions,
      billing_webhook_events: billingWebhookEvents,
      credit_grants: creditGrants,
      credit_ledger: creditLedger,
      credit_reservations: creditReservations,
      credit_reservation_allocations: creditReservationAllocations,
      credit_charge_remainders: creditChargeRemainders,
      payment_orders: paymentOrders,
      payment_events: paymentEvents,
      usage_outbox: usageOutbox,
    } as const;

    const countAll = async () => {
      const counts: Record<string, number> = {};
      for (const [table, schema] of Object.entries(legacyTables)) {
        counts[table] = (await database.select().from(schema)).length;
      }
      return counts;
    };

    const before = await countAll();
    const first = await guardCleanupDeletion(database, evidenceInput);
    const second = await guardCleanupDeletion(database, evidenceInput);
    const after = await countAll();

    expect(after).toEqual(before);
    const strip = (report: typeof first) => {
      const { generatedAt: _ignored, ...rest } = report;
      return rest;
    };
    expect(strip(second)).toEqual(strip(first));
  });
});
