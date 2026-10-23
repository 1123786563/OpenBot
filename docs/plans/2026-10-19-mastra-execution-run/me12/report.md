# ME12 Report — OpenMuse 与 Workshop 调用保留任务、产物和作用域 (#484)

> 控制器注：本报告由 ME12 实现 Agent 以文本返回，控制器于 2026-10-23 原文落盘（该 Agent 对此路径无写权限）。控制器独立复核：30 文件波 324 pass / 0 fail（全绿）。

- Date: 2026-10-23. Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec2-2`, branch `1123786563/mastra-exec2-2`, working base `46b4180ed3`. 本票全部改动为该基点上的未提交增量，叠在 ME11 未提交增量之上。本 Agent 未执行任何 commit/push/stash；ME11 增量零触碰。
- Ticket: `docs/tickets/mastra-agent-execution/issues/me12.md`；Spec §8（A13）；复用 ME09/ME10/ME11 共享装配与选择器合同。
- 独立评审：尚未进行（实现与自验完成；待只读验证者 + 独立评审）。

## 0. 入口清单（AC1 — 主仓库实际装配的 OpenMuse/Workshop 无头调用）

方法：`grep openmuseTaskRunner / workshop headless / groupConversations` + 全量 workshop/craft/openmuse 消费面核查。主仓库真正装配、驱动 OpenBot Bot 模型 turn 的调用只有一处。

| 调用 | 装配点 | 入口 | 身份 | 作用域 | 预算 | 产物 | 取消关系 | 处置 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenMuse Task runner（runTurn 接缝） | index.ts `openMuseTaskRunner`（选择器 L5205） | openMuseTaskSweep(5s)→队列 claim(attempts≤2)→每 Task 一 turn | 记录权威=openmuse_tasks 行；owner=行 ownerUserId，Bot=行 botId（私有 OpenMuse Bot），thread=owner×Bot 直接频道 | 旧版无企业作用域；受控臂（本票）：目录按 owner+thread 现签，entrypoint schedule | 旧版无显式预算；受控臂：共享 OPENBOT_ROUTINE_RUN_OUTPUT_TOKENS + runWithBoundModelRoute；payer=admission principal | 证据/步骤/artifactIds 全落 Task 行 + 文件 store 幂等键 + 通知 emit | AbortSignal.timeout(deadlineMs)；取消/暂停于 turn 结束安全边界结算（行 CAS）；T07 attempts 恢复 | **迁移** |
| groupConversations（runTurn，ME10/ME11 登记指向 ME12） | index.ts L5212 区域 | groupSweep(1s)→每 Bot 一 turn 进 group 线程+relay | 记录权威=group_messages 行 | 无 | 无显式预算 | 共享 transcript | 队列租约 15min 逐 Bot 续租 | **登记不迁移**（R1 结构性阻塞） |
| Workshop 无头通道（run_workshop_turn/createHeadlessWorkshopTools） | workshop/headless.ts | **无生产挂载**（仅测试引用） | — | — | — | — | — | **登记：主仓库今日无此装配**；Workshop turn 执行器（orchestrator→CodeRunGateway sandbox 流）为 Workshop 自身执行器，票面边界明示不改 |
| Craft turns（craft/turn-executor.ts） | craft 模块 | 交互 turn 后台执行 | — | — | — | — | — | Craft 自身执行器，边界外 |
| proactive engine（runTurn） | index.ts L4937 区域 | proactive sweep | — | — | — | — | — | 维持 ME10 §4 登记：非 spec §8 枚举项（R5） |

## 1. 命令与真实结果

### 1.1 新套件（独跑）
```
ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-openmuse-entry.test.ts
→ 7 pass / 0 fail / 22 expect()
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=… bun test server/tests/enterprise/mastra-openmuse-entry.integration.test.ts
→ 4 pass / 0 fail / 27 expect()（真实 PG me03 一次性库 teardown drop；连跑 3 轮全绿）
```
集成四例：正常（全链 sweep→受控 turn→行 succeeded+证据+会话回写+run 行上限）/ 复制（二次队列投递收敛 0 新拨号）/ 已撤销（无企业身份 owner 目录拒，0 run 行 0 拨号 0 会话写入）/ 取消（在飞取消→安全边界落 cancelled+备注）。

### 1.2 合并波（31 个 bun-driven mastra 文件含本票两件）
```
→ 324 pass / 0 fail / 1601 expect()（实现 Agent 口径；控制器 30 文件复跑 324/0/1593，全绿）
```
mastra-storage.integration 仍为主侧既有环境红（要求 openbot_enterprise_* 库名），不在波内。注册顺序照办：add-driven ×2（每调用一件→617 driven/39 groups）→ e2e-file-audit 再生 → e2e-bun-manifest 再生 617/39。

### 1.3 邻家回归
OpenMuse 家族 e2e runner 252/0（tasks 87、task-runner 80、files 63、deletion、group-conversations）+ lease-recovery 8/0 + capacity 10/0 + group-conversations.integration（真 PG）15/0。Workshop 授权面 6 文件 51/0 + preview/artifacts 19/0/49。旧 store/runner 单测 bun 直跑 registerHooks 为既定 e2e-native 错层（ME10 §1.3 同型），已按真实 runner 复跑。multitenancy/execution-artifacts 收集失败（support/bots-ownership.ts:97 既有语法错；分区 config 显式排除，主侧既有）。

### 1.4 门禁
tsc 恰好 3 条基线（bootstrap-local-gateway.ts:106/108/120）0 新增。Biome 本票四文件干净；index.ts 与基线同集合 6 条（全在预存行），新增行 0 告警。

## 2. AC 逐条证据

- **AC1**：§0 表六维逐一登记含 file:line。
- **AC2**：选择器 index.ts:5165（governedOpenMuseTaskTurn，enterprise 谓词同族）+ :5205（`governedOpenMuseTaskTurn ?? createTurnRunner({...原文...})`）。记录权威 `server/src/mastra/openmuse-task-entry.ts:35`：turn 时现读任务行（settled/gone→ROUTINE_SCHEDULING_RECORD_GONE；unit `a_settled_task_refuses_before_anything_is_admitted`、`a_routine_id_that_is_not_an_openmuse_task...`），channel seam 现解析；集成 revoked 例经真实目录 resolveForThread 拒绝并断言 0 run 行/0 拨号/0 会话写入。无第二模型直连、无 env 猜测；表面 extraTools 仅 openMuseToolsFor(scope.actorId, agentId)（C07 模板门控）。
- **AC3**：等待合同=共享表面原文（governedHeadlessSurfaceFor 携带 ME05/ME06 durable continuation install；ME10 F4 全链集成持续护住）。回传：回复写回原 Task 行 evidence + owner 原会话线程（集成断言）。重复回调：集成 duplicate 例——行自身状态权威跳过（0 新拨号、evidence 条数/run 行数不变）；产物幂等（finance 幂等键、plan 步 CAS）原样。
- **AC4**：turn 侧执行环境按目录现签作用域（revoked→THREAD_SCOPE_NOT_FOUND→任务 failed 诚实落地）；产物/预览/下载面零改动，保全证据=§1.3 workshop 51+19、openmuse-files 63/0（含 non-user 403、share 撤销、跨渠道 token 同形 404、preview-only 无下载、owner-scoped 读取）。
- **AC5**：超时 unit（run FAILED+lease 释放）；取消集成（安全边界落 cancelled+"Cancelled while running…"）；错误展示 sweep catch 原样落行；费用归属 run 行 modelRouteMaximumTokens===1024+受控 carrier 结算、payer=admission principal。缺依赖如实 unverified（§0 Workshop 行），未造假成功。

## 3. 文件清单（未提交增量）

新增：`server/src/mastra/openmuse-task-entry.ts`；`server/tests/mastra-openmuse-entry.test.ts`；`server/tests/enterprise/mastra-openmuse-entry.integration.test.ts`。
修改：`server/src/index.ts`（import + governed turn + 选择器）；`server/src/openmuse-tasks/store.ts`（既有缺陷修复 §5）；`tests/config/e2e-bun-suites.json`、`archive/verification/e2e-file-audit.json`（再生）；ledger.md。

## 4. Intelligence 残差登记

| # | 残差 | 性质/依据 |
| --- | --- | --- |
| R1 | groupConversations legacy turn 未迁移 | **结构性阻塞**：group bot 线程（group_bot_threads.threadId）无 enterprise_conversations 行亦无 mapping 行，resolveForThread 与 conversations.append 必拒——受控 turn 无法对 group 线程签作用域/写消息。迁移需"group bot 线程登记为企业会话/资源"的 tenancy 产品决策 → ME14/ME16 |
| R2 | Workshop run_workshop_turn | 今日无生产挂载；执行器为 sandbox 网关流（边界外）。未来挂载时应走受控 turn 组装 |
| R3 | proactive engine | 维持 ME10 §4：非 spec §8 枚举项 |
| R4 | agents/wake-up.ts:297 同型 jsonb 缺陷（未修，非本票面） | `workItems.payload || ${JSON.stringify({outcome})}::jsonb`——payload 为对象时 PG 抛 invalid concatenation，唤醒结算写结果失败。建议 ME14 前一行修复 |
| R5 | version-catalog.ts:184、model-route-catalog.ts:349 | 同型绑定：双重编码为标量串但读路径对称解析，功能未坏；登记待收口 |
| R6 | ME11 F1 清理候选（hopNotAdvanceable 终态化） | 交接域策略，转 ME14 |

## 5. 实施期发现的既有缺陷（已修复）

`openmuse-tasks/store.ts` 12 处 `${JSON.stringify(x)}::jsonb`（修正于 fix-round-1：原计 13 处含 store.ts:1266 的解释性注释本身——第 13 个 grep 命中非修复点） 在 Bun SQL 下双重编码——真实 PG 上每次结算的 steps/evidence/artifactIds 均被写成单字符串元素（集成首跑暴露：evidence `["[{...}]"]`）；既有单测走内存假库掩盖至今。修复：12 处统一 `::text::jsonb`（gateway/price-snapshot.ts:567 仓库先例；driver 探针验证）+ store.ts:1266 缘由注释。同型残差见 R4/R5。

## 6. 边界与如实披露 / UNVERIFIED

- 有意契约：OpenMuseTaskTurn 无 runId，受控意图每次尝试 manual-<uuid>；队列重投递去重权威保持任务行 attempts/status CAS（T06×T07），不新增第二套幂等（按 item.key 锁意图反而打破 T07 恢复）。
- 声明差异：受控臂无逐字流式进度（onText）——OpenMuse Task 路径本就未用（零回归）；group 因 R1 未迁移不受影响。
- 企业部署需任务频道已登记 enterprise resource+read grant，否则目录拒绝（fail-closed，与 ME10 wake-up 同合同）；集成以企业会话线程替代渠道（channel seam 即注入点，测试注释已声明）。
- 未改动 OpenMuse 子模块、Craft、Workshop 执行器；未改调度/疲劳/计费。
- UNVERIFIED：真实时钟/cron-worker 链端到端；真实 provider 拨号（stub SSE harness 形态）；openbot_enterprise_* 企业命名库全量；multitenancy 分区（config 排除+既有 collect 错）；独立评审与 OCR（流程后置）。

## 7. 修正记录（fix-round-1，2026-10-23 独立评审；控制器应用）

评审判定 APPROVED_WITH_FINDINGS（5/5 AC MET；R1 结构性主张与 jsonb 修复均经独立复核为真）。必修一项（P3 报告级）：§5 与 ledger 的修复计数 13→12 更正（第 13 个 `::text::jsonb` grep 命中是 store.ts:1266 的注释本身）。另按评审 INFO 建议补记两条披露：(a) 受控任务 turn 若在审批/问询等待处停车，Task 行仍以 FAILED + 等待文案结算（legacy 同样失败该行——无回归；恢复结果落在 owner 线程不回任务行）；(b) 集成的"撤销"用例为从未入职（THREAD_SCOPE_NOT_FOUND 同一拒绝缝；active-then-suspended 分支未单独驱动，与 ME11 的 membership 级联裁同理）；(c) T07 恢复代际铸造新 run 行（新代际即新 run，按设计；已结算行去重保证不受影响）。
