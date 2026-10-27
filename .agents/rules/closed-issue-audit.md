# 已关闭 Issue 的 Agent 验证与待人审标签

用户要求审计 `1123786563/OpenBot` 中已关闭且带 `ready-for-agent` 的 Issue，或核对、添加 `agent:ready-for-review` 标签时读取。此规则只覆盖该资格集合及下述对账对象，不宣称审计全部已关闭 Issue。此规则用于回溯验证；不把 `closed`、PR merged、历史测试通过或已有标签当作当前交付证据。`agent:ready-for-review` 的含义是“已由 Agent 验收通过，待人审”，不表示人工批准。经 Orca 派发审计或修复时，Agent 选择以 [Orca Agent 选择](orchestration-agents.md)为准。

## 1. 冻结范围和代码版本

1. 分开冻结两个原始集合并逐集合分页、排除 PR：新审集合 N 为 `state=closed` 且带 `ready-for-agent` 的全部 Issue（含首次遇到的 completed、not_planned、作废和关闭原因不明票）；标签对账集合 R 为任意状态下带 `agent:ready-for-review` 的全部 Issue，加共享 Ledger 中所有未结算 label/close/delivery 意图及纠正对象（无论当前标签或状态）。R 不以 closed 或 ready-for-agent 为过滤条件，重新打开、移除资格标签的票仍可触达。保存查询起止时间、条件、页数/游标、数量、编号/URL、去重结果和完整性；搜索上限须拆分查询核对，缺页/无权/转移读取不全记 `intake_incomplete`。本轮冻结原始全集为 N∪R；结束前重新对账新增、移除和状态变化，新增项登记下轮队列及发现时间，不暗中扩大本轮容量。
2. 先对账已有 Run、报告、标签回执、人审决定、Git 和活跃工作区。已有结论只能在其需求、目标代码、环境及证据仍然一致时复用；记录每项“复用、重验、失效”的依据，不重复派发已有效完成的审计。N/R 是原始候选集合，不覆盖有效人审终态：`human_review_state=approved/rejected` 的对象只做决定有效性和遗留标签对账，不重新验收或贴标；人审决定须绑定需求指纹、目标 SHA、决定范围和 `approval_ref`。需求或交付范围变化后以 `scope_changed` 使人审终态失效并进入新结论流程。
3. 按 [delivery-gates.md](delivery-gates.md)固定原 Issue 约定交付目标（默认 origin/main）的完整 SHA、子模块 SHA、环境和工作区基线。审计与测试使用该版本的字节一致隔离树；代码或服务已漂移时重建环境。记录共享数据库、端口、容器和测试产物的归属，按 [验证与测试资源](testing.md)隔离或串行使用。

## 2. 逐票摄取和验收

每票按[Issue 摄取](issue-delivery.md)的只读规则读取正文、验收、评论中的已确认决定、关闭原因、正式子 Issue、依赖和相关 PR/提交；每种集合分别处理分页、去重、读取时间及完整性，递归子项也不能只取首屏。按 [设计与事实源](design.md)核对有效批准版本及 `CONTEXT.md`。区分 `contains` 与 `depends_on`，普通引用需核实关系。建立 `Issue → 每条验收 → 目标 SHA 中的实现/交付物 → 验证方法 → 证据` 映射；只读摄取不授权实施。

- `completed` 票进入交付验收。`not_planned`、作废、撤回或转移票先按 [design.md](design.md)核实有权批准且覆盖当前需求版本的取消/无需交付决定；决定有效时将单票结论记为 `not_required`，保存决定证据和 `approval_ref`，不要求交付完成决定、不贴待人审标签，已有待人审标签进入纠正分支。没有有效决定或关闭原因不明时记 `unproven`，不得把关闭原因枚举本身当作取消批准。
- 父 Issue 递归读取正式子项，逐项保留独立结论；每日容量及跨日 aggregate_pending 按 [每日规则](closed-issue-daily-run.md)执行；父票另验自身独有要求和组合行为。子票不因父票未通过而自动失败；全部后代均已有有效 `not_required` 决定且父级也无自身交付要求时，父票才可按同一决定链记 `not_required`。
- 需求冲突、子项读取缺失或验收无法定义时保留经脱敏的来源证据、受控原文引用与缺口；不以未知代替“无要求”。

非 Orca 与 Orca 的逐票初审均须由与本票历史实现者及当前主控不同的独立审核者，以新会话/Brief 执行行为验收和代码审查；实际主体、会话谱系与贡献独立性按 [Agent 选择](orchestration-agents.md)核验；Agent 产品相同不自动等于同一主体，单独新开会话也不自动证明独立。历史实现身份不可核实时保留缺口，并按 [Agent 选择](orchestration-agents.md)的历史票替代独立性证明取得有权批准；不得要求恢复过去从未记录的信息。主控只核对证据并裁决，不以自审代替独立性；初审者不得接手本票修复，后续修复复审与终审按 [Agent 选择](orchestration-agents.md)同一独立性判据逐项留证；Orca 场景另核实其候选 ID/Dispatch。

单票按以下顺序验证：

1. 将每条验收写为可观察结果，选择正常、拒绝、边界及适用的权限、并发、持久化、回滚场景。设计或文档票核对批准的交付物与决策验收。
2. 追溯当前 SHA 中的代码、配置、迁移和实际装配调用链，检查关闭后的变更是否撤销或改变行为。独立审查正确性、安全、兼容性和回归；跨票缺陷若使本票行为不可达，也计入本票结论。
3. 实际运行适用的最小相关测试、类型检查、Lint、构建和真实 API/UI/服务验收。运行前读取 [验证与测试资源](testing.md) 及其指定 ADR；保存命令、退出码、实际执行/失败/跳过数、脱敏日志、受控原文引用与环境。静态阅读只支持代码判断，不能充当行为验收。
4. 主控按 [review.md](review.md)对验收映射中的实际实现/装配范围执行 OCR，保存输入清单、覆盖对账和裁决；通用非 Orca 审计也不能省略此项。
5. 按 [目录与产物归处](artifacts.md) 保存单票报告和原始证据，记录目标 SHA、时间、输入、预期与实际结果、代码位置、文件哈希及本轮资源清理复查。主控独立核对报告、原始日志、哈希和目标 SHA。

## 3. 裁决、贴标和人审收尾

每条验收标记 `verified / failed / blocked / unproven / not_applicable`；`not_applicable` 附事实源依据。单票仅在所有适用条款 `verified`、实际运行所需依赖成立、目标 SHA 的 Required Checks/标准 CI 有效、无有效 critical/high/medium finding、独立审查与完整 OCR 及主控证据对账通过时为 `verified`。父票还须通过聚合验收。环境无法运行记 `blocked`，仅有推断记 `unproven`；任一失败或缺口均不能折算通过。`not_required` 是仅依据有效取消/无需交付决定的单票终态，不是验收条款的通过，也不进入交付验收或贴标。

当本轮请求授权 GitHub 贴标时，主控仅对 `verified` 且 `human_review_state=none/pending` 的票执行以下写入门禁：

1. 按 [delivery-gates.md](delivery-gates.md)核对交付目标、需求批准权限、CI 和人审可访问证据。首次发起贴标或复核已有待人审标签时，若 human_review_state=none，先在保存写入意图的同一事务将其改为 pending；已 pending 则保持，approved/rejected 不进入本流程。随后持久保存含需求指纹、目标 SHA、预期人审状态和资格/状态的写入意图。已有标签也须核验，不得在无有效人审终态决定时把已有待人审标签回写为 none。
2. 添加标签并保留 `ready-for-agent`；写后按共同协议完整 rescan，只有意图条件仍成立才算有效。API/回读不明为 `label_pending`；失配为 stale，并按授权纠正，否则 `label_correction_pending`。操作者、时间、URL、前后版本、证据索引及回执均留档。
3. 对 `not_required / failed / blocked / unproven / intake_incomplete` 不添加标签。重新打开、移除 ready-for-agent、有效取消/无需交付决定、有效人审终态或证据过期等使已有标签无效时，进入 R 的纠正分支；按现有移除授权只移除该待人审标签并复核，不改其他标签。无授权或回执不明保留 `label_correction_pending`，不报告纠正成功。
4. 验证结论与交付/标签动作分列，状态契约和仅标签恢复见 [每日规则](closed-issue-daily-run.md)。有效证据未变且只剩贴标/回读/移除时，只做标签对账和必要 rescan；不重跑整票验收。若需求、目标树或 CI 失效则转重验，不能用标签重试复活旧 verified。

人审通过或拒绝须有可核实的人工作出者、决定范围、时间、需求指纹、目标 SHA 和证据入口，分别记 `human_review_state=approved/rejected` 并撤销旧 `pending`；标签移除本身不等于人审决定。两种终态都退出新审和重新贴标调度，保留 Agent 验证结论作为历史，不改写为人工批准。遗留待人审标签按现有授权纠正；没有移除授权时保留具名 `label_correction_pending`，不因此重新验收。人审拒绝要求变更时，以有效需求变更另建 revalidate 范围，不在旧决定上直接复活旧 verified。

R 中只剩 close/delivery 动作的对象，按 [交付门禁](delivery-gates.md)逐项回读原意图与当前远端结果：关闭动作恢复/纠正必须核对授权及后续人工决定；交付动作按 [协调格式](coordination-format.md)的 delivery_action、delivery_intent 和当前回执对账。已进入目标的代码仍记 delivered，树偏离记动作 stale、验证 revalidating，回退/修复另需授权。不因本请求只授权贴标而执行关闭、重开、推送或回退。无授权或回执不明保留对应 pending/correction_pending，报告远端可能仍有错误状态。冻结范围完成还要求每个动作有明确对账结论；未授权动作保持具名待处理。

审计只读代码和测试源文件；修复缺陷另立范围，修复后重验受影响条款。本规则不扩大 GitHub 写入、提交、关闭 Issue 或清理资源的授权。

## 4. 完成和记录

按 [目录与产物归处](artifacts.md) 在 `.archive/runs/<run-key>/` 保存完整候选清单、逐票事实源和验收矩阵、Ledger、报告、验证日志、finding 裁决、label/close/delivery 意图及回执。审查者产品/主体、会话谱系、Dispatch（适用时）、贡献排除范围、历史身份缺口及替代独立性批准由单票不可变 review manifest 索引，daily.issues.review 引用该 manifest，不另造可变身份状态；取消决定和人审决定分别由 `decision`、`human_review` 引用。最终报告列候选数、已摄取数、各结论数、人审各状态数、已贴标与 `label_pending` 数、已有标签复核/移除数、`label_correction_pending` 数、close_action/delivery_action 各状态数及待纠正对象、实际交付回执与未完成原因、未审编号、结束前新增待下轮清单和每票可访问证据入口。仅在冻结 N∪R 逐票有结论或有效人审终态、父票聚合已完成且所有授权动作通过写后条件复核时，报告“冻结范围审计完成（截至时间/清单哈希）”；分批结束时只报告该批确切范围，未授权或失败的纠正明确列为待处理。
