# Provable Input Bound(保守计数 + 自执行截断)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让配置了 Lago 计费的部署在 OpenAI 兼容 chat 适配器上真正放行计费模型调用:保守计数 + 发送前自执行截断,取代"精确计数否则拒绝"的准入标准。

**Architecture:** 新增 `billing/input-bound.ts`(纯函数计数器 + 截断器);`copilot.ts` 的 `ModelUsageInputBound` 合同加可选 `fit`,`meteredModel` 准入在计数前先 fit;`index.ts` 的 gate 从 `unsupported` 改为 `counted` + counter/fit。结算侧零改动(既有 `usage_over_bound` 兜底)。

**Tech Stack:** Bun test,TypeScript,无新依赖(不引入分词器)。

**Spec:** `docs/specs/2026-10-13-provable-input-bound-design.md`(决策 1b/2/3/4/5)· ADR:`docs/adr/0001-conservative-input-bound.md`

## Global Constraints

- 不新增环境键(决策 4);校准常量内置:`BYTES_PER_TOKEN_FLOOR=2`、`SAFETY_FACTOR=1.25`、`PER_MESSAGE_OVERHEAD_TOKENS=4`。
- 截断只丢最旧非 system 消息,保 system 块 + 最新一条(决策 3);截断后仍超限 → 不改请求,准入按 `input_over_limit` 拒绝。
- 计数必须保守方向(≥ 典型分词器);序列化失败 → `Number.MAX_SAFE_INTEGER`(fail-closed)。
- code-run 路径不动(决策 5);结算/台账/预扣不动。
- 工作区有他人未提交的 `app/` 改动:提交只 `git add` 本计划列出的文件。

---

### Task 1: 保守计数器与截断器(billing/input-bound.ts)

**Files:**
- Create: `server/src/billing/input-bound.ts`
- Test: `server/tests/billing-input-bound.test.ts`

**Interfaces(Produces,后续任务依赖):**
- `countChatInputTokens(params: unknown): number` — 确定性保守计数。
- `fitChatInputRequest(maximumTokens: bigint): (params: unknown) => unknown` — 截断到 ≤ 上限,放不下时原样返回。

- [x] **Step 1: 写失败测试**

```ts
// server/tests/billing-input-bound.test.ts
import { describe, expect, test } from "bun:test";
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

const chat = (parts: string[]) => ({
  prompt: [
    { role: "system", content: "sys" },
    ...parts.map((content, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content,
    })),
  ],
});

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
    const fit = fitChatInputRequest(200n); // 小到必须裁
    const fitted = fit(params) as { prompt: { role: string }[] };
    expect(fitted.prompt[0].role).toBe("system");
    expect(fitted.prompt.at(-1)).toEqual(
      (params.prompt as unknown[]).at(-1),
    );
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
    expect(fit({ prompt: "not-an-array" })).toEqual({ prompt: "not-an-array" });
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd server && bun test tests/billing-input-bound.test.ts`
Expected: FAIL — cannot find module `../src/billing/input-bound`

- [x] **Step 3: 最小实现**

```ts
// server/src/billing/input-bound.ts
import { getLogger } from "../../../shared/logger";

const log = getLogger("server");

/**
 * The chat-completions input bound's conservative counter and self-enforcing fitter
 * (ADR-0001, docs/specs/2026-10-13-provable-input-bound-design.md).
 *
 * WHY BYTES, NOT A TOKENIZER. The provider behind an OpenAI-compatible gateway keeps its own
 * tokenizer; a local look-alike would disagree with it, and the contract a counted bound must
 * satisfy is not "exact" but "the provider cannot be SENT more than the configured ceiling by
 * our own measure". So the counter prices serialized bytes — deterministic, shape-tolerant,
 * tokenizer-free — with calibration constants chosen to sit ABOVE a typical tokenizer's
 * answer (the conservative direction), and the fitter drops the oldest non-system messages
 * until the count fits. A tokenizer that beats the calibration shows up at settlement as
 * `usage_over_bound` — a held reservation for reconciliation, never a silent charge.
 */

export const CONSERVATIVE_BYTES_PER_TOKEN_FLOOR = 2;
export const CONSERVATIVE_SAFETY_FACTOR = 1.25;
export const CONSERVATIVE_PER_MESSAGE_OVERHEAD_TOKENS = 4;

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function promptLength(params: unknown): number {
  const prompt = (params as { prompt?: unknown } | null | undefined)?.prompt;
  return Array.isArray(prompt) ? prompt.length : 1;
}

export function countChatInputTokens(params: unknown): number {
  const bytes = serializedBytes(params);
  if (bytes === Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  const counted =
    Math.ceil(
      (bytes / CONSERVATIVE_BYTES_PER_TOKEN_FLOOR) *
        CONSERVATIVE_SAFETY_FACTOR,
    ) + promptLength(params) * CONSERVATIVE_PER_MESSAGE_OVERHEAD_TOKENS;
  return Number.isSafeInteger(counted) ? counted : Number.MAX_SAFE_INTEGER;
}

function leadingSystemCount(prompt: unknown[]): number {
  let count = 0;
  for (const entry of prompt) {
    if ((entry as { role?: unknown } | null)?.role === "system") count += 1;
    else break;
  }
  return count;
}

/**
 * Self-enforcement (spec decision 1b/3): return the request this call should actually send —
 * the oldest non-system messages dropped until the conservative count fits the ceiling, the
 * system block and the latest turn always kept. When even that does not fit (or the shape is
 * not a prompt array), the params come back untouched so admission refuses `input_over_limit`
 * rather than sending something uncounted.
 */
export function fitChatInputRequest(
  maximumTokens: bigint,
): (params: unknown) => unknown {
  const limit = Number(maximumTokens);
  return (params) => {
    if (!Number.isSafeInteger(limit) || limit <= 0) return params;
    const prompt = (params as { prompt?: unknown } | null | undefined)?.prompt;
    if (!Array.isArray(prompt) || prompt.length <= 2) return params;
    const head = leadingSystemCount(prompt);
    const last = prompt.length - 1;
    for (let drop = 1; head + drop <= last; drop += 1) {
      const candidate = [...prompt.slice(0, head), ...prompt.slice(head + drop)];
      const fitted = { ...(params as object), prompt: candidate };
      if (countChatInputTokens(fitted) <= limit) {
        log.debug(
          {
            type: "billing-model-input-truncated",
            dropped: drop,
            kept: candidate.length,
          },
          "billing-model-input-truncated",
        );
        return fitted;
      }
    }
    return params;
  };
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `cd server && bun test tests/billing-input-bound.test.ts`
Expected: PASS(all)

- [x] **Step 5: 提交**

```bash
git add server/src/billing/input-bound.ts server/tests/billing-input-bound.test.ts
git commit -m "feat(billing): conservative chat input counter and self-enforcing fitter"
```

---

### Task 2: 准入合同加 fit(meteredModel 先 fit 再计数)

**Files:**
- Modify: `server/src/copilot.ts`(`ModelUsageInputBound` 类型、`meteredModel` 准入块、类型注释)
- Test: `server/tests/copilot-usage-meter.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的 `countChatInputTokens` / `fitChatInputRequest`(仅 Task 3 使用;本任务只扩展合同与流)。
- Produces: `ModelUsageInputBound` 增加可选 `fit?: (params: unknown) => unknown`;fit 后的请求同时用于计数与 `inner.doStream`。

- [x] **Step 1: 写失败测试(追加到 copilot-usage-meter.test.ts 的 describe 内)**

```ts
  test("a fit is applied before counting and the fitted request reaches the provider", async () => {
    const { calls, model } = recordingModel({ inputTokens: 1, outputTokens: 1 });
    const original = {
      prompt: [
        { role: "system", content: "sys" },
        { role: "user", content: "old ".repeat(200) },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ],
    };
    const fitted = {
      prompt: [
        { role: "system", content: "sys" },
        { role: "user", content: "new question" },
      ],
    };
    const { phases, lifecycle } = recordingLifecycle({
      input: {
        enforced: "counted",
        maximumTokens: 50n,
        countInputTokens: (params: unknown) => {
          // The counter must see the FITTED request, not the original.
          expect(params).toEqual(fitted);
          return 20;
        },
        fit: () => fitted,
      },
      output: { enforced: "provider_cap", maximumTokens: 100n },
    });
    try {
      setModelUsageGate(async () => lifecycle);
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await wrapped.doStream(original);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ prompt: fitted.prompt });
      expect(phases).toEqual([{ phase: "finish" }]);
    } finally {
      setModelUsageGate(undefined);
    }
  });

  test("a fit that cannot bring the request under the bound leaves it refused", async () => {
    const { calls, model } = recordingModel();
    const { phases, lifecycle } = recordingLifecycle({
      input: {
        enforced: "counted",
        maximumTokens: 10n,
        countInputTokens: () => 11,
        fit: (params: unknown) => params, // cannot help
      },
      output: { enforced: "provider_cap", maximumTokens: 100n },
    });
    try {
      setModelUsageGate(async () => lifecycle);
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await expect(wrapped.doStream({ prompt: [] })).rejects.toMatchObject({
        name: "ModelUsageRefusalError",
        code: "input_over_limit",
      });
      expect(calls).toHaveLength(0);
      expect(phases).toEqual([{ phase: "fail", reason: "bound_refused" }]);
    } finally {
      setModelUsageGate(undefined);
    }
  });
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd server && bun test tests/copilot-usage-meter.test.ts`
Expected: 第一个新测试 FAIL(`fit` 不在合同里,fit 未被调用,计数看到 original 而非 fitted)

- [x] **Step 3: 实现**

类型(copilot.ts `ModelUsageInputBound`)加可选字段并更新其上注释:

```ts
/**
 * How the input side of one billed call is provably bounded BEFORE the provider is called.
 *
 * A reservation is not a provider limit: admission needs a proof that billable input cannot
 * exceed the configured maximum. `counted` is a conservative pre-call count of the effective
 * provider request — with an optional `fit` that self-enforces the ceiling by shrinking the
 * request before it is priced and sent (ADR-0001); a provider-side exact count, where one
 * exists, remains the ideal. `unsupported` names the capability this deployment cannot prove,
 * and a call that carries it is refused rather than approximated.
 */
export type ModelUsageInputBound =
  | {
      enforced: "counted";
      maximumTokens: bigint;
      countInputTokens: (params: unknown) => number | Promise<number>;
      /**
       * The self-enforcing side of a conservative bound: given the params admission is about
       * to price, return the request this call should actually send — truncated to the
       * bound's own ceiling when the original would be refused. Absent when the bound cannot
       * self-enforce; admission then refuses an over-limit request outright.
       */
      fit?: (params: unknown) => unknown;
    }
  | { enforced: "unsupported"; reason: string };
```

准入块(meteredModel 内,`let request = params;` 已存在):

```ts
        let counted: number;
        try {
          if (
            providerBounds.input.enforced === "counted" &&
            providerBounds.input.fit
          ) {
            request = providerBounds.input.fit(params);
          }
          counted = await providerBounds.input.countInputTokens(request);
        } catch (error) {
```

maxOutputTokens 合并把 `...(params as Record<string, unknown>)` 改为 `...(request as Record<string, unknown>)`。

- [x] **Step 4: 跑全部 meter 测试确认通过(含旧回归)**

Run: `cd server && bun test tests/copilot-usage-meter.test.ts`
Expected: PASS(all)

- [x] **Step 5: 提交**

```bash
git add server/src/copilot.ts server/tests/copilot-usage-meter.test.ts
git commit -m "feat(billing): admission applies a bound's fit before counting the request"
```

---

### Task 3: gate 装配 counted 输入界(index.ts)

**Files:**
- Modify: `server/src/index.ts`(gate 的 bounds 构造与注释,import)
- Modify: `docs/configuration.md`(chat 适配器输入界说明)

**Interfaces:**
- Consumes: Task 1 `countChatInputTokens`/`fitChatInputRequest`;Task 2 合同 `fit`。
- Produces: 计费开启时 chat 适配器的输入界从 `unsupported` → `counted`。

- [x] **Step 1: 修改 index.ts**

import 区加:

```ts
import {
  countChatInputTokens,
  fitChatInputRequest,
} from "./billing/input-bound";
```

gate 的 bounds(替换 input 的 unsupported)并重写其上注释:

```ts
      /*
       * The provider-bound contract, as it stands for the adapters this deployment actually
       * invokes. The built-in instance path is the OpenAI-compatible chat model: it maps
       * maxOutputTokens to max_tokens, which the chat-completions contract enforces, so the
       * output cap is proven. Its input side has no provider-enforced ceiling, so the bound
       * is the deployment's own (ADR-0001): a conservative bytes-based count that sits above
       * a typical tokenizer, and a fit that drops the oldest non-system messages until the
       * count fits the configured ceiling — the provider cannot be SENT more than the
       * reservation prices by our own measure, and a tokenizer that beats the calibration
       * surfaces at settlement as usage_over_bound for reconciliation.
       */
      bounds: {
        input: {
          enforced: "counted" as const,
          maximumTokens: modelPolicy.input.maximumTokens,
          countInputTokens: countChatInputTokens,
          fit: fitChatInputRequest(modelPolicy.input.maximumTokens),
        },
        output: {
          enforced: "provider_cap" as const,
          maximumTokens: modelPolicy.output.maximumTokens,
        },
      },
```

- [x] **Step 2: 类型检查**

Run: `cd server && bunx tsc --noEmit -p .`
Expected: 无错误

- [x] **Step 3: 配置文档更新(docs/configuration.md 的 hard-cap 段落后补一行)**

在 `BILLING_CODE_RUN_MAX_RESERVATION_TOKENS` 表格行之后、段落说明中追加:

```md
The input maximum for a chat model is enforced by the deployment itself (ADR-0001): the
request is counted conservatively from serialized bytes and truncated — oldest non-system
messages dropped, system block and latest turn kept — until the count fits, and a request
that still cannot fit is refused before the provider is called. A tokenizer that produces
more tokens than the conservative count surfaces at settlement as an over-bound hold for
operator reconciliation rather than a silent charge.
```

- [x] **Step 4: 提交**

```bash
git add server/src/index.ts docs/configuration.md
git commit -m "feat(billing): wire the conservative counted input bound into the model gate"
```

---

### Task 4: 端到端验证(现网 lago-e2e 部署)

**Files:** 无新文件(验证任务)。

- [x] **Step 1: 重启本机 dev server(nohup 进程,`bun --watch` 会自动热载源码改动;确认监听)**

Run: `sleep 3 && lsof -iTCP:3001 -sTCP:LISTEN | tail -1`
Expected: bun 进程监听 3001

- [x] **Step 2: 用 admin 会话发起一次真实 agent run(general-assistant)**

预期:HTTP 200 受理;30s 内日志无 `input_bound_unsupported`;`credit_reservations` 新行最终 `settled`(或 released);`credit_ledger` 出现新"模型调用"行、`used` 增长;`/api/billing/credits/summary` 的 used 上升。

- [x] **Step 3: 长输入触发截断路径(可选,发一条超长消息)**

预期:日志出现 `billing-model-input-truncated`(debug),调用仍成功。

- [x] **Step 4: 汇报证据(reservation 行、ledger 行、summary 前后对比)给用户。**
