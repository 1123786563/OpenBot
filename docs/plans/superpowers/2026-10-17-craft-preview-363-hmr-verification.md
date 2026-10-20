# Craft Preview Origin #363 — HMR 升级验证与补证（收口）计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用真实证据确认已合并主线（本 worktree，HEAD=origin/main `bbea87ba`）满足 #363 的四条 AC，补上此前因环境故障缺席的 **host 形态（生产 preview origin）live 证据**，然后以证据关闭工单。

**Architecture:** 实现已随 PR #400（`981f4da8`，#362 含 #363）及修复波（#434/#435/#438）合并。本计划默认不改生产代码；若探针暴露真实缺陷，按 TDD 在票面 write scope（`server/src/craft/webapp-proxy.ts`、`server/src/index.ts`、`server/tests/craft-webapp-hmr.test.ts`）内修复。三面证据：单元（39 用例）→ dev 拓扑真浏览器（既有 acceptance 脚本）→ host 拓扑真浏览器（新探针脚本 + 本地 TLS 终结前置）。

**Tech Stack:** Bun（server/探针/TLS 前置）、Playwright + Chrome（真浏览器）、docker 共享栈（postgres/casdoor/agent-sandbox）。

**Spec:** Issue #363（GitHub）；父 Spec `docs/specs/2026-10-15-craft-preview-origin-design.md`（AC5）；运维事实源 `reference/craft-preview-origin.md`。

## Global Constraints

- 拒绝形状 401/404/503；拒绝发生在 `server.upgrade` 提交之前（既有语义，不许回退）。
- 票据值不进日志、错误响应、持久 URL。
- 每步证据先行："Evidence over claims"——没有跑过的命令不得声称通过。
- 环境（postgres/casdoor/agent-sandbox 容器）为共享栈：只读使用，不重启、不清理他人会话；探针会话跑完即删（CLEANUP=1）。
- 机器高负载：长命令全部落盘 + tail 读取，不阻塞等待；tsc 已后台启动（pid 见 ledger）。

## Review Focus

- **host 形态 TLS**：本地无证书链——探针用 `ignoreHTTPSErrors` + 自签证书的 TLS 前置（`https://{label}.localhost:3443`）。若浏览器拒收 `SameSite=None; Secure` pass cookie，证据如实记录 FAIL，不得用 http 模板绕过（`parseTemplate` 已 fail-closed 拒绝 http，fix-ocr4 #9）。
- **HMR 帧基线**：握手帧（`{"action":"sync"}`）不算编辑信号——失效断言只对编辑后的增量帧（acceptance 脚本既有口径，防 invalidation 恒真）。
- **票据绑定**：previewHost 三元组绑定在 host 形态下是 `{label}.localhost:3443`——TLS 前置必须透传 Host 头（字节直通天然满足）。
- **同 site 干扰**：`{label}.localhost` 与 `localhost` 同 site——主站 cookie 会随请求携带；HMR 拒绝路的 401 断言必须用无 pass 的干净 context，不能只删一条 cookie。

---

### Task 1: 单元与类型证据（merged main）

**Files:** 无新改动（只运行验证）。

**Interfaces:**
- Consumes: 已合并的 `resolvePreviewWebappHmrUpgrade` / `webappHmrIsAppPath` / boot-file dispatcher。
- Produces: 单元证据记录（39/39）+ tsc 结果，写入 ledger。

- [x] **Step 1: 跑 HMR 测试文件**

Run: `cd server && bun test tests/craft-webapp-hmr.test.ts`
Expected: 39 pass / 0 fail（含 preview dispatcher 双拓扑、伪造 pass 401、MAC 翻转 401、重指派 404、无沙箱 503、CSWSH Origin 门、拒绝先于 upgrade commit 的 source-pin）

- [x] **Step 1 结果:** 39 pass / 0 fail（82 expect，6.61s）✅

- [ ] **Step 2: tsc --noEmit 收尾**

Run: `bun x tsc --noEmit`（后台运行中，pid 31154，输出 /tmp/tsc-out.txt）
Expected: 退出码 0，无输出

- [ ] **Step 3: ledger 记录证据**

### Task 2: dev 拓扑真浏览器回归（AC-1/AC-2/AC-3 live + AC-4 拓扑一）

**Files:** 无生产代码改动；证据落 `gui-test-screenshots/craft-preview-365/` + ledger。

**Interfaces:**
- Consumes: `scripts/craft-preview-acceptance.ts`（已合并，含 F-1/F-2 修复与全部 OCR 收口）。
- Produces: dev 形态（`http://127.0.0.1:3221/<label>`）真浏览器 HMR 证据（帧>0 双向、编辑→失效帧、DOM 热更不刷新）。

- [ ] **Step 1: 环境就位**

```bash
cp ../craft-preview-origin-exec/.env .env   # 共享栈连接配置（DATABASE_URL/CASDOOR 等）
```
容器核验：postgres :5432 / casdoor :8000 healthy / agent-sandbox-1 :4300+3011-3098 healthy（已核验 ✅）。
端口核验：3220/3221 空闲。

- [ ] **Step 2: 起 API server（3221）与 app dev（3220，/api 代理→3221）**

```bash
cd server && bun --env-file=../.env src/index.ts > /tmp/363-server-dev.log 2>&1 &
cd app && APP_PORT=3220 SERVER_PORT=3221 bun --bun node_modules/vite/bin/vite.js --port 3220 --strictPort > /tmp/363-app-dev.log 2>&1 &
```
Expected: 两日志无 fatal；`curl http://localhost:3221/api/health`（或等价探活）200。

- [ ] **Step 3: 跑 acceptance（真实浏览器全链）**

Run: `cd server && bun --env-file=../.env scripts/craft-preview-acceptance.ts`（工作目录脚本自读 `server/.env`?——脚本 `existsSync(".env")` 相对 cwd；按脚本头注在 repo 根跑 `bun scripts/...` 并确保 `server/.env` 或根 `.env` 可达）
Expected: AC5 三步（帧双向流动 / 编辑→失效帧 / DOM 热更）全 PASS；输出落盘后逐条核对。已知非缺陷残面（票据 URL 残留、about:blank CORS、harness 竞态）按 ledger §fix-f1 归因口径判定，不掩盖新 FAIL。

- [ ] **Step 4: ledger 记录（含 PASS/FAIL 计数与 HMR 三步逐条结果）**

### Task 3: host 形态（生产 preview origin）live 证据（AC-4 拓扑二 + AC-2 live 拒绝路）

**Files:**
- Create: `scripts/craft-host-form-hmr-evidence.ts`（探针脚本，独立微脚本；生产代码零改动）
- Create: `/tmp/363-tls-front.ts`（本地 TLS 终结前置，字节直通；不入库）

**Interfaces:**
- Consumes: `resolvePreviewRequest`（Host 解析）、`resolvePreviewWebappHmrUpgrade`、preview-ticket 签发路由、`parseTemplate` 的 https 模板（`https://{session}.localhost:3443`）。
- Produces: host 形态真浏览器证据：wss 升级帧>0、编辑→热更、无 pass 401 / 未知 label 404 / 他人会话拒绝；证据文件 `.superpowers/evidence/issue-363-host-form-hmr.txt` + 截图。

- [ ] **Step 1: 自签证书 + TLS 前置**

```bash
openssl req -x509 -newkey rsa:2048 -keyout /tmp/363-key.pem -out /tmp/363-cert.pem -days 2 -nodes -subj "/CN=*.localhost" -addext "subjectAltName=DNS:*.localhost,DNS:localhost"
```
前置（Bun）：`Bun.listen({ port: 3443, tls: { cert, key }, socket })` → `Bun.connect("127.0.0.1", 3221)` 双向字节直通（WS upgrade 帧透明穿透）。

- [ ] **Step 2: 带模板重启 API server**

`OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE=https://{session}.localhost:3443`（其余同 Task 2；app dev 不动）。

- [ ] **Step 3: 写探针脚本（复用 acceptance 的登录/建会话/探针/HMR 技巧；Playwright context `ignoreHTTPSErrors: true`）**

核心步骤（每步 PASS/FAIL 如实输出）：
1. Casdoor 登录（`http://localhost:3220`）
2. 建会话 + 探针应用（`[data-testid="probe-marker"]` fixture 与 acceptance 同款）
3. 签票 → `goto https://{label}.localhost:3443/?ticket=…` → 兑换 → 应用文可见
4. **HMR 升级**：页内 `new WebSocket("wss://{label}.localhost:3443/_next/webpack-hmr")`（完整地址脚本侧派生，防相对 URL SyntaxError——ledger #1147 教训）→ 帧 ≥ 3
5. **热更新**：第二只 socket 收增量帧；`gatewayWriteFile(page.tsx v2)` → invalidation/building/built 帧 → DOM marker v2 且 `window` 身份保留（不整页刷新）
6. **拒绝路（live）**：干净 context 无 cookie 直达 host → 401 通行文案；未知 label host → 404 "Unknown preview host"；B 会话 pass 打 A 会话 host → 401
7. 清理：停服 + 删探针会话（docker exec 白名单校验同 acceptance）

- [ ] **Step 4: 跑探针，逐条核对输出**

Run: `bun scripts/craft-host-form-hmr-evidence.ts`
Expected: 3/3 主链 PASS + 拒绝路 3/3 PASS。任何 FAIL 先 systematic-debugging 归因：探针工件（证书/时序）vs 生产缺陷；生产缺陷 → 票面 write scope TDD 修复（RED→GREEN）后重跑。

- [ ] **Step 5: ledger 记录**

### Task 4: 证据归档与工单收口

- [ ] **Step 1: 汇总证据**（单元 39/39、tsc、dev 拓扑 acceptance 输出、host 形态探针输出 + 截图清单）写入 `.superpowers/evidence/issue-363/`（或 ledger 指定处）
- [ ] **Step 2: 关闭 issue #363**，评论附四条 AC 的证据索引与残留缺口（如有，如实列出）
- [ ] **Step 3: 提交**（探针脚本如验证通过则入库：`git add scripts/craft-host-form-hmr-evidence.ts` + commit）
