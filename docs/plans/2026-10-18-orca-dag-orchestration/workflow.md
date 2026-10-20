> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

# 共享执行约束

只在准备派发、阶段门禁或失败处理时读取；单任务 Brief 引用适用条款。本文是原计划的执行规则，不授予当前会话新的运行、提交或 GitHub 写权限。

## Global Constraints

产物归处以[仓库目录规范](../../../.agents/rules/artifacts.md)为准；下文 `runDir`、报告和检查点属于 `.archive/runs/<run-key>/`，方案属于 `docs/plans/`。

- Issue tracker 为 `1123786563/OpenBot`；遵守 `.agents/rules/issue-tracker.md`、根 `AGENTS.md`、`CONTEXT.md` 和 `docs/adr/0008-test-runner-tester-army-e2e.md`。
- 本轮只交付计划，不启动 Worker、不创建 GitHub Issue、不提交、推送、合并或关闭 Issue。后续默认使用未提交检查点；没有已有提交授权不得自动提交。
- 整理时主工作区存在无关未提交修改。计划文档保存在当前目录供审阅；实施前必须使用 using-git-worktrees + Orca 建立隔离执行工作区，显式复制本计划入口及其配套目录并核对各文件 SHA-256，记录原始 BASE 和相关未提交事实源。不得假定新工作区带入本目录未提交改动。
- 一个主协调器负责整个 Run；使用 Orca orchestration 派发 Pi 子 Agent 执行任务、验证、独立审核及修复复审。主协调器负责计划、派发、对账、集成和门禁裁决，不代替子 Agent 实现或审核。每个 Pi 子 Agent 只接收单个 Brief，不递归派发；不得以非 Pi Worker、内置子 Agent 或主协调器内联执行替代。
- 并行实施必须独立 Worktree、写权限不相交、接口稳定；共享数据库、端口、缓存、迁移和产物目录均进入资源模型。
- 只读默认：摄取、规划、dry-run 不启动 Worker。实际 start/resume 的范围和并发预算必须来自已授权运行配置。
- CLI 可执行路径按技能解析一次并持久化；原计划记录的核验路径为 `/Applications/Orca.app/Contents/Resources/bin/orca`。执行时重新读取该版本技能，禁止假设未来版本仍使用相同参数。
- 不把 task-list --ready、worker_done、Issue closed 或测试进程 exit 0 单独视作业务验收完成。
- 验证证据绑定代码检查点；完整范围独立 Review 及修复复审通过才交付。OCR 时机与修复循环遵循[主入口执行裁决](../2026-10-18-orca-dag-orchestration.md#execution-ruling)。
- 原计划记录的授权为：未来运行中在验收完成后同步 `agent:ready-for-review` 标签和交付评论，证据失效时撤标并更新评论；授权仅限本次运行范围内的 Issue。本轮仍仅修改文档，不调用 GitHub 写接口。摄取、plan、dry-run 保持只读；标签同步不包含关闭 Issue、修改正文或推送代码的授权。

## Review Focus

1. GitHub 分页中途失败、403/404 或依赖缺失：保存部分证据，受影响节点阻塞，不能静默视为完整。（T2）
2. Worker 启动已发生但响应丢失：先对账并保持未知状态，不派发第二个写入者。（T4、T8）
3. 过期 Dispatch 和重复 Delivery：不覆盖当前尝试，不重复集成，处理后才 ack。（T3、T8）
4. 验证后文件变化或依赖未进入实际工作区：证据失效，不能释放下游。（T7）
5. 最大并发与公平性：容量为硬约束，等基数优先老任务；严格最大基数不保证有界等待，持续输出延迟原因，不宣称防饥饿。求解必须可中断且不阻塞消息处理。（T5、T8）

<a id="pi-dispatch"></a>

### 2.3 Pi 子 Agent 强制派发规则

本规则适用于 T1–T10 中的执行、验证与审核工作，以及工具投入运行后的业务任务和全部修复轮次。T10 的运行计划编写也由主协调器派发 Pi 子 Agent 完成；主协调器保留授权核对与交接责任。

- **执行后端：** 所有任务 Worker 必须由 Orca 启动为 Pi 子 Agent。Pi 是执行后端；`backend_implementer`、`backend_validator`、`reviewer` 是职责角色，两者分别核验，不能互相替代。
- **独立审核：** 实现者、验证者和审核者使用不同的 Pi 子 Agent 身份。审核者只读检查任务增量及其证据，分别给出 Spec compliance 和 code quality 结论；实现者自查不能代替独立审核。
- **启动核验：** preflight 核验当前 Orca 版本支持的 Pi 启动方式、角色配置及实际运行身份。命令参数以版本匹配的技能和 help 为准，不凭空假定某个 CLI 参数。缺少 Pi 能力、角色映射不成立或启动回执无法核实时，记录 blocked/unverifiable 并保留恢复条件，不自动换用其他后端。
- **派发证据：** Brief、启动配置和 Ledger 记录预期后端 `pi`、实际后端、角色、Worker 身份、Orca Task/Dispatch、工作区、检查点及报告路径。任务门禁同时核验代码证据和派发身份。
- **外层 OCR：** 按[主入口执行裁决](../2026-10-18-orca-dag-orchestration.md#execution-ruling)运行；使用自身 provider，不能替代 Pi 独立审核证据。有效问题返回 Pi 实现者修复，独立 Pi 验证者和审核者复审后，再做完整 OCR。

### 通用步骤与失败处理

以下步骤适用于 T1–T8，每个 Task 的断言和实现接口见专属条目：

- [ ] 主协调器通过 Orca 派发对应角色的 Pi 子 Agent，核验实际后端、身份和角色并记录回执；子 Agent 读取本 Task Brief、事实源和前置接口，核对当前 BASE、工作区、写权限与资源预留。
- [ ] 在指定测试文件写明专属行为断言；运行 `E2E_UNIT_SCOPE=scripts bun run test -- scripts/orca-dag-<name>.test.ts`，确认新行为缺失导致失败，不接受收集失败代替 RED。
- [ ] 在 owned_files 实现指定接口；只修改本 Task 文件。运行相同命令，期望新用例全部通过、无 collection error、无意外 skip、用例数大于 0。
- [ ] 针对本 Task 新文件执行 `bunx biome check <owned_files>`；不对仓库无关文件自动修复。
- [ ] 生成包含 staged/unstaged/new/deleted 文件的检查点与 SHA-256 清单、独立报告；验证者优先复用同一哈希有效证据，Reviewer 给出 Spec compliance 和 code quality 两个结论。
- [ ] 主协调器核对审查通过及产物集成后更新 Ledger。每次修复必须重新绑定检查点和相关验证；失败阻塞该节点及后继，其他无关任务继续。

测试入口依照 ADR 0008；若隔离工作区的测试基础设施与此处读取的未提交版本不同，先记录并解决基线差异，不复制整个脏工作区，不更换测试框架掩盖问题。单 Task 修复上限遵守 SDD；超限报告阻塞并按既有升级规则处理。
