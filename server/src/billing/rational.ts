/**
 * Exact rationals shared by the speech evidence chain (OCR r2 convergence): the
 * interrupted collector's chunk-by-chunk sum and the settle surface's re-measurement
 * must be the SAME arithmetic — two copies of the sum were the standing risk that a
 * future drift turns honest evidence into an unexplainable settlement_conflict.
 */
export type Rational = { numerator: bigint; denominator: bigint };

/** The value in lowest terms; zero normalizes to 0/1. */
export function reduceRational(value: Rational): Rational {
  if (value.numerator === 0n) return { numerator: 0n, denominator: 1n };
  const divisor = gcd(value.numerator, value.denominator);
  return {
    numerator: value.numerator / divisor,
    denominator: value.denominator / divisor,
  };
}

/** a + b, exactly, in lowest terms. */
export function addRational(a: Rational, b: Rational): Rational {
  return reduceRational({
    numerator: a.numerator * b.denominator + b.numerator * a.denominator,
    denominator: a.denominator * b.denominator,
  });
}

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
