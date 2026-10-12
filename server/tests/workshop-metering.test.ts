import { describe, expect, test } from "bun:test";
import {
  calculateExactModelUsageCharge,
  CODE_RUN_METRIC,
  reportCodeRunUsage,
  UsageChargeError,
} from "../src/workshop/metering";
import type { UsageOutbox, UsageOutboxInput } from "../src/billing/usage-outbox";

/**
 * The metering pipeline's contract (I4): one run, one provider event — and no provider at
 * all is silence, never an error. The fake billing records every recordUsage call; nothing
 * here touches Lago, the database, or the network.
 */
function fakeOutbox() {
  const calls: UsageOutboxInput[] = [];
  const outbox = {
    record: async (input: UsageOutboxInput) => {
      calls.push(input);
      return { inserted: true };
    },
  } as unknown as UsageOutbox;
  return { outbox, calls };
}

const RUN = {
  runId: "cr-test-1",
  status: "completed",
  sessionId: "ses-1",
  botId: "bot-1",
  ownerUserId: "user-1",
  externalCustomerId: "cust-1",
  modelId: "glm-4.6",
  inputTokens: 4_845,
  outputTokens: 4,
  occurredAt: new Date("2026-10-12T03:04:05.000Z"),
};

describe("reportCodeRunUsage (I4: single source, idempotent, silent without billing)", () => {
  test("records one immutable outbox event keyed by the run id", async () => {
    const { outbox, calls } = fakeOutbox();
    const attempted = await reportCodeRunUsage(outbox, RUN as never);
    expect(attempted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      eventId: "code-run:cr-test-1",
      source: "code_run",
      externalCustomerId: "cust-1",
      transactionId: "code-run:cr-test-1",
      inputTokens: 4845,
      outputTokens: 4,
      model: "glm-4.6",
      client: "web",
      occurredAt: RUN.occurredAt,
      runId: "cr-test-1",
      botId: "bot-1",
      ownerUserId: "user-1",
      sessionId: "ses-1",
      status: "completed",
    });
  });

  describe("calculateExactModelUsageCharge", () => {
    const policy = {
      input: {
        rate: { numerator: 3n, denominator: 2n },
        maximumTokens: 10n,
        maximumCostUnits: 15n,
      },
      output: {
        rate: { numerator: 5n, denominator: 4n },
        maximumTokens: 8n,
        maximumCostUnits: 10n,
      },
      maximumReservationUnits: 25n,
    };

    test("adds exact rational input and output charges without rounding away the remainder", () => {
      expect(
        calculateExactModelUsageCharge(policy, {
          inputTokens: 3,
          outputTokens: 2,
        }),
      ).toEqual({
        inputTokens: 3,
        outputTokens: 2,
        actual: { numerator: 7n, denominator: 1n },
      });
    });

    test("refuses usage that exceeds the configured token ceiling", () => {
      expect(() =>
        calculateExactModelUsageCharge(policy, {
          inputTokens: 11,
          outputTokens: 0,
        }),
      ).toThrow(
        expect.objectContaining({
          name: UsageChargeError.name,
          code: "usage_over_token_max",
        }),
      );
    });

    test("usage exactly at the configured token ceiling charges at the ceiling cost", () => {
      // The same limits admission enforces: exactly-at-limit is admitted, and the
      // whole-celling charge equals the configured maximum reservation.
      expect(
        calculateExactModelUsageCharge(policy, {
          inputTokens: 10,
          outputTokens: 8,
        }),
      ).toEqual({
        inputTokens: 10,
        outputTokens: 8,
        actual: { numerator: 25n, denominator: 1n },
      });
    });
  });

  test("a replayed report carries identical immutable facts for the same run", async () => {
    const { outbox, calls } = fakeOutbox();
    await reportCodeRunUsage(outbox, RUN as never);
    await reportCodeRunUsage(outbox, RUN as never); // a crash-replay, a retried settle
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
  });

  test("the event keeps the provider metric constant alongside the persisted facts", async () => {
    expect(CODE_RUN_METRIC).toBe("code_run_tokens");
  });

  test("no outbox configured: silent false, nothing thrown, nothing recorded", async () => {
    const attempted = await reportCodeRunUsage(null, RUN as never);
    expect(attempted).toBe(false);
    const attempted2 = await reportCodeRunUsage(undefined, RUN as never);
    expect(attempted2).toBe(false);
  });

  test("a run without tokens is nothing meterable — no event, no error", async () => {
    const { outbox, calls } = fakeOutbox();
    const attempted = await reportCodeRunUsage(outbox, {
      ...RUN,
      inputTokens: 0,
      outputTokens: 0,
    } as never);
    expect(attempted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("an outbox write that throws is contained by the caller, not this helper", async () => {
    const broken = {
      record: async () => {
        throw new Error("usage-outbox down");
      },
    } as unknown as UsageOutbox;
    // The gateway wraps its onUsage in its own catch; this asserts the module itself does not
    // add a second failure mode (it delegates, and what it delegates to is the service's own
    // contained path — a broken fake here proves the direct-call shape throws, so callers
    // MUST keep the containment the gateway provides).
    await expect(reportCodeRunUsage(broken, RUN as never)).rejects.toThrow(
      "usage-outbox down",
    );
  });
});
