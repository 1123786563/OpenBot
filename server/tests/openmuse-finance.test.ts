import { describe, expect, test } from "bun:test";
import { analyzeSpending } from "../src/openmuse-finance/csv";

/*
 * T13: the §7 finance fixture against the parser ported from OpenMuse's
 * `apps/server/src/engine/finance.ts` (prior art, read-only). Same rules —
 * header date,description,amount,category; 1–5,000 rows; ≤500 KB; ISO date;
 * max two decimals; positive = expense, negative = income, no conversion —
 * with cents arithmetic carried through and the §7 summary answered as
 * fixed-point strings so no float ever rounds a money value.
 */

const FIXTURE = [
  "date,description,amount,category",
  "2026-09-01,Salary,-4200.00,Income",
  "2026-09-02,Groceries,84.50,Food",
  "2026-09-03,Coffee,6.50,Food",
].join("\n");

describe("analyzeSpending", () => {
  test("the three-row fixture gives the exact §7 summary", () => {
    expect(analyzeSpending(FIXTURE)).toEqual({
      income: "4200.00",
      spending: "91.00",
      saved: "4109.00",
      byCategory: { Food: "91.00" },
      count: 3,
    });
  });

  test("an income-only CSV zeroes spending without a category row", () => {
    expect(
      analyzeSpending(
        "date,description,amount,category\n2026-09-01,Salary,-4200.00,",
      ),
    ).toEqual({
      income: "4200.00",
      spending: "0.00",
      saved: "4200.00",
      byCategory: {},
      count: 1,
    });
  });

  test("an empty category on an expense lands as Uncategorized", () => {
    const summary = analyzeSpending(
      "date,description,amount,category\n2026-09-01,Coffee,6.50,",
    );
    expect(summary.byCategory).toEqual({ Uncategorized: "6.50" });
  });

  test("a bad amount refuses the entire CSV naming its row", () => {
    // Prior art numbers rows by CSV line, header = line 1: the 6.501 row is
    // line 5 when appended after the full fixture, line 4 as the third data
    // row. Either way the whole CSV is refused — no partial tracker.
    expect(() =>
      analyzeSpending(`${FIXTURE}\n2026-09-04,Tip,6.501,Food`),
    ).toThrow(/Row 5/);
    expect(() =>
      analyzeSpending(
        [
          "date,description,amount,category",
          "2026-09-01,Salary,-4200.00,Income",
          "2026-09-02,Groceries,84.50,Food",
          "2026-09-03,Tip,6.501,Food",
        ].join("\n"),
      ),
    ).toThrow(/Row 4/);
  });

  test("a non-ISO date refuses the CSV naming its row", () => {
    for (const date of ["2026-9-1", "09/01/2026", ""]) {
      expect(() =>
        analyzeSpending(
          `date,description,amount,category\n${date},Coffee,6.50,Food`,
        ),
      ).toThrow(/Row 2/);
    }
  });

  test("a wrong header refuses the CSV", () => {
    expect(() =>
      analyzeSpending("date,description,amount\n2026-09-01,Coffee,6.50"),
    ).toThrow(/needs date,description,amount,category columns/);
  });

  test("a duplicate required column refuses the CSV", () => {
    expect(() =>
      analyzeSpending(
        "date,description,amount,category, Amount \n2026-09-01,Purchase,10,Food,1000",
      ),
    ).toThrow(/duplicate/i);
  });

  test("an empty CSV refuses with the row-count rule", () => {
    expect(() => analyzeSpending("date,description,amount,category")).toThrow(
      /between 1 and 5,000/,
    );
  });

  test("more than 5,000 rows refuses the CSV", () => {
    const rows = ["date,description,amount,category"];
    for (let i = 0; i < 5_001; i++) rows.push(`2026-09-01,Row ${i},1.00,Food`);
    expect(() => analyzeSpending(rows.join("\n"))).toThrow(
      /between 1 and 5,000/,
    );
  });

  test("more than 500 KB refuses the CSV", () => {
    expect(() =>
      analyzeSpending(
        `date,description,amount,category\n${"x".repeat(500_000)}`,
      ),
    ).toThrow(/at most 500 KB/);
  });

  test("a row with the wrong column count refuses naming its row", () => {
    expect(() =>
      analyzeSpending(
        "date,description,amount,category\n2026-09-01,Coffee,6.50",
      ),
    ).toThrow(/Row 2 has the wrong number of columns/);
  });

  test("a UTF-8 byte order mark before the header is accepted", () => {
    expect(
      analyzeSpending(
        `\uFEFFdate,description,amount,category\n2026-09-01,Coffee,10.10,Food`,
      ).spending,
    ).toBe("10.10");
  });

  test("quoted fields survive with commas and doubled quotes inside", () => {
    const summary = analyzeSpending(
      '"date","description","amount","category"\r\n' +
        '"2026-09-01","Coffee, ""local""","10.10","Food"\r\n',
    );
    expect(summary.count).toBe(1);
    expect(summary.spending).toBe("10.10");
  });

  test("a blank line mid-file does not shift the reported line numbers", () => {
    // Physical lines: 1 header, 2 salary, 3 BLANK (skipped), 4 the bad
    // amount — the error must name the CSV's own line 4, not the filtered
    // array's index+2 (which would say 3).
    expect(() =>
      analyzeSpending(
        [
          "date,description,amount,category",
          "2026-09-01,Salary,-4200.00,Income",
          "",
          "2026-09-02,Tip,6.501,Food",
        ].join("\n"),
      ),
    ).toThrow(/Row 4/);
  });

  test("an out-of-range amount refuses naming its row, like every other row error", () => {
    expect(() =>
      analyzeSpending(
        "date,description,amount,category\n2026-09-01,Jet,999999999999.99,Toys",
      ),
    ).toThrow(/Row 2: transaction amount is out of range/);
  });

  test("the 500 KB bound counts bytes, not UTF-16 code units", () => {
    // 200,000 CJK characters are ~600 KB of UTF-8 but only 200,000 code
    // units — a character-count bound would let ~1.5 MB through.
    const cjk = "购".repeat(200_000);
    expect(() =>
      analyzeSpending(
        `date,description,amount,category\n2026-09-01,${cjk},6.50,Food`,
      ),
    ).toThrow(/at most 500 KB/);
  });

  test("a category literally named __proto__ still reports, keeping byCategory consistent with spending", () => {
    const summary = analyzeSpending(
      'date,description,amount,category\n2026-09-01,Odd,10.00,"__proto__"',
    );
    expect(summary.spending).toBe("10.00");
    const protoKey = "__proto__";
    expect(Object.hasOwn(summary.byCategory, protoKey)).toBe(true);
    expect(summary.byCategory[protoKey]).toBe("10.00");
    // The prototype itself was never written.
    expect(({} as { "10.00"?: string })["10.00"]).toBeUndefined();
  });
});
