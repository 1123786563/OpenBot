/**
 * The Bot service registry (bifrost-5, 04.1 / #234).
 *
 * One row is an administrator's decision that a Bot exists as a SERVICE IDENTITY: a builtin one or
 * an approved external one. That is all a row is. It is not a credential (04.2 issues those
 * separately, against `credentials`), not a user's authorization (04.5 creates grants), and not any
 * kind of credit permission — a Bot consumes somebody's credits only through a Model Access Grant a
 * person gave it, never through this table.
 *
 * `bot_id` is the primary key, and there is no delete path anywhere in the store: an identity that
 * was used cannot be silently replaced by another Bot wearing the same id. Disabling keeps the row
 * (status `disabled`, with who and when) so the id stays taken and downstream surfaces (04.2's
 * authentication, 03.8's capability filter, 05.3's key issuance) can read the refusal fact.
 */
import { sql } from "drizzle-orm";
import {
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Builtin (this deployment's own) or external (an administrator approved it in). */
export const botServiceKind = pgEnum("bot_service_kind", [
  "builtin",
  "external",
]);

/** Only the refusal fact a downstream consumer needs; `active` is a registration's default. */
export const botServiceStatus = pgEnum("bot_service_status", [
  "active",
  "disabled",
]);

/**
 * The capability declaration an administrator pinned at registration, and the filter 03.8 applies
 * against the model catalog. Closed on purpose: a capability with no billing/admission story behind
 * it must not be declarable here, and the store rejects anything outside this list.
 */
export const botServiceCapability = pgEnum("bot_service_capability", [
  "chat",
  "image",
  "audio",
  "embedding",
  "realtime",
  "async",
]);

export const botServices = pgTable(
  "bot_services",
  {
    botId: text("bot_id").primaryKey(),
    displayName: text("display_name").notNull(),
    kind: botServiceKind("kind").notNull(),
    capabilities: botServiceCapability("capabilities").array().notNull(),
    status: botServiceStatus("status").notNull().default("active"),
    /** The administrator who registered it, as an id rather than a reference — see `audit_events`. */
    registeredBy: text("registered_by").notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledBy: text("disabled_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // A Bot that declares nothing can call nothing; an empty declaration is a registration mistake.
    // (Set semantics — no duplicates — are the STORE's invariant, validated before every write: a
    // PostgreSQL CHECK cannot count distinct elements of an array without a subquery, and an
    // immutable helper function bought for one column is not worth the migration surface.)
    check(
      "bot_services_capabilities_not_empty_check",
      sql`cardinality(${table.capabilities}) > 0`,
    ),
    // A disabled row names who disabled it; an active row names nobody. Half-written states are
    // what this keeps out: `disabled_by` set on an `active` row reads as a disable that unwound.
    check(
      "bot_services_disabled_consistency_check",
      sql`(${table.status} = 'active' AND ${table.disabledAt} IS NULL AND ${table.disabledBy} IS NULL) OR (${table.status} = 'disabled' AND ${table.disabledAt} IS NOT NULL AND ${table.disabledBy} IS NOT NULL)`,
    ),
  ],
);
