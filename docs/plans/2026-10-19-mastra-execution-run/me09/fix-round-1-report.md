# ME09 Fix Round 1 Report — 独立评审三项修复 + 四项非阻塞记录 (#481)

- Date: 2026-10-22. Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec2-2`, branch `1123786563/mastra-exec2-2`, BASE `bcf51633f162`（无 commit/push/stash/git 状态变更；ME01–ME09 共享未提交树原样保留，本修复增量叠加其上）。
- Scope: ME09 独立评审 FIX 1（HIGH, settlement-clean 门）/ FIX 2（MEDIUM, store 级 fence 测试）/ FIX 3（MEDIUM, duplicate→skipped 行为测试与 FALSE 注释更正）；非阻塞 F4–F7 如实记录、未修。

## 0. 处置总览

| 项 | 处置 | 落点 |
| --- | --- | --- |
| FIX 1 | FIXED（先 RED 后 GREEN） | `server/src/index.ts`（wrapper 装配）+ `server/src/mastra/headless.ts`（gate 定义，评审授权的 seam：*only if the carrier surfacing needs a seam there*）+ `server/tests/mastra-headless.test.ts`（8 例） |
| FIX 2 | ADDED（真 PG，10 例） | 新文件 `server/tests/enterprise/mastra-resume-fences.test.ts`；`store.ts` 零改动（无需新导出） |
| FIX 3 | ADDED（行为测试）+ 注释更正 | `server/tests/routine-runner.test.ts`（+1 例）+ `server/tests/mastra-headless.test.ts` 原 L1086 注释改指真测试 |
| F4–F7 | RECORDED，未修 | 见 §4，路由 ME10+ |

## 1. FIX 1 — resume settle 路径的 settlement-clean 门（HIGH）

**修前行为**（index.ts wrapper，ME09 原树）：`innerResumeDriver.resume` 返回 resumed/declined 后无条件 `runs.complete(scope,{lease})`，carrier 困在 `loopFor`/`governedResumeSurface` 内不出 —— usage 被拒/缺失的 drive 可把 run 结成 succeeded，无结算证据（spec §5 "仅见引擎 finish 即成功" 违例）；且 complete 被拒后 fail 也可能双双被拒（无工具续驱期间租约过期），此时 outcome 仍按原样返回 "resumed"。

**修后契约**（`headless.ts` 新导出 `settleResumedRun`，index.ts wrapper 调用；与 headless 自身 finish 路径 L679 及 runner.ts RUN_FINISHED L705→729 同一门）：

1. carrier `settlementClean()` 真 → `runs.complete` 同租约结算；成功即正常返回 driven。
2. complete 被拒 → 一次真话 fail（MODEL_EXECUTION_FAILED）；fail 成功 → 抛 `MASTRA_RESUME_COMPLETION_STALE`（run 已按 failed 结算，绝无 succeeded）。
3. settlement 不洁（refused/unknown usage，含 carrier 未浮出的 null 情形，fail-closed）→ 不尝试 complete，按 `classifyGovernedRunFailure` 分类码 `runs.fail`；成功 → 抛 `MASTRA_RESUME_SETTLEMENT_UNVERIFIED`。
4. complete/fail 双拒（租约过期、无人续）→ `releaseRequestLease` 释放租约、run 保持 waiting/suspended（显式隔离处置，非结算成功）→ 抛 `MASTRA_RESUME_RUN_UNSETTLED`。

每条非成功路径都抛命名 refusal，wrapper 原 catch 释放租约后原样上抛 —— `resumeMastraContinuation` 传播该失败，continuation 结果永不静默 "resumed"/"declined"（outcome 反映真实）。

**carrier 浮出方式**：`resumeDriveState` WeakMap 的 state 增加 `carrier: GovernedModelExecution | null` 字段，`governedResumeSurface` 构建 carrier 并 `bind` 后写回 `state.carrier`（loopFor 在 wrapper `resume()` 同一 claim 上运行，wrapper 可读）；wrapper 把 `state.carrier` 交给 `settleResumedRun`。

**边界裁决（如实声明）**：
- declined 路径同门：engine finish 后若本 drive 无任何 usage 证据（issued==0，如引擎对 decline 直接终止不再调模），按同一 fail-closed 规则结 failed —— 评审 FIX 1 文本明确 "gate complete on it exactly like headless.ts:679 / runner.ts:705→729"，两处均无 decline 豁免。
- `receiptSink.executed()` 语义未动：receipt 是**外部效果**（审批的调用确已执行）的证据层，run 结算真话性由 run 层本门承担；结算失败时 refusal 叠在其上，resume 调用方看到的是命名失败而非 "resumed"。
- `resumeDriveState`（loopFor 与 resume 的既有 claim→state 通道）复用为 carrier 通道，未改 resume-driver.ts / approvals.ts。

**RED→GREEN 证据**（`server/tests/mastra-headless.test.ts` 新 describe "the resumed drive's settlement gate"，8 例）：
- RED（先写测试后实现）：
  ```
  ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-headless.test.ts
  → SyntaxError: Export named 'assertResumeBindingCurrent' not found in module '…/server/src/mastra/headless.ts'. 0 pass / 1 fail / 1 error
  ```
- GREEN（实现后，同命令）：
  ```
  → 27 pass / 0 fail / 114 expect()（基线 19/82 + 新 8 例/+32）
  ```
- 八例覆盖：settlement-refused resumed drive（0 complete、fail=MODEL_SETTLEMENT_FAILED、抛 SETTLEMENT_UNVERIFIED）；declined 无 usage 证据 fail-closed；clean+complete 成功（控制例：1 complete/0 fail/0 release）；complete 拒→fail 成（COMPLETION_STALE）；双拒→隔离+release（RUN_UNSETTLED）；预算 402+死租约（fail=MODEL_BUDGET_EXCEEDED+release+RUN_UNSETTLED）；carrier 缺失 fail-closed；`assertResumeBindingCurrent` 的 attempt/generation 错配拒绝（ GENERATION_STALE，即原 index.ts:3254-3262 内联检查的唯一定义化）。

**index.ts 装配**（本票增量）：`assertResumeBindingCurrent(reactivated, claim.binding)` 替换内联 attempt/generation 检查；else 分支替换为 `settleResumedRun(enterpriseRunner.runs, {scope, lease: state.lease, carrier: state.carrier, outcome})`；随移除仅此一处使用的 `MASTRA_CONTINUATION_REFUSALS` 导入（净导入不添噪）。

## 2. FIX 2 — runs 服务新面的 store 级 fence 测试（MEDIUM）

新文件 `server/tests/enterprise/mastra-resume-fences.test.ts`（bun，真 PG）：me03 式一次性 fixture（`createMe03Fixture`，pg-container 5433，teardown drop 库），runs 服务/run store/conversation 服务全为生产实例，每个用例独立会话（runs 服务的单 thread 单活跃 run 互斥要求）。10 例：

- `markRunSuspended` 拒绝族（4 例）：错误 owner token（有效 UUID 冒名——注：owner token 列为 uuid 类型，非 UUID 字符串会触发 PG 类型错而非 fence false，故冒名 token 用 `randomUUID()`）→ false；owner 窗口过期（直接置 attempt.request_owner_expires_at 过去）→ false；attempt 失活（`runStore.expireLease`，按 runs 集成套件先例传未来 now）→ false；run 已离开 queued/running（二次 markRunSuspended）→ false。正控制例：真租约 → true、run 行 suspended、attempt 仍 active。
- `reactivateSuspensionLease` 拒绝族（4 例）：非 waiting run 与已 settle run → `RUN_NOT_ACTIVE`；活 owner 在场（markRunSuspended 后租约未释放）→ `RUN_REQUEST_LEASE_HELD`(409)；并发双 reactivate（先 release）→ 恰一成、一拒 `RUN_REQUEST_LEASE_HELD`（pre-check/CAS 两臂共同保证的单驱动者性质；注：pre-check `SELECT … FOR UPDATE` 与 CAS 同事务持锁，外部无法确定性打进 CAS 拒绝臂本身——该臂为防御性死码，并发例钉住的是可观察保证）；createdAt+MAXIMUM_RUN_DURATION(15 分钟) 上限（置 createdAt 20 分钟前）→ `RUN_LEASE_EXPIRED` 且 run 保持 suspended（隔离非结算）。
- 返回事实（1 例）：同 attempt/generation 重臂（新 ownerToken、未过期），`modelRouteRef`/`maximumTokens` 等于 run 行自身 `model_route_ref`/`model_route_maximum_tokens`（接口不收 caller route，事实即 run 自己的）。
- wrapper generation-stale 门（1 例）：suspended→release→expireLease（generation+1、run 仍 suspended）→ 真 store 产出的重臂租约喂 `assertResumeBindingCurrent`：旧绑定抛 `MASTRA_CONTINUATION_GENERATION_STALE`，当前绑定通过 —— index.ts:3254-3262 检查经抽出的唯一定义由真 store 事实驱动。

## 3. FIX 3 — duplicate→skipped 的 runner 行为测试 + FALSE 注释更正（MEDIUM）

- `server/tests/routine-runner.test.ts` 新例 "records a duplicate-delivery convergence as skipped without touching the fatigue rule"：fake `runTurn` 抛 `GovernedHeadlessRefusal(ROUTINE_INTENT_ALREADY_ADVANCED)` → `finishRun` 落 `skipped`（error=拒绝消息）、频道零 activity、零 setEnabled，且疲劳计数**未被读**（harness 新增 `fatigueReads()` 计数器断言为 0 —— 计数器加在 `consecutiveFailures` 存根上，不触既有断言）。套件 11 → 12 例。
- `server/tests/mastra-headless.test.ts` 原 L1084-1089 注释 "The mapping itself is covered by the routines runner suite" 为假 —— 更正为指向 `server/tests/routine-runner.test.ts` 的上行为测试（dup→skipped 此前在 routines runner 侧并无覆盖，评审属实）。

## 4. 非阻塞 finding 记录（不修，路由 ME10+）

- **F4 approval waits never park on mastra paths**：所有装配点 `durableToolNames: []`（index.ts continuations install 等）；需审批的 granted 调用在 mastra 路径上以命名拒绝 fail-closed，从不挂起等待。ME10 需产品裁决：挂 durable 暂停（resumption 面 + 审批 UI 接线）或书面固化 fail-closed 合同；届时一并更正 `server/src/mastra/tools.ts:234` 注释。
- **F5 headless events-append 注释不符**：`server/src/mastra/headless.ts` 事件台账 best-effort（append 失败仅日志）与相关注释措辞不一致；ME09 report §4 已声明该偏差，注释收口归 ME10+。
- **F6 dead waiting rows disposition**：`waiting` 行的 routine run 无后续驱动者时的处置（认领过期后无 recovery 路径）无显式语义，留 ME10+。
- **F7 stale refusal mapping**：`server/src/mastra/continuation-routes.ts:100` 仍映射 `MASTRA_RESUME_LOOP_MODEL_UNWIRED`（ME09 已移除该占位拒绝，死映射），且 `server/tests/mastra-computer-tools.test.ts:405` 仍在钉住该 stale 映射；改名/清除归 ME10+。

## 5. Diff 摘要（本修复增量，全部未提交）

- `server/src/mastra/headless.ts`：+`MASTRA_RESUME_SETTLE_REFUSALS`（3 个命名码）、+`settleResumedRun()`、+`assertResumeBindingCurrent()`；+continuation-store 导入。生产 finish 路径零改动。
- `server/src/index.ts`：resume wrapper 区（~L3140-3330）——state 增 `carrier` 字段并在 `governedResumeSurface` 写回；内联 stale 检查换 `assertResumeBindingCurrent`；settle 分支换 `settleResumedRun`；导入增删（+`GovernedModelExecution` 类型、+两个 gate 函数，−`MASTRA_CONTINUATION_REFUSALS`）。
- `server/tests/mastra-headless.test.ts`：+settlement-gate describe（8 例）+ FIX 3 注释更正。
- `server/tests/routine-runner.test.ts`：harness `fatigueReads` 计数器 + 1 行为例。
- `server/tests/enterprise/mastra-resume-fences.test.ts`：新文件（10 例）。
- `tests/config/e2e-bun-suites.json`、`archive/verification/e2e-file-audit.json`：新文件入册再生。
- `server/src/enterprise/runs/store.ts`：**零改动**（FIX 2 无需导出）；`server/src/mastra/headless.ts` 之外的 mastra 生产文件零改动。

## 6. 命令与真实计数

### 6.1 本修复套件（独跑，多轮同计数）
```
ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-headless.test.ts
→ RED 0 pass/1 fail（导出缺失）→ GREEN 27 pass / 0 fail / 114 expect()

ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test server/tests/enterprise/mastra-resume-fences.test.ts
→ 10 pass / 0 fail / 50 expect()（三轮同计数，每轮一次性新库、teardown drop）

ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=… bun test server/tests/enterprise/mastra-routines.integration.test.ts
→ 4 pass / 0 fail / 26 expect()

bunx e2e run --config e2e.unit.config.ts server/tests/routine-runner.test.ts
→ 12 passed（基线 11）
```

### 6.2 全量绿波（me09 §1.2 的 22 文件 + 本修复新 fence 套件 = 23 文件）
```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test <22 文件 + server/tests/enterprise/mastra-resume-fences.test.ts>
→ **273 pass / 0 fail / 1350 expect()**（基线 255/1268 + headless 8/32 + fences 10/50；数字严格对账）
```

### 6.3 门禁
- `bunx tsc --noEmit`（server/）→ **恰好 3 条基线错误**（scripts/bootstrap-local-gateway.ts 106/108/120），本修复 0 新增。
- `bunx biome check` 触及四文件（headless.ts、mastra-headless.test.ts、routine-runner.test.ts、mastra-resume-fences.test.ts）→ **clean**（两测试文件的 import 排序/格式经 --write 收敛后复检 0 error）；`bunx biome check server/src/index.ts` → 仅预存噪声（noUnusedImports `currentRunObservationScope`、noConsole、noNonNullAssertion，均非本修复行，与本修复前一致）。
- 清单注册：`node scripts/e2e-add-driven.mjs server/tests/enterprise/mastra-resume-fences.test.ts` → `added … · 611 driven · 39 groups`（单独一次调用）。随后按 me09 先例再生 `e2e-file-audit.mjs`（1197 files audited，本会话内完成）+ `e2e-bun-manifest.mjs`：新文件与 headless/routines 套件同样按 `Received protocol 'bun:'` 归 Bun-runtime driven，清单 **611 kept / 39 groups**、fences 文件在册（`manifest.files.has(...) === true` 程序化核验）；`COLLECTION_ERROR` 3 条均为工作区既有 multitenancy 文件（与本修复零交集）。
- Git 状态：无 commit/push/stash/add —— `git stash list` 的既有 `stash@{0}`（main @792c8760）为工作区先前遗留，未触碰。

## 7. 偏差与边界

1. **gate 定义落 headless.ts 而非全在 index.ts**：评审授权 "headless.ts only if the carrier surfacing needs a seam there — prefer index.ts"。index.ts 不可被测试导入（顶层装配副作用），不抽 seam 则 FIX 1 的 RED 无法成立；`settleResumedRun`/`assertResumeBindingCurrent` 即 carrier 浮出/门判定的测试 seam，生产装配仍全在 index.ts。
2. **FIX 1 测试为 gate 单测而非 wrapper 端到端**：同上原因；生产 wrapper 调用的就是被测函数（同一代码路径），真 PG 侧的 reactivation/binding-stale 事实由 fence 套件第 8-10 例供结。
3. **declined 无 usage 即 failed**（见 §1 边界裁决）：这是 fail-closed 方向的行为收紧，评审文本明示要 "exactly like headless.ts:679"。
4. **fence 套件每例独立会话**：runs 服务的单 thread 单活跃 run 互斥（ACTIVE_RUN_CONFLICT）要求之；非夹具缺陷。
5. **冒名 owner token 必须是合法 UUID**：uuid 列的类型错先于 fence 判定，测试按真实可拒绝面取值（§2）。
