# Bifrost bf14：#325 / #341 / #344 三票实施计划

- 工作区：`bf14` worktree（main@HEAD `73aa6d59` + 未提交前置增量至 0194）；bifrost 子模块本地克隆于 pin `ad9470a5`，零提交口径（新 Go 文件入未跟踪树）。
- 运行键：`2026-10-21-bifrost-bf14`；报告：`reports/orca-dag-wave3-bf14.md`（本 Run 的验证证据按派发约束落在 reports/，不写 `.archive/`）。
- 事实源：票面（#325/#341/#344，GitHub 1123786563/OpenBot）、父 Spec #5、ADR 0002/0003/0004/0008、前置交付（#326 的 `async_jobs`/`async-job-submit.ts`、#343 的 `credit_settlement_dimension_breakdown`、#288 的 `personal-key-isolation.ts`）。
- 幽灵标签重排：#325/#341 票面 `agent:ready-for-review` 注释宣称"已在 main"为旁支未合并交付（verify1 复核 PHANTOM），本 Run 在本树真实实施。

## 关键设计决定

1. **#325 复用 `async_jobs`，不建第二张表**。0188（#326）的表头注释明言"the dedicated ticket adopts this row rather than growing a second one"——列成员与 #325 Produces 契约逐项对应。本票交付身份读侧模块与迟到 provider 映射写侧；`attach-provider-job-id` 服务 17.3/08.x 恢复扫描。映射锚定在 OpenBot 本地侧（本地 `aj-` 身份为主键，`provider_job_id` 唯一部分索引为反向通道）；Go 侧 `TableProviderJob.ID` 保持 `ProviderJobID(kind, provider, providerJobID)` 可推导（非随机），两侧不可能漂移——以 jobaccounting 新增 identity 测试钉住该推导与再驱动不改身份。
2. **#341 新增两个闭集维度**：`surcharge_tool_call`（每次真实工具执行的按次费：MCP 工具、内置/注入工具、responses 工具）、`surcharge_a2a_call`（A2A 调用）。v1 wire 的 `Pricing` 结构（core/schemas/models.go）无对应字段 → `not_on_wire_v1` → 记 unknown（非 0），与 image_output/audio/video 同一纪律；不进入 03.3 已知/免费分类的必要集（模型可调用性不受影响）。web_search / per_request 已有维度覆盖既有供应商工具族。
3. **入口枚举以 hook 调用点反推**（Resume hint），落在 `tool-surcharge-pricing.ts` 的封闭注册表：`mcp.tool_call`、`injected.tool_call`、`injected.web_search`、`responses.tool_call`、`a2a.call`、`routing.embed`（计费走被挂模型自身的 token 维度）＋非计费入口 `mcp.connection`、`codemode.meta_tool`（main.go:1666 明言 codemode 元工具不按工具执行治理）。注册表锚点由测试钉死（seam 移动即红），供 22.1 全入口核查直接引用（同 #288 `PERSONAL_KEY_ENTRYPOINTS` 模式）。Go 侧在 governance 增同名注册表 `toolentrances.go`。
4. **#341 工具计费身份**：新表 `tool_call_charges`（0195），每次真实工具调用一行——`attempt_id`（07 语义：其预留的 `att-` 映射）为主键、入口/维度/归属（grant+payer 解析侧）/状态机（pending/charged/refused，形状 CHECK 同 realtime_units）。工具费与模型费在数据模型上可区分：surcharge_* 维度行（0189 breakdown 的 surcharge 组）+ 独立身份行。
5. **#344 准入门**：`tool-admission.ts`——个人 Key 面（grant 门）的三段拒绝：越权段（公司范围字段在场即拒 + 公司工具对个人授权拒绝，记 `billing.tool_overreach_refused` 审计）→ 计价段（`assessToolSurchargeEnablement`，缺项 unknown 即拒、无预留无结算、执行数 0，记 `billing.tool_bypass_refused`）→ 预留段（余额不足透传 reserve 拒绝）。#342 的启用门（20.2）消费本注册表与 assess；本树无 #342 交付，接缝即 assess 函数与注册表，不造假桩。
6. **迁移 0195** 一张：`valid_gateway_price_dims` 函数重拼写（required += 2）+ `tool_call_charges` 建表。#325 无新迁移。既有 14 个测试文件的 V1_AMOUNTS 型全量 dims 夹具需机械补 2 键（闭集契约变更的必然落点，同 0192 加入 ocr 能力时的先例）。

## 任务与验证

| # | 票 | owned files | 验证 |
| --- | --- | --- | --- |
| T1 | #325 | `server/src/billing/async-job-identity.ts`、`server/tests/async-job-identity.integration.test.ts`、`bifrost/framework/jobaccounting/identity_test.go`（未跟踪） | `TEST_DATABASE_URL=...bf14 bun test server/tests/async-job-identity.integration.test.ts`；`go test ./...`（jobaccounting） |
| T2 | #341 | `server/drizzle/0195_tool_surcharge_dimensions.sql`、`meta/_journal.json`、`db/schema/credit-reservations.ts`（toolCallCharges）、`gateway/price-snapshot.ts`（词汇表 +2）、`billing/tool-surcharge-pricing.ts`、`billing/tool-call-charge.ts`、`server/tests/tool-surcharge-pricing.test.ts`、14 个夹具补键 | `bun test server/tests/tool-surcharge-pricing.test.ts` + 受影响回归（price-snapshot、price-status-classification、async-submit、usage-breakdown、reserve-*、settle-* 等） |
| T3 | #344 | `billing/tool-admission.ts`、`audit.ts`（+2 事件）、`server/tests/tool-isolation.test.ts`、`bifrost/plugins/governance/toolentrances.go` + `toolbypass_test.go`（未跟踪） | `bun test server/tests/tool-isolation.test.ts`；`go test -run ToolBypass ./...` 与 `go test ./...`（governance） |
| T4 | 收尾 | e2e-add-driven 登记三测 + audit、typecheck、biome lint、报告 | `bun run --filter server typecheck`；`bunx biome lint --error-on-warnings <changed>`；`node scripts/e2e-coverage-audit.mjs` |

测试库：容器 `orca-w3-bf-pg`（127.0.0.1:5566）新建 `bf14` 库，`DATABASE_URL` 全链迁移后以 `TEST_DATABASE_URL` 跑。已知基线红不修不报；不 commit 不 push；GitHub 只读。
