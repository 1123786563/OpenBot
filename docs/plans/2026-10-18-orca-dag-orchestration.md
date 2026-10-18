# Orca DAG Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从用户指定的根 Issue 开始，递归扫描完整子 Issue 树、核验依赖并生成执行 DAG，通过 Orca 持续调度，在依赖、文件所有权和资源容量允许时取得当前就绪集合的最大并行数，并保留验收、审查、集成及恢复证据。

**Architecture:** 单一主协调器拥有派发权；确定性的本地工具负责摄取、图校验、资源选择和执行 Ledger，Orca 负责 Task、Dispatch、Worker 和消息生命周期。业务验收状态与 Orca 执行状态分离；依赖仅在产物已审查、验证并进入下游实际工作区后释放。

**Tech Stack:** 现有 Node.js / TypeScript / Bun 工具链；新增运行工具使用 Node ESM `.mjs`，测试使用仓库 e2e tools-only target 及 `tests/support/e2e-compat.ts`；外部能力经已认证 `gh` 与当前 Orca CLI 调用。

**Spec:** 本文“需求基线”来自 2026-10-18 当前会话的用户要求和前一轮架构讨论，属于待实施设计，尚非独立批准 Spec。未读取真实全量 Issue 树，因此本计划是编排工具的实施任务，不是已经核实的业务 Issue 执行 DAG。

## Global Constraints

- Issue tracker 为 `1123786563/OpenBot`；遵守 `docs/agents/issue-tracker.md`、根 `AGENTS.md`、`CONTEXT.md` 和 `docs/adr/0008-test-runner-tester-army-e2e.md`。
- 本轮只交付计划，不启动 Worker、不创建 GitHub Issue、不提交、推送、合并或关闭 Issue。后续默认使用未提交检查点；没有已有提交授权不得自动提交。
- 当前目录是主工作区，存在大量无关未提交修改。计划文档保存在当前目录供审阅；实施前必须使用 using-git-worktrees + Orca 建立隔离执行工作区，显式复制本计划并核对 SHA-256，记录原始 BASE 和相关未提交事实源。不得假定新工作区带入本目录未提交改动。
- 一个协调器负责整个 Run；Worker 只接收单个 Brief，不递归派发。使用 Orca orchestration，不以非 Orca 子 Agent 替代实际执行。
- 并行实施必须独立 Worktree、写权限不相交、接口稳定；共享数据库、端口、缓存、迁移和产物目录均进入资源模型。
- 只读默认：摄取、规划、dry-run 不启动 Worker。实际 start/resume 的范围和并发预算必须来自已授权运行配置。
- CLI 可执行路径按技能解析一次并持久化；本次核验路径为 `/Applications/Orca.app/Contents/Resources/bin/orca`。执行时重新读取该版本技能，禁止假设未来版本仍使用相同参数。
- 不把 task-list --ready、worker_done、Issue closed 或测试进程 exit 0 单独视作业务验收完成。
- 验证证据绑定代码检查点；完整范围独立 Review、OCR 及修复复审通过才交付。

## Review Focus

1. GitHub 分页中途失败、403/404 或依赖缺失：保存部分证据，受影响节点阻塞，不能静默视为完整。（T2）
2. Worker 启动已发生但响应丢失：先对账并保持未知状态，不派发第二个写入者。（T4、T8）
3. 过期 Dispatch 和重复 Delivery：不覆盖当前尝试，不重复集成，处理后才 ack。（T3、T8）
4. 验证后文件变化或依赖未进入实际工作区：证据失效，不能释放下游。（T7）
5. 最大并发引发饥饿或容量超用：容量硬约束，等基数集合优先老任务及关键路径，调度结果可解释。（T5）

---

## 需求基线与验收映射

| ID | 需求 | 负责 Task |
| --- | --- | --- |
| A1 | 从指定根 Issue 递归扫描完整子树，每个 Issue 有分类、来源和完整性，不把父子关系当执行依赖 | T1、T2、T6 |
| A2 | 无环、验收覆盖、稳定接口和文件所有权预检 | T1、T6 |
| A3 | 当前就绪集合在资源约束下最大并行，完成即补位 | T5、T8 |
| A4 | Orca 原生协调、独立 Worktree、角色路由、权威尝试唯一 | T3、T4、T7、T8 |
| A5 | 验证、独立 Review、集成后释放依赖 | T7、T8、T9 |
| A6 | 崩溃恢复、消息去重、不确定状态安全恢复 | T3、T4、T8 |
| A7 | 完整范围 OCR、修复循环和持久证据 | T9、T10 |
| A8 | 先演练、再真实小范围试运行、最后全范围运行 | T9、T10 |

默认扫描入口为一个根 Issue，`root_issue` 接受完整 GitHub Issue URL 或 `owner/repo#number`。仓库固定为 `1123786563/OpenBot`；根 Issue 指向其他仓库、PR 或无法读取时，启动失败并保留错误，不回退到全仓库扫描。

“全部”固定为根 Issue 本身及其递归子 Issue，包含 open 和 closed；只按状态过滤会遗漏父级验收与实现核验。正式子 Issue 每层处理分页，以 repo + number 去重，保存完整 contains 路径；正文任务链接逐条核验，只有确认的子项进入 contains。普通引用和树外依赖不会自动扩展实施范围。树外依赖只读核验状态、接口和目标代码证据，记录 external_blockers；确需实施时先显式修改范围快照。读取开始和结束时间、每页来源均记录；读取失败明确标注不可知部分并阻塞依赖该部分的任务。closed 节点须经目标代码核验后才标 satisfied。

首次扫描结束冻结 `scope_revision`、根 Issue 身份及树指纹；启动绑定这一版本。新子 Issue 或依赖变化需通过显式 `rescan` 生成差异，保留已 verified 证据并重算受影响节点，不重复派发。若变化推翻运行中任务的前提，暂停受影响节点的后续派发并通知当前 Worker，待核对后继续。全库扫描不属于默认入口。

### 根 Issue 到执行的运行任务

这组是工具完成后的实际运行步骤，与下文 T1–T10 的工具开发任务分开记录：

| ID | 动作 | 依赖 | 可检查产物 |
| --- | --- | --- | --- |
| R0 | 解析根 Issue、核对授权范围、执行工作区和并发预算 | 无 | scope.json，包含 root_issue 和执行 BASE |
| R1 | 递归扫描根及全部子 Issue、讨论和依赖 | R0 | Issue 快照、contains 图、分页与完整性清单 |
| R2 | 核验 closed/进行中节点的 Git 与现有 Orca 执行证据 | R1 | satisfied/in-progress/external-blocked 分类 |
| R3 | 对照 Spec/ADR 分解任务、补父级未覆盖验收、校验 DAG | R2 | dag.json、验收映射、带证据的依赖边 |
| R4 | 保存详细计划、Brief、接口和所有权预检，计算 dry-run | R3 | writing-plans 计划、可派发集合及延迟原因 |
| R5 | 按最大可行集合派发，事件到达后持续补位 | R4 | Orca Run/Task/Dispatch、检查点、验证和 Review |
| R6 | 聚合根 Issue 验收、完整范围 OCR、修复与复审 | R5 的全部交付节点 verified | 根验收报告、OCR 和最终范围证据 |

R1 不完整时不得宣称全树已扫描；仅当可证明局部验收及前置条件完整时，才允许 R3–R5 处理不受影响的部分。根 Issue 无子项时直接将自身需求分解为任务；父节点不重复实现已由子节点覆盖的工作。R5 内按真实 DAG 并行，R0–R4 是准备步骤，不能为提高并行度跳过依赖核验。

## 文件与接口约定

新增实现仅写 `scripts/orca-dag/`；新增测试 `scripts/orca-dag-*.test.ts`；固定 fixtures 位于 `scripts/orca-dag/fixtures/`；操作说明 `docs/agents/orca-dag.md`。不修改应用、计费和既有运行中的任务文件。

运行目录为 `docs/plans/<date>-orca-run-<run-key>/`，包含 `scope.json`、`issues/`、`dag.json`、`briefs/`、`events.jsonl`、`state.json`、`receipts/`、`checkpoints/`、`reports/`。持久事实源不包含凭据及完整环境变量。

T1 冻结 `contracts.schema.json`：
- Task：`id/source_issues/acceptance/depends_on/owner_role/validator_role/owned_files/interfaces/verification/status`，另含 `kind/resources/priority/estimated_seconds`。
- 业务状态：`pending/ready/running/implemented/validating/reviewing/integrating/verified/blocked/failed/unverifiable`；不能从 worker_done 直接跳到 verified。
- Resource：`key/mode(shared|exclusive)/units`；容量为正整数；未知写范围按仓库独占处理。
- Evidence：`task_id/attempt_id/checkpoint_hash/commands/results/review_status/integrated_checkpoint`。
- Event：`event_id/run_id/task_id/attempt_id/type/payload/recorded_at`；Delivery ID 与 Dispatch ID 保留原值。
- RuntimeState：任务、资源预留、权威尝试、待对账启动、已处理消息和待 ack Delivery 的投影。
- ScheduleDecision：`selected/deferred/objective/algorithm/exact/diagnostics`。

所有模块对外接受/返回符合该 schema 的 JSON 对象；不依赖隐式全局工作区。外部进程使用 argv 数组而非 shell 拼接。

## DAG、角色与并行关系

| Task | 交付 | depends_on | owner_role | validator_role | status |
| --- | --- | --- | --- | --- | --- |
| T1 | 冻结契约、配置和生命周期校验 | — | backend_implementer | backend_validator | pending |
| T2 | 从根 Issue 递归摄取与范围快照 | T1 | backend_implementer | backend_validator | pending |
| T3 | Ledger、唯一尝试和恢复投影 | T1 | backend_implementer | backend_validator | pending |
| T4 | Orca 适配与回执核验 | T1 | backend_implementer | backend_validator | pending |
| T5 | 精确最大并行调度 | T1 | backend_implementer | backend_validator | pending |
| T6 | Issue 转 Task DAG 与 Brief | T2 | backend_implementer | backend_validator | pending |
| T7 | Worktree、检查点、验收集成门禁 | T3、T4 | backend_implementer | backend_validator | pending |
| T8 | 持续补位协调循环与 CLI | T3、T4、T5、T6、T7 | backend_implementer | backend_validator | pending |
| T9 | 故障演练及全工具审查 | T8 | backend_validator / reviewer | reviewer | pending |
| T10 | 真实试点与全范围运行操作手册 | T9 | 主协调器 | reviewer | pending |

每个实施 Task 内独立执行 RED → GREEN → REFACTOR、验证、Spec + 质量 Review；下表的依赖完成均指已审查且已集成。所有节点 `source_issues=[]`，来源为用户会话需求；不得伪造 GitHub 编号。T10 摄取真实 Issue 后另存真实业务 DAG，不复用本表充当业务依赖证据。

理论开发并行宽度为 4：T1 后可同时执行 T2/T3/T4/T5；T2 完成即可启动 T6，T3/T4 完成即可启动 T7，不等整批结束。实际同时启动数仍取决于已配置预算和运行中任务。不存在前端交付，不派发前端角色。

## 通用任务步骤与失败处理

以下步骤适用于 T1–T8，每个 Task 的断言和实现接口见专属条目：
- [ ] 读取本 Task Brief、事实源和前置接口；核对当前 BASE、工作区、写权限与资源预留。
- [ ] 在指定测试文件写明专属行为断言；运行 `E2E_UNIT_SCOPE=scripts bun run test -- scripts/orca-dag-<name>.test.ts`，确认新行为缺失导致失败，不接受收集失败代替 RED。
- [ ] 在 owned_files 实现指定接口；只修改本 Task 文件。运行相同命令，期望新用例全部通过、无 collection error、无意外 skip、用例数大于 0。
- [ ] 针对本 Task 新文件执行 `bunx biome check <owned_files>`；不对仓库无关文件自动修复。
- [ ] 生成包含 staged/unstaged/new/deleted 文件的检查点与 SHA-256 清单、独立报告；验证者优先复用同一哈希有效证据，Reviewer 给出 Spec compliance 和 code quality 两个结论。
- [ ] 主协调器核对审查通过及产物集成后更新 Ledger。每次修复必须重新绑定检查点和相关验证；失败阻塞该节点及后继，其他无关任务继续。

测试入口依照 ADR 0008；若隔离工作区的测试基础设施与此处读取的未提交版本不同，先记录并解决基线差异，不复制整个脏工作区，不更换测试框架掩盖问题。单 Task 修复上限遵守 SDD；超限报告阻塞并按既有升级规则处理。

### Task 1: 冻结运行契约与状态约束

**Files / owned_files:** `scripts/orca-dag/contracts.schema.json`、`scripts/orca-dag/contracts.mjs`、`scripts/orca-dag-contracts.test.ts`。

**Interfaces:** Consumes 会话需求、AGENTS；Produces `validateDocument(kind, value): {ok, errors}`、`canTransition(from, to, evidence): boolean`，以及前述 JSON schema。

**具体改动与验收:** schemaVersion 固定为 1；配置要求 repo、root_issue、scope、capacity、roleRouting、executionMode、runDir。scope.mode 固定为 root-tree，快照包含 scope_revision 和树指纹。executionMode 支持 dry-run/start/resume；capacity 无值或 root_issue 缺失时禁止 start。角色映射由实施前核实的运行配置显式提供，不能假设 Orca --agent 等于专业 agent_type。对外来 Issue 文本只按数据处理。

**测试断言:** 缺少 owner_role 拒绝；容量 0 拒绝；根 Issue URL 与 owner/repo#number 规范化到相同身份；缺根 Issue 或指向其他仓库/PR 拒绝；非法状态跳转拒绝；worker_done 且无 Evidence 不能 verified；未知 schemaVersion 报错且不改写。

### Task 2: 从根 Issue 递归扫描并分类完整子树

**Files / owned_files:** `scripts/orca-dag/github.mjs`、`scripts/orca-dag/fixtures/github/`、`scripts/orca-dag-github.test.ts`。

**Interfaces:** Consumes T1；Produces `ingestIssues(config, githubTransport): Promise<IssueSnapshot>`、`diffScope(previous, current): ScopeDelta`。快照包含 root_issue、scope_revision、tree_fingerprint、issues、contains、depends_on、sources、read_window、incomplete、external_blockers；关系带 explicit/inferred、出处和理由。ScopeDelta 包含 added/removed/changed/affected_task_ids；移出范围不意味着撤销已发生的修改。

**具体改动与验收:** 已认证 gh 先读取指定根 Issue，按队列遍历全部层级子项，每层使用 `gh api --paginate repos/{owner}/{repo}/issues/{number}/sub_issues`，同时读取每个节点的评论、验收及支持的原生依赖；核验正文任务链接。去重集合和遍历队列持久化，扫描中断可从未完成页/节点恢复；若分页游标失效则重新读取该节点并去重，不跳过未知页。扫描同时保留 open/closed 节点，重复引用不重复摄取，contains 回路显式报错。原生依赖读取不可用时标记该维度不完整。closed Issue 只记录候选 satisfied，交给代码核验，不自动完成。快照只读，不改标签、正文或关闭状态。

**测试断言:** 根→子→孙→曾孙完整读取；某父节点三页共 205 个子项全部读取；重复 Issue 去重且保留来源路径；根无子项合法；closed 子项仍扫描；contains 不生成 depends_on；第三页 403 保留前两页并标 incomplete；根 404 不回退全库；PR 拒绝；树外阻塞不自动实施；循环引用有具体路径；中断恢复不漏节点；新增子项 rescan 产生 ScopeDelta 且不重派 verified；Issue 正文中的命令不执行。

### Task 3: 持久化 Ledger 与执行唯一性

**Files / owned_files:** `scripts/orca-dag/ledger.mjs`、`scripts/orca-dag-ledger.test.ts`。

**Interfaces:** Consumes T1；Produces `appendEvent(runDir, event): Promise<void>`、`replay(runDir): Promise<RuntimeState>`、`reserveAttempt(runDir, taskId, expectedRevision): Promise<AttemptReservation>`。

**具体改动与验收:** events.jsonl 为事实日志，state.json 原子替换为可重建投影；单协调器进程锁、revision 比较、事件去重；记录启动意图再调用外部启动。锁损坏或持有者不明不自动抢锁；机器重启后需核对活跃 Worker 再恢复。

**测试断言:** 同任务两次 reserve 仅一次成功；事件重复不重复扣资源；半写尾行作为恢复异常显式报告；旧 attempt 的完成事件不能覆盖新 attempt；重新投影状态一致；进程锁禁止两个协调器同时写入。

### Task 4: Orca 生命周期适配

**Files / owned_files:** `scripts/orca-dag/orca.mjs`、`scripts/orca-dag/fixtures/orca/`、`scripts/orca-dag-orca.test.ts`。

**Interfaces:** Consumes T1；Produces `OrcaClient` 的 `preflight()`、`createRun(objective)`、`createTask(spec, deps)`、`startWorker(taskId, placement, roleConfig)`、`receive(timeoutMs)`、`ack(deliveryId)`、`inspectWorkers(runId)`、`reply(messageId, body)`、`release(dispatchId)`；返回保留完整原始回执引用的标准对象。

**具体改动与验收:** 加载精确版本技能和必要 reference，使用 JSON 回执；未知字段可忽略，缺少必要权威字段则 unverifiable。正常 worker-start 使用已有 Task；launch 部分失败读取 failedStage/residualResources，不能重新启动。等待超时不超过 60 秒，给协调器更新机会。角色路由需验证有效 launch 配置/Brief，未核实映射不得声称专用角色已启用。

**测试断言:** argv 保留路径空格和正文特殊字符；unknown optional field 兼容；响应丢失不重发 start；非零退出保留残留资源信息；settlement 未接受不能 release；请求模型与实际模型不一致显式阻塞或纠正。

### Task 5: 最大可行并行集合选择

**Files / owned_files:** `scripts/orca-dag/scheduler.mjs`、`scripts/orca-dag-scheduler.test.ts`。

**Interfaces:** Consumes T1；Produces `selectRunnable(dag, state, capacities): ScheduleDecision`，纯函数，无进程和文件副作用。

**具体改动与验收:** 过滤未 verified/未集成依赖，扣除已运行任务资源；把规范化后的文件所有权冲突、资源容量和 Worker 槽位作为硬约束。用确定性分支定界求最大基数可行集合；等基数按等待时间、关键路径长度、id 排序。比较以精确定义的稳定排序为准。返回搜索证据；若设置搜索预算而提前停止，exact=false，不声称最大，严格模式不派发。第一版不引入额外求解器依赖。

**测试断言:** A 同时冲突 B/C、B/C 互不冲突且容量 2 时选 B/C；三个独立任务容量 2 时只选两个；shared/exclusive 正确互斥；缺少 integrated_checkpoint 的前置不释放；相同输入结果确定；用小图穷举 oracle 校验最大基数；已运行 Worker 占用被计入。

### Task 6: Issue 验收转为可派发 DAG 与 Brief

**Files / owned_files:** `scripts/orca-dag/planner.mjs`、`scripts/orca-dag/brief.mjs`、`scripts/orca-dag-planner.test.ts`。

**Interfaces:** Consumes T1、T2 snapshot 和经主协调器审阅的任务分解 JSON；Produces `compileDag(snapshot, decomposition): DagResult`、`renderBrief(task, facts): string`。任务分解由协调器依据 Spec/ADR/Issue 作出，不从自然语言自动猜出可信依赖。

**具体改动与验收:** 检查唯一 ID、依赖引用、自环、环路路径、验收覆盖、文件所有权和接口消费者/生产者；为实施任务生成验证、Review、集成验收门禁节点。聚合父 Issue 不重复实现。推断边带证据；未解决冲突节点不 ready。Brief 含单任务上下文、报告路径、前置产物、角色、检查点策略、禁止再派发及失败处置。

**测试断言:** A→B→C→A 返回具体闭环；缺失验收映射拒绝派发；子 Issue 已覆盖父要求不重复生成实施任务；未知写范围触发仓库独占；未批准的推断依赖不能当事实静默使用；依赖指向最终验收节点。

### Task 7: 工作区、检查点和验收集成门禁

**Files / owned_files:** `scripts/orca-dag/workspaces.mjs`、`scripts/orca-dag/checkpoints.mjs`、`scripts/orca-dag/gates.mjs`、`scripts/orca-dag-workspaces.test.ts`。

**Interfaces:** Consumes T3 Ledger、T4 OrcaClient；Produces `prepareWorkspace(task, base): Promise<WorkspaceReceipt>`、`captureCheckpoint(workspace, ownedFiles): Promise<Checkpoint>`、`evaluateGate(task, evidence): GateResult`、`integrateCheckpoint(task, checkpoint, integrationWorkspace): Promise<IntegrationReceipt>`。

**具体改动与验收:** Orca 管理独立 Worktree，记录完整工作区 ID 与 BASE；使用 T4 注入调用器，不再实现第二套 Orca 启动逻辑。未提交交付捕获 staged/unstaged/untracked/deletions 和哈希；只转移授权增量，冲突保留并阻塞。集成唯一写入者；验证者只读，reviewer 输出两个结论。所有权外改动拒收，代码变更使原验证失效；保留任务来源和既有改动基线。

**测试断言:** untracked 和删除文件均进入检查点；越权文件拒收；脏目标工作区无关文件保留；哈希变化拒绝复用测试；集成冲突不释放下游；前置产物确实存在于消费者工作区；新建 Worktree 未自动带入父目录未提交文件时明确补齐和核对。

### Task 8: 事件驱动的协调循环与操作入口

**Files / owned_files:** `scripts/orca-dag/coordinator.mjs`、`scripts/orca-dag/cli.mjs`、`scripts/orca-dag-coordinator.test.ts`。

**Interfaces:** Consumes T3–T7；Produces `tick(context, delivery): Promise<TickResult>` 和 `node scripts/orca-dag/cli.mjs <ingest|plan|dry-run|start|resume|rescan|status> --config <path>`；这些是待实现工具命令，不是现有 Orca 命令。首次配置写入 root_issue；start/resume 必须匹配冻结 scope_revision。rescan 只生成范围差异，协调器核验并写入 scope_revision 变更事件后才能派发新增任务。

**具体改动与验收:** 单协调器每次事件处理后立刻选取最大可行集合，原子预留后启动；处理问题/escalation、校验 Dispatch、持久化结果、为 settled Worker 决定 reuse/retain/release，最后 ack。worker_done 仅推进实现结果，后续仍需验收门禁。启动前对账已有 Orca Run/Worker 和 Ledger，禁止重复领取已在实施的 Issue；其他 Run 的工作未经明确转交不接管。连续三次空等待后分页 enumerate Worker；unverifiable 不释放资源或重试。

**测试断言:** A/B 并行，A 验收集成后立即启动 C 而 B 仍运行；同一 Delivery 重放不重复启动或集成；收到旧 Dispatch 完成只归档；启动回执丢失后 resume 先对账；遇到未退出 Worker 不新开编辑者；start 与 dry-run 互不混淆；两个并发 CLI 只有一个获得协调权；启动配置更换根 Issue 或范围版本不匹配时拒绝；rescan 不自动启动新增任务；依赖变更使受影响的后继派发暂停。

### Task 9: 故障演练、独立 Review 与完整范围 OCR

**Files / owned_files:** 验证者仅写本轮 `reports/`；可生成测试临时目录；不得改业务代码和测试源码。发现缺失测试时由主协调器派发原实现者补充。

**Interfaces:** Consumes T8 集成检查点；Produces 故障演练报告、Spec/quality Review、OCR 每轮报告和 finding rulings。

- [ ] 运行 `E2E_UNIT_SCOPE=scripts bun run test -- scripts/orca-dag-*.test.ts`，确认测试选择参数按实际 runner 使用文件列表传入；报告逐套件用例数，不接受零用例通过。
- [ ] 使用假的 GitHub/Orca transport、临时真实 Git 仓库，演练分页失败、重复消息、崩溃恢复、资源冲突、过期尝试和证据失效；不启动真实收费模型调用。
- [ ] 独立 reviewer 只读审查完整工具改动，输出 Spec compliance 与 code quality。
- [ ] 主协调器按 open-code-review Skill 直接运行 workspace OCR，覆盖全部未提交交付；若同时存在已提交交付，再覆盖原始 BASE..HEAD。保存 exit code、覆盖和失败文件，不能将 exit 0 视为自动通过。
- [ ] 有效 critical/high/medium finding 进入编号修复 DAG，由对应实现者修复、验证者验证、reviewer 复审，再完整 OCR；provider/凭据故障记录为阻塞。

**验收:** 所有 A1–A8 的离线可验证部分有证据；Review 通过；OCR 覆盖完整且无有效阻塞问题。此 Task 不声称真实根 Issue 范围运行完成。

### Task 10: 真实仓库试点和全范围执行准备

**Files / owned_files:** `docs/agents/orca-dag.md`，本轮运行目录的 scope、Issue snapshots、DAG、Brief、Ledger、reports；不改无关计划和 Issue。

**Interfaces:** Consumes T9 通过报告和实际运行授权；Produces 可复现运行配置、真实业务 DAG、试点结果和全量运行检查表。

- [ ] 固定配置：repo=1123786563/OpenBot；root_issue 为用户给出的真实根 Issue，scope.mode=root-tree；范围按本文定义；并发预算显式设置并计入既有 Worker；专业角色启动方式必须在实际运行时核实。尚未给根 Issue 时仍可完成工具开发和 fixtures 演练，但不能启动真实扫描执行。
- [ ] 按 R0–R4 只读摄取根及全部递归子项，记录读窗、来源、树指纹和范围版本；核对 Git 及现有运行的实施证据，区分未实施、已满足和进行中；不关闭 Issue、不接管其他协调器的 Run。
- [ ] 主协调器审阅真实业务分解和推断依赖，保存快照、DAG、验收映射及 Brief，运行 dry-run。若有 incomplete、环路或需求冲突，只阻塞相关范围。
- [ ] 从剩余任务选择至少两个互不冲突的就绪业务任务和一个后继任务。若没有这样的真实结构，明确报告试点结构不足，不能虚构 Issue 或删除依赖制造并发。
- [ ] 在已授权预算与范围内启动试点，验收“并行实施、完成即补位、独立 Review、集成后解锁、恢复不重复执行”；保留每任务检查点和回执。
- [ ] 试点通过后按已授权全量范围继续；没有全量实施授权时交付可执行配置和 dry-run 报告，不自动扩展。推送、合并、发布和关闭 Issue 均遵守已有独立授权。

**验收:** 工具可操作与真实 Issue 完成分别报告；根 Issue 范围实施只有在真实 DAG 全部交付节点 verified、根级聚合验收满足、覆盖完整 OCR 通过后才可宣告完成。不因子项都 closed 自动宣布根级需求完成。

## 自检与执行 Ledger 起点

- [x] 需求 A1–A8 映射到任务；Task ID 唯一，依赖存在，无自环和循环。
- [x] 拓扑序可用：T1 → {T2,T3,T4,T5} → {T6,T7} → T8 → T9 → T10；采用持续补位而非整批屏障。
- [x] 并行写文件不相交；共享 schema 由 T1 独占，修改需停止受影响消费者并重新校验。
- [x] 后端实现/验证角色匹配；无前端任务；每个实现 Task 独立 reviewer。
- [x] 实际 Issue 树未摄取的事实已披露；本文没有伪造编号、状态、依赖或验收证据。
- [x] 当前唯一新增内容为计划文档；未执行测试、启动 Agent 或实施工具代码。

计划记录起始 HEAD：`129fed8edd5bdce751270441269df4e9e39a7d0b`。实施工作区、执行 BASE、Orca Run ID、角色有效配置和运行预算由实施前置检查记录后才能 start；这些是启动输入，不是默认为已满足的条件。
