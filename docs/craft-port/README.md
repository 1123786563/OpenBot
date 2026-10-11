# Craft → OpenBot 移植总览（功能对照说明）

> onyx `backend/onyx/server/features/build/`（71 文件 / 27,584 行）→ OpenBot `server/src/craft/`（25 文件 / ~7,500 行 TS）
> 本目录文档：`architecture-analysis.md`（架构与映射全表）｜`schema-notes.md`（数据库对照）｜`acceptance-report.md`（验收报告）

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
| 审批 / 定时任务 / external_apps+OAuth / user_library / 快照 sleep-wake / webapp_proxy / docx/pptx | 不移植（一期） | 取舍：OpenBot 已有 approvals/workshop schedule/plugins 体系；沙箱常驻则无需 sleep/restore。restore 端点留 no-op 兼容 |

## 二、配置与依赖清单

**零新增 npm 依赖**（package.json 未动）——复用 hono/drizzle-orm/项目内 RedisPort。

环境变量（前缀 `OPENBOT_CRAFT_*`，语义对照 onyx `configs.py`）：

| 变量 | 默认 | 对照 onyx |
|---|---|---|
| `OPENBOT_CRAFT_ENABLED` | false | ENABLE_CRAFT |
| `OPENBOT_CRAFT_OPENCODE_DISABLED_TOOLS` | "question" | OPENCODE_DISABLED_TOOLS |
| `OPENBOT_CRAFT_SSE_KEEPALIVE_INTERVAL_SECONDS` | 15 | SSE_KEEPALIVE_INTERVAL |
| `OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START/END` | 3010/3100 | 同名 |
| `OPENBOT_CRAFT_INTERACTIVE_TURN_HARD_CAP_SECONDS` | 1800 | timeouts.py 硬帽 |
| （派生，不可配）soft=720、runnerStale=90、activeTurnTtl=2700、requestIdTtl=3600 | — | 推导关系见 config.ts 注释 |

迁移：`cd server && bun run db:migrate`（0072 迁移已生成）。

## 三、关键流程（发一条消息）

1. `POST /api/craft/sessions/{id}/send-message` → 幂等检查（client_request_id 复用 turn_id）→ active_turn 冲突 409 → 落 USER 消息 → 创建 turn（QUEUED）→ 立即返回 turn_id
2. 后台 runner：claim（CAS）→ ensureSessionReady（workspace + opencode 会话 + ACTIVE）→ reconcile LLM 配置（opencode.json 比对重写 + dispose）→ 发 prompt_async（一切端点带 `?directory=`）
3. 事件流：PodEventBus 长连接收 opencode 事件 → translateOpencodeEvent 翻译 → 每事件 touch 心跳 + persistSandboxEvent 落库（与 SSE 同 payload）
4. 前端 `GET /sessions/{id}/turns/{turn_id}/events`（SSE）attach 同一总线；`prompt_response`/`error` 终态关流
5. 中断：`POST /sessions/{id}/interrupt` → Redis fence + abort，turn → CANCELLED

## 四、与原实现的差异点（12 处有意偏离，全量清单见霍承钧交付记录）

最重要的三处：
1. **fetchMessage 异步 hydrate 降级**：onyx 从读线程同步 REST hydrate 消息角色；TS 翻译器是同步生成器无法直通异步——delta 先到且角色未知时保守丢弃，text 落点靠 part.updated gap-fill 兜底（已在 serve-client.ts 注释标明；实测有丢失再加预水化缓存）
2. **沙箱通路**：onyx 自管 k8s/docker 容器；OpenBot 经 agent-sandbox 网关（sandbox-gateway.ts 薄适配）
3. **Bun 无线程**：后台 runner 线程 → fire-and-forget 异步任务；prompt slot 由 turn 状态机 active_turn 锁承担（独立 slot 留二期）

## 五、部署接入（app.ts 片段）

```ts
import { createCraftRoutes } from "./craft/routes";
import { loadCraftConfig } from "./craft/config";

const craftConfig = loadCraftConfig(process.env);
if (craftConfig.enabled) {
  app.route("/api/craft", createCraftRoutes({ requireUser, deps: {
    config: craftConfig, db: database, redis,
    botIdFor: async (sessionId) => /* 会话→Bot */,
    llmConfigFor: async (session) => /* 模型目录→provider config */,
    sandboxConnectionFor: (botId) => /* {baseUrl, token} | null */,
    userNameFor: async (userId) => /* 显示名 */,
  }}));
}
```
