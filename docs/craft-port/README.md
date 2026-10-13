# Craft → OpenBot 移植总览（功能对照说明）

> onyx `backend/onyx/server/features/build/`（71 文件 / 27,584 行）→ OpenBot `server/src/craft/`（44 文件 / ~13,800 行 TS，含 events/opencode/storage/templates 子目录；其中约 +5,400 行来自 craft-port-verify 分支的 9 个校准任务）
> 本目录文档：`port-parity.md`（**当前状态的权威对照**：功能映射/依赖/调用链/差异全表）｜`architecture-analysis.md`（架构与映射全表）｜`schema-notes.md`（数据库对照）｜`acceptance-report.md`（验收报告）

## 一、功能对照（原实现 → OpenBot 实现）

| onyx 源 | OpenBot 目标 | 复刻方式 |
|---|---|---|
| `session/api.py` + `session/messages.py` | `craft/session-routes.ts` + `craft/message-routes.ts` | 一对一：会话 CRUD、send-message（幂等/409 冲突/attachments 校验）、interrupt、messages 读取 |
| `interactive_turns/{state,executor,api}.py` | `craft/{turn-state,turn-executor,turn-routes}.ts` | 一对一：Redis 状态机（键名/TTL 照搬）+ 异步 runner（claim/touch/finish、超时续跑×2、硬帽 1800s、interrupt fence）；turns/{id}/events SSE |
| `session/streaming.py` | `craft/streaming.ts` | 一对一：BuildStreamingState + persistSandboxEvent 落库规则（chunk 累积 flush、tool 仅终态、TodoWrite 例外、task_output 合成、plan upsert、context_usage 每 turn 一行） |
| `session/manager.py` | `craft/manager.ts` | 一对一（拆薄）：yield/persist/finalize 分层、reconcile、interrupt |
| `sandbox/serve_transport.py` + `opencode/{serve_client,event_bus}.py` | `craft/opencode/{serve-transport→并入 manager,serve-client,event-bus}.ts` | 一对一：translateOpencodeEvent 逐分支移植（delta/updated 对账、terminator 恰一次、子代理 _meta 路由、metadata.exit≠0→failed）；PodEventBus 指数退避重连 |
| `sandbox/util/{opencode_config,agent_instructions}.py` + `AGENTS.template.md` | `craft/{opencode-config,agent-instructions}.ts` + `AGENTS.template.md` | 一对一：_PERMISSIONS_TEMPLATE 全量、占位符替换顺序（ORGANIZATION_INSTRUCTIONS_SECTION 最后） |
| `session/{locks,interrupt_signal,errors,naming,session_ready}.py` | `craft/{locks,interrupt,errors,naming,session-ready}.ts` | 一对一（含 Redis 内存降级） |
| `session/sandbox_lifecycle.py` + `sandbox/{base,factory}.py` | `craft/sandbox-gateway.ts` + 复用 `sandbox_instances` 表 | **裁剪**：OpenBot 沙箱由 agent-sandbox 服务承担，只留每会话 directory + opencode 会话语义 |
| `db/build_session.py` 等 | `db/schema/craft.ts` + `craft/store.ts` | 一对一：三表 + CAS（finalize WHERE status='initializing'；端口 23505 重试） |
| `configs.py` + `timeouts.py` | `craft/config.ts` | 一对一：OPENBOT_CRAFT_* 前缀，派生族照搬 |
| k8s/docker 沙箱后端（4,754 行） | 不移植 | 取舍：agent-sandbox 服务 + sandbox_instances 表已覆盖生命周期 |
| ~~审批~~ / ~~定时任务~~ / ~~快照 sleep-wake~~ / ~~docx/pptx~~ / ~~webapp_proxy~~ | **已落地**（craft-port-verify 分支） | 审批 = permission.asked 生产者 + announce/wake 信号（`approvals.ts`/`approval-gate.ts`/`approval-signals.ts`）；定时任务 7+3 端点 + sweeper；快照/idle reaper + sandbox-status；上传/删除/目录下载；docx/pptx 导出复用既有依赖。详见 `port-parity.md` |
| external_apps+OAuth / user_library / connect_app / craft_gateway / debug | 不移植 | 取舍：OpenBot 无对应外部应用域与推送管线；AGENTS 模板对应段落随之一并裁剪（port-parity.md Task 1） |

## 二、配置与依赖清单

**零新增 npm 依赖**（package.json 未动，craft-port-verify 分支亦未动）——复用 hono/drizzle-orm/zod/项目内 RedisPort，以及四个既有依赖：`docx`、`pptxgenjs`（export.ts）、`cron-parser`（scheduled-tasks.ts）、`@aws-sdk/client-s3`（storage/object-store.ts 动态 import，快照对象存储）。依赖实况见 `port-parity.md` §③。

环境变量（前缀 `OPENBOT_CRAFT_*`，语义对照 onyx `configs.py`）：

| 变量 | 默认 | 对照 onyx |
|---|---|---|
| `OPENBOT_CRAFT_ENABLED` | false | ENABLE_CRAFT |
| `OPENBOT_CRAFT_OPENCODE_DISABLED_TOOLS` | "question" | OPENCODE_DISABLED_TOOLS |
| `OPENBOT_CRAFT_SSE_KEEPALIVE_INTERVAL_SECONDS` | 15 | SSE_KEEPALIVE_INTERVAL |
| `OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START/END` | 3010/3100 | 同名 |
| `OPENBOT_CRAFT_INTERACTIVE_TURN_HARD_CAP_SECONDS` | 1800 | timeouts.py 硬帽 |
| `OPENBOT_CRAFT_OPENCODE_EVENT_PATH` | "/event" | 新增（装配）：SSE 订阅路径，agent-sandbox 用 "/events" |
| `OPENBOT_CRAFT_OPENCODE_PROMPT_ENDPOINT` | "prompt_async" | 新增（装配）：prompt 动词，agent-sandbox 用 "message" |
| `OPENBOT_CRAFT_SESSION_DIRECTORY_MODE` | "absolute" | 新增（装配）：目录形状，agent-sandbox 用 "bot-relative" |
| `OPENBOT_CRAFT_SANDBOX_BOT_ID` | "craft" | 新增（装配）：承载 craft 会话的 Bot（bot-id 规则校验，非法回落默认） |
| `OPENBOT_CRAFT_IDLE_REAPER_ENABLED` | true | 新增：idle reaper（会话休眠清扫）总开关，false = 完全不启动 |
| `OPENBOT_CRAFT_IDLE_REAPER_INTERVAL_SECONDS` | 60 | 新增：清扫节奏（对照 onyx celery beat SANDBOX_IDLE_CLEANUP_INTERVAL_SECONDS；30s 下限） |
| `OPENBOT_CRAFT_SANDBOX_IDLE_TIMEOUT_SECONDS` | 3600 | SANDBOX_IDLE_TIMEOUT_SECONDS：心跳静默多久判 idle |
| （派生，不可配）soft=720、runnerStale=90、activeTurnTtl=2700、requestIdTtl=3600 | — | 推导关系见 config.ts 注释 |

注：装配侧（index.ts）在 `AGENT_SANDBOX_URL` 存在且上述三个拓扑变量未显式设置时，自动套用 agent-sandbox 形状（/events + message + bot-relative）——OpenBot 部署默认即正确，显式设置则完全尊重操作者。

迁移：`cd server && bun run db:migrate`（0072 迁移已生成）。

## 三、关键流程（发一条消息）

1. `POST /api/craft/sessions/{id}/send-message` → 幂等检查（client_request_id 复用 turn_id）→ active_turn 冲突 409 → 落 USER 消息 → 创建 turn（QUEUED）→ 立即返回 turn_id
2. 后台 runner：claim（CAS）→ ensureSessionReady（workspace + opencode 会话 + ACTIVE）→ reconcile LLM 配置（opencode.json 比对重写 + dispose）→ 发 prompt（prompt_async 或 /message，一切端点带 `?directory=`）
3. 事件流：PodEventBus 长连接收 opencode 事件 → translateOpencodeEvent 翻译 → 每事件 touch 心跳 + persistSandboxEvent 落库（与 SSE 同 payload）
4. 前端 `GET /sessions/{id}/turns/{turn_id}/events`（SSE）attach 同一总线；`prompt_response`/`error` 终态关流
5. 中断：`POST /sessions/{id}/interrupt` → Redis fence + abort，turn → CANCELLED

## 四、与原实现的差异点（16 处有意偏离，全量清单见霍承钧交付记录）

最重要的三处：
1. **fetchMessage 异步 hydrate 降级**：onyx 从读线程同步 REST hydrate 消息角色；TS 翻译器是同步生成器无法直通异步——delta 先到且角色未知时保守丢弃，text 落点靠 part.updated gap-fill 兜底（已在 serve-client.ts 注释标明；实测有丢失再加预水化缓存）
2. **沙箱通路**：onyx 自管 k8s/docker 容器；OpenBot 经 agent-sandbox 网关（sandbox-gateway.ts 薄适配）
3. **Bun 无线程**：后台 runner 线程 → fire-and-forget 异步任务；prompt slot 由 turn 状态机 active_turn 锁承担（独立 slot 留二期）

### agent-sandbox 拓扑适配（装配引入，4 处，均可通过 OPENBOT_CRAFT_* 切回 onyx 语义）

craft 移植主体按 onyx 原生 opencode-serve 语义编写（`/event`、`/session/:id/prompt_async`、`/workspace/sessions/{id}` 绝对目录、`/instance/dispose`）。OpenBot 的 agent-sandbox 网关对这四处逐一错位，装配以**配置开关 + 端点适配**弥合，不改动 agent-sandbox：

4. **SSE 订阅路径 `/event` → `/events`**（`OPENBOT_CRAFT_OPENCODE_EVENT_PATH`，默认 `/event`）。agent-sandbox 白名单无 `/event`，其 `/events` 是对 opencode `/event` 的转发 + 加 keepalive + **family filter**。⚠️ **一期已知限制**：该 filter 只放行五族（message_chunk=field:text 的 delta、thought=part.updated reasoning、tool_call=part.updated tool、progress=session.status、prompt_response=session.idle），会拦掉：
   - `message.updated`（翻译器靠它登记 assistant 角色）→ 已在 `turnStateForStream` 加 `assumeAssistantDeltas` 缓解：`/events` 模式下 delta 不做角色过滤直接放行（craft 的 prompt 从不经 opencode 回显，误放 user delta 无害；代价是 summary 消息的 delta 也放行——仅影响 compaction 边缘展示）；
   - `message.part.updated` 且 part.type=text 的 **gap-fill 锚点**（familyOf 判其为 other → 滤除）→ 翻译器断流重连后的 text 对账无锚可依，断线窗口内的 text 增量可能缺失，**靠 delta 主通道覆盖**（正常流式不断线时无影响）；
   - `session.created`（子代理登记，bus 的 parent→child 表填不上）→ 子代理 `_meta` 路由降级；
   - `session.compacted`、`permission.*` → compaction 提示与一期 auto-allow 的 permission.asked 均不达（permission 走 opencode.json 预授权，无碍）。
   如需完整行为，须 agent-sandbox 放开 filter 或加 query 旁路（二期）。
   另注：agent-sandbox 的 `/events` 转发**不透传 `?directory=`**（sse.ts 上游 fetch 只打到 `/event`），一期所有 craft 会话共享网关的默认实例事件流——单 Bot 部署（botIdFor=固定值）下语义仍自洽。
5. **prompt 端点 `/session/:id/prompt_async` → `/session/:id/message`**（`OPENBOT_CRAFT_OPENCODE_PROMPT_ENDPOINT`，默认 `prompt_async`）。两种 body 的 model 字段同为 `{providerID, modelID}` 对象（对照 codesandbox/client.ts:141-152 实证）。关键差异在响应时序：`/message` 是同步端点，响应在 turn 结束才返回——直接 await 会饿死事件消费循环（订阅队列 500 上限溢出丢弃）且请求超时会杀掉活 turn。处理：`/message` 模式下 fire-and-forget 发 POST，只 race 一个 10s admission 窗口——窗口内快速 HTTP 错误（坏模型/session 不存在）同步上抛，窗口耗尽即视为已受理，turn 事件照常走 bus。
6. **会话目录 `/workspace/sessions/{id}` → Bot 相对路径 `{id}`**（`OPENBOT_CRAFT_SESSION_DIRECTORY_MODE`，默认 `absolute`）。agent-sandbox 的 POST /file 只接受相对路径（proxy.ts:238-246 拒绝对路径与 `..`），每 Bot 的 opencode-serve 以 `/workspace/bots/{botId}` 为 cwd。`bot-relative` 模式下 `sessionDirectory(id)` 直接返回 `{id}`：`?directory={id}`（opencode 的 session 隔离键）、`POST /file path={id}/AGENTS.md`、`GET /file path={id}/outputs` 三者自洽，opencode 从 cwd 向上找 AGENTS.md 能命中会话级文件。附件的 `file://` URI 在此模式下前置 `/workspace/bots/{botId}`（attachmentUri——否则 session id 会被 URI 的 authority 吞掉）。absolute 模式行为不变（onyx 语义，原生 opencode-serve 部署用）。
7. **`POST /instance/dispose` 404/501 降级**：agent-sandbox 白名单无此端点。disposeInstance 对 404/501 与传输层失败降级为 warn 日志并返回（dispose 语义由网关自身的 per-Bot serve 生命周期承担）；其他状态码仍抛出。原生路径（有该端点）不受影响——404/501 只在端点不存在时出现，降级安全。

### 装配决策（index.ts，见 §五）

8. **botIdFor = 部署级固定 Bot**（`OPENBOT_CRAFT_SANDBOX_BOT_ID`，默认 `craft`）：craft_sessions 无 bot 关系列，全部会话路由到该 Bot 的沙箱 workspace。取值须满足 agent-sandbox 的 bot-id 规则（字母数字开头、仅 `[A-Za-z0-9_-]`、≤64），不合法配置在 loadCraftConfig 内回退默认值而非运行时 400。
9. **llmConfigFor = runtimeModel 单模型目录**：以部署自身模型（runtimeModel + resolveRuntimeModelApiKey）构建单条目 CraftModelDescriptor catalog；apiBase 取 OPENAI_BASE_URL/ANTHROPIC_BASE_URL（按 provider），未配置时用 provider 官方端点（apiBase 必填，无默认则 opencode 无法建 provider）。context/output limit 给固定合理值（200k/32k）并注释——runtime model 是 wire id 无 models.dev 元数据，数值在接入模型元数据源后修正。
10. **idle reaper 的释放步降级为"快照 + 会话置 idle"**（`craft/snapshot.ts` startCraftIdleReaper，装配于 craft routes，`OPENBOT_CRAFT_IDLE_REAPER_ENABLED` 默认 true、间隔 60s、idle 阈值 = `OPENBOT_CRAFT_SANDBOX_IDLE_TIMEOUT_SECONDS` 默认 3600s）：onyx 的 cleanup_idle_sandboxes_task 在快照后 terminate pod；OpenBot 的 agent-sandbox 拓扑下无逐会话沙箱可终止——所有会话共享单 Bot workspace，网关只有 `/workspace/snapshot`、`/workspace/restore` 与治理性的 `/workspace/reset`（会摧毁全部会话的现场），且网关自身已对空闲 per-Bot runtime 做再回收。故清扫链为：无活跃 turn（fail-closed，查 turnState）→ 快照 → `markSessionIdleIfStillIdle` CAS 置 idle（等价 onyx 二次扫描"仍 idle"），快照失败留 active 下轮重试；唤醒走既有 `GET /sessions/:id` 内的 wakeIfIdle（restore 快照 + idle→active）。配套新增 `GET /sessions/:id/sandbox-status`（`{status}`，从会话状态 + 网关可达性推导：initializing→provisioning、active+可达→running、active+不可达→provisioning（冷启动）、idle→sleeping、failed→failed、无 Bot 配置→null；terminated/restoring 为客户端侧状态）与前端状态芯片（轮询 provisioning 2s / running 30s，sleeping 时输入聚焦触发唤醒）。

## 五、部署接入（已装配至 app.ts / index.ts）

app.ts 新增末位参数 `craftRoutes?: CraftRoutesFactory`（APPENDED LAST 铁律），canUseBot 定义之后挂载：

```ts
if (craftRoutes) app.route("/api/craft", craftRoutes({ requireUser }));
```

index.ts 装配（enabled 才构建；AGENT_SANDBOX_URL 存在时自动套用 agent-sandbox 拓扑：/events + /message + bot-relative）：

```ts
const craftConfig = loadCraftConfig(process.env);
// AGENT_SANDBOX_URL 存在时按网关形状重载拓扑三项（/events + /message + bot-relative），
// 运维显式设置的 OPENBOT_CRAFT_* 仍优先；得到 craftEffectiveConfig。
const craftRoutes = craftEffectiveConfig.enabled ? ({ requireUser }) =>
  createCraftRoutes({
    requireUser,
    deps: {
      config: craftEffectiveConfig,
      db: database,
      redis: workshopRedisPort,          // 与 workshop 同一 Redis 端口（可 null 降级）
      botIdFor: async () => craftEffectiveConfig.sandboxBotId,  // 部署级 Bot（OPENBOT_CRAFT_SANDBOX_BOT_ID，默认 "craft"）
      llmConfigFor: async () => craftLlmConfig(),      // runtimeModel → 单模型 catalog
      sandboxConnectionFor: () => ({ baseUrl: sandboxUrl, token: sandboxToken }),
      userNameFor: async (userId) => (await peopleStore.find(userId))?.name ?? null,
      generateName: craftGenerateName,                 // one-shot system+user（不复用 createModelCompleter）
    },
  }) : undefined;
```

三个集成缝的实现要点：
- **botIdFor**：craft_sessions 表无 Bot 关系列，全部会话路由到部署级 `OPENBOT_CRAFT_SANDBOX_BOT_ID`（默认 "craft"，config.ts 内按 agent-sandbox bot-id 规则校验，非法回落默认）
- **llmConfigFor**：`runtimeModel`（部署模型）→ 单模型 `CraftLLMProviderConfig`（provider "openbot"，apiBase 取 OPENAI/ANTHROPIC_BASE_URL，apiKey 经 `resolveRuntimeModelApiKey()`）
- **generateName**：独立 one-shot（OpenAI: system+user 两条 messages；Anthropic: system 顶层字段 + max_tokens 200），失败 throw 由 craft/naming.ts catch 走 fallback
