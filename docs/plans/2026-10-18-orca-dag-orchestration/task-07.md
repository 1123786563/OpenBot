> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

# Task 7: 工作区、检查点和验收集成门禁

**依赖与角色：** T3、T4（传递依赖 T1）；backend_implementer → backend_validator → reviewer。

**共享约束：** [B.4–B.5](protocols.md)。

**Files / owned_files:** `scripts/orca-dag/workspaces.mjs`、`scripts/orca-dag/checkpoints.mjs`、`scripts/orca-dag/gates.mjs`、`scripts/orca-dag-workspaces.test.ts`。

**Interfaces:**

- **Consumes:** T3 Ledger/资源接口、T4 OrcaClient。
- **Produces:** `prepareWorkspace(task, base): Promise<WorkspaceReceipt>`、`captureCheckpoint(workspace, ownedFiles, baseline, prerequisiteCheckpoints): Promise<Checkpoint>`、`evaluateGate(task, evidence): GateResult`、`buildIntegrationVerificationPlan(task, integratedTasks, integrationWorkspace): Promise<IntegrationVerificationPlan>`、`integrateCheckpoint(task, checkpoint, integrationWorkspace, evidence, verificationPlan, reservations): Promise<IntegrationReceipt>`、`reconcileIntegration(intent, integrationWorkspace): Promise<IntegrationRecovery>`。集成入口核验全部预留 token、计划哈希和目标树；不允许调用方省略资源门禁。

**实施要求:**

- Orca 管理独立 Worktree，记录完整工作区 ID 与 BASE；使用 T4 注入调用器，不再实现第二套 Orca 启动逻辑。
- 未提交交付捕获 staged/unstaged/untracked/deletions 和哈希；只转移授权增量，冲突保留并阻塞。
- 集成唯一写入者；验证者只读，reviewer 输出两个结论。
- 所有权外改动拒收，代码变更使原验证失效；保留任务来源和既有改动基线。
- 实现[B.5](protocols.md) 的集成事务和完整受测树协议；prepareWorkspace 必须显式转移并核验前置检查点，integrateCheckpoint 只有在精确结果树补验通过后返回 validated。

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

执行前读取 [共享约束](workflow.md) 中适用条款；上下文、消息和恢复使用 [读取规则](context.md)。
