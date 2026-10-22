# ME06 Report — Computer 与前端工具在有人和无人值守场景中保持真实执行 (#478)

> 控制器注：本报告由 ME06 实现 Agent 以文本返回，控制器于 2026-10-20 原文落盘（该 Agent 对此路径无写权限）。

- Date: 2026-10-20
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`, branch `1123786563/mastra-exec`
- HEAD: `bf64d0f2772766a7c0cdbc3e9831c9024400e165`（无 commit/push/stash；ME01–ME06 共享同一棵未提交树）
- Ticket: `docs/tickets/mastra-agent-execution/issues/me06.md`（6 条 AC）；Brief: `docs/plans/2026-10-19-mastra-execution-run/me06/brief.md`

## 0. 交付概要

前端工具的**真实参与协议**在 Mastra 路径端到端打通：浏览器声明的工具挂载为**惰性桥**（服务端永不执行、永不伪造结果），模型调用触发引擎 `tool-call-suspended` 挂起 → 持久化 `frontend_tool` continuation（与 approval 同台账、同 receipt 规则）→ 客户端真实结果经 HTTP 参与入口按幂等决策回灌 → 生产 resume driver 驱动引擎从真实结果继续作答。computerGuidance 在 Mastra 路径打开（legacy 原文、legacy 位置）；learnedSkills 拒绝保留（ME08）。作用域解析、生产装配（真实 store + seam + 路由挂载）与 R2-10 fixture 去重全部落地。app/ 零改动。

## 1. 命令与真实结果（commands → exit code → 实际计数）

### 1.1 ME06 自己的套件（unit + integration）

```
ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-computer-tools.test.ts \
  server/tests/enterprise/mastra-frontend-tool-participation.integration.test.ts
→ exit 0；16 pass / 0 fail / 0 skip（107 expect() calls）
```

unit 11 条（bridge 挂载/挂起/回灌、O11 真引擎 execute-context 形状、granted 冲突让位、stream-events tool-call-suspended 归一、frontend_tool 挂起 kind 派发、AC1 作用域解析 4 条）；integration 5 条（跨进程参与完成、重复回包只计一次、stop/撤权失败注入、过期 claim 走 receipt 证据、参与路由 list/get/apply/重放/跨 scope）。

### 1.2 全量绿波（基线 13 文件 + 本票 2 新套件）

```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test \
  server/tests/mastra-computer-tools.test.ts \
  server/tests/enterprise/mastra-frontend-tool-participation.integration.test.ts \
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
→ exit 0；**164 pass / 0 fail / 0 skip**，15 files，786 expect() calls
```

基线（ME05 交付时 13 文件 146 pass）+ 本票 18 条 = 164。连跑 3 次复验：两次全绿、一次 1 条 5s 超时伪红（§5 已知噪声）。

### 1.3 波外邻家套件（fixture 重构波及面验证）

```
ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-agent-resume-process.test.ts \
  server/tests/mastra-tools.test.ts server/tests/mastra-governed-tools.test.ts
→ exit 0；18 pass / 0 fail（121 expect）
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=… bun test server/tests/mastra-engine-wiring.integration.test.ts
→ exit 0；5 pass / 0 fail（27 expect）
```

### 1.4 清单再生（本轮新增了测试文件 → 必跑）

```
node scripts/e2e-file-audit.mjs → exit 0
node scripts/e2e-bun-manifest.mjs → exit 0
470 kept on the Bun runtime, in 33 driven group(s)（469 → 470：新套件入册）
2 still ours to fix：app/tests/auth-client.test.ts（既有）+
  server/tests/multitenancy/bots-ownership.test.ts（提交态文件 06e3c9bc，本树零改动，
  COLLECTION_ERROR 为环境条件；bun test 下 50 skip / 0 fail，与本票无关）
新文件入册：mastra-frontend-tool-participation.integration.test.ts → driven group "server/tests part 4"；
mastra-computer-tools.test.ts → "server/tests part 6"。
```

### 1.5 受影响 driven 组（经 e2e 统一调度驱动 Bun 组）

```
E2E_UNIT_OUTPUT=.e2e-me06 E2E_BUN_ONLY="server/tests part 4" \
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts → 1 passed / 0 failed（exit 0）
E2E_BUN_ONLY="server/tests part 6"（同 env）→ 1 passed / 0 failed（exit 0）
```

（首轮 part 4 未带 TEST_DATABASE_URL 伪红：db-client-address.test.ts 的环境守卫，带 env 复跑即绿。）

### 1.6 Typecheck / Biome

```
bun run --cwd server typecheck → exit 0，恰好 3 条基线错误
  （scripts/bootstrap-local-gateway.ts:106/108/120，与本票零交集）
bunx biome check server/src/mastra → exit 0，clean
bunx biome check <本票全部新/改 test 与 support 文件> → exit 0，clean
```

说明：`bunx biome check server/src/{copilot,app,index}.ts` 全文件检查存在 17 条**既有**告警（buildAgents 签名 noUnusedFunctionParameters、既有 console.error/noNonNull、observation-run-scope 遗留 import——均不在本票 diff hunk 内；本票基线口径为 `server/src/mastra` clean，与 ME05 相同）。

## 2. AC 对照（file:line + 测试名）

> **修正记录（fix-round-1，2026-10-20）**：独立评审后更正两处 AC 判定——**AC1 与 AC3 由 PASS 改判 PARTIAL**。两处同属"已交付、未上电"：AC1 的 server 侧 computer 工具作用域装配合同已交付，但 Mastra 路径今天没有任何 server 侧 computer 工具 mount（无生产装配点）；AC3 的生产参与完成被有意拒绝（loopFor 在 receipt 之前抛 `MASTRA_RESUME_LOOP_MODEL_UNWIRED`），且生产 grant 门对 frontend_tool 名恒拒不放行（F2 形状缺陷，见 §4/§6）。其余 AC 判定与计数维持原文（fix-round-1 的代码修正与本报告更正见 `fix-round-1-report.md`）。

### AC1 环境/凭据按 scope 解析，禁止全局 Bot ID 共享有状态环境 — PARTIAL（fix-round-1 更正：装配已交付、未接线）
- 实现：`server/src/mastra/computer-scope.ts`（新）——`scopedComputerEnvironmentKey`（:60，作用域复合环境地址，全段校验防注入 :48）、`scopedComputerGateway`（:80，Proxy 视图：非本绑定作用域地址一律 `MASTRA_COMPUTER_ENVIRONMENT_SCOPE_REFUSED`，raw 全局 botId 点名拒绝）、`createMastraComputerTools`（:128，legacy headless 工具原语义 + 作用域地址/actor 装配）。
- 测试：`same_bot_across_two_scopes_resolves_two_different_environments`、`scoped_gateway_view_refuses_raw_global_bot_addressing`（同 Bot 两 scope 不同地址、raw botId 与外来 scope 地址均拒）、`mastra_computer_tools_assembly_addresses_the_gateway_by_scoped_key`（gateway 只见作用域键）、`environment_address_rejects_injected_or_unshaped_ids`（unit 文件 "ME06 computer scope resolution (AC1)" 组）。
- **PARTIAL 的缺口（fix-round-1 更正）**：本票交付的是作用域解析/装配/寻址合同与测试；Mastra 路径至今**不存在 server 侧 computer 工具的生产 mount 点**（无任何调用 `createMastraComputerTools` 的生产装配），故"环境按 scope 解析"对用户尚不可观察。装配接线（headless mastra 路径挂上作用域 computer 工具）收敛于 ME09/ME10。

### AC2 服务端可执行走 ME04 包装；浏览器工具不伪造结果 — PASS
- 实现：`server/src/mastra/frontend-tools.ts`（新，:68 `createFrontendBridgeTools`）——resumeData 在 ⇒ 原样返回客户端真实结果（:115），否则 `context.agent.suspend({kind:"frontend_tool", toolCallId, toolName, args})`（:130），无引擎挂起面 ⇒ `MASTRA_FRONTEND_TOOL_SUSPEND_UNAVAILABLE` fail-closed（:126）；granted 同名冲突让位（挂载时丢弃，granted 永不被 shadow）。execution.ts:255 桥与 ME04 包装工具同 mount；copilot.ts:2426 从 run 输入组装 frontendTools（服务端组装，非 wire 可选）。
- 事件面：stream-events.ts:72/373 `tool-call-suspended` 入册并映射为终无 terminal 的 suspension（命名挂起 call）。
- 测试：`frontend_tool_call_suspends_the_engine_and_announces_the_call_without_a_server_result`（真引擎：finishReason=suspended、TOOL_CALL_START/ARGS 有、TOOL_CALL_RESULT 无、provider 只拨 1 轮）、`frontend_tool_suspension_saves_a_frontend_tool_continuation_fact`（事件无 RESULT、无 RUN_FINISHED/RUN_ERROR、fact kind/toolCallId/argsDigest/operationId/snapshotRef 全对）、`bridge_mount_skips_a_client_declaration_that_collides_with_a_granted_tool`、`computer_guided_bot_bridges_frontend_tool_participation`（browser-runner 端到端 SSE：guidance 进 prompt 且在 PROVENANCE 之后、TOOL_CALL 事件到 wire、run 未完成、owner 如实 settle）。

### AC3 无人值守持久挂起、原 UI 可查看、参与后恢复；stop/撤权阻断 — PARTIAL（fix-round-1 更正：生产参与完成被有意拒绝）
- 实现：execution.ts:408-440 挂起先落行（`suspensionKindOf` :225 按 frontend 名集派发 kind）；resume-driver.ts:136-247 frontend drive（`resumeStream(decision.result ?? null, {runId, toolCallId})` :242-247，receipt started→executed 顺序与 F1 围栏照用）；approvals.ts onSuspension 按驱动 kind 存替身挂起（re_suspended 同款 R3-11 语义）；stop 闸 = 生产 generationCurrent 走 `runs.getActiveAttemptGeneration`（index.ts:2989，stop 后代际移动 → MASTRA_CONTINUATION_GENERATION_STALE），撤权闸 = `toolGrantCurrent` 走生产 grantedTools（index.ts:2975-2983）。
- 测试（integration）：`headless_suspension_persists_then_a_fresh_process_completes_participation`（挂起落 waiting 行 → **独立 OS 进程**经生产六门+CAS+receipt 顺序应用真实 tool_result → resumed、answer 含真实参与结果、receipt=['executed']、行终态 finished/resumed、二次进程同回包 → already_applied）、`stop_after_suspension_blocks_the_resume_and_revoked_grant_refuses`（两闸拒绝、行保持 waiting、零额外拨号）。
- 可查看：`GET /api/mastra-continuations`（workspace 级 waiting 列表，0164 预留索引 `mastra_continuations_scope_status_idx` 消费，continuation-store.ts:656）+ `GET /:id`；route 测试 `participation_route_list_get_and_tool_result_apply` 断言刷新后 waiting 仍在。
- **PARTIAL 的缺口（fix-round-1 更正）**：(a) 生产参与**完成**被设计性拒绝——生产 loopFor 在 receipt 之前抛 `MASTRA_RESUME_LOOP_MODEL_UNWIRED`（index.ts:3001-3006），挂起保持 waiting，绝不绕开 governed 预算/租约拨号（§4）；(b) grant 门的形状缺陷（评审 F2）：生产 `toolGrantCurrent`（index.ts:2973-2982）检查 `toolName ∈ plugin grantedTools`，对浏览器声明的 frontend_tool 名**恒假**——ME09/ME10 在接线 loopFor 之前必须把该门改为 kind-aware（frontend_tool 决策不查 plugin grant 台账），否则接线即全员 403；(c) 浏览器回调接线（真实 Chrome 参与回灌）仍开放 → ME16（§6.1）。集成套件对真引擎+真库+真子进程证明了恢复合同本身（fixture loop surface）。

### AC4 结果关联 operationId/toolCallId+argsDigest；重复回包只计一次 — PASS
- 实现：挂起 fact 的 operationId = `continuationOperationId(executionKey, toolCallId, argsDigest)`（execution.ts:425-429，F6 断言经 store.saveContinuation 第三参）；参与入口 `frontendToolResultReceiptId`（continuation-routes.ts:45）= 回包内容 canonical JSON sha256 → 同回包同 decisionId → `already_applied`；不同回包 → alreadyFinished 拒绝；receipt 复用 = ME05 规则原样（findReceipt → executed 复用 / unknown 待处置）。
- 测试：`duplicate_tool_result_reply_is_applied_exactly_once`（同决策重放 already_applied、provider 仅 2 轮、receipt 台账恰 1 行 executed）、route replay→already_applied + mismatch toolCallId→400、`expired_frontend_tool_claim_follows_the_receipt_evidence_rules`（过期 claim + executed receipt → reused_receipt，恢复不拨号）。

### AC5 gallery/activity 语义保持；等待状态刷新不丢 — PASS（浏览器内渲染 UNVERIFIED，见 §6）
- 实现：`open-generative-ui` 的 legacy 通道（copilot.ts ~4661 的 runtime `openGenerativeUI` 中间件）零改动；Mastra 路径经同一 runtime/channel，stream-events 对前端工具参数的 TOOL_CALL_ARGS 帧与 legacy 完全同形（中间件消费输入未变）；sandboxed/gallery 前端工具与 computer 工具同走惰性桥（同挂起/同参与协议）。等待状态：continuation 行持久（DB），list/get 路由 = 刷新后的可读状态；engine snapshot 在受限租户存储（index.ts:2952-2964 storageFor → resolveMastraBinding + mastraStorage.getStore）。
- 测试：`participation_route_list_get_and_tool_result_apply`（list 含 waiting 行、GET 200、跨 scope 404）、integration 主测试行绑定断言（threadId/runId/kind/status=waiting）；`tool_call_suspended_chunk_is_a_known_suspension_naming_the_call` + `suspend_pause_supersedes_an_earlier_tool_calls_step_end`（stream-events 单测）。

### AC6 Computer 审批/host-access 保持；撤权、过期、跨范围拒绝 — PASS
- 实现：`/api/approvals/computer/*` 与 host-access 模块零改动（git status 无 approvals/**、computer/** 引擎条目）；撤权/跨范围/过期在参与路径的对应闸 = toolGrantCurrent（撤权→403 GRANT_REVOKED）+ 作用域视图拒绝（AC1）+ 过期 claim receipt 证据规则（ME05 原样消费）。
- 测试：`stop_after_suspension_blocks_the_resume_and_revoked_grant_refuses`（撤权注入 → MASTRA_CONTINUATION_GRANT_REVOKED）、`expired_frontend_tool_claim_follows_the_receipt_evidence_rules`、route 跨 scope 404；approvals/** 零 diff 即零回归面（ME05 §1.2 结论继续成立）。

### Re-review 遗留与评审跟踪项
- **execution.ts 4 处 `as unknown as BaseEvent`** → 已改为 `RunErrorEvent` 类型化构造（execution.ts:213 `saveFailedRunError`，调用点 :402/:416/:427/:436；与 stream-events R4-14 同模式）。
- **F1 围栏**：ME05 fix-round-1 已落地（receiptSink.started → MASTRA_CONTINUATION_CLAIM_LOST）；本票原样消费，frontend drive 同一围栏（resume-driver.ts:216-236）。
- **O11（两次 defer）**：新 unit 测试对**真锁定引擎**断言 execute-context 形状：`context.agent.toolCallId === "call_fe_1"`、`suspend` 为函数、resumeData 首轮 undefined（tests/mastra-computer-tools.test.ts "O11" 注释块）；resume 回灌测试断言 resumeData=客户端结果。
- **R2-10（第 4 次 defer 后归本票）**：`server/tests/support/pg-container.ts`（新：testPgContainer/testPgPort/psql/psqlStrict/dropDatabaseAndRole/createDisposableDatabase）；me01（3 行委托）、me05（afterGrants 回调内迁移+授权）、me03（消费 psql/testPgContainer）全部改为消费它，行为零变化；全部下游套件绿（§1.2/§1.3）。

## 3. 改动文件清单（本票 delta；全部未提交）

**新增（src）**：`server/src/mastra/frontend-tools.ts`、`server/src/mastra/computer-scope.ts`、`server/src/mastra/continuation-routes.ts`
**修改（src）**：`server/src/mastra/execution-contracts.ts`（FrontendToolDefinition + request 字段 + tool_result.result）、`execution.ts`、`stream-events.ts`、`resume-driver.ts`、`approvals.ts`（fact kind + attemptId 门，加法）、`continuation-store.ts`（listContinuations）、`ag-ui-agent.ts`、`copilot.ts`、`server/src/index.ts`（生产装配）、`server/src/app.ts`（路由挂载）
**新增（tests）**：`server/tests/support/pg-container.ts`、`me06-fixture.ts`、`me06-child.ts`、`server/tests/mastra-computer-tools.test.ts`、`server/tests/enterprise/mastra-frontend-tool-participation.integration.test.ts`
**修改（tests）**：`server/tests/support/me01-fixture.ts`、`me03-fixture.ts`、`me05-fixture.ts`（R2-10）、`server/tests/mastra-governed-execution.test.ts`（computerGuidance 用例按 ME06 新契约改写：拒绝→桥+挂起）、`server/tests/mastra-browser-runner.test.ts`（harness computerGuidance 选项 + 2 新测试）
**生成物**：`docs/verification/e2e-bun-suites.json`、`archive/verification/e2e-file-audit.json`（清单再生）。`.e2e-me06/` 已删除；`.gitignore` 已还原未改。
**生成性改动注（fix-round-1 补记）**：`server/src/app.ts` 的 diff 除路由挂载外还包含一遍 biome organize-imports（import 排序为 biome 强制格式，非人工重排；逻辑零改动）。

## 4. 生产装配说明（对用户可见的前提 + 有意的边界）

index.ts:2936-3016 构造**真实** continuation store（部署 database + keyEncryptionKey）、真实 storageFor（会话绑定→租户受限引擎存储）、真实 grant/generation 门，并 `setMastraContinuations(...)` 接上 seam；`/api/mastra-continuations` 挂载使等待/恢复对用户可见。**有意留白（命名拒绝，非绕过）**：resume loop 的 governed 模型再绑定（route+ceiling+run 重激活）属 ME09 审批集成/ME10 审批续跑合同——runs 服务对已 settle 的 run 拒绝 capability 铸造（model-capability.ts RUN_NOT_ACTIVE/RUN_ATTEMPT_STALE），故生产 loopFor 以 `MASTRA_RESUME_LOOP_MODEL_UNWIRED` fail-closed，绝不绕开 governed 预算/租约拨号。挂起、等待可见、门禁与幂等在生产全为真；引擎循环的跨进程恢复已在集成套件对真引擎+真库+真子进程证明（fixture loop surface，与 ME05 同口径）。engine selector 仍为测试装配（ME14/ME16 切换），生产路径零行为变化。

**F2 接线进入条件（fix-round-1 起跟踪；ME09/ME10 的硬前置）**：生产 `toolGrantCurrent`（index.ts:2973-2982）以 `grantedTools({store, botId, ...})` 的返回集判定，即 **toolName ∈ plugin grantedTools**。browser 声明的 frontend_tool 名只存在于 run 输入的 `frontendTools` 定义里，**永远不在** plugin grant 台账中——该门对 frontend_tool 决策恒拒（恒 403 GRANT_REVOKED）。因此 ME09/ME10 在把 loopFor 接上生产之前，必须先把六门编排中的 grant 门改为 **kind-aware**：`approval` 决策继续查 plugin grantedTools（撤权语义原样），`frontend_tool` 决策改查"该 toolName 是否本挂起绑定的 frontend 声明集成员"（参与身份已由 scope + argsDigest/tamper 门把住），或等价的可撤权 browser 声明台账。在本轮（ME06 fix-round-1）只记录，不改 index.ts。

## 5. 已知噪声（非本票回归，证据优先）

15 文件共进程偶发 1 条 5s 超时伪红：本轮记录到 `mastra-conversation-runtime.integration.test.ts (unnamed) [5001ms]` 与基线 13 文件波同样偶发的 `mastra-continuations.integration.test.ts new_process_can_resume [5003ms]`（子进程 spawn 在重载共进程下超时）。ADR 0008 口径验证：两文件**独跑全绿**（conversation-runtime 15 pass/0 fail；子进程三件套连跑 3 次全绿）、e2e driven 组（part 4/6）全绿、多次全波复跑多数全绿。基线 13 文件波（不含本票文件）以相同频率复现同款伪红——共进程调度噪声，非 ME06 引入。

## 6. UNVERIFIED（不装通过）

1. **真浏览器内端到端**（本会话无浏览器环境）：真实 Chrome 中 useFrontendTool handler 收到 Mastra 路径 TOOL_CALL 事件→执行→经 `/api/mastra-continuations/:id/tool-result` 回灌→聊天 UI 显示续答。事件协议服务端已证（SSE body 断言 + runtime-compat 套件绿）；浏览器端参与回调接线是**发现的真缺口**：legacy 引擎由 CopilotKit runtime 带内回灌，Mastra 引擎下 run 终无 terminal，handler 结果需客户端调参与路由——该接线涉及 provider/approvals/引擎选择联动，超出本票文件范围（app/ 按指令零改动），建议随 ME16 切换落地。**前端结论：verified as-is（零改动；服务端事件面与参与入口已就绪）**。
2. **物理 per-scope Computer 供给**：AC1 交付解析/寻址/拒绝合同；provider.locate(作用域键) 背后按键供实物属部署 provider 事实（不改 Computer 引擎，范围边界）。legacy 浏览器参与门 `/api/approvals/computer/<botId>` 保持全局寻址（approvals/** 范围外）；**更正（fix-round-1）**：MASTRA 路径的 computer 工具装配目前是**已交付但未接线**（`computer-scope.ts` 的作用域装配合同存在，但生产路径没有任何 server 侧 computer 工具 mount 点），两通道在 ME09/ME10 接 headless mastra 装配时收敛。
3. **生产 resumed-loop 模型拨号**：见 §4（MASTRA_RESUME_LOOP_MODEL_UNWIRED 有意 fail-closed）；接线前还须满足 §4 的 **F2 进入条件**——toolGrantCurrent 改为 kind-aware（对 frontend_tool 决策恒拒的形状缺陷），否则接线即所有 frontend_tool 参与被 403 拒绝。
4. **gallery/activity 在 Mastra 挂起轮次的浏览器渲染**：中间件零改动 + 事件帧同形已证；真实渲染画面未在本会话观察（同 UNVERIFIED 1）。

## 7. 冲突与升级记录

- 无 Spec/ADR 冲突需裁决。实现遵循 ADR 0006（作用域寻址）、0008（两层测试制）、0010（引擎治理）；spec §5 生命周期表逐条有测试对应。
- drizzle 无新增迁移（0164 预留索引已覆盖本票读面），F2（0165/0166 撞号）未触发。
