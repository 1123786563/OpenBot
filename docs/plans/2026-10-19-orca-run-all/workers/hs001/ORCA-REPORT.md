# [hs001] Issue #377 候选记忆审核与召回门槛 — 执行报告

日期：2026-10-19。分支：`1123786563/hs001`，基线 HEAD `3ca32d49`（改动未提交，留在 worktree）。

## 结论

#377 的主体实现已在祖先提交 `a891698f`（2026-10-17，"feat(memory): #377 候选审核门槛与 #378 敏感候选拒绝、30 天过期清理"）落地，且召回 seam 的收紧是真实、集中、可测的：全部 Bot 侧读取收敛到 `store.retrieve → eligibleRows` 一条 SQL seam（`server/src/memory/store.ts` 中 `inArray(personalMemories.reviewState, ["confirmed","edited"])` 与 `enabled AND deletedAt IS NULL`），注入（`PersonalMemoryMiddleware`）与工具（`recall_personal_memory`）两个入口都只走它；Intelligence 镜像/派生侧由 `mirrorEligible` 同一行门槛挡住未审核候选。本会话在专用库上全量复验 13 个测试文件 146 用例全绿（0 跳过），补上本票唯一残余缺口：`remember_personal_fact` 工具描述未向模型声明「只记明确表述、不扩写」，已按 AC3 收紧（一行改动）。

## 逐条 AC 实证

### AC1 候选先成为 candidate（内容/来源/观察时间可见），审核改当前用户当前公司记录

- 自动形成：`store.formMemory` 固定 `reviewState: "unreviewed"`，`provenance` 记 `"{sourceApp} ({link}), observed {ISO}"`，`observedAt` 入列（`server/src/memory/store.ts:425-470`）。
- 导入：`completeSync` 插入不设 reviewState，列默认 `'unreviewed'`；provenance 记来源标题；`observedAt: new Date()`（`server/src/memory/store.ts:748-770`）。
- 本人可见：`store.list(ownerUserId)` 不带 reviewState 过滤，候选与其内容/来源/观察时间一起返回（`server/src/memory/store.ts:340-356`），routes `GET /api/memory` 经 `requireUser` 后仅本人。
- 审核范围：`update`/`remove` 的 WHERE 全部含 `ownerUserId = actor.id`；routes 全挂在 `requireUser` 后。测试 `facts are owner scoped on list, edit and delete`（他人 list 看不到、update/remove 抛 `MemoryNotFoundError`）。
- 「当前公司」维度：personal_memories 表当前没有公司归属列（已知现状，父 Spec #376 迁移前提与公司/团队多租户 Spec 均已记录），公司隔离由后续被本票阻塞的 #382/#392 落地；本票范围内审核作用于当前用户全部记录，跨用户不可能。

### AC2 未审核候选在全部召回路径不可见，也不进入派生判断

单点 seam 证据（所有路径汇于一条查询）：
- SQL/本地降级：`eligibleRows` 过滤 `reviewState IN ('confirmed','edited') AND enabled AND deletedAt IS NULL`（`server/src/memory/store.ts:316-320`）。无 Intelligence 时 `retrieve` 直接返回它（"tables are the whole store"）。
- 原 Bot / 其他 Bot：`formedByThisBot` 与 `personOrSource` 两个分支都叠加在同一个 reviewState 过滤上（`server/src/memory/store.ts:294-322`）。
- 网页/频道/定时任务：所有表面（AG-UI `copilot.ts:2559` 的 `PersonalMemoryMiddleware`、`agent-resolver.ts:165` 的注入、`loadToolsForActor` 的 recall 工具）都经 `ingestion.contextFor`/`ingestion.recall` → `store.retrieve`，无第二条读取路径（全仓 `personalMemories` 只有 `memory/store.ts`、`agents/lifecycle-reset.ts`（删 Bot 清数据）与 schema 引用）。
- 派生判断（当前唯一派生引擎 = CopilotKit Intelligence）：`mirrorEligible` 与 `eligibleRows` 同一行门槛，未审核行永不镜像，也就永不参与 Intelligence 语义召回/综合；Hindsight 服务（#380）目前仅 config/health，不读个人记忆。
- 测试：`an unreviewed candidate is invisible to every Bot-side recall path until confirmed`（覆盖 list 可见 vs retrieve/recall/contextFor 不可见 → 确认后全通 → 删除后再次全断）；`the Bot's injected memory context and recall tool carry no unreviewed candidate`（middleware 注入报文与工具返回双双断言）；`an imported fact waits for the person's confirmation before any Bot recalls it`；`a Bot-formed memory reaches Intelligence only once the person confirms it`（派生侧）；`not entitled: ... the tables are the whole store`（SQL 降级）。

### AC3 「记住」只确认明确表述；拒绝/删除的候选不再召回

- 服务端逐字：`store.create` 对 normal 敏感度直接 `reviewState: "confirmed"`、内容原样一行入库，无任何扩写逻辑；测试 `'remember' confirms exactly the person's explicit statement, word for word`（content 逐字、恰好 +1 行）与 `the remember tool stores only the person's explicit statement`（工具层只透传一次调用）。
- 模型侧契约（本会话收紧）：`remember_personal_fact` 描述补上 "exactly as they stated it — add nothing they did not say"（`server/src/memory/tools.ts:114`），AC3 的「不扩写」现在在服务端与模型侧两层都有明文约束。
- 拒绝/删除：`remove` 置 tombstone（`deletedAt`、`enabled: false`、`content: ""`）；`formMemory` 去重查询含已删行，同内容再观察返回 `forgotten: true` 不复活；`completeSync` 冲突更新对 `deletedAt IS NOT NULL` 的行保留原内容。测试：`forget removes manual facts immediately`、`deleted imported fact cannot resurrect during the next sync`、`Bot-formed memories carry provenance, await review, and never come back once forgotten`（proactive-store.integration）。

## 命令与输出摘要

专用库（保留未删）：`pgvector/pgvector:pg16` 容器 `orca-all-hs001-pg`，端口 5560，库 hs001。说明：票面给的 `postgres:16` 镜像不含 vector 扩展，server 迁移 `CREATE EXTENSION vector` 直接失败，故换 pgvector 同版本镜像重建同名容器；迁移前先以超户执行 `server/ops/enterprise/roles.sql`（角色前置检查要求）。

1. 迁移：`DATABASE_URL=postgres://postgres:postgres@localhost:5560/hs001 bun server/scripts/migrate.ts` → `{"type":"migrations-applied","status":"ok"}`（161 个迁移）。
2. Bun 套件（bun-test-compat，5 文件）：`TEST_DATABASE_URL=... bun test ./tests/memory-{defaults.integration,expiry,intelligence.integration,sensitivity,store.integration}.test.ts`（server/ 下）→ **56 pass / 0 fail / 263 expect()**。
3. e2e 原生套件（e2e-compat，8 文件，tools-only unit config）：`TEST_DATABASE_URL=... bun run test -- server/tests/{memory,memory-default-source-tool,memory-runtime,memory-shared-source,intelligence-memory,openmuse-memories,hindsight-config,hindsight-health}.test.ts`（仓库根）→ **8 files passed, 90 passed (90)**。
4. 合计 13 文件 146 用例全绿；无跳过被计为通过（两层制见 ADR 0008：Bun 套件由 bun 执行、e2e-compat 套件由 e2e/Node 执行，混跑会假失败，本次已分流）。
5. 类型检查：`cd server && bun run build`（tsc --noEmit）→ 无输出，通过。

## 改动文件

- `server/src/memory/tools.ts`（1 行）：`remember_personal_fact` 描述补「逐字、不扩写」。
- `ORCA-REPORT.md`（本文件）。

`git status --short`：` M server/src/memory/tools.ts`（另有本报告为未跟踪文件，见下）。

## 遗留

- 「当前公司」审核范围依赖公司归属列迁移（多租户），属 #382/#392（被本票阻塞）；本票以 ownerUserId 收紧到位。
- Hindsight 侧派生判断（观察→待审核判断）在 #383+ 才接入；当前派生引擎仅 Intelligence，已由 mirrorEligible 门槛覆盖并测试。
- #378 的敏感/过期部分虽与 a891698f 同提交落地，本报告只按 #377 三条 AC 验证（其自身套件 sensitivity/expiry 一并跑绿，未按 #378 AC 逐条复核）。
