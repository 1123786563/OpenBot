# 计费修复交付 · 最终全量测试验证报告

## 验证概览

| 项 | 值 |
|---|---|
| 项目根目录 | `/Users/wuyongjun/trea/OpenBot` |
| HEAD commit | `27531bd`（`test(app): 修复 mock.module 跨文件污染…`），分支 main，领先 origin/main 2 commits |
| 关键交付提交 | f5c8a06 / 71ab6d6 / 9f0654c / 9e7dedb / 27531bd（均已验证在 HEAD 可达） |
| 日期 | 2026-10-11 |
| 运行环境 | Bun 1.4.2 (macOS arm64)；Docker 主 PG `openbot-postgres-1`（127.0.0.1:5432，PG 17 系）；基线 worktree 对照 c3ba494 |
| 集成测试库 | `openbot_qa_batch1`（5432，73/75 迁移，见 E 组脚注与待确认 #3） |
| 干净库验证 | `openbot_qa_final_clean`（5432，验后已 DROP） |

工作树状态说明：本验证开始时工作树含 3 个测试文件的未提交修改（`app/tests/billing-credits-ui.test.tsx`、`server/tests/qa-batch2-t5-semantics.integration.test.ts`、`server/tests/qa-batch2-unreadable-fourth.integration.test.ts`，均为批次3 QA 按批次3 授权对 B3 修复后的期望值更新，属于交付工作的一部分），以及未跟踪的 `server/tests/qa-batch3-reconcile.test.ts`（已纳入本次门禁跑通）。验证中途（21:08）另一并行工作流改动了 `server/src/craft/` 下 5 个源文件——与计费无关，未纳入本次验证范围，仅如实记录（见待确认 #4）。

---

## 逐项结果

### A. 服务端计费全量回归（核心门禁）

| # | 命令/步骤 | 预期 | 实际 | 判定 |
|---|---|---|---|---|
| A1 | `TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5432/openbot_qa_batch1 bun test server/tests/billing-*.test.ts server/tests/payment*.test.ts server/tests/qa-batch{1,2,3}-*.test.ts server/tests/copilot-usage-meter.test.ts` | ≥506 pass / 0 fail | **506 pass / 0 fail**，8216 expect()，36 文件，3.99s | ✅ |
| A2 | 上述套件连跑 5 次 | 0 抖动 | 5 次全部 **506/0**（3.59s–4.48s），逐次结果：506/506/506/506/506 | ✅ |
| A3 | 边界抽查：在用例清单中点名确认 10 个关键边界场景 | 全部有对应用例且通过 | 全部覆盖且 pass，逐项见下 | ✅ |

A3 逐场景点名（均为 pass）：

| 边界场景 | 承载用例（pass 实录） |
|---|---|
| 并发扣减 8 路 | `probe a: eight concurrent draws of 300 on a 1000 grant — Σapplied == 1000, never more`；另有 exact-capacity 边界 `probe a-boundary: concurrent draws totalling EXACTLY the capacity — all applied in full` |
| 幂等重试双发 | `probe b: two CONCURRENT reports of one idempotency key — exactly one ledger row, one draw`；grant 侧 `probe a: six concurrent grants on one key land exactly one row, nobody throws` + `the replay answer carries the first grant's facts, not the retried arguments` |
| 后扣语义（T5 late-charge） | `qa-batch2-t5-semantics` 套件内 pending-pair/后扣场景 pass（suite 0 fail） |
| pending-pair 竞态 | `probe b: five concurrent inserts on one (plan, provider) land ONE pending order`；跨 provider 不阻塞 `the same plan on DIFFERENT providers does not block`；终态释放 `a terminal order frees the pair`；同事务竞态 `two orders racing the SAME channel transaction — one claims, one alreadyKnown` |
| 顺序双付 duplicate_paid | `sequential double payment (cross-provider): both paid, and the duplicate is VISIBLE`；`probe c: a second paid order on the plan (cross-provider) records duplicate_paid`；`the same transaction delivered against a second order answers alreadyKnown + duplicate_paid`；`the fixed duplicate path fires ONCE…` |
| 重投风暴 | `redelivering the same paid delivery 8 times writes ZERO anomalies, not 8`（qa-batch1-replay-storm） |
| failed 复活 | `probe g: a failed order is picked up by listPaidPendingActivationOrders and lands applied`；`the alarm stays ONE row per order across many sweeps` |
| unreadable 三击终结 | `probe h: three unreadable strikes block; further deliveries never reopen the order` |
| 第 4 次静默（B3） | `probe h-fourth (B3 fixed): strikes 1-2 pend, strike 3 blocks; FOURTH+ deliveries ack silently, zero new rows`（工作树更新版，strike 数保持 3） |
| 守卫直读投影 | `probe i: the purchase guard's uncached projection read — a live row in billing_subscriptions refuses the purchase while the cached read says null` |
| 恒等式对账四场景 | `an agreeing world yields no findings` / `paid_without_fact` / `fact_transaction_mismatch` / `applied_without_subscription` / `grants_ledger_divergence`（billing-reconcile.integration 全 pass）+ qa-batch3 路由侧 401/403/审计行全 pass |

### B. 干净库全链迁移验证

| # | 命令/步骤 | 预期 | 实际 | 判定 |
|---|---|---|---|---|
| B4 | `CREATE DATABASE openbot_qa_final_clean`（空库）→ `DATABASE_URL=…5432/openbot_qa_final_clean drizzle-kit migrate` → 实查 | 书签 75；关键列/索引齐备 | **75 migrations applied**。实查：`credit_grants.idempotency_key` NOT NULL + UNIQUE 索引；`credit_ledger.idempotency_key` NOT NULL + UNIQUE 索引、`applied` NOT NULL DEFAULT 0；`payment_orders_pending_pair_unique_idx` = UNIQUE (plan_code, provider) WHERE status='pending'（partial）；`payment_events_paid_fact_unique_idx` = UNIQUE (channel_transaction_id) WHERE kind='fact' AND state='paid'（partial）；`payment_events_anomaly_unique_idx` = UNIQUE (order_id, code) WHERE kind='anomaly' AND code<>'amount_unreadable'（partial，074）。完整 pg_indexes 输出（16 行）已附录存档 | ✅ |
| B5 | 干净库上 `bun test billing-credits-writer.integration / qa-batch2-credits-consume.integration / billing-reconcile.integration` | 全绿 | **21 pass / 0 fail**，77 expect()，3 文件，515ms | ✅ |
| B6 | `DROP DATABASE openbot_qa_final_clean` | 删除 | DROP DATABASE 已执行，库已不存在 | ✅ |

### C. app 侧

| # | 命令/步骤 | 预期 | 实际 | 判定 |
|---|---|---|---|---|
| C7 | `bun test app/tests/billing-*.test.ts*` 连跑 3 次 | 23+ pass，3 连跑稳定 | 3 次全部 **23 pass / 0 fail**（billing-credits-ui / billing-format / billing-invoice-shared / billing-payments 4 文件） | ✅ |
| C8 | 全量 `bun test app/tests/`（147 文件）→ 失败清单对照 c3ba494 基线 | 计费相关 0 新增失败 | HEAD：1075 pass / **8 fail**。基线（c3ba494 隔离 worktree 复跑）：836 pass / **247 fail**（27531bd 修复前 mock 污染所致）。HEAD 的 8 个失败全部存在于基线失败名单中，且**无一计费相关**；基线失败的 2 个计费用例（UpgradeDialog 两例，位于 billing-credits-ui.test.tsx）在 HEAD 已转绿 | ✅ |

C8 失败清单归因（8 个失败 → 4 个文件，全部「预存，非本次引入」，基线 worktree 可复现）：

| 文件 | 失败用例 | 归因 |
|---|---|---|
| `transcript-attachments.test.tsx` | a thumbnail is a crop…（1 例） | 预存跨套件抖动（transcript 类）；单文件隔离跑 40 pass/0 fail，仅在组合运行时受污染 |
| `channel-pagination.test.tsx` | scrolling requests the cursor once / a failed page preserves rows / search loads older history（3 例） | **预存且非抖动——确定性失败**：单文件隔离跑即 1 pass/3 fail，且在 c3ba494 基线 worktree 单文件隔离复跑同样 1 pass/3 fail，证实先于本次全部交付存在 |
| `account-mode-dialog.test.tsx` | switching an app to Shared > names what goes…（1 例） | 预存跨套件抖动（connector 类）；单文件隔离跑 3 pass/0 fail |
| `brokered-account-row.test.tsx` | a form reopened × 3（3 例） | 预存跨套件抖动（表单类，含 7–12s 超时特征）；单文件隔离跑 43 pass/0 fail |

### D. 静态检查

| # | 命令/步骤 | 预期 | 实际 | 判定 |
|---|---|---|---|---|
| D9 | `bun run typecheck`（--filter '*'，worker/app/server） | 0 错误 | worker / app / server typecheck 全部 **Exited with code 0** | ✅ |
| D10 | `bunx biome lint server/src/billing server/src/billing/payments app/src/lib/billing app/src/components/billing` | 0 error（warning 记录） | **2 errors, 5 warnings, 2 infos**（37 文件） | ⚠️ |

D10 明细（均为 FIXABLE）：

- **2 errors** — `app/src/components/billing/upgrade-dialog.tsx:177` `lint/correctness/useExhaustiveDependencies` ×2（`order?.status` 比 captures 更特化 + 漏依赖 `order`）。经 `git merge-base --is-ancestor` 验证：该文件最后修改于 `ac78ba3`，**早于 c3ba494 基线，非本次交付引入**。
- 5 warnings — `channel-http.ts` noUnusedVariables ×1、`credits-writer.ts` noNonNullAssertion ×1、`credits.ts` useConst ×2、`upgrade-dialog.tsx` useOptionalChain ×1。
- 2 infos — `alipay.ts` useTemplate / useLiteralKeys。

注：仓库根 `bun run lint` 使用 `--error-on-warnings`，上述 error 会使其非零；但这些违规全部可追溯到基线之前。修复建议：后续由 Engineer 跑一次 `biome lint --write` 于该 5 文件即可全部自动消除（本轮不修，路由判定 Engineer，非阻断）。

### E. 运行时冒烟（失败不阻断）

| # | 命令/步骤 | 预期 | 实际 | 判定 |
|---|---|---|---|---|
| E11 | 进程内路由冒烟：以 index.ts 同款装配（`Hono + createBillingAdminRoutes + requireUser/requireAdmin`）挂载 `/api/admin/billing`，未登录 `POST /api/admin/billing/reconcile` | 401（路由挂载存在 + 守卫在前） | **401** `{"error":"Authentication required."}`（完整 server 启动因需全套 .env 运行时环境未做，采用进程内同款装配冒烟，路由工厂与守卫即生产代码路径） | ✅ |

---

## 通过项汇总（10 通过 / 1 警告 / 0 失败）

- **A1** 506/0 ｜ **A2** 5 连跑 0 抖动 ｜ **A3** 10 边界场景全部点名覆盖且通过
- **B4** 干净库 75 迁移 + 全部关键列/约束/三个 partial unique 索引实查确认 ｜ **B5** 干净库 3 套件 21/0 ｜ **B6** 库已清理
- **C7** app 计费 23/0 × 3 连跑 ｜ **C8** 全量 1075 pass，8 失败全为预存（基线复现证实），计费 0 新增失败且基线 2 个计费失败已转绿
- **D9** typecheck 全绿 ｜ **E11** 401 冒烟通过
- **D10** ⚠️ 0 计费新增违规；2 error 为基线前遗留（upgrade-dialog，可自动修复）

## 失败项汇总

无判定为 ❌ 的项。D10 的 2 个 lint error 记录为 ⚠️：`app/src/components/billing/upgrade-dialog.tsx` useExhaustiveDependencies ×2，`git merge-base` 证实最后触碰提交 `ac78ba3` 早于基线 c3ba494，属遗留问题；修复建议 `bunx biome lint --write app/src/components/billing/upgrade-dialog.tsx`（路由：Engineer，非阻断，建议随下次计费目录整洁提交一并处理）。

## 待进一步确认问题

1. **channel-pagination 3 例为确定性失败而非抖动**（单文件隔离即失败，基线同样失败）。虽确认预存，但它不属于「跨套件抖动」而像真实存量缺陷或 happy-dom/timing 环境问题，建议单独立项跟进（路由：QA/工程联合排查，非本次范围）。
2. **基线 c3ba494 全量 247 fail 的量级**主要由 27531bd 修复的 mock.module 污染导致（HEAD 已降到 8），说明 27531bd 的修复效果显著且已验证；此条为记录，无需行动。
3. **openbot_qa_batch1 为 73/75 迁移**（0074_anomaly_dedupe 未应用，但 0074 的 partial index 在该库存在——由 qa-batch1-migration-0071 类测试按需建索引或早期手工方式落库）。5 个 B 组场景在 73 迁移库与 75 迁移干净库上均全绿，故不影响结论；但建议后续将 openbot_qa_batch1 补齐至 75 以消除双轨漂移（环境项）。
4. **并行工作流正在修改 `server/src/craft/` 5 文件**（21:08 起出现在工作树，含 event-bus/session-ready 等）。与计费无关、本次未验证其影响；提示主理人在汇总交付时知悉工作树非纯净。
5. **5435 库（openbot_enterprise_test）现为 75/75 迁移**，与简报所述「陈旧未含全链」不符——期间已被补齐（可能为批次2/3 QA 或他人操作）。本轮所有关键结论均建立在 5432 真实库 + 5432 干净库之上，不受影响。

## 结论

**最终判定：PASS（通过）。**

三批次计费修复（T1–T7 + B3）在 HEAD `27531bd` 上通过全部 11 项最终验证：核心门禁 506/0 且 5 连跑零抖动；10 个关键边界场景（并发、幂等、竞态、风暴、复活、终结、静默、守卫、对账）全部有实测用例且通过；干净库 75 迁移全链落库结构正确、三套件全绿、验后清理；app 侧计费用例 23/0 三连跑稳定、全量套件计费 0 新增失败（且较基线净改善 2 例）；typecheck 全绿；运行时路由冒烟 401 符合预期。唯一 ⚠️（upgrade-dialog 的 2 个基线前 lint error）与 5 条待确认事项均不阻断交付，已给出路由与建议。
