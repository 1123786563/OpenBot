import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { BillingSubscriptionStatus } from "../../billing/types";

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
    status: text("status")
      .$type<BillingSubscriptionStatus>()
      .notNull(),
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
 * redelivery of a known `provider + event_id` is answered from this table alone. `lago_unique_key`
 * carries the delivery's idempotency header for investigation; it is an aid, not the key, because
 * only the pair of columns is guaranteed present on every event.
 */
export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    lagoUniqueKey: text("lago_unique_key"),
    webhookType: text("webhook_type").notNull(),
    objectId: text("object_id"),
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
  ],
);
