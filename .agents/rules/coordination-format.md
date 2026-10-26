# 共享协调 v1 数据与适配器契约

登记资源、更新跨日队列或恢复索引时，由 [coordination-state.md](coordination-state.md)加载本文件。下述是协议要求，不宣称仓库已有可用实现。启动时须登记唯一公共协调适配器的绝对入口、版本和内容哈希，并让所有参与者使用同一入口；接口逻辑名为 `transaction(request)`，不是可直接执行的 CLI。仓库未提供实现或外部适配器未通过本节样例时，跨 Run 写入保持 blocked，可继续只读检查；禁止各 Agent 临时各写一套不兼容 Ledger。不能以文档协议冒充已部署服务。

## 唯一身份与编码

- repo_identity：tracker 的规范 host/owner/repo，全小写、无协议、无 `.git` 或尾斜线；SSH/HTTPS/别名通过已核实的远程仓库身份映射到同一值。OpenBot 固定 `github.com/1123786563/openbot`。重命名/转移保留已批准别名映射，无法核实身份先 blocked。
- repo-key：repo_identity 的 UTF-8 字节逐字节转为两位小写十六进制，无前缀。它是文件名编码，资源身份仍用 repo_identity。例 `a/b/c` → `612f622f63`；禁止 URL 编码、Base64 或自行替换斜线。
- host_id：协调根 `host.json` 首次受锁初始化的持久 UUID（小写标准连字符格式），后续读取复用；主机名/IP 仅为别名。同一真实主机的所有参与者必须使用同一 ID；复制系统镜像到新主机须重新登记。路径以实际文件系统根上的物理路径为准，大小写折叠/Unicode 等价依所在文件系统处理，不能按用户输入字符串生成身份。
- resource_key：下表元组的无空白 UTF-8 JSON 数组（字符串保持原 Unicode，转义仅使用 JSON 必需转义）。ref 必须是完整 `refs/heads/...`，路径必须是规范绝对物理路径。显示名如 `daily:<repo-key>` 仅作别名，不能用于互斥比较。

| 资源 | resource_key 元组 |
| --- | --- |
| Issue / 每日入口 | `["issue",repo_identity,十进制编号字符串]` / `["daily",repo_identity]` |
| 父级聚合 | `["aggregate",repo_identity,父票编号]`，重叠判断见 coordination-state |
| Worktree / 本地 ref | `["workspace",host_id,realpath]` / `["local-ref",host_id,common_dir_realpath,ref]` |
| 远程 ref（跨 clone） | `["remote-ref",remote_repo_identity,ref]`，fork 与上游各登记实际写入目标 |
| 端口 | `["port",host_id,network_namespace_id,协议,规范IP,起始端口字符串,结束端口字符串]` |
| 数据库 | `["database",service_id,database,schema]` |
| Docker / 缓存 / 输出 | `["docker",host_id,daemon_id,project]` / `["path",host_id,realpath]` |

service_id、daemon_id、network_namespace_id 从主机统一配置/实际服务实例核实，保存地址/别名映射，不用 localhost、容器名或 IP 别名分裂同一实例；未知则不取得可能重叠声明。端口通配/IP族/区间及路径祖先重叠须语义检查，不能仅比较 key 相等。

## 文件 schema

claims.json 与 daily-ledger.json 共用 v1 schema；适配器须同时验证结构与下述语义，不只验证 JSON 能解析。UTC 时间使用 RFC3339，版本/generation 为非负整数，token 为不可预测 UUID；数组按稳定键排序。

机器 schema 的唯一来源为 [coordination-schema.json](coordination-schema.json)，按本地文件读取，不访问其中的标识 URI。它严格验证外壳、声明、逐票状态、指纹、恢复引用和历史条目；下文定义身份、跨字段及事务语义约束。

嵌套字段契约（缺项或未知枚举拒绝更新，不填假默认）：

- evidence / recovery_ref：`path` 为持久绝对路径或已授权证据 URI，`sha256` 为内容哈希，`checkpoint_id / snapshot_generation / attempt` 绑定同一代；URI 的接收权限和可读回执另存。敏感原文仅保留受控引用。
- daily.issues 每项：`issue`（规范身份+编号）、`class`（recovery/new/revalidate/null）、`eligible_since`、`last_slot`（整数或 null）、`target_sha`（完整 SHA 或 null）、`requirements_fingerprint`、`validation_state / delivery_state / label_action / close_action`（枚举见每日规则）、`run / workspace / checkpoint / review / label`（恢复引用或 null）、`action_reason`（字符串或 null）、`label_intent / close_intent`（意图的恢复引用或 null）、`wait_reason`（字符串或 null）、`resume_condition`（下述对象）、`input_fingerprint`、`retry_after`（UTC或 null）、`next_action`、`aggregate_children`（子票及对应指纹/检查点）、`history`（按 slot_sequence 的动作/结果，含上次有效结论）。未摄取字段可为 null，null 不构成有效证据；不能因更新队列抹去历史。
- resume_condition：`all` 数组，每项为 `kind / subject / expected / observed / source_ref`；kind 为 authorization、dependency、environment、target、api_retry、evidence，明确布尔满足条件；无等待时 all=[]。不能只写“稍后重试”。
- input_fingerprint：算法名 `daily-input-v1` 加 SHA-256，输入为规范 Issue 身份、有效授权引用/范围、requirements_fingerprint、target 仓库/ref/SHA、依赖状态/接口指纹、环境配置身份、证据可访问性、resume_condition 的有意义观测值。按 delivery-gates 的规范 JSON 编码；排除 updated_at、心跳、随机 Run ID 和无关 main 变动（须附无关影响分析），禁止以时间变化唤醒等待票。保存规范输入对象供复核。

v1 严格拒绝未知 schema_version、未知枚举/字段；迁移须在锁内备份旧文件、核对活跃拥有者/事务、生成新版本并验证全体参与者兼容后切换。revision 是乐观并发版本，每次成功事务精确 +1，比较失配不写入；不能把 schema_version 当 revision。新建空 daily 的 next_class=new，slot_sequence=0；推进时机按每日公平规则。

## 公共事务入口与一致性样例

`transaction(request)` 请求包含 `request_id / expected_revision（每个将写文件的规范绝对路径→revision 映射）/ owner_run / token / generation / claims_to_acquire / releases / daily_updates / recovery_relocations`。唯一适配器负责身份规范化、schema/嵌套契约校验、集合重叠检查和 OS 锁下比较更新。跨文件更新使用一个 fsync 的事务 journal（含前后 revision/哈希及提交标记），在启动时完成重放/回滚后才接受新请求；每个数据临时文件 flush+fsync，原子替换后 fsync 父目录，最后写并 fsync 提交标记。失败/未知事务不得启动副作用。相同 request_id 重放返回原回执，不重复占名额或释放锁；返回事务序号、新 revision、集合和文件哈希。按资源保存持久 generation 高水位（含已释放记录的 journal/tombstone），每次取得新拥有权严格递增，token 每次新建；释放不能删除高水位或使旧 generation 重新有效。共用多主机后端时提供等价原子性/持久化。

适配器上线及升级至少验证以下样例并保存结果：

| 输入/故障 | 必须结果 |
| --- | --- |
| HTTPS 与 SSH 的 OpenBot remote；不同 clone 向同一 main 写 | 同一 repo-key 和 `["remote-ref","github.com/1123786563/openbot","refs/heads/main"]`，第二拥有者冲突 |
| 已持父聚合 P，另一 Run 申请其实际子票 C 写；反向顺序 | 同一树关系快照下两种顺序均拒绝；只读摄取不冲突 |
| 同主机符号链接路径/主机别名、通配端口与区间重叠 | 归一身份后冲突 |
| revision=4，两个请求 expected_revision=4 | 仅一个写成 5，另一个无副作用地拒绝 |
| 未知版本、缺字段、../资源路径、未知服务别名 | 验证失败，不另起 Ledger |
| 替换第一个文件后崩溃、目录 fsync 失败 | 恢复 journal 后得到一代完整状态；不对外宣称已取得声明 |
| 旧 token/generation 释放；重放成功 request_id | 前者拒绝，后者返回原回执且 revision/名额不再变化 |
| recovery A/B 始终可行动，new 和 revalidate 也非空 | 每三次已结算选择各类至少一次；仅标签恢复不重跑整票 |
| 恢复索引迁移中断 | 原或新完整一代可读，未更新引用前禁止删除源 |

这里定义了验收样例，并未运行某个协调后端的实现测试；Run 须提供实际适配器及上述实测证据。
