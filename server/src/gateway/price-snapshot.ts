/**
 * The multi-dimensional price snapshot (Bifrost 03.2, AC06/Q11/Q17).
 *
 * ONE REF, ONE VERSIONED PRICE BASIS. A snapshot is the full pricing of one ModelRef cell —
 * the identity the catalog already fixed (03.1) — at one `snapshot_version`. The same model
 * name under two providers is two cells with two version sequences; nothing here merges them,
 * and the primary key on (provider, model, capability, snapshot_version) is that rule stated
 * twice.
 *
 * EVERY DIMENSION, PRESENT OR UNKNOWN. The closed dimension vocabulary below covers the
 * billing dimensions the parent spec names — input, output, image, audio, cache, surcharge —
 * plus the ones the wire schema prices (reasoning) or the roadmap reserves (video, image
 * output). Mapping walks the gateway's `pricing` object (the exact bytes 03.1 kept in
 * `raw_entry`; core/schemas/models.go `Pricing`) field by field, and a dimension no upstream
 * field prices is recorded as `unknown` *with the fixed reason it is unknown* — never as 0,
 * because Bifrost's own missing-price paths compute zero cost and strict billing must not
 * inherit that. Only a known amount of exactly "0" is a price of free; that distinction is
 * what 03.3's known/free/unknown classification reads.
 *
 * EXACT DECIMALS, NEVER FLOATS. An amount is the decimal string the gateway sent, taken
 * through canonical decimal surgery (strip redundant zeros) and never through `parseFloat` —
 * a JSON *number* in the pricing object has already been through float parsing, so it is
 * refused as `price_dim_unreadable` rather than laundered. The database CHECK re-refuses
 * negative, exponential or non-string amounts, so "the stored value is exact" holds in the
 * database, not merely in this file.
 *
 * IMMUTABLE, VERSIONED, RESOLVABLE. The table is append-only in the database (0130's triggers
 * refuse UPDATE, DELETE and TRUNCATE). A sync that finds changed dims appends the next version
 * for that ref and touches nothing else; an unchanged sync appends nothing — a version is a
 * price change, not a clock tick. Requests lock `(ref, snapshotVersion)`; settlement resolves
 * the same version forever, and `latestPriceSnapshot` is what a gate reads.
 *
 * WHO CALLS THIS. 03.3 classifies per-dim known/free/unknown from the dims map, 03.4 runs
 * `syncFromCatalog()` on its five-minute cadence and after its own manual trigger, 03.7 opens
 * scopes only over refs whose snapshot prices completely, and 06.1's reserve path locks the
 * snapshotVersion it admitted against.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Logger } from "../../../shared/logger";
import { getLogger } from "../../../shared/logger";
import type { Database } from "../db/client";
import { gatewayPriceSnapshots } from "../db/schema";
import {
  assertPriceStatusColumns,
  assertPriceStatusColumnsMatchDims,
  classifyPriceDims,
  type PriceClassification,
  priceStatusColumns,
  type PriceStatusMissingDimension,
} from "./price-status";
import {
  type CatalogStoredRef,
  type ModelCapability,
  type ModelRef,
  MODEL_CAPABILITIES,
  GATEWAY_CATALOG_SOURCE,
} from "./catalog";
import { createConversionRateStore } from "./conversion-rate-store";
import type { ConversionRate } from "./conversion-rate";

/**
 * The closed billing-dimension vocabulary. A new member arrives with its own migration — the
 * rule the capability enum and the access-grant scopes follow — never as a free-text key a
 * reader cannot reason about. The unit is fixed by the vocabulary, not per row: the mapping
 * knows what each upstream field is denominated in, and a snapshot carries amounts only.
 */
export const PRICE_DIMENSIONS = [
  /** USD per input token — the gateway's `pricing.prompt`. */
  "input",
  /** USD per output token — the gateway's `pricing.completion`. */
  "output",
  /** USD per reasoning token — the gateway's `pricing.internal_reasoning`. */
  "reasoning",
  /** USD per input image — the gateway's `pricing.image`. */
  "image",
  /** USD per output image; the v1 wire carries no field for it (reserved, ticket 12.1). */
  "image_output",
  /** USD per audio input second; the v1 wire carries no field for it (reserved, tickets 13.x/14.x). */
  "audio_input",
  /** USD per audio output second; the v1 wire carries no field for it (reserved, ticket 13.x). */
  "audio_output",
  /** USD per cache-read token — the gateway's `pricing.input_cache_read`. */
  "cache_read",
  /** USD per cache-write token — the gateway's `pricing.input_cache_write`. */
  "cache_write",
  /** USD per video second; the v1 wire carries no field for it (reserved, tickets 19.x). */
  "video",
  /** USD per server-side web-search request — the gateway's `pricing.web_search`. */
  "surcharge_web_search",
  /** USD flat per billed request — the gateway's `pricing.request`. */
  "surcharge_per_request",
] as const;

export type PriceDimension = (typeof PRICE_DIMENSIONS)[number];

/** What one dimension's amount is denominated in — fixed by the vocabulary, shown by surfaces. */
export const PRICE_DIMENSION_UNITS: Record<PriceDimension, string> = {
  input: "USD per input token",
  output: "USD per output token",
  reasoning: "USD per reasoning token",
  image: "USD per input image",
  image_output: "USD per output image",
  audio_input: "USD per audio input second",
  audio_output: "USD per audio output second",
  cache_read: "USD per cache-read token",
  cache_write: "USD per cache-write token",
  video: "USD per video second",
  surcharge_web_search: "USD per web-search request",
  surcharge_per_request: "USD per billed request",
};

/** Why a dimension is unknown. Fixed codes; safe to show on any screen. */
export type PriceDimensionUnknownReason =
  /** The manifest's pricing object carries no field for this dimension. */
  | "price_dim_no_source"
  /** A field was present, but it is not an exact non-negative decimal string. */
  | "price_dim_unreadable";

export const PRICE_DIM_UNKNOWN_REASONS = [
  "price_dim_no_source",
  "price_dim_unreadable",
] as const satisfies readonly PriceDimensionUnknownReason[];

/** One dimension's state: an exact known amount, or unknown with the reason it is unknown. */
export type PriceDimState =
  | { status: "known"; amount: string }
  | { status: "unknown"; reason: PriceDimensionUnknownReason };

/** The full dimension map: every dimension of the vocabulary is present, always. */
export type PriceSnapshotDims = { readonly [D in PriceDimension]: PriceDimState };

/** The fixed source a snapshot carries: the catalog's own constant, never a URL. */
export const GATEWAY_PRICE_SNAPSHOT_SOURCE = GATEWAY_CATALOG_SOURCE;

const DECIMAL_SHAPE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Canonicalize one exact decimal string: strip redundant leading and trailing zeros. Pure
 * string surgery — never `parseFloat`, never `Number`, because either would turn the one thing
 * this ticket exists to preserve (exactness) into an approximation. "1.500" and "1.5" and "1"
 * are one value and must compare equal, or a re-sync would mint versions over spelling.
 */
export function canonicalPriceAmount(
  value: unknown,
): { ok: true; amount: string } | { ok: false } {
  if (typeof value !== "string") return { ok: false };
  const match = DECIMAL_SHAPE.exec(value);
  if (!match) return { ok: false };
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return { ok: true, amount: fraction === "" ? whole : `${whole}.${fraction}` };
}

/**
 * The wire field each dimension maps from, on the gateway's `pricing` object. The Go
 * struct `Pricing` (core/schemas/models.go, verified at the pinned upstream commit) spells
 * each JSON key after its field: reasoning's field `InternalReasoning` emits
 * `"internal_reasoning"` — the wire is what this module reads, and the wire says so.
 */
const WIRE_SOURCES: Readonly<Record<PriceDimension, string>> = {
  input: "prompt",
  output: "completion",
  reasoning: "internal_reasoning",
  image: "image",
  image_output: "not_on_wire_v1",
  audio_input: "not_on_wire_v1",
  audio_output: "not_on_wire_v1",
  cache_read: "input_cache_read",
  cache_write: "input_cache_write",
  video: "not_on_wire_v1",
  surcharge_web_search: "web_search",
  surcharge_per_request: "request",
};

/** Dimensions the v1 wire schema has no field for; they are unknown until the wire grows one. */
const NO_WIRE_SOURCE: ReadonlySet<PriceDimension> = new Set(
  PRICE_DIMENSIONS.filter(
    (dimension) => WIRE_SOURCES[dimension] === "not_on_wire_v1",
  ),
);

/**
 * The dimensions the v1 wire can price — the necessary set 03.3's classification demands
 * (input, output, reasoning, image, cache read/write and the two surcharges). A dimension
 * outside this set has no wire field at all in v1, for every model equally: a protocol-level
 * gap, not one model's missing price, so it does not block known/free. The set is derived
 * here, in the vocabulary's own module, so the wire schema stays the single source of truth
 * both the mapping and the classification read.
 */
export const WIRE_PRICED_DIMENSIONS: readonly PriceDimension[] =
  PRICE_DIMENSIONS.filter((dimension) => !NO_WIRE_SOURCE.has(dimension));

/**
 * Map one catalog entry's raw upstream entry to the full dimension map. Pure: no database, no
 * network, no clock — the fixture tests in `tests/price-snapshot.test.ts` pin every rule named
 * here. Every dimension of the vocabulary is present in the answer; nothing is ever 0 by
 * default.
 */
export function mapPriceDims(rawEntry: Record<string, unknown>): PriceSnapshotDims {
  const pricing =
    rawEntry.pricing !== null &&
    typeof rawEntry.pricing === "object" &&
    !Array.isArray(rawEntry.pricing)
      ? (rawEntry.pricing as Record<string, unknown>)
      : undefined;

  const dims = {} as Record<PriceDimension, PriceDimState>;
  for (const dimension of PRICE_DIMENSIONS) {
    if (NO_WIRE_SOURCE.has(dimension) || pricing === undefined) {
      dims[dimension] = { status: "unknown", reason: "price_dim_no_source" };
      continue;
    }
    const raw = pricing[WIRE_SOURCES[dimension]];
    if (raw === undefined) {
      // The field simply is not on this entry: nothing was claimed, so nothing is priced.
      dims[dimension] = { status: "unknown", reason: "price_dim_no_source" };
      continue;
    }
    const canonical = canonicalPriceAmount(raw);
    dims[dimension] = canonical.ok
      ? { status: "known", amount: canonical.amount }
      : { status: "unknown", reason: "price_dim_unreadable" };
  }
  return dims;
}

/**
 * Re-validate a dims object against the closed vocabulary — the application's half of the
 * database CHECK (0130's `valid_gateway_price_dims`), applied on write AND on read so a
 * tampered row fails loudly instead of pricing anything. A dims object that misses a
 * dimension, or records unknown-with-an-amount, is a defect, not data.
 */
export function assertPriceSnapshotDims(
  value: unknown,
  where: string,
): PriceSnapshotDims {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${where}: dims is not an object.`);
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (
    keys.length !== PRICE_DIMENSIONS.length ||
    !PRICE_DIMENSIONS.every((dimension) => dimension in raw)
  ) {
    throw new TypeError(
      `${where}: dims must carry exactly the closed dimension set (${PRICE_DIMENSIONS.join(", ")}).`,
    );
  }
  const dims = {} as Record<PriceDimension, PriceDimState>;
  for (const dimension of PRICE_DIMENSIONS) {
    const entry = raw[dimension];
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      throw new TypeError(`${where}: dims.${dimension} is not an object.`);
    }
    const state = entry as Record<string, unknown>;
    if (state.status === "known") {
      const canonical = canonicalPriceAmount(state.amount);
      if (!("amount" in state) || !canonical.ok || "reason" in state) {
        throw new TypeError(
          `${where}: dims.${dimension} is known but its amount is not an exact non-negative decimal string.`,
        );
      }
      dims[dimension] = { status: "known", amount: canonical.amount };
      continue;
    }
    if (state.status === "unknown") {
      if (
        !PRICE_DIM_UNKNOWN_REASONS.includes(
          state.reason as PriceDimensionUnknownReason,
        ) ||
        "amount" in state
      ) {
        throw new TypeError(
          `${where}: dims.${dimension} is unknown but does not carry exactly a fixed reason.`,
        );
      }
      dims[dimension] = {
        status: "unknown",
        reason: state.reason as PriceDimensionUnknownReason,
      };
      continue;
    }
    throw new TypeError(
      `${where}: dims.${dimension} status must be "known" or "unknown".`,
    );
  }
  return dims;
}

/**
 * Canonical JSON for change detection: the database's jsonb does not preserve key order, so
 * "did the prices change" is asked over a serialization with sorted keys — otherwise every
 * read-back would look changed and mint versions over nothing.
 */
function canonicalDimsJson(dims: PriceSnapshotDims): string {
  const ordered: Record<string, unknown> = {};
  for (const dimension of PRICE_DIMENSIONS) {
    const state = dims[dimension];
    ordered[dimension] =
      state.status === "known"
        ? { amount: state.amount, status: state.status }
        : { reason: state.reason, status: state.status };
  }
  return JSON.stringify(ordered);
}

/** One versioned price snapshot, read or built (the contract the downstream tickets consume). */
export type PriceSnapshot = {
  ref: ModelRef;
  snapshotVersion: number;
  dims: PriceSnapshotDims;
  /**
   * The known/free/unknown classification of THESE dims (03.3), bound to this
   * `snapshotVersion` — the invocability input 03.8's capability filter, 06.2's reserve
   * re-verification and 07.6's bound evidence read. `unknown` is never a zero cost and
   * `free` is a price, not an admission; see `gateway/price-status.ts`.
   */
  classification: PriceClassification;
  /** When the producing catalog fetch completed — the sync time the ACs name. ISO 8601. */
  fetchedAt: string;
  /** The fixed source constant — never a URL. */
  source: string;
  /** The endpoint configuration version the producing fetch spoke for. */
  configVersion: number;
  /** The conversion-rate version in effect at sync time; null when no rate was configured. */
  rateVersion: number | null;
};

/** What a sync hands the store: a mapped dims object plus the provenance to record with it. */
export type PriceSnapshotAppendInput = {
  ref: ModelRef;
  dims: PriceSnapshotDims;
  fetchedAt: string;
  source: string;
  configVersion: number;
  rateVersion: number | null;
};

/** Where price snapshots persist; tests may supply their own. */
export type GatewayPriceSnapshotStore = {
  /**
   * Append the next version for every ref whose dims changed; skip the rest. One transaction
   * under the store's advisory lock, so two concurrent syncs serialize and every change lands
   * exactly once — a half-written price sync would be a tear between two price bases.
   */
  appendSnapshots(
    inputs: readonly PriceSnapshotAppendInput[],
  ): Promise<{ appended: number; skipped: number }>;
  /** The newest version for one ref, or undefined before the first sync. */
  latestPriceSnapshot(ref: ModelRef): Promise<PriceSnapshot | undefined>;
  /** One recorded version, forever identical to what admission locked. */
  priceSnapshot(
    ref: ModelRef,
    snapshotVersion: number,
  ): Promise<PriceSnapshot | undefined>;
  /** The newest version of every recorded ref. */
  listLatestPriceSnapshots(): Promise<PriceSnapshot[]>;
};

type SnapshotRow = {
  provider: string;
  model: string;
  capability: string;
  snapshotVersion: number;
  dims: unknown;
  priceStatus: string;
  priceStatusReason: string | null;
  priceStatusMissingDims: unknown;
  source: string;
  configVersion: number;
  rateVersion: number | null;
  fetchedAt: Date;
};

/** Strict read of one stored row; a damaged row is a thrown defect, never a guessed price. */
function priceSnapshotFromRow(row: SnapshotRow): PriceSnapshot {
  if (!MODEL_CAPABILITIES.includes(row.capability as ModelCapability)) {
    throw new TypeError(
      `The stored price snapshot for ${row.provider}/${row.model} carries capability "${row.capability}", which is outside the closed set; the table has been tampered with.`,
    );
  }
  if (!Number.isSafeInteger(row.snapshotVersion) || row.snapshotVersion < 1) {
    throw new TypeError(
      `The stored price snapshot for ${row.provider}/${row.model} carries snapshot version ${String(row.snapshotVersion)}, which is not a positive whole number.`,
    );
  }
  if (row.rateVersion !== null && (row.rateVersion < 0 || !Number.isSafeInteger(row.rateVersion))) {
    throw new TypeError(
      `The stored price snapshot for ${row.provider}/${row.model} carries rate version ${String(row.rateVersion)}, which is neither null nor a non-negative whole number.`,
    );
  }
  const dims = assertPriceSnapshotDims(
    row.dims,
    `The stored price snapshot ${row.provider}/${row.model}@${row.snapshotVersion}`,
  );
  // The persisted status columns must agree with the dims they were persisted beside — the
  // database CHECK (0134) enforces it on write; this re-checks it on read, so a row written
  // around both layers fails loudly instead of pricing anything.
  const where = `The stored price snapshot ${row.provider}/${row.model}@${row.snapshotVersion}`;
  const storedStatus = assertPriceStatusColumns(
    {
      priceStatus: row.priceStatus,
      priceStatusReason: row.priceStatusReason,
      priceStatusMissingDimensions: row.priceStatusMissingDims,
    },
    where,
  );
  assertPriceStatusColumnsMatchDims(dims, storedStatus, where);
  return {
    ref: {
      provider: row.provider,
      model: row.model,
      capability: row.capability as ModelCapability,
    },
    snapshotVersion: row.snapshotVersion,
    dims,
    classification: classifyPriceDims(dims),
    fetchedAt: row.fetchedAt.toISOString(),
    source: row.source,
    configVersion: row.configVersion,
    rateVersion: row.rateVersion,
  };
}

/**
 * The snapshot store over `gateway_price_snapshots` — the sibling pattern of the catalog and
 * rate-version stores. Version numbers are handed out inside one transaction under the
 * advisory lock, so concurrent syncs get adjacent numbers and no two syncs can hand one
 * version to two different price bases.
 */
export function createEnterpriseGatewayPriceSnapshotStore(
  database: Database,
): GatewayPriceSnapshotStore {
  const selection = {
    provider: gatewayPriceSnapshots.provider,
    model: gatewayPriceSnapshots.model,
    capability: gatewayPriceSnapshots.capability,
    snapshotVersion: gatewayPriceSnapshots.snapshotVersion,
    dims: gatewayPriceSnapshots.dims,
    priceStatus: gatewayPriceSnapshots.priceStatus,
    priceStatusReason: gatewayPriceSnapshots.priceStatusReason,
    priceStatusMissingDims: gatewayPriceSnapshots.priceStatusMissingDims,
    source: gatewayPriceSnapshots.source,
    configVersion: gatewayPriceSnapshots.configVersion,
    rateVersion: gatewayPriceSnapshots.rateVersion,
    fetchedAt: gatewayPriceSnapshots.fetchedAt,
  };

  return {
    async appendSnapshots(inputs) {
      // Deterministic order, so a sync's statements land in one repeatable sequence.
      const ordered = [...inputs].sort((a, b) =>
        `${a.ref.provider}|${a.ref.model}|${a.ref.capability}`.localeCompare(
          `${b.ref.provider}|${b.ref.model}|${b.ref.capability}`,
        ),
      );
      let appended = 0;
      let skipped = 0;
      await database.transaction(async (tx) => {
        // Serialize syncs on this one name (the rate store's rule): `SELECT ... FOR UPDATE`
        // cannot stop two first-inserts from both computing version 1, because a missing row
        // locks nothing. The transaction-scoped lock is released even if the transaction dies.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('gateway_price_snapshots'))`,
        );
        for (const input of ordered) {
          // The store re-checks what the mapping promised: the full dims set, exact decimals.
          // A defect fails the whole sync inside the transaction — never half a price basis.
          const dims = assertPriceSnapshotDims(
            input.dims,
            `The snapshot append for ${input.ref.provider}/${input.ref.model}/${input.ref.capability}`,
          );
          if (!MODEL_CAPABILITIES.includes(input.ref.capability)) {
            throw new TypeError(
              `The snapshot append for ${input.ref.provider}/${input.ref.model} carries capability "${input.ref.capability}", which is outside the closed set.`,
            );
          }
          const [latest] = await tx
            .select({
              snapshotVersion: gatewayPriceSnapshots.snapshotVersion,
              dims: gatewayPriceSnapshots.dims,
            })
            .from(gatewayPriceSnapshots)
            .where(
              and(
                eq(gatewayPriceSnapshots.provider, input.ref.provider),
                eq(gatewayPriceSnapshots.model, input.ref.model),
                eq(gatewayPriceSnapshots.capability, input.ref.capability),
              ),
            )
            .orderBy(desc(gatewayPriceSnapshots.snapshotVersion))
            .limit(1);
          if (latest !== undefined) {
            const stored = assertPriceSnapshotDims(
              latest.dims,
              `The stored price snapshot ${input.ref.provider}/${input.ref.model}@${latest.snapshotVersion}`,
            );
            if (canonicalDimsJson(stored) === canonicalDimsJson(dims)) {
              // A version is a price change, not a clock tick: unchanged prices keep their
              // version, and the history stays a record of changes.
              skipped += 1;
              continue;
            }
          }
          const nextVersion = (latest?.snapshotVersion ?? 0) + 1;
          // The classification is derived HERE, from the canonicalized dims, and never taken
          // from the caller: a version's status cannot drift from its own price basis.
          const statusColumns = priceStatusColumns(classifyPriceDims(dims));
          await tx.insert(gatewayPriceSnapshots).values({
            provider: input.ref.provider,
            model: input.ref.model,
            capability: input.ref.capability,
            snapshotVersion: nextVersion,
            /*
             * The dims go through a raw SQL wrapper deliberately: the Bun SQL driver encodes
             * parameters jsonb-first — a JS *string* param arrives quoted and lands as a jsonb
             * string scalar, which the table's CHECK rightly refuses. The object itself arrives
             * as a real object, so the stored dims are the dims the CHECK validated.
             */
            dims: sql`${dims}` as unknown as PriceSnapshotDims,
            priceStatus: statusColumns.priceStatus,
            priceStatusReason: statusColumns.priceStatusReason,
            /*
             * Same jsonb surgery as the dims, plus two driver traps: a JS array in an `sql`
             * template expands into a parameter TUPLE, and a JS string param arrives already
             * typed as a jsonb STRING scalar (the `::jsonb` cast alone would keep the quotes).
             * `::text::jsonb` is correct under both encodings — the text is read, then parsed
             * into the array the CHECK validates.
             */
            priceStatusMissingDims:
              statusColumns.priceStatusMissingDimensions === null
                ? null
                : (sql`${JSON.stringify(statusColumns.priceStatusMissingDimensions)}::text::jsonb` as unknown as readonly PriceStatusMissingDimension[]),
            source: input.source,
            configVersion: input.configVersion,
            rateVersion: input.rateVersion,
            fetchedAt: new Date(input.fetchedAt),
          });
          appended += 1;
        }
      });
      return { appended, skipped };
    },

    async latestPriceSnapshot(ref) {
      const [row] = await database
        .select(selection)
        .from(gatewayPriceSnapshots)
        .where(
          and(
            eq(gatewayPriceSnapshots.provider, ref.provider),
            eq(gatewayPriceSnapshots.model, ref.model),
            eq(gatewayPriceSnapshots.capability, ref.capability),
          ),
        )
        .orderBy(desc(gatewayPriceSnapshots.snapshotVersion))
        .limit(1);
      return row === undefined ? undefined : priceSnapshotFromRow(row);
    },

    async priceSnapshot(ref, snapshotVersion) {
      const [row] = await database
        .select(selection)
        .from(gatewayPriceSnapshots)
        .where(
          and(
            eq(gatewayPriceSnapshots.provider, ref.provider),
            eq(gatewayPriceSnapshots.model, ref.model),
            eq(gatewayPriceSnapshots.capability, ref.capability),
            eq(gatewayPriceSnapshots.snapshotVersion, snapshotVersion),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : priceSnapshotFromRow(row);
    },

    async listLatestPriceSnapshots() {
      // DISTINCT ON keeps one row per ref — the newest, by the primary key's version order.
      const rows = await database
        .selectDistinctOn([
          gatewayPriceSnapshots.provider,
          gatewayPriceSnapshots.model,
          gatewayPriceSnapshots.capability,
        ], selection)
        .from(gatewayPriceSnapshots)
        .orderBy(
          gatewayPriceSnapshots.provider,
          gatewayPriceSnapshots.model,
          gatewayPriceSnapshots.capability,
          desc(gatewayPriceSnapshots.snapshotVersion),
        );
      return rows.map(priceSnapshotFromRow);
    },
  };
}

/** Why a price sync failed. Fixed codes of this module — displayable anywhere. */
export type PriceSnapshotSyncFailureReasonCode =
  | "price_sync_catalog_unavailable"
  | "price_sync_rate_unavailable"
  | "price_sync_persist_failed";

/** What {@link GatewayPriceSnapshotService.syncFromCatalog} answers — never a throw. */
export type PriceSnapshotSyncOutcome =
  | {
      status: "ok";
      /** Refs the last-good catalog held when the sync ran. */
      mappedRefs: number;
      /** Refs whose dims changed and got a new version. */
      appended: number;
      /** Refs whose dims matched their latest version and got nothing new. */
      skipped: number;
      syncedAt: string;
    }
  | {
      status: "failed";
      reasonCode: PriceSnapshotSyncFailureReasonCode;
      failedAt: string;
    };

export type GatewayPriceSnapshotDeps = {
  /** The last-good catalog entries with their raw upstream bytes — 03.1's read. */
  listCatalogEntries: () => Promise<CatalogStoredRef[]>;
  store: GatewayPriceSnapshotStore;
  /**
   * The conversion-rate version in effect right now, or null when no rate is configured — the
   * sync records what existed, and never guesses a zero.
   */
  readRateVersion: () => Promise<number | null>;
  /** Injectable clock for tests. */
  now?: () => Date;
  log?: Logger;
};

export type GatewayPriceSnapshotService = {
  /**
   * Map every last-good catalog entry to its dimension map and append what changed. A failed
   * sync is an outcome with a fixed reason code — the last versions stay exactly as they were,
   * which is what makes "the price basis a request locked" a promise kept.
   */
  syncFromCatalog: () => Promise<PriceSnapshotSyncOutcome>;
  /** The newest snapshot for one ref — what a gate or a picker reads. */
  latestPriceSnapshot: (
    ref: ModelRef,
  ) => Promise<PriceSnapshot | undefined>;
  /** One recorded version — what settlement resolves against. */
  priceSnapshot: (
    ref: ModelRef,
    snapshotVersion: number,
  ) => Promise<PriceSnapshot | undefined>;
  /** The newest snapshot of every recorded ref. */
  listLatestPriceSnapshots: () => Promise<PriceSnapshot[]>;
};

export function createGatewayPriceSnapshotService(
  deps: GatewayPriceSnapshotDeps,
): GatewayPriceSnapshotService {
  const log = deps.log ?? getLogger("server");
  const now = deps.now ?? (() => new Date());

  const failed = (
    reasonCode: PriceSnapshotSyncFailureReasonCode,
  ): PriceSnapshotSyncOutcome => ({
    status: "failed",
    reasonCode,
    failedAt: now().toISOString(),
  });

  return {
    async syncFromCatalog(): Promise<PriceSnapshotSyncOutcome> {
      let entries: CatalogStoredRef[];
      try {
        entries = await deps.listCatalogEntries();
      } catch (error) {
        log.error(
          {
            type: "gateway-price-sync-catalog-unavailable",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The last-good catalog could not be read, so no price snapshot was mapped.",
        );
        return failed("price_sync_catalog_unavailable");
      }

      let rateVersion: number | null;
      try {
        rateVersion = await deps.readRateVersion();
      } catch (error) {
        log.error(
          {
            type: "gateway-price-sync-rate-unavailable",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The conversion-rate state could not be read, so no price snapshot was mapped.",
        );
        return failed("price_sync_rate_unavailable");
      }

      try {
        const { appended, skipped } = await deps.store.appendSnapshots(
          entries.map((entry) => ({
            ref: entry.ref,
            dims: mapPriceDims(entry.rawEntry),
            fetchedAt: entry.fetchedAt,
            source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
            configVersion: entry.configVersion,
            rateVersion,
          })),
        );
        if (appended > 0) {
          log.info(
            {
              type: "gateway-price-sync-appended",
              mappedRefs: entries.length,
              appended,
              skipped,
            },
            "The price sync appended new snapshot versions.",
          );
        }
        return {
          status: "ok",
          mappedRefs: entries.length,
          appended,
          skipped,
          syncedAt: now().toISOString(),
        };
      } catch (error) {
        log.error(
          {
            type: "gateway-price-sync-persist-failed",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The mapped price snapshots could not be persisted; the previous versions are kept.",
        );
        return failed("price_sync_persist_failed");
      }
    },

    latestPriceSnapshot(ref) {
      return deps.store.latestPriceSnapshot(ref);
    },

    priceSnapshot(ref, snapshotVersion) {
      return deps.store.priceSnapshot(ref, snapshotVersion);
    },

    listLatestPriceSnapshots() {
      return deps.store.listLatestPriceSnapshots();
    },
  };
}

/**
 * Install the running price snapshot service, from the wiring that holds the deployment
 * configuration. Internal consumers read it back through {@link gatewayPriceSnapshotControls};
 * `undefined` uninstalls (tests). The five-minute cadence and the administrator's manual
 * trigger install and call it — 03.4/03.5's tickets.
 */
let installed: GatewayPriceSnapshotService | undefined;

export function installGatewayPriceSnapshotService(
  service: GatewayPriceSnapshotService | undefined,
) {
  installed = service;
}

/** The running price snapshot service, or undefined in a process that never installed one. */
export function gatewayPriceSnapshotControls():
  | GatewayPriceSnapshotService
  | undefined {
  return installed;
}

/**
 * The rate version in effect right now, or null when no rate is configured — the read a
 * service's `readRateVersion` dep is wired with. The environment rate is the caller's to pass:
 * it lives in the deployment configuration's scope (the same value the readiness gate is wired
 * with), and a store built without it would honestly answer "not configured" and silently
 * misreport which rate basis existed.
 */
export async function readCurrentRateVersion(
  database: Database,
  environmentRate?: ConversionRate,
): Promise<number | null> {
  const state = await createConversionRateStore({
    database,
    environmentRate,
  }).readConversionRate();
  return state.configured ? state.rateVersion : null;
}
