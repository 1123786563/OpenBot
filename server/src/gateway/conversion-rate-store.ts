/**
 * The administrator's write path for the conversion rate, and `readConversionRate()` — the read
 * 01.4's version lock and 06.5's settlement consume.
 *
 * Storage follows the enterprise settings pattern (`server/src/admin/settings-store.ts`): one row
 * in the generic `enterprise_settings` key-value table, written inside a transaction that ends
 * with a `pg_notify`, so every API server re-reads the moment one of them saves. The row stores
 * the two terms as decimal strings and a monotonic `rateVersion`; 01.4 will grow this into
 * immutable version records, and its starting point is this contract.
 *
 * Validation is not re-implemented here: `save()` runs the input through the same
 * `parseConversionRate()` the process-start path uses, so an administrator's write and a
 * deployment's environment variable cannot disagree about what a legal rate is.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { enterpriseSettings } from "../db/schema";
import {
  type ConversionRate,
  type ConversionRateConfig,
  type ConversionRateIssue,
  type ConversionRateState,
  notConfiguredConversionRateState,
  parseConversionRate,
} from "./conversion-rate";

/** The notify channel every gateway settings write announces on, delivered on commit. */
export const GATEWAY_SETTINGS_TOPIC = "gateway_settings_changed";

const CONVERSION_RATE_KEY = "gateway_conversion_rate";

/** The stored row's shape: terms as decimal strings, so jsonb round-trips stay exact. */
type StoredConversionRate = {
  value: { numerator: string; denominator: string };
  rateVersion: number;
};

/**
 * The version a save continues from, read defensively: a tampered row must not brick the write
 * that repairs it, but a sane version is never rewound. A legal administrator save is the
 * recovery path for a corrupted row — it replaces the value and keeps counting from whatever
 * version the row still carried.
 */
function nextRateVersion(stored: unknown): number {
  const version = (stored as StoredConversionRate | undefined)?.rateVersion;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return 1;
  }
  return version + 1;
}

export type ConversionRateSaveResult =
  | ({ ok: true } & ConversionRateConfig)
  | { ok: false; issues: readonly ConversionRateIssue[] };

export type ConversionRateStore = ReturnType<typeof createConversionRateStore>;

export function createConversionRateStore(deps: {
  database: Database;
  /**
   * The rate the deployment set in `GATEWAY_CREDIT_CONVERSION_RATE`, already validated at start.
   * It is an explicit deployment choice, not a default: it serves reads only until an
   * administrator saves a row, and never silently replaces one.
   */
  environmentRate?: ConversionRate;
}) {
  const { database, environmentRate } = deps;

  const parseStored = (stored: unknown): ConversionRateConfig => {
    const parsed = parseConversionRate(
      (stored as StoredConversionRate | undefined)?.value ?? undefined,
    );
    if (!parsed.ok) {
      throw new Error(
        `The stored conversion rate row "${CONVERSION_RATE_KEY}" is invalid (${parsed.issues
          .map((issue) => issue.message)
          .join(
            "; ",
          )}). Refusing to guess a rate: repair or remove the row before re-enabling billing.`,
      );
    }
    const version = (stored as StoredConversionRate).rateVersion;
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error(
        `The stored conversion rate row "${CONVERSION_RATE_KEY}" has rateVersion ${String(
          version,
        )}, which is not a positive whole number.`,
      );
    }
    return { ...parsed.rate, rateVersion: version };
  };

  return {
    /**
     * The effective rate: an administrator's saved row wins, then the deployment's environment
     * value (rateVersion 0 — it is static, so nothing has ever changed it), and with neither,
     * the explicit "not configured" state. Never a fallback rate.
     */
    async readConversionRate(): Promise<ConversionRateState> {
      const rows = await database
        .select({ value: enterpriseSettings.value })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, CONVERSION_RATE_KEY));
      if (rows.length > 0) {
        return {
          configured: true,
          ...parseStored(rows[0].value),
          source: "admin",
        };
      }
      if (environmentRate) {
        return {
          configured: true,
          ...environmentRate,
          rateVersion: 0,
          source: "environment",
        };
      }
      return notConfiguredConversionRateState();
    },

    /**
     * Validate and persist one administrator write. Illegal input is refused with the reasons and
     * changes nothing; a legal one is stored reduced to lowest terms under a strictly incremented
     * rateVersion, announced on commit.
     */
    async save(input: unknown, by: string): Promise<ConversionRateSaveResult> {
      const parsed = parseConversionRate(input);
      if (!parsed.ok) {
        return { ok: false, issues: parsed.issues };
      }
      const value = {
        value: {
          numerator: parsed.rate.numerator.toString(),
          denominator: parsed.rate.denominator.toString(),
        },
      };
      const rateVersion = await database.transaction(async (tx) => {
        /*
         * Serialize writers on this one key. `SELECT ... FOR UPDATE` alone cannot stop two
         * first-inserts from both computing version 1, because a missing row locks nothing; the
         * transaction-scoped advisory lock closes that gap, and is released even if the
         * transaction dies, so a crashed writer cannot wedge the rate.
         */
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${CONVERSION_RATE_KEY}))`,
        );
        const current = await tx
          .select({ value: enterpriseSettings.value })
          .from(enterpriseSettings)
          .where(eq(enterpriseSettings.key, CONVERSION_RATE_KEY))
          .for("update");
        const next =
          current.length === 0 ? 1 : nextRateVersion(current[0].value);
        await tx
          .insert(enterpriseSettings)
          .values({
            key: CONVERSION_RATE_KEY,
            value: { ...value, rateVersion: next },
            updatedBy: by,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: enterpriseSettings.key,
            set: {
              value: { ...value, rateVersion: next },
              updatedBy: by,
              updatedAt: new Date(),
            },
          });
        await tx.execute(sql`select pg_notify(${GATEWAY_SETTINGS_TOPIC}, '')`);
        return next;
      });
      return {
        ok: true,
        ...parsed.rate,
        rateVersion,
      };
    },
  };
}
