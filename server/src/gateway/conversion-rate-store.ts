/**
 * The administrator's write path for the conversion rate, and `readConversionRate()` — the read
 * 01.4's version lock and 06.5's settlement consume.
 *
 * Storage follows the enterprise settings pattern (`server/src/admin/settings-store.ts`): the
 * *current* version is the `gateway_conversion_rate` row in the generic `enterprise_settings`
 * key-value table, written inside a transaction that ends with a `pg_notify`, so every API server
 * re-reads the moment one of them saves. Since 01.4 every save also appends the same version to
 * the append-only `gateway_rate_versions` table — the record requests resolve against by time
 * (`rateVersionAt`) and by number (`readRateVersion`), which is what makes a change reach only
 * requests admitted after it (Q14/Q19, ADR 0003). The row stores the two terms as decimal
 * strings so jsonb round-trips stay exact.
 *
 * Validation is not re-implemented here: `save()` runs the input through the same
 * `parseConversionRate()` the process-start path uses, so an administrator's write and a
 * deployment's environment variable cannot disagree about what a legal rate is.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { enterpriseSettings, gatewayRateVersions } from "../db/schema";
import {
  CONVERSION_RATE_NOT_CONFIGURED_EXPLANATION,
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

/**
 * One recorded version: the unit the ticket names — version number, the moment it took effect,
 * the exact rational and the operator who recorded it. Rows are append-only in the database
 * (migration 0128's triggers refuse UPDATE, DELETE and TRUNCATE), so a record read back today is
 * the record that was written, and a request that locked this version settles with exactly this
 * value no matter how many changes followed.
 */
export type RateVersionRecord = {
  rateVersion: number;
  numerator: bigint;
  denominator: bigint;
  effectiveAt: Date;
  recordedBy: string;
};

/**
 * The answer to "which rate version was in effect at this moment?" — the one resolution both
 * admission and settlement call, so they can never disagree. Before the first administrator
 * version the truth is the deployment's environment rate (version 0: static by definition, so a
 * fact about configuration rather than a recorded event), or — if there was never one — the
 * honest statement that no rate was configured at that moment and no settlement can be priced
 * from it.
 */
export type RateVersionResolution =
  | ({ resolved: true; source: "admin" } & RateVersionRecord)
  | ({ resolved: true; source: "environment"; rateVersion: 0 } & ConversionRate)
  | {
      resolved: false;
      reason: "not_configured";
      explanation: string;
    };

/**
 * The lock contract's read side: resolve one specific version number to its recorded value.
 * Admission stores the version it resolved (`rateVersionAt`); settlement reads the same number
 * here and gets the same exact value, because versions are immutable. Version 0 resolves to the
 * environment rate; a number nobody recorded resolves as not-found — never to a neighbor's value.
 */
export type LockedRateVersion =
  | ({ found: true; source: "environment"; rateVersion: 0 } & ConversionRate)
  | ({ found: true; source: "admin" } & RateVersionRecord)
  | { found: false; reason: "not_found" | "not_configured" };

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

  /**
   * One recorded version row, validated before it is served. A row can only get here through
   * `save()`'s validator, so a value that fails to parse means the history was tampered with at
   * the database — the same loud refusal the pointer row gets, for the same reason: a guessed or
   * silently-dropped version would misprice every settlement that resolves through it.
   */
  const parseVersionRow = (row: {
    rateVersion: number;
    numerator: string;
    denominator: string;
    effectiveAt: Date;
    recordedBy: string;
  }): RateVersionRecord => {
    const version = row.rateVersion;
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error(
        `The recorded conversion rate version ${String(
          version,
        )} is not a positive whole number; the version history has been tampered with.`,
      );
    }
    const parsed = parseConversionRate({
      numerator: row.numerator,
      denominator: row.denominator,
    });
    if (!parsed.ok) {
      throw new Error(
        `The recorded conversion rate version ${String(version)} is invalid (${parsed.issues
          .map((issue) => issue.message)
          .join(
            "; ",
          )}). Refusing to guess a rate: repair the version history before resolving against it.`,
      );
    }
    return {
      rateVersion: version,
      numerator: parsed.rate.numerator,
      denominator: parsed.rate.denominator,
      effectiveAt: row.effectiveAt,
      recordedBy: row.recordedBy,
    };
  };

  /** The next version number: the pointer's count never rewinds, and recorded history is never re-used. */
  const nextVersionNumber = async (
    tx: Parameters<Parameters<typeof database.transaction>[0]>[0],
  ): Promise<number> => {
    const current = await tx
      .select({ value: enterpriseSettings.value })
      .from(enterpriseSettings)
      .where(eq(enterpriseSettings.key, CONVERSION_RATE_KEY))
      .for("update");
    const fromPointer =
      current.length === 0 ? 1 : nextRateVersion(current[0].value);
    // The pointer is mutable configuration and may be absent; recorded history is immutable and
    // its greatest version is never re-used. Continuing from the greatest of both is what keeps
    // a pointerless deployment from colliding with its own past (the primary key would refuse,
    // and a save that fails is a change the operator did not get).
    const maxRows = await tx
      .select({
        max: sql<number | null>`max(${gatewayRateVersions.rateVersion})`,
      })
      .from(gatewayRateVersions);
    const maxRecorded = maxRows[0]?.max;
    const fromHistory =
      maxRecorded === null || maxRecorded === undefined
        ? 1
        : Number(maxRecorded) + 1;
    return Math.max(fromPointer, fromHistory);
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
     * changes nothing; a legal one is appended to the immutable version history under a strictly
     * incremented rateVersion, and the pointer row — the separately-marked current version — is
     * moved to it. Both happen in one transaction announced on commit.
     *
     * The append is the change; the pointer is only a marker. Nothing ever updates or removes a
     * recorded version (the database refuses those statements outright), so a request that
     * resolved to version N keeps resolving to version N's exact value forever — which is the
     * property settlement relies on when it prices a request admitted before a later change.
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
         * transaction dies, so a crashed writer cannot wedge the rate. The version row is
         * written inside the same critical section, so concurrent saves get adjacent numbers
         * and — because the insert's effective time is the statement time of the statement that
         * runs only after the lock is held — version order and effective-time order can never
         * disagree.
         */
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${CONVERSION_RATE_KEY}))`,
        );
        const next = await nextVersionNumber(tx);
        await tx.insert(gatewayRateVersions).values({
          rateVersion: next,
          numerator: parsed.rate.numerator.toString(),
          denominator: parsed.rate.denominator.toString(),
          recordedBy: by,
        });
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

    /**
     * The version in effect at `requestTime` — the query admission and settlement share.
     * Admission calls it with the current moment and locks the answer's version number;
     * settlement calls it with the request's admission moment and must get the same version
     * back, which immutability guarantees. With no administrator version yet in effect, the
     * deployment's environment rate was what requests were priced with (version 0), and with
     * neither, no rate existed at that moment — answered honestly rather than guessed.
     */
    async rateVersionAt(requestTime: Date): Promise<RateVersionResolution> {
      const rows = await database
        .select({
          rateVersion: gatewayRateVersions.rateVersion,
          numerator: gatewayRateVersions.numerator,
          denominator: gatewayRateVersions.denominator,
          effectiveAt: gatewayRateVersions.effectiveAt,
          recordedBy: gatewayRateVersions.recordedBy,
        })
        .from(gatewayRateVersions)
        .where(sql`${gatewayRateVersions.effectiveAt} <= ${requestTime}`)
        .orderBy(
          sql`${gatewayRateVersions.effectiveAt} desc`,
          sql`${gatewayRateVersions.rateVersion} desc`,
        )
        .limit(1);
      if (rows.length > 0) {
        return {
          resolved: true,
          source: "admin",
          ...parseVersionRow(rows[0]),
        };
      }
      if (environmentRate) {
        return {
          resolved: true,
          source: "environment",
          rateVersion: 0,
          numerator: environmentRate.numerator,
          denominator: environmentRate.denominator,
        };
      }
      return {
        resolved: false,
        reason: "not_configured",
        explanation: CONVERSION_RATE_NOT_CONFIGURED_EXPLANATION,
      };
    },

    /**
     * One specific version's recorded value — the read side of the lock contract. A settled
     * request carries the version its admission resolved; this is how the same request prices
     * itself with the same exact rational after any number of later changes. Version 0 is the
     * environment rate when one is configured; anything else that was never recorded is
     * not-found, never a neighbor's value.
     */
    async readRateVersion(rateVersion: number): Promise<LockedRateVersion> {
      if (rateVersion === 0) {
        if (!environmentRate) {
          return { found: false, reason: "not_configured" };
        }
        return {
          found: true,
          source: "environment",
          rateVersion: 0,
          numerator: environmentRate.numerator,
          denominator: environmentRate.denominator,
        };
      }
      const rows = await database
        .select({
          rateVersion: gatewayRateVersions.rateVersion,
          numerator: gatewayRateVersions.numerator,
          denominator: gatewayRateVersions.denominator,
          effectiveAt: gatewayRateVersions.effectiveAt,
          recordedBy: gatewayRateVersions.recordedBy,
        })
        .from(gatewayRateVersions)
        .where(eq(gatewayRateVersions.rateVersion, rateVersion))
        .limit(1);
      if (rows.length === 0) {
        return { found: false, reason: "not_found" };
      }
      return { found: true, source: "admin", ...parseVersionRow(rows[0]) };
    },
  };
}
