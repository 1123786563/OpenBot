# Opik T06 可信 scope seam 与企业预留拒绝 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「授权范围 / 存储定位 / 评测资格」三件事收进一个可替换的 seam，当前只实现工作台适配器；未知企业 scope 被拒绝且不回退；scope 参与记录键、游标、缓存、导出与任务，使两个可信 scope 即便资源 ID 相同也无法互相读取。

**Architecture:** 直接照搬仓库已有的 fail-closed 先例 `server/src/enterprise/tenancy/scope.ts`：scope 只能由 `resolveObservationScope` 产生，产出的对象 `Object.freeze` 并登记进模块私有 `WeakSet`，`assertObservationScope` 只承认本进程真正签发过的对象——序列化再还原的、展开复制的、手搓的普通对象一律失败。错误类型照搬 `EnterpriseError` 的约定（**code 即契约，message 就是 code**，调用方按 code 分类、按 status 映射传输状态，绝不解析文案）。**关键区别**：企业分支不是一个待实现的适配器，而是一条拒绝路径——本 Ticket 不建租户表、不伪造租户、不引入隐式租户头、不建租户角色层级、不把 workspace/project 布局当授权，并且用一条静态测试把这条纪律钉住。

**Tech Stack:** TypeScript（strict）、`bun:test`、Biome。无数据库、无外部依赖。

**Spec:** `docs/specs/2026-10-14-opik-integration-design.md`（Implementation Decision 5「Authorization」、6「Enterprise reservation」、7「No premature tenant model」）；Ticket：https://github.com/1123786563/OpenBot/issues/12 ；父 Spec：https://github.com/1123786563/OpenBot/issues/4 的 A5、A12。

## Global Constraints

- 覆盖父 Spec 验收：**A12**（测试适配器提供两个可信 scope 而无真实租户表：相同资源 ID、外部游标/缓存/任务不能跨 scope，未知企业 scope 被拒绝且不回退）、**A5**（授权基础）。
- 只允许改：`server/src/ai-observability/scope.ts`、`server/src/ai-observability/contracts.ts`、`server/tests/opik-scope.test.ts`。越界即停并上报。
- **禁止**：创建租户表或任何 `tenant*` 迁移；伪造租户；读取隐式租户请求头；建立租户角色层级；把 Opik workspace/project 布局当作授权证明；推断既有工作台数据的租户归属。
- **禁止**导出任何 `issueScopeUnsafe` 式的逃生舱（上游先例的注释明确写了 “deliberately NOT exported”）。
- scope 必须是显式参数，逐层携带；**不得**引入模块级 “current scope” 变量。
- 未知企业 scope 一律拒绝，**不得**回退到工作台 scope，也不得“先按工作台处理”。
- 纯逻辑，不碰数据库、不打网络；因此本 Ticket 可在无 Docker / 无 PostgreSQL / 无 Opik 的环境下完整验证。
- 归属事实（谁是 owner、是否 admin）由调用方注入（`ownership`），本模块**不自己查库**——查库是 #7（T07）与 #17（T11）的职责。

## File Structure

| 文件 | 责任 |
| --- | --- |
| `server/src/ai-observability/contracts.ts` | 词汇与错误契约：scope 形状、解析输入、错误 code/status、存储定位、评测资格。单一责任＝「观测授权领域的类型与拒绝码」。 |
| `server/src/ai-observability/scope.ts` | 唯一的 scope 签发点与三件事的工作台适配器：授权范围、存储定位、评测资格；外加游标绑定。 |
| `server/tests/opik-scope.test.ts` | 两个可信 scope 的隔离、伪造/复制/序列化 scope 的拒绝、企业 scope 的拒绝、以及「无租户表」纪律的静态守卫。 |

---

### Task 1: 契约与拒绝码 `contracts.ts`

**Files:**
- Create: `server/src/ai-observability/contracts.ts`
- Test: `server/tests/opik-scope.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export type ObservationScopeKind = "workbench"`
  - `export type ObservationScope = Readonly<{ kind: ObservationScopeKind; key: string; actorId: string; botId: string; epoch: number }>`
  - `export type BotOwnership = "owner" | "admin" | "none"`
  - `export type ScopeResolutionInput = { actorId: string | undefined; botId: string | undefined; ownership: BotOwnership; epoch: number; enterpriseHint?: unknown }`
  - `export type ObservationScopeErrorCode = "AUTH_REQUIRED" | "BOT_REQUIRED" | "OWNERSHIP_REQUIRED" | "ENTERPRISE_SCOPE_UNSUPPORTED"`
  - `export class ObservationScopeError extends Error { code: ObservationScopeErrorCode; status: 400 | 401 | 403 }`
  - `export type ObservationStorageLocator = Readonly<{ scopeKey: string; workspace: string; project: string }>`
  - `export type EvaluationEligibility = Readonly<{ allowed: true; scopeKey: string } | { allowed: false; code: ObservationScopeErrorCode }>`

- [ ] **Step 1: 写失败测试**

创建 `server/tests/opik-scope.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import {
  ObservationScopeError,
  type BotOwnership,
  type ObservationScopeErrorCode,
} from "../src/ai-observability/contracts";

const STATUS: Record<ObservationScopeErrorCode, 400 | 401 | 403> = {
  AUTH_REQUIRED: 401,
  BOT_REQUIRED: 400,
  OWNERSHIP_REQUIRED: 403,
  ENTERPRISE_SCOPE_UNSUPPORTED: 403,
};

describe("ObservationScopeError", () => {
  test("the code is the contract and the message is just the code", () => {
    for (const code of Object.keys(STATUS) as ObservationScopeErrorCode[]) {
      const error = new ObservationScopeError(code, STATUS[code]);
      expect(error.code).toBe(code);
      expect(error.message).toBe(code);
      expect(error.status).toBe(STATUS[code]);
      expect(error).toBeInstanceOf(Error);
    }
  });

  test("the three ownership answers are exhaustive", () => {
    const all: BotOwnership[] = ["owner", "admin", "none"];
    expect(all).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/tests/opik-scope.test.ts`
Expected: FAIL — `Cannot find module '../src/ai-observability/contracts'`

- [ ] **Step 3: 写 `server/src/ai-observability/contracts.ts`**

```ts
/**
 * Observation authorization vocabulary.
 *
 * Errors follow the house convention (server/src/enterprise/errors.ts): the code is the contract
 * and the message is deliberately just the code. Callers classify by `code`, map transport status
 * from `status`, and never parse message text. Anything unrecognized fails closed.
 *
 * There is exactly ONE scope kind. That is not an oversight and not a stub: the parent Spec
 * reserves enterprise tenancy as a seam, and a seam that already has a second variant is a seam
 * somebody has started to guess at. An enterprise caller is refused by `resolveObservationScope`
 * with ENTERPRISE_SCOPE_UNSUPPORTED rather than admitted under a kind this codebase cannot yet
 * authorize.
 */

export type ObservationScopeKind = "workbench";

/**
 * The scope every observation consumer carries explicitly. `key` is what participates in record
 * keys, cursors, caches, exports and jobs, so two scopes with the same botId are still two
 * different key spaces. `epoch` is the ownership generation: a transfer or revocation bumps it,
 * which invalidates every cursor and cache entry minted under the old one.
 */
export type ObservationScope = Readonly<{
  kind: ObservationScopeKind;
  key: string;
  actorId: string;
  botId: string;
  epoch: number;
}>;

/** The caller's answer about this Bot, resolved elsewhere. This module never queries for it. */
export type BotOwnership = "owner" | "admin" | "none";

export type ScopeResolutionInput = {
  actorId: string | undefined;
  botId: string | undefined;
  ownership: BotOwnership;
  /** Ownership generation; bump on transfer or revocation so cached cursors die with it. */
  epoch: number;
  /**
   * Anything an enterprise integration might hand us. Present-and-unresolved is a refusal, not a
   * hint to fall back to the workbench. Deliberately `unknown`: this module must not learn to read
   * a tenant id, a tenant header, or a workspace name out of it.
   */
  enterpriseHint?: unknown;
};

export type ObservationScopeErrorCode =
  | "AUTH_REQUIRED"
  | "BOT_REQUIRED"
  | "OWNERSHIP_REQUIRED"
  | "ENTERPRISE_SCOPE_UNSUPPORTED";

export class ObservationScopeError extends Error {
  constructor(
    public code: ObservationScopeErrorCode,
    public status: 400 | 401 | 403,
  ) {
    super(code);
  }
}

/** Where a scope's records live upstream. A locator is not a permission — see resolveStorageLocator. */
export type ObservationStorageLocator = Readonly<{
  scopeKey: string;
  workspace: string;
  project: string;
}>;

export type EvaluationEligibility = Readonly<
  { allowed: true; scopeKey: string } | { allowed: false; code: ObservationScopeErrorCode }
>;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/tests/opik-scope.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: 提交**

```bash
git add server/src/ai-observability/contracts.ts server/tests/opik-scope.test.ts
git commit -m "feat(opik): observation scope vocabulary and fail-closed refusal codes"
```

---

### Task 2: 唯一签发点 `resolveObservationScope` 与进程内信任

**Files:**
- Create: `server/src/ai-observability/scope.ts`
- Test: `server/tests/opik-scope.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的全部类型与 `ObservationScopeError`。
- Produces:
  - `export function resolveObservationScope(input: ScopeResolutionInput): ObservationScope`
  - `export function assertObservationScope(scope: unknown): asserts scope is ObservationScope`
  - `export function scopeKey(actorId: string, botId: string, epoch: number): string`
  - **不导出**任何 unsafe 签发函数

- [ ] **Step 1: 追加失败测试**

在 `server/tests/opik-scope.test.ts` 顶部补充 import：

```ts
import {
  assertObservationScope,
  resolveObservationScope,
  scopeKey,
} from "../src/ai-observability/scope";
```

在文件末尾追加：

```ts
const actorA = "user-a";
const actorB = "user-b";

function workbench(overrides: Partial<Parameters<typeof resolveObservationScope>[0]> = {}) {
  return resolveObservationScope({
    actorId: actorA,
    botId: "agent-1",
    ownership: "owner",
    epoch: 1,
    ...overrides,
  });
}

describe("resolveObservationScope", () => {
  test("an owner gets a frozen workbench scope", () => {
    const scope = workbench();
    expect(scope.kind).toBe("workbench");
    expect(scope.actorId).toBe(actorA);
    expect(scope.botId).toBe("agent-1");
    expect(scope.epoch).toBe(1);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  test("an administrator gets a scope, and its key differs from the owner's", () => {
    const asAdmin = workbench({ actorId: actorB, ownership: "admin" });
    expect(asAdmin.key).not.toBe(workbench().key);
  });

  test("a missing actor is 401 before ownership is even considered", () => {
    expect(() => workbench({ actorId: undefined })).toThrow(new ObservationScopeError("AUTH_REQUIRED", 401));
  });

  test("the dev-local placeholder actor is not an authenticated identity", () => {
    expect(() => workbench({ actorId: "dev-local-user" })).toThrow(
      new ObservationScopeError("AUTH_REQUIRED", 401),
    );
  });

  test("a missing bot id is 400", () => {
    expect(() => workbench({ botId: undefined })).toThrow(new ObservationScopeError("BOT_REQUIRED", 400));
  });

  test("ownership 'none' is 403 even with a valid actor and bot", () => {
    expect(() => workbench({ ownership: "none" })).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
  });

  test("an ownership epoch bump produces a different key, killing old cursors", () => {
    expect(workbench({ epoch: 2 }).key).not.toBe(workbench({ epoch: 1 }).key);
  });

  test("scopeKey is deterministic and injective over its three inputs", () => {
    expect(scopeKey(actorA, "agent-1", 1)).toBe(scopeKey(actorA, "agent-1", 1));
    expect(scopeKey(actorA, "agent-1", 1)).not.toBe(scopeKey(actorA, "agent-2", 1));
    expect(scopeKey(actorA, "agent-1", 1)).not.toBe(scopeKey(actorB, "agent-1", 1));
  });

  test("a bot id cannot smuggle a separator and collide with another key", () => {
    expect(scopeKey(actorA, "agent-1:2", 1)).not.toBe(scopeKey(actorA, "agent-1", 2));
    expect(scopeKey(actorA, "agent|1", 1)).not.toBe(scopeKey(actorA, "agent", 1));
  });
});

describe("enterprise reservation is a refusal, not a fallback", () => {
  test("an unresolved enterprise hint is refused", () => {
    expect(() => workbench({ enterpriseHint: { tenantId: "acme" } })).toThrow(
      new ObservationScopeError("ENTERPRISE_SCOPE_UNSUPPORTED", 403),
    );
  });

  test("a tenant header value is refused, not read", () => {
    expect(() => workbench({ enterpriseHint: "acme" })).toThrow(
      new ObservationScopeError("ENTERPRISE_SCOPE_UNSUPPORTED", 403),
    );
  });

  test("an empty or null hint is not an enterprise request", () => {
    expect(workbench({ enterpriseHint: undefined }).kind).toBe("workbench");
    expect(workbench({ enterpriseHint: null }).kind).toBe("workbench");
  });

  test("refusal happens before ownership, so a valid owner still cannot borrow a workbench scope", () => {
    expect(() =>
      resolveObservationScope({
        actorId: actorA,
        botId: "agent-1",
        ownership: "owner",
        epoch: 1,
        enterpriseHint: { workspace: "acme" },
      }),
    ).toThrow(new ObservationScopeError("ENTERPRISE_SCOPE_UNSUPPORTED", 403));
  });
});

describe("assertObservationScope — process-internal trust", () => {
  test("a scope this process issued passes", () => {
    const scope = workbench();
    expect(() => assertObservationScope(scope)).not.toThrow();
  });

  test("a serialized-and-restored scope fails closed", () => {
    const restored = JSON.parse(JSON.stringify(workbench()));
    expect(() => assertObservationScope(restored)).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
  });

  test("a spread copy fails closed", () => {
    const copy = { ...workbench() };
    expect(() => assertObservationScope(copy)).toThrow();
  });

  test("a hand-built object with the right shape fails closed", () => {
    const forged = Object.freeze({
      kind: "workbench" as const,
      key: scopeKey(actorA, "agent-1", 1),
      actorId: actorA,
      botId: "agent-1",
      epoch: 1,
    });
    expect(() => assertObservationScope(forged)).toThrow();
  });

  test("null, undefined and primitives fail closed", () => {
    for (const value of [null, undefined, "workbench", 42, []]) {
      expect(() => assertObservationScope(value)).toThrow();
    }
  });

  test("the module exports no unsafe issuance escape hatch", () => {
    const exports = Object.keys(require("../src/ai-observability/scope"));
    expect(exports.filter((name) => /unsafe|internal|forge|bypass|raw/i.test(name))).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/tests/opik-scope.test.ts`
Expected: FAIL — `Cannot find module '../src/ai-observability/scope'`

- [ ] **Step 3: 写 `server/src/ai-observability/scope.ts`**

```ts
/**
 * Scope issuance and process-internal trust.
 *
 * `resolveObservationScope` is the ONLY way an observation scope comes to exist. It takes the
 * actorId the AuthService verified, the Bot the caller named, and the caller's answer about
 * ownership — never a body or header value it parsed itself. There is no module-level "current
 * scope": the scope is an explicit argument every consumer carries.
 *
 * Trust is recorded in a module-private WeakSet, so only the frozen objects this process actually
 * issued answer `assertObservationScope`. A serialized-and-restored scope, a spread copy, or a
 * hand-built plain object is not in the set and fails closed. Background workers must re-derive a
 * scope from their own authenticated identity and live ownership. Deliberately NOT exported is any
 * `issueScopeUnsafe`-style escape hatch.
 *
 * Enterprise tenancy: an unresolved enterprise hint is a refusal, not a suggestion to fall back.
 * This file must not grow a tenant table read, a tenant header parse, a workspace-to-tenant map, or
 * a second scope kind. When the enterprise Spec is approved, the seam to replace is this function.
 */
import {
  ObservationScopeError,
  type ObservationScope,
  type ScopeResolutionInput,
} from "./contracts";

const issued = new WeakSet<object>();

/** The dev placeholder the enterprise seam also refuses: a scope needs a real authenticated id. */
const PLACEHOLDER_ACTOR = "dev-local-user";

/**
 * Key layout: length-prefixed so a botId containing the separator cannot shift fields and collide
 * with another (actor, bot, epoch) triple. `wb` is the kind tag; a future kind gets its own tag and
 * therefore its own key space rather than sharing this one.
 */
export function scopeKey(actorId: string, botId: string, epoch: number): string {
  const parts = ["wb", actorId, botId, String(epoch)];
  return parts.map((part) => `${part.length}:${part}`).join("|");
}

function isEnterpriseHint(hint: unknown): boolean {
  return hint !== undefined && hint !== null;
}

export function resolveObservationScope(input: ScopeResolutionInput): ObservationScope {
  /*
   * Order matters. The enterprise refusal comes first: an enterprise caller with a perfectly valid
   * workbench ownership answer must NOT be quietly served under workbench scope, because that is
   * exactly the fallback the parent Spec forbids.
   */
  if (isEnterpriseHint(input.enterpriseHint)) {
    throw new ObservationScopeError("ENTERPRISE_SCOPE_UNSUPPORTED", 403);
  }
  if (!input.actorId || input.actorId === PLACEHOLDER_ACTOR) {
    throw new ObservationScopeError("AUTH_REQUIRED", 401);
  }
  if (!input.botId) {
    throw new ObservationScopeError("BOT_REQUIRED", 400);
  }
  /* A missing ownership answer and a denied one are the same refusal: no scope. */
  if (input.ownership !== "owner" && input.ownership !== "admin") {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
  if (!Number.isInteger(input.epoch) || input.epoch < 0) {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }

  const scope: ObservationScope = Object.freeze({
    kind: "workbench" as const,
    key: scopeKey(input.actorId, input.botId, input.epoch),
    actorId: input.actorId,
    botId: input.botId,
    epoch: input.epoch,
  });
  issued.add(scope);
  return scope;
}

/**
 * Fails closed for anything this process did not issue. A forged scope is an authorization failure,
 * so it answers with the same 403 a denied caller gets — it does not leak "this object was almost
 * right".
 */
export function assertObservationScope(scope: unknown): asserts scope is ObservationScope {
  if (typeof scope !== "object" || scope === null || !issued.has(scope)) {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
}
```

> `require(...)` 在 Bun 的 ESM 测试里可用；若 typecheck 报 `require` 未定义，把 “no unsafe issuance escape hatch” 那条测试改成 `await import("../src/ai-observability/scope")` 的异步形式并取 `Object.keys(module)`。语义不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/tests/opik-scope.test.ts`
Expected: PASS（Task 1 的 2 条 + 本 Task 的全部）

- [ ] **Step 5: 提交**

```bash
git add server/src/ai-observability/scope.ts server/tests/opik-scope.test.ts
git commit -m "feat(opik): one scope issuance point with WeakSet trust and enterprise refusal"
```

---

### Task 3: 三个 seam 适配器 + 游标绑定 + 无租户表纪律守卫

**Files:**
- Modify: `server/src/ai-observability/scope.ts`
- Test: `server/tests/opik-scope.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `resolveObservationScope` / `assertObservationScope`。
- Produces:
  - `export function resolveStorageLocator(scope: ObservationScope): ObservationStorageLocator`
  - `export function resolveEvaluationEligibility(scope: ObservationScope): EvaluationEligibility`
  - `export function bindCursor(scope: ObservationScope, payload: string): string`
  - `export function readCursor(scope: ObservationScope, cursor: string): string`（外部 scope 的游标 → 抛 `OWNERSHIP_REQUIRED`）
  - `export function cacheKey(scope: ObservationScope, name: string, ...parts: Array<string | number>): string`
  - `export function jobKey(scope: ObservationScope, name: string, idempotencyKey: string): string`
  - `export function exportKey(scope: ObservationScope, exportId: string): string`

- [ ] **Step 1: 追加失败测试**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bindCursor,
  cacheKey,
  exportKey,
  jobKey,
  readCursor,
  resolveEvaluationEligibility,
  resolveStorageLocator,
} from "../src/ai-observability/scope";

/** Two trusted scopes with the SAME resource ids — A12 without a single tenant table. */
const scopeAlpha = workbench();
const scopeBeta = workbench({ actorId: actorB, ownership: "admin" });

describe("two trusted scopes over identical resource ids", () => {
  test("the scopes differ while botId is identical", () => {
    expect(scopeAlpha.botId).toBe(scopeBeta.botId);
    expect(scopeAlpha.key).not.toBe(scopeBeta.key);
  });

  test("storage locators are distinct and both namespaced by scopeKey", () => {
    const a = resolveStorageLocator(scopeAlpha);
    const b = resolveStorageLocator(scopeBeta);
    expect(a.scopeKey).toBe(scopeAlpha.key);
    expect(a.project).not.toBe(b.project);
    expect(a.workspace).not.toBe(b.workspace);
  });

  test("a cursor minted under one scope is refused by the other", () => {
    const cursor = bindCursor(scopeAlpha, "page-2");
    expect(readCursor(scopeAlpha, cursor)).toBe("page-2");
    expect(() => readCursor(scopeBeta, cursor)).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
  });

  test("an ownership epoch bump invalidates cursors minted before it", () => {
    const before = workbench({ epoch: 1 });
    const after = workbench({ epoch: 2 });
    const cursor = bindCursor(before, "page-2");
    expect(() => readCursor(after, cursor)).toThrow();
  });

  test("a tampered cursor payload is refused", () => {
    const cursor = bindCursor(scopeAlpha, "page-2");
    const tampered = `${cursor.slice(0, -2)}99`;
    expect(() => readCursor(scopeAlpha, tampered)).toThrow();
  });

  test("cache, job and export keys cannot cross scopes even with identical names", () => {
    expect(cacheKey(scopeAlpha, "runs", "p1")).not.toBe(cacheKey(scopeBeta, "runs", "p1"));
    expect(jobKey(scopeAlpha, "evaluation", "idem-1")).not.toBe(jobKey(scopeBeta, "evaluation", "idem-1"));
    expect(exportKey(scopeAlpha, "exp-1")).not.toBe(exportKey(scopeBeta, "exp-1"));
  });

  test("the same idempotency key under one scope is stable", () => {
    expect(jobKey(scopeAlpha, "evaluation", "idem-1")).toBe(jobKey(scopeAlpha, "evaluation", "idem-1"));
  });

  test("evaluation eligibility is granted for a valid scope and names the scopeKey", () => {
    expect(resolveEvaluationEligibility(scopeAlpha)).toEqual({ allowed: true, scopeKey: scopeAlpha.key });
  });

  test("eligibility for a forged scope is refused, not defaulted to allowed", () => {
    const forged = { ...scopeAlpha };
    expect(() => resolveEvaluationEligibility(forged as unknown as typeof scopeAlpha)).toThrow();
    expect(() => resolveStorageLocator(forged as unknown as typeof scopeAlpha)).toThrow();
  });
});

describe("no premature tenant model", () => {
  const scopeSource = readFileSync(
    join(import.meta.dir, "..", "src", "ai-observability", "scope.ts"),
    "utf8",
  );
  const contractsSource = readFileSync(
    join(import.meta.dir, "..", "src", "ai-observability", "contracts.ts"),
    "utf8",
  );

  test("neither module reaches the database", () => {
    for (const source of [scopeSource, contractsSource]) {
      expect(source).not.toMatch(/from\s+["'][^"']*db\/schema/);
      expect(source).not.toMatch(/from\s+["']drizzle/);
    }
  });

  test("no exported type or function name mentions a tenant", () => {
    const names = [
      ...scopeSource.matchAll(/^export\s+(?:type|function|const|class)\s+(\w+)/gm),
      ...contractsSource.matchAll(/^export\s+(?:type|function|const|class)\s+(\w+)/gm),
    ].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /tenant/i.test(name))).toEqual([]);
  });

  test("there is exactly one scope kind", () => {
    expect(contractsSource).toMatch(/export type ObservationScopeKind = "workbench";/);
    expect(contractsSource).not.toMatch(/ObservationScopeKind\s*=[^;]*\|/);
  });

  test("an upstream workspace name is derived from the scope key, never trusted as authorization", () => {
    const locator = resolveStorageLocator(scopeAlpha);
    expect(locator.workspace).toContain(scopeAlpha.key.length.toString());
    // The locator is an output of authorization, not an input to it: re-deriving a scope from a
    // workspace name is impossible because no such function is exported.
    const names = [
      ...scopeSource.matchAll(/^export\s+function\s+(\w+)/gm),
    ].map((m) => m[1]);
    expect(names.filter((n) => /fromWorkspace|fromProject|fromLocator|scopeFrom/i.test(n))).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test server/tests/opik-scope.test.ts`
Expected: FAIL — `resolveStorageLocator` 等未导出

- [ ] **Step 3: 在 `scope.ts` 追加实现**

```ts
import type {
  EvaluationEligibility,
  ObservationStorageLocator,
} from "./contracts";
import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Cursor integrity key. Process-local and per-boot on purpose: a cursor is a pagination position,
 * not a durable credential, so a restart invalidating outstanding cursors is the safe failure.
 * What must never happen is one scope accepting another scope's cursor.
 */
const CURSOR_KEY = new TextEncoder().encode(
  `opik-cursor/${process.pid}/${Date.now()}`,
);

function mac(scopeKey: string, payload: string): Uint8Array {
  const hmac = createHmac("sha256", CURSOR_KEY);
  hmac.update(scopeKey);
  hmac.update("\u0000");
  hmac.update(payload);
  return new Uint8Array(hmac.digest());
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Bind a pagination payload to the scope that minted it. */
export function bindCursor(scope: ObservationScope, payload: string): string {
  assertObservationScope(scope);
  return `${encode(Buffer.from(payload, "utf8"))}.${encode(mac(scope.key, payload))}`;
}

/**
 * Read a cursor back. A cursor from another scope, another ownership epoch, or a tampered payload
 * is an authorization failure — not an empty page, and not a silent restart from page one.
 */
export function readCursor(scope: ObservationScope, cursor: string): string {
  assertObservationScope(scope);
  const [encodedPayload, encodedMac] = cursor.split(".");
  if (!encodedPayload || !encodedMac) {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
  let payload: string;
  let offered: Uint8Array;
  try {
    payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
    offered = new Uint8Array(Buffer.from(encodedMac, "base64url"));
  } catch {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
  const expected = mac(scope.key, payload);
  if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
  return payload;
}

/** Cache, job and export keys all carry the scope key, so none of them can be reused across scopes. */
export function cacheKey(scope: ObservationScope, name: string, ...parts: Array<string | number>): string {
  assertObservationScope(scope);
  return ["cache", scope.key, name, ...parts.map(String)].join("|");
}

export function jobKey(scope: ObservationScope, name: string, idempotencyKey: string): string {
  assertObservationScope(scope);
  return ["job", scope.key, name, idempotencyKey].join("|");
}

export function exportKey(scope: ObservationScope, exportId: string): string {
  assertObservationScope(scope);
  return ["export", scope.key, exportId].join("|");
}

/**
 * Where this scope's records live upstream.
 *
 * Derived FROM the authorized scope key. Never the other way round: an upstream workspace or
 * project name is a storage address, not a permission, and a layout that happens to look like a
 * tenant boundary proves nothing. No function here reconstructs a scope from a locator.
 */
export function resolveStorageLocator(scope: ObservationScope): ObservationStorageLocator {
  assertObservationScope(scope);
  const fingerprint = String(scope.key.length);
  return Object.freeze({
    scopeKey: scope.key,
    workspace: `openbot-${scope.kind}-${fingerprint}`,
    project: `bot-${scope.botId}-${fingerprint}-${scope.epoch}`,
  });
}

/** Whether this scope may run evaluations. The workbench adapter's answer is the scope itself. */
export function resolveEvaluationEligibility(scope: ObservationScope): EvaluationEligibility {
  assertObservationScope(scope);
  return Object.freeze({ allowed: true as const, scopeKey: scope.key });
}
```

> `resolveStorageLocator` 里的 `workspace` / `project` 命名只是**占位实现**：真正的命名与幂等创建属于 #14（T08）与 #25（T19）。此处必须满足的唯一约束是「由 scope 派生、含 scopeKey、两个 scope 结果不同」，测试即按此断言。若 T08 需要不同布局，改 T08 侧的映射并在本文件留注释，**不要**让本函数去读上游布局。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test server/tests/opik-scope.test.ts`
Expected: PASS（三个 describe 块全绿）

- [ ] **Step 5: 类型检查与格式**

Run: `cd server && bun run typecheck && cd .. && bunx biome lint --error-on-warnings server/src/ai-observability server/tests/opik-scope.test.ts && bunx biome format server/src/ai-observability server/tests/opik-scope.test.ts`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add server/src/ai-observability/scope.ts server/tests/opik-scope.test.ts
git commit -m "feat(opik): scope-bound cursors, cache/job/export keys and the two-scope isolation proof"
```

---

## Self-Review

**Spec coverage（Ticket #12 的 4 条验收标准）**
1. 「授权范围、存储定位与评测资格集中在可替换 seam，当前只实现工作台适配器」→ Task 3 的三个 `resolve*` 函数全部经 `assertObservationScope`，且 `ObservationScopeKind` 只有一个成员（Task 3 的 “exactly one scope kind” 静态测试）。
2. 「两个测试 scope 使用相同资源 ID 时互相隔离，游标、缓存与任务不跨 scope」→ Task 3 的 `two trusted scopes over identical resource ids` describe：botId 相同而 key 不同、locator 不同、跨 scope 游标被拒、epoch bump 使旧游标失效、篡改游标被拒、cache/job/export key 不跨 scope。
3. 「未知企业 scope 被拒绝且不回退到工作台 scope」→ Task 2 的 `enterprise reservation is a refusal, not a fallback` describe，其中一条专门验证「拒绝发生在 ownership 判定之前，因此合法 owner 也不能借到工作台 scope」。
4. 「不创建租户表、不伪造租户、不引入隐式租户头，不把 workspace/project 布局当作授权证明」→ Task 3 的 `no premature tenant model` describe：不 import db/schema 或 drizzle、导出名不含 tenant、只有一个 scope kind、没有任何 `scopeFrom*/fromWorkspace*` 反推函数。

**A5 覆盖**：`AUTH_REQUIRED` 401（含 `dev-local-user` 占位）、`BOT_REQUIRED` 400、`OWNERSHIP_REQUIRED` 403，以及伪造/复制/序列化 scope 一律 403。

**Placeholder scan**：无 TBD / TODO / “类似 Task N”。三处尖括号说明都是**明确的现场决策指令**（`require` 与 `import` 的等价替换、locator 命名的归属边界、epoch 语义），不是待填内容。

**Type consistency**：`ObservationScope` / `ScopeResolutionInput` / `BotOwnership` / `ObservationScopeErrorCode` / `ObservationStorageLocator` / `EvaluationEligibility` 全部在 Task 1 定义，Task 2/3 只消费；`assertObservationScope(scope: unknown): asserts scope is ObservationScope` 的断言签名使 Task 3 各函数无需类型断言即可访问 `scope.key`；`scopeKey(actorId, botId, epoch)` 的三参数签名在 Task 2 定义并在 `resolveObservationScope` 内调用，测试直接以同签名调用；错误 code 与 status 的配对（401/400/403/403）在 Task 1 测试的 `STATUS` 表与 Task 2 实现的抛出点完全一致。

**已知边界（不得当作通过）**：`CURSOR_KEY` 含 `process.pid` 与 `Date.now()`，因此**进程重启会使既有游标失效**。这是有意的安全失败（游标是分页位置而非持久凭据），但 #17（T11）实现分页时必须把「游标失效」表达为可解释错误而不是静默回到第一页——该要求已写入 #17 的验收标准（「移交或撤权后历史详情、分页与缓存立即不可读」）。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-15-opik-t06-trusted-scope-seam.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每个 Task 派发新的 subagent，Task 之间 review。
2. **Inline Execution** — 本会话内按 executing-plans 批量执行并设检查点。

完成后把提交哈希、`scopeKey` 的实际布局与 `ObservationScopeErrorCode` 清单写入 `docs/tickets/opik-4/manifest.json` 的 `T06.handoff.checkpoint`（这是 #13 / T07 的 `consumes`），并在 GitHub #12 勾选验收标准。
