import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PayerKind } from "../../billing/payer";
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
 *
 * OWNERSHIP (10.3, AC14/Q27): the subscription belongs to the OpenBot payer the paid order was
 * bound to — the same personal account its plan allowance and every renewal payout land in. The
 * pair is resolved SERVER-SIDE from the persisted order at creation (the activation call is the
 * only writer that names it); the provider's webhook deliveries carry no OpenBot identity at all,
 * so the projection refresh physically cannot move it, and a client names no ownership field
 * anywhere on the purchase boundary. Nullable for rows written before the columns existed (the
 * reconciler matches those against ownerless orders by the deployment key, and Q23 forbids
 * auto-attribution).
 *
 * ALLOWANCE PERIOD: the billing period whose plan allowance has been covered — set by the
 * activation path together with the owner (the period the order paid for), advanced by the
 * renewal path only after the new period's grant is recorded. The paired columns are the
 * fast "already covered" marker; the ledger's own `plan-renewal:<id>:<periodStart>` idempotency
 * key is the fence that makes a duplicate or racing delivery a no-op.
 */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    externalCustomerId: text("external_customer_id")
      .notNull()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    /**
     * The provider namespaces external subscription ids per customer (BP05/#373): a personal
     * deployment's subscription and a company's can share the string. The row's identity is
     * the PAIR with its customer, the same domain the provider itself answers in — never the
     * bare string, which would collapse two accounts' subscriptions into one row and one
     * payout.
     */
    externalSubscriptionId: text("external_subscription_id").notNull(),
    planCode: text("plan_code").notNull(),
    status: text("status").$type<BillingSubscriptionStatus>().notNull(),
    /** The payment subject the owning order was bound to; the pair moves together or not at all. */
    ownerPayerKind: text("owner_payer_kind").$type<PayerKind>(),
    ownerPayerId: text("owner_payer_id"),
    /** The billing period whose plan allowance has been paid out (the renewal marker). */
    allowancePeriodStart: timestamp("allowance_period_start", {
      withTimezone: true,
    }),
    allowancePeriodEnd: timestamp("allowance_period_end", {
      withTimezone: true,
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "billing_subscriptions_status_check",
      sql`${table.status} IN ('active', 'incomplete', 'canceled', 'terminated')`,
    ),
    // The owner pair moves together: a half-written owner is a bug, not a state (the same
    // shape payment_orders carries, so the reconciler's pairing reads like the orders').
    check(
      "billing_subscriptions_owner_pair_check",
      sql`(${table.ownerPayerKind} IS NULL) = (${table.ownerPayerId} IS NULL)`,
    ),
    check(
      "billing_subscriptions_owner_kind_check",
      sql`${table.ownerPayerKind} IS NULL OR ${table.ownerPayerKind} IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')`,
    ),
    // The allowance marker moves together too: a period whose end is unknown is not a
    // covered period, and an end without a start is not a period.
    check(
      "billing_subscriptions_allowance_pair_check",
      sql`(${table.allowancePeriodStart} IS NULL) = (${table.allowancePeriodEnd} IS NULL)`,
    ),
    primaryKey({
      columns: [table.externalCustomerId, table.externalSubscriptionId],
    }),
    index("billing_subscriptions_customer_idx").on(table.externalCustomerId),
    // The renewal pass and the per-account reconciliation match by the owner pair, never by
    // a deployment-wide walk.
    index("billing_subscriptions_owner_idx").on(
      table.ownerPayerId,
      table.ownerPayerKind,
    ),
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

/**
 * The account-level resolution registry (Bifrost BP06, #374): one row per authorized
 * disposal command on one payer account — the durable RESULT REGISTRATION of an
 * operator's account-scope decision (补发/结算/释放/平台承担损失/人工退款), with the
 * evidence it stood on, the operator who commanded it, and the command's own retry
 * identity.
 *
 * THE ROWS ARE DECISIONS, NOT MONEY MOVEMENT. The actions themselves go through their own
 * doors — a hold settles or releases only through 08.9's evidenced disposal, a plan
 * redelivers through the activation path — so this table never moves a hold or writes a
 * ledger row. What it guarantees is the ticket's own list: a replay of the SAME command
 * reads the recorded answer and registers nothing (the idempotency-key UNIQUE index), the
 * refund ceiling reads the account's PRIOR refunds (超可退额 is a query, not a hope), and
 * every landed row names its evidence — a command without evidence never reaches the
 * table (0176's CHECKs keep a landed row honest; the service refuses the rest).
 */
export const billingAccountResolutions = pgTable(
  "billing_account_resolutions",
  {
    /** `bar-` plus 8 random bytes as hex, minted by the resolution service. */
    id: text("id").primaryKey(),
    /** The payer account the disposal decided about (the credit account key). */
    externalCustomerId: text("external_customer_id")
      .notNull()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    /** The account-scope action, from the closed five-word vocabulary. */
    action: text("action")
      .$type<"reissue" | "settle" | "release" | "absorb" | "refund">()
      .notNull(),
    /** The operator's stable snake_case reason word (e.g. `paid_not_delivered`). */
    reasonCode: text("reason_code").notNull(),
    /** What the command stands on, by kind; see the migration for the closed set. */
    evidenceKind: text("evidence_kind")
      .$type<
        | "reconcile_finding"
        | "payment_event"
        | "recovery_evidence"
        | "operator_statement"
      >()
      .notNull(),
    /** The specific evidence row/reference the kind names — never free prose alone. */
    evidenceReference: text("evidence_reference").notNull(),
    /** The operator who commanded the disposal; the session's own actor on the route. */
    operatorId: text("operator_id").notNull(),
    /** The command's retry identity: the same key replays the recorded answer. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** The money the action concerns, when it concerns money (refund/absorb/reissue);
     * NULL for record-only actions. Positive whole cents when present. */
    amountCents: integer("amount_cents"),
    /** The operator's own bounded words for what was done. */
    detail: text("detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "billing_account_resolutions_action_check",
      sql`${table.action} IN ('reissue', 'settle', 'release', 'absorb', 'refund')`,
    ),
    check(
      "billing_account_resolutions_evidence_kind_check",
      sql`${table.evidenceKind} IN ('reconcile_finding', 'payment_event', 'recovery_evidence', 'operator_statement')`,
    ),
    check(
      "billing_account_resolutions_amount_check",
      sql`${table.amountCents} IS NULL OR ${table.amountCents} > 0`,
    ),
    check(
      "billing_account_resolutions_reason_code_shape_check",
      sql`${table.reasonCode} ~ '^[a-z0-9_]{1,64}$'`,
    ),
    // One registration per command key, ever — the database-level half of 可重放不重复.
    uniqueIndex("billing_account_resolutions_idempotency_key_unique_idx").on(
      table.idempotencyKey,
    ),
    index("billing_account_resolutions_account_idx").on(
      table.externalCustomerId,
      table.createdAt,
    ),
  ],
);
