# B5-219 (Bifrost 02.5) 余额不足不切换账户 — Implementation Plan

> **For agentic workers:** inline execution (dispatched Pi worker, Orca `task_3c587507bfa1` / `ctx_7a150654af7a`)。TDD：RED→GREEN→REFACTOR。硬性禁止 git commit/push/stash；检查点=未提交状态。

**Goal:** 同一请求贯穿准入、用量、结算与尾差固定一个 PayerBinding；余额不足唯一语义=拒绝并说明账户类型与可用额度，不重新解析、不切换账户；恢复路径从持久化映射完整还原，不猜归属。

**Architecture:** 新增 `payer-binding.ts`（付款账户绑定模块：bind/assertSame/restore + 请求级 AsyncLocalStorage + 消费入口解析策略 + 可展示拒绝错误）。`index.ts` 消费入口（model usage gate）从隐式 `billing.externalCustomerKey` 默认改为显式 PayerBinding（请求绑定优先；无绑定时用 boot 时显式创建的部署绑定——09.2 的移除点，清单测试钉死不增长）。结算与尾差由 reservation 行自带 externalCustomerId 决定（writer 已有性质，测试钉死）；跨进程恢复 = `readPayerAccountForKey` + `restorePayerBinding`，未映射键拒绝而非猜测。

**Tech Stack:** TypeScript / Bun test / Drizzle / PostgreSQL（专用库 openbot_b5_219）

**Spec:** 父 Spec #5 AC13（subscription harnesses cannot become a balance-exhaustion fallback）、ADR 0004（余额不足不切换）、CONTEXT.md（Payer/Reservation/尾差术语）

## Rulings（执行中裁决）

- R1: 无 ALS 请求绑定时，消费入口使用 boot 时**显式**创建的部署 `legacy_deployment` 绑定（不是隐式键默认值；是 09.2 的文档化移除点）。理由：本票不得顺带实施 09.2 的面级解析，也不得让现有消费全灭。成本：09.2 若不删该分支，清单测试会钉住它。
- R2: 不给 usage_outbox 加 payer 列——消费记录已携带 external_customer_id，`payer_accounts` 映射行是 kind+id 的权威（boot 时经 createPayerAccount 确保存在），恢复=映射反查+未映射即拒绝。避免二次冗余与迁移号协调。
- R3: `CreditInsufficientError`（code `credits_exhausted`）落位 payer-binding.ts（billing 侧契约），copilot.ts 仅在 gate catch 的已识别名单中加入它——错误语义归 billing，渲染入口归 runtime。

## Interfaces

**Consumes（#215/#217/#218 已交付）**: `PayerRef`、`payerKey`、`createPayerAccount`、`readPayerAccountForKey`（payer.ts）；`CreditWriter.reserveCredits`（拒绝分支 `{reserved:false, availableCents}`）。

**Produces**: `PayerBinding`/`bindPayer`/`assertSamePayer`/`restorePayerBinding`/`withPayerBinding`/`currentPayerBinding`/`resolveConsumptionPayerBinding`/`ensureDeploymentPayerBinding`/`CreditInsufficientError`（09.2、04.5、05.3、组 08 恢复消费）。

## Tasks

### Task 1: 绑定模块纯函数 + 请求上下文（RED→GREEN，单元）
- Create `server/src/billing/payer-binding.ts`; Test `server/tests/payer-no-fallback.test.ts`（单元部分）。
- `bindPayer(ref)`（payerKey 一次、unknown_owner/坏 id 拒绝）、`assertSamePayer`（不一致→`PayerBindingConflictError`，消息不含对方 id）、`restorePayerBinding(account)`（unknown_owner 拒绝）、ALS `withPayerBinding/currentPayerBinding`、`resolveConsumptionPayerBinding`（请求绑定在场→原样返回=不解析部署；缺席→部署绑定）。

### Task 2: 余额不足注入 + 结算/尾差同账户 + 恢复（RED→GREEN，真库）
- 集成：A 账户授予少额→reserve 拒绝→`{reserved:false, availableCents}`，无任何 key 产生 reservation/ledger 行；`CreditInsufficientError` 消息含己方类型+可用额、不含他人 id/key/余额。
- 全路径：绑定 A→reserve→settle（经 createCreditUsageTarget）→ ledger 行+尾差行都在 A 键；B 账户全程未被触碰。
- `ensureDeploymentPayerBinding`：幂等创建 legacy_deployment 映射；键被 unknown_owner 占用时响亮冲突。
- 恢复：`restorePayerBinding(readPayerAccountForKey(key))` 还原 {kind,id}；未映射键→null→拒绝。

### Task 3: 消费入口接线 + 拒绝识别（RED→GREEN，静态+接线）
- `index.ts` gate：`resolveConsumptionPayerBinding` → reserve/outbox/recordUnsettled/fail 全用 `binding.externalCustomerId`；拒绝分支抛 `CreditInsufficientError`。boot：billing 装配处 `ensureDeploymentPayerBinding`。
- `copilot.ts` gate catch 识别名单加入 `CreditInsufficientError`。
- 静态清单测试：`deploymentExternalCustomerId` 在 `server/src`（非测试）出现文件集合 === 白名单 {service.ts 定义, payer.ts legacy 分支, payer-legacy.ts 归因, index.ts boot+入口}。

## Verification

```bash
cd server && TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_b5_219 bun test tests/payer-no-fallback.test.ts
rg -n 'deploymentExternalCustomerId' server/src | grep -v test
bun run typecheck
bunx biome lint --error-on-warnings src/billing/payer-binding.ts src/index.ts src/copilot.ts tests/payer-no-fallback.test.ts
```
