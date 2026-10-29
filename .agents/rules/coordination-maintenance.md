# 协调协议迁移与上线验收

仅部署、维护、升级适配器或核验相应能力时读取；日常入口为 [共享协调](coordination-state.md)，运行合同为 [协调格式](coordination-format.md)。迁移与验收要求不因拆分而豁免；未通过匹配当前版本的验收仍须阻塞相关能力。

## 版本迁移与参与者升级

v3 严格拒绝未知 schema_version、未知枚举/字段；迁移须在锁内备份旧文件、核对活跃拥有者/事务、生成新版本并验证全体参与者兼容后切换。v1→v2 必须在原持久根及原锁内冻结全部写入、备份旧内容/事件/高水位，保留 claim 的 owner/token/generation，不另建根或重置代次。旧事件保存为 legacy manifest；无法从证据重建 Run/类别/容量时不猜填，先安全结算旧 slot，以具名迁移回执建立新调度基线。旧 verified 按当前指纹和策略重验后才能恢复。

v2→v3 同样在原持久根及原锁内冻结并备份，保留 generation 高水位、request 幂等记录和事件顺序。旧 slot 缺少 slot_kind 时先按原 Dispatch 安全结算并存入 legacy manifest，不猜测动作类型；新 slot 必须使用 v3 完整字段。旧 action_reason 仅保留为历史，按各 intent/receipt 重建三个动作的独立原因、下一步、wait_reason、input_fingerprint 和恢复条件，证据不足的对象保持 blocked；decision/human_review 经完整 rescan 后填写，无取消决定时 decision=null，有人审终态决定时绑定其指纹和证据，不能批量假定 approved。无人审终态但当前标签或 intent/receipt 表明仍待人审时 human_review_state=pending；确认没有待人审标签或待办意图时才为 none，已有 applied_valid/pending 不得迁移为 none。从未服务票的 enqueue_sequence 固定为迁移时当前 slot_sequence，已有 last_slot 的票保留该服务序号及原入队历史证据；repair_rounds_total 按同一审计票全部 Task/finding 的可核实旧修复 Dispatch 事件跨 Run 求和重建为保守历史锚点，不能倒推合并成更少波次；无法完整重建时不得完成迁移或继续修复。旧等待记录须按统一算法重建成硬条件、探测或组合形状，无法区分时保持 blocked 并人工对账。迁移验收通过前不接受 v3 新写入。

本轮保留 v3 Ledger 外壳字段/枚举；新增独立 manifest 定义和选票/预算/波次语义随 policy revision 记录。适配器必须读取引用对象并分别按对应 $defs 校验，不能只验证 Ledger 外壳。已部署参与者升级前须在原锁内停止写入、备份并安全结算全部旧 slot/Dispatch，再从选择事件重建公平游标和服务顺序、从旧计数建立不减小的修复历史锚点；缺选择顺序或身份证据则保留旧投影并 blocked，不能猜填 P、预留或活跃波次。原 capacity=1 不自动变 4，新的 C/P 仅经有效配置在新 Run 生效。完成新增样例及 schema 验收后切换，补足真实取消证据；不能清零预算、清空 rejected 或据 schema_version=3 推断兼容。未完成验收的适配器保持 blocked。

## 上线与升级验收样例

至少验证以下样例并保存结果；这些是协议验收要求，不宣称已有后端已运行：

| 输入/故障 | 必须结果 |
| --- | --- |
| HTTPS/SSH 别名、跨 clone main 写、通配端口与区间 | 规范身份后第二拥有者冲突 |
| 父子两种申请顺序、关系快照变化、contains 对账后登记前变化 | 同快照互斥；过期快照以 stale_relation 拒绝，不启动副作用 |
| 重复 daily record/Issue/子票/(resource_key,owner_run)/event_id/slot | 全部 validation_failed，无副作用 |
| 无目标/指纹/checkpoint/review 的 verified，无回执的 delivered/applied_valid | 全部拒绝；合法 stale→revalidating→重验路径可持久化 |
| 无 decision 的 not_required；无 human_review 的 approved/rejected；人审终态重新贴标；not_required 新建 label_pending/close_pending | 全部拒绝；有效取消和人审终态 class=null，仅具名遗留动作可 recovery |
| 终态只有 label/close stale；无等待的 correction_pending/delivery_pending/integration_pending；同类动作仍有等待或退避 | stale 可选择 recovery 先回读；无等待动作必须 recovery；有等待动作可 class=null，唤醒后转 recovery |
| 已有待人审标签从 v2 迁移；普通 none 发起贴标 | 分别初始化为 pending；贴标意图与 none→pending 同事务，applied_valid 不接受 none |
| 同一审计票跨 Run 打开第 5 波；v2 历史累计大于 5 | 第 5 波只继续冻结且尚未尝试的成员；结束仍未解决则 repair_round_limit blocked，禁止第 6 波。旧累计不减小，大于 5 时阻塞新增修复 |
| revision=4 的两个并发请求 | 仅一个写成 5，另一个无副作用拒绝 |
| 旧 token/generation；逐项批量 acquire/release | 旧代次拒绝；各资源分别严格递增，不能共享高水位 |
| 同 request_id 同/异载荷；journal 压缩后重放 | 同载荷返回原回执；异载荷拒绝；去重记录仍有效 |
| 替换第一个文件后崩溃、journal 或父目录 fsync 失败、内容段丢失 | 恢复为完整旧代或新代；内容不足则 unverifiable，不接受新事务 |
| 重置 next_class/计数、截断 history、slot 重号、selected 后崩溃 | 任意调度改写拒绝；崩溃后先对账原名额，不重复选择 |
| recovery/new/revalidate 持续非空、C=1 与 C=2；同类持续有新到票或旧票连续动作 | 每轮不超过 C 个不同名额，按 last_slot ?? enqueue_sequence 轮转，同键新票优先，新旧票服务上界均成立，不重复执行未结算票 |
| 空等待、缺 input_fingerprint/source_ref、expected≠observed | 非法组合拒绝；硬条件不满足不执行副作用，纯/组合退避到期只按算法探测或唤醒 |
| 同票 label+close+delivery 待办、动作不同恢复原因；纯动作退避缺动作输入指纹 | 分别选择 slot 并保存 slot_kind，动作级原因/条件/指纹互不覆盖；缺指纹或非法等待形状拒绝 |
| 父/子 target_sha 不同、子项缺顶层记录、无新 SHA manifest 的旧 SHA 证据聚合 | 拒绝父票 verified/贴标；有有效影响分析和 revalidation manifest 的承接证据可进入新 SHA 聚合 |
| verified 父票含同 SHA verified 子票与有权取消的 not_required 子票 | 核实取消决定覆盖父级对应要求及当前子票指纹、父级其余验收通过后可 verified；取消子票不要求目标 SHA/检查点 |
| 取消子票缺当前指纹/decision，或父票含 failed/unproven 子票 | 拒绝父级 verified；取消子票不冒充 verified，聚合不丢弃原 contains 项 |
| rejected 仅因原验收下的实现缺陷，已有修复授权 | state_changed 留存旧决定/检查点及前后状态，关联 finding 和新 attempt，当前人审转 none、验证转 finding_confirmed；原需求指纹不变，入队/服务序号和修复累计次数不重置 |
| rejected 无修复授权、无 finding 或试图原检查点直接重新贴标 | 保持 rejected/等待；新 attempt 仍须独立验证/复审及目标门禁，新检查点通过后才 pending |
| integration_pending 后确认 finding 或进入新修复 attempt | finding_confirmed/repairing 可保留历史本地 checkpoint/review；当前不得贴标或关闭 |
| read/read、read/write、aggregate/write、migration/database | 按兼容矩阵共享或互斥，不用不同资源键规避 |
| 特殊平台路径、硬链接/特殊文件、展开资源超限 | 全包预检失败且零部分写入 |
| 恢复索引迁移中断 | 原或新完整一代可读，未更新引用前禁止删除源 |
| C=4、P=2，两票 audit 后需贴标 | n=2/r=2 时拒绝第三个 audit；两票就绪 label 按公平队列分别选 slot，n=4/r=0，无越额；C=1 且 reserve_label_slots=true 拒绝 |
| audit 失败/无需贴标，或 label 预留消费后重复释放 | 保存原因并只释放一次；重复事件幂等，原动作等待不被抹掉，不能把预算释放当动作成功 |
| 三类持续可接纳、P=3，三个任务逆序完成 | 选择按 new/revalidate/recovery 轮转；settled 不再次推进游标，连续选择与任意完成顺序重放结果一致 |
| 已选/启动意图后崩溃，或旧 Worker 未证明退出 | 同票不再选名额，原尝试占 P；先对账，不因列表缺席或超时释放容量 |
| 两张无共同父票的 finding 在同一 daily batch Run | source_issues/scope 和每 Task 归属完整；终审覆盖授权增量并集，未授权票不可写，不制造父票 |
| P=2 但无并行实现授权；共享数据库/输出资源冲突 | 写代码阶段全局最多一个；只读审计也先隔离资源，冲突任务等待并保存原因，不降低既有授权/独立性门禁 |
| 五个 Task 的首次修复、同 Task 再试或追加成员 | 首次冻结为一波且只计一次；同 Task 第二次写入/新增成员须下一波，换 Task/finding 别名不能绕过 |
| max_run_repair_rounds=1，已打开一波且时间/P/资源充足 | 可执行其冻结未尝试成员，只拒绝第二次开波；时间耗尽才安全结算，不在首次开波后立即空转退出 |
| 不透明非空 Run ID、后续波次缺历史锚点 | Run ID 沿用现有事件的非空字符串契约；空 ID、round_number>1 且 previous_wave=null 拒绝，锚点权限/关联另验 |
| 同波跨日恢复、第 5 波未尝试成员、波次打开后崩溃 | 同 wave_id 重放不再计次；第 5 波剩余成员可恢复，实际尝试不得重做；未解决不打开第 6 波 |
| 旧五次 Dispatch 计数迁移，或缺失旧选择顺序 | 旧计数至少仍为 5，不合并降额；缺顺序/身份证据则 blocked，旧容量不自动扩至 4，验收前不接纳新语义 |

新增适配器验收还须覆盖：双读者分别续租/释放后写者才可取得；integration_pending→revalidating/blocked 可落盘；无 slot 的失效事件可重放；跨 Run 恢复不重占名额；同类 A/B 持续可行动时 C 必须获得服务；父级 epoch 跨日完成后目标前移保持历史且不贴标，稳定窗口内连续 Run 的容量只在新 Run 生效；v2→v3 迁移保留 generation 高水位且不猜填 slot_kind、人审或动作恢复字段；关闭 pending 对账不依赖当前标签。

