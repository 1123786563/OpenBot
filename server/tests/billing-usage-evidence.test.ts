import { describe, expect, test } from "bun:test";
import {
  createUsageEvidenceRecorder,
  isConfirmedNoCost,
  type UnsettledUsageInput,
} from "../src/billing/usage-evidence";
import { UsageOutboxConflictError } from "../src/billing/usage-outbox";

const input: UnsettledUsageInput = {
  eventId: "ev-1",
  source: "llm",
  externalCustomerId: "openbot-deployment-t1",
  model: "GLM-5.3",
  client: "web",
  occurredAt: new Date("2026-10-14T00:00:00.000Z"),
  inputTokens: 0,
  outputTokens: 0,
  reason: "usage_missing",
};

describe("the unsettled-usage evidence recorder", () => {
  test("writes a durable outbox row with no reservation facts, so both targets end in evidence", async () => {
    const rows: unknown[] = [];
    const record = createUsageEvidenceRecorder({
      record: async (row) => {
        rows.push(row);
        return { inserted: true };
      },
    });
    await record(input);
    expect(rows).toEqual([
      {
        eventId: "ev-1",
        source: "llm",
        externalCustomerId: "openbot-deployment-t1",
        transactionId: "ev-1",
        inputTokens: 0,
        outputTokens: 0,
        model: "GLM-5.3",
        client: "web",
        occurredAt: input.occurredAt,
        reservationId: null,
        actualCostNumerator: null,
        actualCostDenominator: null,
        status: "usage_missing",
      },
    ]);
  });

  test("a conflicting row (real facts already committed) is a superseded evidence write, not a failure", async () => {
    const messages: string[] = [];
    const record = createUsageEvidenceRecorder(
      {
        record: async () => {
          throw new UsageOutboxConflictError("ev-1");
        },
      },
      (message) => messages.push(message),
    );
    await record(input);
    expect(messages.join("\n")).toContain("usage_evidence_superseded");
  });

  test("a rejected write is logged with both stable ids and never throws into the run", async () => {
    const messages: string[] = [];
    const record = createUsageEvidenceRecorder(
      {
        record: async () => {
          throw new Error("connection reset");
        },
      },
      (message) => messages.push(message),
    );
    await record(input);
    expect(messages.join("\n")).toContain("usage_evidence_write_failed");
    expect(messages.join("\n")).not.toContain("connection reset");
  });
});

describe("which failure reasons may release a hold", () => {
  test.each([
    ["provider_error", true],
    ["bound_refused", true],
    ["no_usage", true],
    ["usage_missing", false],
    ["stream_error", false],
    ["cancelled", false],
  ])("%s releases the reservation: %s", (reason, releases) => {
    expect(isConfirmedNoCost(reason)).toBe(releases);
  });
});
