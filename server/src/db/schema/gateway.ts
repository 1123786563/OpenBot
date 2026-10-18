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
import type { GatewayCustomerSubjectKind } from "../../gateway/customer";
import { accessGrants } from "./access-grants";

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

/**
 * The OpenBot side of the gateway Customer association — 05.1's (#242) table,
 * evolved in place by 05.2's (#243) migration 0135 (never rebuilt).
 *
 * One row per subject (the same { kind, payer_id } pair the payer accounts use)
 * recording the gateway Customer that carries it and — decisively for 05.2 —
 * HOW FAR the association has been confirmed:
 *
 * - `pending`:     a create was issued and no outcome is on file yet. A crash
 *                  between the insert and the outcome write lands here.
 * - `recoverable`: the remote outcome is unknown — the create may or may not
 *                  have landed. The next provisioning call MUST look the
 *                  subject up by its stable correlation key before creating.
 * - `confirmed`:   the local row and the remote subject agree. Recovery and
 *                  reservation adoption write this spelling.
 * - `active`:      05.1's own spelling of the same fact — a complete
 *                  association whose remote id is on file, written by 05.1's
 *                  provisioning inserts. The value stays legal because that
 *                  seam keeps running against this table; readers normalize
 *                  it to `confirmed` instead of rewriting applied rows.
 *
 * The correlation key (`external_reference`) rides with the create request and
 * is the handle recovery looks the remote subject up by. It is a stored
 * generation of `gateway_customer_name` (= payerKey, 05.1's deterministic
 * remote name): the generation IS the backfill of 05.1's existing rows, and it
 * keeps 05.1's insert — which names no reference — working unmodified. The
 * unique indexes make the database, not a read-check, the arbiter: one row per
 * subject, one per remote id, one per name, one per reference.
 *
 * The association is a mapping and nothing more: no balance, no grant and no
 * virtual key is born, moved or copied here.
 */
export const gatewayCustomers = pgTable(
  "gateway_customers",
  {
    id: text("id").primaryKey(),
    /** The subject kind this mapping names. 05.1 provisions personal users only. */
    kind: text("kind").$type<GatewayCustomerSubjectKind>().notNull(),
    /** The subject's own stable id (the OpenBot user id). */
    payerId: text("payer_id").notNull(),
    /**
     * The id the gateway generated for the Customer, or null while no outcome
     * is on file (pending/recoverable reservations — 0135 dropped the NOT
     * NULL). 05.1's rows all carry one and are untouched.
     */
    gatewayCustomerId: text("gateway_customer_id"),
    /** The deterministic gateway-side name (= payerKey), the recovery lookup key. */
    gatewayCustomerName: text("gateway_customer_name").notNull(),
    /**
     * The stable correlation key the create carries and recovery looks up:
     * generated from the name, so no writer can drift from the derivation.
     */
    externalReference: text("external_reference")
      .generatedAlwaysAs(sql`gateway_customer_name`)
      .notNull(),
    /** How far the association has been confirmed; see the table comment. */
    provisionState: text("provision_state")
      .$type<"pending" | "confirmed" | "recoverable" | "active">()
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "gateway_customers_kind_check",
      sql`${table.kind} IN ('personal')`,
    ),
    check(
      "gateway_customers_provision_state_check",
      sql`${table.provisionState} IN ('pending', 'confirmed', 'recoverable', 'active')`,
    ),
    // One mapping per subject — the index a concurrent provisioning burst races into.
    uniqueIndex("gateway_customers_subject_unique_idx").on(
      table.kind,
      table.payerId,
    ),
    // One gateway Customer belongs to at most one subject; NULLs (reservations)
    // are distinct in a PostgreSQL unique index, so 05.1's index stands as-is.
    uniqueIndex("gateway_customers_remote_id_unique_idx").on(
      table.gatewayCustomerId,
    ),
    // One deterministic name is held by at most one row — the uniqueness the
    // name-based recovery stands on.
    uniqueIndex("gateway_customers_remote_name_unique_idx").on(
      table.gatewayCustomerName,
    ),
    // One correlation key is held by at most one row — 05.2's recovery arbiter.
    uniqueIndex("gateway_customers_external_reference_unique_idx").on(
      table.externalReference,
    ),
  ],
);

/**
 * The administrator's model open scope (Bifrost 03.7, AC10/Q4/Q17).
 *
 * THE CATALOG EXISTING IS NOT THE MODEL BEING OPEN. This table holds every
 * ModelRef cell an administrator has explicitly acted on, with the state that
 * action left (`open` or `closed`) and the reason they recorded. A ref with
 * no row here has never been opened — which is exactly the default a sync
 * must arrive at: a newly synced model widens nothing until an administrator
 * says so (Q17: 同步不自动扩大管理员开放范围), so absence of a row is the
 * closed state, not an oversight.
 *
 * THE TABLE HOLDS THE CURRENT STATE ONLY. Every open and close also writes an
 * audit row (`gateway.model_scope_changed`, with the previous state and the
 * reason), so the history lives in the append-only audit trail where nobody
 * can rewrite it; this table stays the cheap current-state read
 * `isModelOpen` resolves against. Re-opening, re-closing and reason updates
 * are ordinary writes — each one audited — because a reason an administrator
 * corrected is itself a fact worth keeping the old row of.
 *
 * SCOPE CHANGES ARE ADMISSION-BOUND, NEVER RETROSPECTIVE. Writing here touches
 * nothing else: the price snapshots a request locked stay resolvable forever
 * (03.2's append-only table), and live reservations are untouched — a close
 * refuses new selections and new admissions only (AC10).
 */
export const gatewayModelOpenScopes = pgTable(
  "gateway_model_open_scopes",
  {
    /** The provider half of the ModelRef identity, exactly as the catalog holds it. */
    provider: text("provider").notNull(),
    /** The model half — everything after the provider prefix, slashes included. */
    model: text("model").notNull(),
    /** The capability half, from the catalog's closed set. */
    capability: text("capability").notNull(),
    /** The state the administrator's latest action left: `open` or `closed`. */
    state: text("state").notNull(),
    /** The reason the administrator recorded — the displayable why for users and auditors. */
    reason: text("reason").notNull(),
    /** Who made the latest change — the operator's email (the audit row carries the user id). */
    changedBy: text("changed_by").notNull(),
    /** When the latest change was made. Statement time, so two racing saves still order truthfully. */
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp()`),
    /** When the row itself was last written. Distinct from `changedAt` for honesty about both. */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /*
     * The identity is the catalog's own triple: one cell, one current state.
     */
    primaryKey({
      columns: [table.provider, table.model, table.capability],
      name: "gateway_model_open_scopes_identity_pk",
    }),
    check(
      "gateway_model_open_scopes_state_allowed",
      sql`${table.state} IN ('open', 'closed')`,
    ),
    check(
      "gateway_model_open_scopes_capability_allowed",
      sql`${table.capability} IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')`,
    ),
  ],
);

/**
 * The catalog sync's own state — the singleton row Bifrost 03.4 keeps between
 * runs (AC10, design Q17: 失败保留最后成功快照；连续失败次数与原因可查询).
 *
 * ONE ROW, DELIBERATELY MUTABLE. Every attempt's detail already has its own
 * append-only home — the fetch log (03.1) and the versioned price snapshots
 * (03.2) — so this row is not a log and must not pretend to be one: it is the
 * pointer a status surface reads, the same shape the conversion rate's
 * `enterprise_settings` row keeps before 0128's history table. A failed sync
 * increments `consecutive_failures` in the same statement that records the
 * reason (an atomic `+1`, so two syncs racing the row cannot lose a count),
 * and a success zeroes it, moves `last_successful_sync_at` and clears the
 * failure columns — "last success" survives failures untouched because the
 * success statement is the only writer of that column.
 *
 * The failure reason is a fixed code of the two producer layers
 * (`catalog_fetch_*` / `price_sync_*`), never a message: no upstream bytes, no
 * address, no credential — displayable on any screen (03.5's result, 01.8's
 * status, 03.10's picker).
 */
export const gatewayCatalogSyncState = pgTable(
  "gateway_catalog_sync_state",
  {
    /** The singleton row's fixed id — one sync state per deployment. */
    id: text("id").primaryKey(),
    /** When the last fully successful sync (catalog AND prices) completed. */
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", {
      withTimezone: true,
    }),
    /** Failures in a row since the last success; zeroed by the next success. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Why the last attempt failed — a fixed code, present iff it failed. */
    lastFailureReasonCode: text("last_failure_reason_code"),
    /** When the last failure was classified. */
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    /** When the last attempt of any outcome completed — the status surface's "tried at". */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /** The last attempt's outcome, when there was one. */
    lastAttemptStatus: text("last_attempt_status"),
    /** When this row was last written. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "gateway_catalog_sync_state_failures_nonnegative",
      sql`${table.consecutiveFailures} >= 0`,
    ),
    check(
      "gateway_catalog_sync_state_attempt_status_allowed",
      sql`${table.lastAttemptStatus} IS NULL OR ${table.lastAttemptStatus} IN ('ok', 'failed')`,
    ),
    /*
     * A recorded failure carries exactly its reason and moment — a failure
     * without a displayable reason is a status screen's dead end, and a reason
     * without the failure it belongs to is a lie the next success forgot to
     * clear.
     */
    check(
      "gateway_catalog_sync_state_failure_details_consistent",
      sql`(${table.lastAttemptStatus} = 'failed') = (${table.lastFailureReasonCode} IS NOT NULL) AND (${table.lastAttemptStatus} = 'failed') = (${table.lastFailureAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * The user's model preference layers (Bifrost 03.9, AC09/design Q16).
 *
 * ONE TABLE, THREE LAYERS. The natural key `(user_id, scope, bot_id, conversation_id)`
 * holds one cell per identity: `global` is the user's default everywhere, `bot` their
 * default for one Bot, `conversation` one session's selection. Resolution reads the
 * three cells and answers the most specific one that exists — 越具体越优先 — and a
 * cell a user never wrote is simply absent: no preference is the honest default, not
 * an inherited guess. An overwrite is an ordinary upsert of exactly its own cell, so
 * a conversation selection can never rewrite what `global` or `bot` say (the isolation
 * the AC demands is the key shape itself).
 *
 * THE IDENTITY COLUMNS LIE TO NO ONE. The coarser a scope, the shorter its identity,
 * and the empty string marks the part a scope does not name — enforced by CHECK so no
 * writer, present or future, can store a `bot` row that names a conversation or a
 * `global` row that silently belongs to one Bot. Nothing here decides whether a ref
 * may be chosen: the write path (03.9's service) validates against 03.8's selectable
 * list before it ever reaches this table, and resolution answers what is stored —
 * availability gating stays with the caller (Q16: 不可用时报错, 第一版不自动换模型).
 */
export const gatewayModelPreferences = pgTable(
  "gateway_model_preferences",
  {
    /** The OpenBot user the preference belongs to — the layers are per-user, never per-tenant. */
    userId: text("user_id").notNull(),
    /** Which layer the row is: `global`, `bot` or `conversation`. */
    scope: text("scope").notNull(),
    /** The Bot the layer names. `''` for `global`, which names no Bot. */
    botId: text("bot_id").notNull(),
    /** The conversation the layer names. `''` for everything coarser than `conversation`. */
    conversationId: text("conversation_id").notNull(),
    /** The provider half of the chosen ModelRef, exactly as the catalog holds it. */
    provider: text("provider").notNull(),
    /** The model half — everything after the provider prefix, slashes included. */
    model: text("model").notNull(),
    /** The capability half, from the catalog's closed set. */
    capability: text("capability").notNull(),
    /** When this preference was last written. Statement time, so racing upserts order truthfully. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp()`),
    /** When the row itself was last written. Distinct from `updatedAt` for honesty about both. */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /*
     * One cell per identity: an overwrite is an upsert of exactly this key, and
     * the layers cannot collide because a scope's shorter identity is a strict
     * prefix shape of the key, never an alias of a more specific row.
     */
    primaryKey({
      columns: [table.userId, table.scope, table.botId, table.conversationId],
      name: "gateway_model_preferences_identity_pk",
    }),
    check(
      "gateway_model_preferences_scope_allowed",
      sql`${table.scope} IN ('global', 'bot', 'conversation')`,
    ),
    check(
      "gateway_model_preferences_capability_allowed",
      sql`${table.capability} IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')`,
    ),
    /*
     * The scope's identity shape: `global` names neither a Bot nor a conversation,
     * `bot` names exactly a Bot, `conversation` names exactly a Bot and a session.
     */
    check(
      "gateway_model_preferences_scope_identity_consistent",
      sql`(${table.scope} = 'global' AND ${table.botId} = '' AND ${table.conversationId} = '') OR (${table.scope} = 'bot' AND ${table.botId} <> '' AND ${table.conversationId} = '') OR (${table.scope} = 'conversation' AND ${table.botId} <> '' AND ${table.conversationId} <> '')`,
    ),
  ],
);

/**
 * The key states a short-lived virtual key record can sit in (Bifrost 05.3/#244). A closed set,
 * because status is read by revocation (05.7) and the state sync (05.8): a value nobody shipped
 * must not be storable, so a new state arrives with its own ticket and migration — the same rule
 * the grant's status check follows.
 */
export const GATEWAY_VIRTUAL_KEY_STATUSES = [
  "active",
  "expired",
  "revoked",
] as const;

/** One of the closed key states; see {@link GATEWAY_VIRTUAL_KEY_STATUSES}. */
export type GatewayVirtualKeyStatus = (typeof GATEWAY_VIRTUAL_KEY_STATUSES)[number];

/**
 * The OpenBot side of the short-lived virtual key record — Bifrost 05.3's (#244) local ledger
 * of what was issued for which authorization (CONTEXT.md: Virtual Key, credentialVersion).
 *
 * ONE ROW PER ISSUANCE, NEVER A SECRET. The plaintext key value exists exactly once — in the
 * issuance response to the authenticated Bot (the channel 05.4 wraps in the CredentialBundle) —
 * and only at the gateway. This table holds the sha256 of that value (`value_hash`, the same
 * no-plaintext discipline `bot_binding_offers.code_hash` keeps), so a database read can identify
 * a key and can never redeem one. Every issuance of the same grant is a NEW credentialVersion
 * (per-grant, starting at 1, monotonic — the unique index is the concurrency arbiter): a secret
 * that is never stored cannot be re-served, so re-claiming is re-issuing, and the previous
 * version's state stays as the lifecycle tickets (05.7/05.8) leave it.
 *
 * A RECORD, NOTHING MORE. No budget is born here and none is copied: all of a person's keys
 * carry the SAME `gateway_customer_id` (05.1's mapping), and spending is governed by that
 * customer at the gateway — issuing adds no credit grant, no ledger row, no payer account.
 * The key's own provider/budget governance is deliberately absent from the create (the customer
 * owns it); `expires_at` records the expiry the key was minted under (05.5: every mint
 * carries a term — the deployment-configured TTL, 15 minutes by default; null only on
 * records written before 05.5 or by a composition that explicitly minted termless keys), and `status` is what this deployment believes — 05.8 syncs it against
 * the gateway's own state.
 */
export const gatewayVirtualKeys = pgTable(
  "gateway_virtual_keys",
  {
    /** Stable, opaque, referenced by 05.8's sync and 05.10's revoke-all. */
    id: text("id").primaryKey(),
    /** The authorization this key was issued for (04.5's stable id); issuance verifies it active. */
    grantId: text("grant_id")
      .notNull()
      .references(() => accessGrants.grantId),
    /** The Bot the credential proved when claiming — the "× Bot" half of the key's identity. */
    botId: text("bot_id").notNull(),
    /** The one customer this key bills: 05.1's mapping id, shared by all of the user's keys. */
    gatewayCustomerId: text("gateway_customer_id").notNull(),
    /** The gateway's own virtual key id — what 05.8's sync addresses remotely. */
    gatewayVirtualKeyId: text("gateway_virtual_key_id").notNull(),
    /** sha256 of the plaintext value, hex. Identification, never recovery; no plaintext column exists. */
    valueHash: text("value_hash").notNull(),
    /** Per-grant monotonic version, starting at 1; see the table comment. */
    credentialVersion: integer("credential_version").notNull(),
    /** What this deployment believes about the key; 05.8 keeps it true. */
    status: text("status")
      .$type<GatewayVirtualKeyStatus>()
      .notNull()
      .default("active"),
    /** The expiry the key was minted under (05.5's term); null only on pre-05.5 records. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The version counter's arbiter: two racing issuances of one grant cannot hold one version.
    uniqueIndex("gateway_virtual_keys_grant_version_unique_idx").on(
      table.grantId,
      table.credentialVersion,
    ),
    // One remote key is named by at most one record — the drift 05.8 reconciles stays countable.
    uniqueIndex("gateway_virtual_keys_remote_id_unique_idx").on(
      table.gatewayVirtualKeyId,
    ),
    // The questions 05.10's revoke-all and the per-customer views ask.
    index("gateway_virtual_keys_bot_idx").on(table.botId),
    index("gateway_virtual_keys_customer_idx").on(table.gatewayCustomerId),
    check(
      "gateway_virtual_keys_status_check",
      sql`${table.status} IN ('active', 'expired', 'revoked')`,
    ),
    check(
      "gateway_virtual_keys_version_check",
      sql`${table.credentialVersion} >= 1`,
    ),
  ],
);

/**
 * The key state sync's own state — the singleton row Bifrost 05.8 (#249) keeps between
 * runs (AC11, design Q18: 同步失败保留上次成功状态并记录原因；最后成功同步时间可查询).
 *
 * The sibling of the catalog sync's row (0137), for the same reasons: every attempt's
 * detail has its own home — each drift lands as an audit event naming the key, the flip
 * and the fixed reason — so this row is the pointer a status read answers, not a log. A
 * failed sync increments `consecutive_failures` in the same statement that records the
 * reason (an atomic `+1`, so two syncs racing the row cannot lose a count), and a success
 * zeroes it, moves `last_successful_sync_at` and clears the failure columns. The failure
 * reason is a fixed `gateway_key_sync_*` code — never upstream bytes, never an address —
 * displayable on any surface.
 */
export const gatewayKeySyncState = pgTable(
  "gateway_key_sync_state",
  {
    /** The singleton row's fixed id — one key state sync per deployment. */
    id: text("id").primaryKey(),
    /** When the last fully successful sync completed. */
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", {
      withTimezone: true,
    }),
    /** Failures in a row since the last success; zeroed by the next success. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Why the last attempt failed — a fixed code, present iff it failed. */
    lastFailureReasonCode: text("last_failure_reason_code"),
    /** When the last failure was classified. */
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    /** When the last attempt of any outcome completed — the status read's "tried at". */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /** The last attempt's outcome, when there was one. */
    lastAttemptStatus: text("last_attempt_status"),
    /** When this row was last written. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "gateway_key_sync_state_failures_nonnegative",
      sql`${table.consecutiveFailures} >= 0`,
    ),
    check(
      "gateway_key_sync_state_attempt_status_allowed",
      sql`${table.lastAttemptStatus} IS NULL OR ${table.lastAttemptStatus} IN ('ok', 'failed')`,
    ),
    /*
     * A recorded failure carries exactly its reason and moment — the same
     * consistency the catalog sync's row enforces, for the same reason.
     */
    check(
      "gateway_key_sync_state_failure_details_consistent",
      sql`(${table.lastAttemptStatus} = 'failed') = (${table.lastFailureReasonCode} IS NOT NULL) AND (${table.lastAttemptStatus} = 'failed') = (${table.lastFailureAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * The sync's drift list — the append-only record of every key a sync flipped
 * (Bifrost 05.8, Produces contract: 同步结果记录……差异清单).
 *
 * The sibling of the catalog sync's fetch log (03.1): the state row above is
 * the pointer between runs, this table is the per-attempt detail. One row per
 * flipped key per run, written in the SAME transaction as the flip itself, so
 * the list and the statuses can never disagree; rows are never updated or
 * deleted — a drift observed twice is two rows, and the history is the point.
 * `reason_code` is one of the three fixed observation codes, `to_status` one
 * of the two unavailability states — a sync can only move a key TOWARD
 * unavailability (Q18: the sync direction is gateway → local, and from a
 * gateway state change no authorization is derived), so the closed sets are
 * the whole truth the writer can express.
 */
export const gatewayKeySyncDrift = pgTable(
  "gateway_key_sync_drift",
  {
    /** Stable, opaque row id. */
    id: text("id").primaryKey(),
    /** The local key record that flipped (`gateway_virtual_keys.id`). */
    keyId: text("key_id").notNull(),
    /** The authorization the key was issued for, carried for the reads that ask "whose". */
    grantId: text("grant_id").notNull(),
    /** The Bot half of the key's identity, carried for the same reads. */
    botId: text("bot_id").notNull(),
    /** The gateway's own id the observation was made against. */
    gatewayVirtualKeyId: text("gateway_virtual_key_id").notNull(),
    /** What the local record said before the flip; always `active` — see the table comment. */
    fromStatus: text("from_status").notNull(),
    /** What the sync set it to; the two unavailability states, never `active`. */
    toStatus: text("to_status").notNull(),
    /** Why the sync flipped it — a fixed observation code, displayable anywhere. */
    reasonCode: text("reason_code").notNull(),
    /** When the observation was made (the sync's clock, not statement time, so a replay names the run). */
    driftedAt: timestamp("drifted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // The questions "what happened to this key" and "what drifted lately" ask.
    index("gateway_key_sync_drift_key_idx").on(table.keyId),
    index("gateway_key_sync_drift_drifted_at_idx").on(table.driftedAt),
    check(
      "gateway_key_sync_drift_from_status_check",
      sql`${table.fromStatus} = 'active'`,
    ),
    check(
      "gateway_key_sync_drift_to_status_check",
      sql`${table.toStatus} IN ('revoked', 'expired')`,
    ),
    check(
      "gateway_key_sync_drift_reason_code_check",
      sql`${table.reasonCode} IN ('gateway_key_deleted', 'gateway_key_disabled', 'gateway_key_expired')`,
    ),
  ],
);

/**
 * Which key field drifted, as the sync observed it (Bifrost 05.9): the owner the key
 * bills (customer), the access scope it answers to, or the term it lives under. A closed
 * set — the whole truth the detector can express; a new field arrives with its own
 * comparison and its own code, never a widening of these.
 */
export const GATEWAY_KEY_FIELD_DRIFT_REASON_CODES = [
  "gateway_key_owner_changed",
  "gateway_key_scope_changed",
  "gateway_key_term_changed",
] as const;

/** One of the closed field-drift codes; see {@link GATEWAY_KEY_FIELD_DRIFT_REASON_CODES}. */
export type GatewayKeyFieldDriftReasonCode =
  (typeof GATEWAY_KEY_FIELD_DRIFT_REASON_CODES)[number];

/**
 * The human decisions a drift disposition can carry (Bifrost 05.9): `accepted` — the
 * operator reviewed the mismatch and the grant resumes; `key_revoked` — the operator
 * declares the drifted key dead, and the local record retires it. A closed set: a new
 * decision arrives with its own semantics, never a reinterpretation of these.
 */
export const GATEWAY_KEY_DRIFT_DECISIONS = [
  "accepted",
  "key_revoked",
] as const;

/** One of the closed disposition decisions; see {@link GATEWAY_KEY_DRIFT_DECISIONS}. */
export type GatewayKeyDriftDecision = (typeof GATEWAY_KEY_DRIFT_DECISIONS)[number];

/**
 * The field-drift events (Bifrost 05.9, #250): the record of every key whose OWNER, SCOPE
 * or TERM at the gateway no longer matches the local record, and the human disposition of
 * each. The sibling of 05.8's availability list (`gateway_key_sync_drift`), for the drifts
 * that are NOT unavailability: a key moved to another Customer still works — it just bills
 * someone else, which is worse.
 *
 * THE ROW IS THE VERDICT AND ITS ANSWER. The observation columns (which key, whose grant,
 * both sides of every mismatched field) are written once when the sync detects the drift
 * and never change. The disposition columns start null and are filled exactly once by a
 * human decision (see {@link gatewayKeyDriftEvents}' checks): while `disposed_at` is null
 * the event is OUTSTANDING, and an outstanding event on a grant pauses that grant's
 * issuance and renewal — the pause is not a flag anywhere else, it IS the absence of a
 * disposition. The partial unique index on `(key_id, reason_code) WHERE disposed_at IS
 * NULL` is the one-outstanding-event rule: re-observations of the same mismatch do not
 * stack rows, and after a disposition a persisting mismatch re-detects on the next sync —
 * the verdict re-arms against a truth that did not change.
 */
export const gatewayKeyDriftEvents = pgTable(
  "gateway_key_drift_events",
  {
    /** Stable, opaque row id. */
    id: text("id").primaryKey(),
    /** The local key record the mismatch was observed on (`gateway_virtual_keys.id`). */
    keyId: text("key_id").notNull(),
    /** The authorization the key was issued for — the unit the pause applies to. */
    grantId: text("grant_id").notNull(),
    /** The Bot half of the key's identity, carried for the reads that ask "whose". */
    botId: text("bot_id").notNull(),
    /** The gateway's own id the observation was made against. */
    gatewayVirtualKeyId: text("gateway_virtual_key_id").notNull(),
    /** The owner the local record believes this key bills (05.1's mapping id). */
    localCustomerId: text("local_customer_id").notNull(),
    /** Which field drifted — one of the three fixed codes below. */
    reasonCode: text("reason_code")
      .$type<GatewayKeyFieldDriftReasonCode>()
      .notNull(),
    /** The owner the gateway answered with, when the drift is about ownership. */
    remoteCustomerId: text("remote_customer_id"),
    /** The term the local record carries (null on pre-05.5 records). */
    localExpiresAt: timestamp("local_expires_at", { withTimezone: true }),
    /** The term the gateway answered with, when the drift is about the term. */
    remoteExpiresAt: timestamp("remote_expires_at", { withTimezone: true }),
    /** When the sync observed the mismatch (the sync's clock, not statement time). */
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    /** The human decision, once made: acknowledge, or retire the drifted key. */
    disposition: text("disposition").$type<GatewayKeyDriftDecision>(),
    /** When the decision was recorded; null exactly while the event is outstanding. */
    disposedAt: timestamp("disposed_at", { withTimezone: true }),
    /** Who disposed of the event (the administrator actor id). */
    disposedBy: text("disposed_by"),
    /** The operator's optional note, carried with the decision. */
    dispositionNote: text("disposition_note"),
  },
  (table) => [
    // The questions "what drifted for this key/grant" and "what is still outstanding" ask.
    index("gateway_key_drift_events_key_idx").on(table.keyId),
    index("gateway_key_drift_events_grant_idx").on(table.grantId),
    index("gateway_key_drift_events_detected_at_idx").on(table.detectedAt),
    // The one-outstanding-event rule: a key carries at most one undisposed event per
    // reason, so re-syncs cannot stack rows and a post-disposition re-detection is a
    // NEW verdict, not an edit of the old one.
    uniqueIndex("gateway_key_drift_events_outstanding_unique_idx")
      .on(table.keyId, table.reasonCode)
      .where(sql`${table.disposedAt} IS NULL`),
    check(
      "gateway_key_drift_events_reason_code_check",
      sql`${table.reasonCode} IN ('gateway_key_owner_changed', 'gateway_key_scope_changed', 'gateway_key_term_changed')`,
    ),
    check(
      "gateway_key_drift_events_disposition_check",
      sql`${table.disposition} IS NULL OR ${table.disposition} IN ('accepted', 'key_revoked')`,
    ),
    // A disposed event carries exactly its decision, its moment and its actor; an
    // outstanding one carries none of them.
    check(
      "gateway_key_drift_events_disposition_consistent",
      sql`(${table.disposition} IS NULL) = (${table.disposedAt} IS NULL) AND (${table.disposition} IS NULL) = (${table.disposedBy} IS NULL)`,
    ),
  ],
);

/**
 * The gateway connection configuration, one singleton row (`id = 'default'`).
 *
 * Ported from the issue5-207-2 checkpoint (b5 wave-1 gateway endpoint config, ticket #207) so the
 * archived gateway/config-store.ts + gateway/endpoint.ts sources typecheck against the integrated
 * tree. Not yet wired into the runtime route mounting; the `gateway_configs` table is created by a
 * future migration when the seam is wired (see integration record 2026-10-18 round 2).
 */
export const gatewayConfigs = pgTable("gateway_configs", {
  id: text("id").primaryKey(),
  baseUrl: text("base_url").notNull(),
  requestTimeoutMs: integer("request_timeout_ms").notNull().default(10_000),
  configVersion: integer("config_version").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
