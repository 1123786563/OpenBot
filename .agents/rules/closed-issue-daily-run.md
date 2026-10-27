# 已关闭 Issue 每日审计与修复

配置或运行“每天审核已关闭 Issue，发现问题后修复”的自动化时读取。审计判定沿用 [已关闭 Issue 验证](closed-issue-audit.md)，Agent 路由以 [Orca Agent 选择](orchestration-agents.md)为准；修复沿用 [Issue 摄取与 DAG](issue-delivery.md)、[执行](execution.md)、[验证](testing.md)、[Review/OCR](review.md) 和 [Worktree](worktrees.md)。定时触发只启动一次受控 Run，不改变这些门禁或 GitHub 写入授权。

## 调度配置

优先用本机 Orca `automations` 为本仓库建立独立任务，不复用普通仓库健康检查的自动化。创建前读取当前 `orca-cli` 的版本匹配指南和 `orca automations create --help`，核对仓库 ID、主机、默认基线与目标 GitHub tracker。当前仓库同时有 `origin=1123786563/OpenBot` 与 `upstream=CopilotKit/OpenBot`；Issue 查询和标签写入显式指定 `1123786563/OpenBot`，代码基线显式指定 `origin/main`，不能依赖 Orca 显示的上游项目身份。

建议初始配置如下；时间和单次容量可调整，实际值记入自动化回执：

| 项 | 值 |
| --- | --- |
| 名称与 Agent | `OpenBot closed Issue 每日审计修复`；`codex` 协调 |
| 触发 | `daily`，`10:00`，`Asia/Shanghai`；含周末 |
| 运行位置 | 已核实的 OpenBot repoId；`new-per-run`，每次新会话，实际工作区以本轮 Orca 回执为准 |
| 基线 | `origin/main`；启动前 precheck 获取 `origin/main` 并确认 GitHub 可读，失败则记录跳过 |
| 容量 | 正整数 C，默认 1；每轮最多 C 个实际验收名额或仅动作对账名额，漏跑宽限 120 分钟，宽限外跳过 |

创建或启用自动化前，先定位并验证协调基础设施：从主机统一配置或 [共享协调状态](coordination-state.md)的默认位置解析实际 `coordination_root` 绝对路径，读取其 `config.json`，核对唯一事务适配器的绝对入口、版本、内容哈希、schema 兼容范围及 [协调格式](coordination-format.md)规定样例的验收回执；再用试运行事务验证声明取得、幂等重放、崩溃恢复和公平性重放。自动化回执必须保存上述路径、适配器身份和验收证据入口。默认文件不存在时继续查找已核实的统一覆盖配置；没有可定位配置、适配器或有效验收时不得创建/启用定时任务，只能保留只读审计能力并报告 `capability_blocked`，不得用私有 Ledger 替代。

首次启用前还须在人工触发的试运行中走完一票，核对读取、隔离、证据、修复与恢复路径；实际启用状态以 Orca 回执为准。每轮启动时复查上述基础设施，并将回执中的 C 与共享 daily record 的 capacity 原子核对，二者不一致先修正配置并结算，不得按两个容量分别执行。错过触发时只补一次，过期跳过并记录；不要并发补跑多次。本机调度要求运行主机可用；每次检查 Orca `automations runs` 回执，不能把“已触发”当作“已审核”。

## 每次运行

1. **独占与恢复**：检查 Orca 历史、活跃 Run/Worktree、共享资源和 Ledger；按[共享协调状态](coordination-state.md)取得 `daily:<repo-key>` 声明和所需 Issue/资源声明。回执核对本轮实际路径，固定仓库路径仅用于定位，不回到主 checkout 实施。恢复仍在运行的任务先监督/对账，不并发启动第二写入者；已结算但未完成的修复保留原工作区和检查点，按下述可行动条件调度。
2. **选择**：分别读取 N 新审集合与 R 标签对账集合，按下述 recovery/new/revalidate 三类别公平调度；首次遇到的非 completed 票也入 new，先核实关闭决定。有效 `not_required` 或人审终态不占新验收入额，只有遗留动作时进入 recovery。每个 slot 只选择一票的一项工作：`audit`（单票、子票或父聚合实际验收）或 `label / close / delivery` 中一个具名动作；同票多个动作须分别选择并结算，不能捆绑在一个 slot。`slot_selected` 回执和事件须记录 `slot_kind` 及动作身份，同一 slot 的 started/settled 沿用该身份。每轮最多 C 个不同 slot；父票子树的只读摄取不等于逐子票行为验收已完成，已有标签也不是跳过对账的依据。
3. **审计**：按 [Orca Agent 选择](orchestration-agents.md)另启逐票审核 Agent，冻结 `origin/main` 的完整 SHA、子模块和环境，逐条核对 Issue 验收、实际装配链、适用测试与独立代码质量审查。报告每条 `verified / failed / blocked / unproven / not_applicable`、证据、finding 严重度和归属；有效取消按审计规则直接结算 `not_required`。审计 Agent 只读业务代码和测试源文件；不能以旧测试报告或 `closed` 状态宣称通过。
4. **缺陷分流**：主控核实 finding 的复现、验收影响及是否仍存在于冻结 SHA。误报记录反证；环境阻塞保存复跑命令；有效且在本票范围内的缺陷进入修复。跨票或需要改批准 Spec/ADR 的问题先明确边界和依赖，不在本票中顺手扩大范围。
5. **修复闭环**：在隔离执行工作区保存 Issue 快照、最小修复 DAG、`writing-plans` 方案及检查点；按 [Orca Agent 选择](orchestration-agents.md)把有效问题交给与审核者不同的修复 Agent，跑针对性 RED→GREEN 与受影响验证，再由新的独立复审 Agent 检查 Spec compliance 和 code quality，最后对完整修复范围完成终审与 OCR。每轮修复启动前，以事务将跨 Run 的 `repair_rounds_total` 精确加一并记录 run_id、Task/finding、Dispatch 和检查点；失败或跨日不扣减，new-per-run 不从零重计。有效 finding 返回修复与复审；连续两轮同一问题无进展按 [Review/OCR](review.md)诊断升级。主控不以自己写完代码代替独立审核。
6. **交付门禁**：修复后的结论绑定实际修复检查点。仅在代码按现有授权进入目标 `main`、重新冻结新的 SHA、相关验收、完整独立终审、完整 OCR 及 Required Checks/标准 CI 在该 SHA 通过后，才按 [已关闭 Issue 验证](closed-issue-audit.md)添加或保留 `agent:ready-for-review`。没有提交、推送、合并或 GitHub 写入授权时保留可恢复 Worktree 与完整未提交检查点，状态记 `repair_prepared` 或 `integration_pending`；不声称当前 `main` 已修复。生产部署、数据迁移与外部发布另按各自授权执行。
7. **预算与结算**：C 只限制 slot 数，自动化回执还须给出 `max_run_minutes` 和 `max_run_repair_rounds` 两个正整数预算（默认 120 分钟、5 轮）。单 Run 修复预算不得超过全局剩余额度；同一审计票完整修复范围（含其全部 Task/finding）的 `repair_rounds_total` 全局上限为 5 轮，与 [Review/OCR](review.md) 的单 Task 上限同时适用；创建新 Run、新修复 Issue、拆 Task 或改 finding ID 均不重置。达到 Run 时间或 Run 修复预算但仍有全局额度时，在当前检查点安全结算并按 recovery 恢复；达到或超过全局 5 轮且问题未解决时记 `blocked`（reason=`repair_round_limit`，历史迁移可能保留大于 5 的真实次数），不得再排修复 recovery，只能按有权批准的新需求/根因决定另立范围，其他对账动作不受此限制。不得因尚有剩余时间或 slot 隐瞒未解决问题。保存候选清单、目标 SHA、逐票报告、命令与用例数、资源清理、Review/OCR、标签回执、全局/本轮修复轮次、未解决问题和下一次恢复入口。按 [协调格式](coordination-format.md)为每个已选 slot 追加标准 settled 事件；释放本轮独占锁前确认 Ledger 已落盘。受控资源只清理本轮创建且归属已核对的部分。

## 发现后的 Issue 与 PR

- 主控先检索现有 Issue/PR，并以 finding ID、复现、受影响验收及目标 SHA 登记到 Ledger。误报和环境阻塞保留审计记录，不发布“代码缺陷”Issue。
- 有效缺陷若跨模块、需要需求/接口决定、存在独立依赖，或预计跨日修复，创建新的修复 Issue，引用原已关闭 Issue 与证据；原票的关闭状态和历史结论如实保留。范围明确且能在本轮完成的局部修复，可直接以原 Issue 和审计 finding 为跟踪入口，避免重复票。
- 修复代码通过本地验证与独立复审后，若已有提交、推送和 GitHub PR 授权，创建修复 PR；仍待检查时保持 draft，完成所需审核与 CI 后转为可审核状态。PR 描述列原 Issue、修复 Issue（若有）、finding、验收证据、风险和目标代码 SHA。引用已关闭原票用 `Refs #<原票>`；新修复票同样默认用 `Refs #<新票>`；仅 [delivery-gates.md](delivery-gates.md) 明确批准的“合并即完成”交付契约和自动关闭授权可用 `Fixes`。
- 合并须满足 [delivery-gates.md](delivery-gates.md) 的目标新鲜度、写前最终树验证/审查及条件写保证、当前合并授权；PR 已开、获批或合并均不能代替目标 `main` 的最终验收。`agent:ready-for-review` 只在合并后的目标 SHA 经重验通过时添加。缺少相应 GitHub 写入授权时保留本地检查点、PR/Issue 草稿内容和 `integration_pending` 状态。

## 状态与完成条件

单票分别持久化验证、交付、标签、关闭和人审字段，禁止用动作状态冒充验证结论：

| 字段 | 枚举及边界 |
| --- | --- |
| validation_state | queued / auditing / finding_confirmed / repairing / revalidating / verified / not_required / blocked / failed / unproven / intake_incomplete / aggregate_pending |
| delivery_state | none / repair_prepared（修复检查点已固定但尚未完成本地验证/审查）/ integration_pending（本地验证审查通过，等待进入约定目标或目标验收）/ delivered（已有目标交付回执；不单独表示当前 verified） |
| delivery_action | none / delivery_pending / applied_valid（只表示意图树已进入目标）/ stale / delivery_correction_pending / corrected |
| label_action | none / label_pending / applied_valid / stale / label_correction_pending / corrected |
| close_action | none / close_pending / applied_valid / stale / close_correction_pending / corrected |
| human_review_state | none / pending / approved / rejected；approved/rejected 必须有当前需求、目标及决定范围的人审证据 |

另存 `decision`、`human_review`、跨 Run 的 `repair_rounds_total`、delivery/label/close 各自 intent 和当前回执。`next_action` 只表示验证下一阶段；每个动作分别保存 `<action>_action_reason`、`<action>_next_action`、`<action>_wait_reason`、`<action>_input_fingerprint`、`<action>_resume_condition` 和 `<action>_retry_after`，不得用单票共用原因、验证等待或共享指纹代替另一动作的恢复记录。标签动作 pending 可在 validation_state=verified、delivery_state=delivered 时存在；不将其算作贴标完成。写后失配按 [交付门禁](delivery-gates.md)和 [协调格式](coordination-format.md)先记 stale；除仅由有效取消或人审终态引起的标签纠正外，使当前 verified 失效，后续 correction_pending 不得复活旧结论。`not_required` 须有有效取消决定且不允许贴标/关闭放行；有效人审终态退出新验收入队，只保留必要的遗留动作 recovery。每次报告各字段、动作级未完成原因、下一步和恢复入口。

父票容量按“实际验收名额”计算：每个子票验收和父票独有/聚合验收各占一个 `audit` 名额，同一 C 限流；只读摄取不占行为验收名额；主控分页读取和关系核验属于选票前准备，不由此取得业务写权限。摄取改变持久需求/状态投影时用 scope_changed/state_changed、result=recorded 的无 slot 事件留证；选中后的实际验收及动作仍走 slot/Dispatch 契约。首次选择父级树时持久保存不可变 epoch manifest（epoch_id、完整 contains/需求指纹、目标仓库/ref/SHA/子模块、policy revision/manifest 引用、子票队列；精确字段以 [协调 schema](coordination-schema.json#/$defs/audit_epoch_manifest)为准），跨日均验该冻结目标，不在每次父聚合时改成最新 main。父票记 aggregate_pending，子票缺口可逐名额补齐；父聚合名额只核验该 epoch 已有同 SHA 子证据及父级独有/组合行为，发现需补跑子票则另排名额，不能藏在父票名额内。需求变化使受影响 epoch 证据失效，保存旧快照后修订队列；不覆盖旧结论。

全部子票和父聚合通过只报告“历史 epoch 的 SHA 审计完成”，不等同当前目标放行。写入标签/关闭前仍须确认放行 SHA 就是当前交付目标并满足 delivery-gates。目标前移时保留旧 epoch 历史，并先生成旧→新目标的影响分析：比较代码、递归 gitlink、配置、迁移和装配差异，将每条验收及每份子证据标为“可承接 / 需补验 / 失效”。只有相关实现、依赖、环境和验证输入均未受影响的证据才可承接；由独立 reviewer 核对影响范围，并为新 SHA 生成引用旧证据和差异分析的不可变 revalidation manifest，子项登记的 target_sha 为新 SHA。受影响项只补跑对应行为验收；当前目标最终仍须完整独立终审、完整 OCR 和 Required Checks/标准 CI，证据承接不豁免这些门禁。未能证明未受影响的项一律补验，父票在聚合完成前保持 aggregate_pending，旧结论不贴标、不关票。

默认收敛路径如下：首次建立或更换父级 epoch 时计算剩余名额 K（未完成子票及受影响补验各一名，加父聚合一名）。K>C 或已有目标前移时，主控先向有权管理目标写入的人申请稳定窗口，记录 `approval_ref`、目标 ref/SHA、起止时间、K、暂停写入或 merge queue 的实际控制证据和临时容量批准；取得窗口后安全结算当前 Run，再以批准的 C=K 启动新的连续执行 Run，并在共享 daily record 原子登记同一容量，由该 Run 完成剩余验收和父聚合，窗口结束再次回读目标 SHA。本地声明不能证明外部写入者暂停，不能冒充稳定窗口。窗口未取得时不反复重开全树 epoch：继续允许有证据的影响承接和局部补验；连续两个 epoch 因目标前移无法放行后，保留历史结论并将当前放行的验证状态置为 blocked，恢复条件是取得上述稳定窗口，而不是每日从头重验。窗口内目标仍变化则本次放行失败并按新差异重做影响分析。摄取超出预算保存游标，不能宣称全树已审。

每日 Run 的索引和逐票证据存 `.archive/runs/<run-key>/`；跨日共享 Ledger 使用[共享协调状态](coordination-state.md)规定的唯一持久路径和事务更新，登记 `Issue → 最近有效目标 SHA → Run/Worktree → 检查点 → 审核状态 → 标签/关闭/交付回执 → 等待条件/下次动作`。Orca 的 `new-per-run` 不自动带入 `.archive/`；跨工作区读取/转移时使用绝对路径并核对哈希。历史与 Ledger 不符先对账，不重新修同一缺陷。

## 公平调度与等待条件

- 三类枚举与循环顺序为 `recovery → new → revalidate → recovery`。recovery 包含可行动的中断修复、目标交付，以及所有未结算 label/close/delivery 意图的回读或纠正；这些动作对象独立加入候选集合，不以 N/R 当前标签和状态过滤；new 包含从未有有效结论且无人审/取消终态的 N/R 对象；revalidate 包含已存在但失效的验收。每票只进一类，优先归 recovery、否则按是否有旧结论区分。从共享 `next_class` 起寻找第一个非空可行动类别，逐名额原子记录 slot_selected，结算或启动后失败都追加 settled 并推进到下一类别；空类跳过，不消耗名额。首次 next_class=new。存在其他可行动类时连续恢复名额上限为一，故 A/A/B/B 恢复票不能垄断。首次入队时由适配器在同一事务保存 `enqueue_sequence=当前 slot_sequence`；类内排序键为 `queue_key = last_slot ?? enqueue_sequence`，按 queue_key 升序，queue_key 相同时从未服务的 last_slot=null 优先，再按 eligible_since、规范 Issue 编号升序。这样新到票进入当前轮转位置，既不能持续插到既有票之前，也不会被连续动作的旧票永久压在队尾。选择即更新 last_slot 到新 slot_sequence，失败、恢复及改类均不清空最近服务序号或入队序号。eligible_since 保留首次可行动年龄用于 SLA，不作为反复占优的唯一排序键。每个持续可行动类最多等待另外两次已结算名额，以该类连续未被选中的已结算名额数检查并报告违例；票级等待另外按 queue_key 轮转检查，不将票等待数用于类级两次上限。C 只改变每轮名额数，不改变逐 slot 轮转顺序。
- 同类有其他持续可行动票时，获得一次名额的票排到队尾，不连续占两个名额；仅剩本票可行动时无需等待。故同类持续可行动队列内每票最多等待其余当前可行动票各一次选择；新到票按 enqueue_sequence 参与同一轮转，新旧任一方持续到达或续作都不破坏另一方服务上界。退避票恢复时沿用最近服务序号和原入队序号参与排序，不重置为 null 获得额外优先。C 按逐 slot 选择计上限，例如 C=2、同类 A/B 就绪时可依次选 A、B；无需把两个名额改成一批轮次。同票不同动作也受此队尾约束。父子验收队列同样适用类别轮转，不能以 aggregate_pending 抢占全部名额。
- 等待票保存验证级 `wait_reason / resume_condition / input_fingerprint / retry_after`，待执行动作使用各自动作级等待字段。是否可行动只按 [协调格式](coordination-format.md)的统一算法判定：硬授权/决定条件未满足时即使 retry_after 到期也不执行写入；API/环境探测到期可以选择一个 recovery slot 做只读或测试性探测，条件变化可经主控对账提前唤醒。可行动的 label_action=label_pending/stale/label_correction_pending、close_action=close_pending/stale/close_correction_pending，以及 delivery_action=delivery_pending/stale/delivery_correction_pending 或 delivery_state=integration_pending 的对象进入 recovery，只回读意图、核对当前需求/目标/CI/证据，按已有授权补标签、对账关闭或纠正；stale 不直接重写远端，先在 slot 内回读后再转相应纠正。遇需求/目标失效转 revalidate，并保留纠正动作；首次 not_planned 先占 new 名额核实，有效取消结算 not_required，只有之后等待明确决定时才退避。
- API/环境故障按 1、2、4 天退避，之后每 7 天；主控在每次候选对账时刷新只读观测，探测 Worker 在到期 slot 内刷新环境观测，观测回执写入后才能改变可行动判定。可行动时间 eligible_since 与 retry_after 分别保存；不能以反复退避抹掉年龄。无可行动票报告 idle 与等待清单。
- 监督仍在运行的 Worker 不等于新名额；活跃写入不能为公平强行抢锁。已选未结算 slot 先按标准事件和 Dispatch 对账，不能因换日重复占用。安全结算或证明边界互不冲突后换票，记录占用延迟和未轮转原因；未知拥有者按共享协议处理。

## 自动化任务提示词

```text
对 GitHub 1123786563/OpenBot 执行一次带 ready-for-agent 的已关闭 Issue 每日审计与修复及全状态待人审标签对账。以本轮 Orca 回执中的 repoId、主机和实际 new-per-run 工作区为准，核对 Git 根目录；仓库登记路径仅用于定位，不返回主 checkout 写入。先读根 AGENTS.md、.agents/rules/closed-issue-daily-run.md 及引用规则，核对协调 config.json、唯一适配器入口/哈希和验收回执，再核对自动化、Run、Worktree、Git、共享协调根与跨日 Ledger；基础设施无效则记 capability_blocked，不启动写入。从自动化回执和共享 daily record 核对同一正整数容量 C（默认 1）及时间/修复预算，每轮最多选择 C 个不同 audit 或单项 label/close/delivery 动作 slot，同票动作不捆绑；按 recovery/new/revalidate、last_slot ?? enqueue_sequence 的类内公平轮转和统一唤醒算法选择。审计 origin/main 的冻结 SHA，逐条实跑验收并保存证据；有效取消记 not_required，有效人审终态不重新贴标。父票按冻结 epoch 跨日验同一 SHA，历史 epoch 通过不等于当前放行；目标前移先做影响分析和证据承接，只补受影响验收，当前目标仍完成完整终审/OCR/CI；需要稳定窗口时按批准、容量和连续 Run 流程取得，不反复从头重验。有效问题用 writing-plans、Orca 监督式派发、独立 Review 和 OCR 在隔离工作区闭环修复，不再启动第二套 SDD 派发器。仅在代码进入目标 main 且目标检查点重验通过，并有标签写入授权时添加 agent:ready-for-review；失效标签按授权纠正，无授权记 label_correction_pending。按 delivery-gates.md 保存写入意图并在写后完整 rescan，失配先记 stale，除有效取消/人审终态纠正外使旧 verified 失效，再按现有授权纠正；保存回执，未授权提交/推送/合并/发布保持待处理。报告本轮 Issue、结论、人审状态、证据、修复位置、各动作等待条件及恢复入口。
```
