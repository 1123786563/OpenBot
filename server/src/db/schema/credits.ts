import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  CreditGrantSource,
  CreditGrantStatus,
} from "../../billing/types";
import { billingCustomers } from "./billing";

/**
 * One credit grant, the local ledger's deposit side.
 *
 * Credits are decimal with two places, stored as whole units scaled by 100 (`CREDIT_SCALE` in
 * ../billing/credits.ts) — the same "never store money as a float" discipline the payment orders
 * keep with `amount_cents`, applied to the credit the plan and the campaigns hand out. The scale
 * lives in one constant, so a grant is never half-read as an integer of the wrong magnitude.
 *
 * A grant is scoped to the deployment's own customer, like every other billing projection: one row
 * answers "what did this deployment get, and what has it spent". `used` only ever grows, and never
 * past `total` — the ceiling is a check, not a convention.
 */
export const creditGrants = pgTable(
  "credit_grants",
  {
    id: text("id").primaryKey(),
    externalCustomerId: text("external_customer_id")
      .notNull()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    /** Where it came from: the plan's own allowance, a campaign, or a check-in. */
    source: text("source").$type<CreditGrantSource>().notNull(),
    /** The operator's own words for why ("官方活动发放"), when the source alone is not enough. */
    reason: text("reason"),
    /** Total allowance, in scaled credit units (×100). */
    total: integer("total").notNull(),
    /** What has been spent of it, in scaled credit units (×100). */
    used: integer("used").notNull().default(0),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When the unspent remainder lapses. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * The INITIAL state at grant time, written once by the writer (../billing/credits-writer.ts)
     * and never maintained afterwards. Every read derives the live status from the clock and the
     * balance (credits.ts `deriveGrantStatus`) — "used up" and "expired" are functions of time, not
     * facts a background job flips — so this column is an audit of how the row was born, not a
     * second truth about how it is doing.
     */
    status: text("status").$type<CreditGrantStatus>().notNull().default("active"),
    /**
     * What makes a retried grant one grant: the writer's stable key for the occurrence (e.g.
     * `plan:<orderId>` for the allowance a paid order pays out; `admin:<random>` for a hand
     * grant, so two presses of the promo button stay two grants). The unique index below holds
     * it, so a replay of the same activation inserts nothing rather than a duplicate grant.
     * Always present — the writer derives one when the caller has no natural key, which is what
     * lets the index be a plain unique index (ON CONFLICT can only infer a non-partial one).
     */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "credit_grants_source_check",
      sql`${table.source} IN ('plan', 'promo', 'signin')`,
    ),
    check(
      "credit_grants_status_check",
      sql`${table.status} IN ('active', 'exhausted', 'expired')`,
    ),
    check("credit_grants_total_check", sql`${table.total} >= 0`),
    check(
      "credit_grants_used_check",
      sql`${table.used} >= 0 AND ${table.used} <= ${table.total}`,
    ),
    // The reads the page makes: a customer's grants, and the soon-to-expire among them.
    index("credit_grants_customer_idx").on(table.externalCustomerId),
    index("credit_grants_customer_expires_idx").on(
      table.externalCustomerId,
      table.expiresAt,
    ),
    // One grant per writer occurrence: the insert-or-nothing against this index is what turns a
    // retried activation or a replayed grant into a no-op rather than a second allowance. Plain
    // (not partial) because the column is never null — the writer derives a unique key when the
    // caller has none, keeping "two presses mean two grants" while letting ON CONFLICT infer the
    // index (Postgres cannot infer a partial index without its WHERE clause spelled in the
    // statement).
    uniqueIndex("credit_grants_idempotency_key_unique_idx").on(
      table.idempotencyKey,
    ),
  ],
);

/**
 * One credit expenditure, the ledger's withdrawal side and the "积分消耗明细" table's row.
 *
 * A row is written when a metered call draws on the credit balance. `title` is the request's
 * business name and `requestId` the truncated identifier under it — the two lines the consumption
 * table shows in its "请求" column. `credits` is the cost, scaled by 100, never negative.
 */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    externalCustomerId: text("external_customer_id")
      .notNull()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    /** The grant this draw landed on, when one is known; null leaves the draw unattributed. */
    grantId: text("grant_id").references(() => creditGrants.id, {
      onDelete: "set null",
    }),
    /** The request's business title. */
    title: text("title").notNull(),
    /** The request id, to be truncated by the client. */
    requestId: text("request_id"),
    /** Cost of this call, in scaled credit units (×100). */
    credits: integer("credits").notNull(),
    model: text("model"),
    /** The surface that made the call (web/api/cli). */
    client: text("client"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("credit_ledger_credits_check", sql`${table.credits} >= 0`),
    // The consumption read walks a customer's ledger newest-first.
    index("credit_ledger_customer_created_idx").on(
      table.externalCustomerId,
      table.createdAt,
    ),
    index("credit_ledger_grant_idx").on(table.grantId),
  ],
);
