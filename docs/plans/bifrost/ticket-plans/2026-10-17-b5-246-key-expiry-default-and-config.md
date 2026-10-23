# Bifrost 05.5 — 默认 15 分钟期限与部署可配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per ticket #246 discipline: **no git commit/push/stash** — progress is tracked by uncommitted checkpoint + `.omc/reports/b5-246.md`.

**Goal:** 每把短期虚拟 Key 签发即带期限（默认 15 分钟，部署环境变量可调，非法配置拒绝并给出原因）；到期后该 Key 不能发起新请求；到期不删除 Key 记录、不取消已发生消费的结算责任。

**Architecture:** OpenBot 侧是本票的全部新代码——Bifrost 上游（`bifrost/plugins/governance`）已实现 `TableVirtualKey.ExpiresAt` + 请求鉴权时的 `IsExpiredAt` 拒绝 + create API 的 `expires_at` 字段（RFC3339、必须未来）。本票补齐 OpenBot 侧：新模块 `server/src/gateway/key-expiry.ts` 承载期限配置（环境变量 `BIFROST_VIRTUAL_KEY_TTL_MINUTES`、默认 15、合法域校验）与到期判定 verdict seam；`key-issuance.ts` 在签发时计算 `expiresAt`，随远程 create 送达（附 `delete_after_expire: false`，防止 Bifrost 清理作业删除远端记录），并落入本地 `gateway_virtual_keys.expires_at`（0143 迁移已存在，无需新迁移）——CredentialBundle 与状态视图经现有字段自动获得一致可见性。

**Tech Stack:** TypeScript / Bun test / Drizzle（PostgreSQL 专用测试库）/ Hono。

**Spec:** docs/plans/tickets/bifrost-5/issues/05.5-key-expiry-default-and-config.md；docs/specs/2026-10-14-bifrost-integration-design.md（Q13 默认 15 分钟、Q18 OpenBot 掌管生命周期）；docs/adr/0002-per-user-bot-model-access.md。

## Global Constraints

- 默认期限 **15 分钟**；合法域：**整数且 ≥1 且 ≤1440**（24 小时上限，"短期 Key"的部署侧天花板）；0、负数、非整数、超上限、非数字一律拒绝并给出含变量名的理由。
- 到期判定边界：`now >= expiresAt` 即过期（`now == expiresAt` 算过期，与 Bifrost `IsExpiredAt` 一致）。
- 到期**绝不删除** Key 记录、绝不变更/释放任何 `credit_reservations` 行；verdict 是纯读函数。
- 可控时钟经 `createGatewayKeyIssuer` 新增 `now` 注入缝进入，测试不得 sleep 等真实时间。
- 测试库：`TEST_DATABASE_URL=postgresql://openbot:openbot@127.0.0.1:5594/openbot_b5_246`（命令行显式传入，禁止落回根 .env 的 5435）；缺库不记通过。
- 禁止 git commit/push/stash；Write scope = key-expiry.ts（新）、key-issuance.ts、两个既有测试的机械 dep 适配、key-expiry.test.ts（新）。
- 远程 create 携带 `delete_after_expire: false`（Bifrost 要求 `delete_after_expire` 必须伴随 `expires_at`）。

## Review Focus

- **时钟边界 ==**：`now` 恰好等于 `expiresAt` 必须判过期（不是可用）→ Task 2 测试 `at the exact expiry instant the key is refused`。
- **配置合法域两端**：1440 可用、1441 拒绝、15 为缺省 → Task 1 测试两端点 + 默认。
- **过期≠删除**：快进后 `gateway_virtual_keys` 行数不变、列值不变 → Task 4 集成断言。
- **过期≠释放**：既有 `reserved` 预留行逐列不变（结算责任存续，06.8/08.x 语义）→ Task 4 集成断言。
- **record/bundle/远端一致**：本地记录、CredentialBundle、远端 create body 三处 `expiresAt` 为同一时刻 → Task 3 断言。

---

### Task 1: 期限配置模块——默认、校验、解析（key-expiry.ts 上半）

**Files:**
- Create: `server/src/gateway/key-expiry.ts`
- Test: `server/tests/key-expiry.test.ts`

**Interfaces:**
- Consumes: 无（叶子模块）。
- Produces:
  - `DEFAULT_VIRTUAL_KEY_TTL_MINUTES = 15`
  - `MAX_VIRTUAL_KEY_TTL_MINUTES = 1440`
  - `VIRTUAL_KEY_TTL_MINUTES_VARIABLE = "BIFROST_VIRTUAL_KEY_TTL_MINUTES"`
  - `virtualKeyTtlMinutesProblem(name: string, value: unknown): string | undefined`（非法→理由句，合法→undefined）
  - `resolveVirtualKeyTtlMinutes(environment: Record<string, string | undefined>): number`（未设→15；非法→throw，消息含变量名与理由）

- [ ] **Step 1: 写失败测试**（`server/tests/key-expiry.test.ts`，先只含本任务 describe）

```ts
describe("05.5 virtual key TTL configuration", () => {
  test("unset environment resolves to the 15-minute default");
  test("a configured value inside the legal range resolves as-is (1 and 1440 are both legal)");
  test("zero, negative, fractional, non-numeric and over-ceiling values are refused with a reason naming the variable");
});
```

断言要点：默认 15；`"1"`→1、`"1440"`→1440；`"0"`/`"-5"`/`"0.5"`/`"abc"`/`""`/`"1441"` 每个 `resolveVirtualKeyTtlMinutes` 都 throw 且消息含 `BIFROST_VIRTUAL_KEY_TTL_MINUTES`；`virtualKeyTtlMinutesProblem` 对合法值返回 undefined。

- [ ] **Step 2: 跑测试确认 RED**：`cd server && TEST_DATABASE_URL=postgresql://openbot:openbot@127.0.0.1:5594/openbot_b5_246 bun test ./tests/key-expiry.test.ts` → FAIL（模块不存在）。
- [ ] **Step 3: 实现** `virtualKeyTtlMinutesProblem` / `resolveVirtualKeyTtlMinutes` 及三个常量（校验顺序：非有限数/非整数 → 0 或负 → 超 1440；理由句风格对齐 `gatewayRequestTimeoutProblem`）。
- [ ] **Step 4: 跑测试确认 GREEN**（同 Step 2 命令）。

### Task 2: 到期判定 verdict seam（key-expiry.ts 下半）

**Files:**
- Modify: `server/src/gateway/key-expiry.ts`
- Test: `server/tests/key-expiry.test.ts`

**Interfaces:**
- Produces:
  - `GatewayKeyExpiryVerdict = { usable: true } | { usable: false; reason: "gateway_key_expired"; expiredAt: string }`
  - `gatewayKeyUsableForNewRequest(row: { status: string; expiresAt: Date | string | null }, now: Date): GatewayKeyExpiryVerdict`（纯读；`status === "expired"` 或 `now >= expiresAt` → 拒绝；注释声明：撤销判定属 05.7，预留/结算一概不触碰）

- [ ] **Step 1: 追加失败测试**

```ts
describe("05.5 expiry verdict", () => {
  test("a key whose term has not started to run out is usable");
  test("a null expiresAt (pre-05.5 record) is usable");           // 兼容既有 null 行
  test("at the exact expiry instant the key is refused");          // now == expiresAt → 过期
  test("after expiry the verdict names the reason and the expired-at instant");
  test("a row the state sync already marked expired is refused without consulting the clock");
  test("a Date and an ISO-string expiresAt decide identically");
});
```

- [ ] **Step 2: RED**（同前命令）。
- [ ] **Step 3: 实现** verdict（比较统一转 UTC 毫秒；`expiredAt` 输出 ISO 字符串）。
- [ ] **Step 4: GREEN**。

### Task 3: 签发线程——TTL 进入远程 create、本地记录、bundle/审计

**Files:**
- Modify: `server/src/gateway/key-issuance.ts`（`GatewayKeyIssuerDeps`、`GatewayVirtualKeyClient`、`issueForGrant`、`createDeploymentKeyIssuer`）
- Modify: `server/tests/key-issuance.integration.test.ts`、`server/tests/credential-bundle-boundary.test.ts`（仅给 `createGatewayKeyIssuer` fixture 加 `keyTtlMinutes: 15` 的机械适配）
- Test: `server/tests/key-expiry.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveVirtualKeyTtlMinutes`；Bifrost create API 已接受的 `expires_at`（RFC3339，必须未来）与 `delete_after_expire`。
- Produces:
  - `GatewayKeyIssuerDeps` 新增 `keyTtlMinutes: number`（必填——组合处显式声明策略）与 `now?: () => Date`（缺省墙钟）。
  - `GatewayVirtualKeyClient.createVirtualKey` 入参新增 `expiresAt: string`；生产 adapter 请求体变为 `{ name, customer_id, allow_all_providers: true, expires_at, delete_after_expire: false }`。
  - 签发记录/审计/`IssuedGatewayKey`/bundle 的 `expiresAt` 从此为非空 ISO 时刻（记录 `expires_at = now() + ttl`）。
  - `createDeploymentKeyIssuer` 以 `resolveVirtualKeyTtlMinutes(process.env)` 供值（组合期非法配置即 throw——部署拒绝启动并给出原因）。

- [ ] **Step 1: 追加失败测试**（key-expiry.test.ts；该文件自带 fake Bifrost：仿 key-issuance.integration.test.ts 的 `startFakeBifrost`，vk create 记录完整 body 含 `expires_at`/`delete_after_expire`）

```ts
describe("05.5 issuance applies the term", () => {
  test("the minted key's expiresAt lands in the local record, the answer and the bundle identically");
  test("the remote create carries expires_at and delete_after_expire=false");
  test("the audit payload names the same expiresAt and never the secret");
});
```

断言要点：时钟固定 T0、ttl=15 → 记录/answer/bundle 三处均为 `T0+15min` 的同一 ISO 串；fake 收到 `expires_at === 同串`、`delete_after_expire === false`。

- [ ] **Step 2: RED**（此时编译失败——deps 缺 `keyTtlMinutes`，同证机械适配必要）。
- [ ] **Step 3: 实现**（key-issuance.ts 按上述 Interfaces；两个既有测试文件 fixture 加 `keyTtlMinutes: 15`）。
- [ ] **Step 4: GREEN** + 全量既有两个签发测试文件回归：
  `TEST_DATABASE_URL=… bun test ./tests/key-issuance.integration.test.ts ./tests/credential-bundle-boundary.test.ts ./tests/key-expiry.test.ts`

### Task 4: 时钟快进集成——到期拒绝新请求、记录与待结算存续

**Files:**
- Test: `server/tests/key-expiry.test.ts`（真库 + fake Bifrost + 可控时钟）

**Interfaces:**
- Consumes: Task 2 verdict、Task 3 签发；`gatewayVirtualKeys`/`billingCustomers`/`creditReservations`（drizzle 直插 fixture，同 model-scope.integration.test.ts 模式）。

- [ ] **Step 1: 追加失败测试**

```ts
describe("05.5 after the clock passes the term", () => {
  test("a key fast-forwarded past its term is refused for new requests");
  test("expiry deletes nothing: the key record survives intact and stays queryable via the status view");
  test("expiry releases nothing: a pre-existing reserved settlement row is column-for-column unchanged");
});
```

断言要点：签发（T0，ttl=15）→ 快进 `T0+16min` → `gatewayKeyUsableForNewRequest` 拒绝且 `expiredAt` 为记录值；行数不变、逐列 equal（含 valueHash/grantId/status）；`gatewayKeyStatusView(row)` 仍返回该 key；快进前直插的 `reserved` 预留行逐列不变；另外在 T0+14min（期限内）同断言 usable=true 作对照。

- [ ] **Step 2: RED**（Task 2/3 已实现则此测试应直接 GREEN——它整合既有缝；若 RED 说明缝接错，修复后 GREEN）。
- [ ] **Step 3: GREEN 并整文件回归。**

### Task 5: 全量验证与报告

- [ ] `cd server && TEST_DATABASE_URL=…openbot_b5_246 bun test ./tests/key-expiry.test.ts ./tests/key-issuance.integration.test.ts ./tests/credential-bundle-boundary.test.ts` 全绿（无 skipped）。
- [ ] `cd server && bun run --filter server typecheck`（或仓库 Verification 原文 `bun run --filter server typecheck`）0 错误。
- [ ] `bunx biome lint --error-on-warnings server/src/gateway/key-expiry.ts server/src/gateway/key-issuance.ts server/tests/key-expiry.test.ts`（+ 两个适配的既有测试文件）0 警告。
- [ ] Go 侧无改动核验：`git status` 不含 bifrost/ 文件；记录 `bifrost/plugins/governance` 未受影响的说明（上游 `IsExpiredAt` 鉴权拒绝已存在并由其自有测试覆盖）。
- [ ] 写 `.omc/reports/b5-246.md`（变更清单、逐条 AC 证据、命令输出摘要、检查点 sha256 清单、遗留/风险）；git status 保持未提交。
- [ ] `orca orchestration send worker_done`（三句摘要 + outcome + files + report path）。

## Self-Review

- **Spec 覆盖**：AC1 默认 15 + 可配置 → Task 1/3；AC2 非法拒绝带原因 → Task 1（组合期 throw）+ Task 3（deployment 组合）；AC3 快进后拒绝新请求 → Task 2/4；AC4 到期不取消结算责任 → Task 4；Produces 契约「expiresAt 在 bundle 与状态查询一致可见」→ Task 3/4。无缺口。
- **步骤单义**：每步一个可检结果；无 TBD。
- **类型一致**：`keyTtlMinutes`/`now`/`expiresAt`/verdict 命名在 Task 2/3/4 间一致。
- **Review Focus**：五项均有归属测试（Task 1×2、Task 2×1、Task 4×2、Task 3×1）。
- **比例**：计划 < 实现代码体量；无转录式代码块。
