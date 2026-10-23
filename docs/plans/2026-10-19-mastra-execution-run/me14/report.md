# ME14 Report — 处置在途运行并完成单写切换与无数据损失回滚演练 (#486)

> 控制器注：本报告由 ME14 实现 Agent 以文本返回，控制器于 2026-10-23 原文落盘（该 Agent 对此路径无写权限）。控制器独立复核：32 文件波 376 pass / 0 fail（全绿）；`git stash list` 为空（其披露的瞬时 stash push+pop 已验证恢复）。

- Date: 2026-10-23. Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec2-2`, branch `1123786563/mastra-exec2-2`, HEAD `46b4180ed3`（无 commit/push；ME11+ME12 未提交增量原样保留，本票增量叠加其上）。
- Ticket: `docs/tickets/mastra-agent-execution/issues/me14.md`（7 条 AC）；Spec §9；Runbook: `me14/runbook.md`。

## 0. 交付概要

ME13 留下的 CUTOVER 机制在 `server/src/mastra/cutover.ts` 落地，CLI 增加第六个子命令 `cutover`，`rollback` 对 switched 状态路由到 fence 回滚：

- **写入 fence（事实层）**：`enterprise_conversations.storage_backend` + `backend_version` 是写者代际——prepare 按版本预留 seq、write 事务复核版本（既有），finalize UPDATE 新增子查询对照行的当前版本（`conversations/service.ts`，ME14 强化）。切换 = 逐线程在与 prepare/write 同一条 per-conversation advisory lock 下对版本条件 +1（CAS），切换与所有写者全序化于数据库。旧写者三类拒绝（真库实证）：非 mastra 后端 → backend 路由拒绝；旧代际 append → `CONVERSATION_BACKEND_CHANGED`（intent 留 pending、零覆盖）；过期 lease → runs lease 谓词拒绝。
- **fence 记录（AC3）**：run state 内 `fence` 字段逐线程记录 from/to 版本、引擎 `mastra` + `engineVersion = mastraEngineFingerprint()`（pinned 包摘要）、`compatibleRollbackVersion`（缺省 null = 无兼容版本可回）、`excludedThreadIds`；rollback/维护事实追加进同一记录，从不改写历史条目。客户端不能选引擎：selector 为服务端 seam。
- **切换编排 `runCutover`**：门评估（AC1）→ 逐线程 bump（逐线程持久化）→ 全部完成 phase=switched。任一阻塞点停止于该点，已完成部分如实记录，修复后重跑续切。
- **门（AC1）**：`evaluateCutoverGates` 五门并列失败输出——entry-inventory（八项运行入口结构化核对：缺项/未知 id/reader 项非只读/legacy-kept 无 note 全部点名）、imports-verified（`stagingStatusOf === "verified"`）、admission-paused、drained（零 queued/running）、in-flight-dispositioned。
- **在途处置账本（AC2）**：`classifyInFlight`——active 不可处置（排空，drain_required 点名）；convert-pause 要求 mastra continuation + 显式已知外部效果（unknown 必须改 isolate）；legacy-drain 活着即 not_drained 拒绝、排空后收档只读；isolate/re-initiate 按 id 移出切换集；未知 id 处置失败（typo 防护，仅 legacy-drain 保留收档语义）。跨进程转换演练：integration 双实例切换前存 continuation、切换后另一实例 CAS claim→finish。
- **回滚/维护（AC5/AC6）**：`runCutoverRollback` 零删除、零指回旧库——保全证据 = 切换前后清单计数对账 + memory 行数 + receipt 引用写进 `fence.rollback`；回滚 = 写者代际再 +1（同一锁纪律）。不可证安全（scope 内活跃 run / 未登记兼容版本 / 版本漂移 / 清单变化）→ `phase=maintenance` + `fence.maintenance.reason`；maintenance 是工具终态。
- **CLI**：`cutover` 在 ME13 apply 双门（`--authorize-fixture` ∧ `MASTRA_CUTOVER_FIXTURE_APPLY`）之下，另要求 `--tenant/--workspace`、`--entry-inventory`、`--dispositions`；`--compatible-rollback-version`、`--pause-admission` 可选；run-id 路径硬化（F3）。
- **携带修复（全部 RED→GREEN）**：ME13 F1（pending 外来 intent 阻断 staging，新端口+真库案）、F2（resume 重跑 classifyThread）、F3（runId 路径硬化）；ME11 F1（HANDOFF_HOP_NOT_ADVANCEABLE 终态化，native runner 26/26）；ME12 R4（wake-up `::text::jsonb`，真库 RED）；ME07 F1（PersonalMemoryMiddleware 跳过 mastra-selected，双向 pin）；ME12 R1（groupConversations tenancy 决策点登记于 runbook §2，只登记不迁移）。conformance-evidence 指纹确认纯 main 侧 stale → 登记不重录（需重跑 Bifrost 22.3/22.4 验证 = 产品决策）。

## 1. 命令与真实结果

### 1.1 RED（TDD 先证伪）
- `bun test server/tests/mastra-cutover-switch.test.ts` → `Export named 'CUTOVER_ENTRY_IDS' not found`（0 pass / 1 fail）。
- 携带项逐个 RED：R4 针（还原 `::jsonb` → 真库 settle 失败）；ME11 F1 针（还原 runner 条件 → native runner 1 failed | 25 passed）；ME07 F1 针（还原 copilot 条件 → 7 pass / 1 fail）。

### 1.2 GREEN — 本票套件（各复跑 2-3 轮同计数）
- `bun test server/tests/mastra-cutover-switch.test.ts` → **35 pass / 0 fail / 97 expect()**
- `ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=… bun test server/tests/enterprise/mastra-cutover.integration.test.ts` → **15 pass / 0 fail / 64 expect()**

### 1.3 合并波（ME12 波 31 文件 + 本票 2 件 = 33 文件）
→ **376 pass / 0 fail / 1767 expect()**（两轮同计数；实现 Agent 口径；控制器 32 文件复跑 376/0/1759 全绿）。mastra-storage.integration 仍为主侧既有环境红，不在波内。

### 1.4 Typecheck / Biome / 清单
- typecheck 恰 **3 条基线**（bootstrap-local-gateway.ts），本票 0 新增。
- biome 全触达文件 clean；copilot.ts 与 HEAD 同集合 10 条（新增行 0 告警）。
- add-driven ×2 → **619 driven / 39 groups**；audit 再生 → bun manifest 再生 619/39（integration → part 6，unit → part 9）。

### 1.5 Driven 组核查（ADR 0008）
- part 9：junit 309 案 308 pass / 1 fail——fail = memory-sensitivity GRANT_TOOL_NAME_INVALID（主侧既有）；本票文件 0 失败。
- part 6：junit 197 案 8 fail——全为官方企业环境族邻居（ME13 §1.5 登记的同一 red-alone 族）；本票 mastra-cutover.integration 组内 junit 15/0、独跑 ×3 全绿。
- native：agent-handoff-runner 经 e2e 临时 audit 配方 **26 passed**（本票 +1 案）。

## 2. AC 逐条证据

- **AC1**：五门并列失败点名（单测）；真库首切未排空/未处置 → CUTOVER_GATES_FAILED 且零线程 bump、fence 缺席；入口清单结构核对含 reader 只读强制与 legacy-kept 强制 note；staging 非 verified → CUTOVER_REQUIRES_VERIFIED（真库）。
- **AC2**：账本分类七案（单测）+ 真库混合 fixture（running 拒绝 → 排空后逐项处置通过）；已终结 → 只读；兼容暂停跨实例转换（双连接池 claim→finish，切换后）；isolate 按 id 移出（真库 thread-iso 版本不动）；CUTOVER_SWITCH_BLOCKED 停于首个阻塞点。
- **AC3**：fence 逐线程 from/to + 引擎指纹（单测+真库）；verify 前拒切（真库）；二次切换拒绝 CUTOVER_ALREADY_SWITCHED；中断续切不重复 bump（单测+真库 main1 恰一次 1→2）；selector 服务端独占。
- **AC4**：pre-switch append → CONVERSATION_BACKEND_CHANGED、intent 留 pending、memory 行数不变；finalize SQL 探针（旧代际 0 行/当前代际 1 行）；hasActiveAttemptLease 过期 false/活 true；切换后新写者正常落库 + history 读回。
- **AC5**：切换后新消息/continuation 在回滚后逐项存活（行数、intents、history、receiptRefs 含 post-switch key）；代际 2→3 切换、3→4 回滚；backend 全程 mastra（不指回旧库）；无兼容版本 → 不回。
- **AC6**：活跃 run → maintenance + reason 点名（零 bump、无 receipt）；无兼容版本 → maintenance；版本漂移 → maintenance；maintenance 拒绝再 rollback。
- **AC7**：双门扩展到 cutover 与 switched-rollback；全部演练在 openbot-test-pg 一次性库（teardown DROP）；runbook = me14/runbook.md（责任人/恢复门槛、入口清单+决策点登记、命令序列、处置表、回滚/维护、边界）。

## 3. 文件清单（本票增量，全部未提交）

新增：`server/tests/mastra-cutover-switch.test.ts`、`server/tests/enterprise/mastra-cutover.integration.test.ts`、`docs/plans/2026-10-19-mastra-execution-run/me14/{runbook.md,report.md}`。
修改：`server/src/mastra/cutover.ts`（fence 核心+CLI 契约+F3）、`server/src/mastra/legacy-import.ts`（F1/F2/fence phase/具名拒绝）、`server/src/enterprise/conversations/service.ts`（finalize 子查询 fence +10）、`server/scripts/mastra-agent-cutover.ts`（cutover 子命令+rollback 路由）、`server/src/agents/wake-up.ts`（R4 一行）、`server/src/agents/handoff-runner.ts`（ME11 F1 终态化）、`server/src/copilot.ts`（ME07 F1 跳过条件）、`server/tests/mastra-legacy-import.test.ts`（+6 行 fixture）、`server/tests/mastra-personal-memory.test.ts`（+2 案）、`server/tests/agent-handoff-runner.test.ts`（+1 案）、manifest、ledger。ME11/ME12 增量零触碰、随波全绿。

## 4. 偏差与边界

- 切换粒度 = run 的 verified 导入线程集（fence 按 run 逐线程）；全租户一次性切换属 ME16 编排决策。
- 跨进程 vs 跨实例：演练为双实例（双连接池）；真子进程级续跑由 ME05 既有套件覆盖。
- conformance-evidence 指纹未重录（纯 main 侧 stale；重录=产品决策）→ runbook §2 登记。
- admission pause = fence 记录 + runbook 门 + drain 检查强制；生产"停止新准入"是部署维护开关/selector 策略（ME16 收口）。
- runAgent 生命周期冲突（mastra-skip 针观察到）：mastra factory 自带 run 生命周期，经 AG-UI runAgent 包装时与外层 RUN_STARTED 冲突——生产 mastra 入口直驱 factory，chat 面 runAgent 接线属 ME16。

## 5. 修正记录（实施期真实行为差异）

1. classifyInFlight 初版把未知 id 的 isolate/convert 静默收档 → 改失败点名（typo 防护）。
2. 切换循环初版收集全部阻塞点继续切 → 改停止于首个阻塞点（真库捕获：fence 多记一个线程）。
3. rollback 初版改写 fence.threads 的 to 版本 → 改只追加 rollback receipt（单测捕获）。
4. integration 真实缺陷五处：subquery uuid/text 类型不匹配、探针 reserved_seq 撞唯一索引、探针污染 history 读路径、hasActiveAttemptLease 直调绕过 RLS（移入作用域事务）、me03 fixture continuation 表无 data 角色授权（改走应用句柄=生产同款）。

## 6. UNVERIFIED

- CLI 生产形态接线（真实远程 Intelligence + 部署 config）未跑（与 ME13 同边界）。
- 真实 fork/exec 子进程的切换期转换：演练为双实例；跨进程续跑证据在 ME05 既有套件。
- driven 组官方企业测试环境复跑：未配置，与 ME11/ME12 同口径。
- conformance-evidence 重录、groupConversations tenancy 决策、chat 面 runAgent 引擎接线（ME16）：登记为决策点/后续票面。

## 7. 边界确认

无生产 apply/切换/停机/发布；全部演练在授权一次性 fixture（teardown DROP）；无 commit/push（一次 copilot.ts 基线对比的瞬时 stash push+pop 已即时恢复并经控制器验证 stash 列表为空）；未删除任何新数据、未重放任何外部写操作。
