/** 1 USD = numerator/denominator credits, exact rational — never a float. */
export type ConversionRate = { numerator: bigint; denominator: bigint };
export const MAX_RATE_DECIMALS = 6;
const RATE_RE = /^\d{1,9}(?:\.\d{1,6})?$/;

export function parseConversionRateInput(raw: unknown): { ok: true; value: ConversionRate } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "Conversion rate is required for billing enablement (1 USD = X credits); no implicit default exists." };
  }
  const s = raw.trim();
  if (!RATE_RE.test(s) || Number(s) === 0) {
    return { ok: false, error: `Conversion rate must be a positive decimal of at most ${MAX_RATE_DECIMALS} places (for example "7.5").` };
  }
  const [intPart, decPart = ""] = s.split(".");
  return {
    ok: true,
    value: {
      numerator: BigInt(`${intPart}${decPart}`),
      denominator: 10n ** BigInt(decPart.length),
    },
  };
}
