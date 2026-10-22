# ME03 Report — 聊天刷新与附件往返保留完整历史和稳定顺序 (#475)

- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`，branch `1123786563/mastra-exec`，BASE `bf64d0f2`。**无 commit/push/merge**；全部增量未提交（继承自前一实现者的 T4 后端 + 本会话的 T12 前端验证）。
- 分工：T4 后端（message-parts / conversation-runtime / 授权历史）由前一实现者完成并报绿；本会话从零核实后端声明（§2），随后完成 T12 前端兼容验证（§4）、清单再生（§5）、类型/静态检查（§6）与检查点哈希（§8）。
- 前一实现者的 report.md 不存在（me03/ 目录只有 brief.md）；后端状态按 `git status` 与新文件重建，未重读其实现细节。

## 1. 结论

ME03 六条验收标准全部 PASS（§3）。T4 后端声明经独立复核属实：两个 ME03 后端套件 17 pass / 0 fail（67 expect），六个既有 mastra 守门套件 53 pass / 0 fail，合计 **70 pass / 0 fail（293 expect，8 文件）**。T12 前端按 brief 新增 `app/tests/mastra-runtime-compat.test.tsx` 五个具名用例，**5 pass / 0 fail**；五个用例全部在现有客户端上直接通过，**没有需要修复的真实客户端缺口，未改动任何前端源码文件**（brief 允许改动清单一个都未触碰，见 §6 边界说明）。

## 2. 命令与真实计数（全部为实际运行结果）

### 2.1 后端直接计数（Bun 层，ADR 0008）

| 命令 | Exit | 结果 |
| --- | --- | --- |
| `ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-message-parts.test.ts server/tests/enterprise/mastra-conversation-runtime.integration.test.ts` | 0 | **17 pass / 0 fail**（67 expect）：message-parts 8 用例（`tool_pairs_roundtrip`、`attachment_parts_roundtrip_preserves_references`、`corrupt_stored_parts_fail_explicitly`、`stored_role_must_match_row_role`、`legacy_text_rows_rebuild_with_stamped_attachments`、`unsupported_wire_roles_are_refused_not_dropped`、`sanitize_cleanup_rules_survive_the_server_rebuild`、`schema_version_is_frozen_at_one`）+ 集成 9 用例（`tool_pairs_roundtrip`、`attachment_scope_checked_before_bytes`、`same_input_key_one_intent`、`retry_assistant_output_does_not_duplicate`、`candidate_seq_not_visible_until_finalized`、`other_resource_cannot_read_thread`、`restart_preserves_full_parts`、`client_forged_history_never_becomes_authoritative`、`corrupt_history_fails_explicitly`），一次性受限库 fixture（`openbot_me03_<rand>`，teardown drop） |
| `ME01_TEST_PG_PORT=5433 bun test <上两文件 + 六个守门套件，共 8 文件>` | 0 | **70 pass / 0 fail**（293 expect）。70 − 17 = **53**，与控制器基线“six guard suites 53”精确一致（守门套件：mastra-agent-resume-process、enterprise/mastra-compatibility、mastra-stream-events、mastra-ag-ui-agent、mastra-governed-execution、mastra-browser-runner，零回归） |

### 2.2 驱动层（e2e 统一调度，ADR 0008 两层制）

| 命令 | Exit | 结果 |
| --- | --- | --- |
| `E2E_UNIT_SCOPE=server ME01_TEST_PG_PORT=5433 E2E_UNIT_OUTPUT=.e2e/mastra-ME03-verify bunx e2e run --config e2e.unit.config.ts <8 文件>`（再生清单**之前**） | 非零 | **整轮中止**：`COLLECTION_ERROR … mastra-conversation-runtime.integration.test.ts: Received protocol 'bun:'`，`no test files`。这正是 ADR 0008 的两层制边界：bun 依赖套件必须先入驱动清单、由 e2e 驱动 Bun 执行；教训记录为“先再生清单再跑”，非缺陷 |
| `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs`（第一次，后端文件入册） | 0 | 1031 files · 463 kept on Bun runtime · 33 driven groups；`mastra-conversation-runtime.integration.test.ts` → `server/tests part 4`，`mastra-message-parts.test.ts` → `server/tests part 6` |
| `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs`（第二次，前端文件入册后终态） | 0 | 1032 files · **464 kept on Bun runtime · 33 driven group(s)**；`app/tests/mastra-runtime-compat.test.tsx` → **`app/tests part 3`**。`directoryIslands`（`app/tests part 1..4`、`server/tests part 1..N` 等）与前缀岛全部保留，未回退 `groupsOf()` |
| `E2E_UNIT_SCOPE=tests E2E_BUN_ONLY="server/tests part 6" ME01_TEST_PG_PORT=5433 E2E_UNIT_OUTPUT=.e2e/me03-t12-part6 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | 0 | **passed**（4.68s）：含 `mastra-message-parts` + 五个守门套件 + `learning-mastra` |
| `E2E_UNIT_SCOPE=tests E2E_BUN_ONLY="server/tests part 4" ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test E2E_UNIT_OUTPUT=.e2e/me03-t12-part4 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | 0 | **passed**（65.3s）：含 `mastra-conversation-runtime.integration`（真实 DB）。组内 2 文件（`craft-routes-assembly`、`enterprise/mastra-compatibility`）仅共享进程时红，driver 自动单独重跑后绿（ADR 0008 补充二规则二：“只在共享进程里红”不算失败），stderr 点名可查 |
| `E2E_UNIT_SCOPE=tests E2E_BUN_ONLY="app/tests part 3" E2E_UNIT_OUTPUT=.e2e/me03-t12-apptests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | 0 | **passed**（34.2s）：含本票 `app/tests/mastra-runtime-compat.test.tsx` |

### 2.3 前端用例（driven，Bun 层）

| 命令 | Exit | 结果 |
| --- | --- | --- |
| `bun test app/tests/mastra-runtime-compat.test.tsx` | 0 | **5 pass / 0 fail**（32 expect）：五个具名用例全绿 |

## 3. 逐条验收判定（docs/tickets/mastra-agent-execution/issues/me03.md 六条）

1. **完整保存文本/文件图片引用/工具对/activity-state-审批 metadata；展示投影≠模型历史 — PASS。** `server/src/mastra/message-parts.ts`：`OPENBOT_MESSAGE_PARTS_SCHEMA_VERSION = 1`（:22）、`OpenBotMessagePart`（:39）、`OpenBotFullMessage`（:65）、`parseStoredFullMessage`（:85，损坏即拒绝）、`fullMessageFromAgUi`（:186）、`agUiMessageFromStoredRow`（:335，重建模型上下文用）。证据：`tool_pairs_roundtrip`（纯转换 + 集成两处）、`attachment_parts_roundtrip_preserves_references`、`legacy_text_rows_rebuild_with_stamped_attachments`、`corrupt_stored_parts_fail_explicitly`。
2. **同一幂等键一个 intent；输出重试不重复；稳定 seq/分页；未 finalized 不进模型上下文 — PASS。** 证据：`same_input_key_one_intent`、`retry_assistant_output_does_not_duplicate`、`candidate_seq_not_visible_until_finalized`（真实 DB 集成套件，candidate seq 对模型上下文不可见）。
3. **ConversationService 唯一写者；禁 Memory 自动 append；snapshot 与会话写入分开 — PASS。** `server/src/mastra/conversation-runtime.ts`：`MastraWriterConversationService`（:45）把全部写入路由进 ConversationService；`loadExecutionInput`（:308）/`persistExecutionMessages`（:362）/`createMastraConversationRuntime`（:394）实现 brief 冻结接口（扩名未改名）。ME01 已证无 Memory 附加（无自动 append 通道）；`server/src/mastra/conversations.ts` intent/seq/锁语义未被绕过。
4. **附件先验 thread/公司/团队/本人权限，再读字节/签发下载；无存在性泄漏 — PASS。** 证据：`attachment_scope_checked_before_bytes`、`other_resource_cannot_read_thread`（第二用户/跨 thread 同一拒绝形状）。
5. **刷新/重连/重启/pending intent 修复保持完整 parts 与调用关系；损坏/缺失历史明确失败不退空历史 — PASS（后端 + 前端两侧）。** 后端：`restart_preserves_full_parts`、`corrupt_history_fails_explicitly`。前端：`partial_text_and_tool_result_render_once`、`reconnect_does_not_duplicate_answer`、`refresh_waiting_approval_can_resume`、`incompatible_legacy_pause_has_clear_next_action`（§4）。
6. **既有历史清理规则保留；客户端伪造 system/tool 历史不成为权威；语音归档读取一致 — PASS。** 后端：`client_forged_history_never_becomes_authoritative`（loadExecutionInput 丢弃客户端 system/tool 历史、以服务端重建为权威）、`sanitize_cleanup_rules_survive_the_server_rebuild`（`sanitizeSeededHistory`/`inlineAttachments` 语义存活，`server/src/copilot.ts` 有改动且被套件覆盖）。前端：客户端读取器 `thread-messages.ts` 的净化语义未动（既有 `thread-messages.test.ts` 在 `app/tests part 3` 组内随组绿）；语音归档读取路径未触碰，`voice-archive` 等套件随同一驱动组通过。

## 4. T12 — `app/tests/mastra-runtime-compat.test.tsx`（新，~560 行）

Harness 沿用 `channel-history-refresh.test.tsx` 的既有形态（`./preload` + `bun-test-compat`、happy-dom GlobalRegistrator、真实 `CopilotKitProvider` + `ChannelChat` 挂载、fetch 边界全 fixture、`core.getAgent` 探针），无活服务器。存储侧 turn 采用 Mastra 后端存储方言（`{id,name,args}` 工具调用、`toolCallId` 结果行），验证客户端不假设旧运行时（Intelligence）私有状态：

1. **`partial_text_and_tool_result_render_once`** — 存储方言四 turn（部分文本 + 工具调用 + 结果 + 回答）经 `readableTurns` 归一后入 transcript；三段文本各恰好渲染一次，且无 “unreadable” 提示（方言不是损坏）。
2. **`refresh_waiting_approval_can_resume`**（仅 UI 态）— 刷新后 `computer_click` 未答调用 + 审批收件箱 pending 请求（同 `toolCallId`）→ `BrowserActivity` 组旁 `PendingApprovals`/`InlineApproval` 渲染 “Waiting for your approval” 卡片；“Allow once” 点击发出 `POST /api/approvals/approval-1/decision {decision:"allow_once"}`。**边界：批准后服务端执行动作一次并续写的 resume 属 ME05，此处只断言客户端可观察的等待态与可用决策通道**。
3. **`stop_targets_current_run`** — 经 `core.runAgent` 起一个流不闭合的在跑 run（fixture 断言 `/run` 收到 runId），Stop 按钮（“Stop the Bot”）出现并点击 → `copilotkit.stopAgent` 恰一次且目标 `agent.agentId === "channel:mastra-compat"`（当前频道 agent 实例，`currentAgent()` 同一性断言），并伴随 `POST /agent/:id/stop/:threadId` 且 body `{runId}` 与在跑 runId **相等**——中断的 turn 不可能与完成的 turn 混淆。
4. **`reconnect_does_not_duplicate_answer`** — 同一回答同时来自网关重连快照（`MESSAGES_SNAPSHOT`）与持久历史读取（同 stable id）→ 渲染一次；roster activity 变更触发 pull 重读同一历史 → 仍一次（`mergeStoredMessages` 按 id 合并）。
5. **`incompatible_legacy_pause_has_clear_next_action`** — sessionStorage 存活的旧会话暂停：调用仍未答 → 通知 “A browser task is paused in this conversation.” + 启用的 “Resume task”；同一暂停但工作已被答 → 不再提供 resume、过期记录被丢弃（无二次执行入口），且 `resumeHandoffTask` 对已答暂停抛出明确句子 “This tool call is already answered.”（可行动的下一步，不是静默重放）。

**修复记录（只动测试夹具，未动客户端）**：三轮失败全部是夹具问题——mounting() 覆盖预置 inbox、activity 补丁缺 bot 字段、happy-dom `location.origin` 为 "null" 使 `new URL` 抛错（`GlobalRegistrator.register({url})` 修复，顺带发现 stop 走 core 的 HTTP stop 端点并携带 runId）。brief 允许清单中的五个客户端文件（channel-chat.tsx、approval-tools.tsx、handoff-resume.ts、thread-messages.ts、stopped-turn.ts）**一个都不需要改**：测试证明客户端对 Mastra 后端历史/审批/停止/暂停语义零假设缺口。

## 5. 清单与分组

- 终态账本：`docs/verification/e2e-bun-suites.json`（33 groups；`app/tests part 3` 含本票前端套件；`server/tests part 4` 含 conversation-runtime 集成；`server/tests part 6` 含 message-parts 与守门套件）、`archive/verification/e2e-file-audit.json`（1032 files / 464 driven / 1 “still ours to fix”：`app/tests/auth-client.test.ts` “Invalid base URL: null”，既有环境项，非本票引入）。
- `scripts/e2e-bun-manifest.mjs` + `scripts/lib/e2e-manifest.mjs`（`groupsOf()`）为前一实现者已改；再生未回退 `directoryIslands` 与前缀岛。

## 6. 类型检查 / 静态检查

| 命令 | Exit | 结果 |
| --- | --- | --- |
| `bun run --cwd server typecheck` | 0 | **恰好 3 个基线错误**（`scripts/bootstrap-local-gateway.ts` :106/:108/:120），零新增 |
| `bun run --cwd app typecheck` | 0 | 干净（修掉本测试文件引入的 2 个类型错后 0 错误；app 基线 0） |
| `bunx biome check app/tests/mastra-runtime-compat.test.tsx` | 0 | clean（`--write` 格式化一次后通过） |

## 7. 触碰文件（继承后端 + 本会话前端）

后端（T4，前一实现者，未提交；本会话仅复核未改）：
- `server/src/mastra/message-parts.ts`（514 行；行号锚点见 §3.1/§3.2）
- `server/src/mastra/conversation-runtime.ts`（412 行；:45/:52/:308/:362/:394）
- `server/src/mastra/execution-contracts.ts`（binding 持久化契约 :35 起）
- 扩展：`server/src/enterprise/conversations/service.ts`、`server/src/enterprise/contracts.ts`、`server/src/copilot.ts`、`server/src/enterprise/runs/governed-execution.ts`、`server/src/mastra/compatibility.ts`
- 测试：`server/tests/mastra-message-parts.test.ts`（265 行）、`server/tests/enterprise/mastra-conversation-runtime.integration.test.ts`（803 行）、`server/tests/support/me03-fixture.ts`（346 行）、`server/tests/enterprise/mastra-compatibility.test.ts`（扩展）

前端（本会话）：
- `app/tests/mastra-runtime-compat.test.tsx`（新，五个具名用例）
- 账本再生：`docs/verification/e2e-bun-suites.json`、`archive/verification/e2e-file-audit.json`
- 本报告与检查点：`docs/plans/2026-10-19-mastra-execution-run/me03/report.md`、`docs/plans/2026-10-19-mastra-execution-run/checkpoints/me03-review/sha256.txt`

## 8. 偏差、环境限制、边界

- **无 commit 授权**：全部增量未提交，哈希检查点见 `checkpoints/me03-review/sha256.txt`。
- **ME05 边界**：resume 的执行（批准后动作一次 + 续写、中断 run 的续跑）属 ME05；本票只断言客户端等待态渲染、决策通道、停止目标 runId、旧暂停不重放。brief 预见的 “resume 本身是 ME05” 边界在用例 2/3/5 内显式注明。
- **两层制操作顺序**：bun 依赖套件在入驱动清单前不能用 `E2E_UNIT_SCOPE=server` 原生跑（会整轮 COLLECTION_ERROR 中止）；正确顺序是先 `e2e-file-audit` + `e2e-bun-manifest`，再 `E2E_BUN_ONLY` 驱动。
- **共享进程假红**：`server/tests part 4` 组内 `craft-routes-assembly` 与 `enterprise/mastra-compatibility` 仅共享进程红、单跑绿（driver 自动隔离重跑，ADR 0008 补充二规则二），不构成失败。
- **审计瞬时态**：第一次审计再生（与后台 bun test 并发时）曾把 4 个 `channel-*` 测试列入 “Cannot find package” 待修；随后干净再生的终态为 1 项（`auth-client`，环境缺 base URL，既有），已持久化为当前账本。
- **环境**：本机测试 Postgres 经 `ME01_TEST_PG_PORT=5433`；集成 fixture 建一次性库 `openbot_me03_<rand>` + 受限角色并在 teardown drop，从不触碰 dev `DATABASE_URL`；驱动组 part 4 需要 `TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test`（与 CI 同构）。
- 未做旧平台全量历史导入（ME13）、未新增自动长期记忆（scope fence 遵守）。

## 9. Fix round 1（2026-10-20，独立评审 F1/I1/I2/M1/M2 处置）

评审五条全部处置完毕，无遗留。生产接线按控制器裁决落在 ME02 seam 内（`copilot.ts` mastraAgentConfiguration + 会话运行时），governed/settlement 契约零改动（runner 的 owner-complete 完结门不变）。

### 9.1 逐条处置

- **F1（Critical）— 生产接线，已修复。** `loadExecutionInput`/`persistExecutionMessages` 原本零生产调用方；现 `copilot.ts` `mastraAgentConfiguration` 的 factory（1）先经新装的服务端 seam `setMastraConversationRuntime`（与 `setBuiltinExecutionEngine` 同形；无 runtime 时 mastra 路径以 `MASTRA_CONVERSATION_RUNTIME_UNWIRED` fail-closed 拒绝，绝不退回浏览器 echo 历史），在运行前 `loadExecutionInput(scope, input)` 重建授权历史——客户端 system/tool/user 历史仅用于取 submitted key 即被整体丢弃；（2）binding 携带经验证的 `threadId`，`ExecutionRequest.input` 即重建后的输入（`executeGovernedMastra` 消费的就是它）；（3）`withPersistedOutput` 包装 hold 住 `RUN_FINISHED`，先 `persistExecutionMessages(binding, snapshot)` 落库、成功后才把成功终态交给 runner——runner 的 settle-complete 只能在终态转发后发生，因此“刷新/分页可见”先于“可完结”；持久化失败则 run 以失败终态（绝不假装成功）。挂起/中止/出错路径无成功终态，不持久化。新增 `createProducedMessageCollector`（conversation-runtime.ts，加法不改冻结接口）：按 AG-UI 协议把 TEXT_MESSAGE_*/TOOL_CALL_* 帧折回引擎产出消息。
- **I1（Important）— 并发同键重试假 503，已修复。** `enterprise/conversations/service.ts`：`append` 与 `appendEngineMessage` 的 catch 在 `writeConfirmed/writeAttempted` 且错误为 `MASTRA_INTENT_FINALIZE_FAILED` 时，先走新增 `readFinalizedMessage`（同一锁后重查 intent 状态 + 存储 digest/seq 校验，与既有 finalized 分支同一验证形状），已由并发方 finalize 则返回完全相同的成功 DTO（同 messageId/seq）；否则维持原 503 `message_pending`。测试 RED→GREEN 实证：禁用收敛分支时 `concurrent_same_key_append_converges_not_pending` 红（503），恢复后绿。
- **I2（Important）— 报告归属，已更正。** §7 原把 `governed-execution.ts` 列为 ME03 扩展；实际它是 **ME02** 产物（#474 T5，本修复轮零改动）。本轮真实触碰文件见 §9.4。
- **M1（Minor）— 用户分支静默 `continue`，已改为具名拒绝。** `message-parts.ts` 用户数组内容循环：text 照旧、`attachmentIdsIn` 可识别的附件 part 照旧走 schema 已建模的 `attachment` kind；其余一切 part 形状抛 `MASTRA_PERSIST_USER_PART_UNSUPPORTED: <type>`，非对象 part 抛 `MASTRA_MESSAGE_PARTS_CORRUPT`（refuse-don't-guess）。
- **M2（Minor）— digest 键序依赖，已修复。** `fullMessageDigestInput` 改为递归 sorted-key canonical JSON（数组保序），digest 只依赖值不依赖键插入序；否则结构相同的 full parts 可能因键序不同被误判 `message_conflict`，破坏输出重试幂等。

### 9.2 新增测试（全部真实命令计数）

| 套件 | 用例 | 证明 |
| --- | --- | --- |
| `server/tests/mastra-engine-wiring.integration.test.ts`（新，3 用例） | `answer_is_persisted_before_complete_and_visible_on_reread` | (a) 真 DB 上 mastra-engine 一轮后，assistant 答案以完整 parts（`openbotParts` schemaVersion 1 + text part + engineMessageId）在会话库可见，二次分页重读（刷新路径）同 row 同内容 |
| | `follow_up_context_comes_from_persisted_history_not_the_wire` | (b) 后续 turn 线上只带 submitted 消息，counting loopback provider 的第 2 次请求体逐字含第一轮 user+assistant（来自服务端持久历史），system 在首位 |
| | `forged_client_history_never_reaches_the_model` | (c) 线上伪造 system/assistant/tool/user 历史，第 3 次请求体 `FORGED-` 零命中，模型上下文恰为服务端持久轮次 |
| `server/tests/enterprise/mastra-conversation-runtime.integration.test.ts`（+1） | `concurrent_same_key_append_converges_not_pending` | I1：(1) 两个同键 engine append 真并发（Promise.all 经锁重叠）双方 fulfilled 且同 messageId/seq；(2) 确定性复现评审点名的交错窗口（钩住 `withConversationLock`，在锁内由“对方”finalize）后重放，收敛为同键同 seq 成功，绝非假 pending |
| `server/tests/mastra-message-parts.test.ts`（+2） | `user_parts_beyond_text_and_attachments_refuse_named` | M1：inline-data image part 抛具名 `MASTRA_PERSIST_USER_PART_UNSUPPORTED: image`，非对象 part 抛 CORRUPT，附件 URL part（任意声明类型）仍建模为 attachment kind |
| | `digest_input_is_key_order_stable` | M2：同值异键序两个 envelope 的 digest 相同；异值 digest 不同 |
| `server/tests/mastra-browser-runner.test.ts`（改造） | `authorized_browser_run_uses_mastra`（增强断言） | SSE 全链：mastra 引擎答案在终态 settle 前已持久化（conversations.rows 恰一行 guided 答案）——ME02 断言的可观察未变，仅按修正后的契约**追加**持久化断言（harness 的 syntheticConversations 扩为真 runtime 可用的 mastra 后端假存储，`harness()` 现常装 runtime，legacy 控制组不受影响） |

### 9.3 命令与真实计数

| 命令 | Exit | 结果 |
| --- | --- | --- |
| `ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-message-parts.test.ts` | 0 | **10 pass / 0 fail**（36 expect；原 8 + 新 2） |
| `ME01_TEST_PG_PORT=5433 bun test server/tests/enterprise/mastra-conversation-runtime.integration.test.ts` | 0 | **10 pass / 0 fail**（41 expect；原 9 + 新 1） |
| `ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-engine-wiring.integration.test.ts` | 0 | **3 pass / 0 fail**（16 expect；新套件） |
| `bun test server/tests/mastra-browser-runner.test.ts` | 0 | **7 pass / 0 fail**（47 expect；数量不变，1 用例增强断言 + harness 扩展） |
| `ME01_TEST_PG_PORT=5433 bun test <上列 9 个后端文件：ME03 三套件 + 六个守门套件>` | 0 | **76 pass / 0 fail（320 expect，9 文件）**；原基线 70 = 本轮 76 − 6 新增（3 wiring + 1 并发 + 2 message-parts），守门 53 零回归 |
| `bun test app/tests/mastra-runtime-compat.test.tsx` | 0 | **5 pass / 0 fail**（22 expect；前端无改动，原绿保持） |
| `bun run --cwd server typecheck` | 0 | **恰好 3 个基线错误**（`scripts/bootstrap-local-gateway.ts` :106/:108/:120），零新增 |
| `bunx biome check <8 个本轮触碰文件>` | 0（test 文件）/ 残留 | 本轮触碰的 4 个测试文件 **clean**；4 个 src 文件仅余**既有**基线诊断（copilot.ts noUnusedFunctionParameters ×4 / noUnusedVariables ×2 / noConsole ×4，service.ts noConsole ×1——全部位于本轮未触碰区域，属 ME02/更早轮遗留），本轮引入的诊断（service.ts useOptionalChain、各测试 unused imports/格式）已清零 |
| `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs`（新增文件后再生） | 0 | 1033 files · **465 kept on Bun runtime · 33 driven groups**（464→465：新套件入 `server/tests` 驱动组）；`mastra-engine-wiring.integration.test.ts` 已注册，still-ours-to-fix 仍为既有 1 项（`auth-client`） |

### 9.4 本轮触碰文件（I2 更正后的真实清单）

生产源码（均在授权 seam/ME03 模块内）：
- `server/src/copilot.ts`（`mastraAgentConfiguration` 接线 + `setMastraConversationRuntime` seam + `withPersistedOutput`；ME02 期文件，ME02 产物 `governed-execution.ts` 本轮**未触碰**）
- `server/src/mastra/conversation-runtime.ts`（+`createProducedMessageCollector`、+`MastraConversationRuntime` 类型，冻结接口未动）
- `server/src/mastra/message-parts.ts`（M1 具名拒绝 + M2 canonical digest）
- `server/src/enterprise/conversations/service.ts`（I1 `readFinalizedMessage` 收敛 + 两处 catch）

测试：
- `server/tests/mastra-engine-wiring.integration.test.ts`（新）
- `server/tests/enterprise/mastra-conversation-runtime.integration.test.ts`、`server/tests/mastra-message-parts.test.ts`、`server/tests/mastra-browser-runner.test.ts`（扩展/改造）

账本与检查点：`docs/verification/e2e-bun-suites.json`、`archive/verification/e2e-file-audit.json`（再生）、本报告、`checkpoints/me03-review/sha256.txt`（追加行）。

### 9.5 边界与说明

- **engine 切换默认未翻转**：`setBuiltinExecutionEngine` 仍无生产调用方（ME02 决定保持）；但一旦部署选择 mastra 引擎，会话运行时即为**必须**——缺装即拒绝，历史权威永远是服务端持久层。
- **execution.ts 未改动**：重建输入经 `MastraAgUiAgent.run(rebuilt)` 自然进入 `ExecutionRequest.input`，持久化在 factory 侧终态前完成，ME02 引擎文件零 diff。
- **ME02 套件适配声明**：`mastra-browser-runner.test.ts` 的 harness 需安装运行时（否则 mastra 选择路径按新契约拒绝）；7 个用例的可观察断言全部保持原语义，仅 `authorized_browser_run_uses_mastra` 追加持久化断言。
- **引擎文本切片边界未变**：重建历史中的附件引用（file parts）在 `execution.ts` toModelMessages 仍按文本切片拒绝——附件进模型上下文属后续票；本轮持久化/重建对附件 parts 的保留不受影响。
- 并发测试用独立线程，避开 `candidate_seq_not_visible_until_finalized` 夹具手工预占 seq 造成的保留位（既有限定，非本轮缺陷）。

## 10. Fix wave: delivery OCR（2026-10-20，ocr-report.txt 30 findings 处置）

评审发现按控制器裁决处置：除 (a) copilot.ts 同步 throw 迁移（推迟到在飞的 ME04 票）、(b) ME04 scratch 文件不动（`server/src/mastra/tools.ts`、`server/tests/mastra-tools.test.ts`、`server/tests/support/me04-harness.ts`、copilot.ts 的 ME04 区域）、(c) newest-N 窗口产品变更不做（只做最小 early-cap-check）、(d) fixture 助手去重重构（仅记录）外，全部修复。本节由第二个修复 agent 收尾完成（前一 agent 在移除 activity 测试临时 debug catch 后耗尽轮次；其遗留的两处未收尾缺陷见 §10.3）。

### 10.1 逐条处置

生产源码（全部已修）：

| 位置 | 级别 | 处置 |
| --- | --- | --- |
| `conversation-runtime.ts` 分页拼接块级乱序 | critical | 已修：`rows.sort((a,b)=>a.seq-b.seq)` 全局升序（:146），`loadAuthorizedRows` |
| `conversation-runtime.ts` activity 行永久毒化线程 | high | 已修：重建后过滤 `role !== "activity"`（:381），早于 sanitize/模型中继 |
| `execution.ts` 已授权附件被 toModelMessages 拒绝 | high | 已修：`textContent` 对 file part 降级为 `[attachment: <url>]` 文本引用（:82-101），与未授权降级同构 |
| `conversation-runtime.ts` 非 mastra 后端误导性失败 | medium | 已修：`resolveMastraBinding` 后 gate `MASTRA_ENGINE_BACKEND_UNSUPPORTED`（:350） |
| `conversation-runtime.ts` endsWith 误删合法附件 | medium | 已修：`value === attachmentUrl(attachmentId)` 精确比对（:288） |
| `conversation-runtime.ts` snapshot tool 结果整体后置 | medium | 已修：单一 `orderedEntries` 有序序列（:618-619），TOOL_CALL_RESULT 按事件序入列 |
| `conversation-runtime.ts` 逐条 append 无同键重试 | medium | 已修：`appendEngineMessageWithRetry`（:404，调用 :463）有界同键重试 |
| `conversation-runtime.ts` 5000 上限页首检查 | perf·medium | 按裁决 (c)：只做最小 early-cap-check（每页读完立即判，:133），newest-N 窗口产品变更明确不做（注释注明） |
| `stream-events.ts` abort 后 finish(stop) 翻转成功 | low | 已修：`if (this.outcome === "aborted") break;`（:399），aborted 终态不可被覆盖 |
| `execution.ts` input.threadId 未绑定 binding | medium | 已修：事件身份取 `binding.threadId ?? input.threadId`（:252） |
| `execution.ts` 重名 GrantedTool 静默覆盖 | low | **被 ME04 取代**：该 `Object.fromEntries` 已被在飞 ME04 的 `createMastraTools`（tools.ts mount-time refusal `MASTRA_TOOL_NAME_COLLISION`，scratch 文件按裁决 (b) 不动）整体替换，重复名即拒绝已实现 |
| `service.ts` parse-back 不等值比较 + `as never` | medium | 已修：canonical digest 复等比对 `fullMessageDigestInput(reparsed) !== fullMessageDigestInput(full)`（:1218），入口补 toolCallId 类型/长度校验（:1190-1196） |
| `service.ts` engineMessageId 164..200 联合不可满足 | low | 已修：上限收紧 163（:1187），注释说明组合 key 预算 |
| `service.ts` appendEngineMessage 缺 legacy 守卫 | low | 已修：prepare 事务内 `currentLegacyMapping` + `authorizedLegacyMapping` → `LEGACY_HISTORY_READ_ONLY`（:1236-1244） |
| `service.ts` I1 收敛裸 catch 无日志 | low | 已修：结构化 `MASTRA_FINALIZED_READ_FAILED`（:463-475，含 context/cause） |
| `service.ts` ~250 行 intent 生命周期双路径复制 | maint·medium | 已修：抽取工厂内共享助手 `appendViaIntentLifecycle`（prepare/write/catch 全收敛），两调用方只传真实差异（legacy 守卫位置、附件副作用开关、memory 行构造回调）；行为逐字保持 |
| `message-parts.ts` assistant/tool 数组 content 静默丢弃 | low | 已修：数组含不可建模 part 抛 `MASTRA_PERSIST_ASSISTANT_PART_UNSUPPORTED`（:278-293），tool 分支对齐 |
| `message-parts.ts` `toolCallId ?? ""` 死分支 | low | 已修：直接用 `full.toolCallId` + 显式 undefined 拒绝（:519-526） |
| `conversation-runtime.ts` `row.seq !== item.seq` 恒假 | low | 已修：删除恒假比较，只留 `if (!row)`（:121） |
| `conversation-runtime.ts` `engineMessageId ?? ""` 死分支 | low | 已修：不再存在该兜底 |
| `ag-ui-agent.ts` run() 同步 throw | low | 已修：`return throwError(() => new Error(...))`（:61） |
| `scripts/lib/e2e-manifest.mjs` audit 透传丢失 | bug·medium | 已修：`readManifest()` 返回 `audit: parsed.audit`（:81），四个写者零改动存活该键 |
| `scripts/e2e-bun-manifest.mjs` 清单缺失即 ENOENT | bug·low | 已修：`existsSync(MANIFEST) ? readManifest() : { files: new Set(), artifacts: new Set(), causes: {} }`（:84-85） |
| `me01-child.ts` String(error) 丢栈 | low | 已修：`error.stack ?? error.message`（:89） |
| `me01-fixture.ts` JSON null 体逃逸 | bug·low | 已修：非对象体回 400 "non-object JSON body"（:172-175） |
| `me03-fixture.ts` CREATE DATABASE 后无失败清理 | maint·medium | 已修：GRANT/角色引导包进 try，失败逐个 DROP ROLE IF EXISTS + DROP DATABASE WITH (FORCE) 后 rethrow |
| `me03-fixture.ts` 迁移子进程 stdout "pipe" 不消费 | low | 已修：`stdout: "ignore"`（:150） |
| `me03-fixture.ts` 凭据清理死代码 | low | 已修：按 `entry.receipt.credentialRef` / `receipt.roleVersion` 精确删除（:329-352） |
| `me03-fixture.ts` container/psql 助手与 me01 重复 | maint·low | 按裁决 (d)：**deferred，仅记录**（抽取共享 PG 容器助手属独立重构） |
| `copilot.ts` fail-closed 工厂同步 throw 迁移 | medium | 按裁决 (a)：**DEFERRED to ME04**（该区域正在被 ME04 改写） |

### 10.2 新增/改写回归测试

| 套件 | 用例 | 证明 |
| --- | --- | --- |
| `enterprise/mastra-conversation-runtime.integration.test.ts`（+4） | `multi_page_history_is_chronological_and_submitted_key_matches` | critical 修复：121 行双页线程，重建 121 条全时间线、newest user key 匹配、无块级乱序 |
| | `activity_rows_do_not_poison_subsequent_turns` | activity 过滤：activity 行落库后 loadExecutionInput 零 activity、周边 turn 结构不动 |
| | `attachment_strip_uses_exact_url_not_suffix_match` | 精确 URL 比对：未授权 "23" 是已授权 "9123" 后缀时只剥 "23"（`[attachment unavailable: 23]`），"9123" 存活 |
| | `append_engine_message_boundaries_and_legacy_guard` | 163 上限 + legacy 守卫：164..200 拒绝、163 通过、legacy 线程引擎写拒绝 |
| `mastra-engine-wiring.integration.test.ts`（+2，1 改写） | `authorized_attachment_turn_reaches_the_model_as_reference` | HIGH 修复端到端：授权附件 turn 以 `[attachment: /api/attachments/<id>]` 文本引用到达模型，无 ME03_MESSAGE_PARTS_UNSUPPORTED |
| | `activity_row_does_not_block_the_turn` | wiring 侧 activity 过滤：RUN_FINISHED、payload 不进模型上下文 |
| | `forged_client_history_never_reaches_the_model`（改写） | 断言改 `dials.at(-1)`（插入鲁棒），完整持久历史等值 + FORGED- 零命中（原绝对索引在插入两个新 turn 后过期，见 §10.3） |
| `mastra-message-parts.test.ts`（+1） | `assistant_and_tool_array_content_refuse_unmodelable_parts` | 数组 content 不可建模 part 具名拒绝 |
| `mastra-stream-events.test.ts`（+1） | `trailing_stop_finish_never_overrides_a_recorded_abort` | abort→finish(stop) 保持 aborted、不发成功终态 |
| `mastra-ag-ui-agent.test.ts`（+1） | `run_without_governed_model_fails_through_the_error_channel` | throwError 经 Observable error 通道 |
| `mastra-governed-execution.test.ts`（+1） | `empty_relayed_history_refuses` | 空模型历史拒绝而非空流 |

### 10.3 本轮收尾修复（前一 agent 遗留的两处未绿）

1. **`corrupt_history_fails_explicitly` 共享线程永久投毒**：该测试在共享线程上删行制造 finalized-intent-without-row（设计上不可修复），自身断言通过但把线程留给后续所有 history 读 `MASTRA_MESSAGE_INTENT_MISMATCH` —— OCR wave 插入的 `activity_rows` / `attachment_strip` 恰好排在其后全灭。修复：victim 改用**专用线程**（与 `multi_page` / `concurrent_same_key` 同一隔离模式），断言语义不变（专用线程上 loadExecutionInput 显式拒绝）。
2. **wiring `forged_client_history_never_reaches_the_model` 过期索引**：两个新 turn 插到它前面后，`dials.length === 3` / `dials[2]` 全部过期（实际 5）。修复：改用 `dials.at(-1)` + 完整持久历史等值（attachment turn 用 `expect.stringContaining`）。
3. activity 测试的临时 debug catch 已确认不存在（前一 agent 最后一动作已完成移除）。

### 10.4 命令与真实计数（全部为实际运行结果）

| 命令 | Exit | 结果 |
| --- | --- | --- |
| `ME01_TEST_PG_PORT=5433 bun test <9 文件：ME03 两套件 + engine-wiring + 六守门套件>` | 0 | **86 pass / 0 fail**（375 expect）：message-parts 11（原 10 + OCR 1）、runtime 集成 14（原 10 + OCR 4）、engine-wiring 5（原 3 + OCR 2）、守门 56（原 53 + OCR 3）；原基线 76 全绿 + 新增 10 个 OCR 回归用例 |
| `ME01_TEST_PG_PORT=5433 bun test server/tests/enterprise/mastra-conversation-runtime.integration.test.ts server/tests/mastra-engine-wiring.integration.test.ts` | 0 | **19 pass / 0 fail**（87 expect；收尾修复后） |
| `bun test app/tests/mastra-runtime-compat.test.tsx` | 0 | **5 pass / 0 fail**（22 expect；前端零改动保持） |
| `bun run --cwd server typecheck` | 0 | **恰好 3 个基线错误**（`scripts/bootstrap-local-gateway.ts` :106/:108/:120），零新增 |
| `bunx biome check <本 wave 触碰文件>` | 0/残留 | 测试文件格式化后 clean；`service.ts` 仅余 2 个**既有** noConsole 基线（`MASTRA_FINALIZED_READ_FAILED` 结构化日志为本 wave 批准的评审修复、`MASTRA_STORAGE_PROBE_FAILED` 为更早轮遗留），本轮重构零新增诊断 |

### 10.5 触碰文件（sha256 见 `checkpoints/me03-ocr-fix/sha256.txt`，17 个）

生产：`scripts/lib/e2e-manifest.mjs`、`scripts/e2e-bun-manifest.mjs`、`server/src/mastra/{conversation-runtime,execution,stream-events,ag-ui-agent,message-parts}.ts`、`server/src/enterprise/conversations/service.ts`。
测试：`server/tests/support/{me01-child,me01-fixture,me03-fixture}.ts`、`server/tests/mastra-message-parts.test.ts`、`server/tests/enterprise/mastra-conversation-runtime.integration.test.ts`、`server/tests/mastra-engine-wiring.integration.test.ts`、`server/tests/mastra-{stream-events,ag-ui-agent,governed-execution}.test.ts`。
未触碰（按裁决）：ME04 scratch（`tools.ts`、`mastra-tools.test.ts`、`me04-harness.ts`、copilot.ts ME04 区域）；`app/` 前端零改动。

### 10.6 边界说明

- **行为保持证据**：intent 生命周期抽取后，`same_input_key_one_intent`、`retry_assistant_output_does_not_duplicate`、`concurrent_same_key_append_converges_not_pending`、`candidate_seq_not_visible_until_finalized`、`restart_preserves_full_parts` 全部原样绿 —— 并发/幂等/seq 语义逐点未被扰动。
- `execution.ts` 的重复工具名守卫记为 **superseded-by-ME04**（`MASTRA_TOOL_NAME_COLLISION`），非本 wave 实现；若 ME04 回滚 tools.ts，该 OCR finding 需重新落地。
- 未提交、未推送（无 commit 授权），增量全部在工作树。
