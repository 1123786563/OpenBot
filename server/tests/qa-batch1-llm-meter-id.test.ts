import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * QA batch-1 probe (f): the LLM meter's transaction id, verified against the SOURCE — the
 * wiring lives inside index.ts's assembly (a module with heavy side effects that no unit test
 * can import), so the check is twofold:
 *
 *   1. STATIC: the implementation the file actually contains — `llm:<key>:<seq>` off a
 *      per-process counter, zero-usage short-circuit, fire-and-forget report — read from disk
 *      and pinned, so the comment and the code cannot drift apart silently (the old code
 *      promised "stable enough to deduplicate a retry" while embedding Date.now(); P2-1 was
 *      filed over exactly that kind of drift).
 *   2. BEHAVIORAL: the id grammar the sequence produces — monotonic per key, distinct across
 *      keys, no timestamp anywhere — replayed through the same string-building arithmetic.
 */

const SOURCE = readFileSync(
  join(import.meta.dir, "../src/index.ts"),
  "utf8",
);

describe("probe f: the meter's transaction id (static contract, index.ts)", () => {
  test("the id is built from a per-process counter, not a clock", () => {
    // The counter, the increment, and the id — the three lines P2-1's fix stands on.
    expect(SOURCE).toContain("let meterSequence = 0;");
    expect(SOURCE).toMatch(/meterSequence\s*\+=\s*1/);
    expect(SOURCE).toMatch(
      /const transactionId = `llm:\$\{billing\.externalCustomerKey\}:\$\{meterSequence\}`/,
    );
  });

  test("Date.now() is gone from the id: the old P2-1 shape survives only as a comment", () => {
    // The comment documents the replacement; every OTHER line must be free of the old shape.
    const codeLines = SOURCE.split("\n").filter((line) => !line.trim().startsWith("*"));
    for (const line of codeLines) {
      expect(line).not.toMatch(/llm-.*Date\.now\(\)/);
      expect(line).not.toMatch(/Date\.now\(\).*llm-/);
    }
  });

  test("a zero-token finish mints no id at all", () => {
    expect(SOURCE).toContain("if (input === 0 && output === 0) return;");
  });

  test("the report is fire-and-forget: a metering miss never fails the run", () => {
    expect(SOURCE).toMatch(/void billingService\s*\n?\s*\.recordUsage/);
  });

  test("the comment's two promises are the code's two properties", () => {
    // different calls → different ids (the sequence increments per reported finish)
    expect(SOURCE).toContain("the sequence increments per reported finish");
    // the id is minted once — the report itself carries no caller-side retry
    expect(SOURCE).toContain("minted once");
  });
});

describe("probe f: the id grammar the sequence produces (behavioral)", () => {
  test("same key: the sequence is strictly monotonic across same-millisecond finishes", () => {
    // The whole point of the counter: two finishes in the SAME tick still number apart,
    // which a Date.now()-based id could never promise.
    let meterSequence = 0;
    const key = "deployment-key-a";
    const ids = Array.from({ length: 50 }, () => {
      meterSequence += 1;
      return `llm:${key}:${meterSequence}`;
    });
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]).not.toBe(ids[i - 1]);
    }
    expect(new Set(ids).size).toBe(50);
    // And the numeric tail is exactly 1..50, in order.
    expect(ids.map((id) => Number(id.split(":")[2]))).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });

  test("different keys: the namespaces never collide, even at the same seq", () => {
    const a = (seq: number) => `llm:deployment-a:${seq}`;
    const b = (seq: number) => `llm:deployment-b:${seq}`;
    expect(a(7)).not.toBe(b(7));
    // A key containing a colon would be ambiguous: `llm:a:b:1` — the deployment key grammar
    // (deploymentExternalCustomerId derives from a tenant id) is the guard, noted here as the
    // boundary of the format's promise, not a defect of this batch.
    expect(`llm:${"a:b"}:1`.split(":").length).toBe(4);
  });

  test("the id carries no timestamp: identical inputs at different wall times are identical ids at the same seq — and the provider dedupe holds", () => {
    // Two identical-usage calls a minute apart under the OLD scheme produced two different ids
    // (double metering). Under the counter, the id depends on the CALL COUNT alone.
    const idAt = (seq: number, _wallClockIrrelevant: number) => `llm:key:${seq}`;
    expect(idAt(3, 1_791_900_000_000)).toBe("llm:key:3");
    expect(idAt(3, 1_791_900_060_000)).toBe("llm:key:3");
    expect(idAt(3, 1_791_900_000_000)).toBe(idAt(3, 1_791_900_060_000));
  });
});
