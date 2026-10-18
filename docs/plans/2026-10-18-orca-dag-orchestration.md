# Orca DAG Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从用户指定的根 Issue 开始，递归扫描完整子 Issue 树、核验依赖并生成执行 DAG，通过 Orca 持续调度，在依赖、文件所有权和资源容量允许时取得当前就绪集合的最大并行数，并保留验收、审查、集成及恢复证据。

**Architecture:** 单一主协调器拥有派发权；确定性的本地工具负责摄取、图校验、资源选择和执行 Ledger，Orca 负责 Task、Dispatch、Worker 和消息生命周期。业务验收状态与 Orca 执行状态分离；业务任务间依赖仅在产物已审查、验证并进入下游实际工作区后释放；任务内部阶段按明确的证据条件推进。

**Tech Stack:** 现有 Node.js / TypeScript / Bun 工具链；新增运行工具使用 Node ESM `.mjs`，测试使用仓库 e2e tools-only target 及 `tests/support/e2e-compat.ts`；外部能力经已认证 `gh` 与当前 Orca CLI 调用。

**Spec:** 本文“需求基线”来自 2026-10-18 制定原计划时的用户要求及架构讨论，属于待实施设计，尚非独立批准 Spec。未读取真实全量 Issue 树，因此本计划是编排工具的实施任务，不是已经核实的业务 Issue 执行 DAG。

## Global Constraints

- Issue tracker 为 `1123786563/OpenBot`；遵守 `docs/agents/issue-tracker.md`、根 `AGENTS.md`、`CONTEXT.md` 和 `docs/adr/0008-test-runner-tester-army-e2e.md`。
- 本轮只交付计划，不启动 Worker、不创建 GitHub Issue、不提交、推送、合并或关闭 Issue。后续默认使用未提交检查点；没有已有提交授权不得自动提交。
- 整理时主工作区存在无关未提交修改。计划文档保存在当前目录供审阅；实施前必须使用 using-git-worktrees + Orca 建立隔离执行工作区，显式复制本计划并核对 SHA-256，记录原始 BASE 和相关未提交事实源。不得假定新工作区带入本目录未提交改动。
- 一个协调器负责整个 Run；Worker 只接收单个 Brief，不递归派发。使用 Orca orchestration，不以非 Orca 子 Agent 替代实际执行。
- 并行实施必须独立 Worktree、写权限不相交、接口稳定；共享数据库、端口、缓存、迁移和产物目录均进入资源模型。
- 只读默认：摄取、规划、dry-run 不启动 Worker。实际 start/resume 的范围和并发预算必须来自已授权运行配置。
- CLI 可执行路径按技能解析一次并持久化；原计划记录的核验路径为 `/Applications/Orca.app/Contents/Resources/bin/orca`。执行时重新读取该版本技能，禁止假设未来版本仍使用相同参数。
- 不把 task-list --ready、worker_done、Issue closed 或测试进程 exit 0 单独视作业务验收完成。
- 验证证据绑定代码检查点；完整范围独立 Review、OCR 及修复复审通过才交付。
- 原计划记录的授权为：未来运行中在验收完成后同步 `agent:ready-for-review` 标签和交付评论，证据失效时撤标并更新评论；授权仅限本次运行范围内的 Issue。本轮仍仅修改文档，不调用 GitHub 写接口。摄取、plan、dry-run 保持只读；标签同步不包含关闭 Issue、修改正文或推送代码的授权。

## Review Focus

1. GitHub 分页中途失败、403/404 或依赖缺失：保存部分证据，受影响节点阻塞，不能静默视为完整。（T2）
2. Worker 启动已发生但响应丢失：先对账并保持未知状态，不派发第二个写入者。（T4、T8）
3. 过期 Dispatch 和重复 Delivery：不覆盖当前尝试，不重复集成，处理后才 ack。（T3、T8）
4. 验证后文件变化或依赖未进入实际工作区：证据失效，不能释放下游。（T7）
5. 最大并发与公平性：容量为硬约束，等基数优先老任务；严格最大基数不保证有界等待，持续输出延迟原因，不宣称防饥饿。求解必须可中断且不阻塞消息处理。（T5、T8）

---

## 阅读导航

正文按执行顺序组织，共享协议集中到附录。当前状态为**计划待实施**，本次工作仅整理文档。

| 阅读目的 | 入口 |
| --- | --- |
| 核对范围、功能与故障验收 | [1. 范围与验收基线](#scope) |
| 查看文件边界、依赖与角色 | [2. 交付结构与开发 DAG](#delivery) |
| 按任务实施 | [3. 实施任务](#tasks)，T1–T8 共用通用步骤，T9 验证与审查，T10 条件交接 |
| 判断是否可交付、恢复执行记录 | [4. 完成条件与 Ledger 起点](#completion) |
| 工具完成后运行真实 Issue | [5. 真实业务运行流程](#runtime)，R0–R7 使用独立运行计划 |
| 查字段、状态及跨模块约束 | [附录 A：数据契约](#contracts)、[附录 B：运行协议](#protocols)、[附录 C：审核同步](#review-sync) |

编号含义：A 为功能验收，F 为故障验收，T 为工具开发及交接任务，R 为真实业务运行步骤。业务 Task、内部阶段和 Orca Task 的状态含义见附录 A、B.1–B.2。

<a id="scope"></a>

## 1. 范围与验收基线

### 1.1 扫描范围与版本边界

默认扫描入口为一个根 Issue，`root_issue` 接受完整 GitHub Issue URL 或 `owner/repo#number`。仓库固定为 `1123786563/OpenBot`；根 Issue 指向其他仓库、PR 或无法读取时，启动失败并保留错误，不回退到全仓库扫描。

“全部”固定为根 Issue 本身及其递归子 Issue，包含 open 和 closed；只按状态过滤会遗漏父级验收与实现核验。正式子 Issue 每层处理分页，以 repo + number 去重，保存完整 contains 路径；正文任务链接逐条核验，只有确认的子项进入 contains。普通引用和树外依赖不会自动扩展实施范围。树外依赖只读核验状态、接口和目标代码证据，记录 external_blockers；确需实施时先显式修改范围快照。读取开始和结束时间、每页来源均记录；读取失败明确标注不可知部分并阻塞依赖该部分的任务。closed 节点须经目标代码核验后才标 satisfied。

首次扫描结束冻结 `scope_revision`、根 Issue 身份及树指纹；启动绑定这一版本。新子 Issue 或依赖变化需通过显式 `rescan` 生成差异，保留历史证据并重算受影响节点；只有需求和代码前提仍有效的 verified 才保持有效，不重复派发未受影响的任务。若变化推翻运行中任务的前提，暂停受影响节点的后续派发并通知当前 Worker，待核对后继续。全库扫描不属于默认入口。

### 1.2 功能验收 A1–A9

| ID | 需求 | 负责 Task |
| --- | --- | --- |
| A1 | 从指定根 Issue 递归扫描完整子树，每个 Issue 有分类、来源和完整性，不把父子关系当执行依赖 | T1、T2、T6 |
| A2 | 无环、验收覆盖、稳定接口和文件所有权预检 | T1、T6 |
| A3 | 当前就绪集合在资源约束下最大并行，完成即补位 | T5、T8 |
| A4 | Orca 原生协调、独立 Worktree、角色路由、权威尝试唯一 | T3、T4、T7、T8 |
| A5 | 验证、独立 Review、集成后释放依赖 | T7、T8、T9 |
| A6 | 崩溃恢复、消息去重、不确定状态安全恢复 | T3、T4、T8 |
| A7 | 完整范围 OCR、修复循环和持久证据 | T9；真实业务由独立 R6 验收 |
| A8 | 先演练、再真实小范围试运行、最后全范围运行 | T8 操作手册、T9 离线演练；T10 交接独立运行计划 |
| A9 | Issue 验收通过后标记等待人工审核，证据失效撤标，失败可恢复且不重跑实施 | T1、T8、T9；真实运行按 R7 同步 |

### 1.3 故障验收 F1–F6

F1–F6 是工具运行时的故障验收要求。协议见附录 B、C，行为断言见对应 Task；开发流程合规不能替代运行时行为验证。

| ID | 必须验证的异常场景 | 负责 Task |
| --- | --- | --- |
| F1 | 验证、Review 或集成失败后，按失败类别恢复并完成修复闭环 | T1、T4、T6、T7、T8、T9 |
| F2 | 集成回归与其他任务争用资源时等待，不并发污染验证环境 | T1、T3、T5、T7、T8、T9 |
| F3 | rescan 期间未受影响的在途结果承接到新版本，不重复实施或永久 running | T1、T3、T6、T8、T9 |
| F4 | 不同 Run、不同 Issue 访问同一独占资源时只有一个成功预留 | T1、T3、T5、T8、T9 |
| F5 | 无实施 Task 的聚合父 Issue 仍能取得同步声明并完成审核标记 | T1、T3、T8、T9 |
| F6 | 精确求解未结束或预算耗尽时，协调器仍处理消息、撤标和恢复 | T1、T5、T8、T9 |

<a id="delivery"></a>

## 2. 交付结构与开发 DAG

### 2.1 文件边界与持久产物

新增实现仅写 `scripts/orca-dag/`；新增测试 `scripts/orca-dag-*.test.ts`；固定 fixtures 位于 `scripts/orca-dag/fixtures/`；操作说明 `docs/agents/orca-dag.md`。不修改应用、计费和既有运行中的任务文件。

运行目录为 `docs/plans/<date>-orca-run-<run-key>/`，包含 `scope.json`、`issues/`、`dag.json`、`briefs/`、`events.jsonl`、`state.json`、`receipts/`、`checkpoints/`、`reports/`。持久事实源不包含凭据及完整环境变量。

### 2.2 任务依赖、角色与并行边界

| Task | 交付 | depends_on | owner_role | validator_role | status |
| --- | --- | --- | --- | --- | --- |
| T1 | 冻结契约、配置和生命周期校验 | — | backend_implementer | backend_validator | pending |
| T2 | 从根 Issue 递归摄取与范围快照 | T1 | backend_implementer | backend_validator | pending |
| T3 | Ledger、唯一尝试和恢复投影 | T1 | backend_implementer | backend_validator | pending |
| T4 | Orca 适配与回执核验 | T1 | backend_implementer | backend_validator | pending |
| T5 | 精确最大并行调度 | T1 | backend_implementer | backend_validator | pending |
| T6 | Issue 转 Task DAG 与 Brief | T2 | backend_implementer | backend_validator | pending |
| T7 | Worktree、检查点、验收集成门禁 | T3、T4 | backend_implementer | backend_validator | pending |
| T8 | 持续补位协调循环、CLI 与操作手册 | T3、T4、T5、T6、T7 | backend_implementer | backend_validator | pending |
| T9 | 故障演练及全工具审查 | T8 | backend_validator / reviewer | reviewer | pending |
| T10 | 独立真实运行计划交接（条件阶段） | T9 | 主协调器 | reviewer | pending |

每个实施 Task 内独立执行 RED → GREEN → REFACTOR、验证、Spec + 质量 Review；表中的依赖完成均指已审查且已集成。所有节点 `source_issues=[]`，来源为用户会话需求；不得伪造 GitHub 编号。T10 交接的独立运行计划摄取真实 Issue 后另存真实业务 DAG，不复用本表充当业务依赖证据。

工具开发默认按仓库规则串行派发；仅有明确并行实施授权时采用以下并行关系。工具运行时最大并行策略也必须服从已授权预算。理论开发并行宽度为 4：T1 后可同时执行 T2/T3/T4/T5；T2 完成即可启动 T6，T3/T4 完成即可启动 T7，不等整批结束。实际同时启动数仍取决于已配置预算和运行中任务。不存在前端交付，不派发前端角色。

<a id="tasks"></a>

## 3. 实施任务

### 通用步骤与失败处理

以下步骤适用于 T1–T8，每个 Task 的断言和实现接口见专属条目：

- [ ] 读取本 Task Brief、事实源和前置接口；核对当前 BASE、工作区、写权限与资源预留。
- [ ] 在指定测试文件写明专属行为断言；运行 `E2E_UNIT_SCOPE=scripts bun run test -- scripts/orca-dag-<name>.test.ts`，确认新行为缺失导致失败，不接受收集失败代替 RED。
- [ ] 在 owned_files 实现指定接口；只修改本 Task 文件。运行相同命令，期望新用例全部通过、无 collection error、无意外 skip、用例数大于 0。
- [ ] 针对本 Task 新文件执行 `bunx biome check <owned_files>`；不对仓库无关文件自动修复。
- [ ] 生成包含 staged/unstaged/new/deleted 文件的检查点与 SHA-256 清单、独立报告；验证者优先复用同一哈希有效证据，Reviewer 给出 Spec compliance 和 code quality 两个结论。
- [ ] 主协调器核对审查通过及产物集成后更新 Ledger。每次修复必须重新绑定检查点和相关验证；失败阻塞该节点及后继，其他无关任务继续。

测试入口依照 ADR 0008；若隔离工作区的测试基础设施与此处读取的未提交版本不同，先记录并解决基线差异，不复制整个脏工作区，不更换测试框架掩盖问题。单 Task 修复上限遵守 SDD；超限报告阻塞并按既有升级规则处理。

### Task 1: 冻结运行契约与状态约束

**依赖与角色：** 无；backend_implementer → backend_validator → reviewer。

**共享约束：** 附录 A、B.1–B.2。

**Files / owned_files:** `scripts/orca-dag/contracts.schema.json`、`scripts/orca-dag/contracts.mjs`、`scripts/orca-dag-contracts.test.ts`。

**Interfaces:**

- **Consumes:** 会话需求、AGENTS。
- **Produces:** `validateDocument(kind, value): {ok, errors}`、`canTransition(entityKind, from, to, evidence): boolean`，以及附录 A 的 JSON schema。

**实施要求:**

- schemaVersion 固定为 1；配置要求 repo、root_issue、scope、capacity、roleRouting、executionMode、runDir，另含 resourceCatalog 和 searchBudget（sliceNodes/sliceMs/maxNodes 均为正整数）。
- 调度策略固定为 strict-max-cardinality，登记本地主机、操作系统用户及 Git common dir 身份。
- scope.mode 固定为 root-tree，快照包含 scope_revision 和树指纹。
- executionMode 支持 dry-run/start/resume；capacity 无值或 root_issue 缺失时禁止 start。
- 角色映射由实施前核实的运行配置显式提供，不能假设 Orca --agent 等于专业 agent_type。
- 对外来 Issue 文本只按数据处理。
- 冻结 F1–F6 的状态、数据类型和资源作用域；canTransition 必须校验恢复裁决与范围承接证据，不能只比较状态字符串。

**测试断言:**

- [ ] 缺少 owner_role 拒绝。
- [ ] 容量 0 拒绝。
- [ ] 根 Issue URL 与 owner/repo#number 规范化到相同身份。
- [ ] 缺根 Issue 或指向其他仓库/PR 拒绝。
- [ ] 非法状态跳转拒绝。
- [ ] worker_done 且无 Evidence 不能 verified。
- [ ] 未知 schemaVersion 报错且不改写。
- [ ] 内部验证可在业务 implemented 时进入，业务下游必须等最终 verified。
- [ ] stale Evidence 不能通过门禁。

**专项验收：**

- [ ] F1/F3：验证失败只能凭 RecoveryDecision 重新进入阶段；旧版本结果只能凭 accepted ScopeCarryForward 推进新版本，同一结果不能推进两次。
- [ ] F2/F4/F5/F6：拒绝缺 scope_id 的资源、缺资源声明的检查和非正搜索预算；允许没有实施 Task 的同步 holder，但未持有 token/epoch 时拒绝同步副作用。

### Task 2: 从根 Issue 递归扫描并分类完整子树

**依赖与角色：** T1；backend_implementer → backend_validator → reviewer。

**共享约束：** 1.1、附录 B.6。

**Files / owned_files:** `scripts/orca-dag/github.mjs`、`scripts/orca-dag/fixtures/github/`、`scripts/orca-dag-github.test.ts`。

**Interfaces:**

- **Consumes:** T1。
- **Produces:** `ingestIssues(config, githubTransport): Promise<IssueSnapshot>`、`diffScope(previous, current): ScopeDelta`。快照包含 root_issue、scope_revision、tree_fingerprint、issues、contains、depends_on、sources、read_window、incomplete、external_blockers；关系带 explicit/inferred、出处和理由。ScopeDelta 包含 added/removed/changed（Issue 身份列表）及 changed_fields（按 Issue 身份索引的字段变化），不包含 task ID；移出范围不意味着撤销已发生的修改。

**实施要求:**

- 已认证 gh 先读取指定根 Issue，按队列遍历全部层级子项，每层使用 `gh api --paginate repos/{owner}/{repo}/issues/{number}/sub_issues`，同时读取每个节点的评论、验收及支持的原生依赖；核验正文任务链接。
- 去重集合和遍历队列持久化，扫描中断可从未完成页/节点恢复；若分页游标失效则重新读取该节点并去重，不跳过未知页。
- 扫描同时保留 open/closed 节点，重复引用不重复摄取，contains 回路显式报错。
- 原生依赖读取不可用时标记该维度不完整。
- closed Issue 只记录候选 satisfied，交给代码核验，不自动完成。
- 快照只读，不改标签、正文或关闭状态。

**测试断言:**

- [ ] 根→子→孙→曾孙完整读取。
- [ ] 某父节点三页共 205 个子项全部读取。
- [ ] 重复 Issue 去重且保留来源路径。
- [ ] 根无子项合法。
- [ ] closed 子项仍扫描。
- [ ] contains 不生成 depends_on。
- [ ] 第三页 403 保留前两页并标 incomplete。
- [ ] 根 404 不回退全库。
- [ ] PR 拒绝。
- [ ] 树外阻塞不自动实施。
- [ ] 循环引用有具体路径。
- [ ] 中断恢复不漏节点。
- [ ] 新增子项 rescan 产生 Issue 级 ScopeDelta，验收变化记录 changed_fields。
- [ ] Issue 正文中的命令不执行。

### Task 3: 持久化 Ledger 与执行唯一性

**依赖与角色：** T1；backend_implementer → backend_validator → reviewer。

**共享约束：** 附录 B.3–B.6、C.3–C.4。

**Files / owned_files:** `scripts/orca-dag/ledger.mjs`、`scripts/orca-dag/resources.mjs`、`scripts/orca-dag/claims.mjs`、`scripts/orca-dag-ledger.test.ts`、`scripts/orca-dag-resources.test.ts`。Ledger 负责 Run 事件；resources 负责共享资源事务；claims 负责 Issue 两种用途的声明。

**Interfaces:**

- **Consumes:** T1。
- **Produces:** `appendEvent(runDir, event): Promise<void>`、`replay(runDir): Promise<RuntimeState>`、`reserveAttempt(runDir, stageAttempt, expectedRevision, claimRequest, resourceReservations): Promise<AttemptReservation>`、`reconcileClaims(repoIdentity, runId): Promise<ClaimReconciliation>`、`releaseClaims(repoIdentity, runId, settlementEvidence): Promise<void>`；resources 导出 `readResourceSnapshot(hostIdentity): Promise<ResourceSnapshot>`、`reserveResources(hostIdentity, requests, expectedRevision): Promise<ResourceReservation[]>`、`releaseResources(hostIdentity, reservationIds, releaseEvidence): Promise<void>`、`reconcileResources(hostIdentity, runId): Promise<ResourceReconciliation>`、`transferIntegrationResources(hostIdentity, oldReservationIds, newRequests, recoveryDecision, expectedRevision): Promise<ResourceReservation[]>`（在单事务中转移故障工作区预留并领取新测试资源，失败则保留旧预留）。claims 导出 `acquireSyncClaim(repoIdentity, issueNumber, runId, outboxId): Promise<Claim>`、`transferClaims(repoIdentity, issues, fromRun, toRun, handoffEvidence): Promise<Claim[]>`。请求、快照和回执类型由 T1 schema 定义；Snapshot 含资源目录、占用和 registry_revision，requests 按 holder_id 分组；releaseEvidence 为退出/结算证据或未产生副作用的持久证明。

**实施要求:**

- events.jsonl 为事实日志，state.json 原子替换为可重建投影；单协调器进程锁、revision 比较、事件去重；记录启动意图再调用外部启动。
- 锁损坏或持有者不明不自动抢锁；机器重启后需核对活跃 Worker 再恢复。
- 实现附录 B.3 的仓库级原子声明协议；reserveAttempt 返回持久化 claim token，启动前必须校验 token。
- 日志持久化遵循附录 B.5 的 fsync 和异常尾行规则。

**测试断言:**

- [ ] 同任务两次 reserve 仅一次成功。
- [ ] 事件重复不重复扣资源。
- [ ] 半写尾行作为恢复异常显式报告。
- [ ] 旧 attempt 的完成事件不能覆盖新 attempt。
- [ ] 重新投影状态一致。
- [ ] 进程锁禁止两个协调器同时写入同一 Run。
- [ ] 不同 runDir 同时领取重叠 Issue 仅一个成功。
- [ ] 多 key 领取无部分成功。
- [ ] 领取后启动意图前崩溃可对账。
- [ ] 独立 clone/远程配置拒绝 start。

**专项验收：**

- [ ] F2/F4：用两个真实进程、不同 runDir 和不同 Issue 争用同一 host 独占资源，断言恰好一个预留成功；多资源事务失败不留下部分占用；Run 配置不能放大共享容量。
- [ ] F4：覆盖资源预留后、Issue 领取后和启动意图写入后的崩溃窗口；只有可证明无副作用的预留可释放，未知子进程占用不得按超时释放。
- [ ] F5：没有 task_id 的父 Issue 同步领取合法；implementation/review_sync 对其他 Run 互斥；pending outbox 阻止释放；移交后旧 epoch 被拒绝，在途请求未知时不能移交。
- [ ] F3：范围迁移与结果承接事件重放后状态一致，原始证据保持原版本且只生成一个有效承接记录。

### Task 4: Orca 生命周期适配

**依赖与角色：** T1；backend_implementer → backend_validator → reviewer。

**共享约束：** 附录 B.1–B.2。

**Files / owned_files:** `scripts/orca-dag/orca.mjs`、`scripts/orca-dag/fixtures/orca/`、`scripts/orca-dag-orca.test.ts`。

**Interfaces:**

- **Consumes:** T1。
- **Produces:** `OrcaClient` 的 `preflight()`、`createRun(objective)`、`createTask(spec, deps)`、`startWorker(taskId, placement, roleConfig)`、`retryFailedStage(orcaTaskId, failedDispatchId, placement, roleConfig, recoveryEvidence)`、`receive(timeoutMs)`、`ack(deliveryId)`、`inspectWorkers(runId)`、`reply(messageId, body)`、`release(dispatchId)`、`preparePlacement(task, base)`、`reuse(dispatchId, nextTaskId, roleConfig)`、`retain(dispatchId, userAuthorization)`、`inspectDispatch(dispatchId)`、`recover(dispatchId, action, evidence)`、`notifyWorker(dispatchId, body)`；返回保留完整原始回执引用的标准对象。

**实施要求:**

- 加载精确版本技能和必要 reference，使用 JSON 回执；未知字段可忽略，缺少必要权威字段则 unverifiable。
- 正常 worker-start 使用已有 Task；launch 部分失败读取 failedStage/residualResources，不能重新启动。
- 等待超时不超过 60 秒，给协调器更新机会。
- 角色路由需验证有效 launch 配置/Brief，未核实映射不得声称专用角色已启用。
- preparePlacement 由版本匹配的 placement reference 实现 Worktree 创建/核验；reuse/retain/recover 分别按 coordinator-loop 与 recovery-and-cleanup reference 映射，recover 的 action 只允许已核验回执支持的 stop/abandon/cleanup，stop/abandon 须有正面的退出证据，cleanup 须满足回执条件。
- retain 必须引用用户保留请求；缺少能力时返回 blocked 和人工恢复步骤，禁止猜参数。
- notifyWorker 只证明发送成功，不证明 Worker 接受。

**测试断言:**

- [ ] argv 保留路径空格和正文特殊字符。
- [ ] unknown optional field 兼容。
- [ ] 响应丢失不重发 start。
- [ ] 非零退出保留残留资源信息。
- [ ] settlement 未接受不能 release。
- [ ] 请求模型与实际模型不一致显式阻塞或纠正。
- [ ] 无用户请求不得 retain。
- [ ] 无退出证据不得 stop/abandon。
- [ ] 未知恢复能力阻塞。
- [ ] Worktree 回执保留工作区身份。

**专项验收：**

- [ ] F1：按版本匹配的 help/reference 实现 retryFailedStage；只对核实可重试的失败 Orca Task 传入 `--task` 和 `--retry-of`，完整重传 placement/角色。成功实现后被 Review 拒绝时创建新修复阶段 Task，不重试成功 Dispatch；未知旧执行状态时拒绝两条启动路径。

### Task 5: 最大可行并行集合选择

**依赖与角色：** T1；backend_implementer → backend_validator → reviewer。

**共享约束：** 附录 A.6、B.1、B.4。

**Files / owned_files:** `scripts/orca-dag/scheduler.mjs`、`scripts/orca-dag/scheduler-worker.mjs`、`scripts/orca-dag-scheduler.test.ts`。纯求解逻辑与 Node worker_threads 执行适配分开。

**Interfaces:**

- **Consumes:** T1。
- **Produces:** `selectRunnable(dag, state, resourceSnapshot, searchCheckpoint, nodeBudget): ScheduleDecision`，纯函数，无进程和文件副作用；以及 `solveSchedule(input, searchBudget, searchCheckpoint, signal, onProgress): Promise<ScheduleDecision>`，在独立 Node worker thread 中分段求解，onProgress 向协调器交付可持久化进度。input 包含 dag/state/resourceSnapshot，schema 和输入哈希算法由 T1 固定。

**实施要求:**

- 按 Dependency.condition 过滤未满足的边：内部阶段按证据推进，跨业务任务须 verified 且前置已集成；读取共享资源快照，计入其他 Run 以及本 Run 实现、验证、Review、集成和未结算子进程的占用，按 reservation_id 去重。
- 文件所有权、资源容量和 Worker 槽位为硬约束；集成候选必须携带 T7 计算的回归资源集合。
- 用确定性分支定界求最大基数可行集合；候选按 ready_since 升序、剩余关键路径 estimated_seconds 降序、id 字典序排序，等基数集合按成员索引序列取字典序最小者。
- ready_since 来自持久事件。
- 严格最大基数不保证有界等待；长等待仅报告，不自动降低目标或抢占。
- 第一版不引入额外求解器依赖。

#### F6：分片求解与预算恢复

每片最多访问 sliceNodes 个搜索节点，并由 worker thread 的单调时钟按 sliceMs 分段交回进度；纯函数不读时钟。

search_checkpoint 包含待搜索 frontier、当前最优集合、上下界、累计节点数和 input_hash。累计达到 maxNodes 仍未证明最优时返回 budget_exhausted/exact=false，不派发该轮候选，status 报告阻塞原因和上下界。相同输入与预算不得自动从头重试；resume 只在明确提高 maxNodes 后从原 frontier 继续，或调度输入变化后重新求解。

心跳、无关日志不改变 input_hash；资源占用、候选资格或依赖证据变化则取消旧搜索。旧结果即使 exact=true，输入哈希或注册表修订号已过期也不能派发。

协调器不等待整个求解完成才处理消息；持续后台求解期间仍处理 settlement、ack、撤标及恢复。worker 线程退出不等于业务 Worker 退出，丢失的求解进度最多重做最后未持久化片段。

**测试断言:**

- [ ] A 同时冲突 B/C、B/C 互不冲突且容量 2 时选 B/C。
- [ ] 三个独立任务容量 2 时只选两个。
- [ ] shared/exclusive 正确互斥。
- [ ] 业务依赖缺少 integrated_checkpoint 时不释放。
- [ ] 相同输入结果确定。
- [ ] 用小图穷举 oracle 校验最大基数。
- [ ] 已运行 Worker 占用被计入。
- [ ] 验证阶段可调度且计槽位。
- [ ] 持续出现 B/C 时与两者冲突的 A 可被延后，报告此限制而不伪称防饥饿。

**专项验收：**

- [ ] F2/F4：共享快照中的跨 Run 占用和集成回归资源参与可行性判断，本 Run 已登记资源不重复扣减。
- [ ] F6：小图分片恢复与一次求解得到相同精确解；预算耗尽保留 frontier，不派发且不重复搜索；提高预算后继续；过期 input_hash 的精确结果被丢弃。
- [ ] F6：以可控同步屏障挂起求解 worker，证明主事件循环仍能响应消息；测试不得只靠机器速度或长 sleep 判断通过。

### Task 6: Issue 验收转为可派发 DAG 与 Brief

**依赖与角色：** T2（传递依赖 T1）；backend_implementer → backend_validator → reviewer。

**共享约束：** 附录 B.1–B.2、B.6。

**Files / owned_files:** `scripts/orca-dag/planner.mjs`、`scripts/orca-dag/brief.mjs`、`scripts/orca-dag-planner.test.ts`。

**Interfaces:**

- **Consumes:** T1、T2 snapshot 和经主协调器审阅的任务分解 JSON。
- **Produces:** `compileDag(snapshot, decomposition): DagResult`、`renderBrief(task, facts): string`、`analyzeScopeImpact(delta, currentDag, acceptanceMap, decomposition): ScopeImpact`（返回 affected/unaffected/removed_task_ids、传递影响、失效理由、需求哈希和承接资格）、`compileRecovery(decision, reviewedRepairDecomposition, currentDag): RecoveryPlan`。RecoveryPlan 包含阶段入口、修复子 DAG、证据失效集合及轮次；无代码修复时分解可为空，repair 必须提供经主协调器审阅的分解。任务分解由协调器依据 Spec/ADR/Issue 作出，不从自然语言自动猜出可信依赖。

**实施要求:**

- 检查唯一 ID、依赖引用、自环、环路路径、验收覆盖、文件所有权和接口消费者/生产者；按附录 B.1 阶段门禁表生成 implement/validate/review/integrate 节点及带 condition 的边，业务 Task 只作聚合，不形成自等待。
- 聚合父 Issue 不重复实现。
- 推断边带证据；未解决冲突节点不 ready。
- Brief 含单任务上下文、报告路径、前置产物、角色、检查点策略、禁止再派发及失败处置。

**测试断言:**

- [ ] A→B→C→A 返回具体闭环。
- [ ] 缺失验收映射拒绝派发。
- [ ] 子 Issue 已覆盖父要求不重复生成实施任务。
- [ ] 未知写范围触发仓库独占。
- [ ] 未批准的推断依赖不能当事实静默使用。
- [ ] 业务依赖指向最终验收结果。
- [ ] 内部链在 implemented 后可正常推进。
- [ ] 验收变化使已 verified 节点及受影响后继失效，无关节点保持有效。

**专项验收：**

- [ ] F1：Review finding 生成只覆盖受影响文件的修复 DAG，旧 Task 已完成部分不重派；环境故障仅重试阶段；缺修复分解或超出轮次上限时返回 blocked。
- [ ] F3：新增无关 B 时运行中的 A 属于 unaffected 并获得承接资格；接口或前置检查点变化时 A 属于 affected；三类任务互斥且覆盖全部现有任务。

### Task 7: 工作区、检查点和验收集成门禁

**依赖与角色：** T3、T4（传递依赖 T1）；backend_implementer → backend_validator → reviewer。

**共享约束：** 附录 B.4–B.5。

**Files / owned_files:** `scripts/orca-dag/workspaces.mjs`、`scripts/orca-dag/checkpoints.mjs`、`scripts/orca-dag/gates.mjs`、`scripts/orca-dag-workspaces.test.ts`。

**Interfaces:**

- **Consumes:** T3 Ledger/资源接口、T4 OrcaClient。
- **Produces:** `prepareWorkspace(task, base): Promise<WorkspaceReceipt>`、`captureCheckpoint(workspace, ownedFiles, baseline, prerequisiteCheckpoints): Promise<Checkpoint>`、`evaluateGate(task, evidence): GateResult`、`buildIntegrationVerificationPlan(task, integratedTasks, integrationWorkspace): Promise<IntegrationVerificationPlan>`、`integrateCheckpoint(task, checkpoint, integrationWorkspace, evidence, verificationPlan, reservations): Promise<IntegrationReceipt>`、`reconcileIntegration(intent, integrationWorkspace): Promise<IntegrationRecovery>`。集成入口核验全部预留 token、计划哈希和目标树；不允许调用方省略资源门禁。

**实施要求:**

- Orca 管理独立 Worktree，记录完整工作区 ID 与 BASE；使用 T4 注入调用器，不再实现第二套 Orca 启动逻辑。
- 未提交交付捕获 staged/unstaged/untracked/deletions 和哈希；只转移授权增量，冲突保留并阻塞。
- 集成唯一写入者；验证者只读，reviewer 输出两个结论。
- 所有权外改动拒收，代码变更使原验证失效；保留任务来源和既有改动基线。
- 实现附录 B.5 的集成事务和完整受测树协议；prepareWorkspace 必须显式转移并核验前置检查点，integrateCheckpoint 只有在精确结果树补验通过后返回 validated。

**测试断言:**

- [ ] untracked 和删除文件均进入检查点。
- [ ] 越权文件拒收。
- [ ] 脏目标工作区无关文件保留。
- [ ] 哈希变化拒绝复用测试。
- [ ] 集成冲突不释放下游。
- [ ] 前置产物确实存在于消费者工作区。
- [ ] 新建 Worktree 未自动带入父目录未提交文件时明确补齐和核对。
- [ ] 写入完成但回执前崩溃不重放增量。
- [ ] 多文件写入中崩溃逐文件对账。
- [ ] 第三种内容阻塞。
- [ ] A/B 文件不相交且分别通过但组合失败时不得 verified。

**专项验收：**

- [ ] F2：A 已集成且回归需要独占数据库，C 正在使用该数据库时，B 的集成不得写目标文件或运行回归；C 安全释放后 B 才执行 A/B 检查。串行检查的 shared units 取最大值，任一 exclusive 要求升级整次预留。
- [ ] F2：预留后目标树或集成集合变化时重新规划；崩溃后仍有测试进程占用时不释放资源、不重跑同一检查。
- [ ] F1：组合失败保留故障树和恢复声明；修复从该树构建新检查点，经独立 Review 后新事务恢复集成，普通候选不得越过故障树。

### Task 8: 事件驱动的协调循环与操作入口

**依赖与角色：** T3、T4、T5、T6、T7；backend_implementer → backend_validator → reviewer。

**共享约束：** 附录 B、C。

**Files / owned_files:** `scripts/orca-dag/coordinator.mjs`、`scripts/orca-dag/cli.mjs`、`scripts/orca-dag-coordinator.test.ts`、`scripts/orca-dag/issue-status.mjs`、`scripts/orca-dag-issue-status.test.ts`、`docs/agents/orca-dag.md`。

**Interfaces:**

- **Consumes:** T3–T7。
- **Produces:** `buildIssueReviewSync(issue, dag, evidence): IssueReviewSync`、`syncIssueReviewStatus(record, githubTransport, claimGuard): Promise<SyncReceipt>`（位于 issue-status.mjs；claimGuard 在每次副作用前核验当前声明/epoch/generation，摄取模块保持只读）、`recordRecovery(context, decision, reviewedRepairDecomposition): Promise<RecoveryPlan>`、`acceptCarriedResult(context, stageResult, carryForward): Promise<GateResult>`、`tick(context, event): Promise<TickResult>`。event 可为 Orca Delivery、求解进度/完成、资源变化或已核验控制输入；均经单一协调器串行应用。

#### CLI 与控制入口

```text
node scripts/orca-dag/cli.mjs <ingest|plan|dry-run|start|resume|rescan|status|recover> --config <path>
```

recover 另需 `--decision <path>`，代码修复另需 `--decomposition <path>`。这些是待实现工具命令，不是现有 Orca 命令。

首次配置写入 root_issue；start/resume 必须匹配冻结 scope_revision。rescan 只生成范围差异，协调器核验并写入 scope_revision 变更事件后才能派发新增任务。

recover 提交按 schema 校验的裁决，受现有范围/授权及单协调器锁约束，不自动扩大所有权。

searchBudget 提高通过 resume 记录为控制事件，保留历史预算和 frontier。recover 和 resume 的控制变更在有活跃协调器时通过持久控制 inbox 交付，无活跃协调器时必须先取得 Run 锁并对账。

**实施要求:**

- 单协调器在调度相关事件处理后启动或更新后台精确求解；只有结果仍匹配当前输入且 exact=true 时，才经 T3 资源预留、Issue 声明和阶段启动意图启动工作。
- 处理问题/escalation、校验阶段与 Dispatch、持久化结果、为 settled Worker 决定 reuse/retain/release（retain 仅有用户请求时），最后 ack；不为等待求解或修复规划而扣住已处理 Delivery。
- worker_done 按阶段类型处理，不能统一当实现完成；失败按 RecoveryDecision 推进，待审阅修复分解时保留 blocked 并继续无关任务。
- 启动前对账已有 Orca Run/Worker 和 Ledger，禁止重复领取已在实施的 Issue；其他 Run 的工作未经明确转交不接管。
- 连续三次空等待后分页 enumerate Worker；unverifiable 不释放资源或重试。
- 恢复在消息重放前对账资源、声明、启动意图和集成 intent，再恢复求解 frontier 及控制 inbox。
- 处理阶段门禁、范围承接和 rescan 的原子版本迁移。
- 实现逐 Issue 审核就绪判定、同步声明、持久 outbox、幂等评论、标签同步及失效撤标；工具开发自身 source_issues=[] 时不产生 GitHub 写操作。
- 操作手册纳入 F1–F6 的配置、恢复命令、预算耗尽状态、声明移交和验收场景，并纳入 T9 完整审查。

**测试断言:**

- [ ] A/B 并行，A 验收集成后立即启动 C 而 B 仍运行。
- [ ] 同一 Delivery 重放不重复启动或集成。
- [ ] 收到已被替代的旧 Dispatch 完成只归档。
- [ ] 启动回执丢失后 resume 先对账。
- [ ] 遇到未退出 Worker 不新开编辑者。
- [ ] start 与 dry-run 互不混淆。
- [ ] 两个并发 CLI 只有一个获得协调权。
- [ ] 启动配置更换根 Issue 或范围版本不匹配时拒绝。
- [ ] rescan 不自动启动新增任务。
- [ ] 依赖/验收变更使受影响的已 verified 任务进入 revalidation_required，未获承接的旧版本完成消息不得放行。
- [ ] 不同 Run 竞争同一 Issue 不重复启动。
- [ ] 完整 implement→validate→review→integrate→下游链无死锁。
- [ ] 集成崩溃恢复先对账后 ack。

**专项验收：**

- [ ] F1：Review 拒绝→持久裁决→新修复 attempt→验证→独立 Review→集成→下游启动；恢复重放不重复修复。环境故障仅重试失败阶段，集成回归失败按故障树修复，超限和未知写入者分别保持 blocked。
- [ ] F3：A 运行期间 rescan 新增无关 B，A 的旧版本结果经承接正常推进且只实施一次；连续两次无关 rescan 仍可承接；中间一次前提变化则拒绝承接并进入重新验证。分别覆盖消息先到、迁移先到及重放。
- [ ] F2/F4：集成等待数据库时其他无冲突任务继续；跨 Run 资源领取失败重新求解，不启动未取得资源的 Worker。
- [ ] F6：受控求解 worker 挂起时仍处理 worker_done、ack 和失效撤标；maxNodes 耗尽后不忙循环，status 可读取，resume 增加预算后从保存节点继续；资源改变使旧求解结果失效。
- [ ] 控制入口：两个 recover 并发提交同一 decision_id 仅生效一次；活跃协调器收到控制输入，不出现第二个写入者；dry-run 不启动求解线程之外的业务 Worker，不领取执行资源、不写 GitHub。

**Issue 同步测试断言（orca-dag-issue-status.test.ts）：** worker_done、局部 Task 完成、缺 OCR 或 stale 证据均不贴标签；完整 Issue 通过后先评论后贴标；父级缺聚合验收不贴标；closed Issue 不重开；无 source_issues 不写 GitHub；标签已存在不重复创建且保留其他标签；重复事件或评论回执丢失后对账不重复发评论；403 只阻塞同步不重派实现；rescan 使待添加请求过期，已添加标签被撤回；撤标失败有明确过期警告；跨 Run 移交后旧 generation 不再写入。dry-run 下 transport 写调用为零。

**专项验收：**

- [ ] F5：父 Issue 的验收全部映射到子任务、没有自己的实施 Task 时，聚合验收与 OCR 通过后仍领取父 Issue 的 review_sync 声明，先评论后贴标，且不领取整树。另一个 Run 持有父 Issue 声明时仅同步等待；未完成 outbox 或在途请求阻止声明释放；移交后旧 epoch 的评论和标签调用均被拒绝。

### Task 9: 故障演练、独立 Review 与完整范围 OCR

**依赖与角色：** T8；backend_validator / reviewer；OCR 由主协调器调用。

**共享约束：** 1.2–1.3、4.2。

**Files / owned_files:** 验证者仅写本轮 `reports/`；可生成测试临时目录；不得改业务代码和测试源码。发现缺失测试时由主协调器派发原实现者补充。

**Interfaces:**

- **Consumes:** T8 集成检查点（含操作手册）。
- **Produces:** 故障演练报告、Spec/quality Review、OCR 每轮报告和 finding rulings。

- [ ] 运行 `E2E_UNIT_SCOPE=scripts bun run test -- scripts/orca-dag-*.test.ts`，确认测试选择参数按实际 runner 使用文件列表传入；报告逐套件用例数，不接受零用例通过。
- [ ] 使用假的 GitHub/Orca transport、临时真实 Git 仓库，演练分页失败、重复消息、崩溃恢复、资源冲突、过期尝试和证据失效；不启动真实收费模型调用。
- [ ] 对 F1–F6 各保存一条完整行为轨迹：失败修复闭环、集成回归资源争用、在途范围承接、双进程跨 Run 互斥、无实施父节点同步、求解期间消息响应及预算恢复。记录测试名称、检查点哈希和结果；缺任一轨迹不得以其他测试通过替代。
- [ ] 独立 reviewer 只读审查完整工具改动，输出 Spec compliance 与 code quality。
- [ ] 主协调器按 open-code-review Skill 直接运行 workspace OCR，覆盖全部未提交交付；若同时存在已提交交付，再覆盖原始 BASE..HEAD。保存 exit code、覆盖和失败文件，不能将 exit 0 视为自动通过。
- [ ] 有效 critical/high/medium finding 进入编号修复 DAG，由对应实现者修复、验证者验证、reviewer 复审，再完整 OCR；provider/凭据故障记录为阻塞。

**验收:** 所有 A1–A9 的离线可验证部分及 F1–F6 行为轨迹有证据；Review 通过；OCR 覆盖完整且无有效阻塞问题。此 Task 不声称真实根 Issue 范围运行完成。

### Task 10: 独立真实运行计划交接（条件阶段）

**依赖与角色：** T9；真实 root_issue 与运行授权为条件输入；主协调器 → reviewer。

**共享约束：** 第 5 节、附录 C。

**Files / owned_files:** 仅独立运行目录中的授权记录、运行计划与交接报告；业务代码所有权由后续真实 DAG 单独定义。

**Interfaces:** Consumes T9 通过报告；有真实 root_issue 及运行授权时，Produces 独立运行计划，引用 R0–R7、工具版本、BASE、配置与预算。没有这些输入时输出明确的未启动记录；不阻塞 T1–T9 工具交付，也不声称真实试点通过。

- [ ] 记录已获得的根 Issue、授权范围、并发预算和工具审查证据；缺失项列为真实运行前置条件。
- [ ] 在独立运行计划中安排 R0–R4 摄取、分解和 dry-run，随后分开定义试点、全量执行及各自验收。本文交接本身不启动这些步骤。
- [ ] 试点优先选择两个独立就绪任务和一个后继；真实结构不足时记录无法验证的并行行为，改用实际可用切片作有限试点，不虚构 Issue，不宣称完成完整并行试点。离线并行验收仍由 T9 完成。
- [ ] 独立运行仅在已授权范围内实施；真实业务 Worker 的所有权、检查点、独立 Review、OCR 和修复闭环全部由真实 DAG 管理，不能沿用本工具计划的文件边界。
- [ ] 全量运行以试点通过且已有全量授权为前提；最终按 R6 完成根级验收、完整范围 OCR 和持久证据，并按 R7 完成各 Issue 的待人工审核同步；同步失败单独报告。提交、推送、合并、发布及关闭 Issue 仍依已有独立授权。

**验收:** 工具交付以 T1–T9 verified 为准；T10 交接完成不等于试点或业务实施完成。真实运行单独报告未启动/进行中/阻塞/完成及证据。

<a id="completion"></a>

## 4. 完成条件与 Ledger 起点

### 4.1 计划覆盖检查

以下勾选只表示文档覆盖，不能作为实现或真实运行通过的证据。

- [x] A1–A9、F1–F6 均映射到任务、接口和行为断言。
- [x] T1–T10 编号唯一，依赖引用存在，无自环或循环；文件所有权与角色已列出。
- [x] 工具开发 DAG、工具运行时协议、真实业务 R0–R7 分开定义；真实 Issue 树尚未摄取。
- [x] 阶段门禁、跨 Run 声明、资源预留、集成事务、受测树证据、范围承接、Orca 能力核验、公平性边界及同步恢复均有对应约束。
- [x] 共享 schema 由 T1 独占；修改时停止受影响消费者并重新校验。
- [x] 本次整理仅修改计划文档，未启动 Worker 或实施工具代码。

### 4.2 工具交付条件

- [ ] T1–T9 均 verified，交付范围内验收、适用测试和静态检查通过。
- [ ] 独立 reviewer 的 Spec compliance 与 code quality 均通过。
- [ ] OCR 覆盖全部交付改动，所有有效 critical/high/medium 问题已修复并复审；低风险延期项有明确记录。
- [ ] T9 保存 F1–F6 的实际行为轨迹、检查点哈希和报告路径。
- [ ] Issue/DAG、验证、Review/OCR、finding 裁决与风险均保存为持久证据，最终 Diff 仅含授权范围。

T10 为条件交接阶段，不阻塞 T1–T9 工具交付。真实试点、全量运行和 GitHub 同步分别报告状态及证据，不由工具交付推定完成。

### 4.3 执行 Ledger 起点

| 记录 | 当前值或填写时机 |
| --- | --- |
| 原计划记录的起始 HEAD | `129fed8edd5bdce751270441269df4e9e39a7d0b`；仅作历史记录 |
| 工具任务状态 | T1–T10 均 pending，见 2.2 |
| 执行工作区与 BASE | 实施前建立隔离工作区后记录；不能直接沿用历史 HEAD |
| 计划副本与事实源 | 显式复制并核对 SHA-256，记录相关未提交基线 |
| Orca Run ID、有效角色配置、预算 | 启动前核实并写入 Ledger |
| 每 Task 检查点、验证与审查 | 随任务推进追加；证据绑定同一检查点哈希 |
| 真实 root_issue 与运行授权 | T10 的独立运行计划记录 |

上述启动输入未记录和核实时，保持未启动状态。恢复执行先读取 Ledger 和 Git，核对已集成检查点及当前证据后再派发。

<a id="runtime"></a>

## 5. 真实业务运行流程 R0–R7

这组是工具完成后的实际运行步骤，与 T1–T9 的工具开发任务及 T10 运行交接分开记录：

| ID | 动作 | 依赖 | 可检查产物 |
| --- | --- | --- | --- |
| R0 | 解析根 Issue、核对授权范围、执行工作区和并发预算 | 无 | scope.json，包含 root_issue 和执行 BASE |
| R1 | 递归扫描根及全部子 Issue、讨论和依赖 | R0 | Issue 快照、contains 图、分页与完整性清单 |
| R2 | 核验 closed/进行中节点的 Git 与现有 Orca 执行证据 | R1 | satisfied/in-progress/external-blocked 分类 |
| R3 | 对照 Spec/ADR 分解任务、补父级未覆盖验收、校验 DAG | R2 | dag.json、验收映射、带证据的依赖边 |
| R4 | 保存详细计划、Brief、接口和所有权预检，计算 dry-run | R3 | writing-plans 计划、可派发集合及延迟原因 |
| R5 | 按最大可行集合派发，事件到达后持续补位 | R4 | Orca Run/Task/Dispatch、检查点、验证和 Review |
| R6 | 聚合根 Issue 验收、完整范围 OCR、修复与复审 | R5 的全部交付节点 verified | 根验收报告、OCR 和最终范围证据 |
| R7 | 按 Issue 同步待人工审核标签和交付评论 | 该 Issue 满足附录 C 的审核就绪条件；根 Issue 还须 R6 通过 | 标签、评论 URL、同步回执或待同步故障记录 |

R1 不完整时不得宣称全树已扫描；仅当可证明局部验收及前置条件完整时，才允许 R3–R5 处理不受影响的部分。根 Issue 无子项时直接将自身需求分解为任务；父节点不重复实现已由子节点覆盖的工作。R5 内按真实 DAG 并行，R0–R4 是准备步骤，不能为提高并行度跳过依赖核验。

<a id="contracts"></a>

## 附录 A：数据契约

T1 负责冻结 `contracts.schema.json`；所有消费者使用同一契约。字段与状态约定如下：

### A.1 任务、阶段与依赖

- Task：`id/source_issues/acceptance/depends_on/owner_role/validator_role/owned_files/interfaces/verification/status`，另含 `kind/resources/priority/estimated_seconds`。
- 业务状态：`pending/ready/running/implemented/validating/reviewing/integrating/verified/blocked/failed/unverifiable/revalidation_required`；不能从 worker_done 直接跳到 verified。阶段节点另用 `pending/ready/running/succeeded/failed/blocked/unverifiable`，两种状态不得混用。
- Dependency：`from/to/condition`；condition 为 `artifact_ready/validation_passed/review_passed/integration_validated/business_verified`，附证据引用。业务任务依赖只使用 business_verified；内部阶段使用附录 B.1 的条件表。
- StageAttempt：`task_id/attempt_id/stage/stage_attempt_id/orca_task_id/dispatch_id/outcome`；attempt_id 标识业务产物轮次，stage_attempt_id 标识一次阶段执行，集成阶段不要求 Orca Task/Dispatch。

### A.2 资源与执行权

- Resource：`scope(workspace|repo|host)/scope_id/key/mode(shared|exclusive)/units`；容量为正整数；未知写范围按仓库独占处理。verification 中每条检查必须声明 resources，确实无共享资源时显式使用空数组。
- ResourceReservation：`reservation_id/run_id/holder_id/resources/registry_revision/token/status`；holder_id 为阶段尝试或集成 ID，status 为 reserved/active/released/unverifiable。
- Claim：`repo/source_issue/run_id/purposes(implementation|review_sync)/holders/token/epoch/status`；holders 记录 Task/Attempt 或 outbox ID，同仓库跨 Run 共享声明注册表。纯同步持有者不需要伪造 Task/Attempt。

### A.3 证据、恢复与范围迁移

- Evidence：`task_id/attempt_id/checkpoint_hash/base_commit/prerequisite_checkpoints/tested_tree_hash/requirements_hash/scope_revision/commands/results/review_status/integrated_checkpoint/validity`；validity 为 current/stale，历史记录不覆盖。
- RecoveryDecision：`decision_id/task_id/failed_stage_attempt_id/kind(retry_stage|repair|revalidate|blocked)/reason/evidence_refs/repair_round/resume_stage/invalidated_evidence_ids`；同一失败事件只能产生一个生效裁决。
- ScopeCarryForward：`task_id/attempt_id/stage_attempt_id/from_revision/to_revision/requirements_hash/prerequisite_checkpoints/ownership_hash/evidence_refs/status`；status 为 eligible/accepted/rejected，保留原始结果及迁移证据。

### A.4 集成事务与验证

- IntegrationIntent：`integration_id/task_id/attempt_id/checkpoint_hash/target_workspace/pre_tree_hash/post_tree_hash/file_manifest/verification_plan_hash/reservation_ids/status`；状态为 prepared/applied/validated/blocked。
- IntegrationVerificationPlan：`target_workspace/target_tree_hash/integrated_checkpoints/checks/resources/verification_plan_hash`；checks 包含命令、预期结果及资源声明。

### A.5 事件、投影与 Issue 同步

- Event：`event_id/run_id/task_id/attempt_id/stage_attempt_id/type/payload/recorded_at`；Delivery ID 与 Dispatch ID 保留原值，无阶段的事件允许 stage_attempt_id 为空。
- RuntimeState：任务、资源预留、权威阶段尝试、恢复裁决、范围承接记录、待对账启动、已处理消息、待 ack Delivery、求解进度及 Issue 标签同步 outbox 的投影。
- IssueReviewSync：`repo/issue_number/run_id/scope_revision/requirements_hash/checkpoint_hash/evidence_refs/desired_ready/generation/status/comment_id/idempotency_key/sync_claim_token/claim_epoch/last_error`；status 为 pending/synced/failed/unverifiable，独立于业务 Task 状态；尚未领取声明时 token/epoch 为空，此时不能写 GitHub。

### A.6 调度决策

- ScheduleDecision：`selected/deferred/objective/algorithm/exact/diagnostics/input_hash/search_status/search_checkpoint/explored_nodes`；search_status 为 searching/exact/budget_exhausted/cancelled，非 exact 结果的 selected 只能用于诊断，不得派发。

所有模块对外接受/返回符合该 schema 的 JSON 对象；不依赖隐式全局工作区。外部进程使用 argv 数组而非 shell 拼接。

<a id="protocols"></a>

## 附录 B：阶段推进、执行权与恢复协议

### B.1 阶段门禁（T1 定义，T5/T6/T7/T8 实现）

业务 Task 是聚合对象，不作为内部阶段必须等待 verified 的前置节点。每个业务 Task 展开以下有限阶段链，阶段完成后标 succeeded，业务 Task 直到最后一阶段通过才标 verified：

| 阶段 | 进入条件 | 完成产物 |
| --- | --- | --- |
| implement | 上游业务 business_verified，且前置产物已进入本工作区 | artifact_ready：实现检查点，Worker 已接受 settlement |
| validate | artifact_ready | validation_passed：针对该受测代码树的通过证据 |
| review | validation_passed | review_passed：独立 Spec 与质量结论 |
| integrate | review_passed | integration_validated：应用回执和集成代码树验证 |

下游业务边等待 integration_validated 汇总为 business_verified；不得把内部 validate 的前置写成同一业务 Task verified。集成由协调器串行执行，不启动实现 Worker。验证和 Review 各占真实 Worker 槽位，复用终端不得复用实现者身份批准自己的实现。实现 settlement 后释放其计算槽位，保留不可变产物；验证/Review 对同一快照只读，后续修复须等待读者结束再生成新 attempt。

### B.2 失败分类与运行时修复（F1；T1/T4/T6/T7/T8）

业务 Task ID 在修复中保持稳定；每轮产物使用新 attempt_id，每次阶段执行使用新 stage_attempt_id。新阶段或产物修复创建独立 Orca Task/Dispatch；同一产物的失败阶段重试可复用已核实失败的 Orca Task，但必须有新的 stage_attempt_id 和 Dispatch。业务聚合对象不映射成可由 worker_done 完成的 Orca Task。worker_done 的成功只证明阶段工作已完成，Review 的业务通过仍取决于报告结论。

| 失败类别 | 状态与裁决 | 恢复入口及证据规则 |
| --- | --- | --- |
| Worker 已确认退出但未正常结算，或检查环境故障 | 阶段 failed，业务 blocked；持久化 retry_stage 裁决 | 先按 Orca 恢复协议结算旧 Dispatch；同一不可变产物可重试失败阶段，保留仍有效的前序证据 |
| 验证发现代码缺陷，或 Review 有有效阻塞 finding | 阶段 failed，业务 blocked；持久化 repair 裁决 | 主协调器调用 writing-plans 形成仅覆盖 finding 的修复 Brief/DAG；新业务 attempt 从 implement 开始，再执行 validate、review、integrate |
| 集成后回归失败或需要冲突解决 | integration intent 保留 applied/blocked，受影响业务及后继暂停；持久化 repair 裁决 | 保留现场，锁定目标工作区的后续集成；以失败组合树作为修复基线，独立实施者修复并重新验证、Review，最后创建引用旧 intent 的新集成事务 |
| 需求变化但可复用现有产物 | 业务 revalidation_required；持久化 revalidate 裁决 | 按新要求从 validate 开始，重新 Review 和集成门禁；不因重新验证创建实施 Worker |
| 活跃写入者、启动结果或资源占用不可证明 | 阶段 unverifiable，业务 blocked | 只对账，不重试、不新开编辑者；取得正面结算/退出证据后再分类 |

RecoveryDecision 必须先写日志，再生成修复任务或重试阶段；重放同一 finding/失败事件不得再创建一轮。原有审查和验证记录保留为历史，新产物不得继承旧产物的通过结论。修复使已验证产物失效时同步冻结后继并排入撤标 outbox。集成失败后的测试进程确认退出后可释放测试资源，目标工作区的恢复声明继续保留；修复集成只能在该声明下对账后进行，不允许普通集成越过故障树。

修复 attempt 使用新的 Orca 阶段 Task，不对先前成功的实现 Dispatch 使用 `--retry-of`。只有当前版本 Orca 确认的失败 Task 才走失败重试适配，并显式传入原 Task、失败 Dispatch、placement 和角色配置。每个业务任务单个 SDD 修复计划最多 5 轮，第四、五轮按仓库规则升级；连续两轮同一 finding 无进展进入 systematic-debugging，超限或缺必要输入时记录 blocked 和恢复条件。外层 OCR 修复使用独立编号计划，不重置历史计数以伪装进展。

### B.3 仓库级声明（T3/T8）

第一版限定同一主机、同一 Git common dir 的协调器；声明目录固定为该 common dir 下 `orca-dag/claims/`，不能由各 runDir 自选。跨主机或独立 clone 缺少共享权威注册表时禁止 start，不声称支持全局唯一性。

以 repo + source_issue 为保守独占粒度：同一 Run 内多个切片可共用 Run 声明，跨 Run 不可共享。声明按 purpose 记录 implementation 与 review_sync 的持有者，两种用途对其他 Run 同样互斥；同 Run 增加用途不更换 owner。父级聚合 Issue 不因 contains 领取实施声明，但同步其评论/标签前必须领取 review_sync 声明，仅锁该父 Issue，不锁整树。无 source_issues 的工具任务使用明确配置的 scope key。事务内原子领取任务涉及的全部 Issue key，再持久化 attempt 启动意图；任一 key 冲突则不新增任何领取。持有者未知、启动响应丢失或 Worker 未确认退出时不因超时回收。

实施用途在 Run 完成或显式移交且关联尝试安全结算后释放；同步用途还须全部 outbox 已对账、没有在途写请求，且 Run 已结束或完成移交才能释放。纯聚合父 Issue 通过独立同步领取接口使用 outbox ID 作为 holder，无需创建空实施 Task。移交递增 claim epoch，转移未完成 outbox；旧 epoch 禁止新的 GitHub 副作用，无法确认旧在途请求已结束时阻塞移交。

恢复先对账注册表与 Run 日志；领取后、写启动意图前崩溃留下的声明保持 reserved，只有能证明启动调用必需的持久意图尚未发生，或取得已启动尝试的正面退出/结算证据，才可恢复或释放；仅枚举不到 Worker 不算退出证据。已有非本工具 Orca Worker 仍须启动前检查；无法证明其范围不重叠时阻塞，不能将本工具锁宣传成对任意外部编辑者的强制锁。

### B.4 资源作用域与跨 Run 预留（F2/F4；T1/T3/T5/T7/T8）

资源身份为 scope + scope_id + key：workspace 使用核验后的工作区身份，repo 使用规范化 Git common dir，host 使用本地主机身份。实际共用的数据库、端口和外部产物目录必须使用相同的 host 资源 key，不能按 Run 或工作区改名规避冲突。容量取共享注册表中的定义，Run 配置只能收紧自身预算，不能覆盖共享容量；容量定义冲突时 preflight 拒绝启动。

T3 在当前操作系统用户的固定目录 `~/.local/state/orca-dag/resources/<host-id>/` 维护所有上述作用域的资源注册表、修订号和持久事务日志，runDir 不能自选注册表位置。第一版仅保证同一用户、同一主机的受管 Run；跨用户/主机或不受管占用无法证明安全时阻塞，不声称强制隔离。Issue 声明仍使用 Git common dir 下的注册表。

每次派发先读取全局资源快照求解，再在资源注册表锁下核对修订号并原子预留所选集合的全部资源；任一资源冲突则全部失败并重新求解。随后按 holder 领取 Issue 声明和持久化阶段启动意图，成功后才启动副作用。某 holder 的 Issue 领取失败且可证明未写启动意图时，只释放该 holder 尚未使用的新预留，不释放同批已经启动的其他 holder 的资源；崩溃留下的预留按 Run 日志对账，不能因超时回收。所有入口遵守资源预留→Issue 声明→启动意图的顺序，避免反向等待。

资源预留覆盖实现、验证、Review、集成及其测试子进程。原子领取可以返回同一 holder 的多个 reservation_id，使工作区独占资源与测试资源可在满足各自释放条件时分别结算。accepted settlement 只有同时证明该阶段的资源使用已结束才允许释放；遗留子进程占用记 unverifiable。同步声明不占模型 Worker 槽位。T5 只读取快照并计算，实际资源领取、释放和恢复均由 T3 完成；不同 Run、不同 Issue 也必须经过同一资源仲裁。

### B.5 集成事务与证据（T3/T7）

幂等键为 task_id + attempt_id + checkpoint_hash + target_workspace。集成锁覆盖准备、写入、回执及集成验证。写文件前持久化 intent（日志 fsync 后才允许副作用），记录完整前置树哈希、预期结果树哈希及每个授权文件的前后哈希、删除和模式信息。state.json 为可重建投影；替换后同步目录。半写日志尾部不得静默跳过，保留异常证据并从最后有效记录与 intent 对账。

恢复若目标等于 pre_tree_hash 则尚未应用，可继续；等于 post_tree_hash 则已应用，只补回执与缺失验证，不能重放增量；部分写入只有在逐文件均为已记录前态或后态、没有第三种内容且写权限仍独占时才可完成剩余写入。出现外部修改或无法证明所有权则 blocked，保留现场，不盲目覆盖或回滚。

checkpoint_hash 标识授权增量；tested_tree_hash 标识完整受测代码输入，包含 BASE、前置增量及相关未跟踪源码/配置，排除显式列出的日志、凭据、缓存和构建产物。独立 Worktree 的通过结果不自动证明合并后通过：每次集成必须在精确结果树上运行该任务验证及所有已集成任务声明的回归检查，再释放下游。集成引入冲突解决或任何超出已审查增量的内容时，必须形成新检查点并重新独立 Review，不能仅靠补测放行。后续集成改变树时旧树证据保留为历史，未完成补验前不能把其当当前组合的通过证据；行为失败阻塞集成门禁及受影响后继。

集成前构建 IntegrationVerificationPlan，固定目标树版本、已集成检查点列表、检查命令及资源集合，并计算 verification_plan_hash。第一版串行运行这些检查：同一资源只要任一检查要求 exclusive 就按 exclusive 领取，否则 shared 的 units 取各检查最大值；合并 workspace 独占集成资源及其他所需资源，一次原子预留整个集合。资源未就绪时不写目标文件、不启动测试。预留后再次核对目标树与已集成集合，变化则释放未使用的预留并重算计划。正常集成在全部检查进程结束后释放预留；失败时可释放测试资源，保留工作区独占预留。修复事务凭旧 intent 和 RecoveryDecision 原子承接该工作区预留并领取新的测试资源，不先释放故障树锁，也不再次争抢自己持有的预留。集成不占模型 Worker 槽位，但必须占用其实际使用的测试资源。锁住集成入口不能替代数据库、端口等资源预留。

### B.6 范围变化与证据失效（T2/T6/T8）

T2 仅输出 Issue 级 added/removed/changed 和变更字段；T6 使用当前 DAG、验收映射及新分解计算任务影响闭包，并将现有任务完整划分为 affected、unaffected、removed。验收、接口、依赖或批准 Spec 变化使对应 requirements_hash 失效，已 verified 任务进入 revalidation_required，下游暂停。纯展示字段变更可由协调器记录理由后保持有效。重新验证通过可恢复 verified；确需改代码才创建修复 attempt，且旧写入者必须已安全结束。被移出范围的既有改动必须记录保留/后续处置裁决，不自动撤销。

scope_revision 迁移、受影响证据失效和未受影响任务的 ScopeCarryForward 资格作为同一个可重放事件生效。requirements_hash 只包含该任务的规范化需求、相关 Spec/ADR、接口及前置条件，不包含全局 scope_revision 或无关 Issue 字段。对 unaffected 的在途阶段，保留原 Dispatch 权威性；结果到达时核对需求哈希、前置检查点、接口/所有权哈希及结果代码检查点，全部匹配才原子记录 accepted 承接和正常阶段推进。原始证据保留旧版本，另建引用原证据的新版本绑定，不能直接改写旧记录。已 verified 的无关任务也必须留下承接依据。经历多个 rescan 时逐次核对完整承接链，不能跳过中间失效版本。

affected 的旧结果归档后，阶段执行仍须完成 settlement/资源结算；业务状态显式进入 revalidation_required 或 blocked，再按失败分类协议处理，不能永久留在 running。removed 的任务停止后续派发，已有执行按生命周期安全结算后记录移出范围裁决。版本迁移与消息到达通过同一 Run 修订号串行化；重复 Delivery 或恢复重放只生效一次。旧版本结果只有有效承接记录才能推进当前门禁，受影响结果不能借承接绕过重新验证。

<a id="review-sync"></a>

## 附录 C：Issue 完成与人工审核同步（T1/T8/T9）

标签固定为 `agent:ready-for-review`，含义为“Code Agent 已完成实施及自动审查，等待人工审核”，不代表人工已批准或 Issue 已关闭。GitHub 标签只是展示投影；Git、验收证据和 Ledger 才是事实源，不从标签反推 verified。

### C.1 逐 Issue 触发条件

该 Issue 的全部实施任务 verified、验收映射完整、产物已集成、适用测试及独立 Spec/质量 Review 通过，而且覆盖其完整交付范围的 OCR 与修复复审通过，证据仍匹配当前需求和代码检查点。worker_done 或单个 Task 完成均不足以触发。若只在 R6 做整批 OCR，子 Issue 也等到该审查覆盖通过后才标记；若提前完成该 Issue 的完整范围 OCR，可以先标记，之后范围变化仍须失效处理。父 Issue 必须额外通过自身聚合验收，不能仅凭子 Issue 标签齐全标记。已 closed 的 Issue 不自动重开或贴待审核标签，记录 skipped_closed；需要后续实施时由协调器明确解决状态冲突。

### C.2 交付评论

包含实现摘要、逐项验收结果、测试/独立 Review/OCR 证据、提交 SHA 或未提交检查点哈希、交付工作区/PR 地址及遗留限制，并明确“等待人工审核”。未提交检查点必须说明未推送且提供持久证据位置，不伪造远程可访问链接。评论可更新为“证据失效，已撤回待审核状态”，保留原证据引用和失效原因。Issue 保持 open，人工审核及关闭遵循独立流程。

### C.3 同步协议

T8 在验收事件后写持久 outbox，再领取该 Issue 的 review_sync 声明，将 token/epoch 绑定到 outbox 后执行 GitHub 写入；纯聚合父 Issue 走同一流程。领取冲突只阻塞同步，不回退已验证业务状态，也不重新实施。按 repo + issue 串行同步，每次写入核验当前声明所有者、epoch 和 generation。幂等键包含 Issue、需求哈希、检查点哈希和 desired_ready；评论使用稳定隐藏标识 `<!-- orca-dag-review:owner/repo#number:run_id -->` 查找并更新本 Run 的评论。首次发布先写评论再添加标签；失败保留 pending/failed，只重试同步，不重新实施。标签不存在时可在已授权仓库创建该固定名称标签，保留已有同名标签定义；不得替换整组标签或改动其他标签。写入回执丢失时先读取标签与分页评论对账，未知结果记 unverifiable，避免盲目重复发布。

### C.4 失效与并发

rescan、修复或组合验证失败使证据 stale 时，在同一 Ledger 事件内递增 generation 并排入 desired_ready=false，优先移除标签，再更新评论。每次副作用前检查最新 generation，过期的添加请求取消；副作用后若发现 generation 已变，立即排入补偿撤标。撤标失败必须在 status 和最终报告显式显示“GitHub 待审核标签可能过期”，不能报告同步成功。跨 Run 的同步受仓库级 Issue 声明约束；交接必须转移未完成 outbox，不能让旧 Run 的重试覆盖新 Run。标签/评论写权限不足属于同步阻塞，不改变已验证代码事实，但未同步完成不得声称 Issue 交付同步完成。
