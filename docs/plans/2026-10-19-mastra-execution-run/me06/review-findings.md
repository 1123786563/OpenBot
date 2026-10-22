# ME06 (#478) Independent Review Findings

- Reviewer role: independent, read-only reviewer (did not write this code; findings returned as text, persisted verbatim-by-controller 2026-10-20)
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec` (uncommitted tree, branch `1123786563/mastra-exec`, BASE `bf64d0f2`)
- Inputs: me06.md ticket, design spec §4/§5/§8, brief.md, report.md, ADR 0006/0010, direct code reads
- Controller runtime evidence: 164 pass / 0 fail / 0 skip / 786 expects (15 files); typecheck 3 baseline; biome server/src/mastra clean

## S1. Per-AC verdicts

| AC | Verdict | Summary |
|---|---|---|
| AC1 scope 解析/禁全局 Bot ID | **PARTIAL** | Contract delivered & correct (`computer-scope.ts:60 scopedComputerEnvironmentKey`, `:80-105 scopedComputerGateway` 拒 raw botId/外来地址, `:128-153 createMastraComputerTools`; 4 条测试)。但 `createMastraComputerTools`/`scopedComputerGateway` 在 `server/src` **零调用方**（仅测试消费）——Mastra 路径未挂载任何服务端 computer 工具。报告 AC1 "PASS" 与 "MASTRA 路径装配一律经 computer-scope.ts" 表述过度。 |
| AC2 服务端受控/浏览器不伪造 | **MET** | ME04 包装（execution.ts:245-250）+ 惰性桥（execution.ts:255-257、frontend-tools.ts:68-153：挂起 :129-140、resumeData 原样回 :114-119、非引擎运行 fail-closed :122-127、恶意引擎兜底返回非结果哨兵 :144-148）。测试：真引擎挂起/1 轮拨号/O11、fact 保存、碰撞让位、SSE 端到端。注：服务端 computer 工具缺失见 F1。 |
| AC3 无人值守挂起/可查看/参与完成/stop 撤权阻断 | **PARTIAL** | 挂起持久化+可见性+门禁为真（save-before-end execution.ts:390-465；frontend drive resume-driver.ts:241-254 + F1 围栏；list/get 路由；生产门 index.ts:2974-2998；跨进程真子进程证明 + already_applied + stop/撤权双闸）。**生产缺口（已披露）**：生产装配下完成参与被拒——index.ts:3000-3008 loopFor 抛 MASTRA_RESUME_LOOP_MODEL_UNWIRED（fail-closed、claim 留待过期、无预算绕过），且 F2 的 grant 门会先拒；无 UI 消费参与路由（报告 UNVERIFIED 1）。AC3 "参与后恢复" 在 fixture loop 面证明，不在生产装配。 |
| AC4 operationId/toolCallId/argsDigest 关联；重复回包一次 | **MET** | operationId=continuationOperationId(executionKey,toolCallId,argsDigest)（store 侧断言）；回包幂等 id=canonical JSON sha256（continuation-routes.ts:45-60）→ 同回包同 decisionId → already_applied；不同回包→409。测试含 SQL 断言 receipt 恰 1 行 executed、过期 claim 走 receipt 证据。 |
| AC5 gallery/activity 语义保持；刷新不丢 | **MET**（服务端可观察；浏览器画面已披露 unverified） | openGenerativeUI 通道零 diff；TOOL_CALL_ARGS 帧同形断言；waiting 为 DB 行，list/get 刷新可读（跨 scope 404）；0164 预留索引消费。见 M3（list 范围不对称）/M4（挂起前部分文本未持久化）。 |
| AC6 审批/host-access 保持；撤权/过期/跨范围拒绝 | **MET** | approvals/**、host-access/**、computer/** 零 diff（git diff --stat 空）。撤权→MASTRA_CONTINUATION_GRANT_REVOKED、过期→receipt 证据、跨 scope→404、scope 视图拒外来地址。注：computer 专属凭据撤权在本路径不可触发（无 computer 工具挂载，F1）；所测为 continuation 层等价闸。 |

## S2. Constraint checks

服务端从不执行/伪造浏览器工具 PASS；挂起先存后可见 PASS（保存失败→SAVE_FAILED RUN_ERROR）；重复回包恰一次 PASS；stop 后阻断 PASS（generation 门=runs.getActiveAttemptGeneration，注意组合回调本身未测）；撤权拒绝 PASS（编排层；生产组合见 F2）；过期 claim 走 receipt PASS；scope 寻址 PASS（空洞成立：无 computer 装配）；gallery 语义/approvals/computer 引擎零改动 PASS（app/src 零改动属实）。

## S3. Code-quality findings

- **F1 [Important]** `createMastraComputerTools`/`scopedComputerGateway` 无生产调用方；headless computer 通道仅在 legacy 引擎（index.ts:2824,3071,3236、copilot.ts:3750、routines/run-turn.ts:492）。与票边界及 UNVERIFIED 2 一致，但报告须更正（AC1→PARTIAL）+ ME09/ME10 显式 carry-forward 门。
- **F2 [Important]** 生产 `toolGrantCurrent`（index.ts:2974-2983）= "toolName ∈ plugin grantedTools"；frontend_tool 的 toolName 是浏览器声明名，永远不可能是插件 grant → 生产 frontend resume 一律 GRANT_REVOKED（即使 ME09/ME10 接上 loopFor）。fail-closed 无绕过、当前被未接线掩盖，但把 AC3 生产故事从"一个具名缺口"变成"两个"。须改为 kind-aware 或显式挂到 ME09/ME10 入场条件。
- **F3 [Important]** MASTRA_RESUME_LOOP_MODEL_UNWIRED 边界真 fail-closed（loopFor 闭包抛、在 receiptSink.started() 之前、无替代拨号路径）；推迟 ME09/ME10 与 ADR 0010/spec §5 一致。AC3 因此 PARTIAL。另：该 refusal 不在 statusForRefusal（continuation-routes.ts:63-87）→ 参与者见 500；409/503 更诚实。
- **F4 [Minor]** POST 身份链 solid（requireUser + scopes.resolve 服务端派生；loadRow 四列匹配；resume 复核）。但 `listContinuations` 只按 tenant+workspace 过滤（continuation-store.ts:656-671）→ workspace 列表暴露同事的 waiting 挂起元数据（不可操作）。收紧或明示同事可见为产品行为。
- **F5 [Minor]** granted 碰撞让位方向安全（granted 永不被 shadow，frontend-tools.ts:81，有测试）；静默丢弃（无效/保留名/重复客户端声明同样静默 :76-85）建议加诊断行。
- **F6 [Minor]** 快照/密钥卫生干净：storageForBinding 拒无 threadId 绑定；snapshotRef 不透明；publicRecord 排除 claim_token_hash；store secret=部署 keyEncryptionKey；requireSegment 不回显输入。
- **F7 [Minor]** app.ts 混入 biome organize-imports 全文件重排（真实改动仅 ~12 行挂载）；建议隔离或注明。

## S4. Test hygiene

- 报告 §2 全部具名测试存在（unit 11 + integration 5 = 16）。
- **发现一个 tautology**：`approval_pause_still_saves_an_approval_fact_alongside_frontend_tools`（mastra-computer-tools.test.ts:344-363）`void request;` + 断言空数组 `toHaveLength(0)`；approval 分支的 suspensionKindOf 派发无真实覆盖。须票内修。
- 集成测试为真：新 OS 进程（pid 断言）、真一次性受限角色 DB、真锁定引擎 + PostgresStore、生产六门 + 生产 driver；child 从 fixture stack 重建 loop，不从 continuation 载荷。
- R2-10 验证通过；清单再生成入册；O11 真引擎断言在位。

## S5. Cannot-verify / UNVERIFIED 评估

真浏览器 E2E 与客户端回调接线是**真缺口**（app/ 无任何 /api/mastra-continuations/:id/tool-result 调用方；legacy 引擎带内回灌）——应记为 ME16 的具名依赖，不宜埋在 UNVERIFIED。物理 per-scope computer 供给出界正确。生产 resumed-loop 拨号已披露 fail-closed。stop 门组合回调未测（runs 服务探针本身为既有代码，已读其查询）。绿波/typecheck/biome 计数取自控制器复核。

---

**VERDICT: APPROVED_WITH_FINDINGS**

Required（门 ME06 关闭 / ME08 派发）：
1. 报告更正：AC1→PARTIAL（scoped computer 装配 delivered-but-unwired）、AC3→PARTIAL（生产参与完成被设计性拒绝：MODEL_UNWIRED + F2 grant 门；浏览器回调接线未闭合）。
2. F2 记为 ME09/ME10 显式入场条件（与 loopFor 接线并列）。
3. 替换 tautology 测试为真实 approval-kind 派发断言。
4. MASTRA_RESUME_LOOP_MODEL_UNWIRED（及 MASTRA_CONTINUATIONS_UNWIRED）加入 statusForRefusal 非 500。

Non-blocking：F4（收紧或文档化）、F5（诊断行）、F7（注明）、组合 generation 回调未测（→ME09/ME10 生产 headless 测试）。
