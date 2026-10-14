import { describe, expect, test } from "bun:test";
import {
  OMIT_COPY_KEY,
  REDACTION_POLICY_VERSION,
  type OmitReason,
  type SafeText,
} from "../../shared/ai-observability";

const REASONS: OmitReason[] = [
  "credential",
  "connection_string",
  "account_identifier",
  "reasoning_content",
  "raw_attachment",
  "internal_capability",
  "unhandled_free_text",
];

describe("safe content contract", () => {
  test("the policy version is namespaced and exact", () => {
    expect(REDACTION_POLICY_VERSION).toBe("opik-redaction/1");
  });

  test("every omit reason maps to a copy key the UI already has", () => {
    for (const reason of REASONS) {
      expect(OMIT_COPY_KEY[reason], reason).toMatch(/^availability\./);
    }
    expect(Object.keys(OMIT_COPY_KEY).sort()).toEqual([...REASONS].sort());
  });

  test("an omitted projection never carries text", () => {
    const value: SafeText = { state: "omitted", reason: "credential" };
    expect("text" in value).toBe(false);
  });
});
