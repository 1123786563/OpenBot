# Hindsight 个人记忆集成 实施计划（Wave 0–1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 Spec #376 与 19 张子 Ticket 实施 Hindsight 个人记忆集成；本文件详述当前解锁波次（#377、#380、#378），后续波次在解锁时按 `docs/plans/2026-10-15-hindsight-personal-memory/dag.json` 展开。

**Architecture:** OpenBot 保持候选/审核/原文/来源/权限/生效时间/遗忘的权威；Hindsight 是模块内部的索引与检索适配器。个人记忆模块对 Bot 只暴露"提出候选、审核、召回已确认、更正、遗忘、看依据"业务 seam；bank/文档 ID/同步/降级留在内部。

**Tech Stack:** Bun + TypeScript + Drizzle（PostgreSQL）、AG-UI middleware（Bot 运行时）、自托管 Hindsight（固定版本，docker 部署）、已批准模型网关。

## Global Constraints

- 事实源：`docs/specs/2026-10-15-hindsight-personal-memory-design.md`、`docs/adr/0005-self-hosted-hindsight-for-personal-memory.md`、`CONTEXT.md`「个人记忆」术语、Issue 正文（快照在 `archive/plans/hindsight-personal-memory/issue-snapshots/`）。冲突时以 Spec 为准。
- 无提交授权：所有任务产出未提交检查点（HEAD + diff + 未跟踪文件 + 哈希）；禁止 commit/push/merge/部署/生产迁移。
- 数据库测试用专用 PostgreSQL（`TEST_DATABASE_URL` 模式，参照 `server/tests/billing-store.integration.test.ts` 的 gate 写法）；skip 不算通过；不指生产数据。
- 未审核候选（`reviewState='unreviewed'`）在任何跨会话召回路径不可见：网页/频道/定时任务/本地 SQL 降级/Hindsight 可用时全部一致。
- tag 不作安全隔离；客户端不能选择 bank；Hindsight 命中进 Bot 前必须从 OpenBot 重读核对。
- 权威边界：OpenBot 保存候选、审核状态、原文、来源、权限、生效时间、遗忘与清理状态；Hindsight 只做索引/检索/排序/待审核判断线索。
- 测试断言观察用户可见行为与 Bot 实际收到内容，不断言 bank 命名或 SQL 形状。

## 现状基线（coordinator 已核验，worker 接手时复核）

- `server/src/memory/store.ts` 约 300–340 行：Bot 侧召回查询（`listForAgent`，供 `ingestion.recall` 与 `PersonalMemoryMiddleware` load 使用）过滤 `ownerUserId + enabled + deletedAt IS NULL + formedBy 可见性`，**缺 `reviewState IN ('confirmed','edited')`**——未审核候选当前可进 Bot 上下文，这是 #377 的核心缺口。
- `mirrorEligible`（store.ts:55）已有 `reviewState IN ('confirmed','edited')`，仅用于 Intelligence 镜像，不是召回门槛。
- `store.create()`（用户明确"请记住"路径）直接 `reviewState: "confirmed"`——#377 需守住"只保存明确表述、不扩写"。
- `personal_memories` 表无公司/租户归属列（#82 范围，本波不添加公司列，不做越权测试中需要公司维度的部分）。
- 测试先例：`server/tests/memory-store.integration.test.ts`、`memory-runtime.test.ts`、`memory.test.ts`、`memory-intelligence.integration.test.ts`。

---

### Task 1 (#377)：候选审核与召回门槛

**Files:**
- Modify: `server/src/memory/store.ts`（召回查询加门槛；`formMemory`/`create` 行为守住）
- Modify: `server/src/memory/ingestion.ts`（`recall` 汇总路径若绕过 store 查询，同样加门槛）
- Modify: `server/src/memory/tools.ts`（`recall_personal_memory` 工具描述更新："current enabled memories" → 已确认记忆）
- Test: `server/tests/memory-store.integration.test.ts`（扩展）、`server/tests/memory-runtime.test.ts`（扩展）

**Interfaces:**
- Consumes: 现有 `MemoryStore`、`MemoryIngestion.recall(ownerUserId, agentId, search?)`、`PersonalMemoryMiddleware`
- Produces: 所有 Bot 侧召回（`recall` 工具、middleware 注入、频道/定时路径共用 seam）统一只返回 `reviewState IN ('confirmed','edited') AND enabled AND deletedAt IS NULL` 的记录；后续 #382/#385/#392 在此 seam 上叠加语义检索/降级/暂停开关。候选列表（本人 UI 可见）保持返回全部未删除记录。

- [ ] **Step 1: 写失败测试**——在 `memory-store.integration.test.ts` 增加：插入一条 `unreviewed` Bot 形成候选 + 一条 `confirmed` 记录；断言本人 `list()` 两条都可见、`listForAgent`/`recall` 只见 confirmed。在 `memory-runtime.test.ts` 增加：`PersonalMemoryMiddleware` 注入的 system 内容不含未审核候选文本；`recall_personal_memory` 工具结果不含未审核候选。
- [ ] **Step 2: 运行确认失败**——`bun test server/tests/memory-store.integration.test.ts server/tests/memory-runtime.test.ts`（`TEST_DATABASE_URL` 指专用库），集成用例期望因未审核候选泄漏而 FAIL。
- [ ] **Step 3: 最小实现**——`store.ts` 召回查询（`listForAgent` 及同路径的 `personOrSource` 分支）追加 `inArray(personalMemories.reviewState, ["confirmed", "edited"])`；核对 `ingestion.recall` 的 Intelligence 合并路径：Intelligence-only 记录（`formedBy='intelligence'`）在本票不新增放行，维持现状映射到 `intelligenceOnly()` 已有逻辑；`create()` 拒绝扩写：仅保存 `memoryInputSchema` 已验证的 `content` 原文（现状已如此，加回归测试锁住）。
- [ ] **Step 4: 运行确认通过**——同 Step 2 命令，期望 PASS；另跑 `bun test server/tests/memory.test.ts server/tests/memory-intelligence.integration.test.ts server/tests/memory-shared-source.test.ts` 确认无回归。
- [ ] **Step 5: 类型检查**——`bunx tsc --noEmit`（或仓库现有 typecheck script）。
- [ ] **Step 6: 未提交检查点**——记录 HEAD、`git diff` 全文、新增未跟踪测试文件内容与 sha256、测试输出到报告路径。

### Task 2 (#380)：自托管 Hindsight 服务与隐私配置

**Files:**
- Create: `deploy/hindsight/docker-compose.yml`（固定版本镜像 tag + 明确 `restart`/网络；不映射控制台到公网）
- Create: `deploy/hindsight/hindsight.config.toml`（隐私显式配置：模型调用含内容追踪关闭、已结束操作载荷保留 1 天、受控备份 ≤30 天、模型端点指向 OpenBot 已批准网关）
- Create: `server/src/hindsight/config.ts`（配置 schema + 环境变量读取 `HINDSIGHT_*`，含合规校验）
- Create: `server/src/hindsight/health.ts`（三态健康检查：service-up / gateway-down / config-noncompliant；不返回记忆内容）
- Test: `server/tests/hindsight-config.test.ts`（新；配置解析与合规校验单测）

**Interfaces:**
- Consumes: 仓库现有模型网关配置（先在 `server/src/config.ts`、`copilot.ts`、`intelligence-client.ts` 中定位"已批准网关"的现有形态并复用其 base URL/鉴权来源；不新开辟模型调用路径）
- Produces: `loadHindsightConfig(): HindsightConfig`、`checkHindsightHealth(config): Promise<HealthStatus>`，供 #381/#384/#393 复用；`deploy/hindsight/` 部署配方供后续真实实例验证。

- [ ] **Step 1: 定位网关现状**——读 `server/src/config.ts` 等文件，记录已批准网关的配置变量与调用形态到报告（若与 Hindsight 需要的自定义 base URL 不兼容，报告冲突，不擅自改网关）。
- [ ] **Step 2: 真实部署验证**——`docker compose -f deploy/hindsight/docker-compose.yml up -d`（固定版本）；记录镜像 digest、版本响应、配置生效证据（Hindsight `/config` 或等价读取端点）；运行一次经网关的调用与三态健康检查（停网关/改坏配置各验证一次）；全部证据（命令、响应、时间）写入报告。失败则按 Hindsight 官方文档调整配置后重试，不降低验收。
- [ ] **Step 3: 写失败测试**——`hindsight-config.test.ts`：缺隐私配置→解析为 noncompliant；追踪开启→noncompliant；载荷保留 >1 天或备份 >30 天→noncompliant；合法样例→ok。
- [ ] **Step 4: 实现并确认通过**——实现 `config.ts`/`health.ts`；`bun test server/tests/hindsight-config.test.ts` PASS；健康检查对真实实例返回三态证据。
- [ ] **Step 5: 未提交检查点**——同 Task 1 Step 6。

### Task 3 (#378)：敏感候选与过期清理（#377 verified + 集成后解锁）

**Files:**
- Create: `server/src/memory/sensitivity.ts`（保守分类：credential / medical / financial / customer-data / normal；只对明确触发词/模式判敏感，不确定按 normal——分类失败保守到 normal 但凭据检测宁误拒）
- Modify: `server/src/memory/ingestion.ts` + `server/src/memory/tools.ts`（敏感类目仅明确要求时成候选；"请记住"路径对凭据拒收）
- Modify: `server/src/memory/store.ts`（`expireStaleCandidates()`：删除 `reviewState='unreviewed'` 且 `updatedAt < now-30d` 的记录；已确认/已编辑不动）
- Modify: `server/src/index.ts`（或现有定时任务注册点）：周期任务调用过期清理，幂等可重复
- Test: `server/tests/memory-sensitivity.test.ts`、`server/tests/memory-expiry.test.ts`（新）

**Interfaces:**
- Consumes: Task 1 的审核状态模型
- Produces: `classifyMemorySensitivity(content): SensitivityClass`；`expireStaleCandidates(now?): Promise<number>`；供 #388（派生判断依据排除）复用。

- [ ] **Step 1: 失败测试**——凭据内容（password/token 模式 + 明确"记住"）→ `MemoryRefusedError`；医疗/财务/客户样本自动学习不成候选、明确要求时成 `unreviewed` 候选并标记需二次确认；`expireStaleCandidates` 只删 30 天未处理 unreviewed，不动 confirmed/edited；重复运行幂等。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**（敏感候选入表时带 `sensitivity` 标记与 `requiresExtraReview`，二次确认前不可被审核确认跳过——复用 reviewState 门槛即可）→ **Step 4: 确认通过 + 回归 Task 1 测试** → **Step 5: 未提交检查点**。

---

## 后续波次（解锁时展开为详细任务）

按 `dag.json`：Wave 2 `#381`（需 #82）；Wave 3 `#382→{#383,#384,#386,#392,#393}`（需 #82）；Wave 4 `#385,#387,#394`；Wave 5 `#388,#389,#390`；Wave 6 `#391`；Wave 7 `#395`；Wave 8 `#396`（需 #6）。每波解锁条件：前置票 verified + 独立审阅通过 + 集成到执行工作区。展开时依据前置票实际交付接口（以验收结果与当前 Git 状态为准），不预写虚构接口。

## Self-Review

- 覆盖检查：#377/#378/#380 验收标准逐条映射到任务步骤 ✓；其余 16 张票在 dag.json 记录且被外部 #82/#6 阻塞（详见 ledger.md 裁决）✓。
- 占位符检查：无 TBD；后续波次为显式"解锁后展开"流程而非占位。
- 类型一致性：`SensitivityClass`、`loadHindsightConfig`、`checkHindsightHealth`、`expireStaleCandidates` 命名前后一致。
