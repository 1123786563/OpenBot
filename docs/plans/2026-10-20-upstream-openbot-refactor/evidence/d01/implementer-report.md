# D01 实施报告：非阻断的启动诊断适配（AC A09 / #497）

- 执行者：backend_implementer。工作区：`.worktrees/upstream-openbot-update`（未提交树，无 commit/push）。
- 日期：2026-10-20。TDD 流程：RED（收集期模块缺失失败）→ GREEN → 验证。

## 1. 改动摘要

| 文件 | 变更 | 内容 |
|---|---|---|
| `server/src/model-availability-check.ts` | 新建（222 行） | `StartupCheckResult`（I5 指定放此）、`checkModelAvailability`、`officialModelMetadataLookup`、共享 3s 预算内核 `runWithStartupBudget` |
| `server/src/intelligence-entitlement-check.ts` | 新建（约 200 行） | `reportIntelligenceEntitlement`、`EntitlementRead`、装配 seam `scheduleStartupDiagnostics` |
| `server/tests/model-availability-check.test.ts` | 新建 | 21 条（13 个 test 声明，含 3 组 test.each） |
| `server/tests/intelligence-entitlement-check.test.ts` | 新建 | 14 条（含 4 条 scheduler 装配用例） |
| `server/src/index.ts` | 修改 | **+54 / −0，纯追加**：2 条 import + 1 处 fire-and-forget 装配（置于 `selfHostBannerIntelligence` 创建之后，行 ~4172；全部依赖——`log`:630、`learningCanCreate`:~845、`credentialStore`:939、`runtimeModel`/`resolveRuntimeModelApiKey`:~2061–2100——均在其上方作用域内） |

未触碰 owned_files 之外任何文件；未删任何 untracked 文件；未用 git stash/commit/push；未派发子 Agent。

## 2. I5 合约对照

- `StartupCheckResult`：`kind: 'available'|'skipped'|'warning'` + 可选 `code`（七值枚举与合约逐一对应）+ 可选 `message`。放在 model-availability-check.ts，entitlement 文件 type-import。✔
- `checkModelAvailability(options: { enabled, model, lookup?, log })`：签名逐参数一致。✔
- `reportIntelligenceEntitlement(options: { enabled, read?, log })`：签名逐参数一致。✔
- 参数注入：配置（enabled/model 名）、只读探测 seam（lookup/read）、日志函数全部注入；两个函数 resolve either way、**从不 reject、从不抛**（含 seam 同步 throw、sever 永不 settle、log sink throw 的用例）。✔
- 统一单次预算 3,000ms（`STARTUP_CHECK_BUDGET_MS`，一处定义两处消费）；deadline 先 `controller.abort()`（真正取消支持取消的请求），race 只是第二道防线（seam 无视 abort 时 check 仍在预算内回答 timeout）；无重试、无后台轮询。**不是**"只用 Promise.race 让请求悬挂"。✔
- 只报告一次：每项检查至多一条 log（仅 warning 才 log，沿用上游"skipped 留白"行为：缺 key/不支持的管理员可能正要补配）。✔
- 不把供应商原始响应记录：`officialModelMetadataLookup` 从不读 response body（测试以会 throw 的 json()/text() 钉死），只有 `{status}` 出闭包；message 为固定句式，至多内插 status 数字与 model 名（tenant package 配置，非秘密）。✔

## 3. 分类矩阵（fake 注入证据，全部真实执行）

**checkModelAvailability（21 条通过）**

| 输入（fake seam） | 期望分类 | 测试 |
|---|---|---|
| `enabled:false`（缺 key） | `skipped/unconfigured`，不探测、不 log | "a deployment with no model credential is skipped…" |
| `enabled:true` 无 `lookup`（兼容 endpoint） | `skipped/unsupported`，不 log | "a compatible endpoint with no lookup…" |
| lookup → 200/204/299 | `available`，不 log | test.each |
| lookup → 401 / 403 | `warning/credential-rejected`，log 恰一次且与返回值同一对象 | test.each |
| lookup → 404（官方 model API） | `warning/model-unavailable`，log 一次 | "a 404 from the official model API…" |
| lookup → 302/500/503 | `warning/unreadable`，log 一次 | test.each |
| lookup reject / 同步 throw | `warning/unreadable`，check 仍 resolve，log 一次 | 2 条 |
| 预算内应答（2999ms 后 404，fake 时钟） | 正常分类而非 timeout | "still inside the budget…" |
| 挂起请求 >3000ms（fake 时钟） | `warning/timeout`，**signal.aborted === true**，log 一次 | "the budget aborts a hanging request…" |
| 无视 abort 永不 settle | 仍在预算内回答 `timeout`（不悬挂 boot） | "a lookup that ignores the abort…" |
| 日志安全 | 序列化后不含 fake key/`authorization`/`x-api-key`/`https://` | "no logged line carries…" |

**reportIntelligenceEntitlement（10 条）**：`enabled:false`→`skipped/unconfigured` 且零探测；无 `read`→`skipped/unsupported`；`{active:true}`→`available` 不 log；`{active:false}`→`warning/entitlement-unavailable` log 一次；read reject→`entitlement-unavailable`；非布尔 active→`unreadable`；>3000ms→`timeout` 且 aborted；无视 abort→仍 timeout；日志安全同上。

**scheduleStartupDiagnostics（4 条装配用例）**：调用方先于两个 check 完成拿到返回（两 probe 未决期间后续语句继续执行）；model factory 同步 throw / 异步 reject 都不逃逸且**不挡** entitlement 侧（各恰一次报告）；每次启动每 check 至多探测一次；log sink throw 被 containment 吞掉。

**officialModelMetadataLookup（4 条）**：openai → `https://api.openai.com/v1/models/{enc(model)}` + `authorization: Bearer`；anthropic → 同形 + `x-api-key` + `anthropic-version`，无 authorization；`init.signal` 与传入 signal 同一对象；model 名 encodeURIComponent；body 永不读。

## 4. 装配接线与非阻断证明

**接线（index.ts 追加块）**：
- model：`enabled` = 部署可解析出模型凭据（走与 intent router / skill 选择完全相同的 `resolveRuntimeModelApiKey()`：credential store → env provider key）；解析为空 → `enabled:false`→skipped/unconfigured。设置了 `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL`（normalizeModelBaseUrls 已在此前剥离空值）→ 有 `enabled` 无 `lookup` → skipped/unsupported。仅直连官方路径提供 `officialModelMetadataLookup`。
- entitlement：`enabled` = `learningCanCreate`（`learningApiOrigin && (learningSetup || cliLoginPresent)`，index.ts:~845）——本地 Learning 依赖"实际启用"的真实条件；`read` = `selfHostBannerIntelligence.getRuntimeEntitlements()`（banner 同一 client，构造不打开连接），`status!=='ready'` 时以固定词表错误抛出（只含 closed-vocabulary status），落为 `entitlement-unavailable`。
- log：仅 warning 时 `log.warn({ diagnostic, ...result }, "startup diagnostic")`——字段全为固定句式/枚举。

**非阻断**：调度函数返回 `void` 且**先于两 check 完成返回**（有测试钉住）；factory 同步 throw 不抛出调度器（有测试）；log sink throw 被 containment（有测试）；index.ts **零新增 top-level await**（diff +54/−0 纯追加）。诚实记录的限制：本仓库没有以测试方式启动 `server/src/index.ts` 的既有 harness（现有套件走 `app.ts`/`createApp`），因此"真实进程整机组启动冒烟"未执行——以装配 seam 行为证据 + 零 await diff 替代，不做"启动成功"的伪造声明。

## 5. 边界（Spec §6 / up09）

- 模型探测只走供应商官方 metadata 端点（metadata 读，非推理调用，零 token 计费）；不旁路任何虚拟 Key；凭据只在 lookup 闭包内。
- 网关目录（gateway/catalog.ts 的 `GET /v1/models` 同步读）**未**作为 lookup 接入：它是业务路径（写 snapshot 行、受 01.7 readiness gate 门控），重拨会复制或绕过该门；I5 的 status-only 合约也无法表达目录成员判断。按 brief"无合法探测接口则 skipped"处理，`skipped/unsupported` 的 message 明确说明兼容端点 404 不判定模型不存在。
- 未启用 Learning 的部署：`enabled:false`，诊断根本不探测，契约零变化；Hindsight/普通聊天不依赖也不等待该诊断。
- 诊断不是授权事实、不是第二 readiness 权威：返回值在装配处被丢弃，仅 log。

## 6. 归层对账（ADR 0008）

- 两个 suite 实际 import：`tests/support/e2e-compat` + 两个新纯模块（无 bun 运行时依赖）→ **e2e native（Node）层**。
- 执行：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/model-availability-check.test.ts server/tests/intelligence-entitlement-check.test.ts` → **2 files / 35 tests 全绿**。
- 对账：`bun scripts/e2e-coverage-audit.mjs` → exit 0，"no gaps"（1059 files · 566 native · 478 driven · 9 engine · 6 named exclusions）。新 suite 不进 `docs/verification/e2e-bun-suites.json`（该清单仅收 Bun 运行时 driven 套件，本两件不属此类）。

## 7. format / typecheck

- `bunx biome format` 五个改动文件逐一 **exit 0**（最终态复验）。新 4 文件 `biome check` exit 0（organizeImports 已修）；`index.ts` 的 6 项 check 发现经 HEAD 副本同配置对照**全部为 BASE 既有**（noConsole×3、organizeImports、noUnusedImports、noNonNullAssertion，行号均在既有代码区），本 diff 新增 0。
- `bun run --filter server typecheck`：仅剩预登记的 bootstrap BASE 红（`scripts/bootstrap-local-gateway.ts:106/108/120` TS2339，与 ledger V01 预登记同一处、同一组），**无任何新增错误**。

## 8. 偏差与记录

1. **超出 I5 两函数的导出**：`STARTUP_CHECK_BUDGET_MS`、`runWithStartupBudget`、`officialModelMetadataLookup`、`EntitlementRead`、`scheduleStartupDiagnostics`。理由：3s 预算单点定义；凭据构造留在诊断文件内不进 index.ts；装配 seam 可测才能给出诚实的非阻断证据。两函数签名与合约逐字一致，无合约变更。
2. **本地事实**：brief 称"Learning/Intelligence 是可选依赖"；本地 `config.ts` 实际在 boot **强制** Intelligence（缺失即拒启）。故"未启用 Intelligence 的部署契约不变"在本地为空真，探测门控落在真实可选件 Learning（learningCanCreate）上——这正是 Spec"配置沿用本地真实条件"的要求，非冲突，不升级。
3. **SDK 限制**：`getRuntimeEntitlements()` 类型不接受 AbortSignal（SDK d.ts 证实）。signal 仍按合约传入 seam；3s 预算由 check 兜底；SDK 读为单次共享/缓存请求（30s/5s TTL），非无限、非重试请求——"不遗留无限网络请求"成立，取消保证在支持取消的传输（模型 fetch 与全部 fake seam）上完整成立。
4. **网关 metadata 未接入 lookup**（见 §5）：按 brief 的"诚实优先于覆盖率"裁决，本地对网关部署产 `skipped/unsupported` 而非虚拟探测。
5. 真实进程整机启动冒烟未执行（无既有 harness，见 §4）——validator 如需该项须另行提供启动环境。

## 9. 证据文件

- 新 suite：`server/tests/model-availability-check.test.ts`、`server/tests/intelligence-entitlement-check.test.ts`
- 新源码：`server/src/model-availability-check.ts`、`server/src/intelligence-entitlement-check.ts`
- 接线 diff：`git diff server/src/index.ts`（+54/−0）
- 测试报告目录：`.e2e/unit/results/`（e2e run 产物）
