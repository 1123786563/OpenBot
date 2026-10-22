# ME10 Report — 职责、投递、唤醒与审批续跑统一执行和回传 (#482)

- Date: 2026-10-23. Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec2-2`, branch `1123786563/mastra-exec2-2`, BASE `bcf51633f162`。本 Agent 未执行任何 commit/push/stash；实施期间（2026-10-23 00:10:57 +0800）**外部操作者（wuyj）以 `chore(sync)` 提交了整个未提交树（commit `0b0b36c14`，含本票与 ME01–ME09/ME13 全部增量）**——本票全部改动完整存在于该提交内的工作树中，无丢失、无本方提交动作。此事件如实上报。
- Ticket: `docs/tickets/mastra-agent-execution/issues/me10.md`（6 AC）；Brief: `me10/brief.md`；Spec §8；ADR 0006/0008/0010。

## 0. 入口清单（AC1 — 逐项登记）

同一 `createGovernedTurnRunner`（ME09 的受控 headless turn）服务四个入口；每个入口只贡献自己的记录权威（`schedulingRecordFor`）与表面增量（`surfaceFor` 的 extraTools），其余全部复用共享装配（scope 重签、预算、runs 装配、事件台账、expert 版本、governed carrier、会话运行时、记忆、continuations install）。

| 入口 | 业务归属（记录权威） | 受限执行身份 | 预算来源 | 去重键（ONE advance intent） | 目标会话 | 回调（结果/失败回传） |
| --- | --- | --- | --- | --- | --- | --- |
| 职责推进 | `responsibility_runs` 行（dispatch 队列只携带 runId） | initiator `kind:"responsibility", id:<responsibilityId>`；scope 由 schedule-entrypoint resolver 从目录按 owner+thread 现签 | 共享 `OPENBOT_ROUTINE_RUN_OUTPUT_TOKENS`（显式 env，正 int32；缺失/非法 → `ROUTINE_BUDGET_UNCONFIGURED`） | `routine-adv:<runId>:<runId>`（governedFiringIntentKey(routineId=runRowId, firingId=runId)） | 责任行 threadId（channel 解析不一致即 gone record） | 成功 `settleRun(succeeded, replyText)` + `onReply`（recordActivity + deliveryNotifications）；等待落 `settleRun(waiting)`；重复收敛落 `skipped` |
| 消息投递 | `delivery_inbox` 行（router 队列携带 inbox row id） | `PERSON_INITIATOR`；scope 同上从目录现签；`authoriseDeliveryScope` 前置 | 同上 | `routine-adv:delivery:<inboxId>:<inboxId>` | inbox 行 threadId（row.threadId 即记录） | 回复 recordActivity(`delivery-reply:<id>`) + notify；inbox 行 `setInbox(sent/failed)`；重复收敛落 failed + 命名原因 |
| 唤醒 | `work_items` 行 kind `bot.wakeup`（sweep 携带 item key） | initiator `kind:"routine", id:"follow-up:<key>"`；scope 同上 | 同上 | `routine-adv:follow-up:<key>:<key>`（WakeUpTurn 新增 runId=item.key 透传） | payload.channelId 的 channel thread，缺省 Bot 私聊 direct | 成功 recordActivity + notify + `settle(succeeded)`；Bot 暂停/重复 → `skipped`；HeadlessToolSuspension → `waiting`；其余 `failed` |
| 审批续跑 | 审批请求行（approvals 子系统）+ ME05 continuation 行（F4 parking） | 决策者本人；scope 由目录按 owner+parked thread 现签，六门逐项复核（identity/ownership/generation/args/fingerprint/grant） | 恢复期不新铸 reservation：`reactivateSuspensionLease` 重臂原 run 租约，capability 仍受原 run 剩余预算约束（已消耗量经 `settledTokens` 播种进恢复 carrier 台账） | 续跑即原 continuation 本身：按 `payload.kind==="approval" && payload.toolCallId === snapshot.toolCallId` 精确取行，不新建意图 | parked run 的 binding.threadId（即 snapshot.threadId） | 驱动结果经 `surface()`：审批行 saveResult+finish、mapped channel recordActivity + deliveryNotifications；来源为责任行时 `settleWaitingResponsibilityRun(succeeded, answer)`；`pending_unknown` 落真实失败（待处置文案） |

**无平行路径**：四入口全部走 ME09 selector 合同（enterprise capabilities 齐备 → governed turn；否则各自 legacy 装配原样保留）。`grep IntelligenceAgentRunner|routineIntelligence` 生产消费面残差登记（§4）。

## 1. 命令与真实结果

### 1.1 本票新套件（独跑）
```
ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-entries.test.ts
→ 12 pass / 0 fail / 42 expect()

ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test server/tests/enterprise/mastra-entries.integration.test.ts
→ 3 pass / 0 fail / 25 expect()（真实 PG me03 式一次性库，teardown drop）
```

### 1.2 合并绿波（20 基线 mastra 文件 + 本票 2 = 22 文件，单次进程）
```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://…:5433/openbot_test \
bun test <22 文件>
→ **259 pass / 0 fail / 1220 expect()**
```

### 1.3 逐文件核查（28 个已册 mastra 文件全部单跑）
- 26/28 绿（含本票两件；`mastra-computer-tools` 12/0、`mastra-continuations` 31/0、`mastra-headless` 27/0、`mastra-governed-execution` 20/0、`mastra-routines.integration` 4/0、`mastra-resume-fences` 10/0 等）。
- `mastra-storage.integration`：要求 `openbot_enterprise_*` 库名（enterprise env group，主侧既有环境红，非本票）。
- 五个跨进程重放套件（`mastra-continuations.integration`/`conversation-runtime`/`frontend-tool-participation`/`import`/`engine-wiring`）在 28 文件合跑高负载下出现 me05/me01 child 进程 5s 超时；**单独复跑全部绿**（2/0、15/0、5/0、7/0、5/0）。属环境负载/子进程孵化抖动，非断言红。
- 28 文件一次性合跑计数：240 tests，221 pass / 19 fail / 1060 expects —— 19 个失败全部归属上述两类（child 超时 × 合跑负载 + storage 的 enterprise URL 门槛），与 §1.3 逐文件结论一致。

### 1.4 门禁
- `bun x tsc --noEmit`（server/）→ **恰好 3 条基线错误**（bootstrap-local-gateway.ts:106/108/120），本票 0 新增。
- `bunx biome check` 本票新增/触改文件 → 干净（`mastra-tools`/`mastra-headless`/`mastra-computer-tools`/entries 两件等）；`ai-sdk-v3-gateway-adapter.ts` 的 noExplicitAny 为整文件既有噪声（本票仅在 deps/ledger 两处加法）；`index.ts` 保持 ME09 时的既有 lint 噪声（noConsole/noNonNullAssertion/noUnusedImports 族），本票新增行 0 告警（唯一的 noUnusedFunctionParameters 由 owner 过滤修复消除）。
- 邻家回归：`routine-sweep.integration` 27/0（本票未触 sweep）；`delivery-router`/`delivery-turn`/`routine-runner` 直跑报 `registerHooks` 为既定 e2e-native 错层模式（ME09 report §1.3 同类，非本票）。
- 清单注册：`node scripts/e2e-add-driven.mjs server/tests/mastra-entries.test.ts`、`… server/tests/enterprise/mastra-entries.integration.test.ts`（逐文件单独调用）；`e2e-file-audit.mjs` 全量再生完成（1199 条，含本票两件——Node 采集器对 bun-driven 文件报 `bun:` protocol collect_error，与 `mastra-headless`/`mastra-continuations` 等既册套件同型同位）；`node scripts/e2e-bun-manifest.mjs` 再生 → **613 driven / 39 groups**，本票两件入册（其中 3 条 multitenancy COLLECTION_ERROR 为主侧既有）。

## 2. AC 逐条证据

- **AC1（四入口登记并迁移）**：§0 清单 + 实现——`index.ts` 共享 `governedHeadlessSurfaceFor`/`governedHeadlessTurnFor`（ME09 routine 装配收敛为共享基），三入口 selector（responsibility engine runTurn / deliveryRouter.runTurn / wakeUpRunner.runTurn）与审批续跑 governed drive；不新建平行模型或 Intelligence runner 路径。
- **AC2（资格重验；撤权不全局扫描续跑）**：每入口 `schedulingRecordFor` 现读各自 durable 行 + `governedHeadlessScopeFor` 目录现签（成员撤销/会话变更当场抛出，turn 未跑先拒）；审批续跑经六门 + `scopeIdentityMatches` 场域逐字段核对 + `toolGrantCurrent` kind-aware 复核；`settleWaitingResponsibilityRun` 查询 owner 过滤。单测 `each_entry_reverifies_eligibility_through_the_directory_before_running`（0 append/0 dial/0 admission）；integration 用真实目录 resolver。
- **AC3（复用 lease/历史/预算/工具/记忆）**：四入口与 routine 共用同一 `createGovernedTurnRunner` 实例族——request lease（acquire/renew/release-once）、`loadExecutionInput` 服务端历史重建、`OPENBOT_ROUTINE_RUN_OUTPUT_TOKENS` 显式预算 + `runWithBoundModelRoute` 绑定、granted 工具 + 作用域 computer 面 + learned skills、ME07 记忆块（本票把 `headlessPersonalMemoryContext` 接入共享表面——AC3 的记忆复用，ME09 未接）。integration 断言 governed carrier/真实 runs 服务/真实会话服务。
- **AC4（重投递/恢复操作身份稳定；receipt 不重执行；未知副作用停止）**：意图键确定性（单测 `derives_one_stable_intent…` 既有 + entries 件 delivery/wake-up 形状）；重复投递收敛（integration `AC6` 真库：1 run 行、0 次 redial、命名拒绝；单测 `a_wake_up_redelivery_converges…`）；receipt 证据层（ME05 既有）+ 恢复驱动 `receiptSink.started/executed` 顺序与 `reused_receipt`/`pending_unknown` 不重执行语义（六门既有，integration 全链验证 resumed→settled succeeded）。
- **AC5（审批续跑引用准确 continuation）**：F4 落地——granted execute 内审批等待经引擎 `suspend()` 挂 ME05 台账（save-before-waiting），run `markRunSuspended(waiting_approval)`；决策到达经 `governedApprovalContinuationDrive`：按 toolCallId 精确取 waiting 行、以行自身 argsDigest 构造决策、`install.resume` 六门 + `reactivateSuspensionLease` 驱动同一步——**从不把批准事件当新聊天重跑**（governed 臂收到 legacy continuation 输入时具名拒绝 `RESPONSIBILITY_LEGACY_CONTINUATION_UNSUPPORTED`；delivery/proactive 的 fresh turn 与 legacy-snapshot resume 各归其位）。integration `F4` 用例走**完整编排器**（`resumeMastraContinuation`：六门——identity 域核对、`createGenerationCurrentGate` 真实 runs 服务 generation 复核、fingerprint、决策/参数匹配、grant——+ store CAS claim + receipt 顺序）+ 真实 `reactivateSuspensionLease` 重臂 + 生产 resume driver：真实 parking→真实行→真实恢复→工具恰执行一次→run succeeded→confirmed usage。
- **AC6（每入口正常+取消/超时/重复；结果可见；费用/观测归属正确）**：单测覆盖 cancel（`a_cancelled_turn_never_claims_the_intent`：0 append/0 dial）、timeout（`a_timed_out_turn_fails_the_run_truthfully…`：fail MODEL_EXECUTION_FAILED + lease 释放）、duplicate（delivery/wake-up 收敛）；正常推进由 integration 三例覆盖。可见性：责任回复落 run 行 + channel activity + delivery notify；投递落 inbox 行状态 + activity；唤醒落 settle 台账 + notify；审批落审批行 result + mapped channel activity。费用归属：governed carrier 台账（integration 断言 confirmed capability）+ 恢复期 `settledTokens` 播种防止重复计 ceiling。

## 3. 文件清单（本票增量）

新增：`server/tests/mastra-entries.test.ts`、`server/tests/enterprise/mastra-entries.integration.test.ts`。

修改（既有脏树内加法；全部未由本方提交）：`server/src/mastra/headless.ts`（frame 选项、surfaceFor routineId、approvalBinding、F5 注释对齐）、`tools.ts`（F4 durable parking + 审批 ALS + decline 结果面 + 原 L234 过时注释更正）、`execution.ts`/`execution-contracts.ts`（approvalBinding 透传）、`resume-driver.ts`（驱动 scope 参数 + 恢复 dial 携带 `maxOutputTokens`+`maxRetries:0`）、`approvals.ts`（驱动合同加 scope）、`continuation-routes.ts`（F7 死映射清除）；`server/src/index.ts`（共享表面/工厂、三入口 selector 与 governed turn、审批 governed drive、F6 接线、记忆接入、恢复表面 approvalBinding+播种）；`server/src/agents/wake-up.ts`（runId 透传 + 重复→skipped）、`server/src/responsibilities/engine.ts`（重复→skipped）、`server/src/delivery/router.ts`（重复收敛）；`server/src/enterprise/runs/store.ts`（F6 disposition + reactivation 返回 `settledTokens`）、`service.ts`、`../contracts.ts`（加法面）、`../models/ai-sdk-v3-gateway-adapter.ts`（ledger 播种）、`governed-execution.ts`（播种透传）；测试：`mastra-tools.test.ts`（F4 合同更新）、`mastra-computer-tools.test.ts`（F7 测试名/断言更正）；`tests/config/e2e-bun-suites.json`、`archive/verification/e2e-file-audit.json`（入册再生）。

## 4. Intelligence 残差登记（生产消费面）

本票后 `routineIntelligence`/`IntelligenceAgentRunner` 的生产消费面：

| 残差 | 性质 | 依据 |
| --- | --- | --- |
| `legacyRoutineTurn`（index.ts） | 非企业部署的 selector fallback | ME09 交付的 selector 合同原文（"无 enterprise 时保持 legacy 装配不变"） |
| 责任引擎 legacy 臂 / `responsibilityAnswerTurn` | 同上 fallback；answer turn 只服务 legacy-parked question 等待（governed 表面不挂 ask_person，不产生新 question 等待） | 同上 + 本票 governed 臂对 legacy continuation 具名拒绝 |
| `approvalContinuationRunner` | legacy-snapshot resume（group conversations 的 ME11 面、proactive startTask、非企业部署审批续跑）；governed parking 一律走 governed drive | 本票 entry-4 分流 |
| proactive engine runTurn | 非本票四入口（Spec §8 入口清单外），未迁移 | 入口清单对照 |
| openMuseTaskRunner / groupConversations / handoff runner | ME12 / ME11 票面 | Spec §10 A12/A13 |
| `getThreadMessages` 三处（审批 re-entry 校验、channel summaries、delivery 会话 history 读） | Intelligence 历史读面（展示/校验），非执行路径；治理归 ME14/ME16 收口 | 对照入口清单 |

## 5. 发现并修复的既有缺陷（实施期真实行为差异）

1. **恢复循环从未携带预算 ceiling**（`resume-driver.ts` resumeStream 无 modelSettings）——governed gateway adapter 对无 ceiling 调用 fail-close（`UNSUPPORTED_OR_INVALID_MODEL_GATEWAY_RESPONSE`），即 ME09 的恢复接线在本适配器上**一次都无法 dial**。修复：`MastraResumeLoop.maxOutputTokens` + resumeStream `modelSettings{maxOutputTokens, maxRetries:0}`；index.ts 恢复表面回填 run 自己的 ceiling。
2. **恢复 wrapper 使用再派生（不受信）scope 调 runs 服务**——`claim.binding.scope` 出库后非 `issuedScopes` 成员，`reactivateSuspensionLease`/`issueModelInvocationCapability`/renew 全部 `UNVERIFIED_SCOPE`。修复：`MastraResumeDriver.resume` 输入增加 `scope`（编排器已域校验的调用方可信 scope），wrapper/表面全部改用之。
3. **恢复 carrier 台账从零起算**——park 轮已确认用量后再按整 ceiling 铸 capability → 402 `MODEL_BUDGET_EXCEEDED`。修复：`reactivateSuspensionLease` 返回 `settledTokens`（与 capability mint 预算门同一求和），`createGovernedModelExecution(alreadySettledTokens)` 播种 adapter ledger，恢复 dial 只请求剩余预算。

以上三项均为 ME09 恢复接线的潜在断点（ME09 report §6 已声明恢复链未做跨进程全链集成），由本票 integration F4 用例首次全链跑通时暴露并当场修复。

## 6. F4/F5/F6/F7 处置

- **F4**：如上（governed 装配挂 durable 审批暂停：requireApproval 语义经引擎 `suspend()` 落 ME05 台账，`reactivateSuspensionLease` 恢复）。与六门无冲突——parking 保存的 binding 正是六门复核的对象；恢复走 ME05 编排器原门。发现并修复 §5 三缺陷。`tools.ts` 原 L234 注释（"ME09's durable approval wiring is the real host"）已替换为 F4 真实语义。**边界（如实声明）**：恢复段产出的回答不经 `persistExecutionMessages` 回写会话存储（resume driver 只回传 produced facts，不产出消息流）；用户可见性由入口回调承担（审批行 result、channel activity、delivery notify、责任 run 行 replyText）——会话存储回写留后续收口，integration 用例按此契约断言。
- **F5**：headless 事件台账注释与行为对齐（best-effort + 声明的偏差来源；未升 fail-run——无实时订阅者，结算证据由 run 行/会话回写/capability 台账承载）。
- **F6**：`disposeUnresumableSuspensions`（store+service，scope 界定）：`waiting_approval/suspended` 且重激活窗口（createdAt+MAXIMUM_RUN_DURATION，即 `reactivateSuspensionLease` 拒绝的同一谓词）已过的 run 落 `failed/SUSPENSION_WINDOW_EXPIRED` + outbox 事件；窗口内的等待（含未决策的审批）不动。驱动点：审批 governed drive 每次决策尝试先清理该 scope 的死行（自然节流，无新定时器；RLS 安全）。integration F6 用例：过期 run 恰一次处置 + 窗口内 run 保持 waiting + 复跑 0。
- **F7**：`continuation-routes.ts` 删除 `MASTRA_RESUME_LOOP_MODEL_UNWIRED` 死映射（503 仅留 `MASTRA_CONTINUATIONS_UNWIRED`）+ 注释更新；`mastra-computer-tools.test.ts` 该用例改名 `unwired_install_refusal_maps_to_503_not_500` 并断言未知码落 500。

## 7. 边界与如实声明

- 本票未改调度算法、疲劳规则、OpenMuse/Craft/Computer 引擎；未 commit/push/stash（外部 sync commit 见报告头）。
- 审批请求通知在投递等待面上以 `requestId`（引擎 toolCallId）出现一次；权威审批通知由审批子系统自身创建时发送，重复面为外观性（记录在案，不阻塞）。
- 责任入口 governed 臂遇到 legacy-parked continuation 具名拒绝（不静默重跑）；切换前旧暂停的迁移处置属 ME14（Spec §9）。
- UNVERIFIED：真实时钟端到端（真 cron/worker 进程链路）；真实 provider dial（既定 stub SSE harness 形态）；28 文件合跑的 child 进程抖动归因（单跑全绿，未做负载隔离矩阵）；`e2e-file-audit.mjs` 全量再生完成时的最终审计 JSON。
