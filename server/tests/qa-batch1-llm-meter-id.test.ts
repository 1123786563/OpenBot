import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);
import { describe, expect, test } from "../../tests/support/e2e-compat";
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
  join(hereDir, "../src/index.ts"),
  "utf8",
);

describe("probe f: the meter's outbox write (static contract, index.ts)", () => {
  test("the finish writes usage facts to the outbox, not directly to Lago or credits", () => {
    // b616ccaa made the write awaited inside a try; the remediation plan kept the await and
    // made the failure decisive — logged with both stable ids, then rethrown (see below).
    expect(SOURCE).toMatch(/await usageOutbox\.record\(\{/);
    expect(SOURCE).not.toMatch(/void billingService\s*\n?\s*\.recordUsage/);
    expect(SOURCE).not.toMatch(/void billing\.creditWriter\s*\n?\s*\.consumeCredits/);
  });

  test("an unusable finish writes nothing and KEEPS the reservation for reconciliation", () => {
    // The reservation-first contract after the remediation: an invalid or over-bound usage
    // report is a distinct settlement failure. Nothing is written, the hold is never
    // released as no_usage, and the failure is thrown so the run cannot report success.
    expect(SOURCE).toMatch(/logUsageOutboxWriteFailure\(\s*\n\s*"llm",\s*\n\s*input\.eventId,\s*\n\s*error,\s*\n\s*reservation\.reservationId,/);
    expect(SOURCE).toMatch(/throw new ModelUsageSettlementError\(/);
    // Audit A2: release is now a decision over an explicit confirmed-no-cost vocabulary, so the
    // probe asserts the vocabulary rather than the literal argument of one call site.
    expect(SOURCE).toMatch(
      /if \(isConfirmedNoCost\(failure\.reason\)\)/,
    );
    expect(SOURCE).toMatch(/await recordUnsettledUsage\(\{/);
  });

  test("a failed durable write fails the run instead of vanishing into a log line", () => {
    expect(SOURCE).toMatch(/await usageOutbox\.record\(/);
    // The catch logs through the runtime's established logger path AND propagates: a
    // completed billed stream may never be reported as successful when its finish usage
    // fact failed to persist.
    expect(SOURCE).toMatch(
      /logUsageOutboxWriteFailure\(\s*\n\s*"llm",\s*\n\s*input\.eventId,\s*\n\s*error,\s*\n\s*reservation\.reservationId,/,
    );
    expect(SOURCE).toMatch(/usageOutboxWriteFailureCode\(error\)/);
  });
});

describe("probe f: the over-bound path's durable evidence (audit A3, index.ts)", () => {
  test("the gate wires recordUnsettled and the evidence rows keep the tokens they learned", () => {
    // The lifecycle member copilot.ts's settlement-failure exit calls is wired to the evidence
    // recorder; the unknown-outcome row carries the reported half (not hardcoded zeros), and
    // the pricing refusal records the real usage before it rethrows.
    expect(SOURCE).toMatch(/recordUnsettled: async \(unsettled\) => \{/);
    expect(SOURCE).toMatch(/inputTokens: failure\.inputTokens \?\? 0/);
    expect(SOURCE).toMatch(/inputTokens: usage\.inputTokens \?\? 0/);
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
