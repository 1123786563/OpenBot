> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

# Task 1: 冻结运行契约与状态约束

**依赖与角色：** 无；backend_implementer → backend_validator → reviewer。

**共享约束：** [数据契约](contracts.md)、[B.1–B.2](protocols.md)。

**Files / owned_files:** `scripts/orca-dag/contracts.schema.json`、`scripts/orca-dag/contracts.mjs`、`scripts/orca-dag-contracts.test.ts`。

**Interfaces:**

- **Consumes:** 会话需求、AGENTS。
- **Produces:** `validateDocument(kind, value): {ok, errors}`、`canTransition(entityKind, from, to, evidence): boolean`，以及[数据契约](contracts.md) 的 JSON schema。

**实施要求:**

- schemaVersion 固定为 1；配置要求 repo、root_issue、scope、capacity、roleRouting、executionMode、runDir，另含 workerBackend（固定为 `pi`）、resourceCatalog 和 searchBudget（sliceNodes/sliceMs/maxNodes 均为正整数）。
- 调度策略固定为 strict-max-cardinality，登记本地主机、操作系统用户及 Git common dir 身份。
- scope.mode 固定为 root-tree，快照包含 scope_revision 和树指纹。
- executionMode 支持 dry-run/start/resume；capacity 无值或 root_issue 缺失时禁止 start。
- 角色映射由实施前核实的运行配置显式提供，不能假设 Orca --agent 等于专业 agent_type。
- 对外来 Issue 文本只按数据处理。
- 冻结 F1–F6 的状态、数据类型和资源作用域；canTransition 必须校验恢复裁决与范围承接证据，不能只比较状态字符串。

**测试断言:**

- [ ] 缺少 owner_role 拒绝。
- [ ] 容量 0 拒绝。
- [ ] workerBackend 缺失或不为 `pi` 时拒绝实际启动；角色配置不能覆盖该后端要求。
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

执行前读取 [共享约束](workflow.md) 中适用条款；上下文、消息和恢复使用 [读取规则](context.md)。
