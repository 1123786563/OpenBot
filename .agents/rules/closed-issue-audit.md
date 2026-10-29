# 已关闭 Issue 的 Agent 验证与待人审标签

审计 `1123786563/OpenBot` 已关闭ready-for-agent票，或核对/添加agent:ready-for-review时读取。仅覆盖本文件N∪R，不宣称全部闭票。待人审标签表示Agent验收通过、等待人审，不表示人工批准；closed、merged、旧测试/标签均非当前交付证据。

## 1. 冻结范围和代码版本

1. 分集合分页、排除PR并冻结：N=closed且ready-for-agent的所有票（含首次遇到的completed/not_planned/作废/关闭原因不明）；R=任意状态待人审标签票＋共享Ledger全部未结算label/close/delivery意图及纠正对象，不受当前标签/资格/状态过滤。记录查询起止/条件、页数/游标、数量/编号/URL、去重/完整性；搜索上限拆分核对，缺页/无权/转移不完整记intake_incomplete。
2. 对账已有Run/报告/回执/人审、Git、工作区。仅需求、目标代码、环境、证据一致且有依据才复用，不重派有效完成项。有效人审approved/rejected只核决定有效性及遗留动作，不重验/贴标；决定绑定需求指纹、目标SHA、范围、approval_ref。需求/交付范围变化用scope_changed失效；原验收下的实现拒绝按第3节显式迁移。
3. 按 [delivery-gates.md](delivery-gates.md)固定原交付契约（默认origin/main）、完整SHA/子模块、环境/基线，使用字节一致隔离树，漂移重建。测试资源按 [testing.md](testing.md)隔离/串行；批量并行按 [daily](closed-issue-daily-run.md)唯一scope及C/P接纳，摄取不授权写入。结束重查新增/移除/状态变化，新增记发现时间和下轮队列，不扩本轮容量。

## 2. 逐票摄取和验收

每票按 [issue-delivery.md](issue-delivery.md)完整只读摄取正文/验收/已确认讨论、关闭原因、正式子项/依赖、PR/提交；按 [design.md](design.md)核批准来源及CONTEXT。建立“每条验收→目标实现/交付物→方法→证据”映射，缺口保留脱敏来源/受控原文，不以未知作无要求。

- completed进入验收；not_planned/作废/撤回/转移先核有权且覆盖当前需求的取消/无需交付决定。有效则not_required并存决定/approval_ref，无须伪造交付完成决定，不贴标，旧标签纠正；否则unproven，关闭原因不等于批准。
- 父票递归保留子票独立结论，另验父级独有/组合要求。子不随父失败；混合verified/not_required按 [协调格式](coordination-format.md)核同SHA证据或覆盖父要求的取消决定。全后代有效取消且父无自身交付要求才可按决定链not_required；每日父级/容量按daily。

[orchestration-agents.md](orchestration-agents.md)统一规定逐票初审、修复、复审、终审的候选/主体、会话/贡献独立性及历史身份缺口替代批准，非Orca同样适用。初审须独立于主控及可核实历史实现者，新窗口不自动证明独立；主控只对账/裁决，初审者不接修复，Orca另核真实ID/Dispatch。

逐票顺序：

1. 将验收写为可观察结果，覆盖正常/拒绝/边界及适用权限、并发、持久化、回滚；文档/设计票验批准交付物/决定。
2. 追溯当前SHA代码、配置、迁移、实际装配，核关闭后变更及使本票行为不可达的跨票缺陷；独立审正确性/安全/兼容/回归。
3. 按testing及ADR实际运行最小相关测试/类型/Lint/构建和必要API/UI/服务验收；静态阅读不能代替行为结果。保留命令/退出码/实际用例/失败跳过、脱敏日志/原文引用、环境及清理复查。
4. 主控按 [review.md](review.md)对实际实现/装配范围执行适用完整OCR，保留输入/覆盖对账/裁决；非Orca也执行。
5. 按 [artifacts.md](artifacts.md)存单票原始证据/报告，含SHA/时间、输入/预期/实际、代码位置/文件哈希；主控独立核报告、日志、哈希、目标SHA。

## 3. 裁决、贴标和人审收尾

条款结论为verified/failed/blocked/unproven/not_applicable，最后一项须来源依据。单票verified要求全部适用验收通过、依赖成立、目标Required Checks/标准CI有效、无有效critical/high/medium、独立审查/适用完整OCR及主控对账通过；父票另含聚合。环境不可运行blocked，仅推断unproven；not_required仅为有效取消终态，不冒充验收通过或进入贴标。

本轮有贴标授权时，仅verified且human_review_state=none/pending可进入流程；每日audit与label各占slot并按协调合同预留预算，预留不授写权。

1. 按交付门禁核目标/批准/CI/共享证据。首次或已有标签核验中，none→pending须与持久写入意图同事务；pending保持，approved/rejected不进入。意图绑定需求/目标、预期人审/资格/状态；不能因已有标签把pending倒写none。
2. 添加待人审标签，保留ready-for-agent；按delivery-gates执行完整写后rescan、失配/超时/纠正。记录操作者/时间/URL、前后版本、证据和回执。
3. not_required/failed/blocked/unproven/intake_incomplete不贴标。重开、移除资格、有效取消/人审终态、证据过期使旧标无效时进入R；仅在移除授权内纠正该标签，不动其他标签；缺授权/回执不明为label_correction_pending，不宣称成功。
4. 验证与各动作分列。证据有效且只剩贴标/回读/移除时仅对账及必要rescan，不重验整票；需求/目标树/CI失效则重验，标签重试不复活旧verified。

人审决定记录可核实人工作出者、范围/时间、需求指纹/目标SHA、证据入口和approval_ref，approved/rejected替代pending并退出新审/重贴标。Agent结论仍是Agent历史，不变成人工批准；标签移除不代表人审。旧标按授权纠正，缺移除授权只留待办。

拒绝后：需求改变须有权范围决定并scope_changed；实现不满足原验收且已有对应finding修复授权时，按协调合同用state_changed保存旧拒绝/需求/目标/检查点与完整前后状态，再建新attempt关联finding/授权，human_review_state=none、human_review=null、validation_state=finding_confirmed，撤旧放行，历史不可变。修复、独立验证/复审、完整终审/OCR、目标验收通过后，以新检查点/新意图转pending；旧检查点不得直接重贴标。缺授权/原因不明保持rejected及等待。新attempt沿用入队/服务序号、repair_rounds_total，不重置公平/预算，遗留动作继续各自对账。

R中的close/delivery按交付门禁回读意图/远端；关闭纠正核后续人工决定，交付树偏离记delivered＋stale/revalidating，修复/回退另核授权。仅贴标授权不允许关闭/重开/推送/回退；缺授权/回执留具名pending/correction_pending并报告远端可能错误。审计只读业务代码/测试，修复另定范围并补验受影响条款。

## 4. 完成和记录

Run保存N/R清单、来源/矩阵、Ledger、原报告/日志、finding、三个动作意图/回执。单票不可变review manifest索引审核主体/产品/会话谱系、适用Dispatch、贡献排除、历史身份缺口/替代批准，daily.issues.review引用它；decision/human_review分别引用取消/人审决定，不另造可变身份状态。

报告列候选/摄取/各验证结论/各人审状态数，贴标/复核/移除及pending/correction_pending，close/delivery各动作状态和待纠正对象，实际交付回执、未审编号/原因、下轮新增、逐票可访问证据。仅N∪R逐票有结论或有效人审终态、父聚合完成、所有授权动作写后匹配时，才报告冻结范围完成并注明截至时间/清单哈希；分批只报确切批次，未授权/失败纠正仍列待办。
