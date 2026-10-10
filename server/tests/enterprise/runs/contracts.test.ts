import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  CreateRunSchema,
  IdempotencyKeySchema,
  RunEventViewSchema,
  RunStates,
  RunViewSchema,
} from "../../../../shared/enterprise/run-contracts";
import {
  goInputDigest,
  runRequestDigest,
} from "../../../src/enterprise/runs/digest";
import {
  parseRuntimeInvocation,
  RUNTIME_WIRE_SCHEMA_VERSION,
  type RuntimeInvocation,
  RuntimeInvocationSchema,
} from "../../../src/enterprise/runtime/wire";

/*
 * E1-A 公共合同与请求摘要（03 分册 §3）。
 *
 * 客户端只提交业务意图：thread/workspace/release/alias 与一段文本。租户身份、
 * principal、attempt、fence、价格与预算全部由服务端派生，出现在请求体里就是
 * 拒绝，不是忽略。金额与序号在 JSON 中一律是十进制字符串（bigint 不转 number），
 * 所以 revision/seq 的负数、指数、小数、前导零形式都在合同层拒绝。
 *
 * 摘要是幂等创建的对照键：同一"解析后"的请求必须得到同一摘要（JSON 键顺序、
 * 是否携带可选字段的表达方式都不改变含义），正文不同摘要必须不同；文本不 trim、
 * 不做 Unicode 归一化——规范化等于给注入开另一条等价通道。
 *
 * 内部 wire（RuntimeInvocation）收敛到 runtime/wire.ts 单一来源：字段、头名、
 * schema_version="1" 全部从同一 Schema 派生，黄金样本与 JSON Schema 由 Zod
 * 生成并冻结，不手写第二套字段。
 */

/** A complete, well-formed create request; every test mutates from here. */
const request = {
  workspace_id: "w",
  expert_release_id: "release",
  model_alias: "chat",
  input: { text: "hello" },
} as const;

const runView = {
  run_id: "run_1",
  thread_id: "thread_1",
  status: "running",
  revision: "3",
  latest_seq: "12",
  reconciliation_required: false,
  reason_code: null,
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

describe("the public run-create contract", () => {
  test("caller cannot assign tenant identity", () => {
    expect(
      CreateRunSchema.safeParse({ ...request, tenant_id: "other" }).success,
    ).toBe(false);
  });

  test("no server-owned field is assignable from the request body", () => {
    for (const forbidden of [
      "tenant_id",
      "principal_id",
      "actor_id",
      "attempt_id",
      "fencing_token",
      "price_micros",
      "budget_reservation_id",
      "request_digest",
    ]) {
      expect(
        CreateRunSchema.safeParse({ ...request, [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
  });

  test("the caller cannot smuggle a resume object into a run request", () => {
    expect(
      CreateRunSchema.safeParse({
        ...request,
        resume: { checkpoint_id: "cp_1" },
      }).success,
    ).toBe(false);
    expect(
      CreateRunSchema.safeParse({
        ...request,
        forwardedProps: { resume: { checkpoint_id: "cp_1" } },
      }).success,
    ).toBe(false);
  });

  test("tool results and framework history are not client input", () => {
    expect(
      CreateRunSchema.safeParse({
        ...request,
        input: { text: "hi", tool_result: "operation succeeded" },
      }).success,
    ).toBe(false);
    expect(
      CreateRunSchema.safeParse({
        ...request,
        input: { text: "hi", messages: [{ role: "tool", content: "done" }] },
      }).success,
    ).toBe(false);
    expect(
      CreateRunSchema.safeParse({
        ...request,
        messages: [{ role: "assistant", content: "history" }],
      }).success,
    ).toBe(false);
  });

  test("input text is bounded and must be a non-empty string", () => {
    expect(
      CreateRunSchema.safeParse({ ...request, input: { text: "" } }).success,
    ).toBe(false);
    expect(
      CreateRunSchema.safeParse({
        ...request,
        input: { text: "x".repeat(32769) },
      }).success,
    ).toBe(false);
    expect(
      CreateRunSchema.safeParse({ ...request, input: { text: 123 } }).success,
    ).toBe(false);
    expect(
      CreateRunSchema.safeParse({
        ...request,
        input: { text: "x".repeat(32768) },
      }).success,
    ).toBe(true);
  });

  test("identifiers and the optional thread follow the ID shape", () => {
    expect(
      CreateRunSchema.safeParse({ ...request, thread_id: "thread_1" }).success,
    ).toBe(true);
    expect(
      CreateRunSchema.safeParse({ ...request, thread_id: "bad id!" }).success,
    ).toBe(false);
    expect(
      CreateRunSchema.safeParse({ ...request, workspace_id: "x".repeat(129) })
        .success,
    ).toBe(false);
  });

  test("the run state set is exactly the ledger's ten states", () => {
    expect([...RunStates]).toEqual([
      "queued",
      "running",
      "waiting_input",
      "waiting_approval",
      "suspended",
      "cancel_requested",
      "succeeded",
      "failed",
      "cancelled",
      "expired",
    ]);
    expect(
      RunViewSchema.safeParse({ ...runView, status: "deleted" }).success,
    ).toBe(false);
  });
});

describe("the idempotency-key contract", () => {
  /*
   * 计划 03 §3.1：Idempotency-Key 使用 ID 同等字符限制，值由调用方生成但
   * 只有去重意义；每次重放仍验证当前授权，不因缓存命中绕过撤权。这里钉住
   * 字符限制本身——E1-C 的路由层用它校验请求头，重放授权由 RunService 在
   * 事务内复核，不属于 Schema 的职责。
   */
  test("the key follows the ID character limit exactly", () => {
    expect(IdempotencyKeySchema).toBe(CreateRunSchema.shape.workspace_id);
  });

  test("a generated key parses; hostile shapes are refused", () => {
    expect(IdempotencyKeySchema.safeParse("same-key").success).toBe(true);
    expect(IdempotencyKeySchema.safeParse("key_2026.10.10").success).toBe(
      false,
    );
    expect(IdempotencyKeySchema.safeParse("").success).toBe(false);
    expect(IdempotencyKeySchema.safeParse("x".repeat(129)).success).toBe(false);
    expect(IdempotencyKeySchema.safeParse("x".repeat(128)).success).toBe(true);
  });
});

describe("bigint values travel as plain decimal strings", () => {
  test("a negative revision is refused", () => {
    expect(
      RunViewSchema.safeParse({ ...runView, revision: "-1" }).success,
    ).toBe(false);
  });

  test("an exponential revision is refused", () => {
    expect(
      RunViewSchema.safeParse({ ...runView, revision: "1e5" }).success,
    ).toBe(false);
    expect(
      RunViewSchema.safeParse({ ...runView, revision: "1E5" }).success,
    ).toBe(false);
  });

  test("fractional, padded and spaced numbers are refused", () => {
    expect(
      RunViewSchema.safeParse({ ...runView, revision: "1.5" }).success,
    ).toBe(false);
    expect(
      RunViewSchema.safeParse({ ...runView, revision: "01" }).success,
    ).toBe(false);
    expect(
      RunViewSchema.safeParse({ ...runView, revision: " 3" }).success,
    ).toBe(false);
    expect(
      RunViewSchema.safeParse({ ...runView, latest_seq: "-2" }).success,
    ).toBe(false);
  });

  test("zero and plain integers stay valid", () => {
    expect(
      RunViewSchema.safeParse({ ...runView, revision: "0", latest_seq: "0" })
        .success,
    ).toBe(true);
    expect(RunViewSchema.safeParse(runView).success).toBe(true);
  });

  test("the public view is strict about unknown fields", () => {
    expect(
      RunViewSchema.safeParse({ ...runView, input_digest: "x" }).success,
    ).toBe(false);
  });

  test("a public event keeps the same decimal rule and allows a null turn", () => {
    const event = {
      schema_version: "1",
      event_id: "evt_1",
      run_id: "run_1",
      turn_id: null,
      seq: "12",
      occurred_at: "2026-10-10T00:00:00Z",
      type: "RUN_STATE_CHANGED",
      payload: { status: "running" },
    };
    expect(RunEventViewSchema.safeParse(event).success).toBe(true);
    expect(RunEventViewSchema.safeParse({ ...event, seq: "1e3" }).success).toBe(
      false,
    );
    expect(
      RunEventViewSchema.safeParse({ ...event, extra: true }).success,
    ).toBe(false);
  });
});

describe("the run-create request digest", () => {
  test("request digest covers the content", () => {
    expect(runRequestDigest(request)).not.toBe(
      runRequestDigest({ ...request, input: { text: "changed" } }),
    );
  });

  test("the same parsed request digests identically regardless of JSON key order", () => {
    const reordered = {
      input: { text: "hello" },
      model_alias: "chat",
      expert_release_id: "release",
      workspace_id: "w",
    };
    expect(runRequestDigest(reordered)).toBe(runRequestDigest(request));
  });

  test("the digest is sha256 over the frozen canonical field array", () => {
    expect(runRequestDigest(request)).toBe(
      sha256(
        JSON.stringify([
          "run-create-v1",
          null,
          "w",
          "release",
          "chat",
          "hello",
        ]),
      ),
    );
  });

  test("an absent thread_id and a present one never collide", () => {
    expect(runRequestDigest({ ...request, thread_id: "t1" })).not.toBe(
      runRequestDigest(request),
    );
    expect(runRequestDigest({ ...request, thread_id: "t1" })).toBe(
      sha256(
        JSON.stringify([
          "run-create-v1",
          "t1",
          "w",
          "release",
          "chat",
          "hello",
        ]),
      ),
    );
  });

  test("text is not trimmed: surrounding whitespace changes the digest", () => {
    expect(
      runRequestDigest({ ...request, input: { text: " hello " } }),
    ).not.toBe(runRequestDigest(request));
  });

  test("text is not unicode-normalized: composed and decomposed accents differ", () => {
    expect(runRequestDigest({ ...request, input: { text: "é" } })).not.toBe(
      runRequestDigest({ ...request, input: { text: "e\u0301" } }),
    );
  });

  test("newlines and Chinese text are covered by the digest", () => {
    expect(runRequestDigest({ ...request, input: { text: "a\nb" } })).not.toBe(
      runRequestDigest({ ...request, input: { text: "ab" } }),
    );
    expect(runRequestDigest({ ...request, input: { text: "你好" } })).not.toBe(
      runRequestDigest({ ...request, input: { text: "你好 " } }),
    );
  });

  test("an empty text never reaches the digest", () => {
    expect(() =>
      runRequestDigest({ ...request, input: { text: "" } }),
    ).toThrow();
  });
});

describe("the Go input digest", () => {
  test("one user message hashes the frozen canonical JSON the Go side produces", () => {
    expect(goInputDigest(["hello"])).toBe(
      sha256('[{"content":"hello","role":"user"}]'),
    );
  });

  test("multiple messages keep their order", () => {
    expect(goInputDigest(["first", "second"])).toBe(
      sha256(
        '[{"content":"first","role":"user"},{"content":"second","role":"user"}]',
      ),
    );
  });

  test("U+2028 is escaped like Go's encoder, never left raw", () => {
    expect(goInputDigest(["a\u2028b"])).toBe(
      sha256('[{"content":"a\\u2028b","role":"user"}]'),
    );
  });

  test("U+2029 is escaped the same way", () => {
    expect(goInputDigest(["a\u2029b"])).toBe(
      sha256('[{"content":"a\\u2029b","role":"user"}]'),
    );
  });

  test("the line-separator digests equal the frozen constants the Go side pins", () => {
    // The same hex constants runtime-go/internal/trustedinput/input_test.go
    // asserts (DigestMessages): either side drifting from these bytes fails
    // both languages' tests instead of mismatching input_digest at run time.
    expect(goInputDigest(["a\u2028b"])).toBe(
      "1d4f05e3190680b0cf439a3afe5ecb28317d3863f646c46c21dbcfb39a6131e2",
    );
    expect(goInputDigest(["a\u2029b"])).toBe(
      "dea9f1abba0be4bffb9aac054d06346d48ec5040bf7aff11326a256a324a5d63",
    );
    expect(goInputDigest(["a\u2028b", "c\u2029d"])).toBe(
      "3d24e293f141c238991318302f822dee3fc94a0569da508ddad6c6cce3b90e87",
    );
  });

  test("a literal backslash-u2028 text is a different byte sequence from the raw separator", () => {
    expect(goInputDigest(["a\\u2028b"])).not.toBe(goInputDigest(["a\u2028b"]));
  });

  test("lone surrogates are refused before hashing", () => {
    expect(() => goInputDigest(["\uD800"])).toThrow("INVALID_UNICODE_INPUT");
    expect(() => goInputDigest(["ok\uD83D"])).toThrow("INVALID_UNICODE_INPUT");
    expect(() => goInputDigest(["ok", "\uDC00tail"])).toThrow(
      "INVALID_UNICODE_INPUT",
    );
  });

  test("paired surrogates (real emoji) stay valid", () => {
    expect(() => goInputDigest(["ok \u{1F600}"])).not.toThrow();
  });
});

describe("the internal runtime wire (single source)", () => {
  const golden = JSON.parse(
    readFileSync(new URL("./fixtures/wire-v1.json", import.meta.url), "utf8"),
  ) as RuntimeInvocation;

  test("the wire version is frozen at 1", () => {
    expect(RUNTIME_WIRE_SCHEMA_VERSION).toBe("1");
    expect(
      RuntimeInvocationSchema.shape.schema_version.safeParse("1").success,
    ).toBe(true);
    expect(
      RuntimeInvocationSchema.shape.schema_version.safeParse("2").success,
    ).toBe(false);
  });

  test("the frozen golden sample still parses field for field", () => {
    const parsed = parseRuntimeInvocation(golden);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.invocation).toEqual(golden);
    }
  });

  test("wire-schema.json is generated from the Zod schema, never hand-written", () => {
    const frozen = readFileSync(
      new URL("./fixtures/wire-schema.json", import.meta.url),
      "utf8",
    );
    expect(
      `${JSON.stringify(z.toJSONSchema(RuntimeInvocationSchema), null, 2)}\n`,
    ).toBe(frozen);
  });

  test("the strict refusals keep their legacy codes", () => {
    const withField = (over: Record<string, unknown>) => ({
      ...golden,
      ...over,
    });
    expect(parseRuntimeInvocation("[]")).toEqual({
      ok: false,
      error: "invalid_body",
    });
    expect(parseRuntimeInvocation(withField({ intruder: 1 }))).toEqual({
      ok: false,
      error: "unknown_field",
    });
    const missingTurn = { ...golden } as Record<string, unknown>;
    delete missingTurn.turn_id;
    expect(parseRuntimeInvocation(missingTurn)).toEqual({
      ok: false,
      error: "missing_fields",
    });
    expect(parseRuntimeInvocation(withField({ schema_version: "2" }))).toEqual({
      ok: false,
      error: "unsupported_schema_version",
    });
    expect(
      parseRuntimeInvocation(withField({ expires_at: "not-a-timestamp" })),
    ).toEqual({
      ok: false,
      error: "invalid_expires_at",
    });
    expect(
      parseRuntimeInvocation(withField({ initiator_kind: "attacker" })),
    ).toEqual({
      ok: false,
      error: "invalid_initiator_kind",
    });
    expect(
      parseRuntimeInvocation(withField({ initiator_kind: "schedule" })),
    ).toEqual({ ok: false, error: "schedule_requires_delegation" });
    expect(
      parseRuntimeInvocation(
        withField({ initiator_kind: "schedule", delegation_ref: "d1" }),
      ).ok,
    ).toBe(true);
  });
});
