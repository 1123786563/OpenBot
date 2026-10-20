> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

# Task 8: 事件驱动的协调循环与操作入口

**依赖与角色：** T3、T4、T5、T6、T7；backend_implementer → backend_validator → reviewer。

**共享约束：** [运行协议](protocols.md)、[审核同步](review-sync.md)。

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

- 消息、报告读取、恢复摘要及读取量记录还须满足 [context.md 第 2–4 节](context.md)。

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

**Issue 同步测试断言（orca-dag-issue-status.test.ts）：** worker_done、局部 Task 完成、缺项或 stale 证据均不贴标签（OCR 不是逐 Issue 贴标条件）；完整 Issue 通过后先评论后贴标；父级缺聚合验收不贴标；closed Issue 不重开；无 source_issues 不写 GitHub；标签已存在不重复创建且保留其他标签；重复事件或评论回执丢失后对账不重复发评论；403 只阻塞同步不重派实现；rescan 使待添加请求过期，已添加标签被撤回；撤标失败有明确过期警告；跨 Run 移交后旧 generation 不再写入。dry-run 下 transport 写调用为零。

**专项验收：**

- [ ] F5：父 Issue 的验收全部映射到子任务、没有自己的实施 Task 时，聚合验收通过后仍领取父 Issue 的 review_sync 声明，先评论后贴标，且不领取整树。另一个 Run 持有父 Issue 声明时仅同步等待；未完成 outbox 或在途请求阻止声明释放；移交后旧 epoch 的评论和标签调用均被拒绝。

执行前读取 [共享约束](workflow.md) 中适用条款；上下文、消息和恢复使用 [读取规则](context.md)。
