# B5-237 (Bifrost 04.4) 绑定凭据失效、防重放与防枚举 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已使用、过期、伪造或跨 Bot 使用的绑定码一律以同一类拒绝失败，并发消费同一码只有一次成功，连续失败的来源被限速锁定；消费语义可被 04.5 在同一事务内组合。

**Architecture:** 在 #236 交付的 `bot_services/binding-codes.ts`（签发模块）内补上**消费半边**：`createBindingOfferConsumer`。消费是一条条件 UPDATE（`status='pending' AND expires_at > clock_timestamp() AND bot_id=<pin?>` → `status='redeemed'`），UPDATE 本身即双花防线（PostgreSQL 行锁 + EvalPlanQual 使第二个事务匹配 0 行）；可选注入调用方事务，让 04.5 的「消费 + 建 AccessGrant」原子提交。四类失败（伪造/过期/已用/跨 Bot）抛同一个 `BindingCodeRejectedError`（同一 message、无附加字段）；失败计数复用 `auth.ts` 已导出的 `createFailureLimiter`，超阈值对**来源**（presentation.source）抛 `BindingCodeRateLimitedError`——锁定的是来源不是码，猜测一个码不能封别人。不改 schema（`status` 的 `'redeemed'` 值已在 0126 CHECK 内）、无迁移、不建路由（04.5 拥有确认页与路由，按其 Resume hint 消费与建授权分两步）。

**Tech Stack:** TypeScript / Bun test / Drizzle ORM / PostgreSQL（专用验证实例 5590 上的 openbot_b5_237 库）

**Spec:** docs/specs/2026-10-14-bifrost-github-spec.md（AC03）、docs/specs/2026-10-14-bifrost-integration-design.md（Q3/Q15/Q22）、ADR 0002、CONTEXT.md（Bot User Binding / Registered Bot）

## Global Constraints

- SQL 原子性必须用真实 PostgreSQL 验证；缺 TEST_DATABASE_URL 不回退、skipped 不算通过。
- 拒绝语义统一：不得以类、消息、字段或时序区分四类失败；错误对象不携带 botId/hint/codeHash。
- 消费只证明**码**有效，不证明 Bot 当前启用状态（下游 04.5/05.3 在建授权/发 Key 时重验）。
- 硬性禁止：git commit/push/stash；不改 Write scope 之外文件（binding-codes.ts + 新测试文件）；不触碰其他 worktree、5590 实例之外的库。
- 同一 (bot,hint) 多条 pending（review-236 下游提醒）：消费按码（code_hash 主键）逐条独立，消费一条不失效兄弟条目。

## Review Focus

- 并发双花：`Promise.allSettled` 两路消费同一码，恰好一 fulfilled 一 rejected；败者必须是统一的 `BindingCodeRejectedError`；行最终 `status='redeemed'`。
- 四类拒绝字节级一致（同 class、同 message、`Object.keys` 无附加字段）。
- 锁定来源而非码：被封来源呈交**有效**码仍被拒；换来源立刻可行；窗口滑过后解除。
- 调用方事务组合：外部 `database.transaction` 内消费成功后由调用方回滚 → 行仍 `pending`（可再次消费）。

---

### Task 1: RED — 失败测试先行

**Files:**
- Create: `server/tests/binding-code-hardening.integration.test.ts`

**Test contents (public-boundary, real PG):**
1. 并发双花：两路同码并发 → 恰一次成功；败者 `BindingCodeRejectedError`；DB 终态 `redeemed`；第三次顺序消费再拒。
2. 四类拒绝：伪造（从未签发的合法形状随机码）/ 过期（直接插入 `expires_at` 已过的行，走公开 UPDATE 路径）/ 已用（先成功消费再重放）/ 跨 Bot（A 的码钉 B 的 botId 消费）→ 全部 `BindingCodeRejectedError`，`error.message` 全等、`Object.keys(error)` 无附加字段、序列化一致。
3. 跨 Bot 拒绝后同码钉回 A 的 botId 仍可成功（拒绝不烧码：非 pending 才终态）。
4. 枚举限速：注入 `createFailureLimiter({ maxFailures: 3, windowMs, now })`，3 次伪造失败后第 4 次（即使呈交有效码）→ `BindingCodeRateLimitedError`；换 source 不受影响；推进注入时钟过窗口 → 解锁。
5. 多条 pending 同 (bot,hint)：消费其中一码成功，兄弟码仍 pending 且可消费。
6. 调用方事务：`database.transaction` 内 consume 成功但抛错回滚 → 行仍 pending；重跑成功。
7. 成功消费返回 `{ botId, externalIdentityHint, singleUse: true, status: "redeemed" }`，不含明文码/哈希。

**Step:** 运行 `TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5590/openbot_b5_237 CREDIT_SCALE=100 bun test server/tests/binding-code-hardening.integration.test.ts` → 因导出不存在而失败（RED 证据）。

### Task 2: GREEN — 消费最小实现

**Files:**
- Modify: `server/src/bot-services/binding-codes.ts`

**Interfaces（Produces 契约）:**
- `class BindingCodeRejectedError extends Error` — message `"The binding code was not accepted."`，无附加字段。
- `class BindingCodeRateLimitedError extends Error` — message `"Too many failed binding-code attempts; retry later."`。
- `type ConsumedBindingOffer = { botId: string; externalIdentityHint: string; singleUse: true; status: "redeemed" }`。
- `type BindingOfferConsumer = { consume(code: string, presentation: { source: string; botId?: string }, within?: BindingOfferTransaction): Promise<ConsumedBindingOffer> }`。
- `createBindingOfferConsumer(dependencies: { database: Database; limiter?: FailureLimiter })`。

**Step:** 条件 UPDATE + `.returning()`，0 行 → `limiter.record(source)` + 统一拒绝；复用 `bindingCodeHash` 输入校验（非串/空 → `BotServiceInputError`）；`source` 必须非空串。文档注释写明：不审计消费（04.5 建授权时审计并引用 codeHash）、不检查 Bot 启用状态、码按 code_hash 独立消费。

### Task 3: REFACTOR + 验证

- 跑本票测试 + `server/tests/binding-code-issuance.test.ts`（回归 04.3）全绿。
- `bun run --filter server typecheck`（等价 `bun x tsc --noEmit`）0 错。
- `bunx biome lint --error-on-warnings` 改动文件 0 警告。
- 报告 `<worktree根>/.omc/reports/b5-237.md`，git status 保持未提交。
