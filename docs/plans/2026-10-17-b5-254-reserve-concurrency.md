# B5-254 (Bifrost 06.3) 原子预留与账户行锁 — Implementation Plan

> **For agentic workers:** Executed inline in this dispatched session (coordinator-supplied method). Steps use checkbox syntax for tracking.

**Goal:** 证明并保持 Reserve 写入路径的账户级原子预留 — 余额 10 时两个上限 8 的并发请求只有一个成功，可用余额为 2；跨 Bot Key 竞争同一账户额度；失败请求零写入并返回当时可用额度；全部由专用 PostgreSQL 测试库的真实并发连接证明。

**Architecture:** #253 已交付 `reserveCreditInTransaction`（五类事务内重验 + 同事务预留），其预留写入经 `createCreditWriter(tx)` 落在 `credits-writer.reserveCredits`，后者在 `billing_customers` 账户行 `FOR UPDATE`（`lockCustomer`）之下完成幂等读、容量读（`liveGrants FOR UPDATE`）与预留写。PayerRef 以 `payerKey` 确定性解析为账户键，跨 Bot 的 Key（grant）共享同一账户键，因此天然竞争同一份额度。本票的缺口是**证明**：以确定性编排（门控事务 + `FOR UPDATE NOWAIT` 探针，不靠 sleep）在真实并发连接上钉死交错顺序，并以变异注入（移除账户锁）证明测试的獠牙。

**Tech Stack:** Bun test + drizzle-orm/bun-sql + PostgreSQL 16（b5-verify-pg 容器 :5590 专用库 `openbot_b5_254`，绝不触碰 5432）。

**Spec:** 票正文（task_8c7ec5319cba）+ docs/specs/2026-10-14-bifrost-integration-design.md（Q5）+ ADR 0002/0003/0004 + CONTEXT.md。

## Global Constraints

- SQL 原子性以专用 PostgreSQL 测试库证明，缺 TEST_DATABASE_URL 不回退、不记通过；skipped 不算通过。
- 不用内存 mock 替代事务；并发用真实并发连接 + 确定性故障注入，不用 sleep 碰运气。
- 不 git commit / push / stash；不修改 Write scope（Reserve 预留写入路径 + 并发集成测试）之外的生产文件；变异注入为临时改动且必须精确还原。
- bun test 文件参数必须 `./` 前缀。
- 预算单位换算：1 credit = 100 scaled units。余额 10 = 1000；上限 8 = 800；预期失败方返回 2 = 200。

## Review Focus

- 失败方返回的"当时可用额度"必须是并发结算后的 2，不是预留前的 10 或 0 —— Test 5 断言 `availableCredits === 2`。
- 跨 Key 竞争若按 Key 各持一份额度，两个请求都会成功（2 行预留、余额超支）—— Test 3/4 以"仅 1 行预留 + 余额 200"捕获。
- 探针查询自身可能坏（语法错误也 reject）—— 每个使用 NOWAIT 探针的测试先在无锁状态下跑一次探针，必须 resolve，证明查询有效后才有资格作为锁证据。
- 清理若按原始前缀 `LIKE '<prefix>%'` 扫派生键列（`openbot-personal-<prefix>…`）将静默零删除（F1）—— 新文件清理一律用派生键前缀，并断言清理后残留为 0。
- 供应商派发次数由"仅一个 `reserved` 结果"在 Reserve 边界证明（本模块不含 provider 调用，不造 provider fake）。

## Files

- Create: `server/tests/reserve-concurrency.integration.test.ts`（并发集成测试，专用池 max 6）
- Modify: `server/tests/reserve-revalidation.integration.test.ts`（仅 afterAll 清理 —— F1 移交项，测试基建非生产代码）
- 无生产代码改动预期（若并发测试暴露真实缺陷，修复限于 Reserve 预留写入路径）

## Interfaces

- Consumes: `reserveCreditInTransaction(tx, request, environment)`（#253 导出，注明供并发注入用）；`createCreditReserveService({database, catalogFreshnessWindowMs})`；`createPayerAccount(db, {kind:"personal", id})`；`createCreditWriter(db).grantCredits/availableBalance/releaseReservation`；`CreditReservationConflictError`；`testDatabaseUrl()/TEST_POOL`。
- Produces: `server/tests/reserve-concurrency.integration.test.ts` — 账户级原子预留的可重跑证明（AC1–AC4）。

## Tasks

### Task 1: F1 清理移交项

- [ ] 在全新库先跑一次 `./tests/reserve-revalidation.integration.test.ts`，查 `credit_*` 残留 > 0，记录 F1 缺陷证据。
- [ ] 将该文件 afterAll 中 `creditReservations`、`credit_charge_remainders`、`credit_ledger`、`credit_grants`、`billing_customers` 五处清理的前缀改为派生键前缀 `openbot-personal-${prefix}%`（payerAccounts.payerId 与 grant/bot/scope/catalog 的原始 id 前缀保持不变）。
- [ ] 重跑该文件，查残留 = 0。

### Task 2: 并发集成测试（先写测试 = RED 载体）

- [ ] 写 `server/tests/reserve-concurrency.integration.test.ts`：
  - 专用池 `{ max: 6 }`（T1 + T2 + NOWAIT 探针 + 主线程断言并发并存）。
  - 精简 accepted-path 世界种子：active bot + grant、personal payer account（派生键 `openbot-personal-<prefix>-user-N`）、grantCredits(余额×100)、catalog ref + 全维度已知价格快照 + open scope + 新鲜 sync state；构造 `CreditReserveRequest`（maximumCredits = 上限×100，唯一 idempotencyKey）。
  - Test A（AC1 自然竞争）：余额 10，两个上限 8 经 `service.reserve` `Promise.all` 真并发 — 恰一个 `reserved`；另一个 `insufficient_credits` 且 `detail.availableCredits === 2`；该账户 `credit_reservations` 恰 1 行；`availableBalance === 200`。
  - Test B（AC1/AC4 确定性编排）：T1 = 显式 `database.transaction` 内 `reserveCreditInTransaction`（上限 8），writer 返回后（账户行锁已持、预留已写未提交）发信号并停在门控；探针（第三连接）`SELECT … FOR UPDATE NOWAIT` 无锁时先 resolve（自证有效），门控期必须 reject（锁被 T1 持有的确定性证据）；随后启动 T2 = `service.reserve`（同账户，上限 8）；释放门控 → T1 提交；断言 T2 refused/available 2、预留恰 1 行且为 T1 的 reservationId、余额 200。
  - Test C（AC2 跨 Key 确定性）：同一 user 两个 bot 两个 grant，一个账户余额 10；T1 用 grant-1 请求（门控 + 探针同 B），T2 用 grant-2 请求走公共 service；断言 T2 refused/available 2、共享账户预留恰 1 行、余额 200 —— 若按 Key 各持一份，T2 必成功，此断言即捕获。
  - Test D（AC2 自然竞争）：同世界双 grant `Promise.all` 两请求 — 恰一个 reserved、恰 1 行、余额 200。
  - Test E（AC3 失败零写入 + 当时额度）：B 的编排下，败方断言：其 idempotencyKey 的预留行 0、该账户 `credit_ledger` 0 行；`detail.availableCredits === 2`（当时 = 赢方预留后）；随后 `releaseReservation` 赢方预留，余额回到 1000 — 证明失败方从未占用。
  - afterAll 按 F1 教训用派生键前缀清理全部 credit 侧表 + payerAccounts(payerId 前缀) + grants/bots/scopes/catalog(原始前缀)，并断言 credit 侧残留 0；关闭池。
- [ ] 对照当前（已集成 #253 的）基线运行：预期全绿（原子性已存在，测试是回归证明）。

### Task 3: 变异 RED（确定性故障注入，证明测试獠牙）

- [ ] 临时变异 `server/src/billing/credits-writer.ts` 的 `reserveCredits`：`lockCustomer` 改为 no-op 且 `liveGrants(..., lock=false)`（即移除账户级串行化；Write scope 内，事后精确还原）。
- [ ] 跑新测试文件：Test A–E 中并发断言必须 FAIL（两行预留/两方成功/错误余额），输出存 `.omc/reports/b5-254-red.log`。
- [ ] 精确还原变异（`git diff` 确认该文件仅剩预期改动或零改动）。

### Task 4: GREEN + 全量验证

- [ ] 还原后重跑新文件：全绿。
- [ ] `./tests/reserve-revalidation.integration.test.ts`（含 F1 修复）全绿 + 残留 0。
- [ ] `cd server && bun run typecheck` 通过。
- [ ] `bunx biome lint --error-on-warnings src/billing/credits-writer.ts tests/reserve-concurrency.integration.test.ts tests/reserve-revalidation.integration.test.ts` 通过。

### Task 5: 报告

- [ ] `.omc/reports/b5-254.md`：变更清单、逐条 AC 证据、命令输出摘要、F1 前后对比、变异 RED 说明、遗留/风险；git status 保持未提交。
- [ ] `worker_done`（附 taskId + dispatchId）。
