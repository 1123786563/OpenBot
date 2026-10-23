# ME16 Report — 退出旧内置执行路径并完成全入口交付验收 (#488)

> 控制器注：本报告由 ME16 实现 Agent 以文本返回，控制器于 2026-10-23 原文落盘（该 Agent 对此路径无写权限）。控制器独立复核：34 文件波 402 pass / 0 fail（全绿；与实现 Agent 的 35 文件 399/0/1853 口径差异为清单差，两侧均全绿）。

- Date: 2026-10-23。Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec2-2`，分支 `1123786563/mastra-exec2-2`，HEAD `46b4180ed3`；无 commit/push/stash；本票增量叠加在 ME11–ME15 未提交树之上（§5 清单，哈希已落盘 `docs/plans/2026-10-19-mastra-execution-run/me16/snapshot/sha256.txt`）。

## 0. 交付概要

1. **Chat 入口引擎接线（旧路径退出的最后一块）**：`index.ts` 企业装配安装 `setMastraConversationRuntime(createMastraConversationRuntime({conversations, storage, authorizeAttachment}))`（ME03 合同）与 `setBuiltinExecutionEngine(() => "mastra")`（index.ts:3507-3530）。selector 只在 governed admission（企业 Runner 签发的 governedModel）内被询问（copilot.ts:2649），路由的恰是 governed chat 运行，客户端字段无法选引擎；无企业能力时 selector 永不被询问。同时删除 seam 草案中零生产者/零消费者的 `"legacy"` 成员（`BuiltinExecutionEngine = "mastra"`）。
2. **ME06 浏览器参与回调**：新模块 `app/src/lib/copilot/mastra-participation.ts`（查等待列表 → kind=frontend_tool 且 toolCallId 匹配 → POST tool-result；404=无路由 legacy 装配一次即止、409=已应答收敛、其余具名抛出）+ 接线进 `useFrontendTool`（approval-tools.tsx，`{waiting:true}` 审批哨兵跳过）+ `/api/mastra-continuations` 入 `SCOPE_HEADER_ALLOWED_PATHS`（ownerTicket ME16，过 MT081 AC4 对账测试）+ app 级 3 案测试。
3. **携带修复（全部 RED→GREEN）**：ME14 F3（rolled_back 具名拒绝 `CUTOVER_ALREADY_ROLLED_BACK`）、F2（部分切换 → `goMaintenance("rollback-unsafe: PARTIAL switch — N of M …")` 维护出口）、F4（receipt 删除谎称 memory 行数的 `newMemoryRows`）、F5（copilot.ts 双写注释去重）；ME15 INFO（channel-summaries 无 Intelligence 整 pass 跳过，不再每 10s 铸同一拒绝）。
4. **最终入口审计 + 登记项**（§1、§3）。

## 1. 最终入口审计

### 1.1 迁移入口 × 实际装配（企业能力在场）

| 入口 | 装配点（本树行号） | 企业能力下实际执行 | legacy 臂与可达性 |
| --- | --- | --- | --- |
| chat-entry（web SSE） | copilot.ts:2649 selector 询问点；index.ts:3527 安装 `()=>"mastra"`；index.ts:3517 会话运行时 | `mastraAgentConfiguration`（copilot.ts:2372）：服务端重建历史、durable 挂起、governed 恢复、预算结算 | legacy BuiltInAgent 仅在无 governedModel（无企业 Runner admission）时构造；企业 chat 零 legacy |
| routine-firing | index.ts:3902 `governedRoutineTurn ?? legacyRoutineTurn` | governedRoutineTurn（3868） | legacy 仅非企业 |
| responsibility-advance | index.ts:4247 `if (governedResponsibilityTurn)` | governed（3955）；legacy-parked continuation 具名拒绝 | legacy 仅非企业 |
| message-delivery | index.ts:5007 `governedDeliveryTurn ?? approvalContinuationRunner` | governed（4032） | legacy 仅非企业 |
| wake-up | index.ts:5144 `governedWakeUpTurn ?? legacy` | governed（4067） | legacy 仅非企业 |
| approval-continuation | index.ts:4767 `if (governedApprovalContinuationDrive)` | 六门编排器 drive | legacy `approvalContinuationRunner`（4496）只接 legacy snapshot：非企业、切换前遗留 parked（处置归 ME14 账本）、R1 group、proactive、sign-in 残留（§1.3） |
| openmuse-task | index.ts:5332 `governedOpenMuseTaskTurn ?? legacy` | governed（5292） | legacy 仅非企业 |
| handoff-delivery | index.ts:5676 `governedHandoffDelivery ?? IIFE` | governed（5597/5626） | legacy IIFE 仅 governed 缺席时求值；无 Intelligence boot `??` 短路零求值；reaper 无 selector（不跑 turn） |
| legacy-history-reader | ME13 CLI | 只读（cutover.ts `READER_ONLY_ENTRY_IDS` 强制） | 非执行入口 |

**结论**：企业能力下 migration-scope 九入口每次真实 turn 都经 governed/Mastra；`BuiltInAgent`/legacy turn runner 活跃消费者仅剩 §1.2 所列臂 + §1.3 具名例外。

### 1.2 保留 legacy 臂（逐项理由）

| 臂 | 理由 |
| --- | --- |
| 非企业 fallback（全部 selector 反侧） | governed 结构性要求企业三库 + Runner；boot 门保证两引擎皆无不静默起服 |
| R1 group 线程（index.ts:5386/5401） | group bot 线程无 enterprise tenancy 行，resolveForThread/append 必拒；前置 = tenancy 产品决策（**只登记，裁决权在用户**） |
| proactive（5060/5065） | Spec §8 入口清单外（ME10 §4 残差表）；无 Intelligence 首跑具名 `INTELLIGENCE_UNCONFIGURED` 拒绝 |
| channel summaries（5853 + titler） | Intelligence 历史读面非执行路径；本票起无 Intelligence 整 pass 跳过 |
| 三处 getThreadMessages 读（1848/1858、5853、8370） | 读而非执行、不产生 turn、不写历史（ME10 登记面，本票核实保留） |
| 旧平台 handoff IIFE | 仅非企业可达；企业零构造 |
| CopilotKit React/SSE SDK | Spec Out of Scope 明文排除移除 |
| 独立 harness（agent-mastra 子模块、me0x fixture 族、learning/legacy 邻家） | Spec 允许保留 |
| ME15 双形 `delivery` thunk 分支 | 已披露的加法 affordance 非旧执行路径 |

### 1.3 审计新发现残留（登记 + 升级，未擅修）

**sign-in 等待恢复走 legacy runner**：governed headless surface 挂 `computer_request_sign_in`（index.ts:3678）；该 wait 抛 `HeadlessToolSuspension(kind="computer_sign_in")`，governed 包装只翻译 `kind==="approval"`（mastra/tools.ts:298-311），其余按 ME10 已批准合同 fail-closed（`MASTRA_TOOL_SUSPENSION_UNSUPPORTED`）。但 sign-in request 已带 governed snapshot 落库（`state:{engine:"mastra"}`，tools.ts:257）；人解决后 `createSignInResumer.onResolved → continueTurn → approvalContinuationRunner`（legacy Intelligence runner，index.ts:2030）。sign-in 恢复路径不读 `state.engine` 分流（修正于终审：该标记在 approvals 决策路径确有读取方——index.ts:4537 governedApprovalContinuationDrive 与 continuation-store.ts:262——但 sign-in 的 onResolved→continueTurn 链路从不咨询它）。即企业部署下 Bot 发起 sign-in 等待且人解决时：governed run 按合同具名失败 + 恢复走 legacy turn——§1.1 零活跃消费者的具名条件例外。修复面 = 新 durable kind + onResolved 分流，超最小改动边界，按 R1 先例登记升级交控制器裁决。chat 面 sign-in 走浏览器前端工具，由本票参与接线应答，不经此残留。

## 2. A01–A20 矩阵（同版本证据指针；全部套件本树复跑绿）

| 编号 | 结果 | 证据 |
| --- | --- | --- |
| A01 | VERIFIED | me01 + `mastra-agent-resume-process`（独立进程）随波 |
| A02 | VERIFIED | me02 + me14 引擎接线 5/0；本票 selector 生产安装 + browser-runner 9/0 |
| A03 | VERIFIED | me02/me04 + governed-execution 随波 |
| A04 | VERIFIED | me03 + conversation-runtime.integration 随波 |
| A05 | VERIFIED | me04 + mastra-tools/governed-tools 随波 |
| A06 | VERIFIED | me05 + mastra-continuations(.integration) 随波 |
| A07 | VERIFIED | me06 双进程集成随波 + 本票 app 级参与链 3 案；真浏览器半边 UNVERIFIED |
| A08 | VERIFIED | me07 + personal-memory/memory-context.integration 随波；#395 合同经 ME07 消费 |
| A09 | VERIFIED | me08 + me15 懒构造 + learned-skills/learning-mastra 随波 |
| A10 | VERIFIED | me09 + routines.integration/headless 随波；真实 cron 容器 UNVERIFIED |
| A11 | VERIFIED | me10 + entries(.integration) 随波；sign-in 例外 §1.3 |
| A12 | VERIFIED | me11 + handoff 双套件 + agent-handoff-runner 26/0 |
| A13 | VERIFIED | me12 + openmuse-entry 双套件；真 OpenMuse 主仓联调 UNVERIFIED |
| A14 | VERIFIED | me13 + import.integration/legacy-import 随波 |
| A15 | VERIFIED | me14 + cutover.integration 15/0 + 本票 F2/F3/F4（43/0）；生产 apply 未执行（越权） |
| A16 | VERIFIED | me15 + no-intelligence-boot 3/0（真实子进程含本票新接线行） |
| A17 | VERIFIED | me02–me12/me15 各 AC + 波内；真实供应商 dial UNVERIFIED |
| A18 | VERIFIED | me05 双进程 CAS/租约 + me14 双实例切换/回滚 + me09–me12 越权拒绝；企业命名库复跑 UNVERIFIED |
| A19 | VERIFIED | me02/03/05/06 客户端证据 + 本票 compat 8/0（含参与 3 案）；浏览器内 UNVERIFIED 半边 |
| A20 | VERIFIED（本报告） | §1 审计 + snapshot 哈希；最终 OCR 归控制器（用户裁决仅最终提交前一次） |

## 3. 携带项处置

ME06 参与回调 = 已交付；ME14 F2/F3/F4/F5 = 已修（RED→GREEN）；ME15 INFO = 已修；ME12 R1 = 只登记；ME07 finding 3 = 跳过（非平凡，登记为后续候选）；conformance-evidence 指纹 = 不重录（产品决策）。

## 4. 命令与真实结果

- `bun test server/tests/mastra-cutover-switch.test.ts`：RED 40/3 → **GREEN 43/0/130 expect()**（×2）。
- `bun test app/tests/mastra-runtime-compat.test.tsx`：**8 pass / 0 fail**。
- **35 文件 mastra 波**：**399 pass / 0 fail / 1853 expect()**（396 基线 + 3 新案；×2；控制器 34 文件复跑 402/0 全绿）。
- 独立 integration 复跑：cutover **15/0**、no-intelligence-boot **3/0**、engine-wiring **5/0**、learning-agent.integration **3/0**。
- 邻家（e2e runner）：config+learning-runtime **172/0**、routine-run-turn+headless-tools+proactive+delivery-turn+learning-config **53/0**、copilot+learning-handoff+passwords-sign-in **108/0**、agent-handoff-runner **26/0**。
- 门禁：tsc 恰 **3 条基线**；biome mastra 目录 + cutover CLI **29 files clean**，本票全部触达文件 clean（index.ts 与 HEAD 同 6 条、copilot.ts 与 HEAD 同 10 条）；基线红核定 self-host-banner 1/22 复现（ME15 已证非增量）。
- 清单：零新增测试文件；audit ledger **byte-identical（diff 0）**，bun manifest **零漂移**（621 driven / 39 groups）。

## 5. 文件清单（本票增量，全部未提交）

新增：`app/src/lib/copilot/mastra-participation.ts`、`docs/plans/2026-10-19-mastra-execution-run/me16/snapshot/{sha256.txt,README.md}`（+ 本报告）。
修改：`server/src/index.ts`（chat 接线 + summaries guard）、`server/src/copilot.ts`（F5 + "legacy" 成员删除）、`server/src/mastra/cutover.ts`（F2/F3/F4）、`server/tests/mastra-cutover-switch.test.ts`（+3 案）、`app/src/lib/copilot/approval-tools.tsx`、`app/src/lib/client.ts`、`app/tests/mastra-runtime-compat.test.tsx`（+3 案 + fixture）、ledger。
ME11–ME15 未提交增量零触碰，随波全绿。

## 6. UNVERIFIED

1. 真实 Chrome 端到端（两半链路均已证，整链未跑）。
2. 参与应答的中途刷新（handler 死亡 → 挂起行留等待列表，可由其他设备应答；自动重挂属后续）。
3. 真实 cron/worker 容器独立触发与无 Intelligence 独立 boot（与 ME15 同口径推断登记）。
4. 真实供应商 dial（全 fixture 证据）。
5. 企业命名库复跑（证据全在授权一次性 fixture 库，teardown DROP）。
6. 生产 apply/切换/停机/发布（越权未执行）。
7. 独立 Review 与最终范围 OCR（归控制器，仅最终提交前一次）。

## 7. 偏差与边界

- §1.3 sign-in 残留为新发现，登记升级而非现场修。
- `"legacy"` 成员删除是 seam 形状收窄（全仓 grep 零生产者/消费者）；如控制器认为 seam 自文档价值更大可一行回退。
- F4 选删字段而非补真实 memory 行计数（计数需新端口 + 集成证据，超"small"；receipt 只报能证明的 intents）。
- 无生产 apply/发布；无 commit/push/stash；无新建容器、无共享 project 操作。

## 9. 终审修正记录（2026-10-23 独立终审；控制器应用）

终审判定 APPROVED_WITH_FINDINGS（6/6 AC MET；终审独立复跑 12+ 套件全绿；快照 10/10 哈希复算吻合）。必修一项（文档级）：§1.3 "生产码无一处读 state.engine" 表述过度——已更正为"sign-in 恢复路径不读该标记"（标记的读取方存在于 approvals 决策路径，与该残留无冲突；残留本体与升级裁决经终审确认成立）。次要从宽记录：F5 追溯性弱（映射到 seam 注释重写）；两处证据行号 ±12 漂移；legacy 引擎参与路由重试延迟（Info）；快照未含 ledger.md（Info）。
