# Craft 移植校准 port-parity 交付文档

> 基线:onyx `backend/onyx/server/features/build/`(71 文件 / 27,584 行)→ OpenBot `server/src/craft/`(44 文件 / 约 13,800 行 TS,含 events/opencode/storage/templates 四个子目录)。
> 本文档覆盖 craft-port-verify 分支(`ac1d408..HEAD`,9 个任务)完成后的**当前**状态:功能对照、实现清单、依赖清单、调用链路、差异点与取舍。
> 同目录:`architecture-analysis.md`(移植前架构分析)|`schema-notes.md`(数据库对照)|`acceptance-report.md`(一期验收)|`README.md`(总览,差异详表 §四)。
> **2026-10-12 起**:§五 全部差异已按 Onyx 源(pinned `251933a`)逐条裁决,裁决表与勘误见 `onyx-contract.md`(六项被裁能力恢复计划 Tasks 2–6 的实现基线);与本文冲突处以 `onyx-contract.md` §6 勘误为准。

---

## ① 功能对照表(onyx ↔ OpenBot)

### API 路由

| onyx 源 | OpenBot 目标 | 说明 |
|---|---|---|
| `session/api.py`(会话 CRUD/list/get/delete/name/generate-name) | `server/src/craft/session-routes.ts` | list :159、create :172、get :201(内含 wakeIfIdle :141)、name :219、generate-name :240、delete :285 |
| `session/api.py`(snapshot/restore 端点) | `session-routes.ts` :330 / :356 | snapshot 走网关 `/workspace/snapshot` + 对象存储;restore 从对象存储回放 + wakeIfIdle |
| —(onyx 无此端点,新增推导) | `session-routes.ts` sandbox-status :299 | `{status}` 从会话状态 + 网关可达性推导(见差异 Task 4) |
| —(onyx `reload_session_skills` 在 manager 内) | `session-routes.ts` skills/reload :374 | POST,活跃 turn 409、turn-state 故障 503 |
| `session/messages.py` send-message/interrupt/messages/turns-active | `server/src/craft/message-routes.ts` | messages :84、send-message :103(幂等/409/attachments)、interrupt :298、turns/active :315 |
| `session/messages.py`(subagent 路由) | `server/src/craft/subagent-routes.ts` :47 | POST `/sessions/:id/subagents/:ocSessionId/send-message`,同步 SSE |
| `interactive_turns/api.py`(turns/:id/events SSE) | `server/src/craft/turn-routes.ts` :68 | attach 端点:轮询就绪 → 订阅同一总线转发;announce drain 合流审批卡 |
| `interactive_turns/{state,executor}.py` | `server/src/craft/turn-state.ts` + `turn-executor.ts` | Redis 状态机(create/claim/touch/finish + stale 重认领)+ 后台 runner |
| `approvals/`(onyx craft 审批 API + cache) | `server/src/craft/approvals.ts` + `approval-gate.ts` + `approval-signals.ts` | live 列表 :152、decision :169;生产者 = permission.asked(见差异 Task 2) |
| `scheduled_tasks/`(7 端点 + beat) | `server/src/craft/scheduled-tasks.ts` | list :848、create :870、detail :950、update :958、delete :1062、run/run-now :1070、runs :1088;sweeper :751 |
| —(onyx scheduled-run 上下文/事件流) | `scheduled-tasks.ts` :1151 / :1175 | run-context join 查询 + SSE 事件流(与 turn SSE 同契约) |
| `api.py` 上传/删除/下载 | `server/src/craft/file-routes.ts` | upload :79、DELETE files :226、download-directory :280(zip;T5 按 F6 恢复 onyx 契约) |
| `manager.py:1595-1682`(download_webapp_zip / download_directory / _zip_files)+ `file_store/serving.py:103-115` | `server/src/craft/zip-archive.ts` | 零依赖 ZIP 写入器(deflate = node:zlib `deflateRawSync`,CRC-32 内建表,仅文件条目)+ `_sanitize_zip_basename` + `build_content_disposition`(ASCII 回退 + RFC 5987 `filename*`);T5 |
| `api.py` artifacts/export-docx/pptx-preview | `server/src/craft/artifact-routes.ts` | artifacts :98、files :119、artifacts/:path :150、export-docx :191、pptx-preview :246 |
| `webapp_proxy.py` + `api.py` webapp-info/webapp-download | `server/src/craft/webapp-proxy.ts` | 反代沙箱 webapp 端口(config 门控挂载);webapp-download 出 zip(T5):`application/zip`、会话名派生 `*-webapp.zip`、HIDDEN_PATTERNS 剪枝、空目录为空档非 404 |
| k8s/docker 沙箱后端(4,754 行) | 不移植 | agent-sandbox 服务承担;`sandbox-gateway.ts` 是薄适配(file/session/events/snapshot 动词) |

### 提示词与工具配置

| onyx 源 | OpenBot 目标 | 说明 |
|---|---|---|
| `AGENTS.template.md`(159 行) | `server/src/craft/AGENTS.template.md` | onyx 原文逐字节重写 + 7 处手术式替换(差异清单 Task 1);7 个占位符 |
| `sandbox/util/agent_instructions.py` | `server/src/craft/agent-instructions.ts` | 占位符替换管线,`ORGANIZATION_INSTRUCTIONS_SECTION` 最后替换(防二次展开) |
| `sandbox/util/opencode_config.py` | `server/src/craft/opencode-config.ts` | `_PERMISSIONS_TEMPLATE` 全量 + gatedTools→"ask" + disabled→"deny" + plugins 选项 |
| `sandbox/image/opencode-plugins/turn-budget.ts` | `server/src/craft/templates/turn-budget.plugin.ts` | 逐字移植(converge/finish-now 文案、60s 节流、六种惰化);落盘位置不同(差异 Task 6) |
| `session/session_workspace.py` | `server/src/craft/workspace.ts` | 目录骨架 + AGENTS.md/opencode.json/插件写入(经网关 POST /file) |
| `session/md_to_docx.py` + pptx | `server/src/craft/export.ts` | docx/pptxgenjs 导出与预览 |

### 配置与事件流

| onyx 源 | OpenBot 目标 | 说明 |
|---|---|---|
| `configs.py` + `timeouts.py` | `server/src/craft/config.ts` | `OPENBOT_CRAFT_*` 前缀;派生族(soft budget、runnerStale、activeTurnTtl 等)照搬;装配侧自动套 agent-sandbox 拓扑(/events + /message + bot-relative) |
| `sandbox/event_schema.py` | `server/src/craft/events/types.ts` | ACP 子集 SandboxEvent 联合(:138),错误码 -1/-2/-3 保留 |
| `packets.py`(6 个自定义包) | `server/src/craft/events/packets.ts` | BuildPacket 联合 :58(error/approval_requested/subagent_started/connect_app_request/context_usage/compaction) |
| `sandbox/opencode/serve_client.py` | `server/src/craft/opencode/serve-client.ts` | `translateOpencodeEvent` :680(逐分支)、`OpencodeServeClient` :977、sendMessage :1364、consumeFromBus :1532、answerPermission :1734 |
| `sandbox/opencode/event_bus.py` | `server/src/craft/opencode/event-bus.ts` | PodEventBus 长连 /event(s) + 每会话队列(500)+ 指数退避重连 |
| `sandbox/serve_transport.py` | 并入 `server/src/craft/manager.ts` | yield/teardown/abort 语义在 manager + serve-client 内 |

### 数据模型 / 定时 / 快照

| onyx 源 | OpenBot 目标 | 说明 |
|---|---|---|
| `db/build_session.py` + `db/sandbox.py` 等 | `server/src/db/schema/craft.ts` + `server/src/craft/store.ts` | craft_sessions/craft_messages/craft_scheduled_tasks(+runs)三族;CAS 守卫;审批复用共享 approval_requests 表(runId 双作 sessionId) |
| `db/artifact.py` / `db/receipt.py` | 对象存储 `server/src/craft/storage/object-store.ts` | 本地/S3(MinIO)双后端,put/get/head/delete 四动词(动态 import @aws-sdk) |
| `scheduled_tasks/` celery beat | `scheduled-tasks.ts` sweeper + `fireAndForgetRun` :562 | 进程内单例 sweeper(unref),cron 解析用 cron-parser |
| `snapshot_manager.py` + idle cleanup task | `server/src/craft/snapshot.ts`(`startCraftIdleReaper` :127) | 快照 + CAS 置 idle;不 terminate 沙箱(差异 Task 4) |

### 前端(app/)

| onyx 源(web/src/app/craft) | OpenBot 目标 | 说明 |
|---|---|---|
| 会话列表/路由 | `app/src/routes/_authed/_app/craft/{index,$sessionId,tasks}.tsx` | SessionSidebar + 会话视图 + 定时任务页 |
| ChatPanel/Composer | `app/src/components/craft/{chat-panel,composer}.tsx` | 转录/输入条/停止;附件链路(attachment-input.tsx) |
| 消息/工具卡渲染 | `app/src/components/craft/message/`(transcript-entry、tool-call 等)+ `tool-cards/`、`output-panel/` | plan/todo/artifact 卡 |
| 流式状态管理 | `app/src/lib/craft/streaming.ts` + `streaming-kernel.ts` | reducer + 纯函数内核(子代理三元路由/转录增长);`useBuildStreaming` |
| 数据访问 | `app/src/lib/craft/{client,queries,scheduled-tasks,types}.ts` | openbot-data-access 惯例;react-query |
| 沙箱状态芯片 | `sandbox-status-indicator.tsx` | 轮询节奏是答案的函数;聚焦唤醒 |
| 子代理视图 | `subagent-view.tsx` | 只读转录 + task 卡入口 |
| 定时任务编辑 | `scheduled-task-editor.tsx` | 三模式表单(interval/daily_weekly/advanced cron) |
| i18n | `app/src/locales/{en,zh-CN}/craft.json` | attachments/sandbox/tasks/subagent 命名空间 |

---

## ② 完整实现清单(本分支 9 任务落地)

一期基础移植(本分支之前)已交付:会话 CRUD、send-message 幂等准入、turn 状态机 + runner、事件翻译器、落库规则、SSE attach、AGENTS 模板与 opencode.json 生成、命名、中断、快照/恢复、webapp 代理、artifacts/docx/pptx、定时任务 7 端点。

本分支(craft-port-verify,`ac1d408..HEAD`)追加:

1. **Task 1** — AGENTS.template.md 对齐 onyx 原文:7 占位符恢复,审批窗口占位符接通(180/200 派生),裁剪段(Connectable apps/Company knowledge)锁定。
2. **Task 2** — 审批生产者:`OPENBOT_CRAFT_APPROVAL_GATED_TOOLS` 门控(opencode.json "ask" 规则)、permission.asked 分流、approval-gate(open/announce/poll)、approval-signals(announce/wake 双列表,Redis eval 或进程内)、decide 端点幂等语义 + wake、SSE announce 合流(approval_requested 包)、前端 invalidate 接线。
3. **Task 3** — 上传/删除/目录下载:upload(multipart、sanitize、限额、碰撞重命名)、DELETE files(严格路径校验)、download-directory(初版 tar.gz,T5 起按 F6 恢复为 zip);agent-sandbox 侧 `SANDBOX_MAX_UPLOAD_BYTES` + `DELETE /file`;前端附件链路(attachment-input/composer/chat-panel)。
4. **Task 4** — idle reaper 装配(默认开,60s 节奏,快照 + CAS 置 idle)、sandbox-status 推导端点、前端状态芯片(轮询节奏按状态、聚焦唤醒)、SIGINT/SIGTERM 关停。
5. **Task 5** — scheduled-run:run-now 别名、scheduled-run-context join 查询、scheduled-run-events SSE(与 turn SSE 同契约)、前端任务管理页 + 编辑器 + banner + 自动附流 + 导航入口。
6. **Task 6** — skills reload 端点(managedContentHashesFor 接缝 + skills_stale 真派生)、turn-budget 契约(stamp/clear 落 `.onyx-turn-budget.json`)、turn-budget 插件逐字移植并随 workspace 落盘。
7. **Task 7** — subagent 直推端点(同步 SSE + abort 语义)、前端 streaming-kernel(三元路由/子代理转录)+ SubagentView + task 卡状态行。
8. **Task 8** — 核心链路行为契约测试 98 用例(翻译器 51/turn 状态机 15/落库 20/send-message 12)+ 两处产品修复(USER 行写失败补偿死锁、reclaimed 持久化矛盾)。
9. **Task 9** — craft decide 独立写入路径(`ApprovalStore.decideQuiet`:落行 + 审计,无 workItem/无规则行)+ 死代码清理 + 本文档。

测试面:server `bun test tests/craft-*.test.ts` 20 文件 274 用例全绿(approvals 域另 47 用例同过);`bun run typecheck` 0 错。

---

## ③ 依赖清单(server)

**本分支零新增 npm 依赖**(ac1d408..HEAD 期间 `server/package.json` 无改动)。craft 直接消费的四个**既有**依赖(`server/package.json` 实况):

| 依赖 | 版本 | craft 消费点 | 引入来源 |
|---|---|---|---|
| `docx` | ^9.10.0 | `craft/export.ts`(export-docx 端点) | 早于本分支 |
| `pptxgenjs` | ^4.0.1 | `craft/export.ts`(pptx preview) | 早于本分支 |
| `cron-parser` | ^5 | `craft/scheduled-tasks.ts`(describeCron / next_runs) | 早于本分支 |
| `@aws-sdk/client-s3` | ^3.1149.0 | `craft/storage/object-store.ts`(动态 import;S3/MinIO 快照存储) | 早于本分支 |

其余复用:hono、drizzle-orm、postgres、zod、项目内 RedisPort(Redis 形态经窄 Port 的 `eval` 跑 list 动词)。前端零新依赖(react-query/tanstack router 既有)。T5 的 ZIP 输出同样零依赖:写入器为仓库内 `craft/zip-archive.ts`(deflate 用 node:zlib `deflateRawSync`,CRC-32 为内置表),未引入任何 zip npm 包;测试外部校验用系统 `unzip -t` + `ditto -x -k`(macOS),非 npm 依赖。
运行时外部服务:Postgres、可选 Redis(多副本;缺省降级进程内)、可选 S3/MinIO(快照;缺省本地目录)、agent-sandbox 网关(必选,`AGENT_SANDBOX_URL`)。

---

## ④ 调用链路说明(POST /send-message → SSE 输出)

行号以 craft-port-verify HEAD 为准。

### 4.1 准入(HTTP 同步段)

1. `POST /api/craft/sessions/:sessionId/send-message` — `message-routes.ts:103`。`withActiveTurnLock` 全程持锁(:140,准入串行器,不可重入):
   - 幂等:`turnState.getTurnForRequest`(同 client_request_id → 直接返回原 turn);
   - 冲突:`getActiveTurn` 非空 → 409 "This session is busy with a previous turn.";
   - 附件校验:相对路径、≥2 段、根 `attachments/`、无 `..`,仅 image/* 随 prompt;
   - 建turn:`turnState.createInteractiveTurn`(Redis 实现 `turn-state.ts:283` / 进程内 :532,工厂 :683)——born QUEUED,写 active 指针 + request 映射;
   - 落 USER 行:`store.createMessage`(失败则锁外 finishTurn FAILED——onyx commit-failure 路径,Task 8 修复);
   - 模型覆写:provider+model 成对才 `updateSession`。
2. 响应 `interactiveTurnResponse`(`{turn_id, session_id, status, turn_index}`),**不**持有流;`executor.startInteractiveTurnRunner(turnId)` fire-and-forget(`turn-executor.ts:414`)。

### 4.2 后台 runner(持久段)

3. `claimTurnForRunner` CAS(QUEUED/stale-RUNNING → RUNNING + runnerId;`turn-state.ts:369`/`:600`,`turn-executor.ts:420`)。
4. 会话就绪:`manager` 内 `ensureSessionReady`(workspace + opencode 会话 + ACTIVE)+ `reconcileSessionLlmConfig`(`manager.ts:228`,opencode.json 字节比对,变化则重写 + dispose)。
5. **turn-budget stamp**:`stampTurnDeadline`(`turn-executor.ts:270` → `turn-budget.ts`)写 `{sessionDir}/.onyx-turn-budget.json`(soft/final/stale_after 全派生);清空点在 finally 的 stillOwns 分支(:400)。
6. `manager.yieldSandboxEvents`(`manager.ts:448`)→ `serve-client.sendMessage`(`opencode/serve-client.ts:1364`):
   - ensure opencode 会话(404→mint 新 id,回写 session 行);
   - prompt POST(`prompt_async` 或 `/message` + 10s admission 窗口,按拓扑配置);
   - `consumeFromBus`(:1532):订阅 PodEventBus(`opencode/event-bus.ts`,每 (bot,directory) 一条长连 SSE),`translateOpencodeEvent`(:680,纯函数)把 opencode 事件翻译为 `SandboxEvent | BuildPacket`;
   - keepalive 每 15s;shouldInterrupt ~1/s;inactivity/absolute 超时 → abort + Error(-2/-3)。
7. 事件循环(`turn-executor.ts:149` 起):每事件 `touchTurn` 续心跳(:158,失主即退)→ `manager.persistSandboxEvent`(`streaming.ts:281`,chunk 累积 flush、tool 仅终态、TodoWrite 例外、task_output 合成、plan upsert、context_usage 攒到 finalize)→ error 事件即 finalize + persistTurnError + finishTurn FAILED。
8. 收尾:PromptResponse(stopReason=cancelled → CANCELLED,否则 SUCCEEDED)→ `finalizePersist`(`streaming.ts:463`,补 context_usage 一行)→ `finishTurn`(`turn-state.ts:428`/`:651`)清 active 指针、保留 request 映射 → `clearTurnDeadline`。超时续跑最多 2 次,硬帽 1800s。

### 4.3 SSE 输出(attach 段)

9. `GET /api/craft/sessions/:sessionId/turns/:turnId/events` — `turn-routes.ts:68`:FAILED turn → 单帧 error;轮询 turn active + opencodeSessionId 就绪(keepalive 桥接)→ `manager.subscribeToExistingSessionEvents`(`manager.ts:651`,只转发不落库;runner 是唯一持久写者)→ `eventToSse`(`streaming.ts:183`)序列化。
10. 帧契约:`event: message\ndata: {JSON}\n\n`;keepalive 注释行 `": keepalive\n\n"`(`SSE_KEEPALIVE`,`streaming.ts:149`);headers 四件套 + type(`CRAFT_SSE_HEADERS`,`turn-routes.ts:31`)。`prompt_response`/`error` 数据帧关流;turn 丢失(无终态帧)静默干净关流。
11. 审批合流:gated 工具配置非空时,每轮迭代 drain announce 列表(`approval-signals.ts`,`craft:approval:announce:{sessionId}`)逐条插 `approval_requested` 包(`events/packets.ts:78`),前端 invalidate live approvals。

### 4.4 关键数据结构

- **InteractiveTurn**(`turn-state.ts:37`):`{turnId, sessionId, userId, clientRequestId, prompt, turnIndex, status, runnerId?, reclaimed, attachments, errorDetail?, ...}`;状态联合 :19-30。
- **BuildStreamingState**(`streaming.ts:46`):per-turn 落库容器(pending 文本/thought 累积、plan 行追踪、context_usage 捕获、当前 routing meta)。
- **SandboxEvent 联合**(`events/types.ts:138`):AgentMessageChunk / AgentThoughtChunk / ToolCallStart / ToolCallProgress / PromptResponse / SSEKeepalive / Error;**BuildPacket 联合**(`events/packets.ts:58`):error / approval_requested / subagent_started / connect_app_request / context_usage / compaction(snake_case wire,与 onyx pydantic model_dump 对齐)。

### 4.5 状态流转

- **turn 状态机**(Redis/in-process 同语义):`QUEUED →(claim CAS)→ RUNNING → SUCCEEDED | FAILED | CANCELLED`(finish 清 active 指针、保 request 映射);RUNNING 心跳过 90s(RUNNER_STALE)可被新 runner 重认领(reclaimed=true,旧 owner touch/finish 双拒)。
- **会话状态**(`db/schema/craft.ts:32`):`initializing →(workspace+opencode 就绪 CAS)→ active ⇄ idle`(idle reaper 快照 + CAS 置 idle;读路径 wakeIfIdle 从快照恢复);`→ failed`(finalize 失败)。
- **审批状态**(共享 approval_requests 表):`pending → approved | denied`(craft decide 走 `decideQuiet`:同决策幂等、异决策 409、allow_always 落原文但等价 allow_once);**EXPIRED 为派生态**——生产者超时对上游答 reject,行保持 pending,live 读按窗口淘汰;行不会进 consumed/completed(craft 无 continuation)。

---

## ⑤ 差异点与取舍理由

汇总口径:一期基础移植的 16 处差异见 `README.md` §四(最重要的是 fetchMessage 异步 hydrate 降级、沙箱通路经 agent-sandbox 网关、Bun 无线程 → fire-and-forget runner;agent-sandbox 拓扑适配 4 处 + 装配决策 3 处)。以下按任务聚合本分支新增/细化的 **56 条**差异,每条含取舍理由。

### Task 1 — AGENTS 模板(7 处替换 + 逐字保留决策)

| # | 差异 | 取舍 |
|---|---|---|
| 1 | Hard rule 1 尾句 egress proxy 措辞 → "The platform injects these for you." | OpenBot 无 egress proxy,平台直接注入凭证 |
| 2 | Hard rule 2 整条改为 "Never bypass the platform…agent-sandbox gateway" | 同上;保持 onyx 句式结构 |
| 3 | webapp 条目:onyx "call the webapp tool" → 现状 "scaffold under outputs/web" | OpenBot 无 webapp 工具(web 开发经 agent-sandbox /devserver/start) |
| 4 | Workspace layout 两行注释同步改写 | #3 组成部分 |
| 5 | "## Connectable apps" 整段裁剪(含 `{{CONNECTABLE_APPS_LIST}}`) | OpenBot 无外部应用域 |
| 6 | "## Company knowledge" 整段裁剪 | 无 company-search skill |
| 7 | Outputs 段前半改写(同 #3 语义) | 后半三句与 onyx 逐字相同 |
| — | **逐字保留**(有意,非偏差):"powering Onyx Craft" 身份段、user_library/ 描述、credentials proxy 段、工作法 "search company knowledge" 措辞、`[Onyx turn budget]` 标记 | 逐字一致性优先;描述的是未移植子系统,待后续语境化裁定 |

### Task 2 — 审批(10 条)

| # | 差异 | 取舍 |
|---|---|---|
| 1 | 生产者是 opencode `permission.asked` + "ask" 规则,非 egress-proxy HTTP 拦截 | 基础设施差异(OpenBot 无 egress proxy) |
| 2 | EXPIRED 不落行(派生态:超时 reject 上游 + live 读窗口淘汰) | 共享表 CHECK 无 expired 值,加值需迁移并波及通用审批 UI |
| 3 | 等待是 0.5s KV 轮询 wake,非 BLPOP park | 同步 sleep 会阻塞 keepalive/interrupt/翻译;可观察语义一致 |
| 4 | 键名带 `craft:` 前缀 | 内部键无跨系统契约 |
| 5 | 卡片无 MatchedAction/display_payload 复杂结构 | 按现有字段(tool_ref/effect/scope/args)降级 |
| 6 | ~~复用共享 decide 的副作用~~ **Task 9 已修**:decideQuiet 独立写入,无 approval.resume workItem、无规则行 | craft 行无 continuation,worker 重试纯噪音 |
| 7 | allow_always ≈ allow_once(落 APPROVED,不写持久授权;上游恒答 once) | onyx session-grant 语义可后续演进;craft 卡片 UI 只提供 allow_once/deny |
| 8 | session-grant 批量批准端点未移植;headless(定时)turn 对 gated 工具 auto-allow | 无人可问;onyx 由 proxy 另行处理 |
| 9 | runner 流持久化审批卡为 durable 消息行 | 增量记录,不与 onyx 冲突(onyx 只进 attach 流) |
| 10 | decide 端点只处理 craft 行:带 `action.policy` 的通用审批行(含 hand_off 策略)→ 404,不触达写入路径 | **Task 9 Fix Round 1 安全修复**:防止经 craft 端点绕过通用 decide 的 hand_off 守卫(hand_off 行只收 handled/deny),且避免 allow_always 不写规则行导致该行滞留 |

### Task 3 — 上传/文件(7 条)

| # | 差异 | 取舍 |
|---|---|---|
| 1 | ~~目录下载 tar.gz 而非 zip~~ **已恢复(T5)** | F6/裁决 C6:download-directory 与 webapp-download 均改出 `application/zip`(deflate、仅文件条目、`_sanitize_zip_basename` 文件名、RFC 5987 disposition);写入器零新依赖(`zip-archive.ts`,node:zlib `deflateRawSync` + 内建 CRC-32);tarGzip 已删除 |
| 2 | 总量限额字节来自上传账本(`attachments/.openbot-uploads.json`),非 `du -sb` | 网关 listing 无 size 字段;账本随快照/恢复走 |
| 3 | 无拖拽/粘贴上传、无进度条/并发限速 | 前端最小范围(chip 状态机) |
| 4 | 空 sandbox 错误码:upload 503,delete/download 404 | OpenBot 网关缺失形态 onyx 不存在 |
| 5 | 单文件超限 craft 层 400;网关传输上限 413 | 两层语义分层,craft 400 对齐 onyx 文案 |
| 6 | 删除目录 → 404(非 400) | 按 onyx docker/k8s 实际行为移植 |
| 7 | 上传需 bot-relative 目录模式部署 | agent-sandbox POST /file 拒绝绝对路径 |

### Task 4 — 快照/idle(6 条)

| # | 差异 | 取舍 |
|---|---|---|
| 1 | idle reaper 只快照 + CAS 置 idle,不 terminate pod | 共享单 Bot 拓扑无逐会话沙箱;网关自带空闲 runtime 回收 |
| 2 | onyx 二次扫描 → 单条守卫 UPDATE(markSessionIdleIfStillIdle) | 同一"清扫期间无新活动"约束的等价表达 |
| 3 | 背景快照(非 idle 每 15min)未移植 | 任务范围明确的简化 |
| 4 | sandbox-status 推导而非读行(active+网关探测;不可达=provisioning 冷启动;terminated 永不出现) | 无 sandbox 表行 |
| 5 | 芯片挂会话视图 header(ChatPanel 无自有 header) | 避免双头 |
| 6 | SandboxAsleepNotice 未移植 | 芯片 + 聚焦唤醒覆盖 |
| — | UI 读路径刷 lastActivityAt | **onyx 同款语义**(读即活动),保持不动 |

### Task 5 — 定时任务(7 条)

| # | 差异 | 取舍 |
|---|---|---|
| 1 | run-now 与 /run 并存 | onyx 仅 run-now;保留旧动词不破老客户端 |
| 2 | 更新走 PUT(onyx PATCH) | 一期 7 端点既定差异 |
| 3 | banner 不禁用输入 | 范围裁剪;副作用是流式期间可点停止中断 headless run |
| 4 | in-flight 集合含 queued | banner 显示排队中 |
| 5 | 运行历史无 cursor 分页 | 一期既定差异;前端一次取默认量 |
| 6 | 导航入口不随 SCHEDULED_TASKS 开关联动 | app 侧无服务端特性开关查询 |
| 7 | 编辑表单无 human_readable 预览 | 列表行用服务端 describeCron 文案 |

### Task 6 — skills/turn-budget(7 条)

| # | 差异 | 取舍 |
|---|---|---|
| 1 | turn-budget 插件随会话 workspace 落盘(.opencode/plugin/),非烤进镜像 | OpenBot 不能改 agent-sandbox 镜像;副作用:老会话下次 reconcile 一次性翻新(即上线机制) |
| 2 | reload 无条件 regenerate+dispose(onyx 非 stale 时短路返回) | 无推送域时按 onyx 短路径端点将永远空转;显式刷新语义 |
| 3 | prompt-slot 守卫换 active-turn 检查(409)+ turn-state 故障 503 | 语义等价(防活 turn 下重写 opencode.json),通道不同 |
| 4 | PROVISIONING 守卫未移植 | 派生状态无法表达;活跃 turn 检查已覆盖 |
| 5 | 插件机械偏差:`satisfies Plugin` 类型糖删除、`Bun.file` → fs/promises | 包非 server 依赖;沙箱 Bun 运行时下等价 |
| 6 | soft = min(SOFT, budget) 恒 no-op,未保留 min | budget == hard cap 常量 |
| 7 | skills fingerprint 源:装配默认稳定 null | 无 managed-content 推送管线,给未见过沙箱的内容算哈希是假语义;谓词/列/回写链路完整 |

### Task 7 — 子代理(8 条)

| # | 差异 | 取舍 |
|---|---|---|
| 1 | 无 ensureSession 预检(失效子会话 id 以错误帧暴露,不静默重铸) | 不静默换会话 |
| 2 | 无 cross-fade / AnimatePresence / tabHistory | 范围控制 |
| 3 | SubagentState 为扁平 streamItems(非 SubagentTurn[] 分轮结构) | 简化 |
| 4 | 完成推断靠 task 终态(onyx markSubagentComplete 语义) | 无独立完成信号 |
| 5 | 无 buildSubagentsFromMessages(reload 后子代理视图空;主转录重放跳过子路由行,与 live 一致) | 范围控制 |
| 6 | 查看子代理期间隐藏 Composer | 只读视图(onyx 显示输入条但同样只读) |
| 7 | pydantic 422 → 400 JSON | 仓库既有约定 |
| 8 | 新端点暂无前端调用方 | 服务端 API 平价先行 |

### Task 8 — 落库判据(2 条)

| # | 差异 | 取舍 |
|---|---|---|
| 1 | TodoWrite 落库例外判据为映射后标题 "Updating todos"(TOOL_TITLE),非原始工具名 | 端到端等价(翻译器恒把 todowrite/todo_write 映射为该标题) |
| 2 | 空 delta 在 assistant 过滤之前短路(onyx 相反) | 可观察行为一致(都不产出、不累积) |

### 架构层(2 条)

| # | 差异 | 取舍 |
|---|---|---|
| 1 | **Mastra 未引入** | 复刻对象是 onyx 的 opencode-serve 驱动模式(自管 agent 循环 + 事件翻译 + 状态机);OpenBot 已有 Mastra 体系用于其他域,craft 若改走 Mastra agent 循环反而偏离 onyx 架构,校准目标(行为契约逐分支对齐)无法达成。事件翻译器/turn 状态机/落库规则均按 onyx 一对一移植 |
| 2 | worker 线程 → fire-and-forget 异步任务;prompt slot 由 active-turn 锁承担 | Bun 无线程(一期既定差异,详见 README §四.3) |

---

## ⑥ Remediation Delta(2026-10-13,验证检查点 `6c7c0d16`)

> 增量基线:六能力恢复计划(`docs/plans/2026-10-12-craft-parity-remediation.md`,提交 `bf81d741..6c7c0d16`)。契约事实源:`onyx-contract.md` + `fixtures/`;终审证据:`remediation-verification.md`(真实 agent-sandbox 冒烟 + finding 全录)。**本节只记增量,与 §①–⑤ 冲突处以本节 + `onyx-contract.md` §6 勘误为准。**

### 恢复了什么(vs remediation 前分支状态 `3c690410`)

| 能力 | remediation 前 | remediation 后(契约级) | 真实现场状态(2026-10-13 冒烟) |
|---|---|---|---|
| C1 Connectable apps 段 | 模板裁剪 | **restore**:`{{CONNECTABLE_APPS_LIST}}` 段 + 逐用户倒置过滤(已连接不出、共享部署账号不出) | ✅ live(段落渲染 + 倒置实证) |
| C2 Managed skills + 双哈希 | 接缝缺失 | **restore**:resolver 接缝 + AGENTS.md 先渲染后 ack + reload 走真 resolver | ✅ live(空源哈希照算;reload 短路按哈希) |
| C3 Per-user MCP servers | 无 mcp block | **restore**:mcp block(键名/权限/指纹逐 onyx)+ 服务器侧中继(逐调用凭证解密) | ✅ live(工具调用全链:`FIXTURE_ECHO` 回程,中继附挂 Bearer) |
| C4 connect_app 工具 | 裁剪 | **restore**:插件文本逐字节 + ask/announce/decide/超时 + decide 端点限定 | ⚠️ **契约级成立,真实现场 blocked-by F-B**(插件不注册,SDK 路径) |
| C5 webapp 工具 + 托管启动 | 裁剪(一期经 /devserver) | **restore**:工具 + 预留端口 start-webapp.sh(flock/pid cwd 守卫)+ attach-not-spawn 预览 | ⚠️ **脚本级 ✅ live;工具真实现场 blocked-by F-B;预览拓扑 blocked-by F-E** |
| C6 ZIP 输出 | tar.gz | **restore**:两路由 `application/zip`(deflate、仅文件条目、sanitize、RFC 5987);tar.gz 从 craft HTTP 面移除 | ✅ live 字节级;**F6-A 递归语义 blocked-by F-C**(顶层仅子目录时空档) |

**配置/依赖:零变更**(`package.json`/`bun.lock`/db schema 在 `3c690410..6c7c0d16` 无 diff;zip-archive.ts 为仓库内实现)。测试:425 craft + 72 agent-sandbox + 双 typecheck 全绿。

### 勘误(转移项 (iv)(v)(vi),Onyx/实现事实胜出先前文档)

- **勘误 C5(原 §4.0 表述)**:C5 的执行环境替代**不是**"agent-sandbox `/devserver/start` 池",而是 **onyx 自己的预留端口模型**(DB 预约 [3010,3100) + 工作区内 start-webapp.sh 自管理单进程)。理由:devserver 池无法绑定指定端口、无法保证 log/pid 文件与进程同址、且池在沙箱内被触发需携带网关 token(泄露面)。`/devserver/start` 子系统仍服务非 craft 场景,与 C5 无关。
- **勘误(措辞)**:webapp 工具 description 保持 onyx 逐字节 "it scaffolds outputs/web, installs dependencies…",而脚本实际**把 scaffold 推迟给 agent**(无 `outputs/web/package.json` 时 `exit 1` + 指引文案)。AGENTS.md 指引补偿(已测);真实现场已复现脚本两侧行为。
- **勘误(fixture)**:`fixtures/webapp-tool.md` §F 的模板拷贝(`cp -r /workspace/templates/outputs/*`,Next 模板)与 dev-server 三环境变量(`ONYX_WEBAPP_PORT/BASE_PATH/ALLOWED_DEV_ORIGINS`)两条在 OpenBot 环境**结构性不可满足**(无镜像模板、无 pod 内 env 注入)——fixture 已加 Erratum E1 注记,断言以脚本结构等价物(flock/pid/探活/ready 行)为准。

### BLOCKED 沿袭(未变化)

company-search(组织知识技能)维持 BLOCKED:OpenBot 知识域无可供沙箱调用而不泄凭证的路径;`COMPANY_KNOWLEDGE_SECTION` 钉住,AGENTS.md 公司知识段仅当 backed skill 落地才渲染。**全量 parity 在此解决 + F-B/F-C/F-D/F-E 修复前不得宣称。**

### 真实现场 finding 摘要(详见 remediation-verification.md §4)

| # | 级别 | 一句话 |
|---|---|---|
| F-A | Critical(部署) | auth 全局 fetch 补丁破坏 craft 对回环沙箱网关的调用(写 201 读 400 / turn runner 事件流卡死) |
| F-B | High(交付) | SDK_TOOL_PATHS 在部署布局不解析 → connect_app/webapp 插件真实现场不注册 |
| F-C | High(交付) | download-directory 假设递归 listing,真实网关扁平 → 嵌套文件静默丢弃 |
| F-D | Medium(交付) | 初装路径不写 start-webapp.sh(stale 行,nextjsPort 未回读) |
| F-E | Medium(拓扑) | 预览/ready 拨 host 回环,dev server 在容器内 → host 部署永 503 |
| F-F | Low/Medium | failed 空会话修复路径必抛 Stale(CAS 不复位 initializing) |

---

## 附:文档间关系

- 一期(基础移植)差异全表与部署接入:`README.md`(§四 16 处 + §五装配)。
- 移植前架构分析与完整映射建议:`architecture-analysis.md`。
- 数据库对照:`schema-notes.md`。
- 一期验收记录:`acceptance-report.md`。
- 契约基线与终审证据:`onyx-contract.md`(+ `fixtures/`)、`remediation-verification.md`(2026-10-13 真实 agent-sandbox 冒烟 + finding 全录)、`ocr-report-round1.md`。
- 本文为**当前状态的权威对照**,agent-instructions.ts 头注指向本文件。
