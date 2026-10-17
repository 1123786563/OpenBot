/**
 * Gateway billing configuration that must remember its own history (Bifrost 01.4, AC12/Q14/Q19).
 *
 * The USD→credits conversion rate used to live as one mutable value in `enterprise_settings`
 * (`gateway_conversion_rate`, see `gateway/conversion-rate-store.ts`). A mutable single value
 * cannot answer "which rate was in effect when this request was admitted?", so every admission
 * before a change would settle at whatever the row happens to hold now. This table is the fix the
 * ticket names: every administrator save appends one immutable version — the version number, the
 * exact rational, the moment it took effect and the operator who recorded it — and requests
 * resolve the version effective at their own time (`rateVersionAt`), so a change only reaches
 * requests admitted after it.
 *
 * The rows are append-only in the database, not merely in the application: triggers refuse
 * UPDATE, DELETE and — because a row-level trigger cannot see it, the exact hole migration 0012
 * closed for the audit trail — TRUNCATE. The `enterprise_settings` row keeps its 01.3 shape and
 * role as the separately-marked *current* version; this table is the history that marker points
 * into. Version 0 is not a row: it is the deployment's environment rate, static by definition.
 */

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
  GatewayCustomerProvisionState,
  GatewayCustomerSubjectKind,
} from "../../gateway/customer";

export const gatewayRateVersions = pgTable(
  "gateway_rate_versions",
  {
    /**
     * The version number 01.3's `rateVersion` already promised: monotonic, assigned by the save
     * transaction under the same advisory lock that serializes the pointer row, so two concurrent
     * saves can never hand out one number twice (the primary key is the final backstop).
     */
    rateVersion: integer("rate_version").primaryKey(),
    /**
     * The exact rational, as decimal strings. Strings rather than integers because the terms are
     * bigints in the application (15 digits each), and a JSON/JSONB or float round-trip is how
     * exact pricing quietly stops being exact.
     */
    numerator: text("numerator").notNull(),
    denominator: text("denominator").notNull(),
    /**
     * When this version took effect. `statement_timestamp()`, not `now()`: a save that blocks on
     * the advisory lock still carries its transaction-start time, which can sit *before* the
     * commit it waited for — two racing saves could then record effective moments in the wrong
     * order, and a request admitted between them would resolve to a version that did not exist
     * when it was admitted. The statement that inserts the row runs only after the lock is held,
     * so its own timestamp strictly follows the predecessor's, and version order stays identical
     * to effective-time order no matter how many saves race.
     */
    effectiveAt: timestamp("effective_at", { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp()`),
    /** Who recorded it — the operator identity the save was attributed to (auditable, AC). */
    recordedBy: text("recorded_by").notNull(),
    /** When the record itself was written. Distinct from `effectiveAt` for honesty about both. */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /*
     * The point-in-time query (`WHERE effective_at <= $t ORDER BY effective_at DESC, rate_version
     * DESC LIMIT 1`) is the one both admission and settlement share, so it leads its own index and
     * carries the sort: one index scan, and the version number breaks any same-instant tie.
     */
    index("gateway_rate_versions_effective_at_idx").on(
      table.effectiveAt.desc(),
      table.rateVersion.desc(),
    ),
  ],
);

/**
 * The gateway customer mapping (Bifrost 05.1, AC01/Q6/Q7): one OpenBot personal user ↔ one
 * Bifrost governance Customer, the "Bifrost Principal" CONTEXT.md names. Provisioning creates
 * the Customer at the gateway (whose `name` is unique, so the deterministic per-subject name is
 * what makes a concurrent create converge on one remote entity) and records the mapping here —
 * the row 05.3's key issuance and 05.8's status sync read instead of asking the gateway.
 *
 * THREE UNIQUE INDEXES ARE THE TICKET'S WHOLE CONCURRENCY STORY. The subject index
 * (`kind, payer_id`) lets exactly one mapping survive a racing provisioning burst — the
 * database, not a read-check, arbitrates which insert wins, and the losers re-read the
 * committed row and answer the winner's customer id. The remote-id and remote-name indexes are
 * the other two directions of "one-to-one": one gateway Customer maps back to at most one
 * subject, and one deterministic name (the resolution key 05.2's crash recovery looks up by)
 * is held by at most one row. Like `payer_accounts`, this table is a mapping and nothing more:
 * provisioning creates no billing customer, no grant, no ledger row, no balance.
 */
export const gatewayCustomers = pgTable(
  "gateway_customers",
  {
    id: text("id").primaryKey(),
    /** The subject kind this mapping names. This ticket provisions personal users only. */
    kind: text("kind").$type<GatewayCustomerSubjectKind>().notNull(),
    /** The subject's own stable id (the OpenBot user id). */
    payerId: text("payer_id").notNull(),
    /** The id the gateway generated for the Customer — the string 05.3 addresses keys with. */
    gatewayCustomerId: text("gateway_customer_id").notNull(),
    /** The deterministic gateway-side name (= `payerKey`), the recovery lookup key for 05.2. */
    gatewayCustomerName: text("gateway_customer_name").notNull(),
    /** The provisioning state the module answers with; "active" is the only one it writes. */
    provisionState: text("provision_state")
      .$type<GatewayCustomerProvisionState>()
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("gateway_customers_kind_check", sql`${table.kind} IN ('personal')`),
    check(
      "gateway_customers_provision_state_check",
      sql`${table.provisionState} IN ('active')`,
    ),
    // One mapping per subject — the index a concurrent provisioning burst races into.
    uniqueIndex("gateway_customers_subject_unique_idx").on(
      table.kind,
      table.payerId,
    ),
    // One gateway Customer belongs to at most one subject, in this direction too.
    uniqueIndex("gateway_customers_remote_id_unique_idx").on(
      table.gatewayCustomerId,
    ),
    // One deterministic name is held by at most one row — the uniqueness the 05.2
    // name-based recovery stands on.
    uniqueIndex("gateway_customers_remote_name_unique_idx").on(
      table.gatewayCustomerName,
    ),
  ],
);
