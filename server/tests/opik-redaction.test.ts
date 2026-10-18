import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  OMIT_COPY_KEY,
  type OmitReason,
  REDACTION_POLICY_VERSION,
  type SafeText,
  type SafeValue,
} from "../../shared/ai-observability";
import {
  DEFAULT_METADATA_ALLOWLIST,
  MAX_SAFE_RECORD_DEPTH,
  MAX_SAFE_RECORD_KEYS,
  MAX_SAFE_TEXT_BYTES,
  projectSafeException,
  projectSafeMetadata,
  projectSafeName,
  projectSafeRecord,
  projectSafeText,
  projectSafeUrl,
} from "../src/ai-observability/redaction";

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
  slackToken: "xoxb-2143456789-2143456789012-AbCdEfGhIjKlMnOpQrStUvWx",
  pemKey:
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAAbW9wNTJz\r\n-----END OPENSSH PRIVATE KEY-----",
  postgresDsn: "postgresql://opik:s3cr3t@10.0.0.5:5432/openbot",
  mysqlDsn: "mysql://root:rootpw@db.internal:3306/opik",
  redisUrl: "redis://:redispass@cache.internal:6379/0",
  accountId: "acct_1A2B3C4D5E6F7G8H",
  internalCapability: "openbot.internal.capability/computer-control",
  reasoning:
    "<reasoning>the user probably wants to bypass the budget check</reasoning>",
  privateFileUrl: "http://127.0.0.1:8080/files/raw/att_01HXYZ?sig=abc123def456",
  // T05 review repair canaries (F1/F3/F7): userinfo URLs, <think> chains, lowercase PEM.
  urlUserinfo: "https://alice:s3cr3t@api.example.com/v1",
  thinkBlock: "<think>internal chain of thought about the budget</think>",
  pemLowercase:
    "-----begin openssh private key-----\nb3BlbnNzaC1rZXktdjEAAAAAAbW9wNTJz\r\n-----end openssh private key-----",
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
    // v5: the O1/O2 repairs close the crash-not-leak residuals (throwing array traps,
    // throwing own-key reads), so frozen dataset references must not silently keep
    // resolving to the old policy.
    expect(REDACTION_POLICY_VERSION).toBe("opik-redaction/5");
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

  test("truncation never strands a lone surrogate at the cut", () => {
    // The byte budget can land between a surrogate pair: the lone half encodes to U+FFFD bytes,
    // so a character-level guard never sees it. Every padding has to stay well-formed.
    for (const pad of [0, 1, 2, 3]) {
      const input = "a".repeat(pad) + "😀".repeat(3000);
      const result = projectSafeText(input, { allowFreeText: true });
      expect(result.state).toBe("truncated");
      if (result.state === "truncated") {
        expect(result.text, `pad=${pad}`).not.toMatch(/[\uD800-\uDBFF]$/);
        const bytes = new TextEncoder().encode(result.text);
        expect(bytes.length, `pad=${pad}`).toBeLessThanOrEqual(
          MAX_SAFE_TEXT_BYTES,
        );
        // A well-formed string round-trips through its own UTF-8 bytes unchanged.
        expect(new TextDecoder().decode(bytes), `pad=${pad}`).toBe(result.text);
        expect(result.originalBytes, `pad=${pad}`).toBe(
          new TextEncoder().encode(input).length,
        );
      }
    }
  });
});

describe("deny patterns hold on the reviewed-free-text path", () => {
  test("a PEM block is denied wherever it sits", () => {
    const pem = CANARIES.pemKey;
    const placements = [
      pem, // string start
      `config:\n${pem}`, // after a newline
      `deploy key:${pem}`, // after a colon
      `deploy key ${pem}`, // after a space
      `value="${pem}"`, // after a quote
      `key${pem}`, // glued to a word character (the only form the old anchor caught)
    ];
    for (const text of placements) {
      const result = projectSafeText(text, { allowFreeText: true });
      expect(result.state).toBe("omitted");
      expect(JSON.stringify(result)).not.toContain("OPENSSH PRIVATE KEY");
      // The base64 body is the credential; denying only the header still leaks the key.
      expect(JSON.stringify(result)).not.toContain("b3BlbnNzaC1rZXktdjE");
    }
  });

  test("a Slack token is denied", () => {
    const result = projectSafeText(`notify ${CANARIES.slackToken}`, {
      allowFreeText: true,
    });
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain(CANARIES.slackToken);
  });

  test("an AWS secret is denied with its label before the value", () => {
    // Config files and env dumps put the label first; a forward-only context
    // lookahead never sees that form.
    const labelled = projectSafeText(
      `aws_secret_access_key=${CANARIES.awsSecret}`,
      { allowFreeText: true },
    );
    expect(labelled.state).toBe("omitted");
    expect(JSON.stringify(labelled)).not.toContain(CANARIES.awsSecret);
  });

  test("an AWS secret is still denied with its label after the value", () => {
    const labelled = projectSafeText(
      `${CANARIES.awsSecret} is the aws secret`,
      { allowFreeText: true },
    );
    expect(labelled.state).toBe("omitted");
    expect(JSON.stringify(labelled)).not.toContain(CANARIES.awsSecret);
  });

  test("an uppercase env-dump label is still denied", () => {
    const result = projectSafeText(
      `AWS_SECRET_ACCESS_KEY=${CANARIES.awsSecret}`,
      { allowFreeText: true },
    );
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain(CANARIES.awsSecret);
  });

  test("a bare 40-char token without any context stays projected (accepted precision trade-off)", () => {
    // Rejecting every bare 40-char base64 run would flag every hash, and unreviewed text is
    // metrics-only anyway (`allowFreeText` is the gate). Reviewed text carries its label.
    const input = `digest ${CANARIES.awsSecret}`;
    expect(projectSafeText(input, { allowFreeText: true })).toEqual({
      state: "projected",
      text: input,
    });
  });

  test("a PEM block never reaches the default metadata path", () => {
    const result = projectSafeMetadata({ model: CANARIES.pemKey });
    expect(result.model?.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain("OPENSSH PRIVATE KEY");
    expect(JSON.stringify(result)).not.toContain("b3BlbnNzaC1rZXktdjE");
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

  test("an inherited property never produces a phantom entry", () => {
    // Own keys only on the source side too: a prototype chain member named by the allowlist
    // must not fabricate data the record never carried.
    const source = Object.create({ inherited: "phantom-value" });
    source.model = "gpt-4o";
    const result = projectSafeRecord(source, ["inherited", "model"]);
    expect(Object.keys(result).sort()).toEqual(["model"]);
    expect(values(result)).not.toContain("phantom-value");
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

  test("a __proto__ key from parsed JSON is an own key, never a prototype hijack", () => {
    const parsed = JSON.parse(
      '{"__proto__": {"injected": "payload"}, "model": "gpt-4o"}',
    );
    const result = projectSafeRecord(parsed, ["__proto__", "model"]);
    // The value is recorded under its own key instead of routing through
    // Object.prototype's __proto__ setter.
    expect(Object.keys(result).sort()).toEqual(["__proto__", "model"]);
    expect(JSON.stringify(result)).toContain("payload");
    expect(({} as Record<string, unknown>).injected).toBeUndefined();
  });

  test("an allowlist entry naming an Object.prototype member fabricates no key", () => {
    const result = projectSafeRecord({ model: "gpt-4o" }, [
      "toString",
      "model",
    ]);
    expect(Object.keys(result).sort()).toEqual(["model"]);
  });

  test("nested record projection does not pollute prototypes either", () => {
    const parsed = JSON.parse('{"nested": {"__proto__": {"injected": "p"}}}');
    const result = projectSafeRecord(parsed, ["nested"]);
    expect(result.nested?.state).toBe("projected");
    expect(values(result)).not.toContain("payload");
    expect(({} as Record<string, unknown>).injected).toBeUndefined();
  });

  test("an array over the key cap reports truncation instead of silently dropping", () => {
    const items = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    const result = projectSafeRecord({ tools: items }, ["tools"]);
    const value = result.tools;
    expect(value.state).toBe("truncated");
    if (value.state === "truncated") {
      expect(value.dropped).toBe(36);
      expect(value.originalBytes).toBeGreaterThan(0);
      expect((value.value as unknown[]).length).toBe(64);
      expect(JSON.stringify(value)).toContain("item-63");
      expect(JSON.stringify(value)).not.toContain("item-64");
      expect(JSON.stringify(value)).not.toContain("item-99");
    }
  });

  test("a record with more than 64 own keys reports truncation", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) obj[`k${i}`] = i;
    const result = projectSafeRecord({ meta: obj }, ["meta"]);
    const value = result.meta;
    expect(value.state).toBe("truncated");
    if (value.state === "truncated") {
      expect(value.dropped).toBe(36);
      expect(Object.keys(value.value as object).length).toBe(64);
      expect(JSON.stringify(value)).toContain("k63");
      expect(JSON.stringify(value)).not.toContain("k99");
    }
  });

  test("an allowlist longer than the key cap is refused, not silently sliced", () => {
    const oversized = Array.from({ length: 65 }, (_, i) => `k${i}`);
    expect(() => projectSafeRecord({ k0: 1 }, oversized)).toThrow(
      /MAX_SAFE_RECORD_KEYS/,
    );
    expect(DEFAULT_METADATA_ALLOWLIST.length).toBeLessThanOrEqual(
      MAX_SAFE_RECORD_KEYS,
    );
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

/**
 * T05 review repair suite (review-report.md F1–F7). Each test names the finding it pins: the
 * deny shape the independent review demonstrated leaking on the /2 policy.
 */
describe("T05 review repair: deny gaps", () => {
  const userinfoUrl = "https://alice:s3cr3t@api.example.com/v1";
  const forty = CANARIES.awsSecret;

  test("F1: URL userinfo credentials are denied in reviewed free text", () => {
    const result = projectSafeText(`endpoint ${userinfoUrl} ready`, {
      allowFreeText: true,
    });
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  test("F1: URL userinfo credentials are denied in record leaves", () => {
    const result = projectSafeMetadata({ environment: userinfoUrl });
    expect(result.environment?.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  test("F1: URL userinfo credentials are denied in names", () => {
    const result = projectSafeName(userinfoUrl);
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  test("F2: api_key= labels a 40-char value as a secret", () => {
    const result = projectSafeText(`api_key=${forty}`, { allowFreeText: true });
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain(forty);
  });

  test("F2: access_token= labels a 40-char value as a secret", () => {
    const result = projectSafeText(`access_token=${forty}`, {
      allowFreeText: true,
    });
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain(forty);
  });

  test("F2: a label before the value denies beyond the old 64-char window", () => {
    const input = `password:\n${"#".repeat(200)}\n${forty}`;
    const result = projectSafeText(input, { allowFreeText: true });
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain(forty);
  });

  test("F2: labelled secrets are denied in record leaves too", () => {
    const result = projectSafeMetadata({ environment: `api_key=${forty}` });
    expect(result.environment?.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain(forty);
  });

  // R2-30: the fixed {40} quantifier had no word boundary to anchor on inside a longer
  // in-class run, so a labelled key of 64 hex or 96 base64 characters projected as-is.
  // The quantifier must extend to the end of the run; the "unlabelled long runs stay
  // projectable" trade-off is unchanged.
  describe("R2-30: SECRET_RUN quantifier must cover runs longer than 40", () => {
    const hex64 =
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
    // 96 chars of the base64 alphabet (A-Za-z0-9), with and without one trailing '='.
    const b64WithoutPad =
      "Hx0bJm3Qv8Kz2Wp7Yc5Rn1Td6Ug9Se4Af0hBi3Oj6Lk9Xz2Cv5Nb8Mq1Wr4Et7YuGy1cKn4Rw9Lz3Xq8Zd6So2Uf7Vh0Wj5F";
    const b64WithPad = `${b64WithoutPad}=`;
    expect(hex64).toHaveLength(64);
    expect(b64WithoutPad).toHaveLength(96);
    expect(b64WithPad).toHaveLength(97);

    test("a 64-hex key with a label is denied", () => {
      const result = projectSafeText(`api_key=${hex64}`, {
        allowFreeText: true,
      });
      expect(result.state).toBe("omitted");
      expect(JSON.stringify(result)).not.toContain(hex64);
    });

    test("a 96-char base64 key with a label and a trailing '=' is denied", () => {
      const result = projectSafeText(`access_token=${b64WithPad}`, {
        allowFreeText: true,
      });
      expect(result.state).toBe("omitted");
      expect(JSON.stringify(result)).not.toContain(b64WithPad);
    });

    test("a 96-char base64 key with a label and no trailing '=' is denied", () => {
      const result = projectSafeText(`password=${b64WithoutPad}`, {
        allowFreeText: true,
      });
      expect(result.state).toBe("omitted");
      expect(JSON.stringify(result)).not.toContain(b64WithoutPad);
    });

    test("the same long runs are denied in record leaves too", () => {
      const result = projectSafeMetadata({ environment: `secret=${hex64}` });
      expect(result.environment?.state).toBe("omitted");
      expect(JSON.stringify(result)).not.toContain(hex64);
    });

    test("the exactly-40-char labelled case is still denied", () => {
      const result = projectSafeText(`api_key=${forty}`, {
        allowFreeText: true,
      });
      expect(result.state).toBe("omitted");
      expect(JSON.stringify(result)).not.toContain(forty);
    });

    test("an unlabelled long run stays projected (unchanged trade-off)", () => {
      const input = `digest ${hex64}`;
      expect(projectSafeText(input, { allowFreeText: true })).toEqual({
        state: "projected",
        text: input,
      });
    });

    test("sk-ant- keys are denied like the other sk- families", () => {
      const key = "sk-ant-api03-9f3a7c21e8b44d0f8e7d6c5b4a3f2e1d";
      const result = projectSafeText(`anthropic key ${key}`, {
        allowFreeText: true,
      });
      expect(result.state).toBe("omitted");
      expect(JSON.stringify(result)).not.toContain(key);
    });
  });

  test("F3: <think> chains are denied as reasoning content", () => {
    const result = projectSafeText(
      "<think>internal chain of thought about the budget</think>",
      { allowFreeText: true },
    );
    expect(result.state).toBe("omitted");
    if (result.state === "omitted")
      expect(result.reason).toBe("reasoning_content");
  });

  test("F3: a lone </think> close tag is still reasoning content", () => {
    const result = projectSafeText("budget check</think> done", {
      allowFreeText: true,
    });
    expect(result.state).toBe("omitted");
  });

  test("F4: the cloud metadata endpoint is omitted as a raw attachment", () => {
    const result = projectSafeUrl("http://169.254.169.254/latest/meta-data/");
    expect(result.state).toBe("omitted");
    if (result.state === "omitted")
      expect(result.reason).toBe("raw_attachment");
  });

  test("F4: link-local, 0.0.0.0 and IPv4-mapped loopback hosts are omitted", () => {
    for (const url of [
      "http://169.254.0.1/",
      "http://0.0.0.0/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      expect(projectSafeUrl(url).state, url).toBe("omitted");
    }
  });

  test("R4-19: the IPv6 link-local block (fe80::/10) is omitted as a raw attachment", () => {
    // The parser hands the host over canonical lowercase hex, so the range is
    // matched on the first hextet: fe80..febf.
    for (const url of [
      "https://[fe80::1]/latest/meta-data/",
      "https://[FE80::A9FE:A9FE]/",
      "https://[febf::1]/",
    ]) {
      const result = projectSafeUrl(url);
      expect(result.state, url).toBe("omitted");
      if (result.state === "omitted")
        expect(result.reason, url).toBe("raw_attachment");
    }
  });

  test("R4-19: the IPv6 unique-local block (fc00::/7) is omitted as a raw attachment", () => {
    // fc00..fdff — the AWS IPv6 metadata endpoint lives here (fd00:ec2::254).
    for (const url of [
      "https://[fd00:ec2::254]/latest/meta-data/",
      "https://[fc00::1]/",
    ]) {
      const result = projectSafeUrl(url);
      expect(result.state, url).toBe("omitted");
      if (result.state === "omitted")
        expect(result.reason, url).toBe("raw_attachment");
    }
  });

  test("R4-19: an IPv4-mapped IPv6 spelling of the metadata endpoint is omitted too", () => {
    // The parser canonicalizes every IPv4-mapped spelling — dotted or hex, full
    // or compressed — to `::ffff:a9fe:a9fe`; the mapped tail is decoded and
    // answered with the same 169.254/16 verdict its IPv4 spelling gets.
    for (const url of [
      "https://[::ffff:169.254.169.254]/latest/meta-data/",
      "https://[::ffff:a9fe:a9fe]/",
      "https://[0:0:0:0:0:ffff:169.254.169.254]/",
    ]) {
      const result = projectSafeUrl(url);
      expect(result.state, url).toBe("omitted");
      if (result.state === "omitted")
        expect(result.reason, url).toBe("raw_attachment");
    }
  });

  test("R4-19: ordinary global IPv6 hosts are still projected (non-regression)", () => {
    for (const url of [
      "https://[2001:db8::1]/trace",
      "https://[2606:4700::6810:85e5]/",
    ]) {
      expect(projectSafeUrl(url).state, url).toBe("projected");
    }
  });

  test("F5: adversarial '=' padding scans in bounded time", () => {
    // One '=' every 41 characters manufactures a word-boundary candidate per chunk. With no
    // label present, the old per-candidate lookahead walked the whole tail for every candidate
    // (quadratic; the review measured 4.6s at 512KB). The label prefilter plus two single-pass
    // tests are linear, so ~1MB has to stay far under the budget.
    const hostile = `${"a".repeat(40)}=`.repeat(24_000);
    const withLabel = `password${hostile}`;
    for (const input of [hostile, withLabel]) {
      const start = performance.now();
      const result = projectSafeText(input, { allowFreeText: true });
      const elapsed = performance.now() - start;
      expect(elapsed, `${input.length} bytes`).toBeLessThan(2_000);
      expect(result).toBeDefined();
    }
  });

  test("F6: a throwing getter is omitted, never propagated", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "environment", {
      enumerable: true,
      get() {
        throw new Error("hostile accessor");
      },
    });
    const result = projectSafeMetadata(hostile);
    expect(result.environment).toEqual({
      state: "omitted",
      reason: "unhandled_free_text",
    });
  });

  test("F6: a throwing getter nested in a record is omitted too", () => {
    const leaf: Record<string, unknown> = {};
    Object.defineProperty(leaf, "boom", {
      enumerable: true,
      get() {
        throw new Error("hostile accessor");
      },
    });
    const result = projectSafeRecord({ nested: leaf }, ["nested"]);
    const nested = result.nested;
    expect(nested?.state).toBe("projected");
    if (nested?.state === "projected") {
      const boom = (nested.value as Record<string, SafeValue>).boom;
      expect(boom).toEqual({ state: "omitted", reason: "unhandled_free_text" });
    }
  });

  test("F7: a lowercase PEM header is denied", () => {
    const result = projectSafeText(CANARIES.pemLowercase, {
      allowFreeText: true,
    });
    expect(result.state).toBe("omitted");
    expect(JSON.stringify(result)).not.toContain("b3BlbnNzaC1rZXktdjE");
  });
});

/**
 * T05 polish round 2 (repair review N1/N3). Two LOW pre-existing gaps: hostname spellings that
 * walk past the endpoint deny sets, and the record enumeration path a Proxy controls outright.
 */
describe("T05 polish 2: pre-existing low gaps", () => {
  test("N1: a trailing-dot localhost is omitted as a raw attachment", () => {
    // `localhost.` is the DNS root-label spelling of the same loopback host — it resolves to
    // 127.0.0.1 but walked past the string-equality loopback check.
    const result = projectSafeUrl("http://localhost.:3010/api/keys");
    expect(result.state).toBe("omitted");
    if (result.state === "omitted")
      expect(result.reason).toBe("raw_attachment");
  });

  test("N1: mixed case with a trailing dot is omitted too", () => {
    // The parser lowercases the host but keeps the dot: normalization has to survive both
    // shapes at once.
    expect(projectSafeUrl("http://LocalHost.:3010/x").state).toBe("omitted");
  });

  test("N1: parser-normalized host spellings stay covered", () => {
    // Verified against the URL parser: uppercase hosts, hex/octal/decimal IPv4 spellings and
    // dotted IPv4 hosts are normalized before we see them. These pin the coverage the trailing-
    // dot fix must not regress.
    for (const url of [
      "http://LOCALHOST:3010/api/keys",
      "http://0x7f.0.0.1/api/keys",
      "http://2130706433/api/keys",
      "http://0177.0.0.1/api/keys",
      "http://127.0.0.01./api/keys",
      "http://169.254.169.254./latest/meta-data/",
    ]) {
      expect(projectSafeUrl(url).state, url).toBe("omitted");
    }
  });

  test("N1: a punycode lookalike domain is not the loopback host", () => {
    // `xn--loalhost-gch` (Cyrillic с) is a *different* domain, not a normalization variant of
    // localhost — mapping it back would be guessing at attacker intent, and a wrong guess
    // denies a real registered host. It projects like any other public host.
    expect(projectSafeUrl("http://xn--loalhost-gch/x")).toEqual({
      state: "projected",
      text: "http://xn--loalhost-gch/x",
    });
  });

  test("N3: a Proxy key name carrying a credential is dropped, never echoed", () => {
    // ownKeys/getOwnPropertyDescriptor are attacker code on a Proxy: they can put the
    // credential in a *key name*, where the value deny scan never looks.
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => ["sk-live-abcdefghijklmnopqrst", "model"],
        getOwnPropertyDescriptor: () => ({
          configurable: true,
          enumerable: true,
        }),
        get: () => "gpt-x",
      },
    );
    const result = projectSafeRecord({ nested: hostile }, ["nested"]);
    const nested = result.nested;
    expect(nested?.state).toBe("projected");
    expect(JSON.stringify(result)).not.toContain("sk-live");
    if (nested?.state === "projected") {
      expect(Object.keys(nested.value as object)).toEqual(["model"]);
    }
  });

  test("N3: a throwing ownKeys trap degrades to omitted, never propagated", () => {
    // Object.keys itself runs the trap, so F6's readOwn guard never sees this throw.
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("hostile ownKeys");
        },
      },
    );
    const result = projectSafeRecord({ nested: hostile }, ["nested"]);
    expect(result.nested).toEqual({
      state: "omitted",
      reason: "unhandled_free_text",
    });
  });

  test("N3: a throwing getOwnPropertyDescriptor trap degrades the same way", () => {
    // Object.keys consults the descriptor trap for enumerability before returning a key.
    const hostile = new Proxy(
      { model: "gpt-x" },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("hostile descriptor");
        },
      },
    );
    const result = projectSafeRecord({ nested: hostile }, ["nested"]);
    expect(result.nested).toEqual({
      state: "omitted",
      reason: "unhandled_free_text",
    });
  });
});

describe("O1/O2: v5 closes the crash-not-leak residuals", () => {
  test("O1: a Proxy array whose traps throw degrades to omitted, never crashes the caller", () => {
    // Array.isArray says yes, but slice/length run attacker code (get traps) that the
    // readOwn guard never sees — pre-v5 this threw out of projectSafeRecord entirely.
    const hostile = new Proxy([1, 2, 3], {
      get(target, prop) {
        if (prop === "slice") throw new Error("hostile array trap");
        return Reflect.get(target, prop);
      },
    });
    const result = projectSafeRecord({ nested: hostile }, ["nested"]);
    expect(result.nested).toEqual({
      state: "omitted",
      reason: "unhandled_free_text",
    });
  });

  test("O2: a throwing descriptor trap on a top-level allowlist key skips that key", () => {
    // projectSafeRecord reads own-ness with Object.hasOwn before readOwn ever runs, so a
    // throwing getOwnPropertyDescriptor aborts the whole allowlist loop pre-v5.
    const hostile = new Proxy(
      { model: "gpt-x" },
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile descriptor");
        },
      },
    );
    const result = projectSafeRecord(hostile, ["model"]);
    expect(result).toEqual({});
  });
});
