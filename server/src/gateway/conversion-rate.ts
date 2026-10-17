/**
 * The USD→credits conversion rate: one exact rational, configured explicitly, never defaulted.
 *
 * This is the deployment's own exchange between what providers charge in dollars and what the
 * credit ledger spends (Q9). It is *not* a model's per-token credit price (`BILLING_MODEL_CREDIT_RATES`
 * owns that) and it is *not* the ledger's internal scale: `CREDIT_SCALE` in `server/src/billing/credits.ts`
 * keeps one credit as 100 stored integer units so ledger amounts are never floats, while this rate
 * converts 1 USD into `numerator / denominator` credits. The two compose — dollar cost × rate ×
 * CREDIT_SCALE gives stored units — and both halves stay in exact integer arithmetic.
 *
 * Because the rate prices real money, it refuses everything it cannot represent exactly:
 *
 * - No implicit default. An unconfigured rate means billing is not enabled (`ConversionRateState`),
 *   which `billingAdmission` turns into the refusal every paid model capability checks (Q19).
 * - Zero and negative terms are refused — a zero rate makes every dollar free, a negative one is
 *   meaningless, and a zero denominator is not a number.
 * - Each term is capped at 15 decimal digits (`MAX_CONVERSION_RATE_TERM`): that is already
 *   quadrillion-scale precision for a per-dollar exchange, and an unbounded term count would make
 *   "legal" mean "whatever bigint happens to parse".
 * - The rate's *value* is capped at 21474836.47 credits per USD: the ledger's amounts are 32-bit
 *   integers at CREDIT_SCALE 100, so a single dollar that costs more credits than the ledger can
 *   hold can never be settled. Compared by cross-multiplication, still exact.
 * - Input must be a JSON object `{ "numerator": "100", "denominator": "1" }` with whole-number
 *   strings (or JSON safe integers). Decimal points, exponents and every other spelling are
 *   refused, so no value is ever read through a float (Q14).
 *
 * This module is deliberately pure — no database, no billing imports — because `server/src/config.ts`
 * runs it at process start and must not import the read modules. It is the single validator both
 * configuration doors call, so the process-start path and the administrator write path can never
 * disagree about what a legal rate is.
 */

/** 1 USD = `numerator / denominator` credits, as an exact rational. */
export type ConversionRate = {
  numerator: bigint;
  denominator: bigint;
};

/** The versioned rate 01.4 locks per request and 06.5 settles with. */
export type ConversionRateConfig = ConversionRate & {
  /** Monotonic: every successful administrator save increments it; 0 while only the environment value is in effect. */
  rateVersion: number;
};

export type ConversionRateIssueField = "rate" | "numerator" | "denominator";

export type ConversionRateIssueCode =
  | "missing"
  | "invalid_shape"
  | "invalid_format"
  | "zero"
  | "negative"
  | "out_of_range";

/** One refusal reason, structured for machines and written for the person who has to fix it. */
export type ConversionRateIssue = {
  field: ConversionRateIssueField;
  code: ConversionRateIssueCode;
  message: string;
};

export type ConversionRateParseResult =
  | { ok: true; rate: ConversionRate }
  | { ok: false; issues: readonly ConversionRateIssue[] };

/**
 * The ledger's internal scale, restated here the way `config.ts` restates it: this module must not
 * import the billing read modules. One credit = 100 stored units (see `CREDIT_SCALE`).
 */
const CREDIT_SCALE_OF_LEDGER = 100n;

/** The largest amount the ledger's 32-bit integer columns can hold, in stored units. */
const MAX_STORED_CREDIT_UNITS = 2_147_483_647n;

/** The 15-digit precision cap each term must respect. */
export const MAX_CONVERSION_RATE_TERM = 1_000_000_000_000_000n;

const TERM_SHAPE = `must be a whole number written in plain digits (for example "100"), so the value is never read through a float; decimal points, exponents and any other spelling are refused`;

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function parseTerm(
  value: unknown,
  field: "numerator" | "denominator",
): ConversionRateIssue | bigint {
  if (value === undefined) {
    return {
      field,
      code: "missing",
      message: `${field} is missing: the conversion rate has no implicit default, so both terms are required`,
    };
  }
  let parsed: bigint;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      return {
        field,
        code: "invalid_format",
        message: `${field} ${TERM_SHAPE} (a JSON number beyond the safe integer range is already lossy; write it as a string)`,
      };
    }
    parsed = BigInt(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      return {
        field,
        code: "invalid_format",
        message: `${field} ${TERM_SHAPE}`,
      };
    }
    parsed = BigInt(trimmed);
  } else {
    return {
      field,
      code: "invalid_format",
      message: `${field} ${TERM_SHAPE}`,
    };
  }
  if (parsed < 0n) {
    return {
      field,
      code: "negative",
      message: `${field} must be positive: negative terms have no exchange meaning`,
    };
  }
  if (parsed === 0n) {
    return {
      field,
      code: "zero",
      message:
        field === "numerator"
          ? "a zero conversion rate would make every dollar of provider cost free, which is not a rate"
          : "a zero denominator is not a number: the rate would be undefined",
    };
  }
  if (parsed > MAX_CONVERSION_RATE_TERM) {
    return {
      field,
      code: "out_of_range",
      message: `${field} exceeds the 15-digit precision cap: each term may be at most ${MAX_CONVERSION_RATE_TERM}`,
    };
  }
  return parsed;
}

/**
 * Validate one conversion rate. Both configuration doors — the `GATEWAY_CREDIT_CONVERSION_RATE`
 * environment variable at process start and the administrator's save — call only this, so their
 * conclusions are the same conclusion. Accepted input is reduced to lowest terms, which makes the
 * stored form canonical: `10/4` and `5/2` are one value, saved and compared as one value.
 */
export function parseConversionRate(value: unknown): ConversionRateParseResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      issues: [
        {
          field: "rate",
          code: "invalid_shape",
          message:
            'the conversion rate must be a JSON object like { "numerator": "100", "denominator": "1" }',
        },
      ],
    };
  }
  const record = value as Record<string, unknown>;
  const numerator = parseTerm(record.numerator, "numerator");
  if (typeof numerator !== "bigint") {
    return { ok: false, issues: [numerator] };
  }
  const denominator = parseTerm(record.denominator, "denominator");
  if (typeof denominator !== "bigint") {
    return { ok: false, issues: [denominator] };
  }
  // Cross-multiplication, so the ceiling itself is an exact comparison: the rate in credits per
  // USD, scaled by CREDIT_SCALE, must fit what one row's 32-bit units can settle.
  if (
    numerator * CREDIT_SCALE_OF_LEDGER >
    MAX_STORED_CREDIT_UNITS * denominator
  ) {
    return {
      ok: false,
      issues: [
        {
          field: "rate",
          code: "out_of_range",
          message: `the rate is ${numerator}/${denominator} credits per USD, above 21474836.47 — the most a single dollar could cost and still be settled in the credit ledger's 32-bit units at CREDIT_SCALE 100`,
        },
      ],
    };
  }
  const common = gcd(numerator, denominator);
  return {
    ok: true,
    rate: {
      numerator: numerator / common,
      denominator: denominator / common,
    },
  };
}

/**
 * The state every billing consumer reads. An unconfigured rate is a *legal* state — a deployment
 * that has not priced its credits yet — but it is not a silent one: the explanation says exactly
 * why billing is off, and `billingAdmission` turns it into the refusal downstream gates check.
 */
export type ConversionRateState =
  | {
      configured: false;
      reason: "not_configured";
      explanation: string;
    }
  | (ConversionRateConfig & {
      configured: true;
      /** Where the value came from: an administrator's saved row wins over the environment. */
      source: "environment" | "admin";
    });

export const CONVERSION_RATE_NOT_CONFIGURED_EXPLANATION =
  "The USD→credits conversion rate is not configured, so billing is not enabled: paid model capabilities cannot be enabled until an administrator saves a legal rate (there is no implicit default).";

export function notConfiguredConversionRateState(): ConversionRateState {
  return {
    configured: false,
    reason: "not_configured",
    explanation: CONVERSION_RATE_NOT_CONFIGURED_EXPLANATION,
  };
}

export type BillingAdmission =
  | {
      enabled: false;
      reason: "conversion_rate_not_configured";
      explanation: string;
    }
  | ({ enabled: true } & ConversionRateConfig);

/**
 * The answer to "may paid model work run under this state?" — the seam 01.7's readiness gate
 * consumes. Unconfigured is a hard, explainable no: no fallback rate, no "close enough" default,
 * because a guessed exchange silently misprices every request it lets through.
 */
export function billingAdmission(state: ConversionRateState): BillingAdmission {
  if (!state.configured) {
    return {
      enabled: false,
      reason: "conversion_rate_not_configured",
      explanation: state.explanation,
    };
  }
  return {
    enabled: true,
    numerator: state.numerator,
    denominator: state.denominator,
    rateVersion: state.rateVersion,
  };
}
