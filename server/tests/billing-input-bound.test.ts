import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  countChatInputTokens,
  fitChatInputRequest,
} from "../src/billing/input-bound";

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** 一个典型 BPE 分词器的形状:每 token 至少 4 字节。保守计数必须 ≥ 它。 */
function typicalTokenizerCount(value: unknown): number {
  return Math.ceil(bytes(value) / 4);
}

function chat(parts: string[]) {
  return {
    prompt: [
      { role: "system", content: "sys" },
      ...parts.map((content, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content,
      })),
    ],
  };
}

describe("countChatInputTokens", () => {
  test("保守:不少于典型分词器(4 bytes/token)的计数", () => {
    const params = chat([
      "你好世界".repeat(200),
      "assistant turn ".repeat(100),
      "final question",
    ]);
    expect(countChatInputTokens(params)).toBeGreaterThanOrEqual(
      typicalTokenizerCount(params),
    );
  });

  test("确定性:同一输入两次计数一致", () => {
    const params = chat(["hello", "world"]);
    expect(countChatInputTokens(params)).toBe(countChatInputTokens(params));
  });

  test("空 prompt 只计 per-message 开销与基线", () => {
    const counted = countChatInputTokens({ prompt: [] });
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThan(50);
  });

  test("不可序列化的输入 fail-closed:返回安全整数上界", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(countChatInputTokens({ prompt: [circular] })).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("fitChatInputRequest", () => {
  test("超限时丢最旧非 system 消息,保 system 与最新一条", () => {
    const params = chat(["old question", "old answer", "new question"]);
    const fit = fitChatInputRequest(200n);
    const fitted = fit(params) as { prompt: { role: string }[] };
    expect(fitted.prompt[0].role).toBe("system");
    expect(fitted.prompt.at(-1)).toEqual((params.prompt as unknown[]).at(-1));
    expect(countChatInputTokens(fitted)).toBeLessThanOrEqual(200);
  });

  test("不超限:原样返回(同一引用)", () => {
    const params = chat(["short"]);
    const fit = fitChatInputRequest(100_000n);
    expect(fit(params)).toBe(params);
  });

  test("system+最新一条都放不下:原样返回,交给准入拒绝", () => {
    const params = chat(["only a huge question ".repeat(500)]);
    const fit = fitChatInputRequest(10n);
    expect(fit(params)).toBe(params);
  });

  test("prompt 非数组:原样返回不抛错", () => {
    const fit = fitChatInputRequest(1n);
    expect(fit({ prompt: "not-an-array" })).toEqual({
      prompt: "not-an-array",
    });
  });
});
