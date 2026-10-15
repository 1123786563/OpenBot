import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { billingCustomers } from "./billing";

/**
 * The billing subject: one PayerRef (kind + stable id) maps to exactly one existing
 * external_customer_id, and one external_customer_id belongs to at most one payer — both enforced
 * by unique indexes, not by read-checks. Creating an account moves no money: balances stay where
 * they are (legacy rows keep their own keys; migration/classification is 02.2's job).
 */
export const payerAccounts = pgTable(
  "payer_accounts",
  {
    id: text("id").primaryKey(),
    payerKind: text("payer_kind").$type<"personal" | "company" | "legacy_deployment" | "unknown_owner">().notNull(),
    externalRef: text("external_ref").notNull(),
    externalCustomerId: text("external_customer_id")
      .notNull()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payer_accounts_subject_unique").on(table.payerKind, table.externalRef),
    uniqueIndex("payer_accounts_customer_unique").on(table.externalCustomerId),
  ],
);
