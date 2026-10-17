import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PayerKind } from "../../billing/payer-ref";
import { billingCustomers } from "./billing";

/**
 * One payer account: the standing fact that one billing subject (../billing/payer-ref.ts
 * `PayerRef` — a kind and a stable id) is billed through exactly one `externalCustomerId`, the
 * same string `credit_grants`, `credit_ledger` and every CreditWriter call are keyed by.
 *
 * Two uniqueness directions, both enforced by the database rather than by read-checks:
 *
 * - `(kind, owner_id)` is unique: a subject has one effective account. Concurrent provisioning
 *   races on this index; the loser's insert becomes a no-op that re-reads the winner's row
 *   (../billing/payer-account.ts).
 * - `external_customer_id` is unique: a billing key belongs to one account. Whatever writes
 *   mappings next (the 02.2 legacy mapping binding existing deployment keys), a key claimed by
 *   two subjects is a write failure here, not a silent second owner.
 *
 * The account carries NO balance of its own: the grants and the ledger stay where they are,
 * under the key. Creating an account must not copy, split or migrate any credit (ticket #215's
 * fourth criterion); it only fixes ownership.
 */
export const payerAccounts = pgTable(
  "payer_accounts",
  {
    id: text("id").primaryKey(),
    /** Which kind of subject owns the account; the check constraint repeats the closed set. */
    kind: text("kind").$type<PayerKind>().notNull(),
    /** The stable id inside that kind (a user id, a tenant id, a deployment tenant id). */
    ownerId: text("owner_id").notNull(),
    /**
     * The billing key this account maps to — one `billing_customers.external_id`. The personal
     * and company kinds derive theirs from the payer (deterministic, injective); the legacy and
     * unknown kinds are bound explicitly by the 02.2 mapping. Either way the unique index, not
     * the derivation, is the authority over who owns the key.
     */
    externalCustomerId: text("external_customer_id")
      .notNull()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "payer_accounts_kind_check",
      sql`${table.kind} IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')`,
    ),
    // One effective account per subject — the index concurrent provisioning converges on.
    uniqueIndex("payer_accounts_owner_unique_idx").on(
      table.kind,
      table.ownerId,
    ),
    // One account per billing key — the bidirectional half of the mapping's uniqueness.
    uniqueIndex("payer_accounts_external_customer_unique_idx").on(
      table.externalCustomerId,
    ),
  ],
);
