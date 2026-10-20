> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

# Task 5: 最大可行并行集合选择

**依赖与角色：** T1；backend_implementer → backend_validator → reviewer。

**共享约束：** [A.6](contracts.md#a6)、[B.1 / B.4](protocols.md)。

**Files / owned_files:** `scripts/orca-dag/scheduler.mjs`、`scripts/orca-dag/scheduler-worker.mjs`、`scripts/orca-dag-scheduler.test.ts`。纯求解逻辑与 Node worker_threads 执行适配分开。

**Interfaces:**

- **Consumes:** T1。
- **Produces:** `selectRunnable(dag, state, resourceSnapshot, searchCheckpoint, nodeBudget): ScheduleDecision`，纯函数，无进程和文件副作用；以及 `solveSchedule(input, searchBudget, searchCheckpoint, signal, onProgress): Promise<ScheduleDecision>`，在独立 Node worker thread 中分段求解，onProgress 向协调器交付可持久化进度。input 包含 dag/state/resourceSnapshot，schema 和输入哈希算法由 T1 固定。

**实施要求:**

- 按 Dependency.condition 过滤未满足的边：内部阶段按证据推进，跨业务任务须 verified 且前置已集成；读取共享资源快照，计入其他 Run 以及本 Run 实现、验证、Review、集成和未结算子进程的占用，按 reservation_id 去重。
- 文件所有权、资源容量和 Worker 槽位为硬约束；集成候选必须携带 T7 计算的回归资源集合。
- 用确定性分支定界求最大基数可行集合；候选按 ready_since 升序、剩余关键路径 estimated_seconds 降序、id 字典序排序，等基数集合按成员索引序列取字典序最小者。
- ready_since 来自持久事件。
- 严格最大基数不保证有界等待；长等待仅报告，不自动降低目标或抢占。
- 第一版不引入额外求解器依赖。

#### F6：分片求解与预算恢复

每片最多访问 sliceNodes 个搜索节点，并由 worker thread 的单调时钟按 sliceMs 分段交回进度；纯函数不读时钟。

search_checkpoint 包含待搜索 frontier、当前最优集合、上下界、累计节点数和 input_hash。累计达到 maxNodes 仍未证明最优时返回 budget_exhausted/exact=false，不派发该轮候选，status 报告阻塞原因和上下界。相同输入与预算不得自动从头重试；resume 只在明确提高 maxNodes 后从原 frontier 继续，或调度输入变化后重新求解。

心跳、无关日志不改变 input_hash；资源占用、候选资格或依赖证据变化则取消旧搜索。旧结果即使 exact=true，输入哈希或注册表修订号已过期也不能派发。

协调器不等待整个求解完成才处理消息；持续后台求解期间仍处理 settlement、ack、撤标及恢复。worker 线程退出不等于业务 Worker 退出，丢失的求解进度最多重做最后未持久化片段。

**测试断言:**

- [ ] A 同时冲突 B/C、B/C 互不冲突且容量 2 时选 B/C。
- [ ] 三个独立任务容量 2 时只选两个。
- [ ] shared/exclusive 正确互斥。
- [ ] 业务依赖缺少 integrated_checkpoint 时不释放。
- [ ] 相同输入结果确定。
- [ ] 用小图穷举 oracle 校验最大基数。
- [ ] 已运行 Worker 占用被计入。
- [ ] 验证阶段可调度且计槽位。
- [ ] 持续出现 B/C 时与两者冲突的 A 可被延后，报告此限制而不伪称防饥饿。

**专项验收：**

- [ ] F2/F4：共享快照中的跨 Run 占用和集成回归资源参与可行性判断，本 Run 已登记资源不重复扣减。
- [ ] F6：小图分片恢复与一次求解得到相同精确解；预算耗尽保留 frontier，不派发且不重复搜索；提高预算后继续；过期 input_hash 的精确结果被丢弃。
- [ ] F6：以可控同步屏障挂起求解 worker，证明主事件循环仍能响应消息；测试不得只靠机器速度或长 sleep 判断通过。

执行前读取 [共享约束](workflow.md) 中适用条款；上下文、消息和恢复使用 [读取规则](context.md)。
