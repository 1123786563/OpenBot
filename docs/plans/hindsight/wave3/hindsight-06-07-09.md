# Hindsight 06/07/09（#383/#384/#386）实施方案

工作区：`orca/workspaces/OpenBot/hbc5`（hbc5 worktree，基线 = main@HEAD + 未提交前置增量 #381/#382/#425/#405/#411/billing）。
父 Spec：#376；ADR：0005（分工）、0008（两层测试）。执行证据与逐票结论见
`reports/orca-dag-wave3-hindsight-06-07-09.md`（本 worktree；`.archive/` 运行目录按派发约束不改）。

## 事实源核验结论

- 正式 tracker = `1123786563/OpenBot`（上游 CopilotKit/OpenBot 撞号，勿读错）。
- 基线已含 #381 `server/src/hindsight/bank-scope.ts`（`resolveHindsightBankScope`、五类 bank 派生、
  断言 mint/verify）与 #382 `server/src/hindsight/preference-recall.ts`（通用偏好权威表 0168 +
  召回 seam）。三票均无等价实现：#382 模块注释明确留白 “the retry queue that drains such rows is
  #384”；无 source-bound 表、无时间有效性列。
- 团队成员资格现读 `enterprise_workspace_memberships`（status active/suspended）；#82 的个人权限面
  在 `server/src/enterprise/tenancy/personal-memory.ts`（只读消费，不改）。

## 票间依赖与公共决定

三票共用身份纪律：placement 一律经 `bank-scope.ts` 派生（服务端受信 scope / 持久后台任务两条
合法入口，Spec Implementation Decisions 原文），客户端可提交的只有内容与询问，无 bank、无文档 ID。
迁移接续 0169：0170（#383 表）、0171（#384 表 + #398 移交的 personal_memories 索引裁决）、
0172（#386 时间列）。

## #383 来源受限个人记忆的授权召回

- 新权威表 `source_bound_memories`（0170）：一行 = 本人确认的一条来源受限记忆。归属键
  (tenant, principal) 复合外键；`restriction ∈ {team, source, bot}` 与目标列
  workspace_id/source_id/agent_id 一一对应（行级 CHECK 恰好一个目标）；tombstone 语义沿用
  #382（deleted_at + enabled + content 清空）。稳定文档身份 `hsb_<hash16>`。
- 新授权登记表 `hindsight_memory_grants`（0170）：(tenant, principal, kind∈{source,bot}, target,
  enabled)——“来源停用”“Bot 失去应用权限”的真实状态源；团队授权现读 workspace 成员资格表。
- `bank-scope.ts` 增 `resolveScopedHindsightBankScope(scope, authorization)`：受信 scope + 当前
  授权快照 → 多 bank grant（team/source/bot 派生复用，不新增身份入口）。
- 新模块 `server/src/hindsight/scoped-recall.ts`：confirm（校验限制目标当前有权才可确认，retain
  进对应受限 bank，绝不进 user bank）与 recall（快照一：算 bank 集 → 逐 bank 召回取文档 ID →
  加载本人权威行 → **快照二（召回后再读授权，TOCTOU 档）** → 逐行复核 tombstone/审核/限制目标
  仍有权）。管理员 principal ≠ 本人 → 结构性空结果。
- 验证：`server/tests/hindsight-source-bound-recall.integration.test.ts`（真实库 + scripted 服务，
  团队 A/B、三种撤权、召回期内撤权、管理员、伪造 scope）+ 真实例合约
  `server/tests/hindsight-scoped-banks.contract.test.ts`（多 bank 断言的逐 bank 允许/越权拒绝）。

## #384 已确认个人记忆的幂等同步与重试

- 新表 `hindsight_sync_work`（0171）：(tenant, subject_type∈{preference, source_bound}, subject_id,
  principal_id, expected_digest, state∈{pending,done,superseded}, attempts, last_error)。部分唯一
  索引保证每主体至多一条 pending（重复任务在持久层折叠）。
- preference-recall 与 scoped-recall 的 confirm/edit/更正注入可选 `SyncWorkRecorder`（缺省不改变
  #382 行为），确认即持久落工作行。
- `server/src/hindsight/sync-queue.ts`：drain 逐条——重读权威行（归属/租户重核）→ 内容摘要 ≠
  expected_digest 判 superseded（旧编辑任务不得覆盖新内容）→ 未确认/已遗忘判 done（只有已确认
  且当前有权的内容被送往 Hindsight）→ source_bound 再核限制目标当前有权（无权则留 pending 不
  发送）→ 已同步摘要相等判 done（幂等，不重复远端写）→ retain（update_mode replace）成功落
  synced 摘要，失败 attempts++ 留 pending（恢复后再 drain 自动补同步）。
- 状态面 `syncStatus`：仅 `synced_content_digest = digest(content)` 且当前有权才报 indexed；
  pending/failed 永不标“已索引”。
- #398 移交裁决：0171 顺带给 `personal_memories (review_state, deleted_at, updated_at)` 索引
  （expireStaleCandidates 无 owner pin 全扫的修复），不改 store.ts 行为。
- 验证：`server/tests/hindsight-sync-queue.integration.test.ts`（注入远端失败、重复任务、乱序
  编辑、恢复补同步、状态真实性、重试归属重核）。

## #386 个人记忆生效时间与历史更正

- 0172 给 `generic_personal_preferences` 加 `effective_from`（NULL=起始不明）、`effective_until`
  （NULL=开放）、`superseded_by`、`superseded_time_unknown`、`corrected_at`；CHECK 保证窗口只在
  更正时闭合、未知时间更正必须带标记。tombstone（deleted_at/enabled/清内容）语义不动，遗忘
  仍然压倒历史。
- `correctGenericPreference`：显式更正 = 新确认行（新文档身份，指定生效时间或声明时间不明）+
  旧行保留原文与有效窗口（明确更正保留旧事实及有效时间）。生效时间早于旧事实起始 → 拒绝
  （矛盾输入不落库）。
- `recallGenericPreferences` 增可选 `asOf`：当前问题取未更正且已生效行（起始不明行带
  timeUncertain）；历史问题取窗口覆盖 T 的行（起始不明行不冒认历史；被不明时间更正闭合的行在
  歧义区带 timeUncertain 返回——表达不确定，不臆造日期）。未确认行本来就不参与（审核门）。
- 视图增 effectiveFrom/effectiveUntil/timeUncertain；基线 `hindsight-preference-recall.integration`
  的键集断言同步扩列（唯一一处基线测试改动，计入增量）。
- 验证：`server/tests/hindsight-temporal-correction.integration.test.ts`（例会周五→下周一改周一的
  当前/历史/时间不明三答 + 未确认变化不改答案 + 遗忘压倒历史 + 更正不触发旧行重同步）。

## 验证与产物

- 驱动层（bun）：三个新集成套件 + 基线 hindsight 套件回归；原生层（e2e）：新合约套件 + 基线
  两套件回归（真实实例 `deploy/hindsight/test/contract-instance.sh start/stop`）。
- 测试库：`postgres://postgres:postgres@127.0.0.1:5567/hbc5`（容器 orca-w3-hbc-pg，已建库并迁移
  至 0169；0170–0172 随实施追加）。
- manifest：三个 bun 套件登记入 `tests/config/e2e-bun-suites.json` “server/tests part 5”。
- 不 commit/push；GitHub 只读；不改 `.archive/`、`server/src/mastra/**`。
