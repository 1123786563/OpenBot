# Bifrost 03.5 管理员立即同步（#227）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理员可从管理端触发立即同步（复用 03.4 的同一同步实现与单飞保护），返回结果（成功时间/快照反馈/失败原因），每次触发写审计记录；非管理员被拒绝。

**Architecture:** 在已挂载的 `/api/admin/gateway` 管理面（`server/src/gateway/admin-routes.ts`）新增 `POST /catalog/sync` 路由。服务通过已安装的 controls 解析（`gatewayCatalogSyncControls()`），因此手动触发与 03.4 定时器共享同一个 `GatewayCatalogSyncService` 实例与单飞 cell（`runSync()` 内的 in-flight promise）——不新建第二个服务，不绕过失败保护。审计由路由层写（操作者是触发管理员，03.4 定时器无 actor），事件类型 `gateway.catalog_sync_triggered`（共享词汇表 `server/src/audit.ts` 增量加一行，03.7 先例）。前端在管理员目录页（`app/src/routes/_authed/admin/model-catalog.tsx`）加"立即同步"区块，经 `app/src/lib/gateway/mutations.ts` 新增 mutation 调用，成功/失败都展示服务端原文，成功后失效目录 query。

**Tech Stack:** Hono（server 路由）、Drizzle/PostgreSQL（TEST_DATABASE_URL 专用库 `openbot_b5_227`）、Bun test、TanStack Query + React（app）、i18next（en / zh-CN）。

**Spec:** docs/tickets/bifrost-5/issues/03.5-admin-manual-sync.md；父 Spec docs/specs/2026-10-14-bifrost-github-spec.md（AC10/AC19，US17）；docs/specs/2026-10-14-bifrost-integration-design.md（Q17）

## Global Constraints

- 手动触发必须复用 03.4 的 `runSync()`（同一实例、同一单飞、同一失败保护），不得复制同步逻辑或直写目录/快照表。
- 路由为管理员-only（沿用 admin-routes.ts 既有 `requireUser` + `requireAdmin` 中间件，依赖注入的测试 guard 与 `gateway-admin-routes.test.ts` 同构）。
- 失败原因只携带 03.1/03.2/03.4 的固定 reason code（`catalog_fetch_*` / `price_sync_*`），绝不携带上游字节、URL 或消息。
- 审计 payload 只含操作者、时间、结果与固定 code；经过 `recordAuditEvent` 的脱敏。
- SQL 行为在专用 PostgreSQL（`TEST_DATABASE_URL=openbot_b5_227`）上验证；缺库不回退 live 库、不记通过；skipped 不算通过。
- 不 commit / push / stash；不越界改文件（audit.ts 增量已按编排纪律 ask 上报，msg_c026be0ebdb6）。
- 前端展示文案走 i18n（en + zh-CN 同步补齐），页面只展示服务端持有的结果。

## Review Focus

- **并发双击**：两个并发 POST 必须共享一次同步（fake gateway 只被拨号一次 /v1/models，fetch log 只加一行，两响应 outcome 一致）→ Task 1 的单飞测试钉死。
- **权限**：member(403)/anonymous(401) 触发被拒，且未产生 fetch、快照或审计行 → Task 1 权限测试钉死。
- **失败保护不绕过**：网关不可达时手动触发返回 failed + 固定 reasonCode，last-good 目录与价格快照保持不变，`lastSuccessfulSyncAt` 不动，`consecutiveFailures+1` → Task 1 故障注入钉死。
- **审计完整**：成功与失败两种结果都有审计行（操作者、时间、结果、reasonCode/appended），路由在审计写失败时不得报成功 → Task 1 审计测试钉死。
- **同步服务未安装**：进程未安装 enterprise controls / sync service 时 503 + 固定 code，绝不猜测或现场组装第二个服务 → Task 1 钉死。

## 契约决定（向下游 03.6 / review 报告的映射说明）

- 03.2 交付的价格快照版本是**每 ref 一条递增序列**（`gatewayPriceSnapshots.snapshotVersion`），无全局快照版本标量。故"新快照版本"反馈 = `result.appended`（新写入快照版本的 ref 数）+ `result.skipped`（维度未变、未新增版本的 ref 数）+ `result.record.configVersion`（本次 last-good 目录对应的 endpoint 配置版本）。下游 03.6 新鲜度门禁消费的是 `gatewayCatalogSyncState.lastSuccessfulSyncAt`，不受此影响。
- 同步结果为 failed 时路由返回 HTTP 200 + `result.status:"failed"`（与 `POST /probe` 先例一致：动作已执行，失败是结果而非路由错误）；服务缺失才是 503。
- 审计行对 ok 与 failed 两种结果都写（AC："每次触发都有审计记录"）；503（服务缺失）未执行同步，不写审计。

---

### Task 1: 管理员同步路由（RED→GREEN，server）

**Files:**
- Modify: `server/src/gateway/admin-routes.ts`（deps 增 `syncService`/`auditStore` 闭包默认值；新增 `POST /catalog/sync`）
- Modify: `server/src/audit.ts`（`auditEventTypes` 词汇表追加 `"gateway.catalog_sync_triggered"` 一行 + 注释；**越界增量，已 ask 上报**）
- Test: `server/tests/catalog-manual-sync.test.ts`（新建）

**Interfaces:**
- Consumes: `GatewayCatalogSyncService.runSync(): Promise<CatalogSyncOutcome>`（ok: `{status:"ok"; record:{fetchedAt,source,rawItemCount,configVersion}; appended:number; skipped:number; syncedAt:string}` / failed: `{status:"failed"; stage:"catalog"|"prices"; reasonCode:CatalogSyncFailureReasonCode; failedAt:string}`）、`gatewayCatalogSyncControls(): GatewayCatalogSyncService|undefined`、`enterpriseControls()?.deps.auditStore: AuditStore`、`recordAuditEvent(store, event)`。
- Produces: `POST /api/admin/gateway/catalog/sync` → 200 `{result: CatalogSyncOutcome}`；503 `{error, code:"gateway_catalog_sync_unavailable"}`（sync service 或 audit store 缺失）；`GatewayAdminRouteDeps` 新增可选注入 `syncService`/`auditStore`；审计事件类型 `gateway.catalog_sync_triggered`（targetType `gateway_catalog`，targetId `gateway_catalog_sync`）。

- [ ] **Step 1: 写失败测试**（新建 `server/tests/catalog-manual-sync.test.ts`，结构对齐 `gateway-admin-routes.test.ts` + `catalog-auto-sync.test.ts`）
  - 测试库经 `testDatabaseUrl()`（TEST_DATABASE_URL）；`actorAs("admin"|"user"|"anonymous")` guard；真实 store + `createGatewayCatalogSyncService` 注入 `deps.syncService`；审计用 `createAuditStore(database)` 注入 `deps.auditStore`，用 `auditEvents` 表直接查询断言。
  - 用例 1 权限：member→403、anonymous→401；事后断言 `gateway_catalog_fetches`、`gateway_price_snapshots`、`audit_events` 均无新行。
  - 用例 2 成功：fake gateway 返回含 1 个模型的 manifest（唯一 provider）；POST → 200 `{result:{status:"ok",appended:1,skipped:0,record.configVersion,syncedAt}}`；断言目录 ref 落库、价格快照 @1、同步状态行 `lastAttemptStatus="ok"`、审计行（eventType、actorUserId、payload.outcome="ok"、payload.appended=1）。
  - 用例 3 失败保护：fake gateway 换 500；POST → 200 `{result:{status:"failed",stage:"catalog",reasonCode:"catalog_fetch_unreachable"}}`（以 fake 实际分类为准断言固定 code）；断言目录 refs 与价格快照不变、`lastSuccessfulSyncAt` 不动、`consecutiveFailures=1`、审计行 outcome="failed" 带 reasonCode。
  - 用例 4 单飞：fake gateway `hold` 计划；发起第一个 POST（挂起）→ 发起第二个 POST（并发）→ `gateway.release()`；两响应 `result.syncedAt` 相同；fake gateway 的 `/v1/models` 拨号请求恰 1 次；`gateway_catalog_fetches` 中该 provider 的成功 fetch 行恰 1 行；审计行恰 1 行（两个请求共享同一次触发执行——单飞共享同一 outcome，只产生一次触发的审计）。
  - 用例 5 审计失败不静默成功：注入一个 insert 即抛的 audit store；POST → 非 2xx；断言审计行不存在。
  - 用例 6 服务缺失：`deps.syncService: () => undefined` → 503 code `gateway_catalog_sync_unavailable`。
- [ ] **Step 2: 跑测试确认 RED**：`cd server && TEST_DATABASE_URL=... bun test tests/catalog-manual-sync.test.ts` → 路由 404（`/catalog/sync` 不存在）或类型错误，均为预期失败形态。
- [ ] **Step 3: 实现**：`server/src/audit.ts` 词汇表追加事件类型（含注释块，格式对齐 `gateway.model_scope_changed`）；`admin-routes.ts` 的 `GatewayAdminRouteDeps` 增 `syncService`/`auditStore` 闭包（默认 `gatewayCatalogSyncControls()` / `enterpriseControls()?.deps.auditStore`）；新增 `app.post("/catalog/sync")`：服务缺失→503；`await resolved.syncService().runSync()`；`await recordAuditEvent(auditStore, {eventType:"gateway.catalog_sync_triggered", targetType:"gateway_catalog", targetId:"gateway_catalog_sync", actorUserId: context.var.actor.id, payload:{trigger:"manual", outcome, ...(ok? {syncedAt,appended,skipped,configVersion}:{stage,reasonCode,failedAt})}})`；返回 200 `{result}`。
- [ ] **Step 4: 跑测试确认 GREEN**：同命令全绿；再跑 `bun test tests/catalog-auto-sync.test.ts tests/gateway-admin-routes.test.ts` 确认未破坏 03.4/01.8。
- [ ] **Step 5: typecheck + lint**：`bun run --filter server typecheck`；`bunx biome lint --error-on-warnings src/gateway/admin-routes.ts src/audit.ts tests/catalog-manual-sync.test.ts`。

### Task 2: 管理员目录页同步入口（RED→GREEN，app）

**Files:**
- Modify: `app/src/lib/gateway/mutations.ts`（新增 `runCatalogSyncMutationOptions`）
- Modify: `app/src/routes/_authed/admin/model-catalog.tsx`（目录列表上方同步区块：按钮 + 结果展示）
- Modify: `app/src/locales/en/admin.json`、`app/src/locales/zh-CN/admin.json`（`modelCatalog.sync.*` 键）
- Test: `app/tests/admin-catalog-sync-ui.test.tsx`（新建，结构对齐 `admin-gateway-readiness.test.tsx`：fetch stub + 内存路由 + i18n en）

**Interfaces:**
- Consumes: `POST /api/admin/gateway/catalog/sync`（Task 1 契约）、`gatewayKeys`、`client()`、`invalidateQueries({queryKey: gatewayKeys.all})` 惯例。
- Produces: `runCatalogSyncMutationOptions(queryClient)` → mutation，POST 后返回 `CatalogSyncOutcome` 形状（status/syncedAt/appended/skipped/record | stage/reasonCode/failedAt）；成功与失败都 invalidate 目录与状态 query。

- [ ] **Step 1: 写失败测试**（fetch stub 维护可变部署状态，路径 `/api/admin/gateway/catalog/sync` + 既有 `/models`）
  - 用例 1：点击"立即同步"→ POST 发生 → 成功结果句（syncedAt + appended/skipped）渲染，目录 query 被重读（stub 的 models 响应在同步后翻转，断言新模型出现）。
  - 用例 2：stub 返回 `result.status:"failed"` + reasonCode → 页面展示失败句 + 固定 code 原文（i18n 键映射或 code 直显），不展示成功句。
  - 用例 3：同步进行中按钮禁用（mutation pending 期间再次点击不产生第二个 POST——stub 计数断言）。
  - 用例 4：503（`gateway_catalog_sync_unavailable`）→ 页面展示不可用句。
- [ ] **Step 2: 确认 RED**：`cd app && bun test tests/admin-catalog-sync-ui.test.tsx` → 找不到按钮/文案，失败为预期。
- [ ] **Step 3: 实现**：mutations.ts 增 mutation（`client("/api/admin/gateway/catalog/sync", {method:"POST", fallbackKey:"gateway.operation"})`，onSuccess invalidate）；model-catalog.tsx 在 `PageSection` 列表前增同步区块（Button + 最近结果文本）；locale 键：`modelCatalog.sync.button/success/failed/unavailable/running`（en + zh-CN 同形）。
- [ ] **Step 4: 确认 GREEN**：同命令全绿；跑 `bun test tests/admin-gateway-readiness.test.tsx` 确认 01.8 页面未破坏。
- [ ] **Step 5: typecheck + lint**：`bun run --filter app typecheck`；`bunx biome lint --error-on-errors`（改动文件）。

### Task 3: 全量验证与报告

- [ ] **Step 1**: `cd server && TEST_DATABASE_URL=<专用库> bun test tests/catalog-manual-sync.test.ts tests/catalog-auto-sync.test.ts tests/gateway-admin-routes.test.ts` 全绿。
- [ ] **Step 2**: `cd app && bun test tests/admin-catalog-sync-ui.test.tsx tests/admin-gateway-readiness.test.tsx` 全绿。
- [ ] **Step 3**: `bun run --filter server typecheck`、`bun run --filter app typecheck` 通过。
- [ ] **Step 4**: `bunx biome lint --error-on-warnings <changed files>` 通过。
- [ ] **Step 5**: 写 `.omc/reports/b5-227.md`（变更清单、逐条 AC 证据、命令输出摘要、契约映射说明、遗留风险）；`git status` 保持未提交。

## Self-Review

- Spec 覆盖：AC 逐条 → 路由立即执行+返回结果（Task1 用例2/3）、非管理员拒绝（用例1）、单飞（用例4）、审计（用例2/3/5）；UI 按钮+结果（Task2 用例1/2/3/4）。无缺口。
- 步骤可执行性：每步一个动作；测试以断言+精确路径钉死；实现只留"按契约最小实现"。
- 类型一致：`CatalogSyncOutcome` 字段名与 `catalog-sync.ts` 逐字一致；审计 payload 键在报告与测试一致（`outcome`/`syncedAt`/`appended`/`skipped`/`stage`/`reasonCode`）。
- Review Focus 五条各有归属测试。
- 比例：计划长度 ≈ 票面 + 契约映射，无代码转录。
