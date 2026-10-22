# ME08 (#480) Task Brief — 保留可选学习技能的快照校验、加载与撤销

Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`（分支 `1123786563/mastra-exec`，未提交树，BASE `bf64d0f2`）。
Ticket: `docs/tickets/mastra-agent-execution/issues/me08.md`（6 条 AC）。Spec §7（记忆、技能与既有需求复用）。前置：ME05 已闭环；**与 ME06 串行**（共享 `copilot.ts`、`mastra/execution.ts`——ME06 先行，本票基于其后的树）。

## 现状与精确接缝

1. **fail-closed 拒绝点**：`server/src/copilot.ts` `mastraAgentConfiguration`（~L2351-2363）当 `learnedSkills?.tools.length > 0` 时抛 `MASTRA_TEXT_ONLY_SLICE`。本票接线后移除该分支（ME06 已移除 computerGuidance 分支；确认两分支都打开后 guard 只剩真正的未接线面）。
2. **Legacy 学习通道（保留语义）**：
   - `server/src/learning/runtime.ts`：`LearnedSkillInvocation`（catalog + 两个保留名工具 `copilotkit_load_skill`/`copilotkit_read_skill_file` + `execute(name,args)`）、`AcquireLearnedSkills`、`createLearningRuntime`、`selectLearningTarget`、`clearLearningRevisionFallback`。
   - `server/src/copilot.ts` ~L3271-3345 `RunBuiltAgent`：每外层 run `acquireLearnedSkills?.(agent.id, signal)`；保留名冲突检测（`LEARNED_SKILL_TOOL_NAMES` 命中 granted/input 工具即抛 "Learned Skill tool names are reserved by Automatic Learning."）；catalog 进 prompt（~L2586、~L2723）；`withTools(..., learnedSkills)` 把 execute 挂上。
   - `server/src/index.ts` ~L822-845：`learningSettingsStore`、`createIntelligenceClient`（learning probe）、learning 配置/健康。**注意 ME15 会再动 Intelligence 客户端构造时机；本票只保证 disabled 时不构造（AC4）**。
3. **Mastra 路径现有工具面**：`server/src/mastra/tools.ts` createMastraTools（GrantedTool 包装）+ `execution.ts` 的工具挂载。学习工具需要同等受控包装：保留名规则、参数 schema 校验、execute 经原 learning runtime、audit。
4. **快照/刷新/撤销**：`learning/runtime.ts` 的刷新与撤销策略、archive 校验（`scripts/setup-learning.ts` / `learning/remote.ts`）。恢复用绑定内容版本 + 每次敏感读取核对当前撤销（AC2）。

## 交付（6 AC 对应）

- AC1 保留 catalog/按名加载/读文件/归档校验/刷新/撤销：服务故障不是空 skills 列表（明确失败策略，`learning/runtime.ts` 现有失败/降级语义保持）。测试：正常加载→模型看到 catalog；执行 load_skill → execute 真实读取；撤销后 load 拒绝；故障→真实失败而非空列表。
- AC2 每外层运行一次经校验快照；合法恢复用绑定内容版本 + 当前撤销核对。测试：同一 run 内两次工具调用用同一快照；恢复路径重验撤销。
- AC3 保留名规则：外部同名工具不能覆盖学习工具（沿用 legacy 的 reserved-name 抛错语义挂到 Mastra 挂载层）。测试：grant 一个 `copilotkit_load_skill` 同名工具 → 挂载拒绝。
- AC4 disabled 不构造 Intelligence 客户端（启动/import/run 全链）；enabled 独立配置 + 真实 delivery/health 展示。测试：disabled 树上 spy/module-load 证明无 IntelligenceClient 实例化；enabled 显示真实状态。
- AC5 单用户取消等待不取消共享刷新；跨公司/团队不共用未授权缓存。测试：并发两 run 共享刷新，一个 abort 另一个完成；不同 scope 快照隔离。
- AC6 旧学习服务异常保持已定义失败/降级并可观察；技能目录内容不写入全局可见上下文。测试：异常时 prompt 不含 catalog 内容、错误可观察。

## 实现要点

- 修改集中在：`server/src/copilot.ts`（mastraAgentConfiguration：catalog 进 instructionParts、learnedSkills 工具经包装挂载、移除拒绝分支）、`server/src/mastra/execution.ts` 或 `tools.ts`（学习工具的受控包装：operationId/argsDigest/audit 沿 ME04 模式）、必要时 `server/src/learning/runtime.ts` 小幅导出（不改算法）。
- **不改**：自动学习算法、Intelligence 服务本体、`server/src/approvals/**`、记忆（ME07 领域）。仍必需的 CopilotKit learned-skills 校验代码不删（boundary 明文）。
- 新测试：`server/tests/mastra-learned-skills.test.ts`（建议名）；入册 `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs`。
- 验证基线：绿波 + 新套件；typecheck 3 基线错误；biome 干净。缺环境记 UNVERIFIED。
- 报告写 `docs/plans/2026-10-19-mastra-execution-run/me08/report.md`。不 commit/push。

## 边界与上报

- 只做可选适配；出现"需要实现新学习算法/删除 CopilotKit 校验"即为范围外，停下报告。
- 冲突升级：与 Spec §7/ADR 0005 冲突时报告，不静默改设计。
