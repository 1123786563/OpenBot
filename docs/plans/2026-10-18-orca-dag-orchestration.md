# Orca DAG Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Execution, validation, and review MUST be delegated through Orca to Pi subagents; implementation and independent review require separate agents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从用户指定的根 Issue 开始，递归扫描完整子 Issue 树、核验依赖并生成执行 DAG，通过 Orca 持续调度，在依赖、文件所有权和资源容量允许时取得当前就绪集合的最大并行数，并保留验收、审查、集成及恢复证据。

**Architecture:** 单一主协调器拥有派发权；确定性的本地工具负责摄取、图校验、资源选择和执行 Ledger，Orca 负责 Task、Dispatch、Worker 和消息生命周期，任务执行、验证与审核由其派发的 Pi 子 Agent 承担。业务验收状态与 Orca 执行状态分离；业务任务间依赖仅在产物已审查、验证并进入下游实际工作区后释放；任务内部阶段按明确的证据条件推进。

**Tech Stack:** 现有 Node.js / TypeScript / Bun 工具链；新增运行工具使用 Node ESM `.mjs`，测试使用仓库 e2e tools-only target 及 `tests/support/e2e-compat.ts`；外部能力经已认证 `gh` 与当前 Orca CLI 调用。

**Spec:** 本文“需求基线”来自 2026-10-18 制定原计划时的用户要求及架构讨论，属于待实施设计，尚非独立批准 Spec。未读取真实全量 Issue 树，因此本计划是编排工具的实施任务，不是已经核实的业务 Issue 执行 DAG。

**状态：** 这是工具待实施计划；另有真实业务运行的历史记录，不证明 T1–T10 已实现。本次整理仅改文档。实施或恢复时以 Git、对应 Run Ledger 和当前授权核对状态。

## 阅读规则

首次由协调器读取本入口。派发时只加载当前 Task、适用共享规则和所需协议；后续按变更补读。子 Agent 从单个 Brief 开始，以不继承主会话的方式启动。

| 当前工作 | 读取入口 | 完成条件 |
| --- | --- | --- |
| 初次规划、核对范围 | [验收基线](2026-10-18-orca-dag-orchestration/acceptance.md) | A1–A9 / F1–F6 有覆盖，无未解决需求冲突 |
| 准备派发、阶段门禁 | [共享执行约束](2026-10-18-orca-dag-orchestration/workflow.md)、[上下文规则](2026-10-18-orca-dag-orchestration/context.md) | Brief、角色、工作区、证据和权限可核验 |
| 实现或验证一个 Task | 下表对应任务文件及其中标明的协议 | 当前 Task 验收和独立 Review 通过，检查点已集成 |
| 收到消息、恢复协调器 | [上下文规则](2026-10-18-orca-dag-orchestration/context.md) | 对账当前权威尝试；按事件处理并持久化后 ack |
| 工具整体交付 | [完成条件与 Ledger](2026-10-18-orca-dag-orchestration/completion.md) | T1–T9 的完整交付证据通过 |
| 准备真实 Issue 运行 | [R0–R7](2026-10-18-orca-dag-orchestration/runtime.md) | 有独立根 Issue、授权、预算和运行计划 |

编号：A/F 是验收，T 是工具开发任务，R 是真实运行步骤。共享协议属于按需参考；派发包列出具体章节，不把所有链接递归展开成必读清单。

<a id="delivery"></a>

## 交付结构与开发 DAG

### 2.1 文件边界与持久产物

新增实现仅写 `scripts/orca-dag/`；新增测试 `scripts/orca-dag-*.test.ts`；固定 fixtures 位于 `scripts/orca-dag/fixtures/`；操作说明 `docs/agents/orca-dag.md`。不修改应用、计费和既有运行中的任务文件。

运行证据目录为 `.archive/runs/<date>-orca-run-<run-key>/`，包含 `scope.json`、`issues/`、`dag.json`、`briefs/`、`events.jsonl`、`state.json`、`receipts/`、`checkpoints/`、`reports/`。持久事实源不包含凭据及完整环境变量。

### 2.2 任务依赖、角色与并行边界

| Task | 交付 | depends_on | owner_role | validator_role | status |
| --- | --- | --- | --- | --- | --- |
| [T1](2026-10-18-orca-dag-orchestration/task-01.md) | 冻结契约、配置和生命周期校验 | — | backend_implementer | backend_validator | pending |
| [T2](2026-10-18-orca-dag-orchestration/task-02.md) | 从根 Issue 递归摄取与范围快照 | [T1](2026-10-18-orca-dag-orchestration/task-01.md) | backend_implementer | backend_validator | pending |
| [T3](2026-10-18-orca-dag-orchestration/task-03.md) | Ledger、唯一尝试和恢复投影 | [T1](2026-10-18-orca-dag-orchestration/task-01.md) | backend_implementer | backend_validator | pending |
| [T4](2026-10-18-orca-dag-orchestration/task-04.md) | Orca 适配与回执核验 | [T1](2026-10-18-orca-dag-orchestration/task-01.md) | backend_implementer | backend_validator | pending |
| [T5](2026-10-18-orca-dag-orchestration/task-05.md) | 精确最大并行调度 | [T1](2026-10-18-orca-dag-orchestration/task-01.md) | backend_implementer | backend_validator | pending |
| [T6](2026-10-18-orca-dag-orchestration/task-06.md) | Issue 转 Task DAG 与 Brief | [T2](2026-10-18-orca-dag-orchestration/task-02.md) | backend_implementer | backend_validator | pending |
| [T7](2026-10-18-orca-dag-orchestration/task-07.md) | Worktree、检查点、验收集成门禁 | T3、T4 | backend_implementer | backend_validator | pending |
| [T8](2026-10-18-orca-dag-orchestration/task-08.md) | 持续补位协调循环、CLI 与操作手册 | T3、T4、T5、T6、T7 | backend_implementer | backend_validator | pending |
| [T9](2026-10-18-orca-dag-orchestration/task-09.md) | 故障演练及全工具审查 | [T8](2026-10-18-orca-dag-orchestration/task-08.md) | backend_validator / reviewer | reviewer | pending |
| [T10](2026-10-18-orca-dag-orchestration/task-10.md) | 独立真实运行计划交接（条件阶段） | [T9](2026-10-18-orca-dag-orchestration/task-09.md) | 主协调器 | reviewer | pending |

每个实施 Task 内独立执行 RED → GREEN → REFACTOR、验证、Spec + 质量 Review；表中的依赖完成均指已审查且已集成。所有节点 `source_issues=[]`，来源为用户会话需求；不得伪造 GitHub 编号。T10 交接的独立运行计划摄取真实 Issue 后另存真实业务 DAG，不复用本表充当业务依赖证据。

工具开发默认按仓库规则串行派发；仅有明确并行实施授权时采用以下并行关系。工具运行时最大并行策略也必须服从已授权预算。理论开发并行宽度为 4：T1 后可同时执行 T2/T3/T4/T5；T2 完成即可启动 T6，T3/T4 完成即可启动 T7，不等整批结束。实际同时启动数仍取决于已配置预算和运行中任务。不存在前端交付，不派发前端角色。

<a id="execution-ruling"></a>

## 执行边界

文档和产物布局遵守[目录与产物归处](../../.agents/rules/artifacts.md)：方案留在 `docs/plans/`，运行状态、快照和报告写入 `.archive/runs/`。

- 当前会话只整理文档；执行工具计划时采用 [共享约束](2026-10-18-orca-dag-orchestration/workflow.md)，运行权限以当前用户指令为准。
- 工具任务默认串行；真实运行中的最大并行策略受已授权预算、文件所有权和共享资源约束。
- 任务细节、数据契约和协议均保留；本次新增上下文读取、消息摘要和恢复要求，见 [context.md](2026-10-18-orca-dag-orchestration/context.md)。
- 原稿关于“OCR 仅最终提交运行一次”的措辞与当前全局工程规则不一致：执行时按当前规则，在 SDD 后做完整 OCR，有有效问题则修复并复审，未提交交付也适用；提交另需已有授权。各详细文件统一引用此裁决。

## Review Focus

重点审查摄取完整性（T2）、响应丢失后不重复启动（T4/T8）、重复与过期消息（T3/T8）、检查点变化和实际集成（T7）、精确调度的容量及响应性（T5/T8）。异常断言见对应 Task；全量故障验收见 [F1–F6](2026-10-18-orca-dag-orchestration/acceptance.md)。

## 原入口导航

保留原路径及锚点，原章节内容移至以下文件。旧引用到达此处后只打开所需文件。

<a id="scope"></a>

- 范围与验收：[acceptance.md](2026-10-18-orca-dag-orchestration/acceptance.md)。

<a id="tasks"></a>

- 实施任务：上方 DAG 中 T1–T10 的链接；共用步骤：[workflow.md](2026-10-18-orca-dag-orchestration/workflow.md)。

<a id="completion"></a>

- 完成条件与 Ledger：[completion.md](2026-10-18-orca-dag-orchestration/completion.md)。

<a id="runtime"></a>

- 真实业务 R0–R7 与历史教训：[runtime.md](2026-10-18-orca-dag-orchestration/runtime.md)。

<a id="contracts"></a>

- 附录 A：[contracts.md](2026-10-18-orca-dag-orchestration/contracts.md)。

<a id="protocols"></a>

- 附录 B：[protocols.md](2026-10-18-orca-dag-orchestration/protocols.md)。

<a id="review-sync"></a>

- 附录 C：[review-sync.md](2026-10-18-orca-dag-orchestration/review-sync.md)。
