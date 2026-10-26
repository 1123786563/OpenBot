# 共享协调 v1 数据与适配器契约

登记资源、更新跨日队列或恢复索引时，由 [coordination-state.md](coordination-state.md)加载本文件。下述是协议要求，不宣称仓库已有可用实现。启动时须登记唯一公共协调适配器的绝对入口、版本和内容哈希，并让所有参与者使用同一入口；接口逻辑名为 `transaction(request)`，不是可直接执行的 CLI。仓库未提供实现或外部适配器未通过本节样例时，跨 Run 写入保持 blocked，可继续只读检查；禁止各 Agent 临时各写一套不兼容 Ledger。不能以文档协议冒充已部署服务。

## 唯一身份与编码

- repo_identity：tracker 的规范 host/owner/repo，全小写、无协议、无 `.git` 或尾斜线；SSH/HTTPS/别名通过已核实的远程仓库身份映射到同一值。OpenBot 固定 `github.com/1123786563/openbot`。重命名/转移保留已批准别名映射，无法核实身份先 blocked。
- repo-key：repo_identity 的 UTF-8 字节逐字节转为两位小写十六进制，无前缀。它是文件名编码，资源身份仍用 repo_identity。例 `a/b/c` → `612f622f63`；禁止 URL 编码、Base64 或自行替换斜线。
- host_id：协调根 `host.json` 首次受锁初始化的持久 UUID（小写标准连字符格式），后续读取复用；主机名/IP 仅为别名。同一真实主机的所有参与者必须使用同一 ID；复制系统镜像到新主机须重新登记。路径以实际文件系统根上的物理路径为准，大小写折叠/Unicode 等价依所在文件系统处理，不能按用户输入字符串生成身份。
- resource_key：下表元组按 RFC 8785 JCS 编码的 UTF-8 JSON 数组。ref 必须是完整 `refs/heads/...`，路径必须是规范绝对物理路径。显示名如 `daily:<repo-key>` 仅作别名，不能用于互斥比较。

| 资源 | resource_key 元组 |
| --- | --- |
| Issue / 每日入口 | `["issue",repo_identity,十进制编号字符串]` / `["daily",repo_identity]` |
| 父级聚合 | `["aggregate",repo_identity,父票编号]`，重叠判断见 coordination-state |
| Worktree / 本地 ref | `["workspace",host_id,realpath]` / `["local-ref",host_id,common_dir_realpath,ref]` |
| 远程 ref（跨 clone） | `["remote-ref",remote_repo_identity,ref]`，fork 与上游各登记实际写入目标 |
| 端口 | `["port",host_id,network_namespace_id,协议,规范IP,起始端口字符串,结束端口字符串]` |
| 数据库 / 迁移 | `["database",service_id,database,schema]` / `["migration",service_id,database,schema]` |
| Docker / 缓存 / 输出 | `["docker",host_id,daemon_id,project]` / `["path",host_id,realpath]` |

service_id、daemon_id、network_namespace_id 从主机统一配置/实际服务实例核实，保存地址/别名映射，不用 localhost、容器名或 IP 别名分裂同一实例。端口通配/IP族/区间及路径祖先重叠须语义检查，不能仅比较 key 相等。migration 与同 database/schema 的 database、migration 写声明全部互斥；迁移还须取得实际写入范围内其他资源声明。

## 文件 Schema 与记录身份

claims.json 与 daily-ledger.json 共用 v1 schema；适配器须同时验证结构与下述语义，不只验证 JSON 能解析。时间统一为 UTC RFC3339 `Z` 形式，版本/generation 为非负整数，token 使用密码学安全随机生成的 UUID；数组按下述身份键排序。机器 schema 的唯一来源为 [coordination-schema.json](coordination-schema.json)，按本地文件读取，不访问其中的标识 URI。它验证外壳、声明、逐票状态、指纹、恢复引用和历史事件；下文定义身份、跨字段及事务语义约束，二者缺一即拒绝更新。

适配器必须强制：每个 claims 文件内 resource_key 唯一；每个 per-repo daily 文件仅有一条与目录 repo-key 相符的 daily record；daily 内规范 Issue、父项 aggregate_children、event_id 全局、每票 slot 事件组合唯一。相同身份但其他字段不同仍是重复，不以 `uniqueItems` 代替。顶层 host_id 须等于本文件所有本地 claim 的 host，目标 repo_identity 须等于文件路径身份。history 只能追加，slot_sequence 不得重号、倒序或超过全局已分配序号；每票 class 非 null 时只有一类，eligible_since 和 input_fingerprint 必填。

嵌套字段契约（缺项或未知枚举拒绝更新，不填假默认）：

- evidence / recovery_ref：`path` 必须是持久绝对路径或已授权证据 URI，指向有确定字节内容的文件、不可变 manifest 或 URI 对象；目录必须通过其 manifest 引用，不定义“目录自身哈希”。`content_kind=file|manifest` 描述该对象；`checkpoint_id / snapshot_generation / attempt` 对检查点证据必须绑定同一代，非检查点证据三者均可为 null，禁止填无意义的 0。URI 的接收权限和可读回执另存；敏感原文仅保留受控引用。
- daily.issues 的 `review` 指向同时索引独立 Review、终审（适用时）和 OCR 的不可变审查 manifest；`label`、`close`、`delivery` 分别指向当前动作回执，不以 history 中某条旧引用代替。run/workspace 也使用上述文件或 manifest 引用。
- 指纹算法为 `requirements-v2` / `daily-input-v2`，使用 [delivery-gates.md](delivery-gates.md)的 RFC 8785 JCS 编码。daily-input 输入为规范 Issue 身份、有效授权引用/范围、requirements_fingerprint、target 仓库/ref/SHA、依赖状态/接口指纹、环境配置身份、证据可访问性、resume_condition 的有意义观测值；排除 updated_at、心跳、随机 Run ID 和有证据的无关 main 变动。保存规范输入对象供复核。v1 指纹和旧状态只作历史，完整摄取后重建，不能直接恢复成当前有效结论。
- resume_condition 的每项为 `kind / subject / expected / observed / source_ref`；source_ref 必填。条件仅在 expected 与 observed 按 JCS 值语义完全相等时满足，all 中全部条件满足才允许唤醒。等待票必须 wait_reason 非空、all 非空且 input_fingerprint 非空；无等待时 wait_reason=null、all=[]、retry_after=null。不能只写“稍后重试”。
- relation_snapshot 保存 `closure / fingerprint / observed_at / source_ref`：aggregate 为冻结的完整 contains 后代闭包，Issue write 为自身及全部祖先闭包。 closure 按规范 Issue 排序，fingerprint 对 JCS 编码的闭包和关系版本证据求 SHA-256。aggregate 和 Issue write 声明均必须有此快照，其他资源必须为 null。

## 状态与调度不变量

适配器在每次 daily 更新时验证合法前态→后态及证据，调用方不得借全量替换绕过：

- 进入 verified 必须具备当前完整 target_sha、requirements-v2、run、checkpoint 和 review；进入 delivered 还必须有先前同代 verified 的合法迁移及 delivery 回执。目标或需求失效后允许 `delivered + revalidating` 表示已交付但当前结论失效，禁止继续贴标/关闭。
- repair_prepared 必须有修复 checkpoint；integration_pending 必须有 checkpoint、review 且 validation_state=verified。label/close 的 applied_valid 只允许 `verified + delivered`，并有对应 intent 和当前回执。
- 写后失配先把动作置 stale、验证置 revalidating（摄取不完整则 intake_incomplete）；开始纠正后可置 correction_pending，但不得恢复旧 verified。重新进入 verified 必须走完整重验，applied_valid 必须走新 intent 和写后对账。
- 调度器只允许 queued/auditing/finding_confirmed/repairing/revalidating 与对应动作间按 Brief、Dispatch、finding 和结算事件迁移；blocked/failed/unproven/intake_incomplete/aggregate_pending 必须保存原因和恢复条件。任何状态更新不得删除历史有效结论，只能新增失效事件并保留原目标与证据。
- slot_sequence 在原子选择名额时精确 +1，同时写入该票 `slot_selected` 和 last_slot；启动后追加 `dispatch_started`，结算后追加 `settled`。selected/started 的 result=not_settled；settled 使用标准结果枚举。已选未结算的票恢复时先对账原 Dispatch，不得另占名额。容量 C 是 daily record 中正整数，默认 1；每轮最多原子选择 C 个不同名额。
- next_class、consecutive_recovery、last_slot、eligible_since 和冷却只能由适配器按 [每日规则](closed-issue-daily-run.md)从合法前态及追加事件推进。history 只追加、不可替换或截断；启动失败也必须有结算事件。适配器须重放事件核对公平性，不能信任调用方提交的计数结果。
- 每个 aggregate_child 必须引用同一 daily 内唯一顶层子票，并保存其 target_sha、requirements_fingerprint、checkpoint、validation_state。父票 verified/aggregate_pending 的每个子项必须与父票最终 target_sha 相同；目标变化使全部旧 SHA 子结论退出当前聚合证据，旧结论只留历史。

v1 严格拒绝未知 schema_version、未知枚举/字段；迁移须在锁内备份旧文件、核对活跃拥有者/事务、生成新版本并验证全体参与者兼容后切换。revision 是乐观并发版本，每次成功事务精确 +1，比较失配不写入；不能把 schema_version 当 revision。新建空 daily 的 next_class=new、slot_sequence=0、consecutive_recovery=0、capacity=1。

## 公共事务入口

请求外壳为 `request_id / request_hash / expected_revision / owner_run / claims_to_acquire / releases / daily_updates / recovery_relocations`：

- `request_id` 在 owner_run 内唯一；request_hash 是除该字段本身外完整规范请求的 JCS+SHA-256。适配器持久保留 `owner_run+request_id → request_hash+原回执`，同 ID 同哈希返回原回执且不改变 revision/名额，同 ID 异哈希返回 `idempotency_conflict`。去重记录与协调根同寿命，journal 压缩不得先行删除。
- expected_revision 是每个将写文件的规范绝对路径→revision 映射。每个 acquire 项为 `resource_key / mode / task / attempt / token / generation / relation_snapshot / evidence`；token 每次新建，generation 必须等于该资源持久高水位 +1。每个 release 项为 `resource_key / token / generation / settlement_ref`，逐项核对当前拥有者。批量操作不使用一个共享 generation 代替逐资源代次。
- daily_updates 每项为 `file / issue / expected_last_slot / set_fields / append_events`。新票以 issue 不存在为前置并提交完整 set_fields；既有票只允许当前状态迁移所需字段，append_events 只能追加新事件，不接受 history 全量替换。恢复迁移需同时提交旧证据代次。
- recovery_relocations 每项为 `old_ref / new_ref`，两者均含路径、哈希、checkpoint_id、snapshot_generation、attempt；必须在同代冻结快照上更新所有活跃引用。
- mode 兼容矩阵：read↔read 可共享；read↔write、write↔write、aggregate↔write、重叠 aggregate↔aggregate 均互斥；aggregate 与包含闭包外 Issue 不冲突。daily 入口始终 write。同一 owner_run 对同一资源的重入必须提交当前 token/generation，不另增代次。

唯一适配器负责身份规范化、Schema/上述语义、集合重叠、状态迁移和 OS 锁下比较更新。成功回执为 `request_id / request_hash / status=applied|replayed / transaction_sequence / revisions / claims / file_hashes`；失败无副作用，返回稳定错误码 `validation_failed / revision_conflict / resource_conflict / stale_relation / idempotency_conflict / stale_token / persistence_failure / unverifiable` 及结构化 details。失败或结果未知不得启动副作用。

## 持久化与崩溃恢复

跨文件更新使用同一事务 journal。journal 必须包含请求、完整前后代文件内容，或指向已 flush+fsync 的不可变前后代内容段的持久引用，以及文件映射、前后 revision/哈希、临时路径和提交状态；只有哈希不构成可恢复内容。先写并 flush+fsync journal，再 fsync 其父目录，确保恢复方能发现它；数据临时文件也须先 flush+fsync。

提交时按 journal 原子替换各数据文件并 fsync 各父目录，最后写并 fsync 提交标记及父目录。启动时先验证 journal 和内容段哈希，再按确定规则完整前滚或完整回滚到同一代；不能恢复完整一代则保持 unverifiable，禁止接受新请求。恢复完成前不得释放或对外宣称声明。每资源 generation 高水位和幂等回执持久保存在 journal/tombstone 中，释放不得删除高水位或使旧 generation 重新有效。共用多主机后端须提供等价原子性、持久化和恢复语义。

## 上线与升级验收样例

至少验证以下样例并保存结果；这些是协议验收要求，不宣称已有后端已运行：

| 输入/故障 | 必须结果 |
| --- | --- |
| HTTPS/SSH 别名、跨 clone main 写、通配端口与区间 | 规范身份后第二拥有者冲突 |
| 父子两种申请顺序、关系快照变化、contains 对账后登记前变化 | 同快照互斥；过期快照以 stale_relation 拒绝，不启动副作用 |
| 重复 daily record/Issue/子票/resource_key/event_id/slot | 全部 validation_failed，无副作用 |
| 无目标/指纹/checkpoint/review 的 verified，无回执的 delivered/applied_valid | 全部拒绝；合法 stale→revalidating→重验路径可持久化 |
| revision=4 的两个并发请求 | 仅一个写成 5，另一个无副作用拒绝 |
| 旧 token/generation；逐项批量 acquire/release | 旧代次拒绝；各资源分别严格递增，不能共享高水位 |
| 同 request_id 同/异载荷；journal 压缩后重放 | 同载荷返回原回执；异载荷拒绝；去重记录仍有效 |
| 替换第一个文件后崩溃、journal 或父目录 fsync 失败、内容段丢失 | 恢复为完整旧代或新代；内容不足则 unverifiable，不接受新事务 |
| 重置 next_class/计数、截断 history、slot 重号、selected 后崩溃 | 任意调度改写拒绝；崩溃后先对账原名额，不重复选择 |
| recovery/new/revalidate 持续非空、C=1 与 C=2 | 每轮不超过 C 个不同名额，按公平规则轮转且不重复执行未结算票 |
| 空等待、缺 input_fingerprint/source_ref、expected≠observed | 不唤醒且非法组合拒绝；条件全部相等才唤醒 |
| 父/子 target_sha 不同、子项缺顶层记录、旧 SHA 证据聚合 | 拒绝父票 verified/贴标 |
| read/read、read/write、aggregate/write、migration/database | 按兼容矩阵共享或互斥，不用不同资源键规避 |
| 特殊平台路径、硬链接/特殊文件、展开资源超限 | 全包预检失败且零部分写入 |
| 恢复索引迁移中断 | 原或新完整一代可读，未更新引用前禁止删除源 |
