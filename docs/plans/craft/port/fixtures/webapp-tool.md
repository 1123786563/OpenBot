# Fixture F5 — webapp 工具:start / 结果文案 / 启动脚本契约

> 全部期望值派生自 Onyx 源(pinned `251933a`,路径相对 `backend/onyx/server/features/build/`,下称 B/)。

## A. 工具 schema(B/`sandbox/image/opencode-plugins/webapp.ts:168-201`,逐字段)

- 工具名:`webapp`。
- description(逐字节,:174-182):

```
Manage this session's web-app dev server. Call with action='start' BEFORE building a web app: it scaffolds outputs/web, installs dependencies, starts the dev server, and waits until it serves. SAFE TO CALL REPEATEDLY: it reconciles current state (already running = success, crashed = restarted). Use action='status' or 'logs' to diagnose problems, and action='restart' if the server is up but misbehaving. NEVER run `bun run dev` or start your own server; the preview proxy only routes to the port this tool manages.
```

- args:
  - `action`: enum `["start", "status", "logs", "restart"]`,describe 见 :184-193;
  - `lines`: number, optional,"Log lines to include, default 30, max 200 - only meaningful for action='logs'."
- 常量:`DEFAULT_ACTION_LOG_LINES=10`、`DEFAULT_LOGS_LINES=30`、`MAX_LOG_LINES=200`、`START_TIMEOUT_MS=150_000`、`MAX_OUTPUT_BYTES=8*1024`、`PROBE_TIMEOUT_MS=2000`(:36-41)。
- metadata title(action→title,:204-210):start→`Starting web app…`、restart→`Restarting web app…`、status→`Checking web app status…`、logs→`Reading web app logs…`。
- 事件面:工具卡标题回落 `"Running tool"`(不在 `_TOOL_TITLE`,B/`sandbox/opencode/serve_client.py:185-214`)。

## B. action=start:成功路径

### 输入

session 目录有 `start-webapp.sh`(workspace setup 时写入,chmod 444);`outputs/web/package.json` 不存在(首启)。脚本经 child_process `bash '<script>' 2>&1` 执行(:131-160),退出码 0 且输出不含 `"already running"`。

### 期望:工具结果文本(逐字节,:252-286)

```
webapp started successfully

--- script output ---
{output}

state: running
port: {PORT}
app dir: outputs/web
scaffolded: yes
logs: nextjs.log
```

- `{output}` = 脚本 stdout+stderr,超过 8KiB 截尾(:151-153)。
- observation 段(`buildObservation`,:100-129):`state: running|not_running`;port 解析自脚本头 `^PORT=(\d+)$`(:57-60),解析失败 → `port: unknown (could not parse PORT from start-webapp.sh)`;有 log 时追加 `--- last 10 lines of nextjs.log ---\n{tail}`(start 动作固定 10 行)。
- 幂等重调(已在跑):退出码 0 且输出含 `"already running"` → headline = `webapp was already running`(:254-257)。

## C. action=start:失败分类(逐字节,:258-286)

| 触发 | error_kind | headline |
|---|---|---|
| 输出含 `EADDRINUSE` 或 `address already in use` | `port_conflict` | `webapp start failed: something else is bound to the managed port {PORT}. Kill that process (e.g. \`fuser -k <port>/tcp\`), then call webapp start again. Do not start a server on a different port; the preview proxy only routes to the managed port.`(无 PORT 时 ` the managed port.` 无端口号) |
| 输出含 `did not become ready` | `app_boot_failure` | `webapp start failed: the server did not become ready. the server crashed or the app code throws on boot; read the log tail, fix the code, then call webapp start again.` |
| 其他非零退出 | `bootstrap_failure` | `webapp start failed. fix the error shown above, then call webapp start again.` |

结果形态:`{headline}\n\n--- script output ---\n{output}\n\nerror_kind: {error_kind}\n{observation 段}`(errorKind 行仅失败时有,:282-286)。**端口冲突禁止自愈换端口**(注释 :249-251)。

## D. 脚本缺失(headless/被删)

### 期望(逐字节,UNAVAILABLE_OBSERVATION,:162-166)

```
state: unavailable
this session has no web-app support (headless session) or the bootstrap script was deleted; reopen the session to regenerate it; never run `bun run dev` yourself.
```

## E. status / logs 动作

- `status`:headline = `web app is running on port {PORT} and the preview updates live (hot reload)` 或 `web app is not running; call webapp start`,后接 10 行 observation(:217-224)。
- `logs`:n = `min(args.lines ?? 30, 200)`;headline = `web app is running on port {PORT}` / `web app is not running`(:226-233)。
- `restart`:先 kill 活 PID + 等 2s,再走 start 路径(:236-244)。

## F. start-webapp.sh 契约(B/`sandbox/nextjs_dev.py`)

### 首启成功(逐字节,:182)

```
web app dev server running on port {PORT} - app dir: outputs/web, logs: nextjs.log. It hot-reloads on file changes and never needs 'bun run dev' run by hand.
```

### 未就绪(90s 轮询超时,:188-190)

stderr:`server did not become ready - check nextjs.log; if it crashed, fix the error and re-run bash start-webapp.sh` + `--- last 30 lines of nextjs.log ---` + tail(退出码 1 ⇒ error_kind=app_boot_failure)。

### 脚本结构断言

- 头部:`SESSION_PATH={session_path}`、`PORT={nextjs_port}`(:132-133)——即 webapp 插件 parsePort 的来源。
- scaffold:无 `outputs/web/package.json` 时 `cp -r /workspace/templates/outputs/*`(含 Next.js 16.1.1 模板)+ `bun install --frozen-lockfile --backend=hardlink`(:141-165)。**〔Erratum E1(Task 6,2026-10-13)〕**本条与下条的模板/环境变量断言在 OpenBot 环境**结构性不可满足**(无镜像模板可拷、无 pod 内 dev-server env 注入),为 Onyx 源描述而非 OpenBot 可满足断言。OpenBot 等价物:scaffold 推迟给 agent(缺 `outputs/web/package.json` → exit 1 + 指引文案),dev server 以 `PORT` 环境变量 + `bun run dev -- -H 127.0.0.1 -p $PORT` 启动;断言载体为脚本结构等价物:头部 `SESSION_PATH`/`PORT`、flock fd9、pid cwd 身份守卫、`nextjs.log`、探活循环与 §F"首启成功"逐字节行、90s 超时分支(均已 live 实证,见 `remediation-verification.md` §3(vii))。
- dev server 环境:`ONYX_WEBAPP_PORT={port}`、`ONYX_WEBAPP_BASE_PATH=/api/build/sessions/{session_id}/webapp`、`ONYX_WEBAPP_ALLOWED_DEV_ORIGINS={WEB_DOMAIN host}`(:93-95);flock 防双起,PID 文件 `nextjs.pid`,日志 `nextjs.log`(:81-117)。**(Erratum E1 同上:ONYX_WEBAPP_* 三变量不可移植;flock/pid/log 断言保留且已 live 实证。)**
- 端口来源 = DB 预约(session create 时 `reserve_nextjs_port__no_commit`,范围 [3010,3100),B/`configs.py:44-45`;headless 会话无端口、无脚本,B/`session/manager.py:544-549` + B/`sandbox/session_workspace.py:57-63`)。

## G. webapp-info 与就绪判定(B/`session/manager.py:1493-1593`)

```jsonc
// GET /sessions/{id}/webapp-info,沙箱 RUNNING、已 scaffold、dev server 应答
{"has_webapp": true,
 "webapp_url": "{WEB_DOMAIN}/api/build/sessions/{session_id}/webapp",
 "status": "running", "ready": true, "sharing_scope": "private"}
```

- `has_webapp` 判据:`outputs/web/package.json` 存在(`WEBAPP_PACKAGE_JSON_PATH`,B/`sandbox/nextjs_dev.py:19`;探测 :1547-1568);沙箱非 RUNNING → `has_webapp=null, status=<sandbox status>, ready=false`。
- `ready` 判据:GET `{internal}/{basePath}/_next/static/onyx-ready-probe.js` **任意响应**(含 404)即 true,2s 超时(:1570-1593)。
- base path:`/api/build/sessions/{session_id}/webapp`(`webapp_base_path`,nextjs_dev.py:22-28;Next 模板 next.config.ts 同源推导,sandbox/image/templates/outputs/web/next.config.ts:5-11)。
- restore 自启哨兵:`ONYX_WEBAPP_AUTOSTART`(快照含 webapp)/ `ONYX_WEBAPP_ABSENT`(nextjs_dev.py:198-199, 213-221)。
