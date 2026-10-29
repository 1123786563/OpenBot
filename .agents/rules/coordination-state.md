# 跨 Run 的共享协调状态

跨 Run 占用 Issue、工作区、分支、数据库、端口、Docker project、缓存或报告目录，以及恢复每日任务时读取。本规范定义共享位置和互斥协议；编码、版本化 schema、唯一公共事务入口及验收样例见 [coordination-format.md](coordination-format.md)，取得写入声明前必须读取并核实适配器。不宣称 Orca 已提供不存在的锁命令。

## 部署状态与启用入口

仓库当前提供协议、schema 和验收样例，未随仓库提供协调事务适配器或安全恢复工具的安装实现。本节是部署边界，不表示服务已部署；规则修订、空配置或新建 Run 都不能使能力自动就绪。

部署作为单独授权任务执行：先指定维护责任人及可访问的实现/版本、安装说明和验收入口，再登记到主机统一的 config.json。默认入口是项目目录下 `.coordination/v1/config.json`；覆盖入口必须由主机配置提供可核实的绝对路径，Run 回执保存该配置来源及实际解析路径。首次使用时，核实该项目的统一持久根后，若默认根目录不存在则创建 `.coordination/v1/`；其他 Worktree 或 clone 不得各自创建私有根。找不到默认或覆盖配置时报告缺失路径和受阻能力，不自行搜索秘密配置、生成空配置或编造适配器命令。

启用前按 [协调格式](coordination-format.md)完成协议验收并保存带工具哈希的回执；安全恢复工具还须通过 [checkpoints.md](checkpoints.md)的路径、文件类型及资源上限验收。随后按 [每日规则](closed-issue-daily-run.md)人工试运行，确认恢复、清理与证据读取后才能启用自动化。没有已验证实现或配置时，记录 `capability_blocked` 并继续不依赖这些能力的只读准备、分析和报告，不反复等待配置出现；需登记的副作用、受控恢复、跨 Run 接管及自动化启用仍受阻，不因当前只有一个 Run 而豁免。

## 位置与身份

- 同一执行主机使用一个持久的绝对 `coordination_root`。默认使用持久项目目录下 `.coordination/v1/` 的实际路径；覆盖位置须由该主机配置统一指定，所有协调器启动时核对相同值。其他 clone 或 Worktree 必须使用同一个已核实的共享根；无法核实时保持受阻。它不位于可清理的 Run/Worktree 中；不得为新 Run、clone 或 new-per-run 另起资源登记根。
- 根内保留 `host.json`、`registry.guard`、`claims.json` 和 `repos/<repo-key>/daily-ledger.json`。repo-key 从正式 tracker 的规范仓库身份生成（本仓库为 `github.com/1123786563/openbot` 的 UTF-8 小写十六进制编码），不依赖当前目录、分支或上游显示名称。Run 归档保存绝对共享路径及登记回执，共享 Ledger 保存 Run/工作区/检查点/证据索引的绝对引用和哈希。
- 资源键按真实排他域生成：Issue 使用规范仓库 + 编号，每日入口使用格式规范的 daily 元组（`daily:<repo-key>` 仅为显示别名）；工作区使用执行主机 + 物理路径；本地分支使用执行主机 + Git common dir + ref，远程写入另登记规范远程仓库 + 完整 ref（跨 clone 相同）；端口使用主机/网络命名空间 + 协议 + 地址/范围；数据库和迁移分别使用服务身份 + database/schema 的 database/migration 元组并互相检查重叠；Docker project、缓存及输出目录使用执行主机和实际名称/物理路径。通配绑定及端口区间按重叠检测，不用不同字符串规避同一资源。

派发前从本轮 Task source_issues 和实际修改/验收范围生成 issue_write_set，不能只登记根票。包含所有实际实施子票、会被改变状态/标签的票，以及将被修改的父级聚合状态；一次原子取得全集合，范围扩展先增补声明。父级纯只读摄取不锁整树；父级聚合验收/状态写入持 aggregate 声明，并以冻结 contains 闭包与任何其他 Run 的子票 write/聚合声明互斥；子票写入也反向检查现有祖先 aggregate 声明。每个 aggregate/Issue write 声明必须按 [协调格式](coordination-format.md)持久保存 relation_snapshot；空 evidence 或私有外部状态不能替代。适配器须在登记锁内重新读取并核对关系版本与闭包，旧快照以 `stale_relation` 拒绝。

每次 Issue/聚合副作用前再次核对 contains 关系和声明快照；优先使用外部关系版本条件写。无法提供条件写时，由唯一持有声明的副作用执行器串行完成“关系 rescan→意图核对→副作用→回读”，任何失配立即标 unverifiable 并停止其他相关写入；不能证明关系仍新鲜或旧请求已排空时保持 blocked。不得用本地 revision、一次启动前对账或不同编号代替关系新鲜度。

Issue 和每日入口声明由 Run 持有，允许该 Run 已登记的各阶段关联同一声明；不要求同一 Run 的每个子 Task 重新抢占本 Run 的 Issue。工作区、分支及测试资源按实际阶段独占，Run 内也不能并发写同一排他资源。read/read 可共享，其余兼容关系按 [协调格式](coordination-format.md)矩阵执行。Run 结束或等待外部条件时，先安全结算，按证据保留/释放声明；共享 Ledger 中的恢复索引本身不持续占有资源。

主机配置统一保存到 coordination_root/config.json，至少登记协调适配器绝对入口/版本/内容哈希、schema 兼容范围、验收回执、心跳/TTL、服务别名映射，以及安全恢复工具入口/版本/验收与最大文件数、单文件/总展开大小、压缩比、链接深度。配置只含身份和受控凭据引用，不存秘密；缺项记 capability_blocked，不把文档当成已部署。根目录名中的 v1 是位置名称，不是 schema 版本，数据升版继续使用原根与锁；已有共享根须按恢复索引迁移门禁迁移，不直接新建空根替代。

## 占用与释放

1. 在启动、集成或测试副作用前，使用 OS 排他文件锁保护 `registry.guard` 的一次登记事务（Unix 可用 `fcntl.flock`，其他平台使用已验证的等效实现）。锁文件保持原 inode，不删除或以 rename 替换；不支持可靠锁的文件系统不得充当共享登记后端。
2. 持锁读取声明，检查所有重叠的资源及 Issue；一次原子取得本阶段所需集合。声明含 `owner_run / coordinator / host / task / attempt / token / generation / state / created_at / heartbeat_at / expires_at / evidence / relation_snapshot`，state 区分 reserved、running、settling、unverifiable。登记须经过唯一公共事务入口，按格式规范完成可恢复 journal、文件 flush+fsync、原子替换及父目录 fsync；失败则不启动副作用。取得后在 Ledger 逐项记录 token/generation，实际 Dispatch 回执到达后补登记；无回执先对账。
3. 每次开始副作用及恢复时逐项核对当前 token/generation；支持 fencing 的外部服务须在资源侧校验 generation，不能只本地检查。GitHub 等不支持 fencing 的服务须由唯一持有声明的副作用执行器串行发送，记录意图/请求 ID，接管前取消或排空旧请求并回读对账；不能证明旧拥有者不再写入时保持 unverifiable，不发新请求。资源不能在另一个拥有者下继续使用。结束时持锁逐项核对拥有者和 token，保存结算/退出及资源清理证据，再释放声明。不是自己的 token 不得删除，Ledger 声称空闲或进程列表缺席不等于已释放。
4. 默认每 60 秒心跳，expires_at=最后心跳+5 分钟；主机统一配置可调整但须记录。到期只触发核查，先标 unverifiable，核对执行主机、Orca Dispatch、实际进程和副作用。仅取得原拥有者已安全结算或正面退出、所有在途请求已取消/排空并对账及资源安全的证据后，才在登记事务中接管并逐项递增 generation；不以 TTL 到期直接抢锁。

跨主机操作同一 Issue、共享数据库或工作区时，须使用所有参与者共用且支持原子事务的协调后端，或已有可核实的唯一协调者。上述本地目录只证明单主机互斥；远端覆盖、后端一致性或所有权无法核实时保持 blocked，不把本地无记录当作远端无人占用。只读查询可继续，不能据此启动潜在重叠写入。

每日任务的共享 Ledger 只维护队列与恢复索引，不替代 Orca 的 Dispatch 事实或 SDD 的活动 Ledger。更新时通过唯一公共事务入口，按 [coordination-format.md](coordination-format.md)校验 schema_version、expected_revision、状态迁移、追加事件和完整逐票/调度字段，保留历史和最后一次有效结论。恢复引用迁移时先冻结源写入并复制同代快照、核验目标，再事务性替换所有活跃 Run/每日条目的旧绝对路径与哈希；从共享 Ledger 实际重新读取新索引及证据成功后才允许删除旧 Worktree。保留旧→新映射，失败则保留源，不以复制成功代替引用更新。
