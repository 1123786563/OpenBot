import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { invocationEnvelopeDigest } from "../../src/enterprise/runtime/envelope-digest";
import type { RuntimeInvocation } from "../../src/enterprise/runtime/wire";

const INVOCATION: RuntimeInvocation = {
  schema_version: "1",
  tenant_id: "tenant-1",
  principal_id: "principal-1",
  actor_id: "actor-1",
  initiator_kind: "user",
  run_id: "run-1",
  attempt_id: "attempt-1",
  turn_id: "turn-1",
  thread_id: "thread-1",
  expert_version: "assistant-v1",
  input_digest: "abcd1234",
  model_route_ref: "route-1",
  budget_reservation_id: "res-1",
  lease_id: "lease-1",
  fencing_token: "3",
  expires_at: "2026-10-10T12:00:00Z",
};

describe("invocationEnvelopeDigest (frozen)", () => {
  test("golden vector: the digest for this envelope is these exact bytes, forever", () => {
    expect(invocationEnvelopeDigest(INVOCATION)).toBe(
      "06d2fcf3fa030abec8b9dc05ff29d02f58e6e1962830b935580bed58ba279b42",
    );
  });

  test("key order in the caller's object never changes the digest", () => {
    const shuffled: Record<string, string> = {};
    for (const key of Object.keys(INVOCATION).reverse()) {
      const value = INVOCATION[key as keyof RuntimeInvocation];
      if (value !== undefined) {
        shuffled[key] = value;
      }
    }
    expect(invocationEnvelopeDigest(shuffled as RuntimeInvocation)).toBe(
      invocationEnvelopeDigest(INVOCATION),
    );
  });

  test("one changed field is a different digest", () => {
    const tampered = { ...INVOCATION, run_id: "run-2" };
    expect(invocationEnvelopeDigest(tampered)).not.toBe(
      invocationEnvelopeDigest(INVOCATION),
    );
  });

  test("U+2028/U+2029 are escaped in the frozen form, not left to the runtime's dialect", () => {
    const withSeparator = { ...INVOCATION, input_digest: "a\u2028b" };
    const digest = invocationEnvelopeDigest(withSeparator);
    // A raw (unescaped) serialization would hash different bytes: pin the escaped spelling.
    const raw = JSON.stringify(
      Object.keys(withSeparator)
        .sort()
        .reduce<Record<string, string>>((acc, key) => {
          const value = withSeparator[key as keyof RuntimeInvocation];
          if (value !== undefined) {
            acc[key] = value;
          }
          return acc;
        }, {}),
    );
    const escaped = raw.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    expect(digest).not.toBe(
      // Hash of the raw spelling — if this ever equals, the freeze was broken.
      invocationEnvelopeDigestOfRaw(raw),
    );
    expect(digest).toBe(invocationEnvelopeDigestOfRaw(escaped));
  });
});

function invocationEnvelopeDigestOfRaw(canonicalJson: string): string {
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}
