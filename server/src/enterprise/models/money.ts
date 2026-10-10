/**
 * Money primitives for the budget ledger, per plan 03 §8.2.
 *
 * Every amount is an integer number of micros (1 currency unit = 1,000,000
 * micros) in ONE currency — currencies are never converted or mixed here.
 * Values cross the whole pipeline as BigInt: a decimal string enters through
 * `units`, arithmetic happens in `cost`, and nothing ever rounds through a JS
 * number (a float from a UI or a provider payload is not money and is refused,
 * not truncated). Amounts land in PostgreSQL bigint columns, so anything past
 * 2^63-1 is an explicit MONEY_OVERFLOW rather than a silent wrap.
 */

/** The PostgreSQL bigint maximum: the hard ceiling for every stored amount. */
export const INT8_MAX = 9223372036854775807n;

/**
 * Parses a canonical non-negative decimal string into micros. Leading zeros,
 * signs, fractions, exponents and whitespace are all INVALID_MONEY — a value
 * that is not exactly how the ledger writes integers is not a value the
 * ledger may spend.
 */
export function units(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("INVALID_MONEY");
  }
  const parsed = BigInt(value);
  if (parsed > INT8_MAX) {
    throw new Error("MONEY_OVERFLOW");
  }
  return parsed;
}

/**
 * Prices one model call: input tokens × input rate + output tokens × output
 * rate + the fixed per-request fee, all in micros. Token counts and rates are
 * per-token integer micros (the MVP pricing profile, §8.2); any negative
 * input is INVALID_MONEY and an int8 overflow is MONEY_OVERFLOW — the true
 * cost is never truncated to fit a budget.
 */
export function cost(
  inputTokens: bigint,
  outputTokens: bigint,
  inRate: bigint,
  outRate: bigint,
  fixed: bigint,
): bigint {
  if ([inputTokens, outputTokens, inRate, outRate, fixed].some((v) => v < 0n)) {
    throw new Error("INVALID_MONEY");
  }
  const result = inputTokens * inRate + outputTokens * outRate + fixed;
  if (result > INT8_MAX) {
    throw new Error("MONEY_OVERFLOW");
  }
  return result;
}
