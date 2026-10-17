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
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
