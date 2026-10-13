# OpenBot「Bot 工作台」设计——完整借鉴 Onyx Craft

> 2026-10-10。基于对 `/Users/wuyongjun/trea/onyx/backend/onyx/server/features/build/` 全部代码的阅读（session/manager 1856 行、sandbox/serve_transport 944 行、sandbox_lifecycle 1021 行、streaming 1009 行、scheduled_tasks、external_apps、webapp_proxy、nextjs_dev、snapshot_manager、db/models 9 张表），与 OpenBot 现状（agent-sandbox P0 已上线并三轮浏览器验证通过）的对照。
>
> 前置：P1-A（per-bot 沙箱隔离与生命周期）已有实施计划 `plans/2026-10-10-sandbox-lifecycle-craft.md`，本文档是其上层的产品与架构设计，P1-A 成为 W1 的一部分。

## 1. Craft 是什么（代码事实，不是宣传语）

Craft 是 Onyx 的 **AI 构建工作台**：用户在聊天里让沙箱内的 OpenCode agent 构建产物——代码、数据分析、以及完整的 **Next.js Web 应用**——并实时预览、管理、分享、定时重跑。代码骨架：

| 模块 | 规模 | 职责 |
|---|---|---|
| `session/manager.py` | 1856 | 会话 CRUD、消息、上传限额、文件浏览、artifact 索引、docx/pptx 导出、目录打包下载、LLM 会话命名、公开分享 |
| `sandbox/serve_transport.py` | 944 | 到沙箱内 opencode serve 的 SSE 事件流：prompt slot、keepalive、事件翻译（消息块/工具调用/思考/子代理）、活动超时 |
| `session/sandbox_lifecycle.py` | 1021 | 沙箱状态机（PROVISIONING/READY/SLEEPING/TERMINATED/FAILED）、durable provisioning（attempt_number CAS）、reservation 锁、reconcile、空闲回收 |
| `session/streaming.py` | 1009 | 流式事件持久化（DB 支撑的断线补齐）、SSE 下行 |
| `interactive_turns/` | 1200+ | 轮次状态机（QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED）+ Redis 锁 + runner 心跳 + stale 恢复 + 打断 |
| `webapp_proxy.py` + `nextjs_dev.py` | 660 | **每会话一个 Next.js dev server**（懒启动、bun 缓存、模板 config）+ 鉴权代理（HTTP+WS）到 `/api/build/sessions/{id}/webapp` |
| `snapshot_manager.py` | 262 | 工作区 tar.gz 快照到 FileStore（含 opencode-history）、restore |
| `scheduled_tasks/` | 1500+ | cron 定时任务（3 种编辑模式编译为统一 cron）+ 沙箱内 headless 执行 + **预授权目标**（定时跑免人工批）+ 运行历史 |
| `external_apps/` + `user_library/` | 1100+ | OAuth 第三方应用凭据（加密入库、注入沙箱）+ 跨会话用户库（managed symlink 进每个会话工作区） |
| `db/models` | 9 表 | build_session / sandbox / build_message / artifact+action_receipt / scheduled_task×3 / external_app×3 |

**LLM 网关铁律**：沙箱拿 `CRAFT_SANDBOX` 作用域 token，所有模型调用强制走 Onyx 网关并打 `LLMFlow.CRAFT_LLM_GENERATION` 独立计量流（`craft_gateway.py`）；沙箱内 `ONYX_PAT` 由代理在 wire 上注入，容器不落盘。

## 2. 借鉴原则

1. **嫁接而非移植**：Craft 的主体是"每用户一个沙箱"；OpenBot 的主体是"每 Bot 一个代理 + 频道对话"。借鉴工作台产品层，落到 OpenBot 的 **Bot/频道**模型上，不引入 Craft 的 user-sandbox 等价物。
2. **网关治理不换轨**：所有新增能力（预览、定时、上传、分享）过 OpenBot 已有的 canUseBot/审计先行/Lago 计量三件套。Craft 的 PAT/网关模式对应我们已有的模型网关 + `code_runs`，不另建。
3. **每一期独立可交付**：W1–W6 每期都是能上线的功能增量，不是大爆炸重写。

## 3. 新产品概念：Bot 工作台（Workshop）

频道侧栏新增工作台视图（对标 Craft sidebar）：一个 Bot 的频道里，用户可以：

- **看**：流式观看 agent 在沙箱里的执行过程（工具调用、文件 diff、命令输出），浏览沙箱文件树，看 artifact 画廊（表格/图/CSV/报告/Web 应用）；
- **给**：上传数据文件进沙箱（限额治理）；
- **收**：下载产物（单文件/目录 zip/docx 报告）；Web 应用类产物**一键实时预览**（iframe 内嵌代理）；
- **定**：把"这个任务"存成定时任务（cron），预授权后无人值守重跑；
- **治**：一键 reset 工作区、看用量、审计。

对话里的入口：Bot 在回复 artifact 时自动给出工作台卡片（对标现有 computer 视图的挂载方式）。

## 4. 架构与映射

```
┌─ app（React）──────────────────────────────────────────────┐
│ 频道对话(已有) + 工作台视图: 文件树│artifact画廊│webapp预览│ │
│ 定时任务面板│用量卡片                                        │
└──────────────┬─────────────────────────────────────────────┘
               │ SSE(/api/workshop/:channelId/events) + REST
┌─ server ─────▼─────────────────────────────────────────────┐
│ workshop 模块(新增, 对标 features/build)                    │
│ ├ turns: 轮次状态机+打断+流式持久化 (对标 interactive_turns │
│ │        +streaming; 状态存 DB+内存锁, 不引入 Redis——单实例 │
│ │        P0 起步, 多副本时再升)                              │
│ ├ artifacts: 产物索引+下载/导出 (对标 Artifact 表)          │
│ ├ files: 文件树/上传 (限额: 数量/单文件/总量)               │
│ ├ webapp: 预览代理(鉴权+作用域, 对标 webapp_proxy)          │
│ ├ schedule: cron+执行器 (对标 scheduled_tasks)              │
│ └ 复用: canUseBot/audit/Lago/codeRunGateway(既有)          │
└──────────────┬─────────────────────────────────────────────┘
               │ x-sandbox-token + x-openbot-bot-id (既有)
┌─ agent-sandbox ▼ (P1-A 后) ────────────────────────────────┐
│ per-bot opencode serve × N + SSE 事件转发(P1-B)            │
│ + webapp serve 子进程(W3, 懒启动) + tar.gz 快照流(W4)      │
└─────────────────────────────────────────────────────────────┘
```

**关键差异决策**（Craft → OpenBot 的取舍）：

| Craft 组件 | OpenBot 对应 | 差异决策与理由 |
|---|---|---|
| user ↔ sandbox 1:1 | **bot ↔ 沙箱运行时** 1:1（P1-A） | Bot 是 OpenBot 的行为主体；用户的隔离边界是租户/频道，已有 RLS |
| build_session 表 | **复用 channel** + 新 `workshop_sessions`（bot 维度，挂 channel 下） | Craft 的会话=产品唯一入口；OpenBot 的入口是频道对话，工作台是频道的视图。opencode_session_id、webapp_port 等挂新表 |
| Redis 轮次锁+心跳 | **DB 行 + 内存锁**（bun 单进程内 mutex + `workshop_turns` 表） | 不为 W2 引入 Redis；多副本部署时升级（OpenBot 有 worker 体系可承接 runner） |
| SSE 事件流（serve_transport） | wrapper 转发 opencode `GET /event` SSE → server 翻译 → 前端 | 事件 schema 直接抄 Craft 的五类划分（AgentMessageChunk/AgentThought/ToolCallStart/Progress/PromptResponse + Subagent） |
| Next.js dev server per session | **静态预览优先，dev server 二期** | Craft 的选择基于"构建完整 Next 应用"的定位。OpenBot P0 场景（数据分析、报表、小工具页）用 **vite build 产物 + 静态服务 + HMR 关闭** 即可预览；需要真 dev server 的场景（W3 后期）再引入 per-bot next dev，端口治理复用 P1-A 的端口注册表 |
| FileStore 快照 | 先落对象存储抽象之外的**卷内 tar.gz + DB 索引**，S3 后端接 FileStore 等价物 | OpenBot 尚无统一 FileStore；W4 定义 `workshop_snapshots` 表 + 存储接口（本地卷起步，S3 适配器后补），接口形状抄 Craft 的 SnapshotManager |
| OAuth 外部应用 | 对接 **OpenConnector**（已获批的方案 A）+ 插件凭据 | 不抄 Craft 的 external_app 表；凭据注入沙箱用同一"任务作用域凭据"机制（对标 CRAFT_SANDBOX PAT） |
| 用户库 managed symlink | **bot 资产库**（skills/数据集 symlink 进 bot 工作区） | OpenBot 已有 learned-skills/marketplace；W6 把它们 symlink 进沙箱，hash 比对决定重推（抄 skills_hash 机制） |
| LLM 网关 flow 打标 | 既有 GLM 路由 + `code_runs` → Lago（P1 已列） | 无新增 |

## 5. 数据模型（新增 4 张表，drizzle）

```
workshop_sessions   — id, channel_id, bot_id, owner_user_id, status(active/archived),
                      opencode_session_id?, webapp_port?, skills_hash?, created_at, last_activity_at
workshop_artifacts  — id, session_id, type(csv|chart|report|webapp|file|dataset), name, path,
                      size_bytes, preview_url?, created_at   （对标 Artifact+receipt 合一；
                      审计走既有 audit_events，不抄 ActionReceipt——OpenBot 审计体系更全）
workshop_turns      — id, session_id, prompt, status(queued|running|succeeded|failed|cancelled),
                      turn_index, runner_heartbeat_at, error?, usage jsonb, started/finished_at
workshop_schedules  — id, session_id, cron, editor_mode, preapproved jsonb, next_run_at,
                      last_run_id?, enabled   （+ workshop_schedule_runs 历史，对标 ScheduledTaskRun）
```

上传限额、分享作用域暂不加表（配置项 + 复用频道 ACL）。

## 6. API 面（`/api/workshop/...`，全部走 canUseBot）

```
GET  /:channelId                 工作台聚合（session+artifacts+sandbox 状态）
GET  /:channelId/events          SSE 轮次事件流（断线用 Last-Event-ID 补齐——抄 Craft streaming）
POST /:channelId/turns           发起轮次（= 治理过的 run_code 长形态）
POST /:channelId/turns/:id/cancel  打断（抄 interrupt_signal：置位标志，serve_transport 层转发中止）
GET  /:channelId/files?path=     文件树    POST /:channelId/files/upload（multipart，限额）
GET  /:channelId/artifacts/:id/download   单文件 / 目录 zip / docx 导出（md_to_docx 思路）
POST /:channelId/snapshot        立即快照    POST /:channelId/restore（从快照恢复，抄 restore 端点）
GET  /:channelId/webapp/*        预览代理（鉴权+作用域，WS 升级透传——W3）
GET/POST/DELETE /:channelId/schedules  定时任务 CRUD；运行历史只读
POST /:channelId/reset           （P1-A 已设计，审计先行）
```

## 7. 分阶段路线（每期独立交付）

**W1 沙箱基座 + 工作台骨架**（含已排期的 P1-A）
- per-bot 沙箱运行时、空闲回收、reset、timeoutSeconds 生效（既有计划）
- `workshop_sessions`/`workshop_artifacts` 表 + 聚合 API + 文件树/上传/下载
- run_code 的产物自动进 artifact 索引（网关在收集产物时写表）
- 前端：频道侧的工作台 Tab（文件树 + artifact 列表）
- 里程碑：浏览器里对 bot 说"分析这份 CSV"→ 上传 → 看产物画廊 → 下载

**W2 流式轮次**
- wrapper 转发 opencode SSE → server 翻译五类事件 → 前端实时过程视图
- `workshop_turns` 状态机 + 打断 + 心跳 + stale 恢复；流式事件持久化（刷新补齐）
- 里程碑：长任务（>1 分钟）可观看、可停止、刷新不丢过程

**W3 Web 预览（最大差异化）**
- 静态构建预览：bot 产出静态页（vite build）→ wrapper 端口注册表起静态服务 → server 鉴权代理 → 频道内 iframe
- webapp artifact 类型 + 启停治理（随 bot 运行时生命周期）
- 二期：真 dev server（next dev）支持热更新的构建场景
- 里程碑：'做个销售看板页面' → 频道内直接看到可交互页面

**W4 快照与恢复**
- tar.gz 工作区快照（wrapper 流式产出 → server 收流 → 卷/S3）+ `workshop_snapshots` 索引
- restore 端点（对标 Craft restore：停 serve → 解包 → 重启 → 校验哨兵）
- opencode 会话历史随快照走（对标 opencode-history.tar.gz）
- 里程碑：reset 后一键回到昨天的工作区状态

**W5 定时任务**
- cron 三模式编辑器（interval/daily/advanced 编译为统一 cron，抄 schedule.py 纯函数设计）
- worker 侧执行器：到点 → 拉起 bot 沙箱 → headless 轮次（无 SSE，结果落 artifacts + 通知频道）
- 预授权目标：创建时圈定可触碰的文件/工具范围，跑时不触发人工审批（对标 PreApprovedTarget）
- 里程碑：'每天 9 点抓取并更新这份报表' 全自动运行，历史可查

**W6 Bot 资产库 + 凭据注入**
- skills/数据集 managed symlink 进 bot 工作区 + hash 推送（抄 skills_hash + push daemon）
- OpenConnector 凭据按任务作用域注入沙箱环境（对标 ONYX_PAT wire 注入）
- 里程碑：bot 在定时任务里用授信连接器拉外部数据并产出报表

## 8. 与既有体系的融合点

- **审计**：每个新动词一个 `workshop.*` 事件类型；上传/分享/预览访问/定时启停全落审计（对标 Craft receipts 的场合由 audit_events 覆盖）
- **计量**：W2 起轮次用量进 `workshop_turns.usage`；W1.x 把 `code_runs`/`workshop_turns` 用量统一接 Lago（P1 已列的计量上报，扩展为两类事件源）
- **多租户**：所有新表带 owner/租户外键；预览代理的分享作用域复用频道成员 ACL（不新造 sharing_scope，Craft 的 public 分享在 SaaS 化需求明确前不做）
- **可观测**：SSE 流、代理、执行器全部挂 P1 的 request_id/结构化日志

## 9. 风险与取舍（明示）

1. **并发模型**：W2 用单进程内存锁起步，多副本部署前必须升级（worker 承接 runner 或引 Redis）——设计时把锁接口抽出来。
2. **预览安全**：webapp 代理是最大的新增攻击面（用户产物的 JS 在内网上下文里跑）。静态预览阶段用独立端口 + 严格 CSP + 不带凭据的代理；dev server 阶段再加来源白名单（抄 allowedDevOrigins）。容器级隔离（P1-B 的 per-bot 容器）是 W3 的前置。
3. **不抄的部分**：Craft 的 k8s 后端（我们有 supervisor 路线）、Redis（暂不需要）、public 分享（合规未定）、external_app 自建 OAuth（走 OpenConnector）。
4. **P1-B（supervisor per-bot 容器 + 状态机）仍独立推进**——它是 W3 的前置和 W4 快照的宿主，优先级在本设计内不变。

## 10. 立即下一步

1. 执行 P1-A 计划（已有，6 任务）。
2. W1 骨架拆实施计划（建议先做：表 + 聚合 API + 文件树/上传 + artifact 索引接线 + 前端 Tab，约 4 个任务粒度）。
3. W2 之前先做一个 opencode SSE 事件格式的 spike（半天：`GET /event` 实采一轮事件样本，冻结事件 schema 再写翻译层——避免抄 Craft 的 schema 但 opencode 版本行为不匹配）。
