# OCR Fix Wave 4 Report — ME04+ME05 delivery-close round 4（findings R4-1..R4-22）

- Date: 2026-10-20
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`，branch `1123786563/mastra-exec`
- BASE: `bf64d0f2`（与 ME01–ME05 共享同一棵未提交树；本 wave 未 commit/push/stash，git 状态未动）
- OCR findings: `ocr-me04-me05-r4.txt`（22 条）；brief: `ocr4-fix-wave-brief.md`
- 结论：**22 项全部处理（21 项编号 + 报告尾部的 style·L 嵌套三元项 = R4-22）**；R4-11/R4-2/R4-6/R4-7/R4-9/R4-12/R4-13/R4-16/R4-17/R4-18/R4-19/R4-20/R4-21 均有 RED→GREEN 证据（§2）；验证门保持并如实记录（§3）。

## 1. 逐项 disposition

| # | 级别 | 判定 | 落点与做法 |
|---|---|---|---|
| R4-11 | bug·HIGH | **已修（TDD，RED 先行）** | `stream-events.ts` tool-call-approval 分支显式 `this.suspendedByToolCalls = false`（真实审批挂起优先于早前 tool-calls 步末标记）。测试 `approval_pause_supersedes_an_earlier_tool_calls_step_end`：step1 finish(tool-calls) → step2 tool-call-approval → outcome "suspended"、suspendedToolCallId "call_2"、无 RUN_ERROR/RUN_FINISHED（RED 证据 §2.1）。execution.ts:351 的 onSuspension 门（`outcome === "suspended"`）由此恢复可达 |
| R4-19 | bug·M | **已修（TDD）** | `onError`、tool-error 分支、finish reason "error" 三处对齐 stop/length 分支：`if (this.outcome === "aborted") return/break;`。测试 `error_frames_after_a_recorded_abort_keep_the_aborted_outcome` 覆盖三条序列（abort→error / abort→tool-error / abort→finish(error)），outcome 保持 "aborted"、terminal-less。content-filter 分支**未**加防护（finding 只点名三处；最小改动），见 §4.3 |
| R4-17 | bug·M | **已修（TDD）** | text-start 查重：`openTextIds.has(id)` → 具名拒绝 `MASTRA_STREAM_MALFORMED_CHUNK: duplicate text-start for an open message id`。测试 `duplicate_text_start_rejects` |
| R4-18 | bug·M | **已修（TDD）** | 新增可删除集合 `openStreamingCalls`（streaming-start 加入、streaming-end 删除）：(a) streaming-start 重发或合并态 tool-call 之后再 streaming-start → 具名拒绝 "duplicate streaming start for an already announced call"（查 openStreamingCalls ∪ announcedToolCalls）；(b) streaming-end 以 `openStreamingCalls.delete` 失败即拒绝（沿用既有 "before streaming start" 文案——重复 END 语义上同样是 START 不开放）；(c) tool-result 新增 `emittedToolResults` 以合成 messageId 去重（重复 result 静默跳过，与合并态 tool-call 的既定 dedup 先例一致，不重发帧）。测试 `duplicate_tool_streaming_frames_reject_or_dedup` 四段断言。**语义收紧说明**：合并态 tool-call 之后再发 streaming-end，旧行为会重发 TOOL_CALL_END，现在拒绝——与 (b) 同一机制的直接推论，无既有测试依赖旧行为 |
| R4-13 | bug·M | **已修（TDD）** | 新增 `closeOpenLifecycles()`：emitRunError 与 emitRunFinished 发终态前，openTextIds 逐个补 TEXT_MESSAGE_END、openStreamingCalls 逐个补 TOOL_CALL_END，随后清空两集合。测试 `terminal_closes_engine_left_open_lifecycles`（text-start→delta + streaming-start → error → 客户端收到 TEXT_MESSAGE_END + TOOL_CALL_END + RUN_ERROR）。aborted/suspended 保持 terminal-less 不收拢（业务生命周期接管，契约不变） |
| R4-12 | bug·M | **已修（TDD）** | 合并态 TOOL_CALL_ARGS 的 `JSON.stringify(payload.args ?? {})` 与 TOOL_CALL_RESULT 的 `JSON.stringify(payload.result ?? null)` 改 `jsonText(...)`。测试 `cyclic_tool_payloads_still_emit_frames`：循环引用 args/result → 帧仍发出（fallback 文案），不抛裸 TypeError |
| R4-21 | bug·L | **已修（TDD）** | unknown-chunk 诊断改 `jsonText(chunk).slice(0, 200)`。测试 `cyclic_unknown_chunk_still_rejects_with_named_error`：循环引用 chunk → 抛出的仍是 UnknownMastraChunkError（消息含 MASTRA_STREAM_UNKNOWN_CHUNK），不是 TypeError |
| R4-20 | bug·L | **已修（TDD）** | result getter 的 suspendedToolCallId 门控为 `outcome === "suspended" && !suspendedByToolCalls && approvalPendingToolCallId`。测试 `suspended_tool_call_id_absent_when_outcome_leaves_suspension`：approval 后跟 error → outcome "errored"、字段不存在。（R4-11 落地后 `!suspendedByToolCalls` 与 `approvalPendingToolCallId 已设` 恒一致，三条件是冗余防御而非漂移源） |
| R4-15 | maint·L | **已修** | `jsonText(value, fallback = "unserializable payload")`——去 "model stream error" 场景绑定措辞；tool-error 分支用场景化 fallback `"tool execution error (unserializable payload)"`；onError 用默认值（其语义本就是 model stream error）。前缀区分：`MASTRA_STREAM_UNKNOWN_CHUNK` 只用于**未知类型**（shapeless chunk / 不在词表内的 type，2 处），`MASTRA_STREAM_MALFORMED_CHUNK` 用于**已知 chunk 载荷/帧畸形**（switch 内全部 15 处 throw，含 R4-17/R4-18 新增）。既有测试无前缀断言需被动更新；主动把 3 个既有 reject 测试（unknown_control_chunk / text_end_without / tool_frames_without）升级为完整前缀断言。冻结 fixtures 复核：`MASTRA_STREAM_UNKNOWN_CHUNK` 仅存在于 stream-events.ts 与历史 review 存档（me02/review-package.md 是评审时点快照，不改写历史），无活动 fixture 需要再生成 |
| R4-14 | maint·M | **已修** | 13 处 `as unknown as BaseEvent` 双重断言全部改为按 @ag-ui/client 具体事件类型直接构造（`const start: TextMessageStartEvent = { type: EventType.TEXT_MESSAGE_START, ... }`），import 具体类型 + EventType 枚举。0 处残留；字段错误（拼写/缺字段）现在编译期暴露 |
| R4-16 | maint·L | **已修（TDD）** | 选择**实现**（brief 允许二选一）：end() 重构为单出口，终态处理后 `if (this.streaming) this.events.length = 0`——流式模式下 result.events 在所有结束路径为空，与 push 一致。测试 `streaming_end_clears_the_buffer_on_failure_paths_too`（no-terminal 路径：tail = [TEXT_MESSAGE_END, RUN_ERROR]、result.events 空） |
| R4-2 | bug·M | **已修（TDD）** | `createProducedMessageCollector` 新增 `lastResultLanded` 锚点：TOOL_CALL_RESULT 置位、TEXT_MESSAGE_START 重置；TOOL_CALL_START 归属条件改 `lastAssistant !== null && !lastResultLanded`——R1 之后无新文本的调用经 `assistant-call-<id>` 开自己的宿主。集成测试 `silent_tool_round_opens_a_new_host_message`（专有线程）：A1(text+call_r1)→R1→call_r2→R2 → 持久化为 [user, a1(call_r1), r1, host2(call_r2), r2]，因果顺序正确（RED 证据 §2.2） |
| R4-3 | perf·L | **已修** | `callsById: Map<toolCallId, {call, message}>`：TOOL_CALL_START 注册一次（去重 break 时不注册），TOOL_CALL_ARGS O(1) 查找；线性扫描 `callFor` 删除 |
| R4-4 | maint·L | **已修** | `UUID_STRING_LENGTH = 36`（具名常量 + 注释来源）+ 导出 `MAX_CLIENT_MESSAGE_KEY_LENGTH = 200`；`MAX_ENGINE_MESSAGE_ID_LENGTH = MAX_CLIENT_MESSAGE_KEY_LENGTH - (UUID_STRING_LENGTH + 1)`；删除模块加载期 `randomUUID()` 调用及 `node:crypto` import。service 侧消费：`appendEngineMessage` 的 `assertInputString(input.clientMessageKey, ..., MAX_CLIENT_MESSAGE_KEY_LENGTH)`（一行置换）。**偏差**：service.ts:1022 的 user append 路径仍为裸 200——任务范围限定「one-line swap」，user 路径与 engine key 组合预算无关（见 §4.4） |
| R4-5 | maint·L | **已修** | `snapshot()` 返回 `structuredClone(entry.message)` 拷贝，注释写明隔离动机（终态后迟到 push / 调用方原地修改不得污染已缓冲/持久化快照）；消息量级小，clone 成本可忽略。集成测试的 persist→load 全链路实际执行了该路径 |
| R4-6 | bug·M | **已修（TDD）** | tool 分支重写：字符串 content 无条件产出 tool-result part（空串含）；数组分支拼接后同样无条件；既非 string 又非 array（含 undefined/null/数字）→ 具名 `MASTRA_PERSIST_TOOL_CONTENT_UNSUPPORTED`。测试 `empty_tool_result_content_is_persisted_not_dropped`：空串 → part 存在 + 空数组 content → part 存在 + sanitize 配对保住（dangling call 不再产生）+ 畸形 content（42 / undefined）具名拒绝（RED 证据 §2.3） |
| R4-7 | bug·M | **已修（TDD）** | 选 brief 方案 (b)：assistant envelope 全部 parts 为 activity 时按 activity 语义重建（`activityMessageOf`，role "activity"，content = activityType、payload 字段恢复），调用方 role 过滤生效；`full.role === "activity"` 分支同一 helper 恢复 activityType/payload（替换硬编码 "activity" 占位）。测试 `activity_only_envelopes_rebuild_as_activity_not_empty_assistant`（RED 证据 §2.4）。**附带收紧**：role "activity" 但无 activity part 的 envelope（手改/损坏行）从「重建 content:"activity"」改为抛 Corrupt——"anything unprovable is corrupt" 契约，见 §4.5。既有集成测试 `activity_rows_do_not_poison_subsequent_turns` 不受影响（rebuild 后仍被 filter 拦截） |
| R4-9 | bug·L | **已修（TDD）** | parseStoredFullMessage 的 tool-result isError：非 undefined 且非 boolean → `MastraMessagePartsCorruptError("tool-result isError must be a boolean")`（避免 finding 草案的 IIFE 嵌套三元，用前置守卫）。测试 `non_boolean_tool_result_isError_is_corrupt`："true"/1 → Corrupt；缺省 → false（语义不变）（RED 证据 §2.5） |
| R4-1 | maint·L | **已修** | 提取 `filePartFor(attachmentId)`（含占位 mime 注释：真实类型由附件存储决定、resolvePart 按存储 mime 选模态），stored 分支与 legacy 分支共用；`attachmentUrlFor` 纯转发包装删除，直调 `attachmentUrl` |
| R4-8 | maint·L | **已修** | textParts 计算下沉 legacy 分支（stored 分支不再白付 filter+map 扫描）；`legacyText = textParts.join("")` 只算一次 |
| R4-10 | doc·L | **已修** | storedMetadataOf 注释修正：仅 user 行（及 legacy 行）保留 identity metadata；engine 输出行（assistant/tool 重建）不挂 metadata——其引擎 id 已体现在 message.id 上，消费方不得依赖 metadata.openbotEngineMessageId |
| R4-22 | style·L | **已修** | r4.txt 第 11 条（message-parts 495-498 嵌套三元）：提取 `contentWithFileParts(text, fileParts)` helper，stored user 分支与 legacy 分支共用——两处嵌套三元消除，且与 R4-1 的构造逻辑收敛到同一处。legacy 语义精确保留（files 仅 role==="user" 时进入 content） |

## 2. RED → GREEN 证据（bug 项全记录）

测试先行：13 个新测试在未修代码上运行，全部 FAIL（RED），随后实现转 GREEN。逐项：

### 2.1 R4-11（最高优先）+ R4-19 + R4-17 + R4-18 + R4-13 + R4-12 + R4-21 + R4-20 + R4-16（stream-events.ts）

对未修代码 `bun test server/tests/mastra-stream-events.test.ts`：

```
(fail) approval_pause_supersedes_an_earlier_tool_calls_step_end      ← R4-11（RUN_ERROR 出现 + outcome errored，即 ME05 挂起被误判为 ME04 截断）
(fail) error_frames_after_a_recorded_abort_keep_the_aborted_outcome ← R4-19（abort 被 error chunk 翻成 errored）
(fail) duplicate_text_start_rejects                                  ← R4-17（第二条 TEXT_MESSAGE_START 被静默放行）
(fail) duplicate_tool_streaming_frames_reject_or_dedup               ← R4-18（重复 START/END/RESULT 均放行）
(fail) terminal_closes_engine_left_open_lifecycles                   ← R4-13（终态缺 TEXT_MESSAGE_END/TOOL_CALL_END）
(fail) cyclic_tool_payloads_still_emit_frames                        ← R4-12（裸 TypeError 逃出 push）
(fail) cyclic_unknown_chunk_still_rejects_with_named_error           ← R4-21（诊断构造自身抛 TypeError）
(fail) suspended_tool_call_id_absent_when_outcome_leaves_suspension  ← R4-20（errored 结果携带 suspendedToolCallId）
(fail) streaming_end_clears_the_buffer_on_failure_paths_too          ← R4-16（result.events 残留 RUN_ERROR）
27 pass → 16 pass / 11 fail（含 3 个升级为完整前缀断言的既有测试，属 R4-15 期望更新）
```

修复后同文件：**27 pass / 0 fail / 99 expect()**。

### 2.2 R4-2（conversation-runtime.ts collector 宿主锚点）

对未修代码（专有线程）：

```
(fail) silent_tool_round_opens_a_new_host_message
  expected roles [user, assistant, tool, assistant, tool]
  received      [user, assistant, tool]          ← call_r2 被折进 a1（持久化为并发兄弟），随后 sanitize 因悬空剥离
```

为排除歧义（空 r2 版本在「修复后」也会因 sanitize 剥离呈现同形失败），用 perl 临时把归属条件翻回旧行为（`lastAssistant !== null && true`）对**最终测试形态**复跑 RED：`14 pass / 1 fail`（同一测试失败）→ 还原修复后 `15 pass / 0 fail`。最终形态的失败即旧代码把「看到 R1 之后才决定的调用」记成 a1 并发调用的直接证据。

### 2.3 R4-6（空 tool 结果）

对未修代码：`(fail) empty_tool_result_content_is_persisted_not_dropped`（`full.parts` 为 `[]`，期望恰 1 个 tool-result part；畸形 content 亦未拒绝）。修复后 GREEN（含 sanitize 配对断言：2 条消息全存活）。

### 2.4 R4-7（activity 不对称）

对未修代码：`(fail) activity_only_envelopes_rebuild_as_activity_not_empty_assistant`（rebuild 出 role "assistant" + content "" 的空 assistant；activity 分支 content 为硬编码 "activity"、payload 丢失）。修复后 GREEN。

### 2.5 R4-9（isError 折叠）

对未修代码：`(fail) non_boolean_tool_result_isError_is_corrupt`（`isError: "true"` 静默折成 false，未抛 Corrupt）。修复后 GREEN（boolean/缺省语义不变断言同测）。

## 3. 命令与真实结果（exit code → 实际计数）

### 3.1 全量绿波（13 文件，清单同 me05/report.md §1.3；无新增测试文件 → 无需清单再生）

```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test <13 文件清单>
→ exit 0；**146 pass / 0 fail / 0 skip；661 expect() calls**（基线 133/614：+13 tests +47 expects）
```

- `mastra-stream-events.test.ts`：18→27 tests（R4-11/19/17/18/13/12/21/20/16 各一），99 expects。
- `mastra-message-parts.test.ts`：11→14 tests（R4-6/7/9），+23 expects。
- `mastra-conversation-runtime.integration.test.ts`：14→15 tests（R4-2，专有线程），68 expects。

### 3.2 engine wiring 守卫（stream-events 的生产消费方 execution.ts 门，波外加跑）

```
同 env bun test server/tests/mastra-engine-wiring.integration.test.ts
→ exit 0；5 pass / 0 fail / 27 expect()
```

### 3.3 Typecheck

```
bun run --cwd server typecheck → exit 2；恰好 3 条基线错误：
  scripts/bootstrap-local-gateway.ts(106,52) (108,53) (120,74) —— 与基线逐条一致
```

### 3.4 Biome

```
bunx biome check server/src/mastra                                    → exit 0（20 files，0 诊断）
bunx biome check <三个测试文件>                                        → exit 0
（service.ts 有 2 条既有 noConsole 诊断：line 491/927，来自此前 wave 的
  MASTRA_FINALIZED_READ_FAILED / MASTRA_STORAGE_PROBE_FAILED 日志，
  非本 wave 引入——本 wave 对该文件仅 import + 一行 assertInputString 置换）
```

### 3.5 波动记录（如实）

修复完成后共 10 次全量运行：9 次 exit 0（146 pass / 0 fail / 661 expects，13.2–16.7s）；
1 次（第 8 次）exit 1，摘要 **146 pass / 0 fail / 1 error**——error 为 `mastra-governed-tools.test.ts`
`budget_402_no_retry_no_route_switch`（故障注入 `ModelInvocationError("MODEL_BUDGET_EXCEEDED", 402)`）
经 @mastra/core 自身 logger（`agent-DsRUDsS_.js:31784 "Error in agent stream"`）在测试窗口之外
异步冒泡为 unhandled error：**零测试失败**，146/146 全过。该文件的 import 图只含 `mastra/tools.ts`
（本 wave 零改动）；按 ADR 0008「只有独自也红才算失败」单独复跑 ×3 全绿（8 pass / 0 fail / exit 0），
随后全量复跑 ×2 亦 exit 0。与 ocr3 wave §3.5 记录的同类间歇现象（当时"1 fail / 1 error，复跑即绿"）
一致，判定为既有故障注入 harness 在负载下的 wall-clock 竞态，与本 wave 改动无关。

## 4. 偏差与决策记录

### 4.1 R4-18 的 dedup-vs-reject 选择

brief 允许「拒绝或去重，不得重复发帧」。落地：重复 **START**（含合并态后补 START）与重复 **END** → 拒绝（与 text-start/text-end 严格对称；END 复用既有 "before streaming start" 文案，其语义就是「无开放的 START」）；重复 **RESULT** → 去重跳过（第一个答案生效）——与文件内合并态 tool-call 既有的 `announcedToolCalls` 静默去重先例一致，且 AG-UI 结果本就以 toolCallId 为幂等键。

### 4.2 R4-13 的收拢范围

只对**发终态**的两条路径（emitRunError/emitRunFinished）收拢。aborted 与 suspended 保持 terminal-less、不收拢——这是文件自己声明的契约（业务生命周期接管），findings 也只要求终态路径。closeOpenLifecycles 同时复用 `openStreamingCalls`（"START 已发、END 未发"与"streaming 开放中"两个集合在本模块的帧序下恒等，单一集合服务 R4-18 与 R4-13，避免第三套簿记）。

### 4.3 R4-19 未覆盖 content-filter

finding 点名 error chunk / finish reason "error" / tool-error 三处，brief 未含 content-filter。content-filter 是 provider 策略终态而非拆除期噪声，业务上与 abort 的叠加语义未定义——按最小改动不扩；若未来需要，模式已就位（一行守卫）。

### 4.4 R4-4 的 service 侧范围

任务限定「one-line swap」。置换的是 `appendEngineMessage` 的 clientMessageKey 校验（与 runtime 组合键配对的唯一消费点）。`append`（user 路径，service.ts:1022）的裸 200 保留——它不参与 engine id 预算推导，替换它属于超范围的一致性清理；如需统一可在后续 wave 一行带上。

### 4.5 R4-7 的附带收紧（activity envelope 无 activity part → Corrupt）

`full.role === "activity"` 且 parts 里没有任何 activity part 的行（写入端回归或手改）原先重建为 content "activity" 的假 activity 消息；现在抛 `MASTRA_MESSAGE_PARTS_CORRUPT`。生产写入方（fullMessageFromAgUi activity 分支）恒写恰一个 activity part，真实路径不可达；属"anything unprovable is corrupt"的契约对齐而非行为变更。

### 4.6 R4-2 测试需要完整第二轮

第二轮调用必须携带它自己的 result（r2）才能通过 sanitize 的悬空调用剥离存活——剥离是该文件既有的读侧清理规则，不是本 wave 的行为。因此测试场景为 A1→R1→call_r2→R2 两轮闭环；宿主归属的判别发生在 collector（persist 前），RED 证据见 §2.2。

### 4.7 其余

- 无新增测试文件（全部落在绿波既有文件内）→ 清单/manifest 不需再生；`server/drizzle/meta/` 未动。
- 触碰文件（全在授权清单内）：`server/src/mastra/stream-events.ts`、`server/src/mastra/message-parts.ts`、`server/src/mastra/conversation-runtime.ts`、`server/src/enterprise/conversations/service.ts`（R4-4 一行置换 + import）、三个对应测试文件。
- me02/review-package.md 等历史存档中的旧前缀文本是评审时点快照，按"不改写历史"原则未更新（亦无活动 fixture 引用旧前缀）。
- scratch/临时 perl 翻转已还原，树内无残留（复核：`lastAssistant !== null && !lastResultLanded` 在位，15/15 integration pass）。
