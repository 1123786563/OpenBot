# Craft Parity Remediation — Task 6 验证报告（全链路 + 终审）

> 执行：Task 6 验证代理｜2026-10-13
> 检查点：HEAD = `6c7c0d16`，工作树 clean（`git status --short` 空输出）。
> 交付范围：`3c690410..6c7c0d16`（remediation Tasks 1–5，共 11 个提交），用户自有文档提交 `b4fe6a87` 已排除（非本交付）。
> 结论先行：**DONE_WITH_CONCERNS** — 单测/类型/装配层全绿、六能力契约级全部落地；真实 agent-sandbox 冒烟确认了 MCP 中继链与 ZIP/脚本契约，同时暴露 6 项真实现场缺口（§4，含 2 项交付级、3 项环境拓扑级、1 项状态机级），按计划规则以命名 finding 回流控制器，不在本任务内私自修复。

---

## 0. Round 2 复验（修复后，2026-10-13，检查点 `6488eab2`）

> 修复提交：`ff7d18ab`（F-A：auth fetch 补丁 — content-length 按字节、SSE 经 `Readable.toWeb` 流式、abort signal 接线）、`0aae4340`（F-B：SDK_TOOL_PATHS 部署候选 + 相对解析；F-D：createSession 在端口预留后回读行；F-F：resetFailedSessionForRepair CAS）、`6488eab2`（F-C：按 onyx `_walk_sandbox_dir` 重建递归扁平遍历；OCR 同族 bug：404→[] + 真失败拒绝 ack；F-E：网关 /webapp/* 中继证实不可行 → 沙箱宿主拨号 + compose 发布 3010-3100 + 恢复 `-H 0.0.0.0`）。

### 0.1 复验命令与结果

| # | 命令（cwd=repo） | 结果 |
|---|---|---|
| R2-1 | `cd server && bun test tests/craft-*.test.ts`（30 文件） | **439 pass / 0 fail**（10.56s） |
| R2-2 | `cd server && bun run typecheck` | **EXIT=0** |
| R2-3 | agent-sandbox 经 compose override 发布 3011-3098（本机 3010/3100 被占用）；`AGENT_SANDBOX_URL=http://127.0.0.1:4300` **不再绕行**（F-A 的真正测试位形） | 容器健康，全链跑通 |

### 0.2 finding 状态（全部真实现场证据）

| # | 状态 | 现场证据 |
|---|---|---|
| F-A | **FIXED（live）** | 回环沙箱 URL 下会话创建 201→active（原先 400/500）；完整 turn 环闭环：send-message → 真实 GLM 回合（含 45s 非活性 abort → steer 续跑的设计机制）→ turn 落定 → **assistant 消息持久化**（messages 出现 error-frame 与 steer 文案两型落库）；409 busy；`POST /interrupt` → `{"interrupted":true}` 且 active turn 即时清除 |
| F-B | **FIXED（live）** | 部署沙箱会话目录实例工具目录 **14 项，含 `connect_app` 与 `webapp`**（round 1 为 12 项无两者）；模型实际调用 **`webapp` 工具**成功，observation 逐字节（`web app is not running; call webapp start` + `state: not_running / port: 3012 / app dir: outputs/web / scaffolded: no / logs: nextjs.log` — F5-E 契约）；**`connect_app` 工具被真实调用且 `context.ask` 停车**（tool part status `running` 持续数分钟） |
| F-C | **FIXED（live）** | 嵌套树 `outputs/{report.md, web/package.json, web/src/app/page.tsx, web/node_modules/pkg/index.js, web/.env}`：`download-directory/outputs` → **3 文件 ZIP**（递归收集），node_modules/** 与 .env 正确剪除；zero-entry 退化消失 |
| F-D | **FIXED（live）** | 全新会话初始装配即含 `start-webapp.sh`（容器 ls 实证；round 1 三个会话两缺） |
| F-E | **FIXED（live）** | 脚本真跑后：`webapp-info` → **`"ready": true`**；`GET /sessions/:id/webapp` → **200 + dev server HTML 正文**（经服务器代理）；host 直连发布端口 200 |
| F-F | **FIXED（live）** | 将 dev 用户空会话行置 `failed` 后 `POST /sessions` → **同 id 修复为 `active`**（round 1 必抛 Stale 500） |
| OCR bug（managed-content 404→[]） | FIXED（439 套件背书） | 6488eab2 的 craft-managed-content 增测 + 全绿 |

### 0.3 转移项 (iii) 的 round-2 状态

**ask 半段 REAL**：connect_app 工具注册（目录证据）+ 被模型真实调用 + `context.ask` 停车（tool part `running`）。**decide 半段与超时回绝仍不能现场闭环 — 新 finding F-G**：停车期间 attach SSE（`GET /turns/:id/events`）0 字节 — 既无 `connect_app_request` 卡（request_id 的唯一出口），也无 keepalive；且窗口到期未见 decline 落为工具结果（步骤最终以"非活性 abort + steer"收场，两轮复现，含按默认派生序 approval=25 < inactivity 的位形）。request_id 无其他出口（无 audit 行、无 pending 列出端点）。装配级 decide/超时语义仍由 craft-connect-app 套件背书。**F-G（Medium）回流控制器。**

### 0.4 新观察（随 F-G 一并流转）

- **F-H（Low，待产品确认）**：对会话 `POST /interrupt` 之后的后续两个 turn 出现"admit 后即刻清除、无 prompt 送出、无落库、无错误行"（同会话连续两次复现）；疑 interrupt fence 跨 turn 残留或清理竞态。
- 环境注记（非产品缺陷）：compose 默认发布 3010-3100 与本机 dev 端口冲突（APP_PORT=3010 的 vite、OrbStack 残留 3100 占用）——本地 dev 需先解冲突；本轮以 override 发布 3011-3098 完成验证。

### 0.5 OCR round 2

同命令重跑（范围随 HEAD 扩至含修复提交，36 文件）：**仍 429 配额阻断 — 8/36 完成、13 条意见、无 Critical/High**（3 × bug·medium：pendingConnectApp 删除路径单一、决策路径非原子、轻路径 ack 哈希未 dispose 旧实例——末条与 §3(i) 实测的实例配置缓存行为同族）。报告 `ocr-report-round2.md`，原文 `ocr-comments-round2-raw.txt`。round-3 待配额恢复。

---

## Round 3 复验（修复后，2026-10-13，检查点 `fe169d20`）

> 修复提交：`fe169d20`（F-G + F-H + OCR round-2 mediums，16 文件：agent-sandbox src 3 + tests 2，server src 7 + tests 4）。证据源：修复代理报告 `.superpowers/sdd/task-6-report.md`「F-G/F-H/OCR-mediums fix」节——每 finding 先 RED 后 GREEN；F-G/F-H 另有真实现场全链路复现（重建镜像 + docker run 沙箱 + 自建 server 3099 + 真实 GLM-5.3 回合），复现后环境已拆、DB 测试行已清。本节为该报告的持久化摘录。

### R3.1 F-G — FIXED（live 全链实证）

**根因：五处仅现场可达的断层叠加**（单测缝隙全部绕开了它们——craft-connect-app 套件把 permission.asked 直接注入 bus 队列、用 stub gateway 应答（不经真网关 filter/allow-list）；attach 相关只测到 `subscribeToExistingSessionEvents` 生成器，从未穿过 `createTurnRoutes` 的 HTTP 面；boot 的 server.timeout 在单测里不存在）：

1. **网关 family filter 丢 `permission.asked`**（`agent-sandbox/src/sse.ts` forwardBlock → `events.ts` familyOf）：五族之外一律 "other" → null——ask 永远到不了 server 的 PodEventBus（无 announce 卡、无 pending 条目，窗口到期无从回绝）。修复：permission.asked 入 SANDBOX_EVENT_TYPES + 新 "permission" 族（控制面例外）。
2. **网关剥掉 `/event` 的 `?directory=` 作用域**（proxy /events handler → forwardEvents 只拉裸 `/event`）：opencode 按 directory 分实例发布事件，craft 会话（directory-scoped）的回合事件**整条不可见**（现场实证：同回合裸流与 scoped 流经网关均 0 字节，直连 per-bot `4400/event?directory=…` 8KB+ 正常）。修复：forwardEvents 增 `upstreamQuery`，proxy 透传调用方的 directory。
3. **权限应答动词不在网关 allow-list**（proxy allowedPath 只认 2 段 `/session/:id/…`）：`POST /session/:id/permissions/:pid` 404 → 决策端点与超时回绝的 answerPermission 全部静默失败（返回 false，opencode 继续停车）。修复：3 段形状路由入列。
4. **boot server 的 SSE idle-timeout 豁免漏了 craft**（`server/src/index.ts:4126-4131` 只对 `/api/workshop/*/events` 调 `server.timeout(request, 255)`）：Bun 默认 ~10s idle 切断，attach 流首条 keepalive 在 15s——现场实测 `time curl` **9.038s 被切、0 字节**。修复：豁免条件扩至 `/api/craft/`。
5. **turn executor 每趟 pass 硬编码 `opencodeSessionId: null`**（turn-executor.ts driveOnePrompt，注释声称"drive loop 从行上解析"但从未实现）：每趟 mint 新 opencode 会话 → attach 订阅的行上 id 与事件流 sessionID 错位，attach 永远看不到回合自身事件（且跨 turn 上下文丢失）。修复：每趟 pass 前重读行、把行上 id 交给 ensureSession（404 仍走 re-mint 回写）。

**RED→GREEN**：agent-sandbox `sse.test.ts`（forwardBlock(permission.asked) 修复前 null → `event: permission`）、`proxy.test.ts`（permissions 应答 404 → 200 转发；`GET /events?directory=X` 到达上游 `/event?directory=X`）；新增 `server/tests/craft-turn-sse-attach.test.ts` 穿真 `createTurnRoutes` SSE 端点 + 真 executor/manager/gateway/bus，事件源经真 forwardBlock——stash 网关修复即 RED（卡永不上流、9s 超时），恢复即 GREEN。

**live 证据**（修复前三处 RED 现场：attach 9.038s 被切 0 字节、网关 scoped/裸流 0 事件；修复后）：attach SSE 承载**完整回合**——65 thought chunks、53 message chunks、tool_call_start/progress（connect_app 运行中=停车）、**1 帧 `connect_app_request`**（request_id e61d838b…，F4 wire 逐字段）、keepalives、停车期间存活；`POST /apps/connect/:request_id/decision {"decision":"declined"}` → **200 → 回合以 declined 工具结果恢复**（落库 `tool_call_progress … connect_app … completed`，模型答复 "Connection declined — Slack (app 7) isn't connected…"），turn 正常收尾——**decide 半段现场闭合：step 经 decline 而非非活性 abort 收场、恰好一次应答、无重试**。

### R3.2 F-H — CONFIRMED + FIXED

**机制确认**（装配级复现 + 现场同形）：`POST /interrupt` 置 fence；被中断 turn 的 runner 经 `shouldInterrupt` 轮询自杀式 cancelled → `finishTurn(CANCELLED)` 清掉 active 指针 → finally 的守卫 `active !== null && active.turnId === turnId` **必为 false**（自己的 finishTurn 刚清了指针）→ **end-of-turn 清 fence 永不执行**；而 interrupt 契约的 "start of each turn" 清除在 admit 路径上根本没接线。fence TTL 600s，泄漏窗口内每个新 turn 都被它在 ~1s 内 cancelled（admit 后即刻清除、无 prompt 输出、无落库、无错误行）。修复两处（都是契约原文）：① turn-executor.ts finally：`active === null` 也算 still-owns（仅指针指向**别的** turn 才让位）；② message-routes.ts admit：409 检查通过后、createInteractiveTurn 前 `fence.clearInterrupt`。**live**：interrupt 取消 turn 1 后，后续 turn admit 并跑完（答复 "ok" 落库）。

### R3.3 OCR round-2 mediums — 全修

1. **pendingConnectApp 删除路径单一**（serve-client.ts）：map 值携 `{requestId, deadline}`；到期先 loadPending——已裁决（决策端点 clearPending 过）则跳过冗余 reject，自行 reject 成功后 clearPending（迟到卡片点击落 200 no-op 而非 502 重试至 TTL；reject 失败保留记录供重试）。
2. **决策路径非原子**（connect-app-routes.ts）：`takePending`（Redis GET+DEL 单脚本；in-process 单同步块）替换 loadPending——并发双击恰一人拿到记录、一人 200 no-op、恰好一次 sandbox 应答 + 一条 audit 行；**502 失败路径 re-stash 保重试**。
3. **轻路径 ack 哈希未 dispose 旧实例**（session-ready.ts 轻路径）：opencode.json 重写后、哈希 ack 前，`session.opencodeSessionId` 存在即尽力 dispose（对齐 manager.regenerateSessionConfig 契约）——否则预崩溃实例永远服旧配置且 sessionRuntimeStale 永假。

### R3.4 回归计数（检查点 `fe169d20`）

`cd server && bun test tests/craft-*.test.ts`：**446 pass / 0 fail（31 文件；基线 439/30）**；`bun run typecheck` EXIT=0。`cd agent-sandbox && bun test`：**77 pass / 0 fail（基线 72 + 5）**；typecheck EXIT=0。零新依赖、零 schema 变更（`3c690410..fe169d20` 对 package.json/bun.lock/db schema 无 diff，复核通过）。

### R3.5 OCR round 3

已完成（session `24c5f9d8`，`3c690410..HEAD`，8m21s）：**41 文件入选、31 个因 bigmodel 429 配额失败（三轮同形阻断）、18 条意见（1 high / 7 medium / 10 low）**。全部 high/medium 已处置于 `faab3c33`：6 项修复（鉴权先于破坏性 take、Branch-4 诚实失败 + permissionGone→410 终态、Redis eval 失败透传 502、超时兜底先拒后删、超时/decide 原子对账、tailLog 下限），1 项裁定为有意偏离（webapp restart 臂的 pid cwd 守卫——onyx 同样裸 `kill -0`，OpenBot 更安全，已录 onyx-contract §6 #9）；10 low 全部 defer。明细见 `ocr-report-round3.md`（原文 `ocr-comments-round3-raw.txt`）。**覆盖不完整（10/41）为持续配额阻断，环境性缺口如实记录**；三轮累计已审 23 个不同文件，含 connect-app/manager/routes/turn 引擎等核心面，其余文件由 SDD 评审与 456 craft 测试背书。处置后套件 **456 pass / 0 fail（31 文件）** + typecheck clean。

### R3.6 未变化项

company-search 维持 BLOCKED（§5.4）；compose 默认发布 3010-3100 与本机 dev 端口冲突的环境注记维持（§0.4，非产品缺陷）。

---

## 1. 命令与结果（round 1，检查点 `6c7c0d16`）

| # | 命令（cwd=repo） | 结果 |
|---|---|---|
| 1 | `cd server && bun test tests/craft-agents-template.test.ts … tests/craft-webapp-tool.test.ts`（全部 28 个 craft 测试文件） | **425 pass / 0 fail**（1245 expect() 调用，11.35s） |
| 2 | `cd server && bun run typecheck` | **EXIT=0**（0 错误） |
| 3 | `cd agent-sandbox && bun test` | **72 pass / 0 fail**（207 expect()，9 文件） |
| 4 | `cd agent-sandbox && bun run typecheck` | **EXIT=0** |
| 5 | `docker compose build agent-sandbox`（镜像重建，源 `agent-sandbox/src` @ `6b627b0f`，NPM_REGISTRY=npmmirror） | **EXIT=0**，镜像 `openbot-agent-sandbox:latest`，opencode-ai@1.18.7 |
| 6 | OCR：`ocr review --from 3c690410 --to HEAD --audience agent --exclude "docs/**,.superpowers/**,docs/plans/**"` | 见 §6（报告存 `ocr-report-round1.md`） |

测试/类型检查日志存档于验证执行记录（/tmp/task6-*.log），关键行已摘录于本表。

## 2. 真实全链路演练（real vs stub 逐链路）

**拓扑（全部真实组件）**：OpenBot API server（host，`bun --env-file src/index.ts`，端口 3099，`OPENBOT_SINGLE_USER=true` + `OPENBOT_CRAFT_ENABLED=true`，本分支代码）+ agent-sandbox（docker compose，真实 opencode-ai@1.18.7 per-bot serve）+ PostgreSQL（openbot-postgres-1）+ 真实 GLM-5.3（bigmodel 网关，.env 凭证）+ fixture MCP server（host:3999，受控 streamable-HTTP echo）。Web App 预览/前端未起（浏览器面不在本轮），SSE 消费端用 curl/脚本直连。

| 链路 | 方式 | 证据 |
|---|---|---|
| 认证 HTTP 入口 `POST /api/craft/sessions` | **real** | 201 + 会话行（status active、nextjs_port 3011/3012 预留、sharing_scope private）；single-user 守卫全链生效 |
| 工作区装配（AGENTS.md 8009B、opencode.json、3 个插件文件、outputs/attachments 骨架） | **real** | 容器内 `ls` 逐一在场；opencode.json 键序 = onyx（schema/model/provider/enabled_providers/permission/plugin/mcp），`connect_app:"ask"` 在场 |
| opencode 会话铸造（`?directory=` 实例锚定） | **real** | `ses_ecec…` 系列，directory 字段 = 会话目录 |
| managed-content reload（MCP set 变更 → 重写 opencode.json） | **real** | mcp block 落盘：key `task6-fixture-echo-task6-fixture-echo`（onyx `_server_key` 语义）、url=中继路由、`X-Onyx-Mcp-Session` 头 = 会话 id |
| **MCP 工具调用全链**：opencode MCP 客户端 → 服务器中继 → 逐用户凭证解密 → fixture | **real** | fixture 日志：`initialize`/`notifications/initialized`/`tools/list`/`tools/call` 全部 `auth=Bearer fixture-token-task6`；模型回复含 `FIXTURE_ECHO:mcpping` |
| 真实模型 turn（GLM-5.3，推理+write 工具+回答） | **real（沙箱侧）** | opencode 会话 tokens（input 6762/output 65/reasoning 33）；消息流含 reasoning、tool(write)、`DONE`；`POST /session/:id/message` 直连与经网关 4300 两条路均 ~4s 干净收尾 |
| 持久化消息 / SSE 输出 / turn 落库 | **stub 级覆盖；real 受阻（finding F-A）** | 沙箱内回合完成，但服务器侧 runner 不消费事件流：turn 永远 RUNNING、无 assistant 落库、SSE 0 字节。装配级/单测层该链路绿（craft-streaming-persist 等） |
| start-webapp.sh 真执行（flock/pid cwd 守卫/真 `bun run dev`/探活） | **real** | §3(vii)：ready 行逐字节、幂等重跑 `already running (PID 1567); reusing` |
| ZIP 下载（webapp-download / download-directory / 空 dir / 缺失 dir） | **real** | §3(viii) 字节级证据 |
| Web App 预览代理 | **real（拒绝路径）** | 503 + 指引文案；可达路径受 finding F-E 阻断 |
| connect_app ask→decide / 超时 | **blocked（finding F-B）** | 插件未加载 → 工具不存在 → ask 无法产生；见 §3(iii) |
| 审批 gated 工具 ask→decide | **未执行** | 依赖 turn 引擎（F-A）；窗口/决策端点单测绿 |

## 3. 转移项逐条核销（Tasks 2–5 评审转移的 8 项）

**(i) deployed agent-sandbox 中一次 craft 会话 + fixture MCP server — 完成（real）**。会话经服务器 HTTP 入口创建（非 harness）；fixture MCP server 直连观察：MCP 客户端在实例启动时经中继完成 initialize/tools-list，工具调用回程 `FIXTURE_ECHO:mcpping`，凭证逐调用解密附挂（Bearer fixture-token-task6）。**注意**：会话先铸造后 seed MCP 再 reload 的路径存在实例配置缓存（dispose 404 降级 no-op，`[craft] instance dispose unsupported … degraded to no-op`），配置变更须等 runtime 回收或重启后生效 — 与 Task 4 交付说明一致，非新缺陷。

**(ii) SDK_TOOL_PATHS 对部署布局的解析 — 已核实：不解析（finding F-B，交付级）**。
- 候选 1 `/home/sandbox/.opencode/node_modules/@opencode-ai/plugin/dist/tool.js`：容器内 `find / -path "*@opencode-ai/plugin*" -name tool.js` 为空；`/home` 下只有 `bun`，运行用户 uid 1000(bun)，HOME 在 per-bot serve 时被改写为 configDir。
- 候选 2 `/home/sandbox/.config/opencode/node_modules/...`：前缀 `/home/sandbox` 不存在，同样失败。`import()` 实测：`ABS-FAIL ResolveMessage: Cannot find module '/home/sandbox/.opencode/...'`。
- SDK 实际落点（opencode 1.18.7 自行物化）：会话工作区 `<session>/.opencode/node_modules/@opencode-ai/plugin/dist/tool.js`（实测 `WORKSPACE-ABS-OK tool= function`）与 `/config/opencode/node_modules/...`（`CONFIG-OK`）。
- 后果（实测）：`GET /experimental/tool?directory=…&provider=openbot&model=GLM-5.3` 共 12 个基础工具，**无 connect_app、无 webapp** — 两个 remediation 插件在真实沙箱永不注册。turn-budget 不 import SDK，不受影响。
- 修复方向（供控制器）：候选列表增加 `<cwd>/.opencode/node_modules/...` 与 `/config/opencode/node_modules/...`，或改用裸 `@opencode-ai/plugin` 导入（opencode 加载器自行解析，其物化行为已被本报告证实）。

**(iii) 真实 connect_app ask→decide + 超时环 — blocked（依赖 F-B）**。插件不注册 ⇒ 模型无法调用 ⇒ permission.asked 不会产生。F4 B/C/D 的 decide 端点、pending/announce 语义、超时兜底在 `craft-connect-app.test.ts`（689 行）装配级全绿；真实环留待 F-B 修复后重跑。同域替代（gated-tool 审批 ask→decide）本轮未能执行，因 turn 引擎受阻（F-A）。

**(iv) C5 勘误 — 已记录**。`onyx-contract.md` §4.0 C5 原文"agent-sandbox `/devserver/start` 池"与实现不符：实现采用 onyx 自己的预留端口模型（DB 预约 [3010,3100) + 工作区内 start-webapp.sh 自管理进程），理由（Task 4 评审转移）：devserver 池无法绑定指定端口、无法保住 log+pid 文件同址、且在沙箱内触发会泄露网关 token。本报告将该勘误落进 `onyx-contract.md` §6（勘误 5）与 `port-parity.md` 差异表。

**(v) "scaffolds outputs/web" 措辞勘误 — 已记录**。工具 description 保持 onyx 逐字节（"it scaffolds outputs/web, installs dependencies…"），而脚本实际把 scaffold 推迟给 agent（无 `outputs/web/package.json` 时 `exit 1`："no web app scaffold found - build your web app under outputs/web first…"）。差异由 AGENTS.md 指引补偿（Task 4 已测）。真实现场已复现该脚本行为（先无 scaffold 场景由脚本内容+测试覆盖，带 scaffold 场景实跑成功）。勘误落 `onyx-contract.md` §6（勘误 6）。

**(vi) fixture §F.86/§F.87 结构性不可满足 — 已记录**。`fixtures/webapp-tool.md` §F 的"模板拷贝 `cp -r /workspace/templates/outputs/*`（Next.js 16.1.1）"与"dev server 环境 `ONYX_WEBAPP_PORT/ONYX_WEBAPP_BASE_PATH/ONYX_WEBAPP_ALLOWED_DEV_ORIGINS`"两条在 OpenBot 环境结构性不可满足（无镜像模板、无 pod 内 env 注入）。已在 fixture 文件追加勘误注记（Erratum E1），并在契约 §6（勘误 7）交叉引用。

**(vii) 真实现场 webapp 启动三件套**：
- SDK-path 加载：**FAIL**（F-B，见 (ii)）。
- 真实 `bun run dev`：**PASS（real）** — 脚本 `bun install`（lockfile 重建）→ `PORT=3011 nohup bun run dev … 9>&- &` → `nextjs.pid` 写入 → 探活循环 `curl --noproxy '*'` → ready 行逐字节输出、exit 0；`nextjs.log` 持有 `dev server on 3011`。
- 真实 flock：**PASS（real）** — `flock -x 9` + `9>"$SESSION_PATH/.webapp.lock"`；子进程 `9>&-` 不继承锁；pid cwd 身份守卫实测 `readlink /proc/1567/cwd` = 会话 `outputs/web`，二次执行走 `already running (PID 1567); reusing` 分支。
- 附带发现：**F-D**（初装路径不写 start-webapp.sh，见 §4）与 **F-E**（预览代理拨 host 回环，见 §4）。

**(viii) 真实现场 ZIP 下载冒烟（含真空 outputs/web 语义）— 完成（real，字节级）**：
- `GET /sessions/:id/webapp-download`（有内容）：200 `application/zip`，`Content-Disposition: attachment; filename="task6-webapp-zip-webapp.zip"; filename*=UTF-8''…`（会话名 sanitize + `-webapp.zip` 后缀），deflate、仅文件条目，`index.html`（68B，模型 write 工具产物）。
- **真空 outputs/web（目录存在、零文件）**：200 `application/zip`、22 字节零条目 ZIP（裸 EOCD `504b 0506`+全零）— 与 onyx `writestr` 循环对空集的行为一致（onyx 对"目录不存在"才是 404）。
- `outputs/web` 不存在：404（`webapp-download`）；`download-directory/does-not-exist`：404 `{"error":"Directory not found"}` — F6-A 错误分支吻合。
- `download-directory/outputs/web`：200，arcname 去前缀（`index.html`）。
- **但 `download-directory/outputs`（顶层只含子目录）：200 + 零条目 ZIP — 嵌套文件被丢弃（finding F-C，交付级）**。`GET /files?path=outputs` 同为扁平（内部一致性保持，但与 F6-A 的递归语义背离）。

## 4. Findings（命名回流控制器；本任务不修业务码）

| # | 级别 | 摘要 | 证据锚点 |
|---|---|---|---|
| **F-A** | Critical（真实现场部署） | **auth 全局 fetch 补丁破坏 craft 对回环沙箱网关的调用**：`server/src/auth/index.ts:41-140` `patchGlobalFetchForLocalhost()` 把 loopback fetch 重实现为 node:http。现场一：`POST /file` 写入在物理 201（TCP tap 亲见）下被服务器读成 400 → 会话创建 500；现场二：turn runner 的 message 流消费永久卡死（沙箱侧回合完成、宿主侧事件零到达；turn RUNNING 永不落库；SSE 0 字节；inactivity 超时不触发）。改用非回环匹配主机名（`localtest.me`→127.0.0.1）后创建恢复正常，判别指向该补丁（具体响应重构/keep-alive 交互未完全归零）。非本分支引入（auth 补丁先于 craft port），但 craft 是首个长流+流式消费方 | 会话创建错误栈（tap 日志对照）；turn 卡死：`/turns/active` RUNNING + opencode 消息流已 DONE；lsof 无 events 连接 |
| **F-B** | High（交付） | **SDK_TOOL_PATHS 在部署 agent-sandbox 布局永不解析 → connect_app/webapp 插件不注册**（§3(ii)）。六能力 C4/C5 的"restore-parity"在契约文本与单测层成立，真实现场工具不存在 | `templates/connect-app.plugin.ts:22-25`、`templates/webapp.plugin.ts:21-27`；容器内 import 实测 + 工具目录实测 |
| **F-C** | High（交付） | **directory-archive 假设网关 listing 递归；真实 listing 扁平 → download-directory 顶层仅子目录时输出零条目 ZIP，嵌套文件静默丢弃**（F6-A 背离；单测被递归 fake listing 掩盖） | `server/src/craft/directory-archive.ts:61-77`（单次 listFiles，无递归）；现场 `outputs` 请求 22B 空 ZIP vs `outputs/web` 181B |
| **F-D** | Medium（交付） | **初装路径不写 start-webapp.sh**：`manager.createSession` 把 `store.createSession` 返回的行（nextjsPort=null）直接交给 `reconcileSession`，端口在 reserve 之后才落库 → `session-ready.ts` 的 `webappPort: session.nextjsPort` 为 null → 脚本跳过。仅在后续全量 reconcile（stale hash / 修复）时补写。真实现场 3 个服务器创建的会话 2 个缺脚本 | `manager.ts` createSession（stale row）；现场：cs-4699 无 start-webapp.sh（reload 非陈旧不补写）vs cs-1aec（seed MCP 后 reload 补写成功） |
| **F-E** | Medium（环境拓扑，不可标 parity） | **预览代理与 ready 探测拨 host 回环保留端口**：`webapp-proxy.ts` `upstreamBaseUrl = http://127.0.0.1:${session.nextjsPort}`、`webappDevServerReady(port)` 同理；dev server 在容器内监听同端口（实测容器内 200、host 000）。host server + docker sandbox 拓扑下 ready 永 false / 预览永 503。agent-sandbox 网关存在 `/webapp/*` 中继面未被使用 | 现场：webapp-info `ready:false` + 预览 503，容器内探活 200 |
| **F-F** | Low/Medium（状态机） | **failed 会话经 getOrCreateEmptySession 修复路径必抛 StaleProvisioningAttemptError**：`reconcileSession` 不先把行复位 initializing，finalize CAS（`store.ts:282-313` WHERE status='initializing'）对 failed 行 0 命中 → 预配置空会话一旦 failed 即砖化（500 循环），直到手工删行。由 harness 复现（真实 500 样本在 F-A 掩蔽下） | harness 栈：`session-ready.ts:262` Stale 抛出；行状态 failed |

**处置建议**：F-A/F-F 归平台修复（auth fetch 补丁旁路 craft 流量 / 修复复位 initializing）；F-B/F-C/F-D 为 remediation 交付缺陷，按 SDD 修复环流回对应任务；F-E 需产品决策（走网关 `/webapp/*` 中继 or 发布 devserver 端口），修复前 **C5 不得宣称真实现场 parity**（port-parity 已按此降格标注）。

## 5. 交付级账目复核

### 5.1 Fixture → 测试映射（6 个 fixture 全量核对）

| Fixture | 主测文件（全绿） | 关键断言抽查 |
|---|---|---|
| F1/F2 agents-md-rendering | craft-agents-template(252 行增量)、craft-managed-content(636) | connectable 倒置（"personal unconnected apps only"）、段落渲染 |
| F3 opencode-config-mcp | craft-opencode-config-mcp(189)、craft-mcp-servers(105)、craft-session-config-mcp(310) | `acme-tools-42_* allow` 先行 + `acme-tools-42_delete_everything deny` 后置（findLast 语义）实测在场（:99-106）；不可认证整台剔除；指纹顺序无关 |
| F4 approvals-and-connect-app | craft-connect-app(689)、craft-mcp-relay(482)、craft-approvals | declined 字符串逐字节（:175）；decision 端点错误分支；KV pending/announce |
| F5 webapp-tool | craft-webapp-tool(1085) | ready 行逐字节（:366-379）；六行为 + 脚本契约 + 404 |
| F6 zip-download | craft-file-routes(146 增量) | sanitize 分支表（allow_dots :564）；仅文件条目；隐藏过滤 |

无 fixture 悬空；F4 真实环与 F5 真实插件加载为已记录缺口（F-A/F-B）。

### 5.2 裁决表 restore-parity 抽查（载荷行）

- C1/C2：live 渲染 + 倒置已实证；C3：mcp block 字节级 live（含会话头/键名）；C6：ZIP live 字节级。
- C4/C5：契约与单测层成立；**真实现场降格**（F-B/F-E）→ port-parity §remediation delta 已相应标注"契约级 restore / 真实现场 blocked-by-finding"。
- 4.1#3/4/7（模板行回原文）：AGENTS.template.md 含 webapp 工具条目与 Outputs 段（tests/craft-agents-template 钉死）。
- 4.6#6（soft=0.4×hard）：acceptance-report B3 已 PASS。
- 4.7#1/4.8#1（subagent 预检/TodoWrite 标题）：对应测试文件在场且绿。
- 计数复核：19 restore / 40 env-equiv / 2 solved / 1 no-change = 56 行 — 与 §五 全行一致，blocked 0（**company-search 仍为计划外 BLOCKED，见 §5.4**）。

### 5.3 配置/依赖变更 — 无（验证）

`git diff --stat 3c690410..HEAD -- server/package.json server/bun.lock bun.lock package.json agent-sandbox/package.json server/src/db` = 空。范围外触碰仅 `server/src/audit.ts`（+7，审计事件常量，随 369a5147）与根 `AGENTS.md`（用户自有）。**零新依赖、零迁移、零 schema 变更** — 与"零新依赖"交付承诺一致（zip-archive.ts 为仓库内实现）。

### 5.4 BLOCKED 沿袭

company-search（组织知识技能）维持 BLOCKED：无 OpenBot kb 路径可供沙箱调用而不泄凭证；`COMPANY_KNOWLEDGE_SECTION` 仍钉住，待 backed skill 落地。**全量 parity 报告在该公司搜索能力 + F-B/F-C/F-D/F-E 修复前不得出具**。

## 6. OCR 覆盖

- 范围：`3c690410..HEAD`（committed），排除 `docs/**`、`.superpowers/**`、`docs/plans/**`（文档与计划文件不属代码评审域；用户文档提交 b4fe6a87 的其余内容随 `docs/**` 排除）。
- 工作树模式：无未提交交付文件（工作树 clean），无需第二轮。
- 结果：**部分覆盖（8/34 文件，15 条意见，无 Critical/High；1 × bug·medium）— LLM 配额阻断**。上游 bigmodel 网关持续 `429 code 1302`（账户速率限制；同账户当日承担了本报告 §2 的真实 GLM 回合），首跑 + 两次 resume 均中止。工具与凭证本身可用（会话可建、可出意见）；已完成部分的完整披露与 round-2 复跑命令见 `ocr-report-round1.md`（意见原文 `ocr-comments-round1-raw.txt`）。
- OCR 的 bug·medium（managed-content.ts:215-218，listFiles 失败吞掉 → stale 清空被跳过但指纹照 ack）与 finding F-C 同族（网关 listing 真实形状与代码假设不符），分诊入 must-fix-before-merge。

## 7. Minor findings 分诊（自账本累积）

**must-fix-before-merge（随对应 finding 一并修）**
- F-C 的掩盖源：directory-archive 测试改用真实网关 listing 形状（扁平）重写（随 F-C）。
- F-D 的测试空缺：createSession 路径断言 start-webapp.sh 在初装即写（随 F-D）。
- OCR bug·medium（managed-content.ts:215-218）：listFiles 失败吞掉 → stale 清空被跳过但 skillsHydrated/指纹照 ack — 与 F-C 同族（网关 listing 契约），随 F-C 一并修（404→[] 映射 + 真失败置 false）。

**defer（后续清理，不阻合并）**
- resolver 每次.reload 2-3 次（Task 2)；uploadFile 缺 TENANT_HEADER（T3)；503 分支未测（T3)；webapp-info 硬编码 status:"running"（T4，F-E 修复时一并)；ready 探测路径与 onyx 探针不一致（T4，同上）；runBootstrapScript stdout/stderr 拼接顺序（T4)；RangeError→误导性 404（T5)；readZip 助手 ~60 行双文件重复（T5)；稳定 null stub 双实例化（T6 前)；并发流共享一个 abort 句柄（T5 前，与 disconnected reaping 同修）；stable-null/decideQuiet 侧账目噪音类（前分支 T2)。

**accept-as-onyx-parity / 环境等价（接受，不再动）**
- 单文件超限 400（craft 层）vs 413（网关中继）分层；未知会话 404 在 body 缓冲后解析；无失败部分写清理（onyx 同）；KV pending 超时存留（onyx 同）；reaper 60s 重叠（CAS 安全）；chip loading 语义合并；间隔反解析不对称；子代理 map 保留差异；streamReducer 组合未测；lone-model 负例空洞；文件命名 craft-streaming-persist；零陈旧 env 间接；插桩可见性经注释而非 spy。

## 8. 环境驱动的残余差异（修复 F 系列后仍将存在的）

1. 单 Bot 共享工作区（`OPENBOT_CRAFT_SANDBOX_BOT_ID=craft`）vs onyx per-user pod — 会话目录隔离承载。
2. 插件随工作区文本落盘（镜像不可烘焙）— 结构性机械偏差（类型糖删除 + SDK 候选路径），onyx 行为等价。
3. 无 egress proxy：审批生产者 = gated 工具 permission.asked（配置面 `OPENBOT_CRAFT_APPROVAL_GATED_TOOLS`），默认 auto-allow。
4. 模板 scaffold 缺位：webapp 脚本期望 agent 自建 outputs/web（AGENTS.md 补偿），onyx 镜像含 Next 模板。
5. 实例 dispose 在网关白名单外（配置变更须等 runtime 回收）— agent-sandbox 侧限制。
6. 预览/ready 的容器内可达性（F-E 修复后表述更新）。

---
*本报告为 remediation 终审证据基线；F 系列 finding 的修复以控制器派单为准，修复后按 §3 各项复验。*
