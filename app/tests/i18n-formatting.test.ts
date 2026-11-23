import { afterEach, expect, test } from "bun:test";
import { formatDate, formatNumber, setLocalePreference } from "@/i18n";
import { relativeTimeShort } from "@/lib/relative-time";

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
  await setLocalePreference("zh-CN");
  expect(relativeTimeShort("not a date", NOON)).toBe("not a date");
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
