import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
  payerAccounts,
} from "../db/schema/billing";
import {
  creditChargeRemainders,
  creditReservationAllocations,
  creditReservations,
} from "../db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../db/schema/credits";
import { paymentEvents, paymentOrders } from "../db/schema/payment";
import { usageOutbox } from "../db/schema/usage-outbox";
import type { CleanupManifest } from "./cleanup-manifest";

/*
 * The legacy billing classification (group 21.2) on top of 21.1's enumeration. Where the
 * enumeration answers "what is there and whose is it", this module answers the question the
 * enumeration deliberately left open: for every legacy billing record, which of the four
 * verdicts applies —
 *
 * - `company_history`  kept in full (ADR 0004). NEVER a cleanup candidate, even when its rows
 *                      also match the test-evidence registries: rule R1 outranks every marker.
 * - `personal_records` kept (migration is a later, separate decision). Never a candidate.
 * - `confirmed_obsolete_test` the ONLY cleanup-candidate class. Requires all three of:
 *                      a `legacy_deployment` mapping (02.2's explicit attribution), explicit
 *                      test evidence for the key, and no in-flight responsibility on the record
 *                      (a reserved or unknown-result hold — 06.8 — or an allocation of one).
 * - `unknown_owner`    isolated keep. Every record the rules cannot prove cleanable: no mapping
 *                      or 02.2's quarantine, a legacy key without test evidence, or in-flight
 *                      responsibility (a reserved or unknown hold and its allocations — Q29:
 *                      open settlement responsibility is never cleanable, whatever its key).
 *
 * The evidence discipline is the ticket's, made mechanical:
 *
 * - "Looks like test data" is not evidence. Test data features exist only as matches against
 *   the operator-vouched registries this module is handed (`testOrderIds`, `testUserIds`) —
 *   explicit id lists from prior evidence gathering, matched EXACTLY against
 *   `payment_orders.id` and `payment_orders.created_by`. No prefix, shape or substring
 *   reasoning anywhere.
 * - Attribution comes only from 02.2's `payer_accounts` mapping and the data linkages the
 *   schema documents (the same ones the 21.1 enumeration recorded): a keyed table's own
 *   `external_customer_id`, a webhook's `object_id` through its subscription, an order's
 *   10.1 owner pair or its `plan:<orderId>` payout grant, an event through its parent order,
 *   an allocation through its reservation. A record that resolves through none is unknown.
 * - The rules, the registries (normalized, with a content hash) and every record's evidence
 *   ride in the returned manifest. Persisting it is the operator's act of saving the JSON;
 *   the classification itself writes nothing — it runs inside the same READ ONLY, REPEATABLE
 *   READ transaction fence the enumeration uses, so the evidence cannot drift from the data
 *   it describes and an accidental write is a runtime error, not a silent mutation.
 * - The verdict is a function of (data, rules, registries) and nothing else — no executor
 *   knob can reclassify a single record. `reclassifyFromManifest` re-derives the whole
 *   verdict from a persisted manifest and reports any difference: the reviewable proof that
 *   an adjustment means changing the inputs and regenerating, never hand-editing.
 * - The manifest's table set is a recorded decision, not an omission — written down as the
 *   review's carried note requires: `model_usage` is deliberately NOT classified here. It is
 *   deployment telemetry — which model served each Bot run, for the usage view and the
 *   allowlist (`schema/admin.ts`) — and a financial record of nobody: no payer key, no
 *   price, no credit. Q28 scopes this cleanup to the legacy billing estate only, so the four
 *   billing verdicts have nothing to decide about it. The usage table that IS classified is
 *   its billing-side counterpart `usage_outbox`, keyed by `external_customer_id` like every
 *   other row here.
 * - The count boundary (the review's other carried note): this module never casts
 *   `count(*)::int`. Every row is read whole and the per-class counts accumulate in JS, so
 *   this ticket's output has no 2^31-1 overflow path. 21.1's enumeration keeps its own
 *   `::int` ceiling (that file is outside this ticket's write scope, untouched on purpose);
 *   re-examining that margin at larger scale is 21.4's dry-run business.
 */

/** The four verdicts, as the ticket names them. */
export type CleanupRecordClass =
  | "company_history"
  | "personal_records"
  | "confirmed_obsolete_test"
  | "unknown_owner";

/**
 * The operator-vouched test-evidence registries: the ONLY test-data evidence there is. Both
 * are exact-id lists from prior evidence gathering (a test order's own id; a test user's own
 * id as it appears in `payment_orders.created_by`) — never patterns.
 */
export type TestEvidenceInput = {
  testOrderIds: string[];
  testUserIds: string[];
};

/** One persisted rule statement: the id a reviewer cites, the scope it claims. */
export type ClassificationRule = { id: string; description: string };

/** The fixed rule set, persisted into every manifest so verdicts cite what decided them. */
export const CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    id: "R1-company-history-kept",
    description:
      "A record whose external customer key maps to a payer_accounts row of kind=company is company_history: company billing history is kept in full (ADR 0004) and is never a cleanup candidate, even when its rows also match the test-evidence registries.",
  },
  {
    id: "R2-personal-records-kept",
    description:
      "A record whose external customer key maps to a payer_accounts row of kind=personal is personal_records: kept (migration is a later, separate decision) and never a cleanup candidate.",
  },
  {
    id: "R3-confirmed-obsolete-test",
    description:
      "A record whose key maps to kind=legacy_deployment, whose key carries explicit test evidence — an exact test_order_number or test_user_marker match from the recorded registries, never a name-shape guess — and that carries no in-flight responsibility is confirmed_obsolete_test: the only cleanup-candidate class.",
  },
  {
    id: "R4-unknown-owner-isolated",
    description:
      "Everything else is unknown_owner and stays isolated: no payer mapping or the explicit unknown_owner quarantine (unknown_attribution), a legacy_deployment key without test evidence (insufficient_test_evidence), or in-flight responsibility — a still-reserved reservation, an unknown-result hold (06.8: the clock is never release evidence) or an allocation of either — of an otherwise evidenced legacy key (in_flight_reservation).",
  },
];

/** One classified billing record, with the evidence that decided it. */
export type ClassifiedRecord = {
  /** The legacy billing table the record lives in. */
  table: string;
  /** The record's own object id in that table. */
  recordId: string;
  /** The external customer key the record's attribution resolved through; null when none. */
  externalCustomerId: string | null;
  /** The exact linkage (mapping row or join path) the attribution rode in on. */
  attributionSource: string;
  /** The verdict. */
  class: CleanupRecordClass;
  /** Matched test-evidence markers for the record's key, e.g. `test_order_number:<id>`. */
  testFeatures: string[];
  /** True when the record is open settlement responsibility (a reserved hold or its allocation). */
  inFlight: boolean;
  /** The record's own timestamp, as evidence of the class's time range; null when it has none. */
  observedAt: string | null;
  /** Why the record is quarantined; non-null exactly when class is unknown_owner. */
  isolationReason:
    | "unknown_attribution"
    | "insufficient_test_evidence"
    | "in_flight_reservation"
    | null;
};

/** The classification manifest 21.3 (FK mapping) and 21.4 (dry-run hash) consume. */
export type CleanupClassification = {
  classificationVersion: 1;
  /** `current_database()` — the database the evidence was read from. */
  database: string;
  /** The schema the classified tables were found in, from the catalog. */
  schema: string;
  generatedAt: string;
  /** The persisted rule set; every verdict cites one of these. */
  rules: ClassificationRule[];
  /** The registries actually used, normalized, with a content hash for independent review. */
  evidenceInput: {
    testOrderIds: string[];
    testUserIds: string[];
    sha256: string;
  };
  /** Every legacy billing record, classified, in a deterministic order. */
  records: ClassifiedRecord[];
  /** Per-verdict counts and time ranges — the class-level evidence summary. */
  summary: Record<
    CleanupRecordClass,
    { count: number; timeRange: { min: string | null; max: string | null } }
  >;
  /** Exactly the confirmed_obsolete_test records: the candidate-cleanup set. */
  candidates: ClassifiedRecord[];
  /** Exactly the unknown_owner records: the isolated-keep set. */
  unknownOwners: ClassifiedRecord[];
};

/** The verdict of `reclassifyFromManifest`: does a persisted manifest survive re-derivation. */
export type ReclassificationVerdict = {
  /** True when re-deriving the classification reproduces the manifest exactly. */
  matches: boolean;
  /** What differs, in reviewable terms; empty when matches. */
  differences: string[];
};

/**
 * The reservation statuses that carry open settlement responsibility: a plain hold
 * (`reserved`) and — 06.8 — an `unknown` hold whose provider result never arrived, whose
 * clock passage is NOT release evidence. `settled`/`released` are terminal. Every in-flight
 * check in the cleanup group (classification verdicts here, live protection in the
 * relations evaluation, the 21.5 deletion guard's fresh probe) reads this one list, so the
 * three cannot drift apart.
 */
export const IN_FLIGHT_RESERVATION_STATUSES = ["reserved", "unknown"] as const;

/** Whether a reservation status carries open settlement responsibility (never cleanable). */
export function isReservationInFlight(status: string): boolean {
  return (IN_FLIGHT_RESERVATION_STATUSES as readonly string[]).includes(status);
}

/** The legacy tables the classification queries, in its fixed (enumeration-aligned) order. */
const TABLE_ORDER = [
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

/**
 * The legacy billing estate (21.5): the only tables the cleanup program may ever name for
 * deletion. Everything else — users, bots, sessions, every other
 * application table — is outside the program's reach by construction (the 21.5 estate wall
 * reads this list; it is the classification's own table universe under its guard name, so
 * the two cannot drift apart).
 */
export const CLEANUP_ESTATE_TABLES: readonly string[] = TABLE_ORDER;

/**
 * Normalize one registry: exact non-empty ids only (a padded id would silently never match),
 * deduplicated and sorted so the persisted form is canonical.
 */
function normalizeRegistry(ids: readonly unknown[], name: string): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || id.trim() !== id) {
      throw new TypeError(
        `${name} entries must be non-empty exact ids with no surrounding whitespace: a padded registry entry would silently never match.`,
      );
    }
    out.add(id);
  }
  return [...out].sort();
}

/** The canonical hashed form of the evidence input, as the manifest records it. */
function evidenceFingerprint(input: {
  testOrderIds: string[];
  testUserIds: string[];
}) {
  return JSON.stringify({
    testOrderIds: input.testOrderIds,
    testUserIds: input.testUserIds,
  });
}

/** A record before the rules see it: what the queries established, nothing more. */
type RawRecord = {
  table: string;
  recordId: string;
  key: string | null;
  attributionSource: string;
  inFlight: boolean;
  observedAt: Date | null;
};

/** How one payment order's attribution resolved, per the documented linkages. */
type OrderResolution = { key: string | null; source: string };

/** The payer-mapping evidence one keyed row carries. */
function keyedSource(
  key: string,
  mapping:
    | { id: string; kind: string; payerId: string; externalCustomerId: string }
    | undefined,
): string {
  return mapping
    ? `payer_accounts row ${mapping.id} (kind=${mapping.kind}, payer=${mapping.payerId}) maps the row's external_customer_id`
    : `unmapped: no payer_accounts row for external_customer_id ${key}`;
}

/**
 * Classify every legacy billing record into the four verdicts, with per-record evidence.
 * Read-only by construction: one READ ONLY, REPEATABLE READ transaction, like the enumeration.
 *
 * `options.enumeration` — when the caller hands in the 21.1 manifest, the classification
 * refuses to run against a drifted table set: the two contracts must cover the same legacy
 * tables, or one of them is silently shrinking the cleanup scope.
 */
export async function classifyCleanup(
  database: Database,
  evidence: TestEvidenceInput,
  options: { enumeration?: CleanupManifest } = {},
): Promise<CleanupClassification> {
  const testOrderIds = normalizeRegistry(evidence.testOrderIds, "testOrderIds");
  const testUserIds = normalizeRegistry(evidence.testUserIds, "testUserIds");

  if (options.enumeration) {
    const enumerated = new Set(
      options.enumeration.tables.map((table) => table.table),
    );
    const covered = new Set<string>(TABLE_ORDER);
    const drifted = [...enumerated].filter((table) => !covered.has(table));
    const missing = [...covered].filter((table) => !enumerated.has(table));
    if (drifted.length > 0 || missing.length > 0) {
      throw new Error(
        `classification and enumeration disagree on the legacy table set: enumeration-only [${drifted.join(", ")}], classification-only [${missing.join(", ")}] — reconcile the two contracts before classifying.`,
      );
    }
  }

  return database.transaction(async (tx) => {
    // The read-only fence: the database refuses every write in this transaction, so the
    // classification cannot mutate the data its evidence describes. REPEATABLE READ pins
    // every read to one snapshot, so records, mappings and orders answer one moment.
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );

    const identity = await tx.execute<{ database: string; schema: string }>(
      sql`SELECT current_database() AS database, current_schema() AS schema`,
    );

    // 02.2's explicit mapping, both directions: key → mapping row, subject → key.
    const mappings = await tx
      .select({
        id: payerAccounts.id,
        kind: payerAccounts.kind,
        payerId: payerAccounts.payerId,
        externalCustomerId: payerAccounts.externalCustomerId,
        createdAt: payerAccounts.createdAt,
      })
      .from(payerAccounts);
    const mappingByKey = new Map(mappings.map((m) => [m.externalCustomerId, m]));
    const keyBySubject = new Map(
      mappings.map((m) => [`${m.kind}|${m.payerId}`, m.externalCustomerId]),
    );

    // The payout-grant linkage: `plan:<orderId>` idempotency keys (see credits.ts) name the
    // order a grant was paid out for — the documented path for orders with no owner pair.
    const planGrants = await tx
      .select({
        idempotencyKey: creditGrants.idempotencyKey,
        externalCustomerId: creditGrants.externalCustomerId,
      })
      .from(creditGrants)
      .where(sql`${creditGrants.idempotencyKey} LIKE 'plan:%'`);
    const keyByPlanOrder = new Map(
      planGrants.map((grant) => [
        grant.idempotencyKey.slice("plan:".length),
        grant.externalCustomerId,
      ]),
    );

    // Every order's attribution resolution, per the documented linkages: the 10.1 owner pair
    // when it stands, else the payout grant, else unknown.
    const orders = await tx
      .select({
        id: paymentOrders.id,
        createdBy: paymentOrders.createdBy,
        ownerPayerKind: paymentOrders.ownerPayerKind,
        ownerPayerId: paymentOrders.ownerPayerId,
        createdAt: paymentOrders.createdAt,
      })
      .from(paymentOrders);
    const orderResolutionById = new Map<string, OrderResolution>();
    for (const order of orders) {
      let resolution: OrderResolution;
      if (order.ownerPayerKind && order.ownerPayerId) {
        const subjectKey = keyBySubject.get(
          `${order.ownerPayerKind}|${order.ownerPayerId}`,
        );
        resolution = subjectKey
          ? {
              key: subjectKey,
              source: `payment_orders owner pair (kind=${order.ownerPayerKind}, payer=${order.ownerPayerId}) → payer_accounts row → external_customer_id ${subjectKey}`,
            }
          : {
              key: null,
              source: `unmapped: payment_orders owner pair (kind=${order.ownerPayerKind}, payer=${order.ownerPayerId}) matches no payer_accounts row`,
            };
      } else {
        const grantKey = keyByPlanOrder.get(order.id);
        resolution = grantKey
          ? {
              key: grantKey,
              source: `payout grant idempotency_key plan:${order.id} → credit_grants.external_customer_id ${grantKey}`,
            }
          : {
              key: null,
              source: `unmapped: no owner pair and no payout grant plan:${order.id}`,
            };
      }
      orderResolutionById.set(order.id, resolution);
    }

    // Key-level test evidence: the exact registry matches, and nothing else. An order
    // contributes its markers only to the key its own attribution resolved to.
    const testOrderSet = new Set(testOrderIds);
    const testUserSet = new Set(testUserIds);
    const featuresByKey = new Map<string, string[]>();
    const addFeature = (key: string, feature: string) => {
      const features = featuresByKey.get(key);
      if (features && !features.includes(feature)) {
        features.push(feature);
        features.sort();
      } else if (!features) {
        featuresByKey.set(key, [feature]);
      }
    };
    for (const order of orders) {
      const resolution = orderResolutionById.get(order.id);
      if (!resolution?.key) continue;
      if (testOrderSet.has(order.id)) {
        addFeature(resolution.key, `test_order_number:${order.id}`);
      }
      if (order.createdBy && testUserSet.has(order.createdBy)) {
        addFeature(resolution.key, `test_user_marker:${order.createdBy}`);
      }
    }

    /** The features a record inherits from its key (its own, reviewed, registry matches). */
    const featuresOf = (key: string | null): string[] =>
      key ? (featuresByKey.get(key) ?? []) : [];

    const rawRecords: RawRecord[] = [];

    // billing_customers: keyed by their own external_id — the cascade roots.
    const customers = await tx
      .select({
        externalId: billingCustomers.externalId,
        lastSyncedAt: billingCustomers.lastSyncedAt,
      })
      .from(billingCustomers);
    for (const customer of customers) {
      rawRecords.push({
        table: "billing_customers",
        recordId: customer.externalId,
        key: customer.externalId,
        attributionSource: keyedSource(
          customer.externalId,
          mappingByKey.get(customer.externalId),
        ),
        inFlight: false,
        observedAt: customer.lastSyncedAt,
      });
    }

    // payer_accounts: the mapping rows themselves, by their own declared kind.
    for (const mapping of mappings) {
      rawRecords.push({
        table: "payer_accounts",
        recordId: mapping.id,
        key: mapping.externalCustomerId,
        attributionSource: `this payer_accounts row declares kind=${mapping.kind} for payer=${mapping.payerId}`,
        inFlight: false,
        observedAt: mapping.createdAt,
      });
    }

    // billing_subscriptions: their own customer key.
    const subscriptions = await tx
      .select({
        externalSubscriptionId: billingSubscriptions.externalSubscriptionId,
        externalCustomerId: billingSubscriptions.externalCustomerId,
        updatedAt: billingSubscriptions.updatedAt,
      })
      .from(billingSubscriptions);
    for (const subscription of subscriptions) {
      rawRecords.push({
        table: "billing_subscriptions",
        recordId: subscription.externalSubscriptionId,
        key: subscription.externalCustomerId,
        attributionSource: keyedSource(
          subscription.externalCustomerId,
          mappingByKey.get(subscription.externalCustomerId),
        ),
        inFlight: false,
        observedAt: subscription.updatedAt,
      });
    }

    // billing_webhook_events: through the subscription their object_id names — or unknown.
    const webhooks = await tx
      .select({
        eventId: billingWebhookEvents.eventId,
        objectId: billingWebhookEvents.objectId,
        receivedAt: billingWebhookEvents.receivedAt,
        customerKey: billingSubscriptions.externalCustomerId,
      })
      .from(billingWebhookEvents)
      .leftJoin(
        billingSubscriptions,
        eq(
          billingSubscriptions.externalSubscriptionId,
          billingWebhookEvents.objectId,
        ),
      );
    for (const webhook of webhooks) {
      rawRecords.push({
        table: "billing_webhook_events",
        recordId: webhook.eventId,
        key: webhook.customerKey,
        attributionSource: webhook.customerKey
          ? `object_id ${webhook.objectId} resolves through billing_subscriptions to external_customer_id ${webhook.customerKey}`
          : `unmapped: object_id ${webhook.objectId} matches no billing_subscriptions row`,
        inFlight: false,
        observedAt: webhook.receivedAt,
      });
    }

    // credit_grants / credit_ledger: their own customer key.
    const grants = await tx
      .select({
        id: creditGrants.id,
        externalCustomerId: creditGrants.externalCustomerId,
        grantedAt: creditGrants.grantedAt,
      })
      .from(creditGrants);
    for (const grant of grants) {
      rawRecords.push({
        table: "credit_grants",
        recordId: grant.id,
        key: grant.externalCustomerId,
        attributionSource: keyedSource(
          grant.externalCustomerId,
          mappingByKey.get(grant.externalCustomerId),
        ),
        inFlight: false,
        observedAt: grant.grantedAt,
      });
    }
    const ledgerRows = await tx
      .select({
        id: creditLedger.id,
        externalCustomerId: creditLedger.externalCustomerId,
        createdAt: creditLedger.createdAt,
      })
      .from(creditLedger);
    for (const entry of ledgerRows) {
      rawRecords.push({
        table: "credit_ledger",
        recordId: entry.id,
        key: entry.externalCustomerId,
        attributionSource: keyedSource(
          entry.externalCustomerId,
          mappingByKey.get(entry.externalCustomerId),
        ),
        inFlight: false,
        observedAt: entry.createdAt,
      });
    }

    // credit_reservations: their own customer key; a reserved or unknown hold (06.8) is
    // in-flight duty — open settlement responsibility, never release evidence by the clock.
    const reservations = await tx
      .select({
        id: creditReservations.id,
        externalCustomerId: creditReservations.externalCustomerId,
        status: creditReservations.status,
        createdAt: creditReservations.createdAt,
      })
      .from(creditReservations);
    for (const reservation of reservations) {
      rawRecords.push({
        table: "credit_reservations",
        recordId: reservation.id,
        key: reservation.externalCustomerId,
        attributionSource: keyedSource(
          reservation.externalCustomerId,
          mappingByKey.get(reservation.externalCustomerId),
        ),
        inFlight: isReservationInFlight(reservation.status),
        observedAt: reservation.createdAt,
      });
    }

    // credit_reservation_allocations: through their reservation, whose status they inherit.
    const allocations = await tx
      .select({
        id: creditReservationAllocations.id,
        reservationId: creditReservations.id,
        reservationStatus: creditReservations.status,
        customerKey: creditReservations.externalCustomerId,
      })
      .from(creditReservationAllocations)
      .innerJoin(
        creditReservations,
        eq(creditReservations.id, creditReservationAllocations.reservationId),
      );
    for (const allocation of allocations) {
      rawRecords.push({
        table: "credit_reservation_allocations",
        recordId: allocation.id,
        key: allocation.customerKey,
        attributionSource: `credit_reservations ${allocation.reservationId} (status=${allocation.reservationStatus}) → its external_customer_id ${allocation.customerKey}`,
        inFlight: isReservationInFlight(allocation.reservationStatus),
        observedAt: null,
      });
    }

    // credit_charge_remainders: keyed by their own customer column.
    const remainders = await tx
      .select({
        externalCustomerId: creditChargeRemainders.externalCustomerId,
        updatedAt: creditChargeRemainders.updatedAt,
      })
      .from(creditChargeRemainders);
    for (const remainder of remainders) {
      rawRecords.push({
        table: "credit_charge_remainders",
        recordId: remainder.externalCustomerId,
        key: remainder.externalCustomerId,
        attributionSource: keyedSource(
          remainder.externalCustomerId,
          mappingByKey.get(remainder.externalCustomerId),
        ),
        inFlight: false,
        observedAt: remainder.updatedAt,
      });
    }

    // payment_orders: the resolutions worked out above.
    for (const order of orders) {
      const resolution = orderResolutionById.get(order.id);
      if (!resolution) continue;
      rawRecords.push({
        table: "payment_orders",
        recordId: order.id,
        key: resolution.key,
        attributionSource: resolution.source,
        inFlight: false,
        observedAt: order.createdAt,
      });
    }

    // payment_events: through their parent order's resolution (the FK guarantees a parent).
    const events = await tx
      .select({
        id: paymentEvents.id,
        orderId: paymentEvents.orderId,
        createdAt: paymentEvents.createdAt,
      })
      .from(paymentEvents)
      .innerJoin(paymentOrders, eq(paymentOrders.id, paymentEvents.orderId));
    for (const event of events) {
      const resolution = orderResolutionById.get(event.orderId);
      rawRecords.push({
        table: "payment_events",
        recordId: event.id,
        key: resolution?.key ?? null,
        attributionSource: resolution
          ? `payment_orders ${event.orderId} attribution: ${resolution.source}`
          : `unmapped: parent order ${event.orderId} not resolvable`,
        inFlight: false,
        observedAt: event.createdAt,
      });
    }

    // usage_outbox: their own customer key.
    const outboxRows = await tx
      .select({
        eventId: usageOutbox.eventId,
        externalCustomerId: usageOutbox.externalCustomerId,
        occurredAt: usageOutbox.occurredAt,
      })
      .from(usageOutbox);
    for (const outbox of outboxRows) {
      rawRecords.push({
        table: "usage_outbox",
        recordId: outbox.eventId,
        key: outbox.externalCustomerId,
        attributionSource: keyedSource(
          outbox.externalCustomerId,
          mappingByKey.get(outbox.externalCustomerId),
        ),
        inFlight: false,
        observedAt: outbox.occurredAt,
      });
    }

    // The rules, in fixed order: company and personal keep first, then the candidate rule,
    // then the quarantine everything the first three cannot prove.
    const records: ClassifiedRecord[] = rawRecords
      .map((raw) => {
        const mapping = raw.key ? mappingByKey.get(raw.key) : undefined;
        const kind = mapping?.kind;
        const features = featuresOf(raw.key);
        let klass: CleanupRecordClass;
        let isolationReason: ClassifiedRecord["isolationReason"] = null;
        if (kind === "company") {
          klass = "company_history";
        } else if (kind === "personal") {
          klass = "personal_records";
        } else if (
          kind === "legacy_deployment" &&
          features.length > 0 &&
          !raw.inFlight
        ) {
          klass = "confirmed_obsolete_test";
        } else {
          klass = "unknown_owner";
          isolationReason =
            !raw.key || !mapping || kind === "unknown_owner"
              ? "unknown_attribution"
              : kind === "legacy_deployment" && features.length === 0
                ? "insufficient_test_evidence"
                : "in_flight_reservation";
        }
        return {
          table: raw.table,
          recordId: raw.recordId,
          externalCustomerId: raw.key,
          attributionSource: raw.attributionSource,
          class: klass,
          testFeatures: features,
          inFlight: raw.inFlight,
          observedAt: raw.observedAt?.toISOString() ?? null,
          isolationReason,
        };
      })
      .sort(
        (a, b) =>
          TABLE_ORDER.indexOf(a.table as (typeof TABLE_ORDER)[number]) -
            TABLE_ORDER.indexOf(b.table as (typeof TABLE_ORDER)[number]) ||
          (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
      );

    // The class summary: counts and observed time ranges per verdict.
    const emptySummary = () => ({
      count: 0,
      timeRange: { min: null, max: null } as {
        min: string | null;
        max: string | null;
      },
    });
    const summary: CleanupClassification["summary"] = {
      company_history: emptySummary(),
      personal_records: emptySummary(),
      confirmed_obsolete_test: emptySummary(),
      unknown_owner: emptySummary(),
    };
    for (const record of records) {
      const bucket = summary[record.class];
      bucket.count += 1;
      if (record.observedAt) {
        bucket.timeRange.min =
          bucket.timeRange.min === null ||
          record.observedAt < bucket.timeRange.min
            ? record.observedAt
            : bucket.timeRange.min;
        bucket.timeRange.max =
          bucket.timeRange.max === null ||
          record.observedAt > bucket.timeRange.max
            ? record.observedAt
            : bucket.timeRange.max;
      }
    }

    return {
      classificationVersion: 1,
      database: identity[0].database,
      schema: identity[0].schema,
      generatedAt: new Date().toISOString(),
      rules: CLASSIFICATION_RULES,
      evidenceInput: {
        testOrderIds,
        testUserIds,
        sha256: createHash("sha256")
          .update(evidenceFingerprint({ testOrderIds, testUserIds }))
          .digest("hex"),
      },
      records,
      summary,
      candidates: records.filter(
        (record) => record.class === "confirmed_obsolete_test",
      ),
      unknownOwners: records.filter(
        (record) => record.class === "unknown_owner",
      ),
    };
  });
}

/**
 * The independent-review seam: re-derive the classification from a persisted manifest's own
 * recorded inputs and compare. An honest manifest reproduces itself exactly; a hand-edited
 * one — the executor's imagined one-record adjustment — is reported difference by difference.
 * Generated timestamps never take part: they are metadata, not verdicts.
 */
export async function reclassifyFromManifest(
  database: Database,
  manifest: CleanupClassification,
): Promise<ReclassificationVerdict> {
  const fresh = await classifyCleanup(database, {
    testOrderIds: manifest.evidenceInput.testOrderIds,
    testUserIds: manifest.evidenceInput.testUserIds,
  });
  const differences: string[] = [];
  if (JSON.stringify(fresh.rules) !== JSON.stringify(manifest.rules)) {
    differences.push("rules differ from the recorded manifest");
  }
  if (
    JSON.stringify(fresh.evidenceInput) !==
    JSON.stringify(manifest.evidenceInput)
  ) {
    differences.push("evidence input registries differ from the recorded ones");
  }
  if (JSON.stringify(fresh.records) !== JSON.stringify(manifest.records)) {
    const freshById = new Map(
      fresh.records.map((record) => [`${record.table}/${record.recordId}`, record]),
    );
    const manifestById = new Map(
      manifest.records.map((record) => [
        `${record.table}/${record.recordId}`,
        record,
      ]),
    );
    const missing = [...manifestById.keys()].filter((id) => !freshById.has(id));
    for (const id of missing) {
      differences.push(`record ${id} is in the manifest but not in the data`);
    }
    const added = [...freshById.keys()].filter((id) => !manifestById.has(id));
    for (const id of added) {
      differences.push(`record ${id} is in the data but not in the manifest`);
    }
    for (const [id, manifestRecord] of manifestById) {
      const freshRecord = freshById.get(id);
      if (
        freshRecord &&
        JSON.stringify(freshRecord) !== JSON.stringify(manifestRecord)
      ) {
        differences.push(
          `record ${id} was altered: manifest says class=${manifestRecord.class}, the data re-derives class=${freshRecord.class}`,
        );
      }
    }
  }
  if (JSON.stringify(fresh.summary) !== JSON.stringify(manifest.summary)) {
    differences.push("per-class summary differs from the recorded one");
  }
  return { matches: differences.length === 0, differences };
}

if (import.meta.main) {
  // Operator entry: `bun server/src/billing/cleanup-classification.ts [registries.json]`
  // prints the classification manifest for the deployment database DATABASE_URL names, with
  // the test-evidence registries read from the JSON file argument
  // ({ "testOrderIds": [...], "testUserIds": [...] }; default: empty). Read-only by
  // construction — the classification runs inside its own READ ONLY transaction. Persisting
  // the manifest is saving this output; adjusting a verdict means new inputs and a rerun,
  // never editing this file.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must point at the deployment database this classification should read.",
    );
  }
  const registryPath = process.argv[2];
  const registryInput: TestEvidenceInput = registryPath
    ? await Bun.file(registryPath).json()
    : { testOrderIds: [], testUserIds: [] };
  const { createDatabase } = await import("../db/client");
  const database = createDatabase(databaseUrl);
  try {
    const classification = await classifyCleanup(database, registryInput);
    process.stdout.write(`${JSON.stringify(classification, null, 2)}\n`);
  } finally {
    await database.$client.end();
  }
}
