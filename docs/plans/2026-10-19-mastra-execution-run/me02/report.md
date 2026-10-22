# ME02 Report — 现有聊天入口通过 Mastra 完成受预算约束的文本回答 (#474)

- 工作区：`/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`，分支 `1123786563/mastra-exec`，BASE `bf64d0f2`（HEAD 同 base，本会话零提交、零推送）。
- 本文件是接续报告：前一实现者在中途预算耗尽；本会话接手收尾。其代码选择全部继承（见 §6），本会话修复的缺陷见 §5。
- Ticket：`docs/tickets/mastra-agent-execution/issues/me02.md`（7 条验收）；Brief：`docs/plans/2026-10-19-mastra-execution-run/me02/brief.md`。

## 1. 命令与退出码（全部实跑）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-stream-events.test.ts` | 0 | 7 pass / 0 fail（34 expect） |
| `ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-ag-ui-agent.test.ts` | 0 | 2 pass / 0 fail（10 expect） |
| `ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-governed-execution.test.ts` | 0 | 7 pass / 0 fail（36 expect） |
| `ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-browser-runner.test.ts` | 0 | 7 pass / 0 fail（46 expect） |
| 四文件合并单进程 `bun test <4 files>` | 0 | 23 pass / 0 fail（126 expect）——无跨文件串扰 |
| `ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-agent-resume-process.test.ts server/tests/enterprise/mastra-compatibility.test.ts` | 0 | 8 pass / 0 fail（守门套件保持绿） |
| `node scripts/e2e-file-audit.mjs --jobs=8` | 0 | 1029 files · 555 collect under e2e · 474 do not；ledger 已重写 |
| `node scripts/e2e-bun-manifest.mjs` | 0 | 461 files kept on Bun runtime, 30 driven groups; artifacts 5 |
| `node scripts/e2e-apply-partition.mjs` | 0 | `0 suite file(s) now import the bun:test layer, 0 the e2e layer`（幂等） |
| `bun run --cwd server typecheck` | 2 (tsc) | 恰好 3 个错误，全部在 `scripts/bootstrap-local-gateway.ts`（106/108/120 行，既定基线）；本票新增 0 |
| `bunx biome check <本会话 6 个文件>` | 0 | clean（见 §4 清单） |
| `E2E_UNIT_SCOPE=tests E2E_BUN_ONLY="server/tests part 6" E2E_UNIT_OUTPUT=.e2e/mastra-ME02-green TEST_DATABASE_URL=postgres://postgres:openbot@127.0.0.1:5433/openbot_test DATABASE_URL=… ME01_TEST_PG_PORT=5433 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | 1 | 驱动组执行 24 个文件；唯一 still-red-alone 的文件是 `server/tests/learning-langgraph.test.ts`（2/2，既知 env-blocked，票面豁免项）；`identity-store.integration.test.ts` 共进程失败、单跑绿（driver 已自动隔离并打印）。本票 4 个文件在组内全绿，不在失败名单 |

zero-skip 声明：四个新套件 0 skip；守门两文件 0 skip。driven 组的组级红由上述既存 env/interference 文件造成，与本票文件无关（driver 输出原文见 §1 最后一行）。

## 2. registerHooks 断裂的根因与重构（票面要求记录）

- 症状：四个新套件在任何 `bun test` 下全体 `SyntaxError: Export named 'registerHooks' not found in module 'node:module'`。
- 根因：前一实现者把四个套件的 suite API 从 `../../tests/support/e2e-compat` 导入。该文件第 1 行 `import { registerHooks } from "node:module"` 并在 584 行 `registerHooks({...})` 安装 Node 侧 loader 钩子，为的是在 Node/e2e 层复刻 Bun 的模块解析行为（其 `./bun-compat` 依赖这一副作用）。Bun 的 `node:module` 没有该导出，加载即致命——这是 ADR 0008 两层制里"跑错层"的必然结果，不是代码缺陷。
- 重构（非 feature-detect）：四个套件改为导入 `../../tests/support/bun-test-compat`（bun:test 层），并重跑 audit/manifest 使其进入 driven 清单——`bun test` 与 e2e 调度两条路都成立。`node:module` 钩子在这条链上从来不是运行时必需：这四个套件需要的是"runner API"，而 repo 对 Bun 层的既定答案是 `bun-test-compat`。改层后 `e2e-apply-partition.mjs` 幂等（0 moves），证明层位与清单一致。
- 层位证据：`docs/verification/e2e-bun-suites.json` → `server/tests part 6` 含本票 4 文件 + ME01 的 resume 套件。

## 3. 清单（manifest）核验

- `directoryIslands` 保持存在且等于 `["server/tests/multitenancy","app/tests/multitenancy"]`；三个 multitenancy 组原样：`app/tests/multitenancy(1)`、`server/tests/multitenancy part 1(24)`、`server/tests/multitenancy part 2(23)`（与 BASE 完全同名同容量）。
- 基线清单由 `scripts/e2e-batch-drive-bun-test.mjs` 生成（33 组/456 文件）；本票按票面命令改由 `scripts/e2e-bun-manifest.mjs` 生成（30 组/461 文件）。+5 = ME01 resume 套件 + 本票 4 文件；组数变化来自两个生成器的分组算法差异，文件全体一致。
- 本票文件加入的组：`server/tests part 6`（与 mastra-agent-resume-process、learning-*、key-*、memory-* 等 24 文件同组）。
- `scripts/e2e-bun-manifest.mjs` 的改动（继承自前一实现者并经本会话验证）：引入 `DIRECTORY_ISLANDS`、岛前缀分组、manifest 写入 `directoryIslands` 字段。

## 4. 本会话触碰的文件（含行号）

生产代码：

- `server/src/mastra/stream-events.ts`（373 行，新文件，前一实现者起草）：修复 tool-call 重复发射——`announcedToolCalls` 集合（L79、L155、L193-199）替代被 `tool-call-input-streaming-end` 提前清空的 `streamingToolCalls`/`completedToolCalls` 双集合；一个 `toolCallId` 只可能发一次 `TOOL_CALL_START/ARGS/END` 三元组（流式路径发射后，收尾的 `tool-call` 大块仅确认、不再重发；非流式路径仍由 `tool-call` 自行发射）。删除未用 `StreamChunk` 类型。
- `server/src/mastra/execution.ts`（239 行，新文件，前一实现者起草）：`stripMastraRequestBookkeeping` 现在只深拷贝 plain object（`isPlainObject`，L99-103、L122）——原先对任意对象逐键拷贝，把 AbortSignal（无可枚举自有属性）拷成 `{}`，导致 Bun `new Request(url, {signal})` 抛 `signal is not of type AbortSignal`；类实例一律按引用透传。`toModelMessages`（L44-53）对非 user/assistant 角色改为 fail-closed 拒绝（`ME03_MESSAGE_PARTS_UNSUPPORTED`），同时修掉 typecheck 错（AG-UI role 联合含 developer/activity/reasoning）。

测试（bun 层化 + 夹具修复）：

- `server/tests/mastra-stream-events.test.ts`、`mastra-ag-ui-agent.test.ts`、`mastra-governed-execution.test.ts`、`mastra-browser-runner.test.ts`：compat 层 `e2e-compat → bun-test-compat`。
- `mastra-governed-execution.test.ts`：夹具按生产语义重写——`trustedScopeFor`（真 scope resolver，合成的 directory DB 行补 `status:"active"` 以同时回答 MT005 workspace-membership 查询）；route 用 `canonicalizeModelRouteSnapshot` 生成真 routeRef（原硬编码 `route-ref-1` 与 canonical `mroute:v1:…` 体系不符）；catalog.get 回放同一 canonical 快照；synthetic RunService 按能力逐条记录 issue 时事实并在 resolve 原样返回（原硬编码 `maximumTokens:4096/attemptId:"attempt-1"` 造成 `MODEL_INVOCATION_BINDING_MISMATCH`）；`client_route_override_inert` 的 fetch 按 `(url, init)` 落成 Request 再捕获。
- `mastra-browser-runner.test.ts`：`scopeResolver: scopes`（原 `scopes.resolver` 取了不存在的属性 → 恒 undefined）；capability resolve 事实逐条回放 + `routeRefByTenant`（由 `modelRoutes.put` 记录真实 canonical routeRef，两用户各归各）；trusted 行补 `status:"active"`；`event_append_failure_prevents_success` 对齐 runner 既有契约（RUN_STARTED 先落盘成功、其后 append 拒绝 → 流错误，非 wire RUN_ERROR——先例 runner-production "a_failed_event_append_fails_the_run"）；`disconnect_does_not_product_cancel` 用 `runBodyFor` 构造 `{agent, input}` 形状的 run 请求（原 `JSON.parse(String(request.body))` 双重错误）；two_users provider 兼容 OpenAI parts 数组形式的 user content；清理未用 import/参数。

共享文件（前一实现者的改动，本会话仅验证不动）：`server/src/copilot.ts`（+129/−1：L99-107 imports、L2117 起 `BuiltinExecutionEngine`/`setBuiltinExecutionEngine`、`mastraAgentConfiguration`（factory 内解析 binding，text-only 守卫）、L2333-2346 `builtInAgentConfiguration` 的 server-selected 分支）、`server/src/enterprise/runs/governed-execution.ts`（`GovernedExecutionFacts`、`executionBinding()`、每次 admission 一个 `executionKey`）、`server/src/mastra/compatibility.ts`（ME01 探针扩展）、`server/tests/enterprise/mastra-compatibility.test.ts`、`scripts/e2e-bun-manifest.mjs`。

其他：删除遗留调试文件 `server/me02-debug2.tmp.mts`（另删本会话的探针 `server/me02-probe.tmp.mts`，runner.ts 探针插桩已 `git checkout` 还原）。

## 5. 本会话 RED→GREEN 增量（修复前的真实失败原文）

接手时四套件全部 registerHooks 断裂；分层修复后逐文件驱红转绿：

1. `stream-events`：`tool_chunks_normalize_with_stable_call_ids` — 实际序列多出第二个 `TOOL_CALL_START/ARGS/END`（Received +3）→ 修复后 7/7。
2. `governed`：三例 `TypeError: Failed to construct 'Request': signal is not of type AbortSignal`（AbortSignal 被 strip 拷成 `{}`）→ 修复后暴露下一层：`MODEL_ROUTE_REBIND_INFRASTRUCTURE_FAILED cause UNVERIFIED_SCOPE` 与 `MODEL_GATEWAY_HTTP_403 MODEL_INVOCATION_BINDING_MISMATCH`（夹具伪造事实与生产校验不符）→ 夹具按生产语义重写后 7/7。`budget_402_no_retry` 继承前一实现者的"按模型步数计数"写法（capability issue 在拨号前 402，`doStream` 计数 ===1），本会话验证成立、未改断言。
3. `browser-runner`：`deps.scopeResolver` undefined（夹具取错属性）→ `WORKSPACE_FORBIDDEN`（trusted 行缺 workspace membership 的 `status`）→ `MODEL_INVOCATION_BINDING_MISMATCH`（routeRef/能力事实硬编码）→ 逐层修复后 7/7。
4. `typecheck`：`src/mastra/execution.ts(52,22)` role 联合错误（第 4 个错误，超出 3 基线）→ fail-closed 修复后回到恰好 3 个基线错误。

原始 RED（实现前基线）属前一实现者会话，本会话不可重放（不回滚其实现）；以上为本会话实际观测到的红→绿证据。

## 6. 继承自前一实现者的设计（本会话认可并交付）

- T2 冻结合同：`ExecutionBinding`/`ResumeRef`/`ExecutionRequest`/`ExecuteMastra` 与票面字段一一对应（execution-contracts.ts）；`buildInstructions` 引用 `PROVENANCE_GUIDANCE`/`UNTRUSTED_GUIDANCE` 原常量，客户端 context/forwardedProps 无法进入组合。
- 执行实例：每请求新建 Mastra Agent，无 Memory、`maxRetries: 0`、无 title/summary/embedding；`request.signal` 在模型前消费并贯穿引擎。
- T3 规范化：ME01 冻结词表 + 显式 allow-list（step-start/step-finish/abort）；未知控制块抛 `UnknownMastraChunkError`；缺终态、error、挂起三类终局契约由套件钉死。
- T5：唯一模型是 `request.governedModel.model`；Mastra usage 不作为结算权威；`classifyGovernedRunFailure` 分类保持；`providerOptions` 仅剥离纯框架键（`{mastra:*}`），其余仍 fail-close 于网关适配器。
- T8：server-side 引擎选择 `setBuiltinExecutionEngine`，无选择器时一切照旧（默认 legacy 未翻转）；text-only 守卫拒绝带工具/技能的 Mastra 装配（ME04/05 接线）。
- 402 计数：按模型步（doStream 包装）而非上游拨号计数——402 发生在能力铸造，先于上游拨号。

## 7. 验收判定（me02.md 7 条）

1. **角色/常驻指令/可信指引保留；两用户不串** — PASS。`instructions_are_the_trusted_server_composition`（role+standing 在前、两条 guidance 无条件追加、顺序断言）；`authorized_browser_run_uses_mastra` 断言 system 含 Bot prompt 与 PROVENANCE_GUIDANCE、不含客户端 context 文本；`two_users_no_context_cross_talk`：A/B 各得各自 standing 与消息，互不出现，两组独立能力。
2. **真实挂载入口完成身份/scope/会话/Run/Attempt/lease 准入；客户端伪造无效** — PASS。mounted Hono/CopilotSseRuntime + 真 `DurableProductionRunner`：start→`acquireRequestLease`→续租循环→persist-before-publish→settle-then-complete 全走生产代码；`forged_run_and_model_ignored`：wire 上只出现 `server-run-1`，拨号 model=`me01-model`，能力铸造挂在服务端 runId 下。
3. **流式开始/增量/结束及错误转 AG-UI；非空；错误/缺终态不伪装成功** — PASS。stream-events 7 例（含 `error_never_becomes_success`、`suspension_has_no_success_terminal`、`missing_terminal_is_failure`、`unknown_control_chunk_rejects`、`tool_chunks_normalize_with_stable_call_ids`）；browser 正文含 RUN_STARTED→TEXT_*→RUN_FINISHED 非空回答。
4. **每次模型调用经原网关能力与上界；非法上限/402/未知价格/未知用量原规则** — PASS。`two_steps_issue_distinct_capabilities`（2 步 2 能力 2 确认、settlementClean）；`spent_budget_narrows_next_capability`（ceiling 100 → 两次铸造 [100,30]）；`budget_402_no_retry`（1 次模型步、无 RUN_FINISHED、`classifyGovernedRunFailure`→`MODEL_BUDGET_EXCEEDED`）；`malformed_usage_no_clean_finish`（0 确认、settlement 不清白）；网关适配器 confirmUsage/markUnknown 未改（diff 零触碰）。
5. **付款方式运行前固定；API 积分拒绝不改走订阅；订阅路径费用归属保持且有兼容证据** — PASS。`subscription_never_falls_back_from_credit_refusal`：mastra 配置 `type:"custom"` 且无 `model` 属性（不存在 PlanModel 分支可回退）；`budget_402` 证明拒绝终局不二次拨号；订阅/legacy 路径代码零改动（else 分支原样），`mastra-compatibility.test.ts` 8/8 保持绿。
6. **持久化+用量确认后仅 owner 完成；stop 精确；断连≠取消；重连不重复计费/消息** — PASS（重连重放为后续票深化）。`event_append_failure_prevents_success`（append 失败 → `MODEL_EXECUTION_FAILED` 落账、零 complete、无成功终态）；`stale_attempt_cannot_complete`（complete 拒绝 → 无 RUN_FINISHED）；`disconnect_does_not_product_cancel`（无 user_requested stop/cancel，弃跑被如实结算为 failed）；`suspended_run_not_completed`；正常路径恰一次 complete + 恰一次 usage confirm。断连后重连重放（messages/events 不重复计费）属 ME03/ME05 的恢复切片，本票以 resume 契约字段（`ResumeRef` 拒绝执行 `EXECUTION_RESUME_UNSUPPORTED`）钉住边界。
7. **一笔调用一组权威结算/观测关联；不把测试范围切成全员默认** — PASS。每步一能力一确认（issued==confirmed 且 unknown=0 才算清白）；executionKey 服务端每 admission 一次（governed-execution.ts L185-187）；默认引擎未翻转——authorized 测试的控制腿证明无选择器时 legacy 路径照常完成。

## 8. 偏差与环境限制

- **无 disposable-DB 的偏差**：controller 预期 browser-runner 用 me01-fixture 的一次性库模式；最终套件把 `RunService`/`ConversationService`/`EventService` 全部 stub 在服务缝上，被测的 admission/lease/persist/settle/stop 全是生产 runner 代码，因此未触达数据库——一次性库模式保留在需要真库的 ME01 resume 套件中。若 review 要求"runner+真库"，那是 `enterprise/runner-production.test.ts`（既存 2000+ 行套件）的领域，非本票新增。
- **驱红层级**：四个套件按 ADR 0008 属 Bun 层（bun-test-compat，driven 组 `server/tests part 6`）；`E2E_UNIT_SCOPE=server` 对它们不适用（unit config 恰好排除 driven 文件），e2e 证据以 `E2E_BUN_ONLY="server/tests part 6"` 驱动跑为准。
- **既存红（未追，票面豁免）**：`learning-langgraph.test.ts`（需 .env 的真实 provider，2/2 红）；`identity-store.integration.test.ts` 共进程串扰（单跑绿，driver 隔离机制覆盖，属该套件自身状态泄漏的既存模式）。这两者使 part 6 组级判定为红，与本票文件无关。
- **audit 基线**：474 个文件不在 e2e 收集层（461 driven + 5 artifacts + 8 "ours to fix" 既存清单），与本票无关、数量与 base 一致量级。
- 无法重放"实现前的原始 RED"（不回滚继承实现）；以 §5 的实测红→绿为准。
- 环境无 `.env`；Postgres 仅 `openbot-test-pg`(5433)/`openbot-enterprise-test-pg`(5435)，driven 证据用 5433 的 `openbot_test`（215 表，CI 同构）。

## 9. 证据文件

- e2e 输出：`.e2e/mastra-ME02-green/`（driven part 6 run，含 trace）。
- 清单/账本：`docs/verification/e2e-bun-suites.json`、`archive/verification/e2e-file-audit.json`（本会话重新生成）。

## 10. Fix wave: delivery OCR（2026-10-20）

OCR 报告 19 条 findings（ocr-report.txt）全部处置完毕。逐条去向：

### HIGH

1. **e2e-bun-manifest.mjs 丢失前缀岛（§1）** — 已修：删除手写分组，复用 `scripts/lib/e2e-manifest.mjs` 的 `groupsOf()`（同时应用文件名前缀 ISLANDS 与 DIRECTORY_ISLANDS，同一排序与 "part N" 命名）。再生后验证：`app/tests/ai-observability`（10 文件）、`server/tests/billing-credits-writer`（1）、`server/tests/gateway-probe`（2）三个前缀岛全部独立成组；四个 mastra server 套件仍在 `server/tests part 6`、compatibility 在 part 4（driven）。
2. **manifest 双写漂移（§3）** — 已修：输出路径改用 lib 的 `MANIFEST` 常量，payload 保留 `audit` 键与 `directoryIslands`，分组与旧生成器同源（groupsOf），消除两套分组算法。
3. **finish reason 白名单（§9）** — 已修（stream-events.ts onFinish）：`length` → 正常 RUN_FINISHED 终态（治理预算截断由 runner 结算）；`tool-calls` → 非终态，与 `suspended` 同待遇（无成功终态，ME04 拥有真实语义）；`content-filter` → RUN_ERROR（emitRunError）。测试 ×3（含 `length` 终态恰一次：重复 finish + 终态后继块不再发事件）。

### MEDIUM

4. **me01-child.ts 连接池泄漏（§3 报告条目）** — 已修：main() 内 try/finally 包住 store 生命周期，删除两处重复 `await store.close()`；`ME01_CHILD_RESULT_PREFIX` 输出契约与 exitCode 语义不变（SUSPENDED_RUN_NOT_FOUND 仍 exitCode=1）。
5. **EXECUTION_BINDING_MISMATCH 字段不全（§5）** — 已修（governed-agent.ts）：补齐 `executionKey` 与 scope 三身份字段（tenantId/workspaceId/principalId）逐字段比对。
6. **治理拒绝无直测（§6）** — 已修：新增 describe "governed execution refusal matrix" ×5（下述测试名），全部断言 marker 字符串；含携带 executionBinding 的协作体"逐字段一致→通过闸门并到达引擎拨号（PROBE_GATE_PASSED 探针）"方向。
7. **MASTRA_TEXT_ONLY_SLICE 零覆盖（§8）** — 已修：×2 迭代期失败测试（granted tool；computerGuidance），并实现 §13 守卫扩展使可达面显式化。
8. **KNOWN_CHUNK_TYPES 缺口（§14）** — 已修：`tool-error` 显式分支 → RUN_ERROR（错误文本经 markUntrusted 包 `tool {id} execution error`）；`reasoning-start/delta/end/signature`、`redacted-reasoning`、`response-metadata`、`raw` 显式进 allow-list，注释载明它们不进本模块任何控制分支（无法改变业务控制流），绝非静默 UNKNOWN。

### LOW（全修）

9. **me01-fixture 建库残留（§4）** — CREATE DATABASE 之后的步骤包 try/catch，失败先 DROP DATABASE/ROLE 再 rethrow。
10. **createGovernedMastraExecution 死代码（§7）** — grep 证实仓库内零引用（仅定义处），已删除；随删 governed-agent.ts 中因此未用的 GovernedModelRequest import。
11. **executionKey 铸造时机（§10）** — 移入 `bind()`：每次绑定铸造新 key，引擎 run id 与所绑 {attemptId, generation} 恒 1:1（governed-execution.ts）。
12. **帧对称（§11+§12）** — `text-end` 无未关门 id（含重复 END）抛 UnknownMastraChunkError；`tool-call-delta` / `tool-call-input-streaming-end` / `tool-result` 未先见 announced call 同样抛。测试 ×2（text_end_without_open_start_rejects；tool_frames_without_an_announced_call_reject）。
13. **events 无界增长（§15）** — 构造器加 `{ streaming?: boolean }`；streaming 模式 push 返回切片后清空缓冲，batch（normalizeMastraChunks）保持累积语义；execution.ts 传 `streaming: true`。测试 streaming_mode_hands_off_events_without_accumulating（交接序列与 batch 等价 + result.events 为空 + outcome 保持）。
14. **onError 序列化（§16）** — `jsonText()` 兜底：message 缺失且 JSON.stringify 抛错（循环引用）时回落 "model stream error (unserializable payload)"；tool-error 分支同用。测试 unserializable_error_payload_still_emits_a_run_error。
15. **模型包装白盒（§17）** — mastraLoopModel 改为全转发 Proxy，仅拦截 doStream 叠加 stripMastraRequestBookkeeping（与 ME01 探针包装同形）；doGenerate 等其余面直通。
16. **computerGuidance 守卫（§13）** — text-only 守卫加 `computerGuidance !== undefined`（ME06 接线浏览器工具前 fail-closed）。
17. **NO_GOVERNED_MODEL 哨兵（§18）** — `MastraExecutionCompletion.governedModel` 改必填；run() 对缺失 completion/governedModel 抛 `MASTRA_AGENT_GOVERNED_MODEL_REQUIRED`（订阅前、零请求构造）；哨兵删除。测试 run_without_governed_model_fails_fast；原两处无 completion 的 ag-ui 测试改持 required completion。
18. **生成器提前终止（§19）** — execution.ts finally 中 `await reader.cancel().catch(() => undefined)` 先于 `reader.releaseLock()`。

### 新增测试（17 条，全部实跑非空洞）

- mastra-stream-events.test.ts ×9：`finish_reason_length_is_a_normal_single_terminal`、`finish_reason_tool_calls_has_no_success_terminal`、`finish_reason_content_filter_is_an_error_terminal`、`tool_error_chunk_is_a_wrapped_run_error`、`engine_metadata_chunks_are_explicitly_ignored`、`text_end_without_open_start_rejects`、`tool_frames_without_an_announced_call_reject`、`unserializable_error_payload_still_emits_a_run_error`、`streaming_mode_hands_off_events_without_accumulating`
- mastra-governed-execution.test.ts ×7：`missing_governed_model_refuses`、`unbound_execution_binding_refuses`、`binding_mismatch_refuses_on_every_published_fact`、`consistent_binding_passes_the_gate_and_reaches_the_dial`、`resume_requests_refuse`、`bot_with_granted_tool_fails_at_iteration`、`bot_with_computer_guidance_fails_at_iteration`
- mastra-ag-ui-agent.test.ts ×1：`run_without_governed_model_fails_fast`

### 命令结果（真实计数）

- `ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-stream-events.test.ts server/tests/mastra-ag-ui-agent.test.ts` → **19 pass / 0 fail**（123 expect）
- `bun test server/tests/mastra-governed-execution.test.ts` → **14 pass / 0 fail**（49 expect）
- `ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-browser-runner.test.ts server/tests/mastra-agent-resume-process.test.ts server/tests/enterprise/mastra-compatibility.test.ts` → **15 pass / 0 fail**（90 expect；resume 子进程跨进程恢复保持绿，me01-child try/finally 后 exit 语义正常）
- `bun run --cwd server typecheck` → 仅 scripts/bootstrap-local-gateway.ts 既有 3 条基线错误（L106/108/120），**本波零新增**
- `bunx biome check`（12 个触及文件）→ 触及文件全清；copilot.ts / governed-execution.ts 仅剩 HEAD 既有 findings（stash 对照逐规则计数 diff 为空，非本波引入）
- `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs` → 474 审计账本再生；清单岛结构验证如上（三个前缀岛 + 两目录岛 + audit 键）
- 驱动组：`E2E_BUN_ONLY="server/tests part 6"`（含五个 server mastra 套件）→ **passed**；`E2E_BUN_ONLY="server/tests part 4"`（含 enterprise/mastra-compatibility）→ **passed**（需 `TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test`，与 CI 同构；证据 `.e2e/me02-ocr-fix/`）。原生层 147 失败全部为本工作树环境类（83×WORKSPACE_FORBIDDEN 无企业目录库、schema 漂移、cwd 相对 ENOENT 等）：stash 全部改动后 HEAD 态 runner-production 同样 42 红，证实非本波引入；触及文件在失败清单中零出现。

---

## Fix wave 2: recheck OCR（2026-10-20，15/15 findings 全处置）

### HIGH

1. **manifest dual-writer（§1）** — 采用收敛裁决：`scripts/lib/e2e-manifest.mjs` 的 `writeManifest()` 成为唯一写者，payload 固定为 `{generatedBy, audit, groups, directoryIslands: DIRECTORY_ISLANDS, files, artifacts, causes}`；`e2e-bun-manifest.mjs` 改调 `writeManifest()`（不再直写 `writeFileSync`），并**保留**其他写者记录的 `causes`（过滤到仍在清单上的文件）+ 透传 `audit` 路径。5 个调用方（e2e-batch-drive-bun-test / e2e-add-driven / e2e-fix-collection / e2e-route-failures / e2e-import-boundary）的实参本就来自 `readManifest()` 的 `{files, artifacts, causes}` 形状，与新签名天然兼容，`causes` 写入行为全部保留；`e2e-import-boundary.mjs --apply` 仍直写旧形状，属退役候选（本轮未动，见 Concerns）。再生验证：`directoryIslands` 在；groups 33 组、组名与组内文件与再生前**逐组相同**；6 个 mastra 套件全部仍 driven。

### SECURITY-MED

2. **fail-open 缺口（§2）** — `governed-agent.ts`：`if (!facts) throw MastraGovernedExecutionRefusal("EXECUTION_BINDING_UNBOUND")`——方法缺失与返回 null 一律拒绝，`request.binding` 不再被整体信任。新增测试 `execution_binding_method_missing_refuses`（stub 省略 `executionBinding` 字段）。

### MED

3. **scope 比对不完整（§3）** — 抽取 `scopeIdentityEquals()`（tenantId/workspaceId/principalId/actorId/memberEpoch/aclEpoch/entrypoint 全 7 字段）进 governed-agent.ts 并接入 MISMATCH 门。测试扩为对 4 个新字段（actorId/memberEpoch/aclEpoch/entrypoint）逐字段断言 `EXECUTION_BINDING_MISMATCH`。
4. **execution.ts 拒绝零覆盖（§11）** — 未建新文件（无 manifest 增量），在既有 driven 文件 mastra-governed-execution.test.ts 新增 describe「mastra execution message-family refusals」×4：`non_text_content_parts_refuse`（file part → ME03_MESSAGE_PARTS_UNSUPPORTED）、`unknown_wire_role_refuse`（role "developer" → 拒绝）、`system_and_tool_history_skipped_user_text_runs`（system/tool 跳过后 user 文本正常全程跑通 + settlementClean）、`empty_relayed_history_refuses`。实现细节：正常路径用每拨号新建 Response 的 `freshTextTurn()`（共享模块级 TEXT_TURN 的 body 单次可读，先跑的 client_route_override_inert 会消耗它）；事件断言直接收集原始 BaseEvent 以覆盖 delta。
5. **me01-child 池泄漏（§6）** — `buildMe01Stack` 移入 try，`let stack: … | undefined`，`finally { await stack?.store.close(); }`——构建中途失败（DDL 在已建池后报错）也能关池退出。
6. **buildMe01Stack 失败路径（§7）** — `new PostgresStore()` 之后整段包 try/catch，`await store.close().catch(() => undefined)` 先于 rethrow，所有调用方天然安全。

### LOW（全修）

7. **executionKey 惰性铸造（§4）** — `let executionKey: string | undefined;`，`bind()` 铸造；`executionBinding()` 在 `!binding || executionKey === undefined` 时返回 null（由 UNBOUND 拒绝兜住），类型本身表达「key 诞生于 bind」。随删因此暴露的死 import `RunnerRequestLease`（biome noUnusedImports，位于本波触及文件内）。
8. **MastraExecutionRefusal re-export（§5）** — 从 governed-agent.ts 删除（import 具名引入与 export 语句都删）；全库 grep 证实零消费方，无需改任何 import。
9. **drop() 逐条容错（§8）** — 两条 DROP 各自 `.catch(() => undefined)`，与 bootstrap 失败路径对称；finally 中抛错不再掩盖原始断言错误。
10. **fake provider 健壮性（§9）** — `request.on("error", () => response.destroy())` + `JSON.parse` try/catch 回 400 JSON（`ME01 fake provider: invalid JSON body`）。
11. **CREATE ROLE dollar-quoting（§10）** — `PASSWORD $$${password}$$`，注释载明 psql -c 无参数绑定、execFile 无 shell 展开故 `$$` 安全。
12. **空历史守卫（§12）** — toModelMessages 末尾 `converted.length === 0` 抛 `ME03_MESSAGE_PARTS_UNSUPPORTED: … empty model history`；测试 `empty_relayed_history_refuses`。
13. **`"error" in queued`（§13）** — ag-ui-agent.ts 桥接层改键存在性判别，`subscriber.error(undefined)` 不再被吞成挂起。
14. **`void computerGuidance;`（§14）** — 删除。（过程记录：本次编辑一度误删了 return 语句体，随即发现并原样修复，最终状态由下方全部测试与 typecheck 验证。）
15. **vendors 段落分歧（§15）** — 仅改注释：载明 connected-but-not-held vendor 段落为 ME04 的**有意延后**、与 legacy 的临时分歧；不引入任何行为变化。

### 命令结果（真实计数）

- `ME01_TEST_PG_PORT=5433 bun test ./tests/mastra-governed-execution.test.ts` → **19 pass / 0 fail**（62 expect；14→19，新增 5 测试全绿）
- `ME01_TEST_PG_PORT=5433 bun test ./tests/mastra-stream-events.test.ts ./tests/mastra-ag-ui-agent.test.ts ./tests/mastra-browser-runner.test.ts ./tests/mastra-agent-resume-process.test.ts ./tests/enterprise/mastra-compatibility.test.ts` → **34 pass / 0 fail**（164 expect；既有套件零回归，resume 子进程 exit 语义正常）
- `bun run --cwd server typecheck` → 仅 scripts/bootstrap-local-gateway.ts 既有 **3 条基线**错误，本波零新增
- `bunx biome check`（触及 10 文件）→ 脚本/套件/其余源文件全清（两 .mjs 已 format --write）；剩 `copilot.ts`（2635–3301 的 noConsole/noUnusedFunctionParameters/noUnusedVariables）与 `governed-execution.ts:296` noConsole（M-j 诊断日志，故意保留）——两文件本波编辑 hunks（≤2227 / 2 处注释与删行）均不在 finding 行上，为前波遗留非本波引入；HEAD 版 copilot.ts stdin 对照为 3 条，佐证增量来自本分支早前未提交波次
- `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs` → **1029 audited · 461 driven · 33 groups**（与再生前逐组相同）· 5 artifacts · 8 待修（agent-computer web-bot-auth ×2、agent-langgraph history、app auth-client/channel-order/channel-search/channel-unread/mark-open-channel-read——全部既有 Cannot-find-package/Invalid-base-URL 类环境缺口，非本波引入）
- 驱动组：`E2E_UNIT_SCOPE=tests E2E_BUN_ONLY="server/tests part 6" ME01_TEST_PG_PORT=5433 e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` → **passed**（含五个 server mastra 套件）；`… E2E_BUN_ONLY="server/tests part 4" ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test …` → **passed**（65.2s，含 enterprise/mastra-compatibility）
- SHA256：`docs/plans/2026-10-19-mastra-execution-run/checkpoints/me02-ocr-fix2/sha256.txt`（10 触及文件 + 2 再生产物）

### Concerns

- `scripts/e2e-import-boundary.mjs --apply` 仍直写旧 payload 形状（spread 旧 manifest + 覆写 groups/files/causes，会丢 directoryIslands/audit）。5 个 `writeManifest` 调用方已收敛，此脚本是清单写者中唯一残留；报告 §1 给的选项是「收敛或退役其余写者」，本波未退役它——建议 ME04/收口波处置或把它也切到 `writeManifest()`。
- ME03 并行进行中：其文件（message-parts.ts / conversation-runtime.ts / enterprise/conversations/** / channels/attachments.ts / app/**）本波零触碰；mastra-message-parts.test.ts 亦未触碰。
