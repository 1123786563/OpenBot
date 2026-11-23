import { formatRelativeTime, i18n, t } from "@/i18n";

const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

/** Locale-aware relative timestamp, e.g. "2 minutes ago", spelled out in the interface language. */
export function relativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  // An invalid date used to flow into `Math.abs(NaN)` comparisons and `format(-NaN)`, which
  // answers "NaN weeks ago" or throws depending on ICU. Return the input unchanged instead.
  if (!Number.isFinite(time)) return iso;
  const elapsed = Date.now() - time;
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  // A formatter speaks the language it was made in, so it is made for this call and not kept.
  // With no interface language yet, Intl speaks the browser's, as it always did.
  const words = new Intl.RelativeTimeFormat(i18n.language || undefined, {
    numeric: "auto",
  }).format(-Math.round(elapsed / scale.divisor), scale.unit);
  return i18n.language === "zh-CN" ? spacedNumeral(words) : words;
}

/** CLDR writes "3分钟前"; Chinese copy sets the numeral apart with a space ("3 分钟前"). */
function spacedNumeral(words: string): string {
  return words.replace(/^\d+/, (digits) => `${digits} `);
}

const SHORT_UNITS = [
  {
    limit: 3_600_000,
    divisor: 60_000,
    suffix: "m",
    unit: "minute",
  },
  {
    limit: 86_400_000,
    divisor: 3_600_000,
    suffix: "h",
    unit: "hour",
  },
  {
    limit: 604_800_000,
    divisor: 86_400_000,
    suffix: "d",
    unit: "day",
  },
  {
    limit: Number.POSITIVE_INFINITY,
    divisor: 604_800_000,
    suffix: "w",
    unit: "week",
  },
] as const;

/**
 * The sidebar's compact timestamp: "now", "5m", "3h", "2d", "6w" in English, spelled out in the
 * interface language elsewhere ("3 分钟前").
 *
 * Rounded down, so a unit never shows its own upper bound ("60m"). A time slightly ahead of this
 * clock, from a server whose clock runs fast, reads as "now" rather than a negative number.
 */
export function relativeTimeShort(iso: string, now: Date = new Date()): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return iso;
  const elapsed = now.getTime() - time;
  if (elapsed < 60_000) return t("relativeTime.now", "now");
  const scale =
    SHORT_UNITS.find(({ limit }) => elapsed < limit) ??
    SHORT_UNITS[SHORT_UNITS.length - 1];
  const count = Math.floor(elapsed / scale.divisor);
  // Only English has these compact suffixes; other languages spell the unit out, which Intl knows.
  if (i18n.language === "en") return `${count}${scale.suffix}`;
  return spacedNumeral(formatRelativeTime(-count, scale.unit));
}
