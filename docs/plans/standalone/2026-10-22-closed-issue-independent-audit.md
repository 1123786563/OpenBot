# 已关闭 Issue 独立代码审查与正式验证方案

## 目标与边界

对 `1123786563/OpenBot` 中选定范围内的**每一个已关闭 Issue 分配一次独立的 Agent 审计任务**，逐条核对需求、目标分支现状、代码质量及可实际运行的验收证据。主控同时最多运行 3 个子 Agent；子 Agent 完成一个 Issue 后可领取下一个，但必须重新接收单 Issue Brief，并为新 Issue 单独产出报告。审计不修改业务代码、测试或 Issue 状态；仅在满足下述通过条件时，由主控给对应 Issue 添加现有标签 `agent:ready-for-review`。发现缺陷后另列修复任务，修复及复审须另行记录。

审计对象是固定的仓库提交 SHA，不以 Issue 的 closed 状态、PR 已合并、历史测试截图或测试退出码 0 代替当前版本的验收。父 Issue 和每个子 Issue 都是独立任务，父级负责独有要求及聚合验收，父级结论不能覆盖子项的单独结论。

## 阶段 1：主控冻结范围与建立清单

1. 通过已认证 `gh` 或 GitHub API 分页列出目标仓库的全部 closed Issue，记录查询时间、页数、总数、筛选条件及每项 URL。默认纳入所有已关闭 Issue；若执行资源有限，按关闭时间分批，但每批必须记录明确的编号清单和剩余数量，不能把前 100 项当成全集。
2. 固定目标分支、HEAD SHA、工作区状态、子模块 SHA、运行环境。已有用户或其他 Agent 的修改只记录为基线，不纳入审计版本。为每个 Agent 提供相同的只读代码快照；需要运行测试时隔离工作区、端口、数据库、容器、缓存和报告目录。
3. 对每项读取正文、验收、讨论、正式子 Issue、依赖、相关 PR/提交、批准 Spec、ADR 与 `CONTEXT.md`。区分 `contains` 和 `depends_on`；普通 Issue 引用须核实关系。读取失败标为 `intake_incomplete`。
4. 建立 `issue → 验收条款 → 候选代码/PR/提交 → 当前代码位置 → 验证方法` 矩阵。PR/提交关联只是线索；须检查改动是否已在固定 SHA 中、后来是否被撤销或改变。跨 Issue 共用代码允许重复审查，但每个 Agent 只为自己负责的 Issue 下结论。

## 阶段 2：最多三个子 Agent 的滚动队列

主控维护待审队列与 `pending / running / reported / reconciled` 状态，最多启用 3 个子 Agent 槽位。同一时刻每个子 Agent 只接收一个 Issue 的独立 Brief，不再派发子 Agent，也不修改代码或测试源文件。一个 Issue 的报告和证据写完、主控收到完成通知并核对该任务已退出 `running` 后，才给空出的槽位派发下一项；失败或阻塞也先保存独立报告，再继续队列。复用同一子 Agent 时明确重置任务边界，只给新 Issue 的 Brief 和必要事实源，不沿用上一项的验收结论。主控记录 `Issue 编号 → Agent/轮次 → 开始与结束时间 → 报告路径 → 状态`，中断恢复时先对账，禁止重复派发已完成项。

最多 3 项审计任务可同时进行；共享数据库、端口、容器、缓存或报告目录的验证必须串行或隔离。每项独立产出报告及证据索引，主控核对 Issue 清单与报告一一对应，不能用一个系列报告替代多个 Issue 报告。

每个 Agent 执行：

1. **需求核对**：逐条提取可验证的验收条件；指出与批准 Spec/ADR 的冲突及尚未明确的条件。
2. **代码追溯和审查**：核对固定 SHA 中对应实现、测试、配置、迁移和调用链；检查正确性、边界条件、权限、安全、数据一致性、回归风险。报告具体文件/行、复现条件和影响。若无法把 Issue 可靠关联到代码，标记 `mapping_unproven`。
3. **正式验证**：为每条验收选择匹配的实际测试。优先最小相关测试，再补类型检查、Lint、构建、集成或真实浏览器/API/服务验证。涉及拒绝路径、并发、持久化、回滚等要求时必须覆盖相应行为。仅静态阅读不能宣称行为通过。
4. **证据封存**：记录实际命令、工作目录、环境前提、固定 SHA、开始/结束时间、退出码、执行/失败/跳过用例数、原始 stdout/stderr 或报告路径及 SHA-256。浏览器/服务验证记录输入、响应或截图、时间和环境；涉密值脱敏。失败不得通过改断言、跳过用例或改生产代码变绿。
5. **结论**：每条验收标记 `verified / failed / blocked / unproven / not_applicable` 并给证据路径。Issue 总结论仅在全部适用验收 `verified`、代码审查无未解决的阻塞问题、证据对应固定 SHA 时为 `verified`；否则为 `failed`、`blocked` 或 `unproven`。`not_applicable` 需说明依据。

运行任何测试前遵守 `.agents/rules/testing.md` 和 ADR 0008。测试入口以当前 `package.json` 为准；`bun run test:ci` 需要核对实际收集与执行数。需要 Docker 时记录原有资源，创建本轮独立资源并在成功、失败或中断后清理及复查；不得清理共享服务。缺少环境或凭据时保留失败/阻塞的原始证据，不推断通过。

## 阶段 3：主控对账与独立复核

主控核对完整分页清单、每项 Issue 的独立 Agent 报告、验收覆盖率、证据文件可读性和 SHA、资源清理结果。对高风险或结论有争议的 Issue 做第二人只读复核；有冲突时保留双方证据与裁决理由。系列/父 Issue 另做跨项集成验收，确认单项验证不能发现的接口和端到端问题。审计发现的问题按严重度、复现步骤、受影响 Issue 和代码版本汇总；此阶段不自动修复或关闭/重开 Issue。

**贴标规则：**仓库现有 `agent:ready-for-review` 的含义是“已由 agent 验收通过，待人审”。只有单 Issue 总结论为 `verified`、主控完成证据对账、证据仍对应目标 SHA，且该 Issue 无未解决的阻塞 finding 时才添加该标签；父 Issue 还须通过聚合验收。记录标签写入时间、操作者、Issue URL、当时 SHA、证据索引及 GitHub 回执。已存在标签则核对其证据是否仍有效，不能视为本轮自动通过。若后续目标代码改变、复审发现缺陷或证据失效，标记原标签证据过期并提出移除建议；`blocked`、`failed`、`unproven` 不贴标。这个标签只表示 Agent 审计通过并等待人工审查，不表示人工已批准。

最终输出全量清单与覆盖数：`已关闭数 / 已摄取数 / 已出报告数 / verified / failed / blocked / unproven`，并列缺失项、真实验证命令与证据位置。任何分页缺口、运行失败、跳过或环境阻塞都须显式保留，不能计入通过。

## 产物位置

- 本方案：`docs/plans/standalone/2026-10-22-closed-issue-independent-audit.md`。
- 本次 Run：`.archive/runs/<date>-closed-issue-audit/`，含 `index.md`、`scope.json`、`issues/`、`ledger.md`、`verification/`、`reviews/`、`logs/`。每项报告命名为 `reviews/issue-<number>.md`，证据用 Issue 编号分目录。
- `.archive/` 是本地忽略目录；若结果需跨工作区或分享，须显式复制脱敏证据、核对哈希并记录接收位置。

## 给主控 Agent 的提示词

```text
请对 GitHub 仓库 1123786563/OpenBot 的已关闭 Issue 发起独立审计。按 docs/plans/standalone/2026-10-22-closed-issue-independent-audit.md 执行。先分页获取完整 closed 清单并固定目标分支 SHA、子模块 SHA 与工作区基线；不要把查询上限当总数。维护最多 3 个子 Agent 槽位的滚动队列；每个 Issue（包括父 Issue）都是独立任务，一个子 Agent 同时只审一个 Issue。其报告和证据完成、主控确认任务结束后，复用空闲子 Agent 领取下一项，并提供新的单 Issue Brief。不得合并多个 Issue 的结论；隔离验证资源，恢复时先对账任务状态。

每个 Agent 必须读取 Issue 验收和关联事实源，追溯当前 SHA 的代码，完成独立代码审查和可运行验收，保存真实命令、退出码、用例数、原始日志、环境及证据哈希。不能运行的条款标 blocked/unproven，不得声称通过。遵守 .agents/rules/issue-tracker.md、design.md、testing.md、review.md、artifacts.md 及 ADR 0008。全程不改业务代码、测试或 Issue 状态。主控最后逐项对账清单和报告，做父级集成核验；仅给符合方案贴标规则的 Issue 添加现有 agent:ready-for-review 标签，并保存 GitHub 回执。输出未验证与缺陷清单。若无法完成全部范围，给出已经审计的确切编号和未完成编号，不宣布全量完成。
```

## 给单 Issue 审计 Agent 的提示词模板

```text
你是 Issue #{ISSUE_NUMBER} 的独立审计 Agent。只审计这个 Issue；不要派发子 Agent，不要修改业务代码、测试、Issue 或其他 Agent 的文件。其他 Agent 正在同一仓库工作，保留他们的改动。

固定仓库：1123786563/OpenBot
目标 SHA：{TARGET_SHA}
Issue URL：{ISSUE_URL}
只读工作区：{WORKTREE}
事实源：{SPEC_ADR_CONTEXT_PATHS}
报告：{RUN_DIR}/reviews/issue-{ISSUE_NUMBER}.md
证据目录：{RUN_DIR}/verification/issue-{ISSUE_NUMBER}/

先记录 Issue 正文、验收、讨论、子项和依赖的来源与读取时间；将每条验收映射到目标 SHA 的具体实现与验证方法。独立检查正确性、安全、边界和回归风险。按仓库测试规范实际运行适用验证，保存命令、环境、时间、退出码、用例数、跳过数、原始日志/截图、证据 SHA-256、容器清理复查。测试结果须对应同一 SHA；现有历史报告只能作线索。无法运行时记录实际阻塞证据。

报告逐条列：验收原文或准确摘要、代码位置、验证操作、证据路径与哈希、结论（verified/failed/blocked/unproven/not_applicable）；再列代码 finding（严重度、位置、复现、影响）、Issue 总结论及限制。不要以 closed、PR merged 或命令 exit 0 单独推断通过。不得为通过而改代码或测试。
```
