import { describe, expect, test } from "bun:test";
import {
  DEFAULT_METADATA_ALLOWLIST,
  MAX_SAFE_RECORD_DEPTH,
  MAX_SAFE_TEXT_BYTES,
  projectSafeException,
  projectSafeMetadata,
  projectSafeName,
  projectSafeRecord,
  projectSafeText,
  projectSafeUrl,
} from "../src/ai-observability/redaction";
import {
  OMIT_COPY_KEY,
  REDACTION_POLICY_VERSION,
  type OmitReason,
  type SafeText,
  type SafeValue,
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
  reasoning:
    "<reasoning>the user probably wants to bypass the budget check</reasoning>",
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
    expect(
      projectSafeText("Summarize the March invoices.", { allowFreeText: true }),
    ).toEqual({
      state: "projected",
      text: "Summarize the March invoices.",
    });
  });

  test("undefined and null are projected as empty, not omitted", () => {
    expect(projectSafeText(undefined)).toEqual({
      state: "projected",
      text: "",
    });
    expect(projectSafeText(null)).toEqual({ state: "projected", text: "" });
  });

  test.each(Object.entries(CANARIES))(
    "free text containing %s is omitted, not passed through",
    (_label, canary) => {
      const result = projectSafeText(`please call ${canary} and continue`);
      expect(result.state).toBe("omitted");
      expect(JSON.stringify(result)).not.toContain(canary);
    },
  );

  test("free text is only projected when the caller proves it handled the content", () => {
    // allowFreeText is an explicit caller assertion, not a default: an unreviewed blob stays metrics-only.
    expect(
      projectSafeText("some unreviewed blob", { allowFreeText: false }).state,
    ).toBe("omitted");
    expect(
      projectSafeText("some reviewed sample", { allowFreeText: true }),
    ).toEqual({
      state: "projected",
      text: "some reviewed sample",
    });
  });

  test("allowFreeText does not license credentials", () => {
    const result = projectSafeText(`key ${CANARIES.openaiStyle}`, {
      allowFreeText: true,
    });
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain(CANARIES.openaiStyle);
  });

  test("oversized text is truncated with the original size recorded", () => {
    const input = "a".repeat(MAX_SAFE_TEXT_BYTES + 500);
    const result = projectSafeText(input, { allowFreeText: true });
    expect(result.state).toBe("truncated");
    if (result.state === "truncated") {
      expect(result.originalBytes).toBe(input.length);
      expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(
        MAX_SAFE_TEXT_BYTES,
      );
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
    if (result.state === "omitted")
      expect(result.reason).toBe("raw_attachment");
  });

  test("an unparseable URL is omitted rather than passed through", () => {
    expect(projectSafeUrl("not a url at all").state).toBe("omitted");
  });

  test("a plain https URL keeps scheme, host and path but drops query and fragment", () => {
    expect(
      projectSafeUrl("https://api.example.com/v1/traces?sig=abc#frag"),
    ).toEqual({
      state: "projected",
      text: "https://api.example.com/v1/traces",
    });
  });
});

describe("projectSafeName", () => {
  test("a span name is projected", () => {
    expect(projectSafeName("chat.completions")).toEqual({
      state: "projected",
      text: "chat.completions",
    });
  });

  test("an internal capability name is omitted", () => {
    const result = projectSafeName(CANARIES.internalCapability);
    expect(result.state).toBe("omitted");
    if (result.state === "omitted")
      expect(result.reason).toBe("internal_capability");
  });

  test("a name carrying a credential is omitted", () => {
    expect(projectSafeName(`call ${CANARIES.githubToken}`).state).toBe(
      "omitted",
    );
  });

  test("names are length-bounded", () => {
    const result = projectSafeName("n".repeat(400));
    expect(result.state).toBe("truncated");
  });
});

function values(record: Record<string, SafeValue>): string {
  return JSON.stringify(record);
}

describe("projectSafeRecord", () => {
  test("only allowlisted keys survive", () => {
    const result = projectSafeRecord(
      {
        model: "gpt-4o",
        tokensInput: 12,
        prompt: "hello",
        apiKey: CANARIES.openaiStyle,
      },
      ["model", "tokensInput"],
    );
    expect(Object.keys(result).sort()).toEqual(["model", "tokensInput"]);
    expect(values(result)).not.toContain(CANARIES.openaiStyle);
  });

  test("a key absent from the allowlist is dropped, not shown as omitted", () => {
    const result = projectSafeRecord({ model: "gpt-4o" }, ["tokensInput"]);
    expect(result).toEqual({});
  });

  test("an allowlisted key whose VALUE is a credential is omitted with a reason", () => {
    const result = projectSafeRecord({ model: CANARIES.bearer }, ["model"]);
    expect(result.model.state).toBe("omitted");
    expect(values(result)).not.toContain("sk-live-9f3a7c21e8b44d0f");
  });

  test("nested objects are projected to the depth limit and then omitted", () => {
    // Leaf string must not collide with SafeValue's own `value` key name, or the JSON
    // serialization of any legal output would contain it regardless of the depth cut.
    let deep: Record<string, unknown> = { leaf: "deep-secret-leaf" };
    for (let i = 0; i < MAX_SAFE_RECORD_DEPTH + 2; i += 1)
      deep = { nested: deep };
    const result = projectSafeRecord(deep, ["nested"]);
    expect(values(result)).not.toContain("deep-secret-leaf");
  });

  test("a non-object input yields an empty record rather than throwing", () => {
    expect(projectSafeRecord("a string", ["a"])).toEqual({});
    expect(projectSafeRecord(null, ["a"])).toEqual({});
    expect(projectSafeRecord(undefined, ["a"])).toEqual({});
  });

  test("arrays inside an allowlisted key are projected element-wise", () => {
    const result = projectSafeRecord(
      { tools: ["search", CANARIES.internalCapability] },
      ["tools"],
    );
    const value = result.tools;
    expect(value.state).toBe("projected");
    expect(values(result)).not.toContain("computer-control");
  });
});

describe("projectSafeMetadata", () => {
  test("the default allowlist is small and contains no free-text field", () => {
    expect(DEFAULT_METADATA_ALLOWLIST.length).toBeLessThanOrEqual(16);
    for (const key of [
      "input",
      "output",
      "messages",
      "content",
      "body",
      "prompt",
      "text",
    ]) {
      expect(
        DEFAULT_METADATA_ALLOWLIST,
        `${key} must not be a default metadata key`,
      ).not.toContain(key);
    }
  });

  test("SDK auto-captured keys outside the allowlist never reach the store", () => {
    const result = projectSafeMetadata({
      thread_id: "thread-1",
      bot_id: "agent-1",
      run_id: "run-1",
      user_email: "dana@example.com",
      authorization: CANARIES.bearer,
      environment: "test",
    });
    expect(values(result)).not.toContain("dana@example.com");
    expect(values(result)).not.toContain("sk-live");
    expect(Object.keys(result)).toContain("thread_id");
  });
});

describe("projectSafeException", () => {
  test("a message carrying a DSN is omitted", () => {
    const error = new Error(`connection failed for ${CANARIES.mysqlDsn}`);
    const result = projectSafeException(error);
    expect(result.state).toBe("omitted");
    expect(values({ m: result })).not.toContain("rootpw");
  });

  test("a clean message is projected without the stack trace", () => {
    const result = projectSafeException(new Error("upstream returned 503"));
    expect(result).toEqual({
      state: "projected",
      text: "upstream returned 503",
    });
  });

  test("a non-Error value is projected as its class name, never as its content", () => {
    expect(projectSafeException({ secret: CANARIES.awsSecret })).toEqual({
      state: "projected",
      text: "Object",
    });
    expect(projectSafeException("boom")).toEqual({
      state: "projected",
      text: "String",
    });
  });

  test("an Error subclass keeps its name", () => {
    class UpstreamTimeout extends Error {}
    expect(projectSafeException(new UpstreamTimeout("timed out"))).toEqual({
      state: "projected",
      text: "UpstreamTimeout: timed out",
    });
  });
});
