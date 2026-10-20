> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

# Task 4: Orca 生命周期适配

**依赖与角色：** T1；backend_implementer → backend_validator → reviewer。

**共享约束：** [B.1–B.2](protocols.md)。

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
- [ ] 预期后端为 Pi 而实际后端不符、无法核验或 Pi 不可用时阻塞，不回退到其他 Worker；实现者与审核者身份相同时拒绝审核门禁。
- [ ] 无用户请求不得 retain。
- [ ] 无退出证据不得 stop/abandon。
- [ ] 未知恢复能力阻塞。
- [ ] Worktree 回执保留工作区身份。

**专项验收：**

- [ ] F1：按版本匹配的 help/reference 实现 retryFailedStage；只对核实可重试的失败 Orca Task 传入 `--task` 和 `--retry-of`，完整重传 placement/角色。成功实现后被 Review 拒绝时创建新修复阶段 Task，不重试成功 Dispatch；未知旧执行状态时拒绝两条启动路径。

执行前读取 [共享约束](workflow.md) 中适用条款；上下文、消息和恢复使用 [读取规则](context.md)。
