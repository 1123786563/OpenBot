import { afterEach, expect, spyOn, test } from "bun:test";
import { formatDate, formatNumber, i18n, setLocalePreference } from "@/i18n";
import { relativeTime, relativeTimeShort } from "@/lib/relative-time";

// Every test file in a run shares one translation instance, so this file puts English back.
afterEach(async () => {
  await setLocalePreference("en");
});

const NOON = new Date("2026-03-05T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** The moment `ms` before the noon above, as the server sends it. */
const ago = (ms: number) => new Date(NOON.getTime() - ms).toISOString();
/** Reads a long relative time at the noon above: it keeps its own clock, so the clock is lent to it. */
function longTimeAtNoon(iso: string): string {
  const clock = spyOn(Date, "now").mockReturnValue(NOON.getTime());
  try {
    return relativeTime(iso);
  } finally {
    clock.mockRestore();
  }
}

// A long time spells its unit out, so it keeps the calendar's own words ("yesterday", "前天").
test.each([
  [30_000, "30 seconds ago", "30 秒钟前"],
  // Rounded to the nearest unit, so a moment can read as the top of the unit below.
  [59_500, "60 seconds ago", "60 秒钟前"],
  [90_000, "2 minutes ago", "2 分钟前"],
  [3 * HOUR, "3 hours ago", "3 小时前"],
  [DAY, "yesterday", "昨天"],
  [2 * DAY, "2 days ago", "前天"],
  [6 * DAY, "6 days ago", "6 天前"],
  [WEEK, "last week", "上周"],
  [3 * WEEK, "3 weeks ago", "3 周前"],
  [-5 * HOUR, "in 5 hours", "5 小时后"],
  [-DAY, "tomorrow", "明天"],
  [-WEEK, "next week", "下周"],
] as const)(
  "%s ms from noon reads %s in English and %s in Chinese",
  async (elapsed, english, chinese) => {
    const timestamp = ago(elapsed);
    await setLocalePreference("en");
    expect(longTimeAtNoon(timestamp)).toBe(english);

    await setLocalePreference("zh-CN");
    expect(longTimeAtNoon(timestamp)).toBe(chinese);

    // Only the words changed: the instant and the clock are the ones given.
    expect(new Date(timestamp).getTime()).toBe(NOON.getTime() - elapsed);
    expect(NOON.toISOString()).toBe("2026-03-05T12:00:00.000Z");
  },
);

test("with no interface language yet, a long time is worded by the browser, as before", () => {
  // What Intl says with no language given is, by definition, the browser's wording.
  const browser = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const threeMinutesAgo = browser.format(-3, "minute");
  const language = i18n.language;
  // A blank tag is the one state Intl refuses; it must read as "no language" rather than throw.
  i18n.language = "";
  try {
    expect(longTimeAtNoon(ago(3 * MINUTE))).toBe(threeMinutesAgo);
  } finally {
    i18n.language = language;
  }
});

test.each([
  [0, "now", "刚刚"],
  [59_000, "now", "刚刚"],
  [-30_000, "now", "刚刚"],
  [MINUTE, "1m", "1 分钟前"],
  [3 * MINUTE, "3m", "3 分钟前"],
  [59 * MINUTE + 59_000, "59m", "59 分钟前"],
  [HOUR, "1h", "1 小时前"],
  [23 * HOUR + 59 * MINUTE, "23h", "23 小时前"],
  [DAY, "1d", "1 天前"],
  [6 * DAY, "6d", "6 天前"],
  [WEEK, "1w", "1 周前"],
  [6 * WEEK, "6w", "6 周前"],
] as const)(
  "%s ms before noon reads %s in English and %s in Chinese",
  async (elapsed, english, chinese) => {
    const timestamp = ago(elapsed);
    await setLocalePreference("en");
    expect(relativeTimeShort(timestamp, NOON)).toBe(english);

    await setLocalePreference("zh-CN");
    expect(relativeTimeShort(timestamp, NOON)).toBe(chinese);

    // Only the words changed: the instant and the clock are the ones given.
    expect(new Date(timestamp).getTime()).toBe(NOON.getTime() - elapsed);
    expect(NOON.toISOString()).toBe("2026-03-05T12:00:00.000Z");
  },
);

test("a time that is not a date is handed back as it came, in either language", async () => {
  await setLocalePreference("en");
  expect(relativeTimeShort("not a date", NOON)).toBe("not a date");
  expect(relativeTime("not a date")).toBe("not a date");
  await setLocalePreference("zh-CN");
  expect(relativeTimeShort("not a date", NOON)).toBe("not a date");
  expect(relativeTime("not a date")).toBe("not a date");
});

test("a date is written in the interface language and still names the same day", async () => {
  // A Date can be moved; this one must come back from both languages as it went in.
  const sent = new Date("2026-03-05T12:00:00.000Z");

  await setLocalePreference("en");
  expect(formatDate(sent, { dateStyle: "long", timeZone: "UTC" })).toBe(
    "March 5, 2026",
  );
  expect(
    formatDate(sent, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    }),
  ).toBe("12:00");

  await setLocalePreference("zh-CN");
  expect(formatDate(sent, { dateStyle: "long", timeZone: "UTC" })).toBe(
    "2026年3月5日",
  );
  expect(
    formatDate(sent, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    }),
  ).toBe("12:00");
  expect(sent.toISOString()).toBe("2026-03-05T12:00:00.000Z");
});

test("the language changes the words of a date, not the hour on this device's clock", async () => {
  const sent = new Date("2026-03-05T12:00:00.000Z");
  const wallClock = {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  } as const;

  await setLocalePreference("en");
  const english = formatDate(sent, wallClock);
  await setLocalePreference("zh-CN");
  expect(formatDate(sent, wallClock)).toBe(english);
});

test("a number keeps its value and takes the language's way of writing it", async () => {
  const attendees = 1234.5;
  const installs = 12345;

  await setLocalePreference("en");
  expect(formatNumber(attendees)).toBe("1,234.5");
  expect(formatNumber(installs, { notation: "compact" })).toBe("12K");

  await setLocalePreference("zh-CN");
  expect(formatNumber(attendees)).toBe("1,234.5");
  expect(formatNumber(installs, { notation: "compact" })).toBe("1.2万");
  expect(attendees).toBe(1234.5);
  expect(installs).toBe(12345);
});
