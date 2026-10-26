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

首次启用前在人工触发的试运行中走完一票，核对读取、隔离、证据、修复与恢复路径；实际启用状态以 Orca 回执为准。每轮启动时将回执中的 C 与共享 daily record 的 capacity 原子核对，二者不一致先修正配置并结算，不得按两个容量分别执行。错过触发时只补一次，过期跳过并记录；不要并发补跑多次。本机调度要求运行主机可用；每次检查 Orca `automations runs` 回执，不能把“已触发”当作“已审核”。

## 每次运行

1. **独占与恢复**：检查 Orca 历史、活跃 Run/Worktree、共享资源和 Ledger；按[共享协调状态](coordination-state.md)取得 `daily:<repo-key>` 声明和所需 Issue/资源声明。回执核对本轮实际路径，固定仓库路径仅用于定位，不回到主 checkout 实施。恢复仍在运行的任务先监督/对账，不并发启动第二写入者；已结算但未完成的修复保留原工作区和检查点，按下述可行动条件调度。
2. **选择**：分别读取 N 新审集合与 R 标签对账集合，按下述 recovery/new/revalidate 三类别公平调度；首次遇到的非 completed 票也入 new，先核实关闭决定。每轮最多选择 C 个不同实际验收名额或 label/close/delivery 动作名额，同一票同一 slot 不重复计数；父票子树的只读摄取不等于逐子票行为验收已完成。已有标签不是跳过依据。
3. **审计**：按 [Orca Agent 选择](orchestration-agents.md)另启逐票审核 Agent，冻结 `origin/main` 的完整 SHA、子模块和环境，逐条核对 Issue 验收、实际装配链、适用测试与独立代码质量审查。报告每条 `verified / failed / blocked / unproven / not_applicable`、证据、finding 严重度和归属。审计 Agent 只读业务代码和测试源文件；不能以旧测试报告或 `closed` 状态宣称通过。
4. **缺陷分流**：主控核实 finding 的复现、验收影响及是否仍存在于冻结 SHA。误报记录反证；环境阻塞保存复跑命令；有效且在本票范围内的缺陷进入修复。跨票或需要改批准 Spec/ADR 的问题先明确边界和依赖，不在本票中顺手扩大范围。
5. **修复闭环**：在隔离执行工作区保存 Issue 快照、最小修复 DAG、`writing-plans` 方案及检查点；按 [Orca Agent 选择](orchestration-agents.md)把有效问题交给与审核者不同的修复 Agent，跑针对性 RED→GREEN 与受影响验证，再由新的独立复审 Agent 检查 Spec compliance 和 code quality，最后对完整修复范围完成终审与 OCR。有效 finding 返回修复与复审；连续两轮同一问题无进展按 [Review/OCR](review.md)诊断升级。主控不以自己写完代码代替独立审核。
6. **交付门禁**：修复后的结论绑定实际修复检查点。仅在代码按现有授权进入目标 `main`、重新冻结新的 SHA、相关验收、完整独立终审、完整 OCR 及 Required Checks/标准 CI 在该 SHA 通过后，才按 [已关闭 Issue 验证](closed-issue-audit.md)添加或保留 `agent:ready-for-review`。没有提交、推送、合并或 GitHub 写入授权时保留可恢复 Worktree 与完整未提交检查点，状态记 `repair_prepared` 或 `integration_pending`；不声称当前 `main` 已修复。生产部署、数据迁移与外部发布另按各自授权执行。
7. **结算**：保存候选清单、目标 SHA、逐票报告、命令与用例数、资源清理、Review/OCR、标签回执、未解决问题和下一次恢复入口。按 [协调格式](coordination-format.md)为每个已选 slot 追加标准 settled 事件；释放本轮独占锁前确认 Ledger 已落盘。受控资源只清理本轮创建且归属已核对的部分。

## 发现后的 Issue 与 PR

- 主控先检索现有 Issue/PR，并以 finding ID、复现、受影响验收及目标 SHA 登记到 Ledger。误报和环境阻塞保留审计记录，不发布“代码缺陷”Issue。
- 有效缺陷若跨模块、需要需求/接口决定、存在独立依赖，或预计跨日修复，创建新的修复 Issue，引用原已关闭 Issue 与证据；原票的关闭状态和历史结论如实保留。范围明确且能在本轮完成的局部修复，可直接以原 Issue 和审计 finding 为跟踪入口，避免重复票。
- 修复代码通过本地验证与独立复审后，若已有提交、推送和 GitHub PR 授权，创建修复 PR；仍待检查时保持 draft，完成所需审核与 CI 后转为可审核状态。PR 描述列原 Issue、修复 Issue（若有）、finding、验收证据、风险和目标代码 SHA。引用已关闭原票用 `Refs #<原票>`；新修复票同样默认用 `Refs #<新票>`；仅 [delivery-gates.md](delivery-gates.md) 明确批准的“合并即完成”交付契约和自动关闭授权可用 `Fixes`。
- 合并须满足 [delivery-gates.md](delivery-gates.md) 的目标新鲜度、写前最终树验证/审查及条件写保证、当前合并授权；PR 已开、获批或合并均不能代替目标 `main` 的最终验收。`agent:ready-for-review` 只在合并后的目标 SHA 经重验通过时添加。缺少相应 GitHub 写入授权时保留本地检查点、PR/Issue 草稿内容和 `integration_pending` 状态。

## 状态与完成条件

单票分别持久化验证、交付、标签和关闭字段，禁止用动作状态冒充验证结论：

| 字段 | 枚举及边界 |
| --- | --- |
| validation_state | queued / auditing / finding_confirmed / repairing / revalidating / verified / blocked / failed / unproven / intake_incomplete / aggregate_pending |
| delivery_state | none / repair_prepared（修复检查点已固定但尚未完成本地验证/审查）/ integration_pending（本地验证审查通过，等待进入约定目标或目标验收）/ delivered（已有目标交付回执；不单独表示当前 verified） |
| delivery_action | none / delivery_pending / applied_valid（只表示意图树已进入目标）/ stale / delivery_correction_pending / corrected |
| label_action | none / label_pending / applied_valid / stale / label_correction_pending / corrected |
| close_action | none / close_pending / applied_valid / stale / close_correction_pending / corrected |

另存 action_reason、delivery_intent/label_intent/close_intent，以及 delivery/label/close 当前回执引用。标签动作 pending 可在 validation_state=verified、delivery_state=delivered 时存在；不将其算作贴标完成。写后失配按 [交付门禁](delivery-gates.md)和 [协调格式](coordination-format.md)先记 stale 并使当前 verified 失效，后续 correction_pending 不得复活旧结论。每次报告各字段、未完成原因、下一步和恢复入口。

父票容量按“实际验收名额”计算：每个子票验收和父票独有/聚合验收各占一个名额，同一 C 限流；只读摄取不占行为验收名额；主控分页读取和关系核验属于选票前准备，不由此取得业务写权限。摄取改变持久需求/状态投影时用 scope_changed/state_changed、result=recorded 的无 slot 事件留证；选中后的实际验收及动作仍走 slot/Dispatch 契约。首次选择父级树时持久保存不可变 epoch manifest（epoch_id、完整 contains/需求指纹、目标仓库/ref/SHA/子模块、policy revision/manifest 引用、子票队列；精确字段以 [协调 schema](coordination-schema.json#/$defs/audit_epoch_manifest)为准），跨日均验该冻结目标，不在每次父聚合时改成最新 main。父票记 aggregate_pending，子票缺口可逐名额补齐；父聚合名额只核验该 epoch 已有同 SHA 子证据及父级独有/组合行为，发现需补跑子票则另排名额，不能藏在父票名额内。需求变化使受影响 epoch 证据失效，保存旧快照后修订队列；不覆盖旧结论。

全部子票和父聚合通过可报告“epoch 的 SHA 审计完成”。写入标签/关闭前仍须确认 epoch SHA 就是当前交付目标并满足 delivery-gates；目标已前移则各子票 validation_state 记 revalidating、父票 validation_state 记 aggregate_pending（单值字段不同时写两态），以 evidence_invalidated 回执保留旧 epoch 结论及失效原因，旧 epoch 仅作历史，不贴标、不关票。下一轮显式选择新 epoch 或等待有权批准的目标稳定窗口，不暗中把新 SHA 重验塞进本轮。持续变化导致当前目标无法通过时如实报告该阻塞；不得声称固定历史 SHA 的通过即当前 main verified。摄取超出预算保存游标，不能宣称全树已审。

每日 Run 的索引和逐票证据存 `.archive/runs/<run-key>/`；跨日共享 Ledger 使用[共享协调状态](coordination-state.md)规定的唯一持久路径和事务更新，登记 `Issue → 最近有效目标 SHA → Run/Worktree → 检查点 → 审核状态 → 标签/关闭/交付回执 → 等待条件/下次动作`。Orca 的 `new-per-run` 不自动带入 `.archive/`；跨工作区读取/转移时使用绝对路径并核对哈希。历史与 Ledger 不符先对账，不重新修同一缺陷。

## 公平调度与等待条件

- 三类枚举与循环顺序为 `recovery → new → revalidate → recovery`。recovery 包含可行动的中断修复、目标交付，以及所有未结算 label/close/delivery 意图的回读或纠正；这些动作对象独立加入候选集合，不以 N/R 当前标签和状态过滤；new 包含从未有有效结论的 N/R 对象（所有关闭原因）；revalidate 包含已存在但失效的验收。每票只进一类，优先归 recovery、否则按是否有旧结论区分。从共享 `next_class` 起寻找第一个非空可行动类别，逐名额原子记录 slot_selected，结算或启动后失败都追加 settled 并推进到下一类别；空类跳过，不消耗名额。首次 next_class=new。存在其他可行动类时连续恢复名额上限为一，故 A/A/B/B 恢复票不能垄断。类内按 last_slot 升序（从未选择的 null 最先），再按 eligible_since、规范 Issue 编号升序；选择即移到该类队尾，失败、恢复及改类均不清空最近服务序号。eligible_since 保留首次可行动年龄用于 SLA，不作为反复占优的唯一排序键。每个持续可行动类最多等待另外两次已结算名额，以该类连续未被选中的已结算名额数检查并报告违例；票级等待另外按 last_slot 轮转检查，不将票等待数用于类级两次上限。C 只改变每轮名额数，不改变逐 slot 轮转顺序。
- 同类有其他持续可行动票时，获得一次名额的票排到队尾，不连续占两个名额；仅剩本票可行动时无需等待。故同类持续可行动队列内每票最多等待其余票各一次选择；退避票恢复时沿用最近服务序号参与排序，不重置为 null 获得额外优先。C 按逐 slot 选择计上限，例如 C=2、同类 A/B 就绪时可依次选 A、B；无需把两个名额改成一批轮次。父子验收队列同样适用类别轮转，不能以 aggregate_pending 抢占全部名额。
- 等待票保存 `wait_reason / resume_condition / input_fingerprint / retry_after`；必要条件未变化时不占名额。字段规范及算法见 [协调格式](coordination-format.md)。可行动的 label_pending/label_correction_pending、close_pending/close_correction_pending，以及 delivery_action=delivery_pending/stale/delivery_correction_pending 或 delivery_state=integration_pending 的对象进入 recovery，只回读意图、核对当前需求/目标/CI/证据，按已有授权补标签、对账关闭或纠正；授权仍缺失或 API 退避未到期则等待。遇需求/目标失效转 revalidate，并保留纠正动作；首次 not_planned 先占 new 名额核实，只有之后等待明确决定时才退避。
- API/环境故障按 1、2、4 天退避，之后每 7 天；必要条件变化可提前唤醒。可行动时间 eligible_since 与 retry_after 分别保存；不能以反复退避抹掉年龄。无可行动票报告 idle 与等待清单。
- 监督仍在运行的 Worker 不等于新名额；活跃写入不能为公平强行抢锁。已选未结算 slot 先按标准事件和 Dispatch 对账，不能因换日重复占用。安全结算或证明边界互不冲突后换票，记录占用延迟和未轮转原因；未知拥有者按共享协议处理。

## 自动化任务提示词

```text
对 GitHub 1123786563/OpenBot 执行一次已关闭 Issue 每日审计与修复及全状态待人审标签对账。以本轮 Orca 回执中的 repoId、主机和实际 new-per-run 工作区为准，核对 Git 根目录；仓库登记路径仅用于定位，不返回主 checkout 写入。先读根 AGENTS.md、.agents/rules/closed-issue-daily-run.md 及引用规则，核对自动化、Run、Worktree、Git、共享协调根与跨日 Ledger。从自动化回执和共享 daily record 核对同一正整数容量 C（默认 1），每轮最多选择 C 个不同实际验收或 label/close/delivery 动作名额，父子验收跨日聚合；按 recovery/new/revalidate 公平轮转和退避规则选择；等待授权/环境且条件未变化的票不重复占位。审计 origin/main 的冻结 SHA，逐条实跑验收并保存证据；父票按冻结 epoch 跨日验同一 SHA、子票和聚合分别占名额；目标前移只保留历史，不以旧 epoch 结论给当前目标贴标。有效问题用 writing-plans、Orca 监督式派发、独立 Review 和 OCR 在隔离工作区闭环修复，不再启动第二套 SDD 派发器。仅在代码进入目标 main 且目标检查点重验通过，并有标签写入授权时添加 agent:ready-for-review；失效标签按授权纠正，无授权记 label_correction_pending。按 delivery-gates.md 保存写入意图并在写后完整 rescan，失配先记 stale 并使旧 verified 失效，再按现有授权纠正；保存回执，未授权提交/推送/合并/发布保持待处理。报告本轮 Issue、结论、证据、修复位置、等待条件及恢复入口。
```
