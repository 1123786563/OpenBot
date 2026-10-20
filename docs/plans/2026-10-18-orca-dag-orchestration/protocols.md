> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

## 附录 B：阶段推进、执行权与恢复协议

### B.1 阶段门禁（T1 定义，T5/T6/T7/T8 实现）

业务 Task 是聚合对象，不作为内部阶段必须等待 verified 的前置节点。每个业务 Task 展开以下有限阶段链，阶段完成后标 succeeded，业务 Task 直到最后一阶段通过才标 verified：

| 阶段 | 进入条件 | 完成产物 |
| --- | --- | --- |
| implement | 上游业务 business_verified，且前置产物已进入本工作区 | artifact_ready：实现检查点，Worker 已接受 settlement |
| validate | artifact_ready | validation_passed：针对该受测代码树的通过证据 |
| review | validation_passed | review_passed：独立 Spec 与质量结论 |
| integrate | review_passed | integration_validated：应用回执和集成代码树验证 |

下游业务边等待 integration_validated 汇总为 business_verified；不得把内部 validate 的前置写成同一业务 Task verified。集成由协调器串行执行，不启动实现 Worker。实现、验证和 Review 均派发 Pi 子 Agent；验证和 Review 各占真实 Worker 槽位，三者身份相互独立，复用终端不得复用实现者身份批准自己的实现。实现 settlement 后释放其计算槽位，保留不可变产物；验证/Review 对同一快照只读，后续修复须等待读者结束再生成新 attempt。

### B.2 失败分类与运行时修复（F1；T1/T4/T6/T7/T8）

业务 Task ID 在修复中保持稳定；每轮产物使用新 attempt_id，每次阶段执行使用新 stage_attempt_id。新阶段或产物修复创建独立 Orca Task/Dispatch；同一产物的失败阶段重试可复用已核实失败的 Orca Task，但必须有新的 stage_attempt_id 和 Dispatch。业务聚合对象不映射成可由 worker_done 完成的 Orca Task。worker_done 的成功只证明阶段工作已完成，Review 的业务通过仍取决于报告结论。

| 失败类别 | 状态与裁决 | 恢复入口及证据规则 |
| --- | --- | --- |
| Worker 已确认退出但未正常结算，或检查环境故障 | 阶段 failed，业务 blocked；持久化 retry_stage 裁决 | 先按 Orca 恢复协议结算旧 Dispatch；同一不可变产物可重试失败阶段，保留仍有效的前序证据 |
| 验证发现代码缺陷，或 Review 有有效阻塞 finding | 阶段 failed，业务 blocked；持久化 repair 裁决 | 主协调器调用 writing-plans 形成仅覆盖 finding 的修复 Brief/DAG；新业务 attempt 从 implement 开始，再执行 validate、review、integrate |
| 集成后回归失败或需要冲突解决 | integration intent 保留 applied/blocked，受影响业务及后继暂停；持久化 repair 裁决 | 保留现场，锁定目标工作区的后续集成；以失败组合树作为修复基线，独立实施者修复并重新验证、Review，最后创建引用旧 intent 的新集成事务 |
| 需求变化但可复用现有产物 | 业务 revalidation_required；持久化 revalidate 裁决 | 按新要求从 validate 开始，重新 Review 和集成门禁；不因重新验证创建实施 Worker |
| 活跃写入者、启动结果或资源占用不可证明 | 阶段 unverifiable，业务 blocked | 只对账，不重试、不新开编辑者；取得正面结算/退出证据后再分类 |

RecoveryDecision 必须先写日志，再生成修复任务或重试阶段；重放同一 finding/失败事件不得再创建一轮。原有审查和验证记录保留为历史，新产物不得继承旧产物的通过结论。修复使已验证产物失效时同步冻结后继并排入撤标 outbox。集成失败后的测试进程确认退出后可释放测试资源，目标工作区的恢复声明继续保留；修复集成只能在该声明下对账后进行，不允许普通集成越过故障树。

修复 attempt 使用新的 Orca 阶段 Task，不对先前成功的实现 Dispatch 使用 `--retry-of`。只有当前版本 Orca 确认的失败 Task 才走失败重试适配，并显式传入原 Task、失败 Dispatch、placement 和角色配置。每个业务任务单个 SDD 修复计划最多 5 轮，第四、五轮按仓库规则升级；连续两轮同一 finding 无进展进入 systematic-debugging，超限或缺必要输入时记录 blocked 和恢复条件。外层 OCR 遵循[主入口执行裁决](../2026-10-18-orca-dag-orchestration.md#execution-ruling)；其修复使用独立编号计划，不重置历史计数以伪装进展。

### B.3 仓库级声明（T3/T8）

第一版限定同一主机、同一 Git common dir 的协调器；声明目录固定为该 common dir 下 `orca-dag/claims/`，不能由各 runDir 自选。跨主机或独立 clone 缺少共享权威注册表时禁止 start，不声称支持全局唯一性。

以 repo + source_issue 为保守独占粒度：同一 Run 内多个切片可共用 Run 声明，跨 Run 不可共享。声明按 purpose 记录 implementation 与 review_sync 的持有者，两种用途对其他 Run 同样互斥；同 Run 增加用途不更换 owner。父级聚合 Issue 不因 contains 领取实施声明，但同步其评论/标签前必须领取 review_sync 声明，仅锁该父 Issue，不锁整树。无 source_issues 的工具任务使用明确配置的 scope key。事务内原子领取任务涉及的全部 Issue key，再持久化 attempt 启动意图；任一 key 冲突则不新增任何领取。持有者未知、启动响应丢失或 Worker 未确认退出时不因超时回收。

实施用途在 Run 完成或显式移交且关联尝试安全结算后释放；同步用途还须全部 outbox 已对账、没有在途写请求，且 Run 已结束或完成移交才能释放。纯聚合父 Issue 通过独立同步领取接口使用 outbox ID 作为 holder，无需创建空实施 Task。移交递增 claim epoch，转移未完成 outbox；旧 epoch 禁止新的 GitHub 副作用，无法确认旧在途请求已结束时阻塞移交。

恢复先对账注册表与 Run 日志；领取后、写启动意图前崩溃留下的声明保持 reserved，只有能证明启动调用必需的持久意图尚未发生，或取得已启动尝试的正面退出/结算证据，才可恢复或释放；仅枚举不到 Worker 不算退出证据。已有非本工具 Orca Worker 仍须启动前检查；无法证明其范围不重叠时阻塞，不能将本工具锁宣传成对任意外部编辑者的强制锁。

### B.4 资源作用域与跨 Run 预留（F2/F4；T1/T3/T5/T7/T8）

资源身份为 scope + scope_id + key：workspace 使用核验后的工作区身份，repo 使用规范化 Git common dir，host 使用本地主机身份。实际共用的数据库、端口和外部产物目录必须使用相同的 host 资源 key，不能按 Run 或工作区改名规避冲突。容量取共享注册表中的定义，Run 配置只能收紧自身预算，不能覆盖共享容量；容量定义冲突时 preflight 拒绝启动。

T3 在当前操作系统用户的固定目录 `~/.local/state/orca-dag/resources/<host-id>/` 维护所有上述作用域的资源注册表、修订号和持久事务日志，runDir 不能自选注册表位置。第一版仅保证同一用户、同一主机的受管 Run；跨用户/主机或不受管占用无法证明安全时阻塞，不声称强制隔离。Issue 声明仍使用 Git common dir 下的注册表。

每次派发先读取全局资源快照求解，再在资源注册表锁下核对修订号并原子预留所选集合的全部资源；任一资源冲突则全部失败并重新求解。随后按 holder 领取 Issue 声明和持久化阶段启动意图，成功后才启动副作用。某 holder 的 Issue 领取失败且可证明未写启动意图时，只释放该 holder 尚未使用的新预留，不释放同批已经启动的其他 holder 的资源；崩溃留下的预留按 Run 日志对账，不能因超时回收。所有入口遵守资源预留→Issue 声明→启动意图的顺序，避免反向等待。

资源预留覆盖实现、验证、Review、集成及其测试子进程。原子领取可以返回同一 holder 的多个 reservation_id，使工作区独占资源与测试资源可在满足各自释放条件时分别结算。accepted settlement 只有同时证明该阶段的资源使用已结束才允许释放；遗留子进程占用记 unverifiable。同步声明不占模型 Worker 槽位。T5 只读取快照并计算，实际资源领取、释放和恢复均由 T3 完成；不同 Run、不同 Issue 也必须经过同一资源仲裁。

### B.5 集成事务与证据（T3/T7）

幂等键为 task_id + attempt_id + checkpoint_hash + target_workspace。集成锁覆盖准备、写入、回执及集成验证。写文件前持久化 intent（日志 fsync 后才允许副作用），记录完整前置树哈希、预期结果树哈希及每个授权文件的前后哈希、删除和模式信息。state.json 为可重建投影；替换后同步目录。半写日志尾部不得静默跳过，保留异常证据并从最后有效记录与 intent 对账。

恢复若目标等于 pre_tree_hash 则尚未应用，可继续；等于 post_tree_hash 则已应用，只补回执与缺失验证，不能重放增量；部分写入只有在逐文件均为已记录前态或后态、没有第三种内容且写权限仍独占时才可完成剩余写入。出现外部修改或无法证明所有权则 blocked，保留现场，不盲目覆盖或回滚。

checkpoint_hash 标识授权增量；tested_tree_hash 标识完整受测代码输入，包含 BASE、前置增量及相关未跟踪源码/配置，排除显式列出的日志、凭据、缓存和构建产物。独立 Worktree 的通过结果不自动证明合并后通过：每次集成必须在精确结果树上运行该任务验证及所有已集成任务声明的回归检查，再释放下游。集成引入冲突解决或任何超出已审查增量的内容时，必须形成新检查点并重新独立 Review，不能仅靠补测放行。后续集成改变树时旧树证据保留为历史，未完成补验前不能把其当当前组合的通过证据；行为失败阻塞集成门禁及受影响后继。

集成前构建 IntegrationVerificationPlan，固定目标树版本、已集成检查点列表、检查命令及资源集合，并计算 verification_plan_hash。第一版串行运行这些检查：同一资源只要任一检查要求 exclusive 就按 exclusive 领取，否则 shared 的 units 取各检查最大值；合并 workspace 独占集成资源及其他所需资源，一次原子预留整个集合。资源未就绪时不写目标文件、不启动测试。预留后再次核对目标树与已集成集合，变化则释放未使用的预留并重算计划。正常集成在全部检查进程结束后释放预留；失败时可释放测试资源，保留工作区独占预留。修复事务凭旧 intent 和 RecoveryDecision 原子承接该工作区预留并领取新的测试资源，不先释放故障树锁，也不再次争抢自己持有的预留。集成不占模型 Worker 槽位，但必须占用其实际使用的测试资源。锁住集成入口不能替代数据库、端口等资源预留。

### B.6 范围变化与证据失效（T2/T6/T8）

T2 仅输出 Issue 级 added/removed/changed 和变更字段；T6 使用当前 DAG、验收映射及新分解计算任务影响闭包，并将现有任务完整划分为 affected、unaffected、removed。验收、接口、依赖或批准 Spec 变化使对应 requirements_hash 失效，已 verified 任务进入 revalidation_required，下游暂停。纯展示字段变更可由协调器记录理由后保持有效。重新验证通过可恢复 verified；确需改代码才创建修复 attempt，且旧写入者必须已安全结束。被移出范围的既有改动必须记录保留/后续处置裁决，不自动撤销。

scope_revision 迁移、受影响证据失效和未受影响任务的 ScopeCarryForward 资格作为同一个可重放事件生效。requirements_hash 只包含该任务的规范化需求、相关 Spec/ADR、接口及前置条件，不包含全局 scope_revision 或无关 Issue 字段。对 unaffected 的在途阶段，保留原 Dispatch 权威性；结果到达时核对需求哈希、前置检查点、接口/所有权哈希及结果代码检查点，全部匹配才原子记录 accepted 承接和正常阶段推进。原始证据保留旧版本，另建引用原证据的新版本绑定，不能直接改写旧记录。已 verified 的无关任务也必须留下承接依据。经历多个 rescan 时逐次核对完整承接链，不能跳过中间失效版本。

affected 的旧结果归档后，阶段执行仍须完成 settlement/资源结算；业务状态显式进入 revalidation_required 或 blocked，再按失败分类协议处理，不能永久留在 running。removed 的任务停止后续派发，已有执行按生命周期安全结算后记录移出范围裁决。版本迁移与消息到达通过同一 Run 修订号串行化；重复 Delivery 或恢复重放只生效一次。旧版本结果只有有效承接记录才能推进当前门禁，受影响结果不能借承接绕过重新验证。
