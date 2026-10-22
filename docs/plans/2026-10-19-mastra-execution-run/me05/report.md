# ME05 Report — 危险操作与用户问答可持久挂起并准确恢复 (#477)

- Date: 2026-10-20
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`, branch `1123786563/mastra-exec`
- HEAD: `bf64d0f2772766a7c0cdbc3e9831c9024400e165`（无 commit/push；ME01–ME05 共享同一棵未提交树）
- Ticket: `docs/tickets/mastra-agent-execution/issues/me05.md`（7 条 AC）
- 实现完成于本报告之前的实施轮；本报告轮完成：approvals-trio 排障、全量绿波、清单再生、typecheck/biome、报告与哈希。

## 1. 命令与真实结果（commands → exit code → 实际计数）

> **修正记录（fix-round-1，2026-10-20）**：本节原记的 17 pass（§1.1）、unit 15 条、116 pass / 529 expect()（§1.3）
> 为报告撰写时的过期计数（3 条 fix-round-1 生产 driver 拒绝闸测试晚于报告初稿）。实际为 **20 pass（unit 18 +
> integration 2）/ 119 pass / 539 expect()**，已就地更正；各段结论不变。fix-round-1 修复后的新实际计数
> （126 pass / 567 expect()，unit 25 / 93）见 `fix-round-1-report.md`。

### 1.1 ME05 自己的套件（unit + integration）

```
ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-continuations.test.ts \
  server/tests/enterprise/mastra-continuations.integration.test.ts
→ exit 0；20 pass / 0 fail / 0 skip（539 expect() calls，13 文件波中一并验证）
```

unit 文件 18 条：fixture 迁移守卫 + 11 条契约名（第 12 条 `two_resumers_only_one_claim` 的跨进程实现属
integration）+ payload 校验 + 2 条生命周期 + 3 条生产 driver 拒绝闸；integration 文件 2 条
（`new_process_can_resume` 真实 spawn 子进程 `server/tests/support/me05-child.ts`；`two_resumers_only_one_claim` 跨进程并发）。

### 1.2 Approvals 三件套（本报告轮的排障结论，见 §3）

| 文件 | 正确运行器 | 命令 | 结果 | exit |
|---|---|---|---|---|
| `server/tests/approvals-store.integration.test.ts` | Bun（imports `tests/support/bun-test-compat`，在 Bun 驱动清单内） | `ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test bun test <file>` | **2 pass / 0 fail**（13 expect calls） | 0 |
| `server/tests/approvals.test.ts` | **native e2e（Node）**（imports `tests/support/e2e-compat`） | `TEST_DATABASE_URL=… bunx e2e run --config e2e.unit.config.ts server/tests/approvals.test.ts server/tests/approvals-native.test.ts` | **18 passed / 0 failed**（approvals 17 + approvals-native 1） | 0 |
| `server/tests/approvals-native.test.ts` | 同上（与上一行同一次运行） | 同上 | 同上 | 0 |

**不是回归**：`server/src/approvals/**` 在本树上零改动（`git status` 无该目录条目），三件套在正确运行器下全绿。
用 `bun test` 直接跑 approvals.test.ts / approvals-native.test.ts 得到的
`SyntaxError: Export named 'registerHooks' not found in module 'node:module'`（0 pass / 1 fail / 1 error）
是**运行器错配**，见 §3。

### 1.3 全量绿波（ME05 + 六守卫 + 邻居，显式文件清单）

```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test \
  server/tests/mastra-continuations.test.ts \
  server/tests/enterprise/mastra-continuations.integration.test.ts \
  server/tests/mastra-stream-events.test.ts \
  server/tests/mastra-ag-ui-agent.test.ts \
  server/tests/mastra-governed-execution.test.ts \
  server/tests/mastra-governed-tools.test.ts \
  server/tests/mastra-browser-runner.test.ts \
  server/tests/mastra-agent-resume-process.test.ts \
  server/tests/enterprise/mastra-compatibility.test.ts \
  server/tests/mastra-tools.test.ts \
  server/tests/mastra-message-parts.test.ts \
  server/tests/enterprise/mastra-conversation-runtime.integration.test.ts \
  app/tests/mastra-runtime-compat.test.tsx
→ exit 0；**119 pass / 0 fail / 0 skip**，13 files，539 expect() calls
```

### 1.4 清单再生（本轮新增了文件 → 必跑）

```
node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs  → exit 0
1037 files audited · 562 collect under e2e · 475 do not · 469 kept on Bun in 33 driven groups
5 deliverable artifacts; 1 still-ours-to-fix（app/tests/auth-client.test.ts，既有 harness 缺口，非本轮引入）
```

ME05 新文件全部入册（islands 幸存）：`app/tests/mastra-runtime-compat.test.tsx`、
`server/tests/mastra-continuations.test.ts`、`server/tests/enterprise/mastra-continuations.integration.test.ts`、
`server/tests/mastra-agent-resume-process.test.ts` 等均出现在 `docs/verification/e2e-bun-suites.json` 的 groups+files。

### 1.5 受影响 driven 组（经 e2e 统一调度驱动 Bun 组）

```
E2E_UNIT_OUTPUT=.e2e-me05 E2E_BUN_ONLY=<组名> bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

| 组 | 含本轮文件 | 结果 |
|---|---|---|
| app/tests part 3 | mastra-runtime-compat | ✓ 1 passed |
| server/tests part 1 | approvals-store.integration | ✓（access-grant-revoke 仅共享进程内红，驱动层独跑复跑后绿，stderr 点名） |
| server/tests part 4 | mastra-continuations.unit 等 3 文件 | ✓（craft-routes-assembly 同上，复跑绿） |
| server/tests part 6 | 9 个本轮相关文件 | ✓ |

substring 过滤顺带命中并全绿：server/tests part 10 / 11 / 12。
**part 13** 被 `E2E_BUN_ONLY="server/tests part 1"` 的子串匹配连带执行，报
`subscription-ownership.integration.test.ts` 共享进程内失败；按 ADR 0008「只有独自也红才算失败」单独复跑：

```
bun test server/tests/subscription-ownership.integration.test.ts（同 env）→ exit 0；7 pass / 0 fail
```

→ 共享进程干扰（part 13 非 ME05 影响组、该文件与本轮零交集），非本轮回归。

### 1.6 Typecheck / Biome

```
bun run --cwd server typecheck → exit 0，恰好 3 条基线错误：
  scripts/bootstrap-local-gateway.ts(106,52) (108,53) (120,74)   ← 与既有基线逐条一致
bunx biome check <15 个本轮触碰文件> → 首轮 exit 1：10 条 copilot.ts 既有基线 + 1 条本轮引入
```

本轮引入并已修复的唯一诊断：`server/src/copilot.ts` assist/source/organizeImports
（`./mastra/approvals` 的 import 排在 `./mastra/conversation-runtime` 之后）；已按 safe fix 手工调整顺序，复查后仅余
**既有基线 10 条**（noUnusedFunctionParameters ×4、noUnusedVariables ×2、noConsole ×4，全部位于本轮未触碰的
legacy 区域，与 me03/me04 报告记录的基线逐条同类、行号随 hunk 平移）。其余 14 个本轮文件 0 诊断。

## 2. 逐 AC 判定（7/7 PASS，每条映射到证明测试）

| AC | 判定 | 证明测试（文件:行） | 实现锚点 |
|---|---|---|---|
| 1 挂起前保存 continuation+受保护 snapshot 引用，关联 scope/Bot/Run/Attempt/generation/operationId/参数摘要/引擎版本 | **PASS** | `suspension_saves_continuation_before_the_stream_ends`（unit:631）、`save_failure_fails_run_instead_of_waiting`（unit:741）、fixture 迁移守卫（unit:220） | `saveContinuation` continuation-store.ts:452-515（收敛保存+冲突拒绝）；schema 全列（mastra-execution-continuations.ts）；`saveSuspension` approvals.ts:313-324；execution.ts:331-365（流终无 terminal 前先落行） |
| 2 动作/参数所见即所执行；篡改/他人批准/撤权/旧 generation 拒绝 | **PASS** | `approval_matches_exact_tool_and_args`（unit:228）、`tampered_args_refused`（unit:296）、`revoked_source_blocks_resume`（unit:284）、`generation_stale_refused`（unit:313） | approvals.ts:110-177（field-wise 身份→lease 探针→generation→fingerprint→grant→argsDigest 六道闸，顺序固定）；store 侧二次篡改闸 continuation-store.ts:543-553 |
| 3 waiting_approval 与 suspended 分别映射既有产品事件；仅正式结果+费用确认后才 succeeded | **PASS** | `frontend_tool_waits_without_fake_result`（unit:343）、`suspension_saves_continuation_before_the_stream_ends`（无 fake 终态）；ME03 conversation-runtime 套件（本波 116 内）守事件面 | execution.ts:214-240（durable tool 挂载）+ execution.ts:331-365（suspension 终无 terminal、绝不完成 run） |
| 4 两个并发恢复者只有一个 CAS claim；重复点击/webhook/刷新/重启不重做已确认外部操作 | **PASS** | `two_resumers_only_one_claim`（unit:254 + integration:218 跨进程双实现）、`completed_receipt_reused_not_reexecuted`（unit:381） | `claimInternal` CAS continuation-store.ts:400-449（revision CAS + 过期接管 + HMAC token 只存 SHA-256）；receipt ledger `findReceipt/recordOperation*` continuation-store.ts:620-664 |
| 5 合法恢复跨 Attempt 保留 operationId；已完成 receipt 复用；未知结果→待处置不自动重放 | **PASS** | `completed_receipt_reused_not_reexecuted`（unit:381）、`unknown_external_effect_is_not_replayed`（unit:406） | `continuationOperationId` continuation-store.ts:182-191（executionKey+toolCallId+argsDigest 稳定派生，跨进程一致）；`finishWithReuse`/`finishPendingUnknown` approvals.ts:213-241（`failed_unknown` 即用户可见待处置） |
| 6 独立进程/实例从持久存储恢复；过期 claim 按 receipt 证据处理；版本不兼容/缺快照隔离不猜测 | **PASS** | `new_process_can_resume`（integration:103，spawn 真 bun 子进程）、`claim_expiry_requires_receipt_evidence`（unit:428）、`fingerprint_mismatch_isolates_not_executes`（unit:323） | 快照经 `snapshotRef` 只入受限存储；fingerprint digest over 实际解析版本 continuation-store.ts:164-174；过期 claim 的 finish 被 SQL 闸拒绝 continuation-store.ts:598-603，再走 receipt 证据 approvals.ts:178-187 |
| 7 拒绝/过期/停止/存储失败遵守原行为；绝不先发布可恢复再发现缺恢复数据；日志/快照不泄密 | **PASS** | `save_failure_fails_run_instead_of_waiting`（unit:741）、`crash_between_decision_and_claim_is_reappliable`（unit:490）、`continuation payload validation refuses non-v1 envelopes`（unit:566）；approvals-* 家族全绿（产品语义零改动） | save 失败→run 失败（不进 waiting）；decision-id 幂等 claim（continuation-store.ts:556-573 `claimForReceiptEvidence`）；token HMAC+随机、只存哈希、never logged continuation-store.ts:411-415；restricted-role fixture（me05-fixture.ts） |

## 3. Approvals trio 排障结论（根因 = 运行器错配，非回归）

**现象**（controller 复核）：无 `TEST_DATABASE_URL` 时三件套在收集期报
`TEST_DATABASE_URL must point at a dedicated PostgreSQL test database`；带 URL 后 `bun test` 仍 2 fail / 2 errors。

**排查与证据**：
1. `docker exec openbot-test-pg env`：`POSTGRES_PASSWORD=openbot` → **凭据正确**，"密码过期"假设排除。
2. 单独 `bun test server/tests/approvals.test.ts`（带 URL）→ `0 pass / 1 fail / 1 error`，错误体：
   `SyntaxError: Export named 'registerHooks' not found in module 'node:module'`。
3. 溯源：`tests/support/e2e-compat.ts:1` = `import { registerHooks } from "node:module"`——Node ≥22.15 的
   `module.registerHooks` API，**Bun 1.4.2 不导出**。凡 import 该兼容层的套件是 **native e2e（Node runner）套件**
   （ADR 0008 两层制），`bun test` 无法按设计加载它们。
4. 归属核验：`server/tests/approvals.test.ts`、`approvals-native.test.ts` 均以 `../../tests/support/e2e-compat` 开头
   → native e2e；`approvals-store.integration.test.ts` 以 `tests/support/bun-test-compat` 开头 → Bun 组（在
   `docs/verification/e2e-bun-suites.json` 驱动清单内）。
5. 正确运行器复跑（§1.2）：**三者全绿**；且 `git status` 证明 `server/src/approvals/**` 零改动。

**结论**：之前"2 fail / 2 errors"是把两个 Node-runner 套件塞进 `bun test` 的运行器错配伪红；产品语义无回归。
`TEST_DATABASE_URL` 守卫（server/tests/support/database.ts:18-44）本身工作正常：CI 在 job 级供给
（.github/workflows/ci.yml:391），本地等价物即本文所用 URL（端口 5433 = 本机 openbot-test-pg 容器，库 `openbot_test` 已存在）。

## 4. 迁移号与文件清单（files + line refs）

**迁移号：0164**（`server/drizzle/meta/_journal.json` 尾条 idx=164，tag `0164_mastra_execution_continuations`，version 7）。

| 文件 | 角色 | 关键行 |
|---|---|---|
| `server/drizzle/0164_mastra_execution_continuations.sql` (64 行) | 迁移：continuation 表 + receipt 证据表 + 索引/约束 | 全文件 |
| `server/src/db/schema/mastra-execution-continuations.ts` (135 行) | drizzle schema（binding 全列、operationId、argsDigest、fingerprint、snapshotRef、revision、claim 态+过期、outcome） | 表定义 22-135 |
| `server/src/mastra/continuation-store.ts` (684 行) | T6 持久 store：收敛 save、CAS claim、token、receipt、fingerprint、payload 校验 | `saveContinuation` 452-515；`claimContinuation` 520-555；`claimForReceiptEvidence` 556-573；`finishContinuation` 575-618；`claimInternal` 400-449；`mastraEngineFingerprint` 164-174；`continuationOperationId` 182-191；`parseContinuationPayload` 198-237；refusal 码表 51-62 |
| `server/src/mastra/approvals.ts` (342 行) | 准确恢复层（消费既有 approvals 决定，不重新裁决） | `resumeMastraContinuation` 100-211（六道闸→receipt 证据→CAS claim→drive→finish）；`finishWithReuse` 213-225；`finishPendingUnknown` 227-241；`MastraContinuationInstall` 274-290；`createMastraContinuationInstall` 292-340 |
| `server/src/mastra/execution.ts` | 生命周期 wiring：durable tool 挂载 + 挂起先落行再终无 terminal | 214-240（durableNames/storage）、331-365（onSuspension save-before-end） |
| `server/src/copilot.ts` | 组装 seam：install 注入 + 每次 Mastra 执行合并 durable 上下文 | seam 2178-2199（`setMastraContinuations`/`mastraContinuationInstall`）、执行合并 2367-2385、import 88 |
| `server/tests/mastra-continuations.test.ts` (785 行) | unit 15 条（一次性 DB fixture） | 测试名清单见 §2 |
| `server/tests/enterprise/mastra-continuations.integration.test.ts` (302 行) | 真 DB、跨进程（spawn `me05-child.ts`）+ 并发 | 103、218 |
| `server/tests/support/me05-fixture.ts` (248 行) / `me05-child.ts` (146 行) | 一次性库+受限角色 fixture / 跨进程子代理 | — |

## 5. 偏差与限制

1. **生产 server 装配尚未调用 `setMastraContinuations`**（copilot.ts:2188 仅定义 seam；引擎路径在 install 存在时才启用
   durable 行为，UNWIRED 时与 ME05 前行为逐字节一致）。approval 路由对 `install.resume` 的消费属后续 approvals
   集成切片；这与 brief 的范围围栏一致（"minimal wiring in execution.ts/copilot.ts — controller pre-approves"），
   与 conversation-runtime（ME03）同构的 composition seam。
2. `recordOf` 在 claim 时刻以 `memberEpoch=0/aclEpoch=0/entrypoint="web"` 重建 binding 的 epoch 字段（
   continuation-store.ts:298-304 注释）：存储的 epoch 是历史而非权威，现值由当前准入重建 —— 设计选择，非遗漏。
3. **环境限制**：approvals.test.ts / approvals-native.test.ts 必须经 `bunx e2e run --config e2e.unit.config.ts`（Node ≥22.15）
   运行；`bun test` 会因 e2e-compat 的 `module.registerHooks` 在 Bun 1.4.2 缺失而 0 pass——这是 ADR 0008 两层制的既定
   边界，不是缺陷。driven Bun 组的 `TEST_DATABASE_URL` 由调用方环境透传（tests/bun-suites.test.ts `bunEnv` 只对 MT
   island 改写）；CI 于 ci.yml:391 在 job 级供给。
4. 非本轮组 server/tests part 13 在共享进程中红（subscription-ownership.integration.test.ts），solo 复跑 7 pass →
   按 ADR 0008 规则不判失败；该组与该文件与本票零交集。
5. 本轮无 commit/push/merge、无 issue 写入、无子代理；`E2E_UNIT_OUTPUT` 必须位于项目根内（runner 约束）。

## 6. 哈希

见 `docs/plans/2026-10-19-mastra-execution-run/checkpoints/me05-review/sha256.txt`。
