/**
 * Shared formatting for the billing pages.
 *
 * Every answer the provider sends carries raw numbers — cents, ISO datetimes, string decimals —
 * and each of the three pages needs them said in the reader's own language. Said once here, so
 * the usage page's ¥199.00 and the entitlements page's ¥199.00 can never disagree.
 */

/**
 * Whole currency units from cents, in the reader's own locale and the plan's own currency.
 *
 * A plan without a currency code formats as a plain amount rather than a guessed one: no code
 * means no reason to claim USD, and `Intl` itself refuses `style: "currency"` without a code.
 */
export function money(cents: number, currency?: string): string {
  return new Intl.NumberFormat(undefined, {
    ...(currency ? { style: "currency", currency } : {}),
  }).format(cents / 100);
}

/** The period as one line: "Oct 1 – Oct 31, 2026", in the reader's locale. */
export function period(from?: string, to?: string): string {
  if (from === undefined && to === undefined) return "";
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const fromPart = from === undefined ? "" : format.format(new Date(from));
  const toPart = to === undefined ? "" : format.format(new Date(to));
  return fromPart && toPart ? `${fromPart} – ${toPart}` : fromPart || toPart;
}

/** A charge's `units` is a string decimal; the token total is the sum across charges. */
export function totalTokensOf(charges: readonly { units: string }[]): number {
  return charges.reduce((sum, charge) => sum + (Number(charge.units) || 0), 0);
}

/** Credits as a reader reads them: up to two places, no trailing noise (23.63, 376.37, 500, 0). */
export function credits(value: number): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * A speech line's measured seconds as a reader reads them: at most three decimals
 * (0.04643991 → 0.046). The wire carries an exact decimal; the table shows a display
 * number, never nine digits and never a value cut off mid-digit.
 */
export function seconds(value: string): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(Number(value));
}

/** A whole count as the reader's language groups it (12,345). */
export function count(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    value,
  );
}

/** A datetime to the second, as the design shows expiries and resets: "2026-10-11 18:48:21". */
export function dateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
