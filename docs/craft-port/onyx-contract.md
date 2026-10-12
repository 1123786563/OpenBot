# Onyx 契约基线(parity remediation contract)

> Task 1 交付物。本文档把 Onyx 源(pinned commit)的**可观察契约**钉死为 Tasks 2–6 的实现基线:仓库基线、链路源码图(带 file:line)、六项被裁能力的确切契约、`port-parity.md` §五全部差异的裁决表、fixture → Task 映射与无环性证明。
> 同目录 fixture:`fixtures/agents-md-rendering.md`、`fixtures/opencode-config-mcp.md`、`fixtures/approvals-and-connect-app.md`、`fixtures/webapp-tool.md`、`fixtures/zip-download.md`。
> 规则:Onyx CODE wins。凡先前文档(`docs/craft-port/*`)与 Onyx 源冲突处,以本文档为准并在 §6 记录勘误。

---

## 1. 仓库基线

| 项 | 值 |
|---|---|
| Onyx repo | `/Users/wuyongjun/trea/onyx`,HEAD `251933a37fd851093a11169df496695b4895ed74`(== pinned;工作树 dirty 仅 `tools/loadtest/*` 删除与 `.gitignore`,`backend/onyx/server/features/build/` 干净,line number 即 pinned 行号) |
| Onyx Craft 根 | `backend/onyx/server/features/build/`(下文路径均相对于此,缩写 `build/`) |
| OpenBot repo | `/Users/wuyongjun/trea/OpenBot`,BASE = branch `craft-port-verify` HEAD `3c690410608bc8ef1c299998ccb7ce0981336bdd`(本任务提交的父) |
| OpenBot craft 根 | `server/src/craft/` |
| 提交时 dirty(禁止触碰/暂存) | `docs/superpowers/specs/OpenMuse-Mobile-OpenBot-Backend{,-Architecture,-GoLive}.md`(M)、`AGENTS.md`、`docs/plans/`、`docs/superpowers/specs/2026-10-12-openmuse-*.md`(??) |
| 本任务新增文件 | 仅 `docs/craft-port/`(本文件 + `fixtures/`) |
| 无 secret | 本文档与 fixtures 只含代码常量与示例字符串,无凭证 |

---

## 2. 端到端链路源码图(session create → 输出)

### 2.1 会话创建

1. `POST /build/sessions`(`build/session/api.py:106-162`)→ `SessionManager.get_or_create_empty_session`(`session/manager.py:561-665`)。
2. `_ready_sandbox`(`manager.py:478-494`):沙箱已 RUNNING 时执行 **managed content 同步** `sync_managed_content`(`session/sandbox_lifecycle.py:295-309` = build payload → push → record hashes)。
3. `_reconcile_session`(`manager.py:667-764`):一次性读出 `connectable_apps_section`(=`build_connectable_apps_list(get_connectable_apps_for_user(...))`,:685-687)、`mcp_servers`(=`resolve_craft_mcp_servers`,:688)、port、user_name,然后 `setup_session_workspace(...)`(:701-709)→ `ensure_opencode_session`(:710)→ `finalize_session_initialization__no_commit(ACTIVE, opencode_session_id, skills_hash, mcp_config_hash)`(:720-727)。
4. 模型变更热路径:`reconcile_session_llm_config`(`manager.py:280-358`)——期望 opencode.json = `json.dumps(build_provider_opencode_config(llm_config, disabled_tools, mcp_servers, session_id))` 与沙箱读回的现文件**字节比对**(:288-302),不同则 dispose-pending 标记 → `regenerate_session_config`(:340-352,同样携带 connectable_apps_section + mcp_servers)→ dispose 实例。

### 2.2 Managed content 推送(skills / user library / 哈希)

- `build_managed_content_payload`(`sandbox_lifecycle.py:218-232`):
  - `build_user_skills_payload(user, db)`(`backend/onyx/skills/push.py:245-256`)→ `(connectable_apps_section, skills_files)`;fileset 组装 `_assemble_fileset`(`push.py:154-236`):内置技能从盘上拷贝 + 模板渲染(company-search、external-app `SKILL.md.template`);custom 技能从 FileStore zip 解包,路径前缀 `{skill.name}/`。
  - `skills_hash = compute_skill_runtime_hash(skills_files, connectable_apps_section)`(`push.py:58-76`):sha256,len-prefixed 的 connectable_apps 字节 + 按 path 排序的 len-prefixed path/content。
  - `mcp_fingerprint = craft_mcp_fingerprint(resolve_craft_mcp_servers(db, user))`(`sandbox/util/mcp_config.py:78-95`):对 `[server_id, url, sorted(disabled_tools)]` 排序后 json sha256,与顺序无关。
  - `library_files = build_user_library_fileset(...)`。
- `push_managed_content`(`sandbox_lifecycle.py:236-274`):推 `SKILLS_MOUNT_PATH = "/workspace/managed/skills"`(`push.py:53`)与 user_library mount;失败仅告警,`skills_hash` 只在成功后落行(:277-292)。
- 管理端变更触发面:`push_skills_for_users`(`push.py:265-320`,锁定 skills_hash 比对后增量推)。

### 2.3 Workspace setup

- `session_workspace.py:46-105` 生成 setup 脚本:`mkdir outputs/ attachments/`、`ln -sfn /workspace/managed/skills → {session}/.opencode/skills`(:87)、`ln -sfn /workspace/managed/user_library → {session}/user_library`(:89)、写 `AGENTS.md`(:94)与 `opencode.json`(:96)、有 port 时写 chmod-444 `start-webapp.sh`(`nextjs_dev.py:225-242` 的 write snippet)。目录契约见 `sandbox/base.py:98-113`。
- AGENTS.md 渲染:`sandbox/docker/docker_sandbox_manager.py:1095-1112 _build_agents_md` → `generate_agent_instructions(...)`(见 §3.1)。

### 2.4 opencode 配置

- `build_provider_opencode_config`(`sandbox/util/opencode_config.py:218-254`):`{model, provider, enabled_providers, permission, plugin?, mcp?}`;`mcp_servers` 非空时必须给 `session_id`,否则 ValueError(:250-252)。

### 2.5 Prompt / 工具调用 / 事件翻译

- `send_message`(`sandbox/opencode/serve_client.py:1329+`)→ `prompt_async`(:1628-1666,parts=[text, file...],model 可覆写)→ `_consume_from_bus`(:1520-1624)。
- `permission.asked` 分流(`serve_client.py:1668-1702`):**唯一被消费的类别是 `connect_app`**(`:1686-1690`),其余一律 WARN + auto-allow(`:1692-1702`,生产 opencode.json 应已覆盖)。connect_app → `_handle_connect_app_permission`(:1738-1811):metadata 缺 id/不可解析 → 直接 deny;否则 `stash_pending`(Redis `craft:connect_app:pending:{request_id}`,TTL 30min,`connect_app.py:83-87`)+ `announce_request`(`craft:connect_app:announce:{session_id}` RPUSH,TTL 60s,`connect_app.py:57-63`),并记 deadline = `SANDBOX_APPROVAL_WAIT_TIMEOUT_SECONDS`(默认 180s);每秒轮询 `_reject_expired_connect_app_permissions`(:1557-1559, 1813-1827)超时 deny。
- `answer_permission`(:1704-1736):`POST /session/{sid}/permissions/{perm_id}` body `{"response":"once"|"reject"}`。
- 事件翻译 `translate_opencode_event`(:520+)。工具卡:webapp / connect_app **不在** `_TOOL_TITLE`(:185-206)→ 标题回落 `"Running tool"`、kind `"other"`(:209-214)。
- SSE 侧 announce 合流:`manager.subscribe_to_existing_session_events → merge_events_with_announces`(`manager.py:1046-1093` + `session/streaming.py`),live worker 从 `pop_announcement` BLPOP(`connect_app.py:66-80`)取卡并发 `ConnectAppRequestPacket`(`build/packets.py:78-89`)。

### 2.6 审批(egress-proxy 域)

- 生产者是 **egress proxy**(非 permission.asked):被 gate 的外呼在 proxy 停车,写 `ActionApproval` 行并停车等待;`approvals/api.py:120-141` live 列表(窗口 = `SANDBOX_APPROVAL_WAIT_TIMEOUT_SECONDS` 180s,:133-135)、`:144-198` decision(同决策幂等、异决策 `CONFLICT "decision already recorded ({existing})"`,:100-117)、`:201-334` session-grant(hydrate proxy 端会话授权缓存)。EXPIRED 只由 proxy 超时写入(:40-43 注释)。
- 被拒后对 agent 的可观察结果:HTTP 403 + `{"error": "user_rejected" | "not_authorized" | "policy_denied"}`(AGENTS 模板 :78-79 描述,proxy 行为)。

### 2.7 Webapp 代理与信息

- `GET /sessions/{id}/webapp-info`(`session/api.py:659-678`)→ `get_webapp_info`(`manager.py:1493-1545`):`has_webapp`(探 `outputs/web/package.json` 是否存在,`manager.py:1547-1568`)、`webapp_url = f"{WEB_DOMAIN}/api/build/sessions/{session_id}/webapp"`(:1534)、`ready`(basePath 下的 `/_next/static/onyx-ready-probe.js` 任意响应即真,:1570-1593)、`status`、`sharing_scope`。
- `webapp_proxy.py`:反代 + WS,剥离 set-cookie 与身份头(:69-125);base path = `/api/build/sessions/{session_id}/webapp`(`sandbox/nextjs_dev.py:22-28`)。

### 2.8 归档下载(ZIP)

- `GET /sessions/{id}/download-directory/{path}`(`session/api.py:711-745`):`application/zip`(:741),Content-Disposition `build_content_disposition("attachment", filename)`(`backend/onyx/file_store/serving.py:103-115`:ASCII fallback + RFC5987 filename*)。错误:path traversal→403、ValueError→400、目录不存在→404 `"Directory not found"`(:728-735)。
- `GET /sessions/{id}/webapp-download`(`session/api.py:681-708`):同样 `application/zip`;不存在→404 `"Webapp not found"`。
- ZIP 构造:`manager.py:1638-1682 download_directory`(arcname = 去掉 `{path}/` 前缀;filename = `_sanitize_zip_basename(Path(path).name, allow_dots=True) + ".zip"`)、`manager.py:1595-1636 download_webapp_zip`(base `outputs/web`;filename = `_sanitize_zip_basename(session.name or f"session-{id[:8]}", allow_dots=False) + "-webapp.zip"`)、`_zip_files`(:1273-1290,`zipfile.ZIP_DEFLATED`,读不到的文件跳过)、`_walk_sandbox_dir`(:1244-1271,递归、跳过 hidden)、`HIDDEN_PATTERNS`(:141-153)与 `_is_hidden_workspace_entry`(:166-167,含一切 dot 开头)。
- `_sanitize_zip_basename`(:159-163):非 `[A-Za-z0-9_-_.]` 一律换 `_`;`allow_dots=False` 时连 `.` 也换。

### 2.9 决策端点(connect_app)

- `POST /build/apps/connect/{request_id}/decision`(`build/external_apps/api.py:436-472`):body `ConnectAppDecisionRequest{decision: "connected" | "declined"}`;pending 缺失/过期 → 200 no-op(:448-450);会话非本人 → 404 `"Connect request not found."`;沙箱非 RUNNING → 503 `"Sandbox is not running."`;`answer_connect_app_permission(allow = decision==CONNECTED)` 失败 → 502 `"Could not reach the sandbox to apply your choice — please try again."`(pending 保留可重试);成功 → `clear_pending`。
- 用户/管理侧 apps API:`GET /apps`(用户视图,:419-433)、`POST /apps/{id}/credentials`(:371-399,**连接成功即 `push_skills_for_users({user})` 刷新沙箱技能/AGENTS**)、`DELETE /apps/{id}/credentials`(:402-416)。

---

## 3. 六项被裁能力的确切契约

### 3.1 Connectable apps 提示词段(Task 2)

- 模板段 `AGENTS.template.md:51-55`(标题 `## Connectable apps` + 三句 prose + `{{CONNECTABLE_APPS_LIST}}`),逐字节见 fixture F2。
- 渲染:`agent_instructions.py:78-89` — 按 `(id, name)` 排序;空 → `"No connectable apps available."`;每行 `` - External app ID `{id}`: **{name}** ``。
- 数据源:`get_connectable_apps_for_user`(`backend/onyx/db/external_app.py:187-201`)= enabled 且该用户**未**通过认证的 org apps(org-credential apps 对所有人可用,不出现在列表)。
- 注入点:workspace setup(`manager.py:685-687`)、llm reconcile(:346-348)、skills reload(:411-413)、skills_hash 的一部分(`push.py:58-76`)。
- 其余 7 个占位符的替换值(常量):`agent_instructions.py:133-168`(USER_CONTEXT :133-136、provider display :20-42、timeout/margin `configs.py:32-38`)。

### 3.2 Managed skills 内容(Task 2)

- 文件落点:session 内 `.opencode/skills` symlink → `/workspace/managed/skills`(`session_workspace.py:86-88`);skill 目录名 = `Skill.name`,内置含渲染后的 `SKILL.md`(`push.py:101-133`)。
- 哈希与 staleness:`skills_hash`(`push.py:58-76`)写入 Sandbox 行;session 行在 finalize/prewarm 时抄录(`manager.py:267-269, 720-727`);`session_runtime_stale` 比对两哈希驱动 reload 端点(`session/api.py:202-210` + `manager.py:360-437`:非 stale 直接 `return False`,PROVISIONING→409,prompt slot 未拿到→409)。
- 浏览器技能开关:`ENABLE_BROWSER`(`configs.py:74-77`)。

### 3.3 Per-user MCP servers(Task 3)

- 解析:`resolve_craft_mcp_servers`(`mcp_config.py:35-75`)——craft-enabled & 用户可认证(不可认证的整台剔除,只留 info log :56-62);disabled tools 按 server 聚合排序(`:63-66`)。
- server key:`_server_key`(`mcp_config.py:28-32`)= `{slug}-{server.id}`,slug = name lower、非 `[a-z0-9]` 连串折成 `-`、去首尾 `-`、空则 `mcp`。
- opencode.json 权限:`opencode_config.py:119-122` —— `permissions["{key}_*"] = "allow"`(先)、`permissions["{key}_{tool}"] = "deny"`(后,findLast 生效)。
- `mcp` block:`opencode_config.py:126-152` —— `{key: {"type":"remote","url":…,"enabled":true,"oauth":false,"headers":{"X-Onyx-Mcp-Session": session_id}}}`;头常量 `MCP_SESSION_TAG_HEADER = "X-Onyx-Mcp-Session"`(`configs.py:139-145`)。
- 默认禁用工具:`OPENCODE_DISABLED_TOOLS` 默认 `["question"]`(`configs.py:23-26`)→ `permissions["question"]="deny"`(`opencode_config.py:114-116`);注入 AGENTS.md 的 `{{DISABLED_TOOLS_SECTION}}`。
- 指纹:`craft_mcp_fingerprint`(`mcp_config.py:78-95`);admin 变更 → `refresh_mcp_config_hashes_for_users`(`sandbox_lifecycle.py:988+`,只动 `mcp_config_hash`,不推技能)。

### 3.4 connect_app 工具(Task 3)

- 插件 `sandbox/image/opencode-plugins/connect-app.ts`(整文件 81 行,schema + 两条结果字符串逐字,见 fixtures F4)。
- 权限:`_PERMISSIONS_TEMPLATE["connect_app"] = "ask"`(`opencode_config.py:87-89`)。
- 处理链 + Redis 键/TTL + decision 端点:见 §2.5 / §2.9 / `build/connect_app.py`(整文件)。
- SSE 卡:`ConnectAppRequestPacket{type:"connect_app_request", request_id, external_app_id, reason?}`(`packets.py:78-89`;FE 由 `/live`/registry 解析 app 名)。

### 3.5 webapp 工具 + 托管启动(Task 4)

- 插件 `sandbox/image/opencode-plugins/webapp.ts`(294 行;schema、observation 文案、错误分类逐字,见 fixtures F5)。
- `start-webapp.sh`:由 `nextjs_dev.py:121-192 build_webapp_bootstrap_script` 生成、session setup 时 chmod 444 写入(`nextjs_dev.py:225-242`);脚本行为:无 scaffold → 从 `/workspace/templates/outputs` 拷贝模板 + bun install(:141-165)→ 起 dev server(flock 防双起,:81-117)→ 90s 就绪轮询(:178-191,成功句/失败句逐字)。
- 端口:DB 预约 `reserve_nextjs_port__no_commit`(`manager.py:548-549`,范围 `SANDBOX_NEXTJS_PORT_START/END = 3010/3100`,`configs.py:44-45`);headless(SCHEDULED/SLACK)不占端口。
- base path/assetPrefix:`next.config.ts` 模板(`sandbox/image/templates/outputs/web/next.config.ts`)。
- restore 后自启:snapshot 含 webapp → nohup `start-webapp.sh` + 哨兵 `ONYX_WEBAPP_AUTOSTART` / `ONYX_WEBAPP_ABSENT`(`nextjs_dev.py:195-222`)。
- bash 权限配合:`"bash start-webapp.sh": "allow"` 等(`opencode_config.py:55-59`)。

### 3.6 ZIP 输出契约(Task 5)

见 §2.8;fixture F6 给出可执行断言(状态码、Content-Type、Content-Disposition、zip 结构、arcname、隐藏过滤、文件名 sanitize 各分支)。

---

## 4. port-parity §五 全量裁决表

裁决值:**restore-parity**(照 Onyx 恢复,注明归属 Task)/ **environment-equivalent**(环境等价替代,注明替代物)/ **blocked**(缺 OpenBot 能力,不算完成,注明能力名)。归属列为 Tasks 2–6 或 `—`(本计划外)。

### 4.0 六项被裁能力(本计划主对象)

| # | 裁剪项 | 裁决 | 归属 | 依据 & 替代 |
|---|---|---|---|---|
| C1 | Connectable apps 提示词段 + `{{CONNECTABLE_APPS_LIST}}` | **restore-parity** | T2 | §3.1 |
| C2 | Managed skills 内容(.opencode/skills + skills_hash) | **restore-parity**(内容源为 environment-equivalent:OpenBot 无 Onyx 内置技能/company-search,由 OpenBot managed-content 接缝供给;空源时哈希照算) | T2 | §3.2;seam 已在 `skills.ts:101-118`、`manager.ts:78-80` |
| C3 | Per-user MCP servers(mcp block + 权限 + 指纹) | **restore-parity**(server 源为 environment-equivalent:OpenBot `server/src/plugins/catalogue.ts` 一方 MCP 目录 + user-oauth 授权替代 Onyx 管理端注册表 + 用户凭证校验) | T3 | §3.3 |
| C4 | connect_app 工具(插件/ask/announce/decision/超时) | **restore-parity**("连接后即可用"的凭证注入为 environment-equivalent:plugins broker 注入,无 egress proxy) | T3 | §3.4、§2.9 |
| C5 | webapp 工具 + 托管启动 | **restore-parity**(进程内执行环境为 environment-equivalent:agent-sandbox `/devserver/start` 池 + workspace 内 start-webapp.sh 替代 pod 内 exec) | T4 | §3.5 |
| C6 | ZIP 下载(download-directory + webapp-download) | **restore-parity** | T5 | §2.8 |

### 4.1 原 Task 1 — AGENTS 模板(7)

| # | 差异 | 裁决 | 归属 |
|---|---|---|---|
| 1 | Hard rule 1 egress 措辞 | environment-equivalent(agent-sandbox 网关注入;Onyx 锚 `AGENTS.template.md:12-13`) | T2 复核措辞 |
| 2 | Hard rule 2 整条 | environment-equivalent(同上;锚 :14-15) | T2 |
| 3 | webapp 条目 "call the webapp tool" | **restore-parity**(T4 恢复 webapp 工具后模板行回原文;锚 :20-24) | T4 |
| 4 | Workspace layout 两行注释 | **restore-parity**(随 #3;锚 :40-49) | T4 |
| 5 | Connectable apps 段裁剪 | **restore-parity**(C1;锚 :51-55) | T2 |
| 6 | Company knowledge 段裁剪 | **restore-parity**(段落原文恢复;company-search 技能内容本身 environment-equivalent——OpenBot 无该内置技能,见 C2) | T2 |
| 7 | Outputs 段前半 | **restore-parity**(随 #3;锚 :99-118) | T4 |

### 4.2 原 Task 2 — 审批(10)

| # | 差异 | 裁决 | 归属 |
|---|---|---|---|
| 1 | 生产者 permission.asked+ask 规则 | environment-equivalent(OpenBot 无 egress proxy;Onyx 生产者是 proxy 写 ActionApproval,serve_client 对非 connect_app 的 permission.asked 一律 auto-allow,`serve_client.py:1692-1702` —— **先前文档表述有偏差,见 §6 勘误 1**) | T3 审批边界 |
| 2 | EXPIRED 不落行 | environment-equivalent(Onyx EXPIRED 仅 proxy 服务端写,`approvals/api.py:40-43`;派生态 + 上游 reject 的可观察面等价) | T3 |
| 3 | 0.5s 轮询 vs BLPOP | environment-equivalent(approval wake 通道;注意 connect_app 的 announce 在 Onyx 本就是 Redis RPUSH+BLPOP,`connect_app.py:57-80` —— 该模式 OpenBot 已有同构,应照抄) | T3 |
| 4 | `craft:` 键前缀 | restore-parity(Onyx 自己就用 `craft:connect_app:*` 键名,`connect_app.py:49-54`;OpenBot 审批键保持 `craft:` 前缀一致) | T3 |
| 5 | 无 MatchedAction/display_payload | environment-equivalent(生产者换成 tool 形态后 payload 结构不同:tool_ref/effect/scope/args;Onyx 的 MatchedAction 是 proxy HTTP 动作形态,`approvals/api.py:46-65`) | T3 |
| 6 | ~~共享 decide 副作用~~ | 已解决(Task 9 decideQuiet),无需动作 | — |
| 7 | allow_always ≈ allow_once | environment-equivalent(Onyx 侧对 opencode 也恒答 `once`,`serve_client.py:1711`;session-grant 只影响 proxy 授权缓存,OpenBot 无对应物) | — |
| 8 | session-grant 端点未移植 / headless auto-allow | environment-equivalent(前者 hydrate 的 proxy 缓存不存在;headless 无人可问,Onyx 由 proxy 处理) | T3(headless 语义复核) |
| 9 | 审批卡 durable 消息行 | environment-equivalent(OpenBot 附加落库;Onyx 只进 attach 流、reload 即消失。**对可观察面是差异**,T3 需确认保留(默认保留:reload 后仍有解释) | T3 确认 |
| 10 | decide 端点限定 craft 行 | 已解决(Task 9 安全修复),无需动作 | — |

### 4.3 原 Task 3 — 上传/文件(7)

| # | 差异 | 裁决 | 归属 |
|---|---|---|---|
| 1 | tar.gz vs zip | **restore-parity**(C6;`api.py:704,741` + `manager.py:1273-1290`) | T5 |
| 2 | 限额来源上传账本 | environment-equivalent(网关 listing 无 size;限额值本身须对齐 Onyx 常量:`configs.py:47-53` = 50MB/文件、20 文件、200MB 总量,T5 校验) | T5 |
| 3 | 无拖拽/进度条 | environment-equivalent(前端范围) | — |
| 4 | 空 sandbox 错误码 | environment-equivalent(Onyx 无该形态:沙箱行恒在) | — |
| 5 | 400/413 分层 | environment-equivalent | — |
| 6 | 删目录 → 404 | **restore-parity(已满足)**——docker 实现 `[ -f ] && rm` 对目录输出 NOT_FOUND → False → 404(`sandbox/docker/docker_sandbox_manager.py:1871-1887`);api 层的 400 映射只在 ValueError 抛出时触发,此路径不抛。T5 加回归断言 | T5 |
| 7 | bot-relative 目录模式 | environment-equivalent(agent-sandbox POST /file 契约) | — |

### 4.4 原 Task 4 — 快照/idle(6)

全部 **environment-equivalent**(共享单 Bot 拓扑替代 per-user pod;agent-sandbox 自回收):#1 不 terminate、#2 单条守卫 UPDATE、#4 状态推导、#5/#6 UI 位置。#3 背景 15min 快照 = environment-equivalent(六能力范围外,记 backlog)。归属 `—`。

### 4.5 原 Task 5 — 定时任务(7)

全部 **environment-equivalent**(Verb/UX/范围差异;Onyx 对照 `scheduled_tasks/api.py`):#1 双动词(additive)、#2 PUT vs PATCH、#3 banner 不禁输入、#4 in-flight 含 queued、#5 无分页、#6 入口不随开关、#7 无 human_readable 预览。归属 `—`(T6 冒烟只验不破)。

### 4.6 原 Task 6 — skills/turn-budget(7)

| # | 差异 | 裁决 | 归属 |
|---|---|---|---|
| 1 | 插件随 workspace 落盘 | environment-equivalent(不能改 agent-sandbox 镜像) | T4(webapp/connect-app 插件同样随 workspace) |
| 2 | reload 无条件 regenerate | **restore-parity**(Onyx 非 stale 短路 `manager.py:367-368`;T2 供真哈希后恢复短路) | T2 |
| 3 | prompt-slot 守卫换 active-turn 检查 | environment-equivalent(无 pod prompt slot;语义等价防重写) | T2 |
| 4 | PROVISIONING 守卫 | environment-equivalent(派生态无法表达;活跃 turn 检查覆盖) | T2 |
| 5 | 插件机械偏差 | environment-equivalent(Bun 运行时等价) | T4 |
| 6 | soft=min 恒 no-op | **restore-parity**(Onyx soft = `TURN_SOFT_BUDGET_FRACTION 0.4 × hard`,`timeouts.py:101-109`;OpenBot 派生族须恢复 0.4 比例) | T6 |
| 7 | skills fingerprint 源 null | **restore-parity**(C2:`compute_skill_runtime_hash` 移植,`managedContentHashesFor` 接缝供真值) | T2 |

### 4.7 原 Task 7 — 子代理(8)

| # | 差异 | 裁决 | 归属 |
|---|---|---|---|
| 1 | 无 ensureSession 预检 | **restore-parity(已满足)**——Onyx `stream_subagent_turn` 同样不预检子会话,只查父会话/沙箱并以错误包返回(`session/streaming.py:800-845`);**先前文档表述有偏差,见 §6 勘误 3**。T6 加断言 | T6 |
| 2-6 | UI/结构简化 | environment-equivalent | — |
| 7 | 422 → 400 | environment-equivalent(仓库约定) | — |
| 8 | 无前端调用方 | no-change(API 平价先行) | — |

### 4.8 原 Task 8 — 落库(2)

#1 TodoWrite 标题判据:**restore-parity(已满足)**——Onyx `_TOOL_TITLE["todowrite"]="Updating todos"`(`serve_client.py:197`),T6 断言。#2 空 delta 过滤顺序:environment-equivalent(可观察一致)。

### 4.9 架构层(2)

#1 不引入 Mastra:environment-equivalent(opencode-serve 驱动模式本就是复刻对象)。#2 fire-and-forget runner:environment-equivalent(Bun 无线程)。

### 4.10 裁决计数

- restore-parity:**19 项** = §4.0 六项能力(C1–C6)+ §4.1–4.9 表内 13 项(原 T1 #3#4#5#6#7、原 T2 #4、原 T3 #1#6、原 T6 #2#6#7、原 T7 #1、原 T8 #1)。
- environment-equivalent:**40 项**(§4.1–4.9 表内)。
- 已解决(先前 Task 9 修复,无动作):**2 项**(原 T2 #6/#10)。
- no-change(API 平价先行等既定状态):**1 项**(原 T7 #8)。
- 合计 19-6+40+2+1 = 56 = §五 全部行;**blocked:0 项**(关键原因:OpenBot `server/src/plugins/` 域提供了一方 MCP 目录 + user-oauth + broker,是 C3/C4 凭证语义的现成替代基座;agent-sandbox `/devserver/start` 是 C5 的现成执行基座;C1/C2/C6 无环境缺口)。

---

## 5. Fixture → Task 映射与依赖图

| Fixture | 覆盖契约 | 主责 Task | 复验 Task |
|---|---|---|---|
| `fixtures/agents-md-rendering.md`(F1 裸用户、F2 连接+可连接) | §3.1 + §3.2 渲染 | T2 | T6 |
| `fixtures/opencode-config-mcp.md`(F3 禁用 MCP 工具 + mcp block) | §3.3 | T3 | T6 |
| `fixtures/approvals-and-connect-app.md`(F4 审批拒绝 + connect_app 拒绝/超时) | §2.5、§2.6、§2.9、§3.4 | T3 | T6 |
| `fixtures/webapp-tool.md`(F5 webapp start) | §3.5 | T4 | T6 |
| `fixtures/zip-download.md`(F6 归档下载) | §2.8、§3.6 | T5 | T6 |

- 依赖图:`T1 → {T2, T3, T4, T5} → T6`;T2 → T3(connectable_apps_section 与 skills/mcp 哈希是 T3 配置重生成与 reload 语义的输入)、T3 → T4(webapp/connect-app 插件共用 workspace 落盘与 ask 机制)、T4 → T5(webapp-download 的 ZIP 形态以 scaffold 存在为前提,仅弱序)。**无环**(线性链 T1→T2→T3→T4→T5→T6 为其生成树)。
- 裁决表的 restore-parity 行均有归属 Task(§4 各表),无"restore-parity 但无 Task"悬空项;blocked=0,无不可完成项。

---

## 6. 先前文档 vs Onyx 源 勘误(Onyx wins)

1. `port-parity.md` §五 原 T2 #1 把 Onyx 审批生产者暗示为"egress-proxy HTTP 拦截 vs permission.asked"之争;实际 Onyx 代码里 **serve_client 对 permission.asked 非 connect_app 类别一律 auto-allow**(`serve_client.py:1692-1702`,注释明言"生产 opencode.json 已覆盖,意外类别=配置缺口"),审批卡生产者完全在 egress proxy 侧。OpenBot 的替代结构正确,但归因描述以此处为准。
2. `port-parity.md` §五 原 T6 #6 声称"onyx soft = min(SOFT, budget) 同为 no-op"——不成立:Onyx soft = **0.4 × hard cap**(`timeouts.py:101-109`),是真实派生值。restore-parity(§4.6 #6)。
3. `port-parity.md` §五 原 T7 #1 声称 Onyx 有"ensureSession 预检"——`session/streaming.py:800-845` 的 subagent 流不预检子会话(docstring 明言 "does not re-run ... preflight"),仅查父会话/沙箱。OpenBot 现行为已是对齐,无需补。
4. `README.md` §四的 16 处一期差异未逐条重审(六能力范围外);其中与 T3-T5 交叠的(审批生产者、tar.gz)已在本表覆盖,其余维持原判,Task 6 冒烟时若见冲突以 Onyx 源为准。
