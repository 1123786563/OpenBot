# ME04 Report — Bot 通过本人授权的连接器工具完成多步工作 (#476)

- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`，branch `1123786563/mastra-exec`，HEAD `bf64d0f2772766a7c0cdbc3e9831c9024400e165`（无 commit/push；全量未提交增量检查点）。
- 本轮为**续作轮**：上一派发在平台 model-service 错误中崩溃后留下部分实现；本轮先全量核读四处遗留，再补齐/修正，最后全量回归。ME01–ME03 全部保持绿（见下文 86 基线零回归）。
- 范围遵守 brief fence：`server/src/mastra/tools.ts`（新）、两个新测试文件、me04-harness（新）、`execution.ts`/`stream-events.ts` 工具循环使能、`copilot.ts` 的 `MASTRA_TEXT_ONLY_SLICE` 取代区域；`plugins/tools.ts`/`selection.ts` 只读复用；未触碰 schema/migrations、ME03 runtime、`index.ts`。

## 1. 命令与结果（全部本轮实跑）

| 命令（cwd = repo root，除注明外） | exit | 结果 |
| --- | --- | --- |
| `cd server && bun test tests/mastra-tools.test.ts` | 0 | **6 pass / 0 fail**（36 expect）：wrapper 单测 6 具名用例全绿（编辑后终态） |
| `cd server && ME01_TEST_PG_PORT=5433 bun test tests/mastra-governed-tools.test.ts` | 0 | **7 pass / 0 fail**（46 expect）：治理工具循环 7 具名用例全绿；`operation_receipt_associated_once` 走一次性受限库 fixture（`ME01_TEST_PG_PORT=5433`，teardown drop） |
| `ME01_TEST_PG_PORT=5433 bun test <11 文件：me04 两套件 + 六守门 + ME03 三后端套件>`（server/ 下） | 0 | **99 pass / 0 fail（457 expect，11 文件）**：86（ME03 OCR 收尾基线：message-parts 11 + runtime 集成 14 + engine-wiring 5 + 守门 56）+ 13（ME04 新增）= 99，精确吻合，零回归 |
| `bun test app/tests/mastra-runtime-compat.test.tsx` | 0 | **5 pass / 0 fail**（22 expect）：前端兼容零改动保持 |
| `bun run --cwd server typecheck` | 0 | **恰好 3 个基线错误**（`scripts/bootstrap-local-gateway.ts` :106/:108/:120），零新增 |
| `bunx biome check server/src/mastra/{tools,execution,governed-agent,stream-events}.ts server/tests/{mastra-tools,mastra-governed-tools}.test.ts server/tests/support/me04-harness.ts` | 0 | **clean**（本轮触碰的 7 个 mastra/me04 文件零诊断；`execution.ts` 曾有 1 处 format 问题，`bunx biome format --write` 修复后复查 clean） |
| `bunx biome check server/src/copilot.ts`（并入上条同跑） | 残留 | 仅余 **既有基线**：noUnusedFunctionParameters ×4（:3063/:3065/:3069/:3073）、noUnusedVariables ×2（:3323/:3425）、noConsole ×4（:2759/:2780/:3120/:3135）——与 ME03 报告记录的 legacy 区域基线逐条一致，全部位于 ME04 未触碰区域，零新增 |
| `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs` | 0 | **1035 files · 467 kept on Bun runtime · 33 driven groups**（ME03 终态 1033/465/33 → +2 = 两个新套件入册）；`directoryIslands` 与前缀岛全部保留（`groupsOf()` 未回退）；still-ours-to-fix 仍为既有 1 项（`auth-client` 缺 base URL，env-blocked 既有） |

证据文件：`docs/plans/2026-10-19-mastra-execution-run/me04/evidence/`（崩溃派发留下的 `red-run.txt`（RED 证据：当时 `mastra/tools` 模块尚不存在，`Cannot find module '../src/mastra/tools'`）、`green-battery.txt`、`typecheck.txt`（3 基线错误同款）、`manifest.txt`（1035/467/33 与本轮再跑一致）、`audit.txt`、`driven-part6.txt`）+ 本轮终态以上表为准。

## 2. 崩溃派发遗留 vs 本轮改动

崩溃派发遗留（核读后**保留**，均判定正确）：

- `server/src/mastra/tools.ts`（新，195 行）：受控包装主体完整——mount 时具名拒绝（`MASTRA_TOOL_UNKNOWN`/`_NAME_INVALID`/`_NAME_RESERVED`/`_NAME_COLLISION`，L119-143）、prototype-less record（L117）、执行前 stop/lease 守卫（L154-165）、operationId+argsDigest 身份（L167-185）。包装的 execute 直呼**原 GrantedTool.execute**（L183），grant→policy→credential→audit 单一路径不变。
- `server/tests/mastra-tools.test.ts`（新）：6 具名 wrapper 用例。
- `server/tests/mastra-governed-tools.test.ts`（新）：7 具名循环用例（controller 消息未列此文件，实为崩溃派发已产出，本轮核读后保留）。
- `server/tests/support/me04-harness.ts`（新）：ME02 fixture 逐行派生的治理载体 harness（真实 governed carrier + 桩上游 dial）。
- `server/src/mastra/execution.ts`：`TOOL_LOOP_MAX_STEPS=8`（L28）、`buildAgent` 经 `createMastraTools(request.tools, { signal: request.signal })` 挂载（L203-218）、`maxSteps` 传入 `agent.stream`（L240）——旧的 `Object.fromEntries` 工具表已被取代，不存在双份实现。
- `server/src/mastra/stream-events.ts`：`suspendedByToolCalls` 标记（L128）、`tool-calls` 保持非终结（L402-411）、`end()` 的 loop-cut 真实错误终结（L366-381）、`tool-error` → RUN_ERROR + `markUntrusted`（L314-330）。
- `server/src/copilot.ts`：`MASTRA_TEXT_ONLY_SLICE` 收窄为仅 learned-skills/computer-guidance 拒绝（L2281-2299，注释明示 ME06/ME08 接线前 fail-closed）；`grantedToolGuidance(tools, connectedVendors)` 进入 trusted instructions（L2303-2309）；granted tools 随 `MastraExecutionCompletion` 进 ExecutionRequest（L2345-2350 → `ag-ui-agent.ts` L71）。ME03 runtime seam 完好：`mastraConversationRuntime` 未接线仍拒（L2321-2322），`loadExecutionInput` 重建历史 + `withPersistedOutput` 先持久化后放行 RUN_FINISHED（L2189-2236、L2329-2355）。

本轮改动（3 处，全部小而准）：

1. `tools.ts` operation 身份收紧（L167-185）：旧逻辑按 `toolCallId` 查 map、命中即复用——当引擎未携带 call id（fallback `""`）时**两次不同调用会合并同一 operationId**，且同 call id 换参数也误标旧身份。修正为：无 call id 的每次 execute 都是新逻辑操作（永不合并）；有 call id 且 argsDigest 相同才复用同一 operationId（ME05 重试/恢复语义），argsDigest 不同即换新身份。
2. `mastra-governed-tools.test.ts`：用例名 `each_step_issues_distinct_capabilities` → `each_step_issues_distinct_capability`，对齐 brief 的 12 合同名（brief 契约：names are contract）。
3. `mastra-tools.test.ts`：扩展 `granted_tool_executes_once`，新增"无 call id 两次同参 execute 各得独立 operationId"断言（LL96-105），锁死修正 1 的行为；并保留 schema 拒绝 `{value:42}` 不触达 granted execute 的断言（实证：`bun test` 直证 Mastra `Tool.execute` 在 schema 失败时不进入包装 execute）。
4. 另有纯格式：`execution.ts` 一处 `bunx biome format --write`（无语义变化）。

## 3. 六条验收标准逐条裁决

**AC1 工具发现与授权分离；只提供经 grant + 筛选的工具，参数经原 schema 校验，实际调用仍过 policy、credential、audit — PASS。**
只有 `grantedTools()`（store `listForAgent` + selection）产出的 GrantedTool 进入包装（`tools.ts` L110-188；`execution.ts` L208 只接收 `request.tools`）；`ungranted_tool_is_absent` 证未持有工具不在 record；挂载 schema = grant 原声明 schema（L149 `inputSchema: granted.parameters`），schema 不过不触达 granted execute（单测实证）；包装 execute 即 `granted.execute` → `store.callTool`（`plugins/tools.ts` L233-249，grant→policy→credential→audit 唯一路径），原始 MCP 工具从不挂载。

**AC2 执行时重查撤权与连接归属；同名/保留名/非法名明确处理，不覆盖系统工具 — PASS。**
运行时撤权重查在 granted 路径内（store 每次调用读新 grant；`revoked_grant_blocks_new_external_call` 实证：两步间撤权后第 2 次外部调用被拒、返回 Refused 句子、run 真实完成，executions 仅 1 次）；连接归属由 `store.callTool` 的 grant/policy 检查承担（只读复用，不重写）。命名冲突三连：`MASTRA_TOOL_NAME_COLLISION`（重复模型名）、`MASTRA_TOOL_NAME_RESERVED`（`copilotkit_load_skill`/`copilotkit_read_skill_file` = `LEARNED_SKILL_TOOL_NAMES`，ME08 前不可被 grant 覆盖）、`MASTRA_TOOL_NAME_INVALID`（空/空格/路径形/点号）全部具名拒绝（单测 `reserved_name_collision_refused`）。

**AC3 供应商错误、平台拒绝、外部不可信内容保持原语义 — PASS。**
vendor 错误信封（`vendorAnswer` 的 `The vendor reported an error:\n<markUntrusted(...)>`）与 `Refused.` 平台拒答标记**逐字节透传**（`vendor_error_remains_untrusted`）；包装自身不改写、不洗白任何外部文本；granted execute 抛错走引擎 `tool-error` → RUN_ERROR + `markUntrusted`（`stream-events.ts` L314-330）；包装守卫的阻断也是具名拒绝（`MASTRA_TOOL_RUN_NOT_CURRENT`/`MASTRA_TOOL_LEASE_NOT_CURRENT`），经同一路径变为不可信包装的可诊断错误。

**AC4 每步签发不同 capability；首步 100 耗 70 后次步 ≤30；预算拒绝不自动 retry/换路由 — PASS。**
`each_step_issues_distinct_capability`：两步模型循环发出 2 个不同 modelRequestId + 2 个不同 capability token，各结算一次（`capabilitiesIssued`/`capabilitiesConfirmed` 均 2，集合去重均 2）。`budget_100_70_next_le_30`：ceiling=100 下 `maximumTokens` 序列恰为 `[100, 30]`（spec 自身算术），工具在其间恰好执行一次，结算干净。`budget_402_no_retry_no_route_switch`：capability issue 处 402（模型 doStream 计数器=1、上游 dial=0、issued=0），终态 RUN_ERROR、无 RUN_FINISHED、`budgetExhausted()=true`，`classifyGovernedRunFailure` 固定分类 `MODEL_BUDGET_EXCEEDED`；`maxRetries: 0`（`execution.ts` L236）+ 无任何 route/payer 切换代码路径。

**AC5 保留最多 8 步工具循环；到上限给真实结果/原因，不伪造工具执行或完整成功 — PASS。**
`tool_loop_cap_eight_truthful_terminal`：上游永不给出最终答案时，恰 8 次 dial、8 次 granted 执行（每步各一次，不多执行）、8 capability/8 confirm（不漏结算），终态 RUN_ERROR 且消息含 "tool-call step"（`stream-events.ts` L366-381 loop-cut 终结），无 RUN_FINISHED。`tool-calls` finish reason 保持非终结（L402-411，流未断时循环继续），`tool-error` 仍映射 RUN_ERROR。

**AC6 工具提议、实际执行、receipt 与观测只关联同一操作一次；失去 owner 或撤权后阻断新外部调用 — PASS。**
`operation_receipt_associated_once`（真实一次性 PG store）：两步循环恰写 1 行 receipt、行 digest = `argsDigestFor({value:"hi"})`、TOOL_CALL_START 恰 1 个且 `toolCallId === "call_1"`（引擎 call id 与 proposal/execution/receipt 关联一致）。重试语义：同 call id 同参数复用同一 operationId（ME05 续算在此基础上），换参/无 id 各为新操作（本轮修正 1）。撤权阻断：AC2 的 revoked 用例。失 owner 阻断：`lost_lease_blocks_new_external_call` 用 **runner 自己的 fencing**（`isRunnerRequestLeaseCurrent` over `RunnerRequestLease`，`enterprise/runs/store.ts` L101-116）构造探针——lease 换 owner 后新外部调用被 `MASTRA_TOOL_LEASE_NOT_CURRENT` 拒于 granted 路径之前（calls 不增）；stop 走既有 abort signal（`MASTRA_TOOL_RUN_NOT_CURRENT`），production 由 `execution.ts` L209 把 `request.signal`（runner stop wire：`activeStreams` controller）接入守卫——无第二套 fencing。

## 4. 12 合同测试名核对（brief 名单 → 实际落点）

| brief 名 | 套件 | 状态 |
| --- | --- | --- |
| `granted_tool_executes_once` | mastra-tools（wrapper 级）+ mastra-governed-tools（循环级，双证） | pass ×2 |
| `ungranted_tool_is_absent` | mastra-tools | pass |
| `two_bindings_do_not_share_tools_or_prompt` | mastra-tools（对象不共享）+ execution.ts 每请求建 Agent（结构证） | pass |
| `vendor_error_remains_untrusted` | mastra-tools | pass |
| `reserved_name_collision_refused` | mastra-tools | pass |
| `each_step_issues_distinct_capability` | mastra-governed-tools（本轮由复数名对齐） | pass |
| `budget_100_70_next_le_30` | mastra-governed-tools | pass |
| `budget_402_no_retry_no_route_switch` | mastra-governed-tools | pass |
| `tool_loop_cap_eight_truthful_terminal` | mastra-governed-tools | pass |
| `revoked_grant_blocks_new_external_call` | mastra-governed-tools | pass |
| `lost_lease_blocks_new_external_call` | mastra-tools | pass |
| `operation_receipt_associated_once` | mastra-governed-tools（真实 PG store） | pass |

## 5. 文件与行号（ME04 范围）

- `server/src/mastra/tools.ts`（新，195 行）：拒绝类/守卫接口 L38-63；名称校验 L71-77；`argsDigestFor`/`toolCallIdOf` L79-103；`createMastraTools` L110-188（守卫 L154-165、身份 L167-185、唯一 granted execute L183）。
- `server/src/mastra/execution.ts`：cap 常量 L28；`buildAgent` 挂载 L203-218（createMastraTools 调用 L208）；`maxSteps`/`maxRetries` L236-241。
- `server/src/mastra/stream-events.ts`：`suspendedByToolCalls` L128；`tool-error`→RUN_ERROR L314-330；loop-cut 真实终结 L366-381；`tool-calls` 非终结 L402-411。
- `server/src/copilot.ts`：text-only 收窄 L2281-2299；grantedToolGuidance 进 instructions L2303-2309；tools/governedModel 进 execution L2345-2350；ME03 seam L2321-2339。
- 测试：`server/tests/mastra-tools.test.ts`（257 行）、`server/tests/mastra-governed-tools.test.ts`（350 行）、`server/tests/support/me04-harness.ts`（426 行）。
- 清单：`docs/verification/e2e-bun-suites.json`、`archive/verification/e2e-file-audit.json`（再生成，1035/467/33）。
- SHA256：`docs/plans/2026-10-19-mastra-execution-run/checkpoints/me04-review/sha256.txt`。

## 6. 偏差与限制

1. **lease 探针的 production 接线点**：守卫的 `leaseCurrent` 探针在 wrapper 层完整实现并以 runner 自有 fencing 单测锁定；production `execution.ts` 现接的是既有 abort signal（stop wire 全程生效）。把 runner 的 `state.lease`/`leaseLost` 以回调形式注入 `GovernedModelRequest` 需改 `governed-execution.ts`+`runner.ts`——在 brief fence 之外，且 runner 失 lease 时现有 `relayEvent` 抛 `RUN_REQUEST_LEASE_STALE` 已使流失败、引擎停拨；完整 runner 侧注入按计划属 T8/T9（`lost_lease_stops_new_tool_calls` RED 名在 plan §T9）。守卫签名已按该注入形状预留（`MastraToolGuard.leaseCurrent`），后续票零改动接入。
2. 合同名对齐：`each_step_issues_distinct_capability` 由崩溃派发的复数名改名（契约名以 brief 为准）。
3. `two_bindings_do_not_share_tools_or_prompt` 的 prompt 半边由结构证（`buildAgent` 每请求新 Agent + 每请求新 instructions）+ ME02 既有 per-request 断言承担，wrapper 单测只锁工具对象不共享。
4. 环境封锁的既有失败（learning-langgraph、db-client-address、auth-client）非本轮范围，未触碰。

---

## Fix round 1（me04-review 修复轮，2026-10-20）

独立评审 3 条发现的处置与实测证据。无新增提交；改动落在同一未提交增量树上。

| # | 发现 | 级别 | 处置 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `EXECUTION_BINDING_UNBOUND`/`MASTRA_CONVERSATION_RUNTIME_UNWIRED` 仍在 `mastraAgentConfiguration` factory 体内同步抛出，违反 MASTRA_TEXT_ONLY_SLICE 的“迭代期结构化 RUN_ERROR”契约 | IMPORTANT | 已修复：两守卫逐字移入返回的 async generator 体内、首个 `await` 之前（copilot.ts L2319-2327，与 text-only 模式同构）；检查逻辑零改动，仅位置变化 | `collectEvents` 迭代期收集下 governed-execution 既有 2 条 `EXECUTION_BINDING_UNBOUND` 断言原样通过（无需改测试，仓库内无同步抛出断言）；typecheck/biome 零新增诊断 |
| 2 | `lost_lease_blocks_new_external_call` 误放 mastra-tools（wrapper 套件），brief 归属循环套件 | MINOR | 已迁移：测试体逐字移入 server/tests/mastra-governed-tools.test.ts L387；原文件同步移除 2 个失效 import（`RunnerRequestLease`、`isRunnerRequestLeaseCurrent`）；wrapper 辅助 `tool`/`callTool` 两文件各自本地保留 | 迁移后 mastra-tools 5 pass（原 6）、mastra-governed-tools 8 pass（原 7），断言零改动 |
| 3 | operation-identity map 缺一行 ME05 语义注释 | MINOR（纯文档） | 已补：tools.ts L166-173 注释块追加“同 run 内 callId+args 相同刻意共享 operationId（重试语义）；ME05 去重不得把身份唯一等同单次执行” | 纯注释，无语义变化 |

### 验证（实测计数）

- `ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-tools.test.ts server/tests/mastra-governed-execution.test.ts server/tests/mastra-governed-tools.test.ts server/tests/mastra-browser-runner.test.ts` → **40 pass / 0 fail**（brief 预估 ~27 为约数；分文件实测：mastra-tools 5、mastra-governed-execution 20、mastra-governed-tools 8、mastra-browser-runner 7）。
- `bun run --cwd server typecheck` → **恰好 3 个基线错误**（scripts/bootstrap-local-gateway.ts TS2339 ×3，非本轮触碰，与既有基线一致）。
- `bunx biome check` 触碰文件：`server/src/mastra/tools.ts`、`server/tests/mastra-tools.test.ts`、`server/tests/mastra-governed-tools.test.ts` **clean**（mastra-tools.test.ts 一处 format 由 `bunx biome format --write` 修复后复查通过）；`server/src/copilot.ts` 仅余既有基线 10 条（noUnusedFunctionParameters ×4、noUnusedVariables ×2、noConsole ×4；行号整体 +3 系本轮 hunk 净增 3 行），**零新增**，与上文 §2 记录逐条对应。
- SHA256 已更新 4 条：`docs/plans/2026-10-19-mastra-execution-run/checkpoints/me04-review/sha256.txt`（copilot.ts、mastra/tools.ts、mastra-tools.test.ts、mastra-governed-tools.test.ts）。

行号刷新（覆盖 §4/§5 相应条目）：`lost_lease_blocks_new_external_call` 现位于 mastra-governed-tools.test.ts L387-447；copilot.ts 两守卫现位于 generator 体内 L2320-2327；mastra-tools.test.ts 现 193 行、mastra-governed-tools.test.ts 现 448 行。
