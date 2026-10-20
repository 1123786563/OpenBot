# Craft Preview Origin 执行计划（#358 剩余七票：#359、#362–#367）

> **For agentic workers:** 本计划由 coordinator（Orca Run）执行；每张 Ticket 通过
> `orca orchestration worker-start --worktree new-child --agent pi` 派发给 Pi 实现者，
> 并由独立 Pi reviewer 只读审阅。步骤用 checkbox 跟踪，实时状态见
> `.superpowers/ledger/craft-preview-origin/LEDGER.md`。

**Goal:** 在隔离执行工作区完成已批准 Spec（Issue #358，D1–D11 / AC1–AC9）的剩余七张
Ticket：#359（ACME DNS-01）、#362（代理 Host 路由与票据流程）、#363（HMR）、#364（退场
basePath）、#365（缝合 E2E）、#366（拒绝注入）、#367（存量回归）。

**Architecture:** 预览从主站同源迁到独立 origin（dev `127.0.0.1:<port>` 路径段 / 生产
`<hash>.<preview-base>` 子域），主站 cookie 换 30s 单次票据，preview 域种会话级 HttpOnly
cookie；#360（票据原语）与 #361（host 路由与准入）已实现并独立审阅通过，作为本计划的
前置交付。

**Tech Stack:** Bun + Hono（server）、Next.js 16 dev server（沙箱内）、React/Vite（app）、
Playwright/browser-harness（真实验证）、acme.sh + Let's Encrypt DNS-01（生产证书）。

## Global Constraints（每张票隐含遵守）

- 事实源顺序：GitHub Issue 正文（#358–#367）> `docs/specs/2026-10-15-craft-preview-origin-design.md`
  > 本地 ticket 文档 > 旧 README。过时文字不是新要求，冲突记录进 Ledger。
- **禁止本地 commit / push / merge**（本次用户授权范围外）。已有提交（073a7d41、91a2dee7）
  是前置会话的既成事实，不回退。新工作全部以未提交检查点保存（diff + sha256）。
- 附着模型不回退：预览代理只探测不拉起第二进程；`webapp tool` 的 status/logs/restart
  与预览指向同一 dev server。
- 交互能力不回退：hydration、HMR、POST/PUT/PATCH/DELETE、Server Actions、全屏放大。
- 拒绝形状 401/404/503，原因可展示；票据值不进日志、错误响应、持久 URL。
- TDD：RED→GREEN→REFACTOR；禁 sleep，推进时间用注入时钟。
- 每票完成须有真实浏览器证据（Playwright + Casdoor 登录 + 真实 dev server）；
  单测桩不算通过。环境不可用时如实记录缺口，不得声称通过。
- 实现者与审阅者都是 Orca 派发的 Pi agent；coordinator 不写生产代码、不批准自己的实现。

## 基线与工作区

| 项 | 值 |
|---|---|
| 原始 BASE | `f0520524`（main） |
| #360 交付 | `073a7d41`（分支 `1123786563/impl-360-preview-ticket`，已独立审阅通过） |
| #361 交付 | `91a2dee7`（分支 `1123786563/impl-361-host-routing`，已独立审阅通过，findings 已回写 #362 正文） |
| 执行主线 | worktree `craft-preview-origin-exec`，分支 `1123786563/craft-preview-origin-exec`，HEAD `91a2dee7` |
| 主工作区未提交文档 | 5 个文件已复制进执行工作区并核对 sha256（见 Ledger §1） |

## DAG（每边已对照 Issue 正文重新核实）

```
#359 (ACME, 独立) ─────────────────────────────────────────┐
#360 ✅ ──> #361 ✅ ──> #362 ──┬─> #363 (HMR) ──┬─> #365 ──┬─> #366
                              └─> #364 (basePath) ─┘        └─> #367
```

- Wave 1（并行，文件域不重叠）：**#359**（docker/compose、证书目录、部署文档）+ **#362**
  （server/src/craft/webapp-proxy.ts、preview-origin.ts、index.ts、app 前端 craft 三件）。
- Wave 2（并行，#363 写 webapp-proxy.ts+index.ts；#364 只写 web-template/，无重叠）：
  **#363** + **#364**。浏览器验证资源（server 3001、沙箱端口段）协调：#363 先行，
  #364 的浏览器回归在 #363 结算后执行（写入 brief）。
- Wave 3：**#365**（缝合 E2E，消费 03/04/05 全部交付，产出可复跑浏览器脚本）。
- Wave 4（并行）：**#366**（server/tests/ 拒绝全集）+ **#367**（server/src/craft/ 判定
  + 文档 + 前端提示）。两者文件域不重叠；#367 若触碰 #366 同名测试文件则以 #366 集成版
  为基准 rebase 增量。
- 每票流程：派发 impl → 完成后 coordinator 存检查点 → 独立 Pi reviewer（只读）→
  有效 findings 回派修复 → 复审 → 集成进执行主线（apply diff + sha256 核对）→ 解锁下游。
- 下游派发前，coordinator 把主线已集成未提交增量显式 apply 到新 child worktree 并核对。

## 已核实接口（来自 91a2dee7 实际代码，下游直接消费）

### 来自 #360（server/src/craft/preview-ticket.ts）
```ts
export const PREVIEW_TICKET_TTL_MS = 30_000;
export type PreviewTicketRefusal = "unknown" | "expired" | "mismatch" | "session";
export type PreviewTickets = {
  issuePreviewTicket(input: { sessionId: string; userId: string; previewHost: string }): { ticket: string; expiresAt: Date };
  redeemPreviewTicket(input: { ticket: string; sessionId: string; previewHost: string }): Promise<{ userId: string } | { reason: PreviewTicketRefusal }>;
  size(): number;
};
export function createPreviewTickets(deps: { store: Pick<CraftStore, "findSession">; now?: () => Date }): PreviewTickets;
export const PREVIEW_SESSION_COOKIE = "openbot_preview_session";
export function previewSessionCookieHeader(value: string): string; // HttpOnly; Path=/; SameSite=Lax; 无 Max-Age/Expires
export function defaultPreviewOrigin(env?): string; // D5 dev 默认（#362 收敛端口语义）
```

### 来自 #361（server/src/craft/preview-origin.ts）
```ts
export type PreviewOriginAdmission = { ok: true } | { ok: false; reason: string };
export type PreviewRequestResolution = { sessionId: string } | { refuse: { status: 404 | 503; reason: string } };
export type PreviewOrigin = {
  admission(): PreviewOriginAdmission;
  originFor(sessionId: string): string;           // 关闭时 throw；注册 label
  handlesRequest(request: Request): boolean;      // dispatcher 分支门
  resolvePreviewRequest(request: Request): PreviewRequestResolution;
  handlePreviewRequest(sessionId: string, request: Request): Promise<Response>; // 兑换→D9 cookie→302
};
export function createPreviewOrigin(deps: { config; previewTickets: PreviewTickets; secret: string; env? }): PreviewOrigin;
```
- `CraftConfig.previewOriginEnabled`（env `OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED`，默认 true）
  与 `previewOriginTemplate`（env `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE`，默认 ""=dev 形态）。
- dev 形态：会话跑在 `http://127.0.0.1:<port>/<label>`（label 是路径段）；host 形态：
  `<label>.<base>`，应用在根路径。label = HMAC-SHA256(secret, sessionId) 截 20 hex。
- index.ts 已在 `serve()` fetch 最前分支 `craftPreviewOrigin.handlesRequest(request)`。
- routes.ts/index.ts 已把同一 `previewTickets` 实例与 `previewOriginFor` 注入 webapp 代理。
- 签发路由已存在：`POST /api/craft/sessions/:id/preview-ticket` → `{ ticket, expiresAt, origin }`。

### 现有代理（webapp-proxy.ts，#362/#363 的改造对象）
- `proxyWebappRequest(input)`、`webappDevServerReady`、`webappUpstreamHost`（nextjs-dev.ts）。
- HMR：`WEBAPP_HMR_PATH = /^\/api\/craft\/sessions\/([^/]+)\/webapp\/_next\/webpack-hmr$/`、
  `webappHmrSessionIdFromPath`、`webappHmrUpstreamUrl`、`resolveWebappHmrUpgrade(deps, input)`、
  `webappHmrSocketHandlers`。
- `webapp-info` 目前返回 `webapp_url: "/api/craft/sessions/<id>/webapp"`（相对）——#362 绝对化。

### 前端（app）
- `app/src/components/craft/output-panel/preview-tab.tsx`：iframe 直接 `src=webapp_url`，
  sandbox 含 `allow-same-origin`（保留，D2）。
- `app/src/lib/craft/{client,types,queries}.ts`：`craftWebappQueryOptions(sessionId)`。

## Tasks

### Task #359 — ACME DNS-01 泛域名证书自动化（AC8）

**Files（write scope）:** `docker/compose/`（证书 sidecar/compose 片段）、证书目录约定、
部署文档（`docs/` 或 docker/compose 内 README）；`server/` 只消费挂载结果。不碰预览代理。
**Interfaces:** Consumes 部署方 DNS 凭据（secret 注入）；Produces `*.<preview-host>` 证书
+ 续期状态可观测信号（成功/失败事件，供准入与告警消费）。
**Steps:**
- [ ] 派发 impl-359（Pi，new-child）
- [ ] 交付：acme.sh DNS-01 自动签发/续期流水线（Let's Encrypt，免费栈）、挂载+reloadcmd
      联动、续期失败告警、私钥权限最小化、失效演练脚本（staging 或注入失败）
- [ ] 缺真实 DNS 凭据：AC8 生产签发证据记为缺口，不伪造
- [ ] 独立 Pi review → 集成 → 检查点

### Task #362 — 预览代理按 Host 路由与票据流程（AC1, AC2）

**Files（write scope）:** `server/src/craft/webapp-proxy.ts`、`server/src/craft/preview-origin.ts`
（入口小改）、`server/src/index.ts`（dispatcher）、`server/src/craft/routes.ts`（装配如需）、
`app/src/components/craft/output-panel/preview-tab.tsx`、`app/src/lib/craft/{client,types,queries}.ts`、
`server/tests/`（新增 craft-webapp-preview-origin.test.ts 或扩展）。
**Interfaces:** Consumes `issuePreviewTicket`/`redeemPreviewTicket`、`resolvePreviewRequest`、
`proxyWebappRequest`、`webappDevServerReady`；Produces `webapp_url` 绝对地址 +
`previewOrigin: string | null`、preview 域 cookie（`previewSessionCookieHeader` 真正 Set-Cookie）、
前端换票→跳转封装。
**Steps:**
- [ ] 派发 impl-362（Pi，new-child）
- [ ] 吸收 #362 正文五条审阅约束（M-1 生产 Host 后缀匹配、M-2 重启空窗二选一+注释修正、
      m-5 webapp-info 关闭原因面、端口语义收敛、#360 接缝消费）
- [ ] RED→GREEN：跨 origin 401、cookie 隔离、四动词+Server Actions、`webapp_url` 绝对化、
      票据不入 URL/日志
- [ ] 下游核验：preview-tab / webapp-download / Tauri（desktop/）/ 分享链路
- [ ] 独立 Pi review → 修复循环 → 集成 → 检查点

### Task #363 — HMR 升级在新 origin 下的鉴权与路由（AC5）

**Files:** `server/src/craft/webapp-proxy.ts`（HMR 段）、`server/src/index.ts`（upgrade
dispatcher）、`server/tests/craft-webapp-hmr.test.ts`。
**Interfaces:** Consumes `resolvePreviewRequest`、票据/preview cookie；Produces
`resolveWebappHmrUpgrade` 的 host 版本（upgrade 鉴权与 HTTP 代理同源判定）。
**Steps:** 派发 → RED（host 路由下升级拒绝/成功两路）→ `WEBAPP_HMR_PATH` 新形状/Host 分发
→ 真实浏览器 HMR 帧>0 → review → 集成。

### Task #364 — 脚手架退场 basePath（AC2）

**Files:** `server/assets/craft/web-template/{next.config.ts,lib/base-path.ts,AGENTS.md}`、
`server/tests/craft-webapp-template.test.ts`。
**Interfaces:** Consumes #362（路径不承载会话语义）；Produces 根路径脚手架契约 + 新断言集。
**Steps:** 派发 → 删三段+resolveWebappBasePath（保留 allowedDevOrigins）→ base-path.ts 置
空串 → AGENTS.md 重写 → 更新测试 → 浏览器回归（在 #363 结算后跑，避免端口争用）→ review
→ 集成。

### Task #365 — 缝合验收 E2E（AC1–AC3, AC5）

**Files:** `server/tests/` 或 `scripts/`（可复跑浏览器验证脚本 + 启动前置说明）、最小 fixture。
**Steps:** 派发 → 两个真实会话+探针应用 → 逐 AC 浏览器验证（截图留证）→ HMR 改文件断言
DOM 变化 → 全屏不重挂载 → review → 集成。失败回退对应上游票，不在本票内修。

### Task #366 — 拒绝与故障注入（AC3, AC4）

**Files:** `server/tests/`。
**Steps:** 派发 → 无票/过期/重放/跨会话/他人票/未知 Host 逐条 → 并发兑换竞争恰好一个成功
→ 准入关闭全拒绝 → 附着模型 503 回归 → review → 集成。

### Task #367 — 存量会话回归（AC7）

**Files:** `server/src/craft/`、`server/tests/`、前端提示（如需）。
**Steps:** 派发 → 判定信号选定（建议 next.config.ts 是否含 basePath）+ 理由 → 分支+测试
→ 文档/UI 提示一致 → review → 集成。

## 验证命令（实现者统一使用）

```bash
cd server && bun test tests/<相关文件>     # 单测（RED→GREEN 循环）
cd server && bun run build                 # tsc --noEmit
cd app && bun run typecheck                # 前端类型
bun run test ./server                      # server 全量回归（集成前）
```
真实浏览器：`uvx browser-harness`（用 goto/DOM click，坐标点击会被前台 tab 污染）；
craft dev 前置：`OPENBOT_CRAFT_ENABLED` + agent-sandbox 容器 + 3010 端口 override。

## 终局

- 全分支 Pi 终审（BASE→最终交付，最强档）→ findings 修复循环
- 外层 OCR（open-code-review，`--audience agent`）：已提交范围 BASE→HEAD + 未提交交付
  （workspace 模式），直到无有效 critical/high/medium
- 保存：Ledger、AC1–AC9 证据、浏览器/证书验证结果、检查点哈希、Pi 审阅、OCR 报告、
  实际 diff、未完成限制
