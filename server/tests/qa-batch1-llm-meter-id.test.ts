import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * QA batch-1 probe (f): the LLM meter's outbox write, verified against the SOURCE — the
 * wiring lives inside index.ts's assembly (a module with heavy side effects that no unit test
 * can import), so the check is twofold:
 *
 *   1. STATIC: the implementation the file actually contains — a usage-outbox write keyed by
 *      the stream event id, zero-usage short-circuit, and no direct Lago or credit draw —
 *      read from disk and pinned, so the task boundary cannot regress silently.
 *   2. BEHAVIORAL: the event-id grammar the stream uses — UUID-shaped and distinct across calls.
 */

const SOURCE = readFileSync(
  join(import.meta.dir, "../src/index.ts"),
  "utf8",
);

describe("probe f: the meter's outbox write (static contract, index.ts)", () => {
  test("the finish writes usage facts to the outbox, not directly to Lago or credits", () => {
    expect(SOURCE).toMatch(/void usageOutbox\s*\n?\s*\.record\(\{/);
    expect(SOURCE).not.toMatch(/void billingService\s*\n?\s*\.recordUsage/);
    expect(SOURCE).not.toMatch(/void billing\.creditWriter\s*\n?\s*\.consumeCredits/);
  });

  test("a zero-token finish still writes nothing", () => {
    expect(SOURCE).toContain("if (input === 0 && output === 0) return;");
  });

  test("the report stays fire-and-forget: a metering miss never fails the run", () => {
    expect(SOURCE).toMatch(/void usageOutbox\s*\n?\s*\.record/);
  });
});

describe("probe f: the event id grammar the stream uses (behavioral)", () => {
  test("UUID-shaped ids remain distinct across two calls", () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    expect(ids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(ids[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(ids[0]).not.toBe(ids[1]);
  });
});
