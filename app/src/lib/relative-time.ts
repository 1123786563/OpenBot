import i18n from "./i18n";

const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

/**
 * One formatter per locale, made on first use. The old module-level singleton was bound to the
 * browser-default locale forever; these are keyed by the active language and reused across the
 * many rows of a roster that all want the same "2 minutes ago".
 */
const formatters = new Map<string, Intl.RelativeTimeFormat>();

function formatterFor(locale: string): Intl.RelativeTimeFormat {
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    formatters.set(locale, formatter);
  }
  return formatter;
}

/**
 * Locale-aware relative timestamp, e.g. "2 minutes ago", in an explicit locale.
 *
 * An invalid date answers `Invalid Date` rather than the input, because a `Date` here has
 * already lost the original string; `relativeTime` below keeps the pass-through behaviour its
 * callers were written against.
 */
export function formatRelativeTime(date: Date, locale: string): string {
  const time = date.getTime();
  if (!Number.isFinite(time)) return String(date);
  const elapsed = Date.now() - time;
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return formatterFor(locale).format(
    -Math.round(elapsed / scale.divisor),
    scale.unit,
  );
}

/** Locale-aware relative timestamp in the active interface language, e.g. "2 minutes ago". */
export function relativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  // An invalid date used to flow into `Math.abs(NaN)` comparisons and `format(-NaN)`, which
  // answers "NaN weeks ago" or throws depending on ICU. Return the input unchanged instead.
  if (!Number.isFinite(time)) return iso;
  return formatRelativeTime(new Date(iso), i18n.language);
}
