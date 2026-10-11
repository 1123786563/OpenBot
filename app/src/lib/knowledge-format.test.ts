import { describe, expect, test } from "bun:test";
import { formatFileSize, formatStringDate } from "@/lib/knowledge-format";

/**
 * QA 补盲区：formatFileSize / formatStringDate 的边界行为。
 * 语义来源 WeKnora utils/files.ts（null/undefined/空串/非正数 → ''），
 * OpenBot 版额外接受字符串数字（上游 wire format 偶见），按实现语义断言。
 */

describe("formatFileSize", () => {
  test("falsy and non-positive inputs return empty string", () => {
    expect(formatFileSize(null)).toBe("");
    expect(formatFileSize(undefined)).toBe("");
    expect(formatFileSize("")).toBe("");
    expect(formatFileSize(0)).toBe("");
    expect(formatFileSize(-1)).toBe("");
    expect(formatFileSize(-1024)).toBe("");
  });

  test("non-numeric strings fall back to empty string", () => {
    expect(formatFileSize("abc")).toBe("");
    expect(formatFileSize("12px")).toBe("12 B"); // parseInt 前缀解析
  });

  test("byte boundaries: 1023 B, 1024 → 1.0 KB, 1 MiB → 1.0 MB", () => {
    expect(formatFileSize(1)).toBe("1 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatFileSize(1024 * 1024 + 512 * 1024)).toBe("1.5 MB");
  });

  test("string numbers parse as decimal", () => {
    expect(formatFileSize("512")).toBe("512 B");
    expect(formatFileSize("2048")).toBe("2.0 KB");
  });
});

describe("formatStringDate", () => {
  test("formats an ISO date into local YYYY-MM-DD HH:mm:ss", () => {
    // 用本地时区无关的构造方式断言字段拼装逻辑本身。
    const d = new Date(2026, 0, 3, 9, 5, 7);
    expect(formatStringDate(d)).toBe("2026-01-03 09:05:07");
    expect(formatStringDate(d.getTime())).toBe("2026-01-03 09:05:07");
    expect(formatStringDate("2026-10-11T12:00:00")).toMatch(
      /^2026-10-11 \d{2}:\d{2}:\d{2}$/,
    );
  });

  test("pads single-digit month/day/hour/minute/second", () => {
    const d = new Date(2026, 10, 1, 1, 2, 3);
    expect(formatStringDate(d)).toBe("2026-11-01 01:02:03");
  });

  test("invalid input returns empty string, never Invalid Date", () => {
    expect(formatStringDate("not a date")).toBe("");
    expect(formatStringDate(Number.NaN)).toBe("");
    expect(formatStringDate(Number.POSITIVE_INFINITY)).toBe("");
  });
});
