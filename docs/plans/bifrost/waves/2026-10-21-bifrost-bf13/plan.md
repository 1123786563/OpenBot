# bf13 wave3 — #315 / #316 / #301 实施方案

- **Worktree**: `/Users/wuyongjun/orca/workspaces/OpenBot/bf13`（分支 1123786563/bf13 = main@73aa6d59 + 未提交前置增量至 0193）
- **票号裁决**：GitHub 实况 #315=B15.2、#316=B15.3、#301=B11.6（与 bf12 报告的 B 编号差 2 先例一致），按票号执行。
- **基线修复**（开工第一步，详见报告）：bf13 落位时只有 tracked diff（journal 至 0193 + 各模块修改），整条 wave3 未跟踪文件链（10 个迁移 SQL、7 个 billing 模块、~20 个测试、app 组件等 67 文件）缺失——从 hbc11（hindsight 链尾，0190/0191 命名与 bf13 journal 完全一致）+ bf12（ocr/realtime/audio 三模块，0190/0191 SQL 重编号为 0192/0193）并集恢复，3 个分歧文件取 hbc11 版（配 0190 purge_restore 的 verify_state 列）。恢复后前置套件 36 pass、server typecheck 仅 3 个已知基线错误。
- **执行顺序**：#315 → #316（构建于 #315 单元注册表）→ #301（独立线）。
- **提交策略**：不 commit、不 push；父仓改动留工作树；bifrost 子模块 pinned e44890f8 零提交（本地 clone），新 Go 文件 + 少量 tracked 文件编辑全部留在子模块工作树未提交增量。
- **验证证据**：`.archive/runs/2026-10-21-bifrost-bf13/verification/`；worker 报告 `reports/orca-dag-wave3-bf13.md`。

## Task 1 — #315 B15.2 单元级 attempt 与 Reservation hook

**依赖核验（已读实际实现）**：15.1 `realtime-session.ts`（establish/restore、身份行冻结 payer/model/双版本、拒绝码闭集）；06.3 `credit-reserve.ts` 导出 `reserveCreditInTransaction(tx, request, env)`（组合纪律：单事务七判决一写入，refused 零写入）；06.7 `attemptIdForReservation`（att- 纯函数）。

**Server 侧**（模块 + 迁移 + 集成测试）：

| 产物 | 内容 |
| --- | --- |
| `server/drizzle/0194_realtime_units.sql` + schema `realtimeUnits` | `ru-` PK、session FK、`(session_id, unit_key)` UNIQUE（重放收敛）、kind 闭集 CHECK（input_audio/output_audio/response/duration）、bound_cents>0、state 闭集 CHECK（pending/reserved/processing/settled/unknown/refused）、状态形状 CHECK（reserved 族必带 attempt_id+reservation_id 且 attempt 唯一；refused 必带 refusal_reason 且无 reservation；pending 两者皆无）、(session_id, created_at) 索引 |
| `server/src/billing/realtime-unit.ts` | `createRealtimeUnitService`：`openUnit(input)` = 形状校验（闭字段、kind/boundCents/unitKey/boundEvidence）→ 单事务：读 session 行（身份来源，open 才可开单元）→ 插 pending 行 → 组合 `reserveCreditInTransaction`（grantId/payer/model/snapshot/rate 全部取自 session 冻结行；idempotencyKey=unitId）→ reserved 则更新 reserved+ids / refused 则更新 refused+原因；重放（同 session+unit_key）答原行现态。`markProcessing(unitId)`：reserved→processing 守卫 UPDATE。`unitState`/`listUnits`：纯行读，重启替身可恢复（AC4）。无 dispatch——转发是网关的事（#316 门控） |
| `server/tests/realtime-unit-reservation.integration.test.ts` | AC1 两单元独立预留（独立 attemptId+reservationId，同账户并存）；AC2+票面步骤4 余额只够一个→第二个 refused（insufficient_credits 透传、无第二行 hold、ledger 0）；AC3 refused 单元不进处理（无 reservation 行、dispatch 语义上无供应商输入——服务无 dispatch 面）；状态机流转（reserved→processing；refused 形状；pending 原子不可见）；重放收敛；AC4 新服务实例恢复单元态；session 未知/关闭/kind 非法/形状拒绝 |

**Go 侧（governance 插件，Reservation hook 的网关半边）**：

新文件 `plugins/governance/realtimeunit.go`（未跟踪树）：
- `RealtimeUnitRecord{UnitID, SessionID, AttemptID, ReservationID, Kind, BoundCents, State, RefusalReason}` 与 server 契约同名同义。
- 插件内 session 键控单元注册表（mutex + map），`RecordRealtimeUnitReserved/Refused`、`RealtimeUnitFor(sessionID)` 导出给转发路径与测试。
- Hook 接线（`creditadmission.go` 未提交编辑，bf12 同例）：`reserveBeforeDispatch` 对 `RealtimeRequest` 在取得/拒绝 hold 时写注册表——每 turn 即一个 response 单元，独立 attempt（既有 creditAttemptID），预留失败 refusal 即单元 refused、不派发（既有短路）。
- `realtimeunit_test.go`：注册表流转断言（pending→reserved/refused、查询、并发安全）。

## Task 2 — #316 B15.3 音频输入门控

**依赖**：#315 的单元注册表 + 既有 per-turn reserve（realtime turn pipeline）。

**Go 侧（主战场）**：

| 产物 | 内容 |
| --- | --- |
| `plugins/governance/realtimeinputgating.go`（新） | 门控决策：`IsBilledRealtimeAudioInput(event)`（闭集：`input_audio_buffer.append`，按 provider 事件类型）先判计费输入；未预留→先经 reserve door 同步预留一个 input_audio 单元（boundCents=reserve 配置上限，#315 hook 的输入侧应用）→ 仍无 hold 则拦截；拦截记录（计数+原因闭集 unit_not_reserved/unit_reserve_refused/unit_reserve_unreachable + 字节量），导出 `RealtimeInputGateStats` 供 22.2 证据。决策只读注册表与事件类型——无任何客户端参数可影响（AC2） |
| `wsrealtime.go` 未提交编辑 | `processRealtimeClientMessage` 在 `upstream.WriteMessage` 前调用门控；拦截即不写 upstream（丢弃不计费）+ 记录；已预留单元的转发路径零变化（AC4）。门控状态经 governance 导出的 ctx 访问器或插件注册表可达（实现时按 realtimeauthgate.go 的导出谓词先例选最小缝） |
| `realtimeinputgating_test.go`（`-run RealtimeInputGating`） | 未预留 append 拦截（door spy 0 次计费输入转发=决策断言）；预留后正常转发；door 402→unit_reserve_refused 拦截；door 不可达→unit_reserve_unreachable 拦截；绕过尝试（事件带任意参数/额外字段）不影响决策；拦截记录断言（原因+计数）；非音频控制事件不过门 |

Server 侧：无需新迁移；`bun run --filter server typecheck` 保持 0 新增（#315 已落）。

## Task 3 — #301 B11.6 OCR 未知价格不得免费执行

**依赖核验（已读）**：11.5 `ocr-pricing.ts` 的 `assessOcrEnablement`/`ocrCeiling`（price_unknown(output) 判定、free=三 billed 维全 known 且 0——非缺维默认）；03.11 发现接口 `/api/model-discovery`（bot 面，冻结字段，加字段=记录在 produces 的契约变更——票面 Produces 已含）；admin `/status` 的 audioPaths 先例（#313）。

| 产物 | 内容 |
| --- | --- |
| `server/src/billing/ocr-admission.ts`（新，rerank 同缝） | `createOcrAdmission({reserve, dispatch})`：enablement 短路——unknown（含逐维 price_unknown）/页数不可定/无输出上限/形状不可读→拒绝，reserve 0 调、dispatch 0 调（供应商调用数 0、零账务写入）；free→{status:"free"} 仍走授权门禁后执行（不 reserve，零成本有价）；priced→ocrCeiling→reserve→hold 后 dispatch。free 判定钉死来自上游定价证据 |
| `server/src/gateway/capability-availability.ts`（新） | `summarizeCapabilityAvailability`：embedding/rerank/ocr 三能力逐 cell 汇总→{capability, state: enabled/free/price_unknown/unmapped, reasonCode}，free 与 unknown 不同态不同码（AC3/AC4） |
| `model-discovery-routes.ts`（+契约字段） | `/` 响应追加 `capabilities`（三能力状态+原因；bot 面只读汇总，无敏感字段） |
| `app/src/components/gateway/capability-availability.tsx`（新）+ gateway.tsx 挂载 + locales + queries 类型 | admin 网关页三行能力状态：free 与 unknown 展示不同（unknown 绝不显示为免费） |
| `server/tests/capability-availability.test.ts`（新，验证命令点名） | unknown OCR 拒绝（spy 0 调用、零账务）；free OCR 可执行（dispatch 1 次、reserve 0 次）且需门禁；free≠unknown 展示与汇总断言；三能力发现接口汇总（embedding enabled / rerank free / ocr unknown 各自原因） |
| `app/tests/capability-availability-ui.test.tsx`（新） | 界面 free/unknown 区分断言 |
| `plugins/governance/creditadmission.go` 未提交编辑 + `ocrpricing_test.go`（`-run OcrPricing`） | `creditCapabilityForRequestType` 补 `OCRRequest→"ocr"`（现状映射缺失=OCR 经门永远 capability unknown 被 open-scope 拒——known 价也被拒，诚实不启用）；Go 测试钉：OCR 请求 reserve payload 携带 capability "ocr"；door 答 422 price_unknown→拒且不派发；明确 free（datasheet 显式负费率证据）过门不 reserve |

## 验证矩阵（全部命令与结果记录到 .archive verification）

- #315：`TEST_DATABASE_URL=…/bf13 bun test ./server/tests/realtime-unit-reservation.integration.test.ts`；server typecheck；`cd bifrost/plugins/governance && go test ./...`
- #316：`go test -run RealtimeInputGating ./...`；server typecheck；governance 全量
- #301：`go test -run OcrPricing ./...`；`bun test ./server/tests/capability-availability.test.ts`；`bun test ./app/tests/capability-availability-ui.test.tsx`；server typecheck；governance 全量
- 公共：新测试 `node scripts/e2e-add-driven.mjs` 登记 + `e2e-coverage-audit`；`bunx biome lint --error-on-warnings`（自有增量）；gofmt；迁移链 journal 连续（0..194）
- 基线红不修不报为新增：gateway-admin-routes 7/2（negotiate）、audit 门禁 workshop.*、bootstrap typecheck 3 错
