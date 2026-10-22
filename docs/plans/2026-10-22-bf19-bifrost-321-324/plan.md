# Bifrost 15.8 / 16.1 / 16.2 / 16.3 — bf19 批次实施计划（#321 #322 #323 #324）

- Run: `.archive/runs/2026-10-22-bf19-bifrost-321-324/`（issues/ 快照、baseline git status、验证回执）
- 工作区：bf19 worktree（`main@HEAD a789f6a4` + 未提交前置增量：15.x 全链 0203–0205 服务端 + bf18 bifrost Go 串行门控基线，已核对复制）
- 事实源：Spec #5、`docs/specs/2026-10-14-bifrost-github-spec.md`、`docs/specs/2026-10-14-bifrost-integration-design.md`（Q26）、ADR 0002/0003/0004/0008、票正文（`.archive/runs/2026-10-22-bf19-bifrost-321-324/issues-*.json`）
- 约束：GitHub 只读；不 commit 不 push；bifrost 子模块零提交；TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/bf19（容器 orca-w3-bf-pg）；不改 `.archive/` 既有内容之外的历史、不改 `server/src/mastra/**`；已知基线红不修不报；新测试经 `scripts/e2e-add-driven.mjs` 登记 + coverage audit。

## 前置核对（已完成）

- #320（15.7 尾结）交付在场：`realtime-tail-settlement.integration.test.ts`、0205、`realtime-unit.ts` settleUnit；#318/#319 同在。
- bifrost 侧 15.2/15.3（#315/#316）Go 基线在场：`realtimeunit.go`、`realtimeinputgating.go`、`main.go` PreRequestHook 挂 gate、`wsrealtime.go` 转发前问 gate（bf18 增量，未提交，已复制入 bf19 子模块克隆）。
- WebRTC 入口（`webrtcrealtime.go`）现状：建立走 `refuseUnauthenticatedRealtime` + `RunPreRequestHooks` + `refuseUnresolvedRealtimeCredential`（与 WS 相同两问），但 ① `newRealtimeRelayContext` 不拷贝 gate key，② `fromBrowser` 转发前不问 gate —— 即未预留输入可经 WebRTC 数据通道直达上游（#322 缺口）。
- 临时凭据现状：`ek_bf_*` 映射可无限次建立会话（无单会话绑定）；未映射 `ek_*`（上游 provider 临时凭据）在 enforce-auth 下豁免准入直接透传上游（#324 缺口）。
- 服务端门（establish/unit/settle）为库级服务，两入口共用同一状态机 —— #323 一致性以同一组用例在权威层断言。

## DAG

```
#321 (restore/双会话/消费展示, openbot) → #322 (WebRTC 门控接线, bifrost) → #323 (关停/尾结一致, bifrost+server) → #324 (防绕开, bifrost+server)
```

串行执行；#321 交付的读面与 #323 的 parity 集成测试共享 bf19 测试库互不阻塞。

## #321 B15.8 断线/重启恢复与实时消费展示

- NEW `server/src/billing/realtime-usage.ts`：`createRealtimeUsageService({database})` → `realtimeSessionsForPayer(payer)`。同一账户（payerKind+payerId）过滤，新到旧，限额；每会话：身份/状态/停止与关闭原因、单元计数（settled/pending(reserved+processing)/unknown/refused）、consumed（settled 单元的 reservation.charged 之和）、pending（holding 单元的 reservation.maximum 之和）、abnormalReason（stop/close/unknown 的闭集码）。金额沿用 ×100 缩放整数。
- `server/src/billing/routes.ts`：`createBillingCreditRoutes` 增 `GET /credits/realtime-sessions`（requireUser；payer 服务端解析；账户参数伪造 400 沿用既有中间件；服务缺配 503 不回退）。
- NEW `server/tests/realtime-recovery.integration.test.ts`（RED→GREEN）：
  - AC1 重启重放：第二服务实例重放同 unitKey → `replay:true` 原单位/原预留，无新行、无第二 attemptId；重启后 settleUnit 一次、重放结算答原结果，ledger 恰一行；
  - AC1 恢复走 08.x：崩溃单位（unknown 标记）经 `scanOnce` 产出 RecoveryItem（不新建单位）；restore(sessionId) 答同一身份；
  - AC2 双会话竞争：同 grant 两会话，余额恰够一单位；A 取走后 B 的新单位 `insufficient_credits` 且 B 被停止（stoppedAt/stopReason），A 已持单元照常结算；
  - AC3/AC4 读面：A 见自身会话消费/待结算/异常；B 查不到 A 的任何会话。
- NEW `app/src/lib/billing/realtime.ts`（queryOptions + 类型）+ `app/src/components/billing/realtime-sessions-card.tsx`（挂入 usage 视图 `usage-credits-view.tsx`）；locales en/zh-CN 增实时会话词条；异常原因经闭集码→i18n key 映射（未映射码走 fallback，不外泄原文）。
- NEW `app/tests/realtime-usage-ui.test.tsx`：渲染消费/待结算/异常；只渲染本人载荷；未知码走 fallback。
- 验证：`TEST_DATABASE_URL=... bun test server/tests/realtime-recovery.integration.test.ts`；`bun test app/tests/realtime-usage-ui.test.tsx`；`bun run --filter server typecheck`。
- 迁移：无需新迁移（全部读现有表）；若实现中发现缺口再按 0206 接续。

## #322 B16.1 WebRTC 入口复用单元预留与门控

- `bifrost/transports/bifrost-http/handlers/webrtcrealtime.go`：
  - `newRealtimeRelayContext` 拷贝列表加 `governance.RealtimeInputGateContextKey()`（gate 指针随 relay 上下文存活）；
  - `realtimeWebRTCMessages.fromBrowser`：`ToProviderRealtimeEvent` 成功后、`sendUpstream` 前问 gate；拒绝→不转发，下行 402 `insufficient_quota` 错误事件（与 WS 同文案/码），`Shutdown`→403 `session_shutdown` 并 `closeWithErrorEvent`（关闭双侧）。
- 建立校验（AC1）：两入口同走两问 + RunPreRequestHooks（现状已同），以 governance 侧测试固化"WebRTC 建立即挂同一 gate"。
- Go 测试：`bifrost/plugins/governance/realtimeunit_webrtc_admission_test.go`（`-run WebRTCAdmission`）：PreRequestHook(RealtimeRequest) 后 gate 在 ctx；同一 gate 对 WebRTC 会话身份的 Decide 与 WS 语义一致（未预留不转发、预留后转发、exhaustion latch、shutdown）；`realtimeserialization` 同门测试。transports 侧 `webrtcrealtime` 测试补 fromBrowser 门控断言（复用既有 fake 面板）。
- 验证：`cd bifrost/plugins/governance && go test -run WebRTCAdmission ./... && go test ./...`；transports `go test ./handlers/ -run WebRTC`（模块内可行时）；`bun run --filter server typecheck`（无 TS 改动则为基线核对）。

## #323 B16.2 WebRTC 关停与尾部结算一致

- 复用 #322 的 gate 接线；关停决定（authorization 拒绝→markShutdown）在 WebRTC 数据通道同样触发 `closeWithErrorEvent` → relay 关闭 browser/provider 两侧 peer（数据通道+上游会话，尽力关停）；registry sweep（holding→unknown, 保留 hold）与 WS 同一函数。
- Go 测试（`-run WebRTCTail`）：WebRTC 会话关停 sweep 后 holding 单元 unknown 且 hold 保留；同一用例跑 WS 身份对比 registry 结果一致；拦截原因闭集一致。
- NEW `server/tests/realtime-webrtc-parity.integration.test.ts`：两入口在权威层共用同一状态机 —— 同一时间线（建立→单元→耗尽停止 / 撤销关停→unknown→尾结一次）分别跑两个会话，断言逐字段一致；尾结重放不重扣；unknown 尾部保持预留。
- 验证：`TEST_DATABASE_URL=... bun test server/tests/realtime-webrtc-parity.integration.test.ts`；`go test -run WebRTCTail ./...`；`go test ./...`。

## #324 B16.3 防临时 provider 会话绕开

- bifrost `plugins/governance/realtimebypass.go`（NEW）：进程级有界旁路审计 registry（closed kind：`unmapped_ephemeral_token` / `ephemeral_token_reuse`；计数+有界记录+stats 读，供 22.x 引用）。
- WS/WebRTC 建立路径共享助手（handlers）：
  - enforce-auth 下未映射 `ek_*`（provider 临时凭据）→ 401 拒绝（闭馆：provider authoritative 豁免仅限 admission 未开启的部署），记 bypass 审计；
  - 已映射 `ek_bf_*` 于首次建立时绑定会话（KV 单次消费标记）；同凭据第二次建立 → 拒绝 + 记审计（会话内重连走服务端 restore，不复用凭据）。
  - 直连不可获得：client_secrets 应答已替换 provider token（断言测试固化）；建立/恢复应答不含上游 URL/长期凭据。
- server `server/src/billing/realtime-session.ts`：establish 请求形状新增闭集拒绝词表（`clientSecret`/`ephemeralToken`/`sessionToken`/`apiKey`/`upstreamUrl`/`endpoint` 等 provider 会话凭据与替代端点字段，presence 即拒 `request_invalid` + bypass 细节），经注入 `audit` 写 `billing.realtime.bypass_refused` 审计事件。
- NEW `server/tests/realtime-bypass-audit.test.ts`（bun，无 DB 依赖或用 bf19 库）：夹带字段 → 拒绝 + 审计行；正常建立无审计噪音；restore 应答无凭据字段。
- Go 测试（`-run RealtimeBypass`）：未映射 ek_ 拒绝；ek_bf_ 复用拒绝；审计记录断言。
- 验证：`go test -run RealtimeBypass ./...`；`bun test server/tests/realtime-bypass-audit.test.ts`；`go test ./...`。

## 收尾

- 新 bun 测试逐个 `node scripts/e2e-add-driven.mjs <file> <reason>`；`node scripts/e2e-coverage-audit.mjs` 全绿。
- `bunx biome lint --error-on-warnings <changed files>`；受影响 typecheck；Go vet/gofmt（模块内）。
- 报告：`reports/orca-dag-wave3-bf19.md` + `reports/bf19-increment-files.txt`（对照 baseline 快照的自有增量清单）。
