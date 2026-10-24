# Issue #459 插件包与市场 V1 实施计划（2026-10-24 Run）

> **执行方式：** 本计划由 Orca 多 Agent Run `run_c02325ef9e57` 执行；主编排者按 Task 顺序/波次派发，Superpowers `writing-plans`/`subagent-driven-development` 不在本会话可用技能列表，按仓库 `execution.md` 规定的标准头、Global Constraints、Review Focus、Task 编号手工编制（已披露）。
> **进度标记：** 用 `- [ ]` / `- [x]` 记录 Task 内步骤；Task 状态只以 Ledger（`.archive/runs/2026-10-24-issue-459/ledger.md`）为准。

**Goal:** 在既有插件包内核（PKG01–04 已交付）上完成 V1 剩余闭环：受管工具派发（PKG05）、版本升级/回滚（PKG06）、停用/卸载/重装（PKG07）、部署侧下架/撤回（PKG08）、审批与后台入口原范围（PKG09）、未知效果核对（PKG10）、存量迁移与灰度（PKG11）、首发验收（PKG12）。

**Architecture:** 不可变制品 + 文件市场索引（`plugins/marketplace.json` + 内容寻址 `plugins/.artifacts`）作为发布事实；范围安装/修订/计划/grant/Run pin 在 `enterprise_package_*` 表由 `PackageMutationStore`（operator 受限通道）写入；运行侧由 `PackageRuntime.prepareWithin` 在同一 Run 写事务固定 pin；新增 `enterprise_package_dispatches` 作为派发线性化点，并经既有 `authorizeToolInvocation` 逐次重验；所有 HTTP 经 `server/src/enterprise/plugin-packages/routes.ts`，Web 经 `app/src/lib/plugin-packages/*` + `app/src/components/market/*`。

**Tech Stack:** TypeScript、Bun/Hono、Zod、Drizzle/PostgreSQL（受限角色 RLS）、React/TanStack Query、既有 MCP/OpenConnector/Composio transport；tester-army e2e（ADR 0008）为统一测试入口。

**Spec / 事实源:** 已批准 Spec v0.2（#459 正文快照 = `docs/specs/2026-10-19-plugin-package-marketplace-design.md`）；ADR 0004/0006/0008；根 `CONTEXT.md`；正式子 Issue #460–#471；原技术参考 `docs/plans/plugin-marketplace/2026-10-19-plugin-package-marketplace-implementation.md`（T1–T10 已被 Issue DAG 取代）。ADR 0007 未批准，Personal Space 不在 V1。

**本轮用户决定（D1–D7，2026-10-24）：** D1 批准 Spec v0.2；D2=A 既有 PKG01–04 按基线接受（差额复审+复验）；D3 archive#34 在树交付+复验为 PKG05 前置；D4 BASE=本地 main `b117c3c3e`，#459 合并排后并做接口重核对；D5 授权任务分支本地提交；D6 实施 claude / 独立审核 claude / 终审 codex；D7 允许本地 commit+合入集成分支+文档写入，禁止 push、GitHub 写入、关票、生产迁移、部署。

## Global Constraints

- **BASE/集成分支**：原始 BASE `main b117c3c3e23f933f7ff025b7170a5314f239b504`；集成分支 `1123786563/issue-459-integration`；集成 Worktree `/Users/wuyongjun/orca/workspaces/OpenBot/issue-459-integration`。任务分支一律从集成分支当前已验证 HEAD 派生。
- **提交策略（D5）**：实现者可在任务分支按 Task 提交（真实 BASE..HEAD 供 Review）；禁止 push/合并到 main。集成由主编排者在集成 Worktree 串行执行；`git merge` 冲突或审核范围外改动需新检查点+独立复审。
- **产品约束**：schemaVersion=1、platformApi=1；manifest ≤64 KiB、资源 ≤256、普通文件 ≤512、总包 ≤16 MiB、单文本 ≤1 MiB；plan 有效期 10 分钟；配置 ≤32 个平面非秘密字段；分页默认 20 上限 100；V1 部署开关默认关闭；不新增 npm 依赖；迁移编号实施时串行分配（migrate-test 任务 id/步骤）。
- **权限红线**：包不存 token、不运行安装脚本、不解释任意 MCP URL；不接受 scope/账号/版本/legacy 回退；包来源 grant 与 legacy `plugin_grants` 不得 OR 放行；平台管理员不自动获得公司管理权；包内资源不得经"已安装"获得工具权限。
- **运行语义**：dispatch 前必须以 `dispatched` CAS 为线性化点；已 dispatched 的外部效果不得因撤权/停用丢失；写超时/崩溃记 unknown 不自动重发；绝不以 skip、零测试、收集失败、空报告记通过。
- **证据**：每 Task 在 Brief/Ledger 记录预期/实际 Orca Agent 身份、worktree、BASE/HEAD、验证命令与退出码、独立审核 SPEC/QUALITY 结论、finding 裁决；长日志进 `.archive/runs/2026-10-24-issue-459/`。
- **范围**：只做 V1 团队受信包；Personal Space、缺执行范围的逻辑私有 Bot 多范围执行、外部格式导入、任意可执行插件不宣称支持。

## Review Focus

1. **派发竞态**：撤权/停用/撤回与 dispatch 并发，线性化点唯一；先停用则网络 0 次，先 dispatched 则回执保留；写超时/崩溃 unknown 不重发（T05/T07/T08/T10）。
2. **范围与身份**：伪造 installId/planId、跨租户同形响应、平台 vs 公司管理员、发布者/他人连接借用均拒绝；秘密不进目录/预览/日志/模型（T05/T06/T09/T11）。
3. **版本 pin 与升级边界**：旧 Run 不吃新 Skill/工具/权限；升级/回滚不复活 grant；同名 Skill/工具不覆盖全局 slug（T06/T07/T10）。
4. **真实受限角色**：owner/部署凭据/legacy grant/默认连接不得成为回退；跨范围 FK/RLS/成员失效在真实 `ob_ent_*` 角色下验证（T00/T05/T07/T08/T11）。
5. **入口完整性**：tools、直接 call、内部 call、审批恢复、schedule/responsibility、memory ingestion 每入口有正向或明确拒绝证据；无受管 Run 返回 PACKAGE_RUN_REQUIRED（T09）。
6. **基线漂移**：BASE 已跨 2026-10-23 合并波 + 上游同步；既有 PKG01–04 在 BASE 上无合并后复验记录，T00 必须先建立 BASE 绿/红清单，历史基线红不得计为回归（T00、T01–T04）。

---

## 执行模型（Orca）

- Run：`run_c02325ef9e57`；协调者为本会话。任务 Worktree 上限 K=4（本计划最大并行 2，按文件所有权而非上限决定）。
- 派发：`orca orchestration worker-start --spec "<Brief>" --worktree new-top-level --name <task-key> --repo id:d6edf033-748a-4549-ae5a-e9efd34cef91 --base-branch 1123786563/issue-459-integration --agent claude --surface terminal --json`；回执记录 dispatch/handle/实际 agent。
- 审核：实现结束后停止写入并结算 Dispatch，`orca agent launch --agent claude --worktree id:<task-worktree> --prompt "<review brief>" --json` 启动**新的独立审核会话**（同一检查点，SPEC+QUALITY 两结论）。有效 finding 交回原实现 Agent 整改，新检查点复审；单 Task 最多 5 轮，第 4–5 轮升级一档。
- 集成：独立审核通过的提交由主编排者在集成 Worktree `git merge --no-ff`；跑组合验证；再清理任务 Worktree/分支（`orca worktree rm --worktree id:<...>`，先核对已合并且无有效会话）。
- 终审：全部 Task verified 后，`orca agent launch --agent codex --worktree id:<integration> --prompt "<final review brief>"`；通过后主编排者跑一次完整范围 OCR（`ocr review --audience agent --from b117c3c3e --to <HEAD> --output .archive/.../ocr/final.json`，含未提交交付时用 workspace 模式）。
- 检查点：每 Task 记录 before/after HEAD、`git diff` 增量清单、测试退出码与用例数、审核报告路径。

## 波次（K≤4；真实业务依赖见 dag.json）

| Wave | Task | 内容 | 放行条件 |
| --- | --- | --- | --- |
| 0 | T00 | BASE 基线核验 + archive#33/#34 行为复验 + 接口重核对 | 批准门（已过） |
| 1 | T01–T04 ｜ T-INF | PKG01–04 差额独立复审（只读，集成 Worktree 并行）；T-INF 测试基建修复（受限角色套件可运行+e2e 分类） | T00 绿/红清单 |
| 2 | T05 | PKG05 派发与受管工具执行 | T03/T04 复审通过 + archive#34 复验 |
| 3 | T06 ∥ T09 | PKG06 升级/回滚；PKG09 审批/后台入口 | T05 verified |
| 4 | T07 ∥ T08 | PKG07 停用/卸载/重装；PKG08 下架/撤回 | T06/T09 verified（PKG07 需 T05） |
| 5 | T10 | PKG10 未知效果核对 | T09 verified |
| 6 | T11 | PKG11 迁移与灰度 | T06/T07/T08/T10 verified |
| 7 | T12 | PKG12 聚合验收 | T11 verified |
| 8 | T13 | Codex 终审 + 完整 OCR | T12 verified |

## 验证基线（ADR 0008 + testing.md）

- **native**：`E2E_UNIT_OUTPUT=.e2e/<run> bunx e2e run --config e2e.unit.config.ts <files>`；**driven**：`E2E_BUN_ONLY="server/tests/multitenancy <filter>" E2E_UNIT_OUTPUT=.e2e/<run> bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`（`E2E_BUN_ONLY` 按 manifest group.name，不按文件名）。正式证据以统一入口报告为准；任务内 `bun test ./<file>` 只作定位。
- **真实 DB**：multitenancy 组需要 `openbot_enterprise_*` 数据库 + `ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL`（`options=-c role=ob_ent_*`，空格用 `%20`）。本轮自建一次性容器（唯一名 `issue459-ent-pg`、独立端口 5436、记录归属，结束后 `docker rm`），不触碰其他 Run 的容器。迁移通过 `bun --no-env-file server/scripts/multitenancy/migrate-test.ts migrate <TASK> [--apply --manifest]`。
- **静态**：`bun run --filter server typecheck`、`bun run --filter app typecheck`、改动文件 `bunx biome check`、受影响构建。仓库既有基线红（server typecheck 3 处 bootstrap、biome 既有项、部分 multitenancy 环境红）由 T00 固化清单，不计回归也不计通过。
- **浏览器/API**：PKG06/07/11/12 需要真实认证 API + 浏览器流程证据（复用既有 CDP/浏览器验收方式）；截图/快照入 `.archive/runs/2026-10-24-issue-459/verification/`。

---

## Task 00：BASE 基线核验（主编排者，无任务 Worktree）

**Source:** 批准包 Wave 0；A12；archive#33/#34 复验前提。
**Depends on:** 无（批准门已过）。 **Owner:** 主编排者；验证者角色=backend_validator（可由主编排者以只读命令执行并留证）。

**步骤**
- [ ] 在集成 Worktree 记录 `git rev-parse HEAD`（应为 `b117c3c3e`）、`git status`；建立 `.e2e/` 输出目录与容器归属记录。
- [ ] 启动一次性企业测试库容器（唯一名/端口），设置 `TEST_DATABASE_URL`、`ENTERPRISE_TEST_*`、`MT_TEST_*`；用 migrate-test dry-run→apply 配方在 fresh 库重放全部 PKG 迁移并记录 journal。
- [ ] 跑既有 package 套件：native（package-artifact/catalogue/install-routes/grants-routes/expert-routes/read-routes/package-install.integration）+ driven（multitenancy package-storage/package-runtime/package-grants/package-expert/package-install.integration）；记录每套件用例数、失败、跳过。
- [ ] 跑 archive#33/#34 行为复验：`server/tests/multitenancy/plugin-install.test.ts`、`tool-invocation.test.ts`（真实受限角色）；核对 `marketplace-install.ts` / `tool-invocation.ts` 契约未被合并波破坏。
- [ ] 跑 `bun run --filter server typecheck`、`bun run --filter app typecheck`、改动相关 biome；记录既有红。
- [ ] 按 Spec §2 逐模块重核对接口假设（插件 store/目录、tenancy scope gate、runs pin 接缝、admin-separation、config 键），列出 BASE 漂移项；漂移若影响后续 Task，写进对应 Brief 的 Consumes/Produces。
- [ ] 产出 `verification/baseline.md`（命令、退出码、用例数、known-red 清单、DB 容器 ID/清理结果、接口漂移表）。

**验收/失败处理**：任一既有 package 套件红 → 先归因为"基线红"或"合并波回归"；后者生成编号修复任务（不派发下游）。DB/角色不可用 → 不跳过，标记 blocked 并在恢复条件满足前不放行 T01–T04。
**Evidence:** `.archive/runs/2026-10-24-issue-459/verification/baseline.md`、`.e2e/*`。

## Task 01–04：PKG01–04 差额独立复审（4 个只读审核会话，集成 Worktree 并行）

**Source:** #460/#461/#462/#463；A01–A04、A06、A08、A10、A11、A12 对应项。**Depends on:** T00。
**方式**：每个票一个**新的独立审核会话**（非实现者），对照该 Issue 正文 AC + Spec 相关 §，审查 BASE 树中的既有实现与测试；同时核对前序 Run 复审结论是否有遗漏。审核会话只读业务代码/测试源，报告写入 `.archive/runs/2026-10-24-issue-459/reviews/pkg0x-<round>.md`。

**每票审核清单**：Issue AC 逐条 → 代码/测试证据映射；错误码与 HTTP 语义；范围/RLS/秘密红线；测试是否真正覆盖（非空断言、真实角色）；与 Spec 冲突或缺失；结论 = SPEC PASS/FAIL + QUALITY PASS/FAIL，blocking finding 编号。
**修复**：任一 blocking finding → 生成该票的固定修复任务（任务 Worktree，claude），修复+新检查点+复审，直至双 PASS。无 finding → 直接标记既有交付 verified-baseline。
**验收**：四份双 PASS 报告（或修复后 PASS）+ finding 裁决记录；A01–A04 等映射证据指向具体测试/报告。

## Task T-INF：测试基建修复（前置，test-only；2026-10-24 T00 发现）

**Source:** T00 基线红 B-1/B-2/B-3（`verification/baseline.md`）；ADR 0008；#460–#471 的 Verification 条款（真实受限角色 + 统一 e2e 入口）。**Depends on:** T00。**Owner:** implementer（claude）；独立审核会话。
**Owned files:** `scripts/e2e-coverage-audit.mjs`（缺目录守卫）、`tests/config/e2e-bun-suites.json`（用文档脚本重新生成）、`scripts/lib/e2e-manifest.mjs`（仅当需要）、`server/tests/multitenancy/support/**`（可复现的漂移调和 helper）、`server/tests/multitenancy/tool-invocation.test.ts`（runner 层修正）、`docs/plans/2026-10-24-issue-459/test-db-recipe.md`（新，记录配方）；`server/scripts/multitenancy/migrate-test.ts` 仅在确实需要时做向后兼容追加（不得重写已应用步骤文本，不得改 CLI）。
**约束：** 只改测试基建，不改 `server/src`/`shared`/`app` 生产代码；不新增依赖；不得削弱 RLS/GRAPH/真实角色断言；其他 multitenancy 套件的既有红只记录不顺手修。
**验收：**
- [ ] `node scripts/e2e-coverage-audit.mjs` 退出 0（或仅剩已记录既有缺口，不再崩溃）。
- [ ] 重新生成的 manifest 正确归类 package 套件；driven 命令实际执行 package-storage/runtime/grants/expert + package-install.integration，真实用例数>0 且全绿；plugin-install（archive#33 行为）全绿。
- [ ] tool-invocation.test.ts 在正确 runner 层可执行并 ≥11 pass。
- [ ] native 6 文件 144 用例仍全绿；改动文件 typecheck/biome 净（既有基线除外）。
- [ ] 任务分支本地提交（D5），不 push。
**报告：** `.archive/runs/2026-10-24-issue-459/tasks/T-INF-report.md`（命令、用例数、漂移清单、配方、偏差、遗留）。

## Task 05：PKG05（#464）本人连接受管工具执行

**Source:** #464 AC；Spec §6/§9–10；A02/A04/A05/A07。**Depends on:** T03/T04 双 PASS + T00 archive#34 复验通过。
**Owner:** backend_implementer（claude）；**Validator:** 独立审核会话。
**Owned files（起点，Brief 按实际接口核对细化）：** `server/src/db/schema/enterprise-plugin-packages.ts`（新增 `enterprise_package_dispatches`）、`server/scripts/multitenancy/migrate-test.ts`（新 task id/步骤，串行分配）、`server/src/enterprise/plugin-packages/{runtime,dispatch,contracts}.ts`、`server/src/plugins/{tools,store,access}.ts`、`server/src/enterprise/tenancy/tool-invocation.ts`（消费，不重写）、`server/src/enterprise/runs/service.ts`、`server/src/index.ts`、`shared/enterprise/plugin-package-contracts.ts`（错误码/DTO 如需）、`server/tests/multitenancy/package-{runtime,dispatch}.test.ts`、`server/tests/package-dispatch*.test.ts`。
**Consumes:** `PackageRuntime.prepareWithin`（ReadPinnedSkills）、`authorizeToolInvocation`、`PluginCatalogDecisionService.authorizeInvoke`、Run/attempt lease、ActionPolicy/审批、既有 transport。
**Produces:** `beginDispatch(scope, input): DispatchPermit`、`completeDispatch(permit, result)`、dispatch 状态机 prepared→dispatched→succeeded/failed/unknown/cancelled；`callTool` legacy/package 标签分支；Skill 读取 pin 校验；`PACKAGE_RUN_REQUIRED`/`PACKAGE_BOT_SCOPE_UNAVAILABLE` 语义。
**步骤**
- [ ] RED：仅安装/仅声明/legacy grant/他人连接/跨团队 Bot 均不放行；撤权后下一次调用拒绝；先停用则 transport 0 次；同 toolCallId 并发只派发一次；dispatched 后崩溃/写超时→unknown；旧 pin 不吸收新工具/新 schema/write 升级。
- [ ] 迁移：新增 dispatch 表 + 最小 RLS（data 角色仅绑定当前 actor/Run 的 INSERT/UPDATE）；dry-run→manifest→apply 在真实受限角色验证。
- [ ] 实现 Run pin 后的 Skill 读取接线与 tool 调用分支；所有判定经 `authorizeToolInvocation`，禁止 legacy OR 回退；参数摘要/连接 generation/effect 校验；网络等待不持锁。
- [ ] 测试：package-dispatch driven + package-runtime 回归 + plugin/tool-invocation 回归；secret canary；真实两个 DB 连接做停用/撤回与 dispatch 竞争。
- [ ] 报告与检查点；独立审核 SPEC+QUALITY。
**验收**：#464 AC 逐条证据；A02/A04/A05/A07 对应条目；dispatch 线性化与 unknown 事实可复核。

## Task 06：PKG06（#465）升级/回滚与权限增量

**Source:** #465 AC；Spec §7/§10；A03/A06/A07。**Depends on:** T05 verified。
**Owner:** backend+frontend（同票内按接口拆，Brief 写明）；**Validator:** 独立审核会话。
**Owned files:** `server/src/enterprise/plugin-packages/{install-service,plans,routes,contracts}.ts`；`app/src/lib/plugin-packages/{mutations,queries}.ts`；`app/src/components/market/{package-detail,package-install-dialog}.tsx`；`app/src/locales/{en,zh-CN}/market.json`；`app/tests/plugin-package-install.test.tsx`（扩展）或新增 `plugin-package-upgrade.test.tsx`；server tests `package-install.integration`、新增 `package-lifecycle.integration`（upgrade/rollback 部分）。
**Consumes:** 既有 revisions/plans/changes 表；`assertReleaseUsable`；`revokeGrantsForInstallLifecycle` 接缝；dispatch 的 pin 交集。
**Produces:** `operation=upgrade|rollback` 的 plan/apply；权限增量（新增工具/read→write/schema digest）预览与重新授权要求；CAS `expectedRevision`；回滚新建 revision，generation/revision 单调；UI 升级/回滚入口与差异展示。
**步骤（RED→GREEN→REFACTOR，节选）**
- [ ] RED：目标非精确版本/已撤回/制品缺失拒绝；并发升级 409；旧 Run 不加新工具；回滚不复活 grant；同版本同 digest 幂等。
- [ ] 服务：plan 比较资源/工具/effect/连接/配置差异；apply 事务内重验 release/revision/幂等键；旧 Run pin 只缩不涨；changes 记录 upgrade/rollback。
- [ ] UI：已安装包显示精确目标版本与差异，确认后 apply；范围切换废弃待确认 plan；i18n 双语。
- [ ] 测试：driven upgrade 套件 + native UI 套件 + 真实 CAS 竞争；浏览器流程证据。
- [ ] 独立审核；检查点。

## Task 07：PKG07（#466）停用/卸载/重装

**Source:** #466 AC；Spec §4/§10；A01/A05/A08。**Depends on:** T06 verified（同文件所有权串行）。
**Owned files:** `server/src/enterprise/plugin-packages/{install-service,routes,contracts}.ts`；`app/src/lib/plugin-packages/mutations.ts`；`app/src/components/market/{package-detail,package-lifecycle-dialog}.tsx`（新）；locales；`app/tests/plugin-package-lifecycle.test.tsx`；server `package-lifecycle.integration`（status 部分）。
**Produces:** `PATCH /installs/:id/status`（CAS + generation）；停用/卸载撤销当前 grant、保留 tombstone/revision/pin/审计；重装复用 installation identity、generation 递增、旧 grant 不复活；`allowedActions` 真实计算；UI 影响面与下一步。
**步骤**
- [ ] RED：停用/卸载后无新 dispatch；在途竞态按 dispatched 线性化；tombstone/历史保留；重装旧 grant 不复活；跨范围同形。
- [ ] 实现 status CAS、grant 撤销接缝、changes 记录；共享 connector 双包场景不破坏。
- [ ] UI 从 `allowedActions` 渲染 disable/enable/uninstall；影响提示与重装引导；i18n。
- [ ] driven + native + 浏览器证据；独立审核；检查点。

## Task 08：PKG08（#467）部署侧下架与安全撤回

**Source:** #467 AC；Spec §10/§12；A01/A02/A05/A07/A12。**Depends on:** T06 verified。
**Owned files:** `server/src/plugin-packages/{catalogue,artifact}.ts`（index schema 增加 `state`/严格校验）；`shared/enterprise/plugin-package-contracts.ts`（若 DTO/错误码需要）；`scripts/plugin-packages/{publish,withdraw}.ts`（新/扩展）；`server/src/enterprise/plugin-packages/{plans,dispatch}.ts`（撤回检查）；`server/tests/package-release-state*.test.ts`；必要时 `app/src/components/market/package-*.tsx`（只读 unavailable 原因）。
**Produces:** 部署 CLI `listed=false` 与 `state=withdrawn`；撤回与 dispatch 串行（release 锁）；撤回阻断旧 pin 新派发；同版本异摘要拒绝；V1 不自动 GC。
**注意**：Spec §6 原设想 DB `enterprise_package_releases`，现有实现为文件索引（PKG01 决策）；本票在文件索引上扩展 must 记录该偏差与理由，或经用户批准新增表。不得静默改变已安装 revision 语义。
**步骤**
- [ ] RED：withdrawn 阻断所有范围与旧 pin 新 dispatch，已 dispatched 保留回执/unknown；listed=false 仅影响发现；公司管理员不能全局撤回。
- [ ] 实现 index/facts 状态 + 锁序 + 命令；跨两团队真实派发竞争测试；CLI 演示。
- [ ] 独立审核；检查点。

## Task 09：PKG09（#468）审批恢复与后台入口原范围

**Source:** #468 AC；Spec §9；A02/A05/A07/A12。**Depends on:** T05 verified。
**Owned files:** `server/src/enterprise/plugin-packages/runtime.ts`（读 pin 接线）；`server/src/plugins/{tools,store}.ts`；`server/src/app.ts`；`server/src/approvals/execute.ts`；`server/src/memory/ingestion.ts`；定时/责任任务装配点（index.ts 内 grantedTools/grantedSkills 调用链）；`server/tests/package-entrypoints*.test.ts`。
**Produces:** 每入口"支持包执行或明确拒绝"清单与实现；后台从持久 Run 身份重建 Scope；审批恢复重验参数/账号/连接 generation/团队/撤权；无受管 Run → PACKAGE_RUN_REQUIRED；外部黑盒 Bot → unsupported。
**步骤**
- [ ] 入口清单（tools、plugins/routes call、app 内部 call、approval resume、schedule/responsibility、memory ingestion）逐项写证据表。
- [ ] RED：改参/切团队/断连/撤权后旧提案拒绝；未带包上下文不能执行包资源；legacy 无回退。
- [ ] 实现接线；transport spy 计 0/1 次；driven + 回归；独立审核；检查点。

## Task 10：PKG10（#469）未知效果核对与安全恢复

**Source:** #469 AC；Spec §9–10；A05/A08/A12。**Depends on:** T09 verified。
**Owned files:** `server/src/enterprise/plugin-packages/{dispatch,runtime}.ts`；`app/src/components/market/*`（unknown 展示/核对入口）；locales；`server/tests/package-unknown*.test.ts`；`app/tests/plugin-package-*.test.tsx`。
**Produces:** dispatched 后崩溃/写超时的 unknown 持久化；重启后同 operation 可见；无幂等协议不重发；支持时按原 operation 核对并写回；失权用户不可见/不可续；停用/卸载/撤回后 unknown 与回执保留；Activity/Run/receipt 真实进度。
**步骤**
- [ ] RED：崩溃注入/写超时→unknown；重启核对；断连恢复；失权拒绝查看；不伪造完成/失败。
- [ ] 实现核对命令/接口与 UI；driven+native；独立审核；检查点。

## Task 11：PKG11（#470）存量迁移与灰度启用

**Source:** #470 AC；Spec §12；A08/A09/A11/A12。**Depends on:** T06/T07/T08/T10 verified。
**Owned files:** `scripts/plugin-packages/{migrate-legacy,publish}.ts`；`server/src/config.ts`（`OPENBOT_PACKAGE_MARKETPLACE_ENABLED`、`PILOT_WORKSPACES`）；`server/src/marketplace/{catalogue,routes,store}.ts`（legacy 适配）；`Dockerfile`/`package.json`（构建携带制品）；`docs/operations/plugin-packages.md`；`server/tests/package-migration*.test.ts`；必要时 Web 侧 gating 提示。
**Produces:** 默认 dry-run 导出源 ID/哈希/映射/unresolved；apply 显式绑定同 manifest + CAS；影子读取（同范围）；默认关闭 + 精确 tenant/workspace pilot；关入口后既有 Run 仍受 pin 治理或安全暂停；不删表回退；无自动 GC。
**步骤**
- [ ] RED：私人编辑不覆盖；缺范围不迁；源并发变更拒绝；legacy slug 映射保留；pilot 名单拒绝通配符。
- [ ] 实现迁移命令 + 开关 + 装配探测；镜像构建携带制品；dry-run→apply 演练；启用→Run→关入口回退。
- [ ] driven/native + 浏览器/API 证据；独立审核；检查点。

## Task 12：PKG12（#471）首发闭环验收与交付证据

**Source:** #471 AC；A01–A12 全量。**Depends on:** T11 verified。**Owner:** 主编排者 + 各专业验证者；独立审核会话。
**步骤**
- [ ] 建立 A01–A12 → 同一交付版本证据矩阵（测试/演示/截图/检查点），无 orphan。
- [ ] 全量受影响 native/driven 复跑 + typecheck/lint/构建 + `node scripts/e2e-coverage-audit.mjs` 对账；实际测试数>0。
- [ ] 真实认证 API + 浏览器主路径：安装→授权→专家/工具使用→升级→撤权→unknown 核对→回退；legacy 回归。
- [ ] 独立 reviewer 双 PASS；列出 blocked/skip；V1 支持范围声明；风险与遗留。
- [ ] 汇总 `verification/acceptance.md` 与交付清单。

## Task 13：终审与完整 OCR（主编排者 + Codex）

**Source:** orchestration.md 完整交付。**Depends on:** T12 verified。
**步骤**
- [ ] 冻结集成范围：BASE `b117c3c3e` → 集成 HEAD + 未提交交付；记录 SHA/清单。
- [ ] 经 Orca 启动 Codex 终审（原始 BASE 至今，Spec/质量双结论）。
- [ ] 主编排者执行一次完整范围 OCR：`ocr review --audience agent --background "<#459 背景+验收+范围>" --from b117c3c3e --to <HEAD> --output .archive/runs/2026-10-24-issue-459/ocr/final.json`（有未提交交付同时覆盖 workspace 模式）；记录 exit、覆盖、跳过。
- [ ] 有效 critical/high/medium → 编号修复任务（新分支，不复活已清理 worktree）→ 复审 → 重新终审/OCR。
- [ ] 通过后汇总最终报告：每验收证据、审核结论、遗留、Git 状态；提交/推送/关票仍按 D7 边界（不执行）。

## 自查与恢复

- 节点唯一、依赖无环（与 GitHub blocked_by 一致）；跨 Task 共享文件按波次串行（T06→T07；T05→T06/T09；T10→T11）；T09 与 T06 文件所有权不相交，允许并行。
- 每个 Task Brief 必须附带：Issue 正文快照路径、Spec 章节、前置检查点/接口、owned_files、验证命令与预期、报告路径、失败上报条件；Worker 不派发子 Agent。
- 恢复顺序：Ledger → dag.json → Orca `worktree list`/`worker-list` → 集成 Worktree `git log/status` → 本计划；禁止重派已完成 Task；未集成改动与有效会话必须保留并标记待对账。
- 本计划不含提交/推送/合并 main/部署授权；D5/D7 的边界以 Run objective 与 Ledger 为准。
