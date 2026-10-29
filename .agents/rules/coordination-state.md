# 跨 Run 的共享协调状态

跨Run占用Issue、工作区/分支、数据库/端口/Docker project、缓存/报告目录或恢复每日任务时读取。Orca/共享资源/每日任务须登记；普通单写者、单工作区且已证明隔离的资源不进入本协议，归属不明先核验。

Agent使用统一适配器及回执，不手工写Ledger/锁。日常按下表读取 [coordination-format.md](coordination-format.md)适用条款，底层结构/语义由已验适配器执行；维护/升级适配器须满足完整合同与验收，不能以缩短阅读豁免能力。

| 操作 | 协调合同条款 |
| --- | --- |
| 取得/更新/释放资源 | 唯一身份与编码、公共事务入口 |
| daily选票/修复/动作恢复 | 每日Run调度与修复波次、状态与调度不变量 |
| 故障恢复/协议升级 | 持久化与崩溃恢复、迁移及上线验收 |

## 部署状态与启用入口

部署单独授权，先确定维护者、实现版本、安装/验收入口；配置/Schema/新Run不等于部署。

默认持久项目 `.coordination/v1/config.json`，覆盖须主机配置给可核实绝对路径。Run记配置来源/解析路径、适配器绝对入口/版本/内容哈希/Schema兼容/协议回执、心跳TTL/服务别名、安全恢复工具入口/版本/验收及文件数/单文件/总大小/压缩比/链接深度上限。配置只存身份与受控凭据引用，缺项capability_blocked。

首次核统一持久根，不存在才创建，clone/Worktree不私建第二根。缺配置报告路径/能力，不搜秘密或造空配置。启用前核协议与 [安全恢复](checkpoints.md)验收回执绑定当前工具哈希/配置，再按 [daily](closed-issue-daily-run.md)人工走完一票的恢复/清理/证据读取；仅case名称或文件存在不证明验收匹配。

无有效能力只继续独立只读准备，声明相关副作用、受控恢复、跨Run接管/自动化启用保持阻塞，不因单Run豁免或反复等待。

## 位置与身份

同主机全部clone/Worktree共用不随清理消失的绝对物理coordination_root；无法核实阻塞。根内host.json、原inode的registry.guard、claims.json、repos/<repo-key>/daily-ledger.json；v1目录名不等于Schema版本，升级沿用原根/锁。

Run保存共享根/声明回执；共享Ledger只存队列与Run/工作区/检查点/证据绝对引用及哈希，不替代Orca Dispatch或SDD活动Ledger。资源按真实排他域规范化/验重叠，包括跨clone远程ref、通配/区间端口、数据库/迁移、Docker、路径/别名，字符串不同不产生第二资源。

派发前按source_issues和实际修改/验收范围原子取得完整issue_write_set，含实施子票、状态/标签票、父聚合；扩范围先增补。父纯读取不锁整树；aggregate按完整contains后代闭包与子票write/重叠aggregate互斥，Issue write反查全部祖先aggregate。二者保存relation_snapshot；适配器持锁重读关系版本/闭包，过期stale_relation，不能用空证据/私有状态替代。

每次Issue/聚合副作用前重核contains/快照，优先外部版本条件写，否则唯一声明执行器串行rescan→意图→副作用→回读。失配unverifiable并停写，无法证明新鲜或旧请求排空则阻塞，本地revision/一次预检不替代。

Issue/daily声明由Run持有，阶段关联而非子Task重抢；工作区/分支/测试资源按阶段独占，read/read共享，其余按兼容矩阵，Run内也不并发写同排他域。等待外部条件先结算再保留/释放；恢复索引不占资源。

## 占用与释放

1. 副作用前公共transaction原子取得完整资源集。registry.guard为可靠OS排他锁、保持inode，不删除/rename替换，不可靠文件系统不可用。结构/语义、expected_revision、追加事件/完整调度字段、journal/fsync和崩溃恢复按协调合同，失败不执行副作用，保留历史/最后有效结论。
2. 逐资源记录token/generation，回执后补Dispatch，响应丢失先对账；每次副作用/恢复核代次。fencing在资源侧核验；无fencing则唯一持有者串行发送并存意图/请求ID，接管前取消/排空旧请求并回读，无法证明停写不启动新者。
3. 默认心跳60秒、最后心跳后5分钟到期，主机可统一调整并记录。到期只标unverifiable并核主机/Dispatch/进程/副作用；正面退出或安全结算、在途排空对账及资源安全证据齐全才事务接管、逐资源增generation，TTL不授抢占。
4. 结束持锁核owner/token，存退出/结算/清理证据再释放，不删他人token。空闲投影/列表缺席/超时不证明释放；跨主机须共享原子后端或可核实唯一协调者，不以本地空记录推断远端无人，无法核实只读。

迁移恢复引用：冻结源写者→复制同代快照核目标→事务替换所有活跃Run/每日条目的旧路径/哈希→从共享Ledger实际试读新索引/证据→才删除源工作区。保留旧新映射，任一步失败保留源，复制不代替引用更新。
