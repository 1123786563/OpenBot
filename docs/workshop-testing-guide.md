# Workshop × CodeSandbox 测试指南

> 覆盖四种测试方法与一份可直接复制的自动化测试提示词。
> 最近三处修复（分享路由 P1-1 / 沙箱 gzip P1-2 / 历史回放 P2）已纳入验证点。

---

## 0. 测试方法总览

| 方法 | 耗时 | 覆盖面 | 适用场景 |
|---|---|---|---|
| ① 单元测试套件 | ~2 分钟 | 逻辑层（路由/编排/分享/沙箱/前端流） | 每次改代码后、提交前、CI |
| ② Live Smoke 脚本 | ~1-3 分钟 | 端到端链路（真实沙箱+真实模型） | 部署后健康巡检、环境变更后 |
| ③ API 快速冒烟 | ~2 分钟 | 关键端点（含三修复） | 无浏览器环境、快速验收 |
| ④ 浏览器端到端 | ~10 分钟 | 完整 UX（六 Tab+交互+控制台） | 发版前验收、UI 改动后 |

**建议组合**：日常改码跑 ①；部署/重启环境后跑 ②+③；发版或 UI 改动后跑 ④。

---

## 方法 ① 单元测试套件（CI / 回归）

### 步骤

```bash
# 1. server 侧（⚠️ 必须在 server/ 目录、带 TEST_DATABASE_URL，否则 DB 用例报 error）
TEST_DATABASE_URL="postgres://openbot:openbot@127.0.0.1:5432/openbot_enterprise_test" \
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts \
  server/tests/workshop-*.test.ts server/tests/schedule-*.test.ts server/tests/sandbox-*.test.ts

# 2. 沙箱侧（同样由根目录的 e2e 收集；这些套件依赖 Bun 运行时，由 e2e 调度、bun 执行）
cd .. && E2E_UNIT_SCOPE=agent-sandbox bun run test

# 3. 前端流机器
cd .. && E2E_UNIT_SCOPE=app bunx e2e run --config e2e.unit.config.ts app/src/lib/workshop

# 4. 类型门禁（可选，三侧零错）
cd ../server && bunx tsc --noEmit -p tsconfig.json
cd ../app && bun run typecheck
cd ../agent-sandbox && bun run typecheck
```

### 关键验证点

- routes 测试含 share 端点 4 条（mint 201 / 未配置 503 / 403 / revoke）与历史回放 2 条
- 沙箱 70 条（含 gzip 修复后的 proxy 透传、devserver 守卫、webapp containment）

### 成败标准

- ✅ 三侧全部 `0 fail`（server 约 44+ 条、沙箱 70 条、前端 5 条）
- ❌ 任何一侧出现 fail；注意区分：不带 TEST_DATABASE_URL 跑 server 集成测试会报 error（是调用姿势问题，不是代码问题）

---

## 方法 ② Live Smoke 脚本（部署健康巡检）

### 前置

- `.env` 有 `SANDBOX_TOKEN`；`docker compose up -d agent-sandbox`（容器 healthy）

### 步骤

```bash
cd /Users/wuyongjun/trea/OpenBot

# ① 双 bot 隔离（最快，~10s）
bun run test:live-sandbox-isolation

# ② codesandbox 基础链路（真实模型，~1 分钟）
bun run test:live-codesandbox

# ③ workshop 全链（需先起 server，见方法③的启动命令；然后）
WORKSHOP_SMOKE_SERVER_URL=http://127.0.0.1:3999 \
NO_PROXY=127.0.0.1,localhost \
bun run test:live-workshop
```

### 关键验证点

- 隔离三断言：bot-a 文件对 bot-b 不可见 / 自见 / reset 只清自己
- workshop 全链五行输出：channel created → turn succeeded → artifact → download verified → audit rows present

### 成败标准

- ✅ 三个脚本各自输出 `OK:` 且 exit 0
- ❌ 任何 `FAIL:` 行；若 401 + proxy 在场，先检查 NO_PROXY（本机 HTTP_PROXY 会劫持 loopback 并剥 token）

---

## 方法 ③ API 快速冒烟（无浏览器，验收三修复）

### 步骤

```bash
# 1) 生成单用户测试 env（一次即可，文件可复用）
cd /Users/wuyongjun/trea/OpenBot
sed -E 's/^(CASDOOR_OAUTH_CLIENT_ID|CASDOOR_OAUTH_CLIENT_SECRET|CASDOOR_OAUTH_ISSUER)=/# \1=/; s/^PORT=3001/PORT=3999/; s/^SERVER_PORT=3001/SERVER_PORT=3999/; s/^(BETTER_AUTH_URL|BETTER_AUTH_SECRET)=/# \1=/' .env > /tmp/openbot-test.env
printf 'OPENBOT_SINGLE_USER=true\nNO_PROXY=127.0.0.1,localhost\nno_proxy=127.0.0.1,localhost\n' >> /tmp/openbot-test.env

# 2) 起测试 server（3999；3001 被主 dev server 占用）
(cd server && bun --env-file=/tmp/openbot-test.env src/index.ts > /tmp/openbot-3999.log 2>&1 &) 
sleep 8

# 3) 三修复逐项验证（CH 换成任意已存在频道，如 smoke 用的频道）
B=http://127.0.0.1:3999; CH=channel_4932d5f2-d1e5-42c2-8834-de1b740e2eba
# 修复1：文件树（曾 500）
curl -s --noproxy '*' "$B/api/workshop/$CH/files?path=" | head -c 120
# 修复2：分享创建（曾 404）
curl -s --noproxy '*' -X POST "$B/api/workshop/$CH/share" -H 'content-type: application/json' -d '{"scope":"preview","expiresInDays":7}' | head -c 120
# 修复3：历史回放（新端点）
TURN=$(curl -s --noproxy '*' "$B/api/workshop/$CH" | python3 -c 'import sys,json;print(json.load(sys.stdin)["turns"][-1]["id"])')
curl -s --noproxy '*' "$B/api/workshop/$CH/turns/$TURN/events" | head -c 120
```

### 成败标准

- ✅ files 返回 JSON 数组（`[{"name":...}`）；share 返回 201 含 `"token":` 与 `"shareUrl":`；events 返回 `{"turnId":...,"events":[...]}` 且 events 非空
- ❌ files 返回 `Internal Server Error`；share 返回 404；events 的 events 为空数组且该轮实际跑过

---

## 方法 ④ 浏览器端到端（完整 UX，发版前）

### 步骤

1. 环境同方法③（server 3999 + `cd app && env APP_PORT=3020 SERVER_PORT=3999 bun run dev`）
2. 打开 `http://127.0.0.1:3020/`，进任一频道，点工具栏「工作台」按钮
3. 逐 Tab 操作并对照验证点；全程保持 DevTools Console 开启

### 关键验证点（六 Tab）

| Tab | 操作 | 期望 |
|---|---|---|
| 过程 | 打开即看（终态轮次） | 渲染历史事件流：思考折叠块、工具调用徽标、busy 进度、答案正文拼接；不再是"这轮没有留下事件" |
| 文件 | 刷新 | 文件树列出工作区文件+尺寸；无"工作台加载失败" |
| 产物 | 点下载 | 200 + attachment 头 + 内容正确 |
| 用量 | 查看 | 六格统计；费用 "—" 而非 NaN |
| 分享 | 创建链接 | 明文链接绿色面板只出现一次（关闭即失）；"分享生效中"+到期时间；撤销有二次确认 |
| 定时 | 三模式建任务/暂停/启用 | 列表出现 cron+下次时间；暂停显示"已暂停" |

外加：URL 带 `?workshop=true` 可直接链接到工作台；`/share/无效token` 显示统一 404 文案。

### 成败标准

- ✅ 六 Tab 全部符合期望；Console 中 workshop 相关 error = 0（`smoke-ws-bot Agent not found` 是 CopilotKit 环境报错、threads socket warning 是既有噪音，均不计）
- ❌ 任一 Tab 报错/空白/假成功；Console 出现 workshop 路径的 error

---

## 附：可直接复制的测试提示词

> 复制下方整段给 AI 编程助手（CodeBuddy 等）即可自动执行方法③+④（API 冒烟 + 浏览器端到端）。

```text
请对本仓库（OpenBot）的 Workshop 工作台做一次完整的测试验收，并输出报告。严格按以下步骤执行：

【环境准备】
1. 确认 docker compose ps 中 agent-sandbox 与 postgres 均 healthy，否则 docker compose up -d agent-sandbox。
2. 生成单用户测试配置 /tmp/openbot-test.env：以根目录 .env 为基础，注释掉 CASDOOR_OAUTH_* 三行、BETTER_AUTH_URL、BETTER_AUTH_SECRET（行首加 #），把 PORT/SERVER_PORT 改为 3999，文件末尾追加三行：OPENBOT_SINGLE_USER=true、NO_PROXY=127.0.0.1,localhost、no_proxy=127.0.0.1,localhost。
3. 从 server/ 目录后台启动测试实例（bun --env-file=/tmp/openbot-test.env src/index.ts，监听 3999；注意启动目录必须是 server/，否则相对路径报 ENOENT）；从 app/ 目录以 APP_PORT=3020 SERVER_PORT=3999 启动 Vite 前端。两者探活通过后再继续。
4. 全程对本机 127.0.0.1 的请求绕过代理（curl 用 --noproxy '*'，进程环境带 NO_PROXY），否则本机 HTTP_PROXY 会劫持回环请求并剥掉 token 导致 401 假失败。

【第一部分：API 冒烟】用 curl 逐项验证并记录 HTTP 状态码与响应片段：
A. GET /api/workshop/<已存在频道>/files?path= → 期望 200 且返回 JSON 文件数组（曾因沙箱 gzip 头残留返回 500，若复现即为回归）。
B. POST /api/workshop/<频道>/share，body {"scope":"preview","expiresInDays":7} → 期望 201，响应含 token 与 shareUrl（曾因路由未挂返回 404）。
C. 先 GET /api/workshop/<频道> 拿最新 turnId，再 GET /api/workshop/<频道>/turns/<turnId>/events → 期望 200 且 events 数组非空（终态轮次历史回放）。
D. GET /api/public/workshop/share/<编造的无效token> → 期望 404（防枚举统一文案，不得 403/500）。

【第二部分：浏览器端到端】用浏览器自动化打开 http://127.0.0.1:3020/，进入任一频道，点「工作台」按钮（或直接访问 /channel/<id>?workshop=true），逐 Tab 验证：
1. 过程：终态轮次应渲染历史事件流（思考折叠、工具调用、进度、答案正文），不得显示"这轮没有留下事件"。
2. 文件：文件树正常列出，不得出现"工作台加载失败"。
3. 产物：点下载链接应成功（HTTP 200 + attachment 头）。
4. 用量：六格统计正常，费用列显示"—"而非 NaN。
5. 分享：点"创建链接"→ 明文链接只展示一次的绿色面板出现且可复制；随后显示"分享生效中"+到期时间；撤销按钮存在且点击后有二次确认。
6. 定时：用三种模式任选其一创建任务 → 列表出现该任务（cron 表达式+下次运行时间）；点暂停 → 显示"已暂停"；点启用 → 恢复。
7. 控制台：全程监控，统计 error；忽略两类已知噪音：smoke-ws-bot 的 "Agent not found"（CopilotKit 环境）与 threads realtime socket warning。workshop 相关 error 必须为 0。

【第三部分：live smoke 回归】执行 WORKSHOP_SMOKE_SERVER_URL=http://127.0.0.1:3999 NO_PROXY=127.0.0.1,localhost bun run test:live-workshop，期望末行输出 OK: ... 且 exit 0。

【收尾】测试结束后停掉 3999 与 3020 两个测试进程，确认未改动根目录 .env。

【输出格式】按三部分逐项给出 PASS/FAIL 与证据（状态码/响应片段/页面快照要点/控制台计数）；发现的每个问题给出：复现步骤、疑似根因、修复建议；最后给一行总结论（全部通过 / 存在 N 个失败项）。
```

### 提示词使用场景说明

| 场景 | 建议用法 |
|---|---|
| 日常改码后回归 | 不用提示词，直接跑方法①的三条命令 |
| 部署/环境变更后 | 只跑提示词的【第一部分】+【第三部分】（或方法②③） |
| 发版前完整验收 | 用完整提示词（三部分全跑） |
| 只想验证某个修复 | 拷贝提示词中对应的一条（如只验 gzip：只留 A 项） |
