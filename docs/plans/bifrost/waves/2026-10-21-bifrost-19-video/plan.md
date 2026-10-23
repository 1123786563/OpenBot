# Bifrost 组 19 视频能力（#337/#338/#339/#340）实施计划

- 工作区：`/Users/wuyongjun/orca/workspaces/OpenBot/bf17`（分支 `1123786563/bf17`，BASE `a789f6a4` + 未提交前置增量）
- 事实源：Issue #337–#340 正文（gh api 快照存 `.archive/runs/2026-10-21-bf17-video19/issues/`）、父 Spec #5、ADR 0002/0003/0004、ADR 0008
- 提交策略：无提交授权 — 未提交检查点；bifrost 子模块 ad9470a5 只读、零提交
- 验证库：`postgres://postgres:postgres@127.0.0.1:5566/bf17`（容器 `orca-w3-bf-pg`，wave3 共享容器，新建 bf17 库）
- 迁移编号：接续 0202（journal idx 202）

## DAG

```
#337 19.1 视频生成规格计价与预留
  └─> #338 19.2 未定价视频规格不可用（终点，无下游）
  └─> #339 19.3 视频编辑/变体规格计价
        └─> #340 19.4 视频异步结算恢复与产物查询（组 19 缝合点，另消费 17.3/17.6/17.7）
```

前置核验（已做）：17.2 提交预留（`async-job-submit.ts`，cap=Σentries×06.5 精确换算、
幂等键收敛、dispatch 丢失→06.8 unknown 全额占用）；17.3 恢复（`async-job-recovery.ts`
providerJobId 丢失恢复，不释放不重派）；17.4 状态只读（`async-job-status.ts`）；17.6 终态
结算（`async-terminal.ts`，reservation 栅栏一次结算、locked basis 计价、over-cap 审计）；
03.2 价格快照（`video` 维度已在词汇表，USD/video-second，v1 wire 无源→unknown）；06.5
（`reserve-bound.ts` 全维精确换算、版本锁）；12.x 图像线模式（tier 表 + enablement 判定 +
overlay）；bifrost 上游 `framework/jobaccounting/video.go`（VideoSettler/Poll/Settle、
UnpriceableReason* 词汇、秒×分辨率×条数维度）。

## 关键设计决定

1. **19.1 不新增价格维度**：`video`（USD/video-second）自 03.2 已预留。分辨率/质量档走
   12.1 同款 tier 表（exact 行→wildcard 回退；已知 `video` 金额填 wildcard 行=全档统一
   每秒价）。纯 v1 wire 快照 → `video` unknown → 表空 → 启用判定 REFUSED（诚实拒绝，
   不用估算补）。
2. **19.3 新增 `video_input` 维度（迁移 0202）**：USD/input-video-second，`not_on_wire_v1`。
   输入侧需要独立的 known/free/unknown 槽：共享 `video` 维度无法表达"输入明确免费"
   （把共享维度记 0 会把输出也判免费——少计费）；上游不收输入费时只能记
   `video_input` known "0"（明确免费+证据），留空→unknown→拒绝（Resume hint 规则）。
   沿 0195 先例：`valid_gateway_price_dims` 整体重拼（14→15 键）；旧快照行不回填
   （append-only 触发器持有），迁移后新 append 全带 15 键。TS 词汇表（PRICE_DIMENSIONS/
   UNITS/WIRE_SOURCES）同步 +1；测试 fixture 机械补键（`Record<PriceDimension,string>`
   或 loop 分支），属本票契约变更的必要机械跟随，报告中如实列出。
3. **视频提交 = 17.2 异步提交的 entries 适配**：视频线不另建预留路径——
   `video` 数量（=秒×条数）与 `video_input` 数量（=输入秒和）作为 entries 喂
   `createAsyncSubmitService`，一次全上限预留、幂等、dispatch 丢失→unknown 全额占用，
   全部继承 17.2 语义（AC"编辑、变体与生成共用同一预留与结算语义"）。
4. **19.2 规格级可用性**：`summarizeVideoSpecAvailability`（纯函数，模型×调用方式粒度：
   generation 判 `video`、edit/remix 判 `video`+`video_input`），沿用组 11
   `summarizeCapabilityAvailability` 的纯读模式（其 UI/发现面挂载属后续票）；入口短路
   拒绝由 19.1 的提交门禁承接（enablement stage 拒绝在 reserve 之前：无预留、无台账、
   dispatch spy=0，原因指向缺失维度）。
5. **19.4 不新增迁移**：终态结算走 17.6 `asyncTerminalSettleService`（usage={video:真实秒,
   video_input:输入秒}），产物查询走 17.4 同款只读纪律（SELECT-only、无 money seam），
   恢复走 17.3 `createAsyncDispatchRecoveryService`；视频线交付 lane 组合 + usage 换算
   纯函数 + 跨票缝合测试。

## 按票任务

### T1 = #337 B19.1 视频生成规格计价与预留

owned_files（新增）：`server/src/billing/video-generation-pricing.ts`、
`server/src/billing/video-submit.ts`、`server/tests/video-pricing.test.ts`

- 规格冻结 `videoGenerationSpecOf`：seconds 必填正整数（无 wire 默认，不可确定即拒）、
  size/quality null 或非空串、outputCount 默认 1 上限 100（沿图像线 count 卫兵）、
  requestType 生成。
- tier 解析 `resolveVideoTierPrice`（exact→wildcard）+ `videoTierPriceTableFromSnapshot`
  （known video→wildcard 行；否则空表）。
- 上限换算 `assessVideoGenerationEnablement`：数量 `video = seconds × outputCount`
  （每条输出按其秒数计价），free=恰"0"；缺价/规格不可定→closed 词汇拒绝（维度具名）。
  `videoGenerationCeilingDims` overlay（tier 价写回 `video` 槽，06.5 换算用）。
- 提交接线 `createVideoSubmitService`：enablement→entries→17.2 asyncSubmit.submit；
  拒绝在 reserve/dispatch 之前（阶段化 reasonCode）。
- RED→GREEN 测试（video-pricing.test.ts）：多档位换算（wildcard 全档+exact 档，
  秒×条数）、缺价拒绝（维度具名）、版本锁定断言（overlay 后的 dims/rate 由
  caller 传入 locked 版本、模块自读价格）、提交门禁 spy（reserve/dispatch 计数）。

验证：`bun test server/tests/video-pricing.test.ts`；`bun run --filter server typecheck`；
`cd bifrost/framework/jobaccounting && go test ./...`（子模块只读回归）；`bunx biome lint
--error-on-warnings <changed>`。

### T2 = #338 B19.2 未定价视频规格不可用（依赖 T1）

owned_files（新增）：`server/src/billing/video-spec-availability.ts`；（叠加）
`server/tests/capability-availability.test.ts` 新增 video describe 块。

- `summarizeVideoSpecAvailability({snapshots})`：视频 cell × 调用方式
  （generation / edit-remix），state ∈ enabled|free|unmapped|price_unknown，
  missingDimensions 具名（video / video_input + reason）；同模型不同规格组合断言
  （Resume hint：模型+规格+调用方式，非整族开关）。
- 强制调用未定价规格：T1 门禁 enablement stage 短路拒绝，reasonCode 指维度；
  测试断言无预留/无台账写入、dispatch spy=0、补价后同判定翻转为 enabled。

验证：`bun test server/tests/capability-availability.test.ts`；typecheck；jobaccounting
go test；biome lint。

### T3 = #339 B19.3 视频编辑/变体规格计价（依赖 T1；产出 video_input 维度）

owned_files（新增）：`server/drizzle/0202_video_input_dimension.sql`、
`server/src/billing/video-edit-pricing.ts`、`server/tests/video-edit-pricing.test.ts`；
（修改）`server/src/gateway/price-snapshot.ts`（词汇表+1）、
`server/drizzle/meta/_journal.json`（idx 202）、（机械跟随）~40 个测试 fixture 文件补
`video_input` 键。

- 迁移 0202：`valid_gateway_price_dims` 15 键重拼（0195 同款）；纯新增，无回填。
- `videoEditSpecOf`：输出侧沿 19.1 卫兵；输入侧每个输入视频时长必须可确定
  （正整秒；不可确定→`video_input_spec_indeterminable` 拒绝，不用估算）；
  requestType ∈ edit|remix。
- `assessVideoEditEnablement`：tier 价 + `video_input` known（unknown→拒绝具名维度；
  "0"=明确免费留证据）；数量 `{video: seconds×outputCount, video_input: Σ输入秒}`；
  与生成共用同一换算/提交/结算语义（语义一致性断言）。

验证：`bun test server/tests/video-edit-pricing.test.ts`；typecheck（含全部 fixture
补键后零新增错误）；受影响 Go module go test；biome lint；迁移对 bf17 库实跑。

### T4 = #340 B19.4 视频异步结算恢复与产物查询（依赖 T3；组 19 缝合点）

owned_files（新增）：`server/src/billing/video-settlement.ts`、
`server/tests/video-settlement-recovery.integration.test.ts`。

- `videoTerminalUsageOf(report)`：真实终态 usage 换算纯函数——provider 终态报告的
  计费秒数（completed=实际秒数×条数 + 输入秒；failed=0 计费、完整结算语义沿
  上游 Settler"失败计价为真实零价"；时长不可读→不可结算）。
- 结算 lane：组装 17.6 `settleTerminal`（poll/notification 双 lane 收敛、一次结算、
  over-cap 审计沿 17.6）；未用额度随 settle 释放。
- 产物查询 `createVideoArtifactQueryService`：17.4 同款只读纪律——SELECT-only、
  ownership-scoped（grant→payer）、无 money seam；重复查询不触发第二次结算
  （断言 settle triggers 计数不变、台账不变）。
- 恢复：dispatch 丢失 → 沿 17.3（markUnknown 全额占用 + providerJobId 找回答 attach）；
  终态不可查 → 保持预留 unknown；重启后不重复派发/不重复扣费（同 submitIdempotencyKey
  重放答同一 job、dispatch 计数不增、结算幂等）——集成测试用真实 PostgreSQL。

验证：`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/bf17 bun test
server/tests/video-settlement-recovery.integration.test.ts`；
`cd bifrost/framework/jobaccounting && go test -run Video ./...` 与 `go test ./...`；
typecheck；biome lint。

## 共同约束（摘自票面 Global constraints）

- 付款账户服务端解析固定；拒绝路径零账务写入；未确认结果预留不释放；unknown≠free；
  计价全维+可强制上限；结算幂等不重扣；provider fake 仅测试。
- 测试登记：新测试经 `node scripts/e2e-add-driven.mjs` 登记 + `node
  scripts/e2e-coverage-audit.mjs` 审计 no gaps。
- 已知基线红（bootstrap-local-gateway typecheck 等）不修不报；`.archive/`、
  `server/src/mastra/**` 不改（本轮仅新增 run 目录）。
