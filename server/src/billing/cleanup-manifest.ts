import { eq, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
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

/*
 * The legacy billing enumeration (group 21.1): one read-only pass over the tables the old
 * billing stack actually occupies, answering "what is there, how much of it, and whose is it"
 * from queries — never from table names or key prefixes.
 *
 * Two invariants the whole cleanup group leans on:
 *
 * - READ ONLY is enforced by the database, not by convention. The enumeration runs every query
 *   inside one `SET TRANSACTION READ ONLY` transaction, so an accidental write is a runtime
 *   error, not a silent mutation. The transaction is also REPEATABLE READ, so the counts, id
 *   ranges and attribution splits answer one consistent snapshot instead of a slowly sliding
 *   one.
 * - Attribution comes only from group 02.2's explicit mapping (`payer_accounts`) and from the
 *   data linkages the schema itself documents — the `plan:<orderId>` payout-grant key, the
 *   subscription id a webhook's object_id may name. A row that resolves through neither is
 *   counted as `unmapped` (unknown attribution): it is listed separately and is nobody's
 *   cleanable default. This module classifies and counts; it never decides what may be
 *   deleted — that is 21.2's job, on top of this manifest.
 */

/** The attribution classes: the four explicit payer kinds plus "no mapping row at all". */
export type PayerAttribution =
  | "personal"
  | "company"
  | "legacy_deployment"
  | "unknown_owner"
  | "unmapped";

/** One legacy billing table's enumerated shape: existence, size, id range, attribution split. */
export type CleanupTableManifest = {
  /** The actual table name, as the manifest queried it. */
  table: string;
  /** The schema the table was found in, from the catalog — not assumed `public`. */
  schema: string;
  /** Whether the catalog lists the table. Absence is evidence too, never a crash. */
  exists: boolean;
  rowCount: number;
  /** min/max of the table's object id column, as strings; null for an empty (or absent) table. */
  idRange: { min: string | null; max: string | null };
  /** Per-attribution row counts; `unmapped` rows are unknown attribution, not cleanable. */
  attribution: {
    personal: number;
    company: number;
    legacyDeployment: number;
    unknownOwner: number;
    unmapped: number;
  };
  /** Why the attribution split means what it means: the exact linkage the query used. */
  attributionBasis: string;
};

/** One external customer key's footprint across the keyed billing tables. */
export type CleanupCustomerEntry = {
  externalCustomerId: string;
  attribution: PayerAttribution;
  /** Keyed table → this key's row count there; tables absent from the record hold zero rows. */
  appearsIn: Record<string, number>;
};

/** The manifest draft 21.2 (classification) and 21.4 (dry-run hash) consume. */
export type CleanupManifest = {
  manifestVersion: 1;
  /** `current_database()` — the database the evidence was read from. */
  database: string;
  /** The schema the enumerated tables were found in, from the catalog. */
  schema: string;
  generatedAt: string;
  /** Fixed enumeration order; the shape 21.4's hash binds against. */
  tables: CleanupTableManifest[];
  /** Every key the keyed tables hold, sorted by id, with its explicit-mapping attribution. */
  customers: CleanupCustomerEntry[];
  /** The unknown-attribution subset of `customers` (unknown_owner and unmapped), listed apart. */
  unknownOwners: CleanupCustomerEntry[];
  /** credit_reservations rows per status — the in-flight responsibility evidence 21.5 guards. */
  reservationStatusCounts: Record<string, number>;
};

/** A drizzle transaction, typed the way the repo types transaction callbacks. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Row count and object-id range of one table, read from the live rows. */
async function totalsOf(
  tx: Transaction,
  table: PgTable,
  idColumn: PgColumn,
): Promise<{ rowCount: number; min: string | null; max: string | null }> {
  const [row] = await tx
    .select({
      // count() is bigint in Postgres; it rides back as text and is widened here, so a
      // legacy table past 2^31-1 rows is a number instead of an "integer out of range".
      rowCount: sql<string>`count(*)`,
      min: sql<string | null>`min(${idColumn})`,
      max: sql<string | null>`max(${idColumn})`,
    })
    .from(table);
  return {
    rowCount: Number(row?.rowCount ?? 0),
    min: row?.min ?? null,
    max: row?.max ?? null,
  };
}

/** Per-key row counts of one keyed table. */
async function keyedCountsOf(
  tx: Transaction,
  table: PgTable,
  keyColumn: PgColumn,
): Promise<{ key: string; n: number }[]> {
  return tx
    .select({
      // The same column reference, typed as the string key it is (a bare PgColumn in a generic
      // select loses its value type to `unknown`).
      key: sql<string>`${keyColumn}`,
      n: sql<number>`count(*)::int`,
    })
    .from(table)
    .groupBy(keyColumn);
}

/** { kind | null, rows } pairs → the fixed attribution distribution. A null kind (no explicit
 * mapping row for the key the row rides on) is unknown attribution, never folded anywhere. */
function distributionOf(rows: { attribution: string | null; n: number }[]) {
  const attribution = {
    personal: 0,
    company: 0,
    legacyDeployment: 0,
    unknownOwner: 0,
    unmapped: 0,
  };
  for (const { attribution: kind, n } of rows) {
    if (kind === "personal") attribution.personal += n;
    else if (kind === "company") attribution.company += n;
    else if (kind === "legacy_deployment") attribution.legacyDeployment += n;
    else if (kind === "unknown_owner") attribution.unknownOwner += n;
    else attribution.unmapped += n;
  }
  return attribution;
}

export async function enumerateCleanupManifest(
  database: Database,
): Promise<CleanupManifest> {
  return database.transaction(async (tx) => {
    // The read-only fence: the database refuses every write in this transaction, so the
    // enumeration cannot mutate what it measures. REPEATABLE READ pins all reads to one
    // snapshot, so the counts and ranges describe one moment, not a sliding one.
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );

    const identity = await tx.execute<{
      database: string;
      schema: string;
    }>(sql`SELECT current_database() AS database, current_schema() AS schema`);
    if (identity[0] === undefined) {
      throw new Error(
        "cleanup manifest: the database identity query returned no row",
      );
    }
    const manifestDatabase = identity[0].database;
    const manifestSchema = identity[0].schema;

    /** The catalog location of one table, preferring the current schema. */
    const locationOf = async (table: string): Promise<string | null> => {
      const rows = await tx.execute<{ table_schema: string }>(
        sql`SELECT table_schema FROM information_schema.tables
            WHERE table_name = ${table}
            ORDER BY (table_schema = current_schema()) DESC, table_schema
            LIMIT 1`,
      );
      return rows[0]?.table_schema ?? null;
    };

    // Attribution basis shared by every table that carries external_customer_id directly.
    const keyedBasis =
      "left join payer_accounts on the table's external_customer_id; kind from the explicit 02.2 mapping; rows with no mapping row count as unmapped (unknown attribution, never a cleanable default)";
    // Kind distribution joined on ONE table's own customer-key column. The payer mapping joins
    // 1:1 (unique external_customer_id), so no attribution query fans rows out.
    const attributionOn = (table: PgTable, keyColumn: PgColumn) => () =>
      tx
        .select({
          attribution: payerAccounts.kind,
          n: sql<number>`count(*)::int`,
        })
        .from(table)
        .leftJoin(
          payerAccounts,
          eq(payerAccounts.externalCustomerId, keyColumn),
        )
        .groupBy(payerAccounts.kind);

    /** Per-table queries, in the manifest's fixed order. */
    const tables: {
      name: string;
      basis: string;
      totals: () => ReturnType<typeof totalsOf>;
      attribution: () => Promise<{ attribution: string | null; n: number }[]>;
    }[] = [
      {
        name: "billing_customers",
        basis: keyedBasis,
        totals: () =>
          totalsOf(tx, billingCustomers, billingCustomers.externalId),
        attribution: attributionOn(
          billingCustomers,
          billingCustomers.externalId,
        ),
      },
      {
        name: "payer_accounts",
        basis:
          "the mapping table itself: rows grouped by their own kind; every row carries a kind, so nothing is unmapped",
        totals: () => totalsOf(tx, payerAccounts, payerAccounts.id),
        attribution: () =>
          tx
            .select({
              attribution: payerAccounts.kind,
              n: sql<number>`count(*)::int`,
            })
            .from(payerAccounts)
            .groupBy(payerAccounts.kind),
      },
      {
        name: "billing_subscriptions",
        basis: keyedBasis,
        totals: () =>
          totalsOf(
            tx,
            billingSubscriptions,
            billingSubscriptions.externalSubscriptionId,
          ),
        attribution: attributionOn(
          billingSubscriptions,
          billingSubscriptions.externalCustomerId,
        ),
      },
      {
        name: "billing_webhook_events",
        basis:
          "left join billing_subscriptions on external_subscription_id = object_id, then the subscription customer's explicit payer mapping; object ids matching no subscription count as unmapped (webhook rows carry no customer key of their own)",
        totals: () =>
          totalsOf(tx, billingWebhookEvents, billingWebhookEvents.eventId),
        attribution: () =>
          tx
            .select({
              attribution: payerAccounts.kind,
              n: sql<number>`count(*)::int`,
            })
            .from(billingWebhookEvents)
            .leftJoin(
              billingSubscriptions,
              eq(
                billingSubscriptions.externalSubscriptionId,
                billingWebhookEvents.objectId,
              ),
            )
            .leftJoin(
              payerAccounts,
              eq(
                payerAccounts.externalCustomerId,
                billingSubscriptions.externalCustomerId,
              ),
            )
            .groupBy(payerAccounts.kind),
      },
      {
        name: "credit_grants",
        basis: keyedBasis,
        totals: () => totalsOf(tx, creditGrants, creditGrants.id),
        attribution: attributionOn(
          creditGrants,
          creditGrants.externalCustomerId,
        ),
      },
      {
        name: "credit_ledger",
        basis: keyedBasis,
        totals: () => totalsOf(tx, creditLedger, creditLedger.id),
        attribution: attributionOn(
          creditLedger,
          creditLedger.externalCustomerId,
        ),
      },
      {
        name: "credit_reservations",
        basis: keyedBasis,
        totals: () => totalsOf(tx, creditReservations, creditReservations.id),
        attribution: attributionOn(
          creditReservations,
          creditReservations.externalCustomerId,
        ),
      },
      {
        name: "credit_reservation_allocations",
        basis:
          "attributed through the reservation's external_customer_id (inner join credit_reservations), then the explicit payer mapping; no mapping row counts as unmapped",
        totals: () =>
          totalsOf(
            tx,
            creditReservationAllocations,
            creditReservationAllocations.id,
          ),
        attribution: () =>
          tx
            .select({
              attribution: payerAccounts.kind,
              n: sql<number>`count(*)::int`,
            })
            .from(creditReservationAllocations)
            .innerJoin(
              creditReservations,
              eq(
                creditReservations.id,
                creditReservationAllocations.reservationId,
              ),
            )
            .leftJoin(
              payerAccounts,
              eq(
                payerAccounts.externalCustomerId,
                creditReservations.externalCustomerId,
              ),
            )
            .groupBy(payerAccounts.kind),
      },
      {
        name: "credit_charge_remainders",
        basis: keyedBasis,
        totals: () =>
          totalsOf(
            tx,
            creditChargeRemainders,
            creditChargeRemainders.externalCustomerId,
          ),
        attribution: attributionOn(
          creditChargeRemainders,
          creditChargeRemainders.externalCustomerId,
        ),
      },
      {
        name: "payment_orders",
        basis:
          "attributed through the paid-out grant's documented idempotency key 'plan:' || payment_orders.id (see credits.ts), then the grant customer's explicit payer mapping; orders with no payout grant count as unmapped (order rows carry no customer key)",
        totals: () => totalsOf(tx, paymentOrders, paymentOrders.id),
        attribution: () =>
          tx
            .select({
              attribution: payerAccounts.kind,
              n: sql<number>`count(*)::int`,
            })
            .from(paymentOrders)
            .leftJoin(
              creditGrants,
              eq(
                creditGrants.idempotencyKey,
                sql`'plan:' || ${paymentOrders.id}`,
              ),
            )
            .leftJoin(
              payerAccounts,
              eq(
                payerAccounts.externalCustomerId,
                creditGrants.externalCustomerId,
              ),
            )
            .groupBy(payerAccounts.kind),
      },
      {
        name: "payment_events",
        basis:
          "attributed through the parent order's payout-grant linkage (inner join payment_orders, see payment_orders); unresolvable rows count as unmapped",
        totals: () => totalsOf(tx, paymentEvents, paymentEvents.id),
        attribution: () =>
          tx
            .select({
              attribution: payerAccounts.kind,
              n: sql<number>`count(*)::int`,
            })
            .from(paymentEvents)
            .innerJoin(
              paymentOrders,
              eq(paymentOrders.id, paymentEvents.orderId),
            )
            .leftJoin(
              creditGrants,
              eq(
                creditGrants.idempotencyKey,
                sql`'plan:' || ${paymentOrders.id}`,
              ),
            )
            .leftJoin(
              payerAccounts,
              eq(
                payerAccounts.externalCustomerId,
                creditGrants.externalCustomerId,
              ),
            )
            .groupBy(payerAccounts.kind),
      },
      {
        name: "usage_outbox",
        basis: keyedBasis,
        totals: () => totalsOf(tx, usageOutbox, usageOutbox.eventId),
        attribution: attributionOn(usageOutbox, usageOutbox.externalCustomerId),
      },
    ];

    const manifestTables: CleanupTableManifest[] = [];
    for (const spec of tables) {
      const [located, totals, attribution] = [
        await locationOf(spec.name),
        await spec.totals(),
        distributionOf(await spec.attribution()),
      ];
      manifestTables.push({
        table: spec.name,
        schema: located ?? "(missing)",
        exists: located !== null,
        rowCount: totals.rowCount,
        idRange: { min: totals.min, max: totals.max },
        attribution,
        attributionBasis: spec.basis,
      });
    }

    // The customers list: every key the keyed tables hold, with live per-table counts.
    const keyedTables = [
      {
        table: "billing_customers",
        object: billingCustomers,
        column: billingCustomers.externalId,
      },
      {
        table: "billing_subscriptions",
        object: billingSubscriptions,
        column: billingSubscriptions.externalCustomerId,
      },
      {
        table: "credit_grants",
        object: creditGrants,
        column: creditGrants.externalCustomerId,
      },
      {
        table: "credit_ledger",
        object: creditLedger,
        column: creditLedger.externalCustomerId,
      },
      {
        table: "credit_reservations",
        object: creditReservations,
        column: creditReservations.externalCustomerId,
      },
      {
        table: "credit_charge_remainders",
        object: creditChargeRemainders,
        column: creditChargeRemainders.externalCustomerId,
      },
      {
        table: "usage_outbox",
        object: usageOutbox,
        column: usageOutbox.externalCustomerId,
      },
    ];
    const mappings = await tx
      .select({
        key: payerAccounts.externalCustomerId,
        kind: payerAccounts.kind,
      })
      .from(payerAccounts);
    const kindByKey = new Map(mappings.map((m) => [m.key, m.kind]));

    const byKey = new Map<string, CleanupCustomerEntry>();
    for (const { table, object, column } of keyedTables) {
      for (const { key, n } of await keyedCountsOf(tx, object, column)) {
        let entry = byKey.get(key);
        if (!entry) {
          entry = {
            externalCustomerId: key,
            attribution: kindByKey.get(key) ?? "unmapped",
            appearsIn: {},
          };
          byKey.set(key, entry);
        }
        entry.appearsIn[table] = n;
      }
    }
    const customers = [...byKey.values()].sort((a, b) =>
      a.externalCustomerId < b.externalCustomerId
        ? -1
        : a.externalCustomerId > b.externalCustomerId
          ? 1
          : 0,
    );

    // Unknown attribution, listed separately: explicit quarantine AND no-mapping rows.
    const unknownOwners = customers.filter(
      (entry) =>
        entry.attribution === "unknown_owner" ||
        entry.attribution === "unmapped",
    );

    // In-flight responsibility evidence: holds that may still settle must never be cleaned.
    const statusRows = await tx
      .select({
        status: creditReservations.status,
        n: sql<number>`count(*)::int`,
      })
      .from(creditReservations)
      .groupBy(creditReservations.status);
    statusRows.sort((a, b) =>
      a.status < b.status ? -1 : a.status > b.status ? 1 : 0,
    );
    const reservationStatusCounts = Object.fromEntries(
      statusRows.map((row) => [row.status, row.n]),
    );

    return {
      manifestVersion: 1,
      database: manifestDatabase,
      schema: manifestSchema,
      generatedAt: new Date().toISOString(),
      tables: manifestTables,
      customers,
      unknownOwners,
      reservationStatusCounts,
    };
  });
}

if (import.meta.main) {
  // Operator entry: `bun server/src/billing/cleanup-manifest.ts` prints the manifest for the
  // deployment database DATABASE_URL names. Read-only by construction — the enumeration runs
  // inside its own READ ONLY transaction and writes nothing.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must point at the deployment database this enumeration should read.",
    );
  }
  const { createDatabase } = await import("../db/client");
  const database = createDatabase(databaseUrl);
  try {
    const manifest = await enumerateCleanupManifest(database);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await database.$client.end();
  }
}
