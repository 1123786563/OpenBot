import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { exactTokensOf } from "../src/ai-observability/execution-billing";

/**
 * The T28 crossover of the billing read (T28-billing): a completed case's usage is
 * `unknown` — the runner's own raw record, or the SafeValue envelope the T28
 * projection shapes, each count itself envelope-wrapped — and the exact-charge read
 * unwraps every honest spelling while refusing everything else to the unknown-cost
 * path. Never a zero (the T25 ruling). The wiring from these tokens to the charge
 * fact and the unknown-cost evidence row is the integration suite's work.
 */
describe("the exact-charge usage read unwraps every honest spelling and refuses the rest", () => {
  test("a raw record, an envelope over raw counts, and the T28 per-field envelope all yield the exact tokens", () => {
    expect(exactTokensOf({ inputTokens: 10, outputTokens: 20 })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(
      exactTokensOf({
        state: "projected",
        value: { inputTokens: 10, outputTokens: 20 },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(
      exactTokensOf({
        state: "projected",
        value: {
          inputTokens: { state: "projected", value: 10 },
          outputTokens: { state: "projected", value: 20 },
        },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  test("omitted and truncated envelopes carry no billable truth — null, never a zero", () => {
    expect(
      exactTokensOf({ state: "omitted", reason: "credential" }),
    ).toBeNull();
    expect(
      exactTokensOf({
        state: "truncated",
        value: { inputTokens: { state: "projected", value: 10 } },
        originalBytes: -1,
      }),
    ).toBeNull();
  });

  test("missing counts and counts that are not finite numbers stay unknown cost", () => {
    expect(exactTokensOf(undefined)).toBeNull();
    expect(exactTokensOf({ inputTokens: 10 })).toBeNull();
    expect(exactTokensOf({ inputTokens: "10", outputTokens: 20 })).toBeNull();
    expect(
      exactTokensOf({
        inputTokens: Number.POSITIVE_INFINITY,
        outputTokens: 20,
      }),
    ).toBeNull();
  });
});
