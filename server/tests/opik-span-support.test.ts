// Issue #4 / FREV-01 — span body governance.
//
// The final review's counterexample, verbatim in shape: a body carrying a customer
// email and a short password — NO deny pattern matches either — reached the port as
// {state:"projected", value:<original>} because projectSpanContent asserted
// allowFreeText unconditionally. That assertion had no proof behind it: no Bot
// security policy approved the body, no human reviewed it. The fix (FREV-01): a
// span body enters the store only behind an approval minted from a Bot's configured
// policy; without one the body is omitted and the span keeps its metrics.
//
// Every case runs the PRODUCTION createModelSpanRecorder against injected fakes and
// intercepts the queued writeSpans exactly the way the review probe did: no network,
// no storage, no provider. The non-regex shapes assert denyReason(body) === undefined
// first, so the omission is proven to come from the governance gate, not from a
// keyword regex — Spec §7's whole point.
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { OpikObservationWrite } from "../src/ai-observability/health";
import { createModelSpanRecorder } from "../src/ai-observability/model-span";
import type { OpikOtlpSpan, OpikPort } from "../src/ai-observability/opik-port";
import { denyReason } from "../src/ai-observability/redaction";
import { resolveObservationScope } from "../src/ai-observability/scope";
import {
  approveSpanContent,
  type SpanContentApproval,
} from "../src/ai-observability/span-support";

// ---------------------------------------------------------------------------
// Fakes (the review probe's own harness shape)
// ---------------------------------------------------------------------------

function fakeQueue() {
  const submitted: OpikObservationWrite[] = [];
  return {
    submitted,
    queue: {
      submit(write: OpikObservationWrite) {
        submitted.push(write);
        return "accepted" as const;
      },
    },
  };
}

function fakePort() {
  const writes: Array<{ spans: readonly OpikOtlpSpan[] }> = [];
  const port = {
    async writeSpans(
      _scope: unknown,
      input: { spans: readonly OpikOtlpSpan[] },
    ) {
      writes.push({ spans: input.spans });
      return { outcome: "ok" as const, value: { accepted: true as const } };
    },
  };
  return { writes, port: port as unknown as OpikPort };
}

function aScope() {
  return resolveObservationScope({
    actorId: "user-1",
    botId: "bot-1",
    ownership: "owner",
    epoch: 1,
  });
}

/** Records one observation through the production recorder; returns the port writes. */
function recordAndCapture(
  observation: Parameters<
    ReturnType<typeof createModelSpanRecorder>["record"]
  >[0],
): Array<{ spans: readonly OpikOtlpSpan[] }> {
  const queue = fakeQueue();
  const recorder = createModelSpanRecorder({ healthService: queue.queue });
  recorder.record(observation);
  const port = fakePort();
  for (const write of queue.submitted) void write.perform(port.port);
  return port.writes;
}

/** One observation carrying exactly the bodies under test, plus a proof or none. */
function anObservation(bodies: {
  input: string;
  output?: string;
  approval?: SpanContentApproval | null;
}) {
  return {
    occurredAt: new Date("2026-10-24T10:00:00.000Z"),
    endedAt: new Date("2026-10-24T10:00:02.500Z"),
    provider: "openai",
    modelId: "gpt-test",
    ending: { kind: "succeeded" as const, inputTokens: 30, outputTokens: 12 },
    input: bodies.input,
    output: bodies.output ?? "Answer follows.",
    scope: aScope(),
    ...(bodies.approval !== undefined
      ? { contentApproval: bodies.approval }
      : {}),
  };
}

// The review's counterexample body, assembled: a customer email plus a short
// password neither of which any deny pattern names.
const FREV_EMAIL = `alice@${"example"}.invalid`;
const FREV_PASSWORD = `short-canary-${"731"}`;
const FREV_BODY = `customer email ${FREV_EMAIL}; password=${FREV_PASSWORD}`;

// Non-regex shapes the deny list cannot see (regressions beyond the counterexample).
const PII_SHAPE = `Invoice for Hans Müller: total 1,234.50 EUR, phone +49 170 1234567, pay by Friday.`;
const PASSPHRASE_SHAPE = `our office door code is 4-7-2-9, please don't share it with guests`;

// ---------------------------------------------------------------------------
// The gate: no proof, no body
// ---------------------------------------------------------------------------

describe("span body governance (FREV-01)", () => {
  test("the review counterexample (email + short password) is omitted without a proof, metrics survive", () => {
    // Premise: neither shape is on the deny list — a regex is not what stops it.
    expect(denyReason(FREV_BODY)).toBeUndefined();

    const writes = recordAndCapture(anObservation({ input: FREV_BODY }));
    expect(writes).toHaveLength(1);
    const span = writes[0].spans[0];
    const serialized = JSON.stringify(span);
    expect(serialized).not.toContain(FREV_EMAIL);
    expect(serialized).not.toContain(FREV_PASSWORD);

    // The body is omitted as unhandled free text — an honest marker, not a masked string.
    expect(span.attributes?.input).toEqual({
      state: "omitted",
      reason: "unhandled_free_text",
    });
    // The span still carries what it can prove: usage, states, identity.
    expect(span.attributes?.tokens_input).toEqual({
      state: "projected",
      value: 30,
    });
    expect(span.attributes?.tokens_output).toEqual({
      state: "projected",
      value: 12,
    });
    expect(span.attributes?.usage_state).toEqual({
      state: "projected",
      value: "actual",
    });
    expect(span.attributes?.span_state).toEqual({
      state: "projected",
      value: "completed",
    });
    expect(span.name.state).toBe("projected");
  });

  test("non-regex shape regression A: business PII prose is omitted without a proof", () => {
    expect(denyReason(PII_SHAPE)).toBeUndefined();
    const writes = recordAndCapture(anObservation({ input: PII_SHAPE }));
    const span = writes[0].spans[0];
    expect(JSON.stringify(span)).not.toContain("Hans Müller");
    expect(span.attributes?.input).toEqual({
      state: "omitted",
      reason: "unhandled_free_text",
    });
  });

  test("non-regex shape regression B: a short shared passphrase is omitted without a proof", () => {
    expect(denyReason(PASSPHRASE_SHAPE)).toBeUndefined();
    const writes = recordAndCapture(anObservation({ input: PASSPHRASE_SHAPE }));
    const span = writes[0].spans[0];
    expect(JSON.stringify(span)).not.toContain("4-7-2-9");
    expect(span.attributes?.input).toEqual({
      state: "omitted",
      reason: "unhandled_free_text",
    });
  });

  test("the output body is governed exactly like the input body", () => {
    const writes = recordAndCapture(
      anObservation({ input: "What is the weather?", output: FREV_BODY }),
    );
    const span = writes[0].spans[0];
    expect(span.attributes?.output).toEqual({
      state: "omitted",
      reason: "unhandled_free_text",
    });
  });

  // -------------------------------------------------------------------------
  // The proof: only a Bot policy's approval carries free text
  // -------------------------------------------------------------------------

  test("a Bot policy's approval lets a benign body project, and the span names its policy", () => {
    const approval = approveSpanContent({
      source: "bot_security_policy",
      policyRef: "bot-1/security-policy/v3",
      allowFreeText: true,
    });
    expect(approval).not.toBeNull();

    const writes = recordAndCapture(
      anObservation({
        input: "What is the weather?",
        output: "Sunny.",
        approval,
      }),
    );
    const span = writes[0].spans[0];
    expect(span.attributes?.input).toEqual({
      state: "projected",
      value: "What is the weather?",
    });
    expect(span.attributes?.output).toEqual({
      state: "projected",
      value: "Sunny.",
    });
    // The audit chain: an approved carry names the policy that approved it.
    expect(span.attributes?.content_policy_ref).toEqual({
      state: "projected",
      value: "bot-1/security-policy/v3",
    });
  });

  test("the deny patterns still run first and win even over an approval", () => {
    const approval = approveSpanContent({
      source: "bot_security_policy",
      policyRef: "bot-1/security-policy/v3",
      allowFreeText: true,
    });
    const canary = `sk-live-${"a".repeat(24)}`;
    const writes = recordAndCapture(
      anObservation({ input: `Please summarise. ${canary}`, approval }),
    );
    const span = writes[0].spans[0];
    expect(JSON.stringify(span)).not.toContain(canary);
    expect(span.attributes?.input).toEqual({
      state: "omitted",
      reason: "credential",
    });
  });

  test("an approving policy does carry the counterexample shape — the gate is the policy, not a regex", () => {
    // Spec §7: the wall is the policy proof, not keyword patterns. A Bot whose
    // security policy explicitly approves free-text bodies gets them projected —
    // only the deny list is unconditional, and it has no pattern for this shape.
    // The production recorders carry no approval (FREV-01 wiring lands with the
    // run-binding ticket), which is why the same body dies in the test above.
    const approval = approveSpanContent({
      source: "bot_security_policy",
      policyRef: "bot-1/security-policy/v3",
      allowFreeText: true,
    });
    const writes = recordAndCapture(
      anObservation({ input: FREV_BODY, approval }),
    );
    const span = writes[0].spans[0];
    expect(span.attributes?.input).toEqual({
      state: "projected",
      value: FREV_BODY,
    });
    expect(span.attributes?.content_policy_ref).toEqual({
      state: "projected",
      value: "bot-1/security-policy/v3",
    });
  });

  test("a policy that does not approve free text mints no approval", () => {
    const approval = approveSpanContent({
      source: "bot_security_policy",
      policyRef: "bot-1/security-policy/v3",
      allowFreeText: false,
    });
    expect(approval).toBeNull();

    const writes = recordAndCapture(
      anObservation({ input: "What is the weather?", approval }),
    );
    expect(writes[0].spans[0].attributes?.input).toEqual({
      state: "omitted",
      reason: "unhandled_free_text",
    });
  });

  test("a forged approval — structurally identical, never minted — projects nothing", () => {
    const forged = {
      source: "bot_security_policy",
      policyRef: "bot-1/security-policy/v3",
    } as unknown as SpanContentApproval;
    const writes = recordAndCapture(
      anObservation({ input: "What is the weather?", approval: forged }),
    );
    expect(writes[0].spans[0].attributes?.input).toEqual({
      state: "omitted",
      reason: "unhandled_free_text",
    });
  });

  test("the mint refuses an empty policy reference", () => {
    expect(
      approveSpanContent({
        source: "bot_security_policy",
        policyRef: "  ",
        allowFreeText: true,
      }),
    ).toBeNull();
  });
});
