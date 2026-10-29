# 已关闭 Issue 每日审计与修复

配置或运行每日闭票审计修复时读取。定时触发只启动受控Run，不授予实施/提交/部署或GitHub写入权。

| 控制 | 权威入口 |
| --- | --- |
| N/R集合、逐票验收、取消/人审及标签有效性 | [closed-issue-audit.md](closed-issue-audit.md) |
| 角色/独立性/升级 | [orchestration-agents.md](orchestration-agents.md) |
| 原子声明、公共适配器/部署能力 | [coordination-state.md](coordination-state.md) |
| C/P接纳、label预留、修复波次、动作等待/状态及迁移 | [coordination-format.md](coordination-format.md)与[Schema](coordination-schema.json) |
| 修复/集成、验证、交付 | [orchestration.md](orchestration.md)、[testing.md](testing.md)、[delivery-gates.md](delivery-gates.md) |

## 调度配置

用本机Orca automations建立独立任务，不复用普通仓库健康检查；先读当前orca-cli版本指南及create帮助，核repoId/主机/基线/tracker。Issue与标签显式指定 `1123786563/OpenBot`，基线显式 `origin/main`，核实际remote，避免Orca上游显示身份误路由。

| 项 | 初始值与约束 |
| --- | --- |
| 名称/主控 | OpenBot closed Issue 每日审计修复 / codex |
| 触发 | daily，10:00，Asia/Shanghai，含周末；漏跑120分钟内只补一次，超时跳过，不并发补跑 |
| 工作区/预检 | 核实repoId，new-per-run新会话；以回执路径执行，不返回主checkout；precheck获取origin/main并确认GitHub可读，失败记录跳过 |
| C | 正整数，默认4，每Run最多C个audit或单项动作slot；授权贴标闭环C≥2并预留label |
| P | max_parallel_tasks，默认2，范围1–4，按Worker/Worktree/测试资源降额；不授并行实施权，未授权写代码全局串行 |
| 时间/修复 | max_run_minutes=120、max_run_repair_rounds=5，均为回执中的正整数；修复另受跨Run/单Task上限 |

创建/启用前定位统一config、适配器/Schema兼容身份与工具哈希绑定验收回执，试验声明、幂等、崩溃恢复、公平重放；人工走完一票的读取/隔离/证据/修复/恢复/清理后才启用。缺能力记capability_blocked，仅继续独立只读准备，不创建/启用或私造Ledger。部署另需授权。

每Run复查基础设施/主机可用性，核automations runs实际回执（触发不等于审核）；将回执C与共享daily capacity原子核对，冻结含C/P、预留、目标/scope及预算的daily_run_manifest。不一致先修正配置并结算，不双重计容量。

## 批次与并行边界

一个协调者、不可变批次scope/source_issues、一个集成树及共享daily声明；无共同父票不虚构父票。每审计/修复Task绑定原票/finding、实际来源、授权、DAG；终审/OCR覆盖本批授权增量并集。新修复票不扩权或重置预算；范围变化先scope_changed。

统一摄取/去重/冻结后，就绪独立票或兄弟子票按P先派发再等待；每票独立Brief/会话，测试资源隔离。同票审计→修复→复审串行，父聚合等子证据；修复并行仍需明确授权且接口/文件/资源互不冲突。审核也占P，集成和GitHub副作用各由唯一入口串行。启动意图、未知尝试及恢复接纳按协调合同，不能多开Run绕限额。

## 每次运行

1. **独占/恢复**：核历史、Run/Worktree、共享声明/Ledger，取得daily及实际Issue/资源声明，核回执路径。在途先监督/对账，不另启第二写者；未完成修复保留原工作区/检查点，按可行动条件恢复。
2. **选slot**：读取审计规则N/R，按下节recovery/new/revalidate公平选择。每slot只做一票的audit（含父聚合）或label/close/delivery之一，记录slot_kind/动作身份，selected/started/settled一致；每Run≤C。audit接纳时按协调合同原子预留后续label，实际动作仍须另选slot和具备授权，不能捆绑或拿预留当执行。
3. **独立审计**：新审核会话用批次/父epoch固定的SHA、子模块/环境逐条实际验收与代码审查，按审计规则裁决；有效取消结算not_required，不以旧报告/closed替代证据。
4. **分流**：主控核finding复现、验收影响及冻结SHA仍存在性。误报留反证；环境阻塞留复跑命令；范围内有效缺陷进入修复，跨票或改批准需求先明确范围/依赖。
5. **修复**：隔离工作区保存需求、最小DAG、writing-plans方案/完整检查点；按Agent合同派不同于审核者的修复者，RED→GREEN/受影响验证、新独立复审，再终审/OCR。写入尝试绑定协调合同的不可变波次；同Task再试/新增成员另开波，跨日/失败不退款，Task/finding改名不重置谱系。
6. **交付/动作**：本地结论绑定修复检查点；代码按授权进入main并固定新SHA，其相关验收、完整独立终审/OCR、目标CI通过后才贴/保留待人审标签。无相应提交/推送/合并/写入权则保存可恢复工作区/未提交检查点，repair_prepared或integration_pending，不宣称main已修复。部署/迁移/发布另核授权。
7. **预算/结算**：按 [协调合同](coordination-format.md#每日-run-调度与修复波次)核 Run 的C/时间/开波预算、跨Run票级5波及Task级5轮；计次、剩余成员、幂等/谱系和第5波退出按该合同，[Review](review.md)管无进展/能力升级。开波预算耗尽不阻止合法的冻结未尝试成员；时间耗尽停止新派发并安全结算。repair_round_limit 后不得开第6波，须有权新需求/根因决定另立范围，其他对账可继续。每slot追加settled，落盘后才释放独占；只清本轮已核资源。

## 发现后的 Issue 与 PR

先查既有Issue/PR，以finding ID/复现/验收/目标SHA登记。误报/环境故障不发布缺陷票。跨模块、需需求/接口决定、独立依赖或跨日修复才建新修复票并引用原票/证据；本轮局部修复沿用原票＋finding，保留原票历史关闭结论。

本地验证/独立复审后，仅已有提交/推送/PR授权才建PR；检查未齐保持draft，满足审核/CI后转可审核。描述列原票/修复票/finding、验收证据、风险/目标SHA。原票与新票默认Refs，仅交付门禁明确批准的自动关闭契约才Fixes。合并仍执行最终树/条件写/CI，贴标仍待main当前验收；缺权限保存本地检查点及Issue/PR草稿和integration_pending。

## 状态与完成条件

Schema定义字段/枚举，协调格式定义证据/等待/迁移，交付门禁定义写入/纠正，审计规则定义取消/人审。验证、交付、三个动作、人审分别记录；每项报告原因/下一步/等待/恢复入口，保留不可变前后历史、修复累计。verified＋delivered＋label_pending仍未完成贴标；stale或纠正不能复活旧verified。取消/人审终态不进新审/重贴标，只恢复具名动作；授权实现拒绝修复须新attempt/新已验检查点，沿用预算/队列序号。

父树：每子票实际验收和父独有/聚合验收各占audit；只读摄取不占行为slot，改变需求/状态投影须scope_changed/state_changed的recorded无slot事件。首次选树保存不可变 [audit_epoch_manifest](coordination-schema.json#/$defs/audit_epoch_manifest)，含完整后代/需求、目标/子模块、policy/队列，跨日保持冻结目标，不在父聚合时切新main。父为aggregate_pending，按名额补子缺口；父slot只核同SHA有效子证据、覆盖父对应要求的取消决定及父剩余/组合验收，补跑子票另排slot。需求变化使受影响epoch证据失效并保存旧快照/修订队列。

历史epoch通过不等于当前放行。目标前移先比较代码/递归gitlink/配置/迁移/装配，把每条验收/子证据标为可承接/需补验/失效，取消项另核当前需求/父级覆盖。相关实现/依赖/环境/输入均不变才可承接，由独立reviewer核影响，保存新SHA不可变revalidation manifest引用旧证据/差异，子项target_sha更新；未知/受影响补验。当前目标仍须完整独立终审、完整OCR和目标CI，父聚合未齐不放行。

收敛：建立/更换epoch时算剩余验收L（子票/补验各一＋父一）及后续动作/预留A；L+A>C或已有目标前移时，向有权管理目标写入者申请稳定窗口，记录approval_ref、ref/SHA、起止、L/A、实际停写/queue控制与临时容量批准。取得后结算原Run，以获批C=L+A开连续Run，P仍核授权/资源，共享daily原子用同容量，完成剩余验收/聚合/就绪动作后再读目标。窗口非本地锁可证明；未取得时允许有证据的承接/局部补验，不反复重开全树。连续两个epoch（单票为两轮）因前移无法放行，保存历史并blocked等待稳定窗口；窗口内仍漂移则撤放行、重新影响分析。摄取超预算留游标，不宣称全树通过，动作预留不豁免新鲜度/终审/OCR/CI。

证据归 [artifacts.md](artifacts.md) 的唯一Run根，共享Ledger仅存跨日队列/恢复索引，按 [coordination-state.md](coordination-state.md)事务更新Issue→目标SHA→Run/工作区/检查点→审核→动作→等待/下一步。new-per-run不自动传归档，跨工作区使用绝对路径/哈希；不一致先对账，不重复修复。

## 公平调度与等待条件

类别轮转 recovery→new→revalidate→recovery，首次next_class=new。recovery含可行动的中断修复/目标交付/所有遗留动作，不以N/R当前状态过滤；new为无有效旧结论且无取消/人审终态者；其余失效验收为revalidate。每票唯一类，优先recovery；not_required/有效人审终态仅具名遗留动作进入recovery，授权实现拒绝修复按审计显式迁移后再调度。首次非completed票仍占new核取消决定。

从next_class找首个非空可接纳类，选择事务保存slot_selected、服务序号/预算、next_class/consecutive_recovery；选择成功才推进一次，空类不占slot。settled可乱序但不推进公平游标；存在其他可接纳类时最多连续一次recovery。持续可接纳类最多等另两次选择；可接纳要求无本票在途、依赖/预算/资源允许，阻塞保留原因/年龄，不计服务界限。

类内按queue_key=last_slot??enqueue_sequence升序；同键未服务票优先，再eligible_since、规范Issue编号。首次入队由适配器事务固定enqueue_sequence=当前slot_sequence，选择更新last_slot；失败/恢复/改类/退避不清零两序号，eligible_since保留首次可行动年龄。服务后排队尾，其他同类票可接纳时不连续选自己；仅剩自己可继续。持续新到或旧票续作均不破坏彼此服务上界；父子同规则，aggregate_pending不抢光名额。公平按选择而非完成顺序重放，C仅限制Run的slot数。

验证级及各动作级分别按 [协调合同](coordination-format.md#每日-run-调度与修复波次)的可行动算法保存等待字段、刷新带source_ref/时间的观测并探测/唤醒；硬条件未满足不执行副作用。退避不抹年龄，无可行动报告idle/等待。

监督在途不占新slot：已选未结算先对账原Dispatch，同票仅恢复原slot；其他独立票可在P/资源内推进。未知/未退出尝试占P，不为公平抢锁或凭列表缺席释放；结算/证明边界不冲突后换票，记录延迟及未轮转原因。

## 自动化任务提示词

```text
对GitHub 1123786563/OpenBot执行一次已关闭ready-for-agent审计修复，对账全状态待人审标签与遗留动作。先读AGENTS.md和.agents/rules/closed-issue-daily-run.md，按触发加载权威合同。以当前Orca回执核repoId/主机/new-per-run工作区、origin/main、C/P和预算。执行摄取、声明/隔离、公平接纳、独立验收/审核/OCR、授权目标交付/写后对账、保全恢复。缺能力/授权仅阻塞相应阶段，不回主checkout、不扩写权。报告确切范围、逐票验证/人审/动作状态、证据、阻塞及恢复入口。
```
