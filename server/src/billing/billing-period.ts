/**
 * Beijing-time Billing Period math for paid Subscription Plans (#101).
 *
 * The first verified payment starts a calendar month anchored on its Beijing
 * day-of-month. Every renewal lands on that anchor day's Beijing midnight,
 * clamped to the month's end when the month is too short — and the original
 * date recovers as soon as the calendar allows it. A gap re-purchase starts
 * over from the new payment's instant with a fresh anchor. An advance
 * purchase becomes effective exactly when the current period ends.
 *
 * Asia/Shanghai is a fixed UTC+8 offset (no DST), so every conversion below
 * is exact arithmetic on shifted milliseconds.
 */

const beijingOffsetMs = 8 * 60 * 60_000;

type BeijingParts = {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
};

function beijingParts(instant: Date): BeijingParts {
  const shifted = new Date(instant.getTime() + beijingOffsetMs);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The instant of Beijing midnight starting the given Beijing day. */
function beijingDayStart(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - beijingOffsetMs);
}

/**
 * The renewal boundary one calendar month after the Beijing (year, month)
 * given: the anchor day's midnight, or the short month's final day when the
 * anchor does not exist in that month.
 */
function renewalBoundary(year: number, month: number, anchorDay: number): Date {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const clamped = Math.min(anchorDay, daysInMonth(nextYear, nextMonth));
  return beijingDayStart(nextYear, nextMonth, clamped);
}

export type BillingPeriod = {
  start: Date;
  /** Exclusive: the Beijing midnight of the next renewal. */
  end: Date;
  /** The Beijing day-of-month this plan renews on. */
  anchorDay: number;
};

/**
 * The period a first (or gap re-purchase) verified payment opens: from the
 * payment instant to the first renewal boundary a calendar month ahead.
 */
export function firstBillingPeriod(verifiedPaymentAt: Date): BillingPeriod {
  const { year, month, day } = beijingParts(verifiedPaymentAt);
  return {
    start: verifiedPaymentAt,
    end: renewalBoundary(year, month, day),
    anchorDay: day,
  };
}

/**
 * The period that follows `period`: same anchor, short months clamp to their
 * final day, and the original anchor day recovers afterwards.
 */
export function nextBillingPeriod(period: BillingPeriod): BillingPeriod {
  const { year, month } = beijingParts(period.end);
  return {
    start: period.end,
    end: renewalBoundary(year, month, period.anchorDay),
    anchorDay: period.anchorDay,
  };
}

/**
 * An advance purchase while a period is still running: the replacement plan
 * takes effect exactly when the current period ends, never earlier.
 */
export function advancePurchasePeriod(current: BillingPeriod): BillingPeriod {
  return nextBillingPeriod(current);
}

/** Whether `at` falls inside the period. */
export function withinPeriod(period: BillingPeriod, at: Date): boolean {
  return at >= period.start && at < period.end;
}
