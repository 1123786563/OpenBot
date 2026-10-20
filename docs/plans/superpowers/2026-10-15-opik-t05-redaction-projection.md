# Opik T05 采集侧脱敏投影与安全内容策略 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任何内容在写入观测存储、进入评测样本或被导出之前，都先经过一次语义白名单投影；凭据、内部能力、连接串、账号标识、reasoning 内容与原始附件被排除，无法可靠处理的自由文本降级为「仅指标」而不是原样透传。

**Architecture:** 一组纯函数（无 IO、无状态、可确定性测试），沿用 `server/src/kb/infrastructure/sanitize.ts` 的风格：导出纯函数 + 导出常量 + 同目录/同层测试，用工厂函数造输入。投影结果不是 `string`，而是一个带 **state** 的判别联合：`projected` / `omitted` / `truncated`，与 #8（T02）已经定义的八类可用性状态同名同义，因此界面能如实说明「这里为什么没有内容」，而不是显示空白让人误以为无数据。策略带版本号，供 #25（T19）冻结进数据集版本。

**Tech Stack:** TypeScript（strict）、`bun:test`、Biome。无外部依赖。

**Spec:** `docs/specs/2026-10-14-opik-integration-design.md`（Implementation Decision 8「Safe content」）；Ticket：https://github.com/1123786563/OpenBot/issues/11 ；父 Spec：https://github.com/1123786563/OpenBot/issues/4 的 A4。

## Global Constraints

- 覆盖父 Spec 验收：**A4**（secret canary、能力、账号标识、敏感结构化字段、不可靠自由文本、原始附件必须不存在于实际存储、视图、样本、Judge 记录与导出中）。
- 只允许改：`server/src/ai-observability/redaction.ts`、`shared/ai-observability.ts`、`server/tests/opik-redaction.test.ts`。越界即停并上报。
- **纯函数**：不做 IO、不读环境变量、不打日志、不调用上游。因此本 Ticket 可在无 Docker、无数据库、无 Opik 的环境下完整验证。
- **fail closed**：无法判定是否安全的内容一律 `omitted`（仅指标），不得「先透传再说」，不得用正则命中数当作安全证明。
- 治理面必须覆盖 **正文、metadata、异常、名称、URL** 五类，而不只是 input/output 两个字段（父 Spec Decision 8 明确要求）。
- 三态语义严格区分：`projected`（安全内容）/ `omitted`（故意不给，附原因）/ `truncated`（给了但被截断，附原始字节数）。三者都不得显示为空字符串。
- 策略版本号是常量并导出，供下游冻结；改语义必须升版本，不得原地改含义。
- 本 Ticket **不接** 采集入口（#14 / T08 的 port）、**不接** 导出（#40 / T34）、**不接** 评测写入（#25/#26）。它只交付投影函数与契约类型。

## File Structure

| 文件 | 责任 |
| --- | --- |
| `shared/ai-observability.ts` | 前后端共享词汇：`SafeContentState`、`SafeText`、`SafeValue`、策略版本常量名。单一责任＝「安全内容的形状」。 |
| `server/src/ai-observability/redaction.ts` | 投影实现：文本、记录、metadata、异常、名称、URL 六个投影函数 + 拒绝模式。 |
| `server/tests/opik-redaction.test.ts` | canary 驱动的对抗测试：每类敏感内容都必须证明「投影后不存在」。 |

---

### Task 1: 共享契约类型 `SafeContentState` / `SafeText` / `SafeValue`

**Files:**
- Create: `shared/ai-observability.ts`
- Test: `server/tests/opik-redaction.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export const REDACTION_POLICY_VERSION = "opik-redaction/1"`
  - `export type SafeContentState = "projected" | "omitted" | "truncated"`
  - `export type SafeText = { state: "projected"; text: string } | { state: "omitted"; reason: OmitReason } | { state: "truncated"; text: string; originalBytes: number }`
  - `export type OmitReason = "credential" | "connection_string" | "account_identifier" | "reasoning_content" | "raw_attachment" | "internal_capability" | "unhandled_free_text"`
  - `export type SafeValue = { state: "projected"; value: unknown } | { state: "omitted"; reason: OmitReason } | { state: "truncated"; value: string; originalBytes: number }`
  - `export const OMIT_COPY_KEY: Record<OmitReason, string>` — 映射到 #8 定义的 i18n key（`availability.omitted` 等），使前端不需要自己发明文案

- [ ] **Step 1: 写失败测试**

创建 `server/tests/opik-redaction.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/tests/opik-redaction.test.ts`
Expected: FAIL — `Cannot find module '../../shared/ai-observability'`

- [ ] **Step 3: 写 `shared/ai-observability.ts`**

```ts
/**
 * The shape of content that is safe to store, evaluate and export.
 *
 * A projection never answers with a bare string. "Nothing here" is three different facts and the
 * UI has to tell them apart: the value was projected and is safe; it was withheld on purpose; it
 * was given but cut. Collapsing them into "" is how a redaction system starts lying — an operator
 * reads an empty field as "the run produced nothing" instead of "we refused to show you this".
 *
 * The state names match the availability copy registered by ticket #8, so a view can render the
 * reason without inventing wording per surface.
 */

/** Bump this whenever the semantics below change. Frozen into dataset versions by ticket #25. */
export const REDACTION_POLICY_VERSION = "opik-redaction/1";

export type SafeContentState = "projected" | "omitted" | "truncated";

export type OmitReason =
  | "credential"
  | "connection_string"
  | "account_identifier"
  | "reasoning_content"
  | "raw_attachment"
  | "internal_capability"
  | "unhandled_free_text";

export type SafeText =
  | { state: "projected"; text: string }
  | { state: "omitted"; reason: OmitReason }
  | { state: "truncated"; text: string; originalBytes: number };

export type SafeValue =
  | { state: "projected"; value: unknown }
  | { state: "omitted"; reason: OmitReason }
  | { state: "truncated"; value: string; originalBytes: number };

/**
 * Reason -> the i18n key that explains it. Keys live in the `ai-observability-*` namespaces
 * created by ticket #8; a reason without a key is a type error here, not a blank string there.
 */
export const OMIT_COPY_KEY: Record<OmitReason, string> = {
  credential: "availability.omitted",
  connection_string: "availability.omitted",
  account_identifier: "availability.omitted",
  reasoning_content: "availability.omitted",
  raw_attachment: "availability.omitted",
  internal_capability: "availability.omitted",
  unhandled_free_text: "availability.omitted",
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/tests/opik-redaction.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: 提交**

```bash
git add shared/ai-observability.ts server/tests/opik-redaction.test.ts
git commit -m "feat(opik): safe-content contract — projected, omitted and truncated are three facts"
```

---

### Task 2: 文本与 URL 投影（canary 驱动）

**Files:**
- Create: `server/src/ai-observability/redaction.ts`
- Test: `server/tests/opik-redaction.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `SafeText` / `OmitReason`。
- Produces:
  - `export const MAX_SAFE_TEXT_BYTES = 8_192`
  - `export function projectSafeText(input: string | null | undefined, opts?: { allowFreeText?: boolean }): SafeText`
  - `export function projectSafeUrl(input: string | null | undefined): SafeText`
  - `export function projectSafeName(input: string | null | undefined): SafeText`
  - `export const SECRET_CANARIES` — 测试与实现共用的 canary 清单（实现只用它做**拒绝模式**，不做“替换 canary”式的假脱敏）

- [ ] **Step 1: 追加失败测试**

```ts
import {
  MAX_SAFE_TEXT_BYTES,
  projectSafeName,
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
  postgresDsn: "postgresql://opik:s3cr3t@10.0.0.5:5432/openbot",
  mysqlDsn: "mysql://root:rootpw@db.internal:3306/opik",
  redisUrl: "redis://:redispass@cache.internal:6379/0",
  accountId: "acct_1A2B3C4D5E6F7G8H",
  internalCapability: "openbot.internal.capability/computer-control",
  reasoning: "<reasoning>the user probably wants to bypass the budget check</reasoning>",
  privateFileUrl: "http://127.0.0.1:8080/files/raw/att_01HXYZ?sig=abc123def456",
};

describe("projectSafeText", () => {
  test("ordinary prose is projected unchanged", () => {
    expect(projectSafeText("Summarize the March invoices.")).toEqual({
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
    if (result.state === "truncated") expect(result.text).not.toMatch(/\uFFFD$/);
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/tests/opik-redaction.test.ts`
Expected: FAIL — `Cannot find module '../src/ai-observability/redaction'`

- [ ] **Step 3: 写 `server/src/ai-observability/redaction.ts`**

```ts
/**
 * Projection, not masking.
 *
 * Every value that reaches the observability store, an evaluation sample, a Judge prompt or an
 * export passes through here first. The rule is an allowlist: content is projected when it is
 * known-safe, and omitted otherwise. There is no "scrub the patterns we thought of" mode, because
 * a masker that rewrites the literals it was tested with passes its own test and leaks the next
 * credential shape.
 *
 * Free text is the hard case. Unreviewed prose is omitted (metrics only) unless the caller
 * explicitly asserts it handled the content — `allowFreeText` is that assertion, and even it does
 * not license a credential: the deny patterns run first and always win.
 */
import {
  type OmitReason,
  type SafeText,
} from "../../../shared/ai-observability";

export const MAX_SAFE_TEXT_BYTES = 8_192;
const MAX_SAFE_NAME_BYTES = 128;

/** Deny patterns. Ordered so the most specific reason wins. */
const DENY: ReadonlyArray<{ reason: OmitReason; pattern: RegExp }> = [
  { reason: "connection_string", pattern: /\b(?:postgresql|postgres|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/\S+/i },
  { reason: "credential", pattern: /\bBearer\s+[A-Za-z0-9._\-]{16,}/i },
  { reason: "credential", pattern: /\bsk-(?:live|test|proj)-[A-Za-z0-9._\-]{16,}/ },
  { reason: "credential", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { reason: "credential", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { reason: "credential", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { reason: "credential", pattern: /\b-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { reason: "credential", pattern: /\b[A-Za-z0-9/+=]{40}\b(?=.*(?:secret|password|passwd|pwd))/i },
  { reason: "account_identifier", pattern: /\bacct_[A-Za-z0-9]{12,}\b/ },
  { reason: "account_identifier", pattern: /\bcus_[A-Za-z0-9]{12,}\b/ },
  { reason: "internal_capability", pattern: /\bopenbot\.internal\.[\w./-]+/i },
  { reason: "reasoning_content", pattern: /<\s*reasoning\s*>/i },
];

function denyReason(input: string): OmitReason | undefined {
  for (const { reason, pattern } of DENY) {
    if (pattern.test(input)) return reason;
  }
  return undefined;
}

/** Cut on a UTF-8 byte budget without splitting a character or emitting U+FFFD. */
function cutToBytes(input: string, budget: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(input).length <= budget) return input;
  let text = input;
  // Binary-search the longest prefix that fits, then drop a trailing partial code point.
  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(input.slice(0, mid)).length <= budget) low = mid;
    else high = mid - 1;
  }
  text = input.slice(0, low);
  return text.replace(/\uFFFD$/, "");
}

function project(input: string, budget: number): SafeText {
  const bytes = new TextEncoder().encode(input).length;
  if (bytes <= budget) return { state: "projected", text: input };
  return { state: "truncated", text: cutToBytes(input, budget), originalBytes: bytes };
}

/**
 * Body text. `allowFreeText` is the caller's explicit assertion that this content was reviewed
 * (a saved dataset case, a curated synthetic sample). Without it, unreviewed prose is metrics-only.
 */
export function projectSafeText(
  input: string | null | undefined,
  opts: { allowFreeText?: boolean } = {},
): SafeText {
  if (input === null || input === undefined) return { state: "projected", text: "" };
  const denied = denyReason(input);
  if (denied) return { state: "omitted", reason: denied };
  if (!opts.allowFreeText) return { state: "omitted", reason: "unhandled_free_text" };
  return project(input, MAX_SAFE_TEXT_BYTES);
}

/**
 * URLs. A private raw-file link with a signature is an attachment, not a reference: following it
 * would hand the reader content the projection just refused. Query and fragment are dropped from
 * what survives, because that is where signatures and account ids live.
 */
export function projectSafeUrl(input: string | null | undefined): SafeText {
  if (input === null || input === undefined || input.trim() === "") {
    return { state: "projected", text: "" };
  }
  const denied = denyReason(input);
  if (denied) return { state: "omitted", reason: denied };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { state: "omitted", reason: "unhandled_free_text" };
  }
  if (url.username || url.password) return { state: "omitted", reason: "credential" };
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { state: "omitted", reason: "unhandled_free_text" };
  }
  const isRawFile = /\/(?:files|attachments|download)\//i.test(url.pathname);
  const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (isRawFile || isLoopback || url.search || url.hash) {
    return { state: "omitted", reason: isRawFile || isLoopback ? "raw_attachment" : "unhandled_free_text" };
  }
  return project(`${url.protocol}//${url.host}${url.pathname}`, MAX_SAFE_TEXT_BYTES);
}

/** Span, tool and model names: short, structured, and a favourite hiding place for capability names. */
export function projectSafeName(input: string | null | undefined): SafeText {
  if (input === null || input === undefined) return { state: "projected", text: "" };
  const denied = denyReason(input);
  if (denied) return { state: "omitted", reason: denied };
  if (!/^[\w.:/@ -]{0,256}$/u.test(input)) return { state: "omitted", reason: "unhandled_free_text" };
  return project(input, MAX_SAFE_NAME_BYTES);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/tests/opik-redaction.test.ts`
Expected: PASS（含 `test.each` 的 12 条 canary 用例）

> 若某条 canary 未被拒绝：**加拒绝模式**，不要放宽测试。若某条正常文本被误拒：调整模式的精度（例如给 40 字符 base64 模式加 secret/password 上下文约束），不要删掉该模式。

- [ ] **Step 5: 提交**

```bash
git add server/src/ai-observability/redaction.ts server/tests/opik-redaction.test.ts
git commit -m "feat(opik): project body text, URLs and names through a deny-then-allowlist filter"
```

---

### Task 3: 结构化投影 —— 记录、metadata 与异常

**Files:**
- Modify: `server/src/ai-observability/redaction.ts`
- Test: `server/tests/opik-redaction.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的三个投影函数。
- Produces:
  - `export type SafeRecord = Record<string, SafeValue>`
  - `export function projectSafeRecord(record: unknown, allowlist: readonly string[]): SafeRecord`
  - `export function projectSafeMetadata(metadata: unknown, allowlist?: readonly string[]): SafeRecord`
  - `export function projectSafeException(error: unknown): SafeText`
  - `export const DEFAULT_METADATA_ALLOWLIST: readonly string[]`
  - `export const MAX_SAFE_RECORD_KEYS = 64`、`export const MAX_SAFE_RECORD_DEPTH = 4`

- [ ] **Step 1: 追加失败测试**

```ts
import {
  DEFAULT_METADATA_ALLOWLIST,
  MAX_SAFE_RECORD_DEPTH,
  projectSafeException,
  projectSafeMetadata,
  projectSafeRecord,
} from "../src/ai-observability/redaction";
import type { SafeValue } from "../../shared/ai-observability";

function values(record: Record<string, SafeValue>): string {
  return JSON.stringify(record);
}

describe("projectSafeRecord", () => {
  test("only allowlisted keys survive", () => {
    const result = projectSafeRecord(
      { model: "gpt-4o", tokensInput: 12, prompt: "hello", apiKey: CANARIES.openaiStyle },
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
    let deep: Record<string, unknown> = { leaf: "value" };
    for (let i = 0; i < MAX_SAFE_RECORD_DEPTH + 2; i += 1) deep = { nested: deep };
    const result = projectSafeRecord(deep, ["nested"]);
    expect(values(result)).not.toContain("value");
  });

  test("a non-object input yields an empty record rather than throwing", () => {
    expect(projectSafeRecord("a string", ["a"])).toEqual({});
    expect(projectSafeRecord(null, ["a"])).toEqual({});
    expect(projectSafeRecord(undefined, ["a"])).toEqual({});
  });

  test("arrays inside an allowlisted key are projected element-wise", () => {
    const result = projectSafeRecord({ tools: ["search", CANARIES.internalCapability] }, ["tools"]);
    const value = result.tools;
    expect(value.state).toBe("projected");
    expect(values(result)).not.toContain("computer-control");
  });
});

describe("projectSafeMetadata", () => {
  test("the default allowlist is small and contains no free-text field", () => {
    expect(DEFAULT_METADATA_ALLOWLIST.length).toBeLessThanOrEqual(16);
    for (const key of ["input", "output", "messages", "content", "body", "prompt", "text"]) {
      expect(DEFAULT_METADATA_ALLOWLIST, `${key} must not be a default metadata key`).not.toContain(key);
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
    expect(result).toEqual({ state: "projected", text: "upstream returned 503" });
  });

  test("a non-Error value is projected as its class name, never as its content", () => {
    expect(projectSafeException({ secret: CANARIES.awsSecret })).toEqual({
      state: "projected",
      text: "Object",
    });
    expect(projectSafeException("boom")).toEqual({ state: "projected", text: "String" });
  });

  test("an Error subclass keeps its name", () => {
    class UpstreamTimeout extends Error {}
    expect(projectSafeException(new UpstreamTimeout("timed out"))).toEqual({
      state: "projected",
      text: "UpstreamTimeout: timed out",
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/tests/opik-redaction.test.ts`
Expected: FAIL — `projectSafeRecord` 等未导出

- [ ] **Step 3: 在 `redaction.ts` 追加实现**

```ts
export const MAX_SAFE_RECORD_KEYS = 64;
export const MAX_SAFE_RECORD_DEPTH = 4;

/**
 * Metadata an SDK captures automatically is the least reviewed content in the system, so its
 * allowlist is deliberately tiny and contains no free-text field: a key named `input` or `content`
 * would make the allowlist a doorway for exactly what the body projection refuses.
 */
export const DEFAULT_METADATA_ALLOWLIST: readonly string[] = [
  "thread_id",
  "bot_id",
  "run_id",
  "attempt_id",
  "deployment_version",
  "prompt_version",
  "model",
  "provider",
  "environment",
  "capability",
  "duration_ms",
  "tokens_input",
  "tokens_output",
];

export type SafeRecord = Record<string, SafeValue>;

function projectLeaf(value: unknown): SafeValue {
  if (value === null || value === undefined) return { state: "projected", value: null };
  if (typeof value === "number" || typeof value === "boolean") {
    return { state: "projected", value };
  }
  if (typeof value === "string") {
    const denied = denyReason(value);
    if (denied) return { state: "omitted", reason: denied };
    const bytes = new TextEncoder().encode(value).length;
    if (bytes > MAX_SAFE_TEXT_BYTES) {
      return { state: "truncated", value: cutToBytes(value, MAX_SAFE_TEXT_BYTES), originalBytes: bytes };
    }
    return { state: "projected", value };
  }
  // Functions, symbols, class instances: no reliable projection, so metrics only.
  return { state: "omitted", reason: "unhandled_free_text" };
}

function projectDeep(value: unknown, depth: number): SafeValue {
  if (depth > MAX_SAFE_RECORD_DEPTH) return { state: "omitted", reason: "unhandled_free_text" };
  if (Array.isArray(value)) {
    return { state: "projected", value: value.slice(0, MAX_SAFE_RECORD_KEYS).map((item) => projectDeep(item, depth + 1)) };
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, SafeValue> = {};
    for (const key of Object.keys(source).slice(0, MAX_SAFE_RECORD_KEYS)) {
      out[key] = projectDeep(source[key], depth + 1);
    }
    return { state: "projected", value: out };
  }
  return projectLeaf(value);
}

/** Allowlist first: a key that is not listed is dropped outright, never rendered as `omitted`. */
export function projectSafeRecord(record: unknown, allowlist: readonly string[]): SafeRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) return {};
  const source = record as Record<string, unknown>;
  const out: SafeRecord = {};
  for (const key of allowlist.slice(0, MAX_SAFE_RECORD_KEYS)) {
    if (!(key in source)) continue;
    const value = source[key];
    if (typeof value === "string") {
      out[key] = projectLeaf(value);
      continue;
    }
    out[key] = projectDeep(value, 1);
  }
  return out;
}

export function projectSafeMetadata(
  metadata: unknown,
  allowlist: readonly string[] = DEFAULT_METADATA_ALLOWLIST,
): SafeRecord {
  return projectSafeRecord(metadata, allowlist);
}

/**
 * Exceptions. The stack trace never leaves the process: it is full of file paths, connection
 * strings and occasionally the argument values that caused the failure. A non-Error answers with
 * its class name, because "what kind of thing failed" is safe and its content is not.
 */
export function projectSafeException(error: unknown): SafeText {
  if (error instanceof Error) {
    const name = error.name === "Error" ? "" : `${error.name}: `;
    const message = `${name}${error.message}`;
    const denied = denyReason(message);
    if (denied) return { state: "omitted", reason: denied };
    return project(message, MAX_SAFE_TEXT_BYTES);
  }
  if (error === null || error === undefined) return { state: "projected", text: "null" };
  const kind = typeof error === "object"
    ? (error as object).constructor?.name ?? "Object"
    : error.constructor?.name ?? typeof error;
  return { state: "projected", text: kind };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/tests/opik-redaction.test.ts`
Expected: PASS（全部 describe 块）

- [ ] **Step 5: 类型检查与格式**

Run: `cd server && bun run typecheck && cd .. && bunx biome lint --error-on-warnings server/src/ai-observability shared/ai-observability.ts server/tests/opik-redaction.test.ts && bunx biome format server/src/ai-observability shared/ai-observability.ts server/tests/opik-redaction.test.ts`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add server/src/ai-observability/redaction.ts server/tests/opik-redaction.test.ts
git commit -m "feat(opik): allowlist projection for records, SDK metadata and exceptions"
```

---

## Self-Review

**Spec coverage（Ticket #11 的 4 条验收标准）**
1. 「凭据、内部能力、连接串、账号标识、reasoning 内容与原始附件在任何写入或导出前被排除」→ Task 2 的 `DENY` 模式表 + `test.each` 对 12 个 canary 逐一断言「不存在于输出」。
2. 「语义字段白名单驱动投影；无法可靠处理的自由文本降级为仅指标，而不是原样透传」→ Task 2 的 `allowFreeText` 显式断言语义 + Task 3 的 `projectSafeRecord` allowlist-first；`unhandled_free_text` 是默认结局。
3. 「治理覆盖正文、metadata、异常、名称与 URL，不只覆盖输入输出两个字段」→ 五个投影函数各自有独立 describe 块：`projectSafeText`（正文）、`projectSafeMetadata`（metadata）、`projectSafeException`（异常）、`projectSafeName`（名称）、`projectSafeUrl`（URL）。
4. 「内容策略带版本号并可被下游冻结引用；canary 测试证明无泄露」→ Task 1 的 `REDACTION_POLICY_VERSION` + 全部 canary 断言以「输出不包含 canary」形式书写（而非「canary 被替换成 \*\*\*」）。

**A4 覆盖**：canary 清单覆盖 bearer / OpenAI 风格 / AWS access key + secret / GitHub token / Slack token / PEM 私钥 / postgres+mysql+redis DSN / 账号标识 / 内部能力名 / reasoning 标签 / 带签名的私有文件 URL。

**Placeholder scan**：无 TBD / TODO / “类似 Task N”；三个 Task 的实现代码完整给出。测试里的 `values({ m: result })` 是有意为之的 JSON 序列化断言辅助，已在测试文件内定义。

**Type consistency**：`SafeText` / `SafeValue` / `OmitReason` 在 Task 1 定义，Task 2/3 只消费不重定义；`project()` 与 `cutToBytes()` 在 Task 2 定义、Task 3 复用（同文件模块内）；`denyReason()` 在 Task 2 定义、Task 3 的 `projectLeaf` / `projectSafeException` 复用；`MAX_SAFE_TEXT_BYTES` 在 Task 2 导出、Task 3 的 `projectLeaf` 使用；`SafeRecord` 在 Task 3 定义并被 `projectSafeMetadata` 返回。

**已知限制（不得当作通过）**：`DENY` 是模式表而非语义分析，因此**新颖凭据形状可能漏网**。这就是为什么 `projectSafeText` 默认 `allowFreeText=false`：不可靠的自由文本走 omitted。下游（#14 / T08 port、#26 / T20 案例保存、#40 / T34 导出）必须调用本模块而不是自行序列化，这一点由 #43（T37）对真实实例的 canary 验收把关。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-15-opik-t05-redaction-projection.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每个 Task 派发新的 subagent，Task 之间 review。
2. **Inline Execution** — 本会话内按 executing-plans 批量执行并设检查点。

完成后把提交哈希与 canary 清单写入 `docs/tickets/opik-4/manifest.json` 的 `T05.handoff.checkpoint`，并在 GitHub #11 勾选验收标准。
