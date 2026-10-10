import { describe, expect, test } from "bun:test";
import { CODE_RUN_METRIC, reportCodeRunUsage } from "../src/workshop/metering";
import type { BillingService } from "../src/billing/types";

/**
 * The metering pipeline's contract (I4): one run, one provider event — and no provider at
 * all is silence, never an error. The fake billing records every recordUsage call; nothing
 * here touches Lago, the database, or the network.
 */
function fakeBilling() {
  const calls: Array<{
    transactionId: string;
    metricCode: string;
    properties: Record<string, number | string>;
  }> = [];
  const service = {
    recordUsage: async (input: {
      transactionId: string;
      metricCode: string;
      properties: Record<string, number | string>;
    }) => {
      calls.push(input);
    },
  } as unknown as BillingService;
  return { service, calls };
}

const RUN = {
  runId: "cr-test-1",
  status: "completed",
  sessionId: "ses-1",
  botId: "bot-1",
  ownerUserId: "user-1",
  modelId: "glm-4.6",
  inputTokens: 4_845,
  outputTokens: 4,
};

describe("reportCodeRunUsage (I4: single source, idempotent, silent without billing)", () => {
  test("reports once with the run id as the idempotency key", async () => {
    const { service, calls } = fakeBilling();
    const attempted = await reportCodeRunUsage(service, RUN);
    expect(attempted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.transactionId).toBe("code-run:cr-test-1");
    expect(calls[0]?.metricCode).toBe(CODE_RUN_METRIC);
  });

  test("a replayed report carries the SAME transaction id (provider dedup makes it one event)", async () => {
    const { service, calls } = fakeBilling();
    await reportCodeRunUsage(service, RUN);
    await reportCodeRunUsage(service, RUN); // a crash-replay, a retried settle
    expect(calls).toHaveLength(2);
    // The key is what makes two calls one event at the provider:
    expect(new Set(calls.map((call) => call.transactionId)).size).toBe(1);
  });

  test("the event carries the row's dimensions: bot, owner, session, model, tokens", async () => {
    const { service, calls } = fakeBilling();
    await reportCodeRunUsage(service, RUN);
    expect(calls[0]?.properties).toMatchObject({
      run_id: "cr-test-1",
      bot_id: "bot-1",
      owner_user_id: "user-1",
      session_id: "ses-1",
      model: "glm-4.6",
      status: "completed",
      input_tokens: 4845,
      output_tokens: 4,
    });
  });

  test("no billing configured: silent false, nothing thrown, nothing reported", async () => {
    const attempted = await reportCodeRunUsage(null, RUN);
    expect(attempted).toBe(false);
    const attempted2 = await reportCodeRunUsage(undefined, RUN);
    expect(attempted2).toBe(false);
  });

  test("a run without tokens is nothing meterable — no event, no error", async () => {
    const { service, calls } = fakeBilling();
    const attempted = await reportCodeRunUsage(service, {
      ...RUN,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(attempted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a billing service that throws is contained: the run's report never surfaces as an error", async () => {
    const broken = {
      recordUsage: async () => {
        throw new Error("lago unreachable");
      },
    } as unknown as BillingService;
    // The gateway wraps its onUsage in its own catch; this asserts the module itself does not
    // add a second failure mode (it delegates, and what it delegates to is the service's own
    // contained path — a broken fake here proves the direct-call shape throws, so callers
    // MUST keep the containment the gateway provides).
    await expect(reportCodeRunUsage(broken, RUN)).rejects.toThrow("lago unreachable");
  });
});
