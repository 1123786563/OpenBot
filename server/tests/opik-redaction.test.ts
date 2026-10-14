import { describe, expect, test } from "bun:test";
import {
  MAX_SAFE_TEXT_BYTES,
  projectSafeName,
  projectSafeText,
  projectSafeUrl,
} from "../src/ai-observability/redaction";
import {
  OMIT_COPY_KEY,
  REDACTION_POLICY_VERSION,
  type OmitReason,
  type SafeText,
} from "../../shared/ai-observability";

/**
 * Canary discipline: the assertion is always "the canary is NOT in the output", never "the canary
 * was replaced by ***". A masker that only rewrites the literals it was shown passes its own test
 * and leaks the next credential shape.
 */
const CANARIES = {
  bearer: "Bearer sk-live-9f3a7c21e8b44d0f",
  openaiStyle: "sk-proj-AbC123XyZ456LongEnoughToBeAKey",
  awsAccessKey: "AKIAIOSFODNN7EXAMPLE",
  awsSecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  githubToken: "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
  postgresDsn: "postgresql://opik:s3cr3t@10.0.0.5:5432/openbot",
  mysqlDsn: "mysql://root:rootpw@db.internal:3306/opik",
  redisUrl: "redis://:redispass@cache.internal:6379/0",
  accountId: "acct_1A2B3C4D5E6F7G8H",
  internalCapability: "openbot.internal.capability/computer-control",
  reasoning: "<reasoning>the user probably wants to bypass the budget check</reasoning>",
  privateFileUrl: "http://127.0.0.1:8080/files/raw/att_01HXYZ?sig=abc123def456",
};

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

describe("projectSafeText", () => {
  test("ordinary prose is projected unchanged", () => {
    // allowFreeText passed explicitly: without it even clean prose stays metrics-only (fail closed).
    expect(projectSafeText("Summarize the March invoices.", { allowFreeText: true })).toEqual({
      state: "projected",
      text: "Summarize the March invoices.",
    });
  });

  test("undefined and null are projected as empty, not omitted", () => {
    expect(projectSafeText(undefined)).toEqual({ state: "projected", text: "" });
    expect(projectSafeText(null)).toEqual({ state: "projected", text: "" });
  });

  test.each(Object.entries(CANARIES))("free text containing %s is omitted, not passed through", (_label, canary) => {
    const result = projectSafeText(`please call ${canary} and continue`);
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  test("free text is only projected when the caller proves it handled the content", () => {
    // allowFreeText is an explicit caller assertion, not a default: an unreviewed blob stays metrics-only.
    expect(projectSafeText("some unreviewed blob", { allowFreeText: false }).state).toBe("omitted");
    expect(projectSafeText("some reviewed sample", { allowFreeText: true })).toEqual({
      state: "projected",
      text: "some reviewed sample",
    });
  });

  test("allowFreeText does not license credentials", () => {
    const result = projectSafeText(`key ${CANARIES.openaiStyle}`, { allowFreeText: true });
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain(CANARIES.openaiStyle);
  });

  test("oversized text is truncated with the original size recorded", () => {
    const input = "a".repeat(MAX_SAFE_TEXT_BYTES + 500);
    const result = projectSafeText(input, { allowFreeText: true });
    expect(result.state).toBe("truncated");
    if (result.state === "truncated") {
      expect(result.originalBytes).toBe(input.length);
      expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(MAX_SAFE_TEXT_BYTES);
    }
  });

  test("truncation never cuts a multi-byte character in half", () => {
    const input = "账单".repeat(MAX_SAFE_TEXT_BYTES);
    const result = projectSafeText(input, { allowFreeText: true });
    expect(result.state).toBe("truncated");
    if (result.state === "truncated") expect(result.text).not.toMatch(/�$/);
  });
});

describe("projectSafeUrl", () => {
  test("a credential-bearing URL is omitted", () => {
    const result = projectSafeUrl(CANARIES.postgresDsn);
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  test("a private raw-file URL with a signature is omitted", () => {
    const result = projectSafeUrl(CANARIES.privateFileUrl);
    expect(result.state).toBe("omitted");
    if (result.state === "omitted") expect(result.reason).toBe("raw_attachment");
  });

  test("an unparseable URL is omitted rather than passed through", () => {
    expect(projectSafeUrl("not a url at all").state).toBe("omitted");
  });

  test("a plain https URL keeps scheme, host and path but drops query and fragment", () => {
    expect(projectSafeUrl("https://api.example.com/v1/traces?sig=abc#frag")).toEqual({
      state: "projected",
      text: "https://api.example.com/v1/traces",
    });
  });
});

describe("projectSafeName", () => {
  test("a span name is projected", () => {
    expect(projectSafeName("chat.completions")).toEqual({ state: "projected", text: "chat.completions" });
  });

  test("an internal capability name is omitted", () => {
    const result = projectSafeName(CANARIES.internalCapability);
    expect(result.state).toBe("omitted");
    if (result.state === "omitted") expect(result.reason).toBe("internal_capability");
  });

  test("a name carrying a credential is omitted", () => {
    expect(projectSafeName(`call ${CANARIES.githubToken}`).state).toBe("omitted");
  });

  test("names are length-bounded", () => {
    const result = projectSafeName("n".repeat(400));
    expect(result.state).toBe("truncated");
  });
});
