> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

# Task 6: Issue 验收转为可派发 DAG 与 Brief

**依赖与角色：** T2（传递依赖 T1）；backend_implementer → backend_validator → reviewer。

**共享约束：** [B.1–B.2 / B.6](protocols.md)。

**Files / owned_files:** `scripts/orca-dag/planner.mjs`、`scripts/orca-dag/brief.mjs`、`scripts/orca-dag-planner.test.ts`。

**Interfaces:**

- **Consumes:** T1、T2 snapshot 和经主协调器审阅的任务分解 JSON。
- **Produces:** `compileDag(snapshot, decomposition): DagResult`、`renderBrief(task, facts): string`、`analyzeScopeImpact(delta, currentDag, acceptanceMap, decomposition): ScopeImpact`（返回 affected/unaffected/removed_task_ids、传递影响、失效理由、需求哈希和承接资格）、`compileRecovery(decision, reviewedRepairDecomposition, currentDag): RecoveryPlan`。RecoveryPlan 包含阶段入口、修复子 DAG、证据失效集合及轮次；无代码修复时分解可为空，repair 必须提供经主协调器审阅的分解。任务分解由协调器依据 Spec/ADR/Issue 作出，不从自然语言自动猜出可信依赖。

**实施要求:**

- 检查唯一 ID、依赖引用、自环、环路路径、验收覆盖、文件所有权和接口消费者/生产者；按[B.1](protocols.md) 阶段门禁表生成 implement/validate/review/integrate 节点及带 condition 的边，业务 Task 只作聚合，不形成自等待。
- 聚合父 Issue 不重复实现。
- 推断边带证据；未解决冲突节点不 ready。
- Brief 含单任务上下文、报告路径、前置产物、Pi 执行后端、职责角色、检查点策略、禁止再派发及失败处置；角色与后端核验遵循 [Pi 派发规则](workflow.md#pi-dispatch)。

- Brief 生成还须满足 [context.md 第 1、4 节](context.md) 的上下文隔离、引用版本与验收完整性要求。

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

执行前读取 [共享约束](workflow.md) 中适用条款；上下文、消息和恢复使用 [读取规则](context.md)。
