import { z } from "zod";

/**
 * T13 (issue #70): the §7 finance parser, ported from OpenMuse's
 * `apps/server/src/engine/finance.ts` (read-only prior art) with its rules
 * intact — header `date,description,amount,category` (case/whitespace
 * insensitive, duplicates of a required column refused), 1–5,000 data rows,
 * at most 500 KB, ISO dates, amounts of at most two decimal places,
 * positive = expense and negative = income, no currency conversion, the
 * whole CSV refused with the offending CSV line number (header = line 1)
 * rather than a partial tracker.
 *
 * Divergence from the prior art, recorded per the plan: the report is the
 * §7 fixture surface — income/spending/saved/byCategory/count as
 * fixed-point strings derived from integer cents — instead of the prior
 * art's float report with per-transaction rows; the cents arithmetic, row
 * numbering and refusal rules are carried over unchanged.
 */

/** The §7 summary a finance Task produces; money as fixed-point strings. */
export type FinanceSummary = {
  income: string;
  spending: string;
  saved: string;
  byCategory: Record<string, string>;
  count: number;
};

/** Prior art's amount convention, restated on every artifact. */
export const AMOUNT_CONVENTION =
  "Positive expenses; negative income. Values use the source currency; no currency conversion.";

/** Cents to a fixed-point string without a float ever touching the value. */
function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

/** The columns every import must carry; a duplicate of any one refuses the file. */
const REQUIRED_COLUMNS = ["date", "description", "amount", "category"] as const;

/** CSV amounts use positive expenses and negative income. No currency conversion is inferred. */
export function analyzeSpending(csv: string): FinanceSummary {
  // Bytes, not UTF-16 code units: a CJK-heavy CSV is ~3 bytes per character,
  // so a character count would let ~1.5 MB through the "500 KB" bound.
  if (Buffer.byteLength(csv, "utf8") > 500000)
    throw new Error("Import at most 500 KB of transaction CSV");
  // Excel and many bank exports start a UTF-8 CSV with a byte order mark. It is not part of the first header.
  if (csv.charCodeAt(0) === 0xfeff) csv = csv.slice(1);
  /*
   * Rows carry their PHYSICAL line number: blank lines are skipped below, so
   * a data row's array index is not its line — the header contract promises
   * the offending CSV line, and a caller mid-file must not be pointed at the
   * wrong one. `line` advances only on unquoted newlines (row separators);
   * `rowStart` pins the line a row begins on, so a quoted field spanning
   * lines reports the row's first line.
   */
  const rows: Array<{ cells: string[]; line: number }> = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    line = 1,
    rowStart = 1;
  for (let i = 0; i <= csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && cell.length)
        throw new Error("Invalid quoted CSV field");
      else {
        quoted = !quoted;
        if (!quoted) {
          const next = csv[i + 1];
          if (
            next !== undefined &&
            next !== "," &&
            next !== "\n" &&
            !(
              next === "\r" &&
              (csv[i + 2] === "\n" || csv[i + 2] === undefined)
            )
          )
            throw new Error("Invalid quoted CSV field");
        }
      }
    } else if (!quoted && (c === "," || c === "\n" || c === undefined)) {
      row.push(cell.replace(/\r$/, ""));
      cell = "";
      if (c !== ",") {
        if (row.some((v) => v.trim()))
          rows.push({ cells: row, line: rowStart });
        row = [];
        if (c === "\n") line += 1;
        rowStart = line;
      }
    } else if (c !== undefined) cell += c;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field");
  const header = rows.shift()?.cells.map((v) => v.trim().toLowerCase());
  if (!header || !REQUIRED_COLUMNS.every((v) => header.includes(v)))
    throw new Error("CSV needs date,description,amount,category columns");
  if (
    REQUIRED_COLUMNS.some(
      (name) => header.indexOf(name) !== header.lastIndexOf(name),
    )
  )
    throw new Error("CSV has a duplicate required column");
  if (!rows.length || rows.length > 5000)
    throw new Error("Import between 1 and 5,000 transactions");
  // Column lookup once, not per cell: the header is fixed from here on.
  const columnOf = new Map<string, number>(
    REQUIRED_COLUMNS.map((name) => [name, header.indexOf(name)]),
  );
  const transactions = rows.map((r) => {
    const get = (name: string) =>
      r.cells[columnOf.get(name) ?? -1]?.trim() ?? "";
    if (r.cells.length !== header.length)
      throw new Error(`Row ${r.line} has the wrong number of columns`);
    const date = get("date"),
      amount = get("amount");
    if (
      !z.iso.date().safeParse(date).success ||
      !/^[-+]?\d+(?:\.\d{1,2})?$/.test(amount)
    )
      throw new Error(
        `Row ${r.line} needs an ISO date and a plain amount with at most two decimal places`,
      );
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isSafeInteger(cents) || Math.abs(cents) > 1e12)
      throw new Error(`Row ${r.line}: transaction amount is out of range`);
    return {
      date,
      description: get("description"),
      category: get("category") || "Uncategorized",
      cents,
    };
  });
  const expenses = transactions
      .filter((t) => t.cents > 0)
      .reduce((n, t) => n + t.cents, 0),
    income = -transactions
      .filter((t) => t.cents < 0)
      .reduce((n, t) => n + t.cents, 0);
  // Prior art's category order: biggest expense first. fromEntries defines
  // every key as an own property, so a category literally named "__proto__"
  // still reports (a plain object's inherited setter would swallow it and
  // leave byCategory disagreeing with `spending`). Key order follows the
  // insertion for ordinary string keys; purely numeric category names (e.g.
  // "2024") are integer-like keys and sort ahead of them in JSON, so key
  // order is not guaranteed for those.
  const grouped = new Map<string, number>();
  for (const t of transactions)
    if (t.cents > 0)
      grouped.set(t.category, (grouped.get(t.category) ?? 0) + t.cents);
  const byCategory: Record<string, string> = Object.fromEntries(
    [...grouped]
      .sort((a, b) => b[1] - a[1])
      .map(([name, cents]) => [name, money(cents)]),
  );
  return {
    income: money(income),
    spending: money(expenses),
    saved: money(income - expenses),
    byCategory,
    count: transactions.length,
  };
}
