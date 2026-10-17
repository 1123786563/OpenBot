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
  jsonb,
  pgTable,
  primaryKey,
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
 * The last-good model catalog, normalized to the ModelRef triple (Bifrost 03.1, AC06/Q4/Q17).
 *
 * Each row is one cell of the identity the ticket names — provider × model × capability — and the
 * unique index below *is* the no-merge rule: the same model name under two providers (say
 * `openai/gpt-4o` and `azure/gpt-4o`, the shape `/v1/models` always reports) is two rows, never
 * one. A model whose capability could not be derived from its upstream capability fields is kept
 * as `capability = 'unknown'` with `unknown_reason` naming why — the closed CHECK is what stops a
 * future edit from quietly defaulting unknown models to chat — and `raw_entry` keeps the exact
 * upstream JSON the ref came from, so the price mapping (03.2) and an auditor re-check the same
 * bytes the gateway sent.
 *
 * The table holds the *last good* snapshot, nothing else: a fetch that fails after the gate writes
 * no rows here (catalog.ts), so a broken gateway never erases what the last successful sync
 * proved. A successful fetch replaces the whole table in one transaction — refs absent from the
 * new manifest are gone, because a model the gateway stopped listing must not stay selectable
 * (design Q17: 下架或失效模型阻止新请求).
 */
export const gatewayModelCatalogRefs = pgTable(
  "gateway_model_catalog_refs",
  {
    /** The provider half of the identity, as the gateway reports it (`openai`, `azure`, …). */
    provider: text("provider").notNull(),
    /** The model half of the identity — everything after the provider prefix, slashes included. */
    model: text("model").notNull(),
    /**
     * The derived capability (`chat`, `embedding`, …) or `unknown`. The closed set is enforced in
     * the database: an unmapped capability must arrive as `unknown` carrying `unknown_reason`.
     */
    capability: text("capability").notNull(),
    /** Where the capability came from: `supported_methods` (mapped) or `none` (unknown). */
    capabilitySource: text("capability_source").notNull(),
    /** Why the capability is unknown — a fixed `catalog_capability_*` code, present iff unknown. */
    unknownReason: text("unknown_reason"),
    /** The exact upstream entry this ref was normalized from, for audit and price re-mapping. */
    rawEntry: jsonb("raw_entry").notNull(),
    /** The endpoint configuration version the gateway answered for when this snapshot was taken. */
    configVersion: integer("config_version").notNull(),
    /** When the successful fetch that wrote this row completed, from the fetcher's clock. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    /*
     * The identity itself. Three rows may share a model name; no two rows may share all three
     * parts — and because the constraint lives here, a buggy writer fails loudly instead of
     * silently merging two providers' prices into one selectable model.
     */
    uniqueIndex("gateway_model_catalog_refs_identity_uq").on(
      table.provider,
      table.model,
      table.capability,
    ),
    /*
     * The closed capability set (CONTEXT.md: 能力; design Q20) plus `unknown`. A new capability
     * arrives with its own migration, the rule the access-grant scope enum follows — never as a
     * free-text value a filter cannot reason about.
     */
    check(
      "gateway_model_catalog_refs_capability_allowed",
      sql`${table.capability} IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')`,
    ),
    check(
      "gateway_model_catalog_refs_source_allowed",
      sql`${table.capabilitySource} IN ('supported_methods', 'none')`,
    ),
  ],
);

/**
 * The catalog fetch log (Bifrost 03.1): one append-only row per completed attempt, successful or
 * not. This is the display the ACs promise — after a failed sync the administrator reads *why*
 * (a fixed `catalog_fetch_*` code, never upstream bytes) and the audit trail answers which
 * snapshot was in force when (`fetched_at`, `config_version`, `raw_item_count`), which is exactly
 * what the price snapshot (03.2) re-checks its mappings against.
 *
 * Failures are recorded beside successes, never over them: the latest row by `fetched_at` is the
 * last attempt's outcome, and the rows before it are the history a reviewer walks. Append-only in
 * the database, not merely in the application — same shape as the rate versions (0128), because a
 * log a process can rewrite answers no question worth asking.
 */
export const gatewayCatalogFetches = pgTable(
  "gateway_catalog_fetches",
  {
    /** Stable, opaque identity of one fetch attempt; never reused. */
    fetchId: text("fetch_id").primaryKey(),
    /** `ok` (the catalog was replaced) or `failed` (nothing was touched). */
    status: text("status").notNull(),
    /** Where the manifest came from — a fixed constant of the catalog module, not a URL to dial. */
    source: text("source").notNull(),
    /** How many raw entries the gateway sent; null for attempts that never got a manifest. */
    rawItemCount: integer("raw_item_count"),
    /** The endpoint configuration version the attempt spoke of, when one was on file. */
    configVersion: integer("config_version"),
    /** For a failure: the fixed, displayable `catalog_fetch_*` reason code. */
    failureReasonCode: text("failure_reason_code"),
    /** When the attempt completed, from the fetcher's clock — the ordering key for "latest". */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    /** When the row itself was written. Distinct from `fetchedAt` for honesty about both. */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "gateway_catalog_fetches_status_allowed",
      sql`${table.status} IN ('ok', 'failed')`,
    ),
    index("gateway_catalog_fetches_fetched_at_idx").on(
      table.fetchedAt.desc(),
      table.fetchId.desc(),
    ),
  ],
);

/**
 * The multi-dimensional price snapshot, versioned and immutable (Bifrost 03.2, AC06/Q11/Q17).
 *
 * Every row is one versioned price basis for one ModelRef cell: the identity is the catalog's
 * own triple plus a per-ref monotonic `snapshot_version`, so the same model name under two
 * providers runs two independent version sequences and can never share — let alone merge — a
 * price. The `dims` column carries ALL billing dimensions of the closed vocabulary the
 * `valid_gateway_price_dims` function enforces: input, output, reasoning, image (in and out),
 * audio (in and out), cache read/write, video and surcharges. A dimension the gateway's
 * manifest does not price is recorded as `{"status":"unknown","reason":"price_dim_*"}` — the
 * database refuses a dims object with a missing key or a numeric/negative amount, so "unknown"
 * can never quietly become 0, and only a known amount of exactly "0" is a price of free.
 *
 * Amounts are decimal *strings*, canonicalized by the mapping (no float ever touches them); a
 * row also names its provenance — the fixed source constant, the catalog fetch that produced it
 * (`fetched_at`, `config_version`) and the conversion-rate version in effect at sync time
 * (`rate_version`, NULL when no rate was configured — an honest gap, not version 0).
 *
 * THE TABLE IS APPEND-ONLY, AND THIS IS WHAT MAKES SETTLEMENT POSSIBLE. A request locks
 * `(ref, snapshot_version)`; admission and settlement must resolve that version to the same
 * dims forever. So any change appends the next version and nothing else: UPDATE, DELETE and —
 * because a row-level trigger cannot see it, the hole migration 0012 closed once already —
 * TRUNCATE are refused by the 0130 triggers, the same shape as the rate versions (0128) and
 * the fetch log (0129).
 */
export const gatewayPriceSnapshots = pgTable(
  "gateway_price_snapshots",
  {
    /** The provider half of the ModelRef identity, as the gateway reports it. */
    provider: text("provider").notNull(),
    /** The model half of the ModelRef identity — everything after the provider prefix. */
    model: text("model").notNull(),
    /** The capability half of the ModelRef identity, from the catalog's closed set. */
    capability: text("capability").notNull(),
    /** Per-ref monotonic version: the first mapped snapshot is 1, every change appends the next. */
    snapshotVersion: integer("snapshot_version").notNull(),
    /** The full dimension map — every dimension present, each known or unknown-with-reason. */
    dims: jsonb("dims").notNull(),
    /**
     * The known/free/unknown classification of `dims` (Bifrost 03.3, AC06): `known` when every
     * wire-priced dimension carries a non-zero-known amount, `free` when they are all exactly
     * zero, `unknown` otherwise. The CHECK `classify_gateway_price_status(dims)` forces the
     * column to be what the dims actually classify to; `free` is a price, not an admission.
     */
    priceStatus: text("price_status").notNull(),
    /** Why the status is unknown, from the classification's fixed reason set; NULL otherwise. */
    priceStatusReason: text("price_status_reason"),
    /**
     * The missing-dimension list for an unknown status — [{dimension, reason}, ...] over the
     * closed vocabularies — the rejection paths display; NULL for known/free.
     */
    priceStatusMissingDims: jsonb("price_status_missing_dims"),
    /** Where the prices came from: the catalog module's fixed source constant, never a URL. */
    source: text("source").notNull(),
    /** The endpoint configuration version the producing fetch spoke for. */
    configVersion: integer("config_version").notNull(),
    /** The conversion-rate version in effect at sync time; NULL when no rate was configured. */
    rateVersion: integer("rate_version"),
    /** When the producing catalog fetch completed — the sync time the ACs name. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    /** When the row itself was written. Distinct from `fetchedAt` for honesty about both. */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /*
     * The versioned identity itself: one cell of provider × model × capability, one monotonic
     * sequence of immutable price bases. Same model name, different provider — two sequences.
     */
    primaryKey({
      columns: [
        table.provider,
        table.model,
        table.capability,
        table.snapshotVersion,
      ],
      name: "gateway_price_snapshots_identity_version_pk",
    }),
    check(
      "gateway_price_snapshots_capability_allowed",
      sql`${table.capability} IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')`,
    ),
    check(
      "gateway_price_snapshots_version_positive",
      sql`${table.snapshotVersion} >= 1`,
    ),
    check(
      "gateway_price_snapshots_rate_version_nonnegative",
      sql`${table.rateVersion} IS NULL OR ${table.rateVersion} >= 0`,
    ),
    /*
     * The full-dims rule, stated in the database: every dimension of the closed vocabulary
     * present, each `known` with a non-negative decimal-string amount or `unknown` with a fixed
     * reason — a missing key or a bare number is a refusal, not a silent zero.
     */
    check(
      "gateway_price_snapshots_dims_valid",
      sql`valid_gateway_price_dims(${table.dims})`,
    ),
    /*
     * The classification (03.3), stated in the database: the status is one of the closed three,
     * unknown alone carries the reason and the missing-dimension list, the list's entries stay
     * inside the closed vocabularies, and the status is exactly what the row's own dims
     * classify to — never a hand-written shortcut around a missing price.
     */
    check(
      "gateway_price_snapshots_status_allowed",
      sql`${table.priceStatus} IN ('known', 'free', 'unknown')`,
    ),
    check(
      "gateway_price_snapshots_status_reason_allowed",
      sql`${table.priceStatusReason} IS NULL OR ${table.priceStatusReason} IN ('price_status_dims_missing', 'price_status_dims_unreadable')`,
    ),
    check(
      "gateway_price_snapshots_status_details_consistent",
      sql`(${table.priceStatus} = 'unknown') = (${table.priceStatusReason} IS NOT NULL) AND (${table.priceStatus} = 'unknown') = (${table.priceStatusMissingDims} IS NOT NULL)`,
    ),
    check(
      "gateway_price_snapshots_status_missing_dims_valid",
      sql`${table.priceStatusMissingDims} IS NULL OR valid_gateway_price_missing_dims(${table.priceStatusMissingDims})`,
    ),
    check(
      "gateway_price_snapshots_status_matches_dims",
      sql`${table.priceStatus} = classify_gateway_price_status(${table.dims})`,
    ),
  ],
);

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
