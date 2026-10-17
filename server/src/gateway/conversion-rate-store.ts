/**
 * Persistence for the gateway conversion rate (Ticket #209, Bifrost 01.3).
 *
 * The admin write path. `saveConversionRate` validates with the same pure parser that guards
 * process start (`gateway/conversion-rate.ts`), refuses invalid input before touching the
 * database, and persists the rate as an exact rational: numerator and denominator are stored as
 * decimal strings inside a jsonb value, because a float column would round the very digits this
 * ticket exists to keep.
 *
 * Concurrent saves are serialized by a transaction-scoped advisory lock taken before the read,
 * so every successful save observes the previous committed version and hands out the next one:
 * versions stay unique and strictly increasing no matter how many admins save at once.
 *
 * Storage is a dedicated key in the existing `enterprise_settings` key/value table (the generic
 * jsonb row store), so this ticket adds no migration and no schema change of its own. Ticket 01.4
 * builds the immutable version history on top of this read contract.
 */
import { eq, sql } from "drizzle-orm";
import { ENTERPRISE_TOPIC } from "../admin/settings-store";
import type { Database } from "../db/client";
import { enterpriseSettings } from "../db/schema";
import {
  type ConversionRate,
  type ConversionRateConfig,
  type ConversionRateReadStatus,
  type ConversionRateRejectionReason,
  effectiveConversionRate,
  parseConversionRateInput,
} from "./conversion-rate";

/** The `enterprise_settings` key this module owns. Nothing else writes this row. */
export const CONVERSION_RATE_SETTING_KEY = "gateway_conversion_rate";

/**
 * Advisory-lock key serializing concurrent saves. Transaction-scoped: acquired as the
 * save transaction's first statement and released at commit, so two admins saving at
 * once queue instead of both reading the same previous version and committing the same
 * next one (review F1). Same idiom as memory defaults' check-then-write lock.
 */
const CONVERSION_RATE_SAVE_LOCK_KEY = "openbot:gateway:conversion-rate-save";

type StoredRateValue = {
  numerator: string;
  denominator: string;
  rateVersion: number;
};

/** What `saveConversionRate` returns: the saved config, or the parser's refusal. */
export type SaveConversionRateResult =
  | { ok: true; config: ConversionRateConfig }
  | { ok: false; reason: ConversionRateRejectionReason; message: string };

export async function saveConversionRate(
  database: Database,
  raw: string,
  by: string,
): Promise<SaveConversionRateResult> {
  // Validation first, on the same parser the boot path uses: an invalid rate must not touch the
  // database, and both paths must reach the same conclusion for the same input.
  const parsed = parseConversionRateInput(raw);
  if (!parsed.ok) {
    return parsed;
  }
  return database.transaction(async (tx) => {
    // One writer at a time for this key (review F1): the lock below is held until commit,
    // so the read-compute-write sequence cannot interleave with another save and hand
    // out the same rateVersion twice.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${CONVERSION_RATE_SAVE_LOCK_KEY}))`,
    );
    const [existing] = await tx
      .select()
      .from(enterpriseSettings)
      .where(eq(enterpriseSettings.key, CONVERSION_RATE_SETTING_KEY))
      .limit(1);
    const previous = (
      existing?.value as { value?: StoredRateValue } | undefined
    )?.value;
    const previousVersion =
      typeof previous?.rateVersion === "number" &&
      Number.isInteger(previous.rateVersion) &&
      previous.rateVersion >= 0
        ? previous.rateVersion
        : 0;
    const config: ConversionRateConfig = {
      numerator: parsed.value.numerator,
      denominator: parsed.value.denominator,
      rateVersion: previousVersion + 1,
    };
    const stored: { value: StoredRateValue } = {
      value: {
        numerator: config.numerator.toString(),
        denominator: config.denominator.toString(),
        rateVersion: config.rateVersion,
      },
    };
    const updatedAt = new Date();
    await tx
      .insert(enterpriseSettings)
      .values({
        key: CONVERSION_RATE_SETTING_KEY,
        value: stored,
        updatedBy: by,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: enterpriseSettings.key,
        set: { value: stored, updatedBy: by, updatedAt },
      });
    // Same notify contract as every other enterprise_settings writer: replicas re-read promptly,
    // so a rate change reaches new requests on every server, not just the one that saved it.
    await tx.execute(sql`select pg_notify(${ENTERPRISE_TOPIC}, '')`);
    return { ok: true, config } as const;
  });
}

/**
 * Read the admin-saved row exactly as stored. A row that has become unreadable or non-positive
 * reads as `invalid` — fail closed, billing unavailable — never as a fallback rate.
 */
export async function readStoredConversionRate(
  database: Database,
): Promise<ConversionRateReadStatus> {
  const [row] = await database
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, CONVERSION_RATE_SETTING_KEY))
    .limit(1);
  if (row === undefined) {
    return { configured: false, reason: "not_configured" };
  }
  const value = (row.value as { value?: StoredRateValue } | undefined)?.value;
  const numerator =
    typeof value?.numerator === "string"
      ? digitsToBigInt(value.numerator)
      : undefined;
  const denominator =
    typeof value?.denominator === "string"
      ? digitsToBigInt(value.denominator)
      : undefined;
  const rateVersion = value?.rateVersion;
  if (
    numerator === undefined ||
    denominator === undefined ||
    numerator <= 0n ||
    denominator <= 0n ||
    typeof rateVersion !== "number" ||
    !Number.isInteger(rateVersion) ||
    rateVersion < 0
  ) {
    return {
      configured: false,
      reason: "invalid",
      detail:
        "The stored gateway_conversion_rate row is unreadable or not positive; billing stays disabled until a valid rate is saved.",
    };
  }
  return {
    configured: true,
    config: { numerator, denominator, rateVersion },
    ...(row.updatedBy !== null
      ? { savedBy: row.updatedBy }
      : { savedBy: undefined }),
    ...(row.updatedAt
      ? { savedAt: new Date(row.updatedAt).toISOString() }
      : { savedAt: undefined }),
  };
}

/**
 * The stable read interface for downstream tickets (01.4 version locking, 01.7 readiness, 06.5
 * settlement): the effective rate is the admin-saved row, else the validated boot value at
 * rateVersion 0, else explicitly not configured. Never a fallback rate.
 */
export async function readConversionRate(
  database: Database,
  bootRate?: ConversionRate,
): Promise<ConversionRateReadStatus> {
  return effectiveConversionRate(
    await readStoredConversionRate(database),
    bootRate,
  );
}

function digitsToBigInt(raw: string): bigint | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  return BigInt(raw);
}
