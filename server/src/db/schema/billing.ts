import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { BillingSubscriptionStatus } from "../../billing/types";
import type { PayerKind } from "../../billing/payer";

/**
 * The customers the billing provider knows about, keyed by the external ID this deployment
 * generates locally (deployment identity), so the projection can be re-read and refreshed without
 * ever storing a provider identifier as its key.
 */
export const billingCustomers = pgTable("billing_customers", {
  externalId: text("external_id").primaryKey(),
  name: text("name"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/*
 * One payer account, the billing subject the whole credit stack is being keyed on: a stable
 * { kind, payer_id } pair (a person, a company tenant, a pre-account-layer deployment) mapped
 * to exactly one existing external customer id — the string `credit_grants` / `credit_ledger`
 * already key on, which is why this table records the mapping instead of re-keying those tables
 * (a one-shot re-key would migrate balances, and this layer must not).
 *
 * The two unique indexes ARE the mapping's bidirectional uniqueness, and the database — not a
 * read-check —
 * is the arbiter: one subject (kind, payer_id) can hold at most one account, and one external
 * customer id can belong to at most one account, so concurrent `createPayerAccount` calls race
 * into the indexes and leave exactly one valid mapping. `unknown_owner` rows are group 02.2's
 * quarantine records: they exist for audit, and the payer module's key derivation refuses them,
 * so no new consumption path can resolve one into a spendable account.
 */
export const payerAccounts = pgTable(
  "payer_accounts",
  {
    id: text("id").primaryKey(),
    /** Which kind of subject owns the account. Narrow at the database, not by convention. */
    kind: text("kind").$type<PayerKind>().notNull(),
    /** The subject's own stable id (a user id, a tenant id, a deployment tenant id). */
    payerId: text("payer_id").notNull(),
    /** The one external customer key this account bills through; never shared with another account. */
    externalCustomerId: text("external_customer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Explicit short name: the drizzle default spells both table names and lands at 68 bytes,
    // past the 63-byte identifier limit Postgres silently truncates at
    // (migration-runner-guard's migration_sql_identifier_names_fit_the_postgres_limit).
    foreignKey({
      name: "payer_accounts_external_customer_id_fk",
      columns: [table.externalCustomerId],
      foreignColumns: [billingCustomers.externalId],
    }).onDelete("cascade"),
    check(
      "payer_accounts_kind_check",
      sql`${table.kind} IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')`,
    ),
    // One account per subject.
    uniqueIndex("payer_accounts_subject_unique_idx").on(
      table.kind,
      table.payerId,
    ),
    // One account per external customer key — the other direction of the pair.
    uniqueIndex("payer_accounts_external_customer_unique_idx").on(
      table.externalCustomerId,
    ),
  ],
);

/**
 * One subscription projection per external subscription ID. `status` is the four states the sync
 * asks the provider about; a terminated subscription stays as a row because "no longer active" is
 * information the entitlement read needs, not an absence.
 */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    externalCustomerId: text("external_customer_id")
      .notNull()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    externalSubscriptionId: text("external_subscription_id").primaryKey(),
    planCode: text("plan_code").notNull(),
    status: text("status").$type<BillingSubscriptionStatus>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "billing_subscriptions_status_check",
      sql`${table.status} IN ('active', 'incomplete', 'canceled', 'terminated')`,
    ),
    index("billing_subscriptions_customer_idx").on(table.externalCustomerId),
  ],
);

/**
 * The webhook inbox: one row per provider event that has been fully processed.
 *
 * The row is written only after the authoritative re-read succeeded and the projections were
 * refreshed, so a row always stands for finished work — never for "received and dropped". A
 * redelivery of a known `provider + event_id` is answered from this table alone. The event's
 * identity is the delivery's `X-Lago-Unique-Key` header (the provider's payload carries no event
 * id of its own), so `event_id` and `lago_unique_key` hold the same value; the column keeps the
 * header's own name for the trail, and the pair remains the one key a redelivery is answered by.
 */
export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    lagoUniqueKey: text("lago_unique_key"),
    webhookType: text("webhook_type").notNull(),
    objectId: text("object_id"),
    /** sha256 of the raw delivery body; the replay-evidence key (audit A7). Nullable: rows written before it exist. */
    bodyHash: text("body_hash"),
    /** Always true today: the row exists precisely because the work it names is done. */
    processed: boolean("processed").notNull().default(true),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_webhook_events_provider_event_idx").on(
      table.provider,
      table.eventId,
    ),
    index("billing_webhook_events_unique_key_idx").on(table.lagoUniqueKey),
    // A plain lookup index, not a uniqueness fence: two distinct events may legitimately carry
    // byte-identical bodies, so the hash is evidence, never a dedupe key (audit A7).
    index("billing_webhook_events_body_hash_idx").on(table.bodyHash),
  ],
);
