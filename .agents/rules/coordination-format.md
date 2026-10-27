# 共享协调 v3 数据与适配器契约

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

claims.json 与 daily-ledger.json 共用 v3 schema；适配器须同时验证结构与下述语义，不只验证 JSON 能解析。时间统一为 UTC RFC3339 `Z` 形式，版本/generation 为非负整数，token 使用密码学安全随机生成的 UUID；数组按下述身份键排序。机器 schema 的唯一来源为 [coordination-schema.json](coordination-schema.json)，按本地文件读取，不访问其中的标识 URI。它验证外壳、声明、逐票状态、指纹、恢复引用和历史事件；下文定义身份、跨字段及事务语义约束，二者缺一即拒绝更新。

适配器必须强制：每个 claims 文件内 `(resource_key, owner_run)` 唯一；每条记录表示一个 holder，同资源仅 read/read 可有多个拥有者；每个 per-repo daily 文件仅有一条与目录 repo-key 相符的 daily record；daily 内规范 Issue、父项 aggregate_children、event_id 全局、每票 slot 事件组合唯一。相同身份但其他字段不同仍是重复，不以 `uniqueItems` 代替。顶层 host_id 须等于本文件所有本地 claim 的 host，目标 repo_identity 须等于文件路径身份。history 只能追加；调度事件序号不得超过已分配值，同一 slot 阶段复用原序号，非调度事件序号为 null；每票 class 非 null 时只有一类，eligible_since 和 input_fingerprint 必填。

嵌套字段契约（缺项或未知枚举拒绝更新，不填假默认）：

- evidence / recovery_ref：`path` 必须是持久绝对路径或已授权证据 URI，指向有确定字节内容的文件、不可变 manifest 或 URI 对象；目录必须通过其 manifest 引用，不定义“目录自身哈希”。`content_kind=file|manifest` 描述该对象；`checkpoint_id / snapshot_generation / attempt` 对检查点证据必须绑定同一代，非检查点证据三者均可为 null，禁止填无意义的 0。URI 的接收权限和可读回执另存；敏感原文仅保留受控引用。
- daily.issues 的 delivery_intent 引用交付写前意图，delivery_action 表达该动作的结算；delivery 引用当前回执。无动作的只读目标观察可为 delivery_action=none、delivery_state=delivered。新写入先记 delivery_pending，回读实际树符合意图后 applied_valid，偏离记 stale 并使验证失效，归属/回读不明保留 pending。纠正走 delivery_correction_pending→corrected 并另核对回退/修复授权；applied_valid 仅说明树与意图一致，不能代替 verified。非 none 动作必须有 intent，applied_valid/stale/corrected 必须有实际目标回执。恢复集合包含 pending/stale/correction_pending 及 integration_pending，不依赖票当前标签。
- daily.issues 的 audit_epoch 为父级 epoch 的不可变 manifest 引用；非聚合票可为 null。
- daily.issues 的 `review` 指向同时索引独立 Review、终审（适用时）和 OCR 的不可变审查 manifest；`label`、`close`、`delivery` 分别指向当前动作回执，不以 history 中某条旧引用代替。run/workspace 也使用上述文件或 manifest 引用。`decision` 引用有权取消/无需交付决定，`human_review` 引用人审决定；human_review_state=approved/rejected 必须有后者并绑定当前需求、目标和决定范围。
- 每个 label/close/delivery 动作分别保存 `<action>_action_reason`、`<action>_next_action`、`<action>_wait_reason`、`<action>_input_fingerprint`、`<action>_resume_condition`、`<action>_retry_after`；验证级 next_action、wait_reason 和 input_fingerprint 不代替动作级字段。动作原因、下一步、等待原因、输入指纹、观测和重试时间只更新所属动作，事件回执保留前后完整值。
- 指纹算法为 `requirements-v3` / `daily-input-v3`，精确输入与迁移按 [指纹合同](fingerprints.md)。保存规范输入对象；旧指纹完整摄取后重建，不直接恢复成有效结论。
- resume_condition 的每项为 `kind / subject / expected / observed / source_ref`；source_ref 必填。条件仅在 expected 与 observed 按 JCS 值语义完全相等时满足。等待记录必须 wait_reason 非空且 input_fingerprint 非空，并采用以下三种形状之一：硬条件等待 all 非空、retry_after=null；探测退避 all=[]、retry_after 非空；组合等待 all 非空且 retry_after 非空。无等待时 wait_reason=null、all=[]、retry_after=null。缺授权、需求/人审决定等硬条件使用第一种，不设置无意义的定时写入重试。
- relation_snapshot 保存 `closure / fingerprint / observed_at / source_ref`：aggregate 为冻结的完整 contains 后代闭包，Issue write 为自身及全部祖先闭包。 closure 按规范 Issue 排序，fingerprint 对 JCS 编码的闭包和关系版本证据求 SHA-256。aggregate 和 Issue write 声明均必须有此快照，其他资源必须为 null。

## 每日 Run 调度与修复波次

每日批次的不可变 Run manifest 使用 [schema 的 daily_run_manifest](coordination-schema.json#/$defs/daily_run_manifest)：`kind=daily-run-v1`，固定 run_id、规范仓库、C=`capacity`、P=`max_parallel_tasks`、`reserve_label_slots`、source_issues、目标树、scope、policy_sha256、并行实现授权引用及时间/修复波次预算。逐票 run 和 slot_selected.refs 索引该 manifest；scope 索引逐票需求、contains/DAG、授权及证据目录，不把 source_issues 读范围当写权限。C/P 在 Run 内不变；需求、目标或写范围变化用 scope_changed/state_changed 保存新 manifest 及前后哈希，受影响阶段先安全结算，不能覆盖旧文件或借 scope revision 扩容。无候选的 idle Run 不强造空 source_issues。

P 默认 2、范围 1–4，是同时占用的 Worker Task/Dispatch 上限，不是每天名额。启动意图及未证明退出/结算的尝试也占 P；阶段切换先结算旧 Dispatch，同一任务工作区不同时派发写者与审核者。接纳前同时核对实际 Worker 槽位、K=4 任务 Worktree、DAG、文件与数据库/端口/缓存/输出资源，取可用的较小容量并留证。没有有效并行实现授权时，所有写代码阶段全局最多一个；只读业务源文件的审计/验证可按 P 并行，但测试副作用仍须隔离和登记。集成工作区及 GitHub 副作用执行器各自串行。

已授权贴标的闭环 Run 必须 reserve_label_slots=true、C≥2，默认 C=4；仅分析/无贴标授权时可为 false、C=1。选中 audit 时为其后续 label 预留一个预算名额，预留本身不是 slot_selected、不占 slot_sequence、不授予写权限。设 n 为该 Run 已选择 slot 数、r 为未兑现预留数：任何新选择均须 n+r≤C；reserve_label_slots=true 的新 audit 在选择事务中同时增加 n 和 r，须预先满足 n+r+2≤C；false 时不建预留，audit 仅 n+1。对应 label 真正就绪并按公平次序选中时，n+1、r−1；其他动作不能偷用该预留，仍须有空闲预算。审计结论不需贴标、标签已有效无需动作、硬条件阻塞无法继续或 Run 安全结算时，保存原因后释放未用预留；动作本身仍保留真实等待状态。C=4、P=2 可先接纳两票 audit，随后选择两票就绪 label，不能再接纳第三票 audit 挤占闭环预算；公平队列也可先服务已有动作，不承诺每票立即贴标。

每个预留由 audit slot 身份唯一索引；选择回执记录预留动作，消费/释放回执记录原预留、原因及前后 n/r，均由既有 refs/state_changed 索引。适配器从追加事件重放，不接受调用方直接传入 n/r；消费和释放最多成功一次，重放不改变预算。恢复先对账旧 slot、预留和 Dispatch；新 Run 不继承旧预算，旧 Run 未安全结算前不建立第二拥有者。

修复波次 manifest 使用 [repair_wave_manifest](coordination-schema.json#/$defs/repair_wave_manifest)：固定 kind=repair-wave-v1、wave_id、打开它的 run_id、原审计票 audit_issue、round_number、前波/历史迁移锚点 previous_wave、完整失败或交付基线 baseline、修复授权、scope/DAG、全部 Task/finding/owned_files 和 policy_sha256。baseline 及每个实际 Dispatch 的完整前置树仍按检查点规范核验；同波不表示业务依赖自动满足。Task ID 须唯一，范围必须属于批次及该票的授权 finding；正文和 schema 的引用都不能代替权限、跨记录关联及安全路径校验。

打开新波次前，适配器在同一事务核对不存在该票未结算波次、全局及 Run 剩余额度，令 repair_rounds_total 精确 +1，以 state_changed.refs 保存波次 manifest 和完整前后状态；同 wave_id 的幂等重放不重复计数。每波每个 Task 只允许一次写入 Dispatch；启动意图、实际 Dispatch 和结算逐项绑定波次/Task。改变 Task 身份、finding 别名或修复 Issue 不能规避同一工作尝试的唯一性。新增成员、扩大范围或同一 Task 再次整改/重试须先安全结算当前波次、固定新基线并打开下一波；失败、跨日及部分派发不退款。五个冻结 Task 首次尝试合计一波；审查/只读验证不另计修复波次，但仍占 P 和时间预算。每 Task 的累计整改轮次及第 4–5 轮升级按 review.md 独立执行，不因波次/Task 改名清零。

第 5 波可继续完成其已冻结但尚未尝试的成员，恢复同一波不再加一；该波结束仍有 finding 或已无合法剩余尝试时，记 repair_round_limit blocked，不打开第 6 波。其他已完成票的对账动作仍可执行。波次结束回执保存所有 Task 的 Dispatch/检查点/结果及未解决 finding，由 state_changed.refs 索引；缺少前态、未证明旧写者退出或无法重建唯一波次时保持 blocked，不重开同范围任务。

验证级和每个动作级等待分别执行同一可行动算法，动作之间不共享结果：

1. 无等待记录时可完整行动。等待中先由主控在候选对账时刷新可只读获取的 observed；到期探测 Worker 在 slot 内刷新 API/环境 observed。每次刷新须有 source_ref 和时间，input_fingerprint 变化只触发重新对账，不直接视为条件满足。
2. all 非空且所有 expected==observed 时条件满足，清除对应等待并可完整行动；组合等待中即使 retry_after 到期，硬条件仍未满足也只能探测，不能执行交付、标签、关闭或其他副作用。
3. 条件未满足且 retry_after 已到期时，只允许选择一个 recovery `probe` 用途的对应 audit/动作 slot 做只读或隔离测试探测；slot_kind 仍记录实际工作类型，探测用途写入选择回执。纯探测退避 all=[] 到期同样先探测，成功并刷新环境回执后才可继续原工作。
4. retry_after 未到期且条件未满足时不可行动、不占名额。探测仍失败则保存新 observed，并按 1、2、4 天、之后每 7 天设置下一次 retry_after；成功或条件满足后清除等待。expected 只能由有权改变等待条件的人或已批准流程修订，执行者不得修改 expected 来制造相等。

例：缺标签写入授权且 retry_after 到期仍不可写；API 故障 all=[] 到期可选 recovery 探测；组合等待中授权未满足但 API 到期只探测 API；主控对账发现授权 observed 已等于 expected 时可提前唤醒，无需等到 retry_after。

## 状态与调度不变量

适配器在每次 daily 更新时验证合法前态→后态及证据，调用方不得借全量替换绕过：

- 进入 verified 必须具备当前完整 target_sha、requirements-v3、run、checkpoint 和 review；进入 not_required 必须具备 requirements-v3、run 和有效 decision，不得要求 target/checkpoint/review，也不得进入贴标或关闭放行。进入 delivered 必须有实际目标交付回执；只读审计已有交付保存目标观察回执，写后树偏离意图时也须如实记录 delivered + revalidating，不以 delivery 字段证明验证通过。目标或需求失效后允许 `delivered + revalidating` 表示已交付但当前结论失效，禁止继续贴标/关闭。
- repair_prepared 必须有修复 checkpoint；integration_pending 表示仍待目标集成或目标验收，必须保留曾完成本地审查的 checkpoint、review；当前 validation_state 可为 verified、finding_confirmed、repairing、revalidating、blocked、failed、unproven 或 intake_incomplete；后续 finding/修复阶段保留的是历史本地通过证据，不能用于当前放行。失效时保留旧证据与交付状态，不退写 repair_prepared。repair_rounds_total 是同一原审计票跨 Run 已打开的修复波次累计数，按上节先冻结全体成员再原子计次；换 Run、拆 Task、改 finding ID 或修复 Issue 不重置。第 5 波的剩余成员与波次结算按上节处理；历史值大于 5 时保留真实值并阻塞新增修复。label/close 的 applied_valid 只允许 `verified + delivered`，并有对应 intent 和当前回执；label applied_valid 还须 human_review_state=pending。验证失效或出现人审终态时同事务撤销全部依赖旧结论的 applied_valid。
- human_review_state=approved/rejected 或 validation_state=not_required 的对象 class=null，只有具名遗留动作时为 recovery；不得进入 new/revalidate 或新贴标，not_required 也不得新建 close_pending。recovery 必须绑定至少一个具名遗留 label/close/delivery 动作或 integration_pending；反过来，这些对象存在所属等待字段为空（wait_reason=null、resume_condition.all=[]、retry_after=null）的可行动遗留动作时必须 class=recovery，不得以 class=null 隐藏待办。仍有硬授权/决定等待或有效退避的动作可保持 class=null，待统一唤醒算法判定可行动后同事务转入 recovery。需求/交付范围变化先以 scope_changed 使相应人审/取消决定失效，再建立新队列。实现缺陷型 rejected 的授权修复是另一条显式迁移：按 [已关闭 Issue 验证](closed-issue-audit.md)用 state_changed 回执保存旧决定、需求/目标/检查点、finding、修复授权及前后完整状态，建立新 attempt 后才可 rejected→none（human_review=null）并进入 finding_confirmed。需求指纹可保持不变，旧人审决定留在历史；后续重新送审须有通过验证的新检查点和新意图。无授权、无具名 finding 或仅更换会话不得退出 rejected。入队/服务序号和修复累计次数不重置。标签移除本身不改变 human_review_state。
- 写后失配先把动作置 stale、验证置 revalidating（摄取不完整则 intake_incomplete）；开始纠正后可置 correction_pending，但不得恢复旧 verified。重新进入 verified 必须走完整重验，applied_valid 必须走新 intent 和写后对账。失配仅由已核实 not_required 或人审终态引起时按 [交付门禁](delivery-gates.md)保留指纹相符的 Agent 验证结论，不转 revalidating；需求或目标失配仍按常规失效路径。
- 调度器只允许 queued/auditing/finding_confirmed/repairing/revalidating 与对应动作间按 Brief、Dispatch、finding 和结算事件迁移；blocked/failed/unproven/intake_incomplete/aggregate_pending 必须保存原因和恢复条件。任何状态更新不得删除历史有效结论，只能新增失效事件并保留原目标与证据。
- slot_sequence 在原子选择名额时精确 +1，同时写入该票 `slot_selected`、last_slot、下一类别 next_class 和 consecutive_recovery，并完成动作预算预留；公平游标按选择顺序推进一次。启动后追加 `dispatch_started`，结算后追加 `settled`，可乱序到达，不再改变公平游标。selected/started 的 result=not_settled；settled 使用标准结果枚举。已选未结算的票不进入新的候选选择；恢复先对账原 Dispatch，不得另占名额。容量 C 是 daily record 中正整数，默认 4；每轮最多原子选择 C 个不同名额。
- 调度事件记录不可变 `run_id / class_at_selection / capacity_at_selection / slot_kind`，slot 身份为 repo_identity + slot_sequence；slot_kind=audit 表示一票或一个父聚合验收，label/close/delivery 各只表示一个动作，不得捆绑。同一 slot 各阶段沿用选择时四字段和选择回执中的动作身份；slot 只有一次 selected/started/settled，审计内部修复 Task 的 Dispatch 用 state_changed.refs/波次报告关联，不伪造额外同号 started。Run 首次选择时冻结 C，配置变化只作用于新 Run。恢复原 slot 不占新名额，新选择按新 Run ID 计数，不能另造身份突破 C。slot_selected.refs 非空并索引启动/容量回执；journal 保留 request_id→event_id 映射，重放以事件为准。
- 非调度变更使用 state_changed / evidence_invalidated / scope_changed / policy_changed，result=recorded，slot_sequence/class_at_selection/capacity_at_selection/slot_kind 均为 null，run_id 必填。refs 非空并索引不可变变更回执，含原因、前后完整逐票状态及证据；首次创建的前态可为 null。覆盖当前 target/checkpoint/review 前先保存该回执；不伪造 slot。调度结算同样保存前后状态，所有验证/交付迁移均可重放。
- next_class、consecutive_recovery、last_slot、enqueue_sequence、eligible_since 只能由适配器按 [每日规则](closed-issue-daily-run.md)从合法前态及追加事件推进。首次入队在同一事务将 enqueue_sequence 固定为当前 slot_sequence；排序使用 `last_slot ?? enqueue_sequence`，同键时 last_slot=null 优先。history 只追加、不可替换或截断；启动失败也必须有结算事件。适配器须重放事件核对公平性，包括持续新到票时既有票的服务上界，以及旧票连续动作时新到票的服务上界，不能信任调用方提交的计数结果。
- 每个 aggregate_child 必须引用同一 daily 内唯一顶层子票，并保存其 target_sha、requirements_fingerprint、checkpoint、validation_state。父票 verified 的每个子项须为 verified 或有效 not_required：verified 子项须与父票最终 target_sha 相同，并核对其当前需求指纹与检查点；not_required 子项须有当前需求指纹及顶层子票的有效 decision，决定覆盖该子项和父级对应要求，无须虚构目标 SHA/检查点，也不能替代父级仍适用的独有及组合验收。无决定、指纹失配或其他未通过状态仍阻塞父票。父票 not_required 的每个子项必须 not_required，且父票 decision 覆盖全部后代及自身无交付要求；aggregate_pending 可保留具名缺口和旧 SHA 引用，但旧结论不能计入当前通过。父级 epoch 按每日规则固定，由不可变 manifest 引用；内容须通过 coordination-schema.json 的 audit_epoch_manifest 定义及语义校验：contains 为完整后代闭包，children_queue 是其中待逐票验收的唯一 ID 队列，root_issue 不入子队列；policy.manifest.sha256 等于指纹输入的 policy_sha256，revision 仅作序号；Gitlink 路径/仓库/SHA 逐项核实，数组按规范身份排序且拒绝重复身份，不以可变子票字段替代。目标变化时旧 SHA 的 verified 子结论退出当前聚合证据并只留历史，not_required 子项另核对决定是否仍覆盖当前需求；按每日规则完成影响分析后，可由新 SHA 的 revalidation manifest 承接未受影响证据，verified 子项 checkpoint 必须指向该 manifest，受影响或无法证明的项补验后才以新 target_sha 进入当前聚合。

v3 严格拒绝未知 schema_version、未知枚举/字段；迁移须在锁内备份旧文件、核对活跃拥有者/事务、生成新版本并验证全体参与者兼容后切换。v1→v2 必须在原持久根及原锁内冻结全部写入、备份旧内容/事件/高水位，保留 claim 的 owner/token/generation，不另建根或重置代次。旧事件保存为 legacy manifest；无法从证据重建 Run/类别/容量时不猜填，先安全结算旧 slot，以具名迁移回执建立新调度基线。旧 verified 按当前指纹和策略重验后才能恢复。

v2→v3 同样在原持久根及原锁内冻结并备份，保留 generation 高水位、request 幂等记录和事件顺序。旧 slot 缺少 slot_kind 时先按原 Dispatch 安全结算并存入 legacy manifest，不猜测动作类型；新 slot 必须使用 v3 完整字段。旧 action_reason 仅保留为历史，按各 intent/receipt 重建三个动作的独立原因、下一步、wait_reason、input_fingerprint 和恢复条件，证据不足的对象保持 blocked；decision/human_review 经完整 rescan 后填写，无取消决定时 decision=null，有人审终态决定时绑定其指纹和证据，不能批量假定 approved。无人审终态但当前标签或 intent/receipt 表明仍待人审时 human_review_state=pending；确认没有待人审标签或待办意图时才为 none，已有 applied_valid/pending 不得迁移为 none。从未服务票的 enqueue_sequence 固定为迁移时当前 slot_sequence，已有 last_slot 的票保留该服务序号及原入队历史证据；repair_rounds_total 按同一审计票全部 Task/finding 的可核实旧修复 Dispatch 事件跨 Run 求和重建为保守历史锚点，不能倒推合并成更少波次；无法完整重建时不得完成迁移或继续修复。旧等待记录须按统一算法重建成硬条件、探测或组合形状，无法区分时保持 blocked 并人工对账。迁移验收通过前不接受 v3 新写入。

revision 是乐观并发版本，每次成功事务精确 +1，比较失配不写入；不能把 schema_version 当 revision。新建空 daily 的 next_class=new、slot_sequence=0、consecutive_recovery=0、capacity=4；只读单名额模式须显式配置 capacity=1。

本轮保留 v3 Ledger 外壳字段/枚举；新增独立 manifest 定义和选票/预算/波次语义随 policy revision 记录。适配器必须读取引用对象并分别按对应 $defs 校验，不能只验证 Ledger 外壳。已部署参与者升级前须在原锁内停止写入、备份并安全结算全部旧 slot/Dispatch，再从选择事件重建公平游标和服务顺序、从旧计数建立不减小的修复历史锚点；缺选择顺序或身份证据则保留旧投影并 blocked，不能猜填 P、预留或活跃波次。原 capacity=1 不自动变 4，新的 C/P 仅经有效配置在新 Run 生效。完成新增样例及 schema 验收后切换，补足真实取消证据；不能清零预算、清空 rejected 或据 schema_version=3 推断兼容。未完成验收的适配器保持 blocked。

## 公共事务入口

请求外壳为 `request_id / request_hash / expected_revision / owner_run / claims_to_acquire / claim_updates / releases / daily_updates / recovery_relocations`：

- `request_id` 在 owner_run 内唯一；request_hash 是除该字段本身外完整规范请求的 JCS+SHA-256。适配器持久保留 `owner_run+request_id → request_hash+原回执`，同 ID 同哈希返回原回执且不改变 revision/名额，同 ID 异哈希返回 `idempotency_conflict`。去重记录与协调根同寿命，journal 压缩不得先行删除。
- expected_revision 是每个将写文件的规范绝对路径→revision 映射。每个 acquire 项为 `resource_key / mode / task / attempt / token / generation / relation_snapshot / evidence`；仅新取得拥有权时创建 token，且 generation 必须等于该资源持久高水位 +1。每个 release 项为 `resource_key / token / generation / settlement_ref`，逐项核对当前拥有者。批量操作不使用一个共享 generation 代替逐资源代次。
- 同资源新增 read holder 也取得新的持久高水位代次，各 holder 原代次在存活期间保持有效；释放只删除本 owner/token 记录。写者须等全部不兼容 holder 安全退出后才取得新代次。read holder 不产生写能力；外部写 fencing 仍校验当前唯一写者代次。
- claim_updates 每项为 `resource_key / token / generation / expected_state / next_state / renew / append_evidence / relation_snapshot`，仅更新本 owner 的 holder，身份和 mode 不变。renew=true 以适配器 UTC 时钟写 heartbeat_at/expires_at；允许 reserved→running、reserved/running→settling、活跃态→unverifiable，以及同态续租/追加证据。unverifiable→running 须有正面对账回执，否则仅可安全结算释放。补 Dispatch 走 append_evidence；更新关系快照先重验关系与冲突。旧 token、非法迁移或缺回执均拒绝；重入 acquire 仅返回原声明，续租/补登记显式走 claim_updates。
- daily_updates 每项为 `file / issue / expected_last_slot / set_fields / append_events`。新票以 issue 不存在为前置并提交完整 set_fields；既有票只允许当前状态迁移所需字段，append_events 只能追加新事件，不接受 history 全量替换。恢复迁移需同时提交旧证据代次。
- recovery_relocations 每项为 `old_ref / new_ref`，两者均含路径、哈希、checkpoint_id、snapshot_generation、attempt；必须在同代冻结快照上更新所有活跃引用。
- mode 兼容矩阵：read↔read 可共享；read↔write、write↔write、aggregate↔write、重叠 aggregate↔aggregate 均互斥；aggregate 与包含闭包外 Issue 不冲突。daily 入口始终 write。同一 owner_run 对同一资源的重入不是新 acquire，不创建 token 或增加 generation；适配器必须核对当前 token/generation 后沿用原声明。

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
| 同波跨日恢复、第 5 波未尝试成员、波次打开后崩溃 | 同 wave_id 重放不再计次；第 5 波剩余成员可恢复，实际尝试不得重做；未解决不打开第 6 波 |
| 旧五次 Dispatch 计数迁移，或缺失旧选择顺序 | 旧计数至少仍为 5，不合并降额；缺顺序/身份证据则 blocked，旧容量不自动扩至 4，验收前不接纳新语义 |

新增适配器验收还须覆盖：双读者分别续租/释放后写者才可取得；integration_pending→revalidating/blocked 可落盘；无 slot 的失效事件可重放；跨 Run 恢复不重占名额；同类 A/B 持续可行动时 C 必须获得服务；父级 epoch 跨日完成后目标前移保持历史且不贴标，稳定窗口内连续 Run 的容量只在新 Run 生效；v2→v3 迁移保留 generation 高水位且不猜填 slot_kind、人审或动作恢复字段；关闭 pending 对账不依赖当前标签。
