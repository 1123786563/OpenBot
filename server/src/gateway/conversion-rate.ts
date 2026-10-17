/**
 * The gateway's USD→credits conversion rate (Ticket #209, Bifrost 01.3).
 *
 * One number — how many credits one US dollar costs — decides whether billing can be enabled at
 * all, so it is validated like a credential, not like a display setting: no implicit default, no
 * float anywhere, and every refusal names its reason. The same pure parser guards both enforcement
 * paths, process start (`config.ts` reading `BIFROST_CREDITS_PER_USD`) and the admin write path
 * (`gateway/conversion-rate-store.ts`), so the two can never disagree about what a legal rate is.
 *
 * The rate is an exact rational: 1 USD = numerator/denominator credits. Decimals are accepted as
 * input and converted to that form without ever passing through a float, because a rate that
 * drifts in its last digit is a rate that bills the wrong number of credits.
 *
 * Relation to CREDIT_SCALE (billing/credits.ts): the conversion rate maps USD → credits; only
 * after that conversion does CREDIT_SCALE (×100) integerise credits for the ledger. The two scales
 * are independent and must not be conflated into one number.
 */

/** 1 USD = numerator/denominator credits, an exact rational. Never a float. */
export type ConversionRate = { numerator: bigint; denominator: bigint };

/**
 * A conversion rate together with the version it was saved under. `rateVersion` 0 means "read from
 * the boot environment, never admin-saved"; admin saves start at 1 and strictly increment.
 * Ticket 01.4 locks this version per request; 06.5 settlement reads it back.
 */
export type ConversionRateConfig = ConversionRate & { rateVersion: number };

/** How many digits may stand before the decimal point. A magnitude cap, not a storage limit. */
export const CONVERSION_RATE_MAX_INTEGER_DIGITS = 9;
/** How many digits may stand after the decimal point. The precision cap from AC12. */
export const CONVERSION_RATE_MAX_DECIMALS = 6;

export type ConversionRateRejectionReason =
  | "missing"
  | "zero"
  | "negative"
  | "invalid_format"
  | "precision_exceeded"
  | "out_of_range";

export type ConversionRateParseResult =
  | { ok: true; value: ConversionRate }
  | { ok: false; reason: ConversionRateRejectionReason; message: string };

/**
 * Parse and validate a credits-per-USD rate.
 *
 * Accepts a plain decimal such as "7.5" or "500" (surrounding whitespace trimmed, matching how
 * `optional` reads environment values). Rejects, each with its own reason: absent input, zero,
 * negative, more than {@link CONVERSION_RATE_MAX_DECIMALS} decimal places, more than
 * {@link CONVERSION_RATE_MAX_INTEGER_DIGITS} integer digits, and anything that is not a plain
 * decimal number (scientific notation, signs other than a leading minus, separators, other
 * scripts' digits). The zero test works on the parsed integer digits, never on a float.
 */
export function parseConversionRateInput(
  raw: unknown,
): ConversionRateParseResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      reason: "missing",
      message:
        "must be configured to enable billing: 1 USD = X credits, and there is no implicit default",
    };
  }
  const trimmed = raw.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) {
    return {
      ok: false,
      reason: "invalid_format",
      message:
        'must be a plain decimal number such as "7.5" (no scientific notation, signs, separators or other symbols)',
    };
  }
  const [, sign, integerPart, decimalPart = ""] = match;
  if (sign === "-") {
    return {
      ok: false,
      reason: "negative",
      message: "must be positive: a negative rate is not a price",
    };
  }
  if (decimalPart.length > CONVERSION_RATE_MAX_DECIMALS) {
    return {
      ok: false,
      reason: "precision_exceeded",
      message: `has more than ${CONVERSION_RATE_MAX_DECIMALS} decimal places; at most ${CONVERSION_RATE_MAX_DECIMALS} are allowed`,
    };
  }
  const numerator = BigInt(`${integerPart}${decimalPart}`);
  if (numerator === 0n) {
    return {
      ok: false,
      reason: "zero",
      message: "must be positive: zero credits per USD cannot price anything",
    };
  }
  if (integerPart.length > CONVERSION_RATE_MAX_INTEGER_DIGITS) {
    return {
      ok: false,
      reason: "out_of_range",
      message: `has more than ${CONVERSION_RATE_MAX_INTEGER_DIGITS} integer digits; at most ${CONVERSION_RATE_MAX_INTEGER_DIGITS} are allowed`,
    };
  }
  return {
    ok: true,
    value: {
      numerator,
      denominator: 10n ** BigInt(decimalPart.length),
    },
  };
}

/** Whether a rate is configured for the gateway, as downstream tickets need to see it. */
export type ConversionRateReadStatus =
  | {
      configured: false;
      reason: "not_configured" | "invalid";
      detail?: string;
    }
  | {
      configured: true;
      config: ConversionRateConfig;
      savedBy?: string;
      savedAt?: string;
    };

/**
 * Resolve the effective rate: an admin-saved row outranks the boot value; a boot value counts as
 * configured at `rateVersion` 0; nothing at all stays explicitly "not configured" — it never falls
 * back to a guessed rate. A stored row that has become unreadable or non-positive fails closed:
 * billing stays unavailable rather than silently switching back to the boot value, because an
 * administrator's saved intent that cannot be proven must not be replaced by a different number.
 */
export function effectiveConversionRate(
  stored: ConversionRateReadStatus,
  bootRate: ConversionRate | undefined,
): ConversionRateReadStatus {
  if (stored.configured) return stored;
  if (stored.reason === "invalid") return stored;
  if (
    bootRate !== undefined &&
    bootRate.numerator > 0n &&
    bootRate.denominator > 0n
  ) {
    return { configured: true, config: { ...bootRate, rateVersion: 0 } };
  }
  return stored;
}

/**
 * The billing-readiness gate for the conversion rate (consumed by 01.4/01.7 readiness and 06.5
 * settlement): billing is unavailable unless an explicit positive rate is in effect. The gate
 * carries an explainable reason code, never a fallback rate.
 */
export type ConversionRateBillingReadiness =
  | {
      billingEnabled: false;
      reasonCode: "conversion_rate_missing" | "conversion_rate_invalid";
      detail: string;
    }
  | {
      billingEnabled: true;
      rate: ConversionRate;
      rateVersion: number;
    };

export function billingReadiness(
  status: ConversionRateReadStatus,
): ConversionRateBillingReadiness {
  if (status.configured) {
    return {
      billingEnabled: true,
      rate: {
        numerator: status.config.numerator,
        denominator: status.config.denominator,
      },
      rateVersion: status.config.rateVersion,
    };
  }
  return status.reason === "invalid"
    ? {
        billingEnabled: false,
        reasonCode: "conversion_rate_invalid",
        detail:
          "The stored credits-per-USD conversion rate is unreadable or not positive; billing stays disabled until a valid rate is saved.",
      }
    : {
        billingEnabled: false,
        reasonCode: "conversion_rate_missing",
        detail:
          "No credits-per-USD conversion rate is configured (1 USD = X credits); billing stays disabled. There is no implicit default.",
      };
}
