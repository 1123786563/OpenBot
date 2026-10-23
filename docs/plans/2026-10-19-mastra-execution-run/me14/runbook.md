# ME14 Runbook — 单写切换、在途处置与兼容回滚（#486）

- Ticket: `docs/tickets/mastra-agent-execution/issues/me14.md`（7 条 AC）；Spec §9（迁移、版本与回滚）
- 机制代码：`server/src/mastra/cutover.ts`（fence 核心）、`server/src/mastra/legacy-import.ts`（staging→verified 状态机，ME13）
- CLI：`server/scripts/mastra-agent-cutover.ts <inspect|dry-run|apply|verify|rollback|cutover>`
- 演练证据：`server/tests/mastra-cutover-switch.test.ts`（fence 核心）、`server/tests/enterprise/mastra-cutover.integration.test.ts`（真 PG 双实例演练）
- 本文件是**生产维护命令与责任人/恢复门槛的可审查 runbook**。所有 apply/cutover/rollback 命令只在授权一次性 fixture 上执行；**生产执行（含停机）另行授权，本 runbook 的批准不构成该授权。**

## 0. 责任人与恢复门槛

| 角色 | 职责 | 本轮登记 |
| --- | --- | --- |
| 切换指挥（operator） | 宣布维护窗口、按 §3 顺序执行、对每道门的输出签字 | 生产执行前由部署方指派；演练期为本票实施者 |
| 目录/库管理员 | 提供 `MASTRA_CUTOVER_FIXTURE_APPLY` 环境钉扎与一次性 fixture 库 | 演练期 = 本地 `openbot-test-pg` 一次性库（me03-fixture 配方） |
| 回滚决策人 | 判读 §5 的 rollback 输出，维护态下决定"修复后重试"或"新 run 另起" | 生产执行前由部署方指派 |
| 独立 Review | 对 fence 变更与 runbook 做只读独立评审（与验证记录一并归档） | me14/report.md §2 |

恢复门槛（任何一条不满足即停，不得跳过以完成上线）：

1. staging 状态恰为 `verified`（`stagingStatusOf`，ME13 verify 全摘要匹配后的唯一 fence-eligible 状态）。
2. 运行入口清单（§2）八项齐全且每项有处置；旁路历史 reader 只读。
3. 目标 scope 的准入暂停已记录、活跃 run 已排空（零 queued/running）、每个暂停逐项处置。
4. 授权双门：`--authorize-fixture <id>` 与环境 `MASTRA_CUTOVER_FIXTURE_APPLY` 同值。
5. 回滚只走"兼容版本"；任何不可证安全的回退 → 维护态（§6），不删数据、不自动重放外部写。

## 1. 写入 fence 的事实（为什么切换是"单写者"）

- `enterprise_conversations.storage_backend` + `backend_version` 是**写者代际**：`ConversationService.append/appendEngineMessage` 的 prepare 事务按 (backend='mastra', backend_version=当前) 预留 seq（service.ts:614-618），write 事务开始时复核版本（service.ts:663-666），finalize UPDATE 以**子查询对照行的当前版本**收口（service.ts，ME14 强化）——旧代际 prepare 的 intent 在切换后既不能通过写入路径复核，也不能在 finalize 竞态窗口落地。
- 切换动作 = 逐线程在**同一条 per-conversation advisory lock**（`pg_advisory_xact_lock(hashtextextended(["conversation",tenant,thread],0))`，与 prepare/write 同锁）下对 `backend_version` 做条件 +1（CAS）：切换与所有写者全序化于数据库，不依赖时钟。
- 切换后旧写者的三类拒绝（integration 实证）：非 mastra 后端写 → `LEGACY_HISTORY_READ_ONLY`/backend 路由拒绝（既有机制）；旧代际 append → `CONVERSATION_BACKEND_CHANGED`（intent 留 pending、零覆盖）；过期 lease 的 run → runs lease 谓词拒绝（`hasActiveAttemptLease`，lease 过期即 false）。客户端不能选引擎：selector 是服务端 seam（copilot.ts `setBuiltinExecutionEngine`），线材字段不可达（ME02/ME07 既有证据）。
- fence 记录（run state 内 `fence` 字段）逐线程记录 `fromBackend/fromBackendVersion/toBackendVersion`、引擎名 `mastra` 与 `engineVersion = mastraEngineFingerprint()`（pinned 包组合摘要，ME01 锁定集）、`compatibleRollbackVersion`、`excludedThreadIds`；rollback/维护事实追加进同一记录，从不改写历史条目。

## 2. 运行入口清单（AC1；cutover 必须核对全部八项）

`--entry-inventory <path>` JSON：`{"entries":[{"id","disposition","note"}...]}`。disposition ∈ `governed`（已选上受控 mastra 执行）| `legacy-kept`（保留旧路，**必须给 note** 说明理由）| `reader-only`（只读旁路）。

| id | 来源票 | 演练登记 | 生产切换前核对 |
| --- | --- | --- | --- |
| `chat-entry` | ME02 | governed（selector + governedModel，未默认翻转） | 确认 selector 策略与本 runbook 一致 |
| `routine-firing` | ME09 | governed | schedule-entrypoint 目录重签路径 |
| `message-delivery` | ME10 | governed | 投递 runner selector |
| `wake-up` | ME10 | governed | 唤醒 runner selector |
| `approval-continuation` | ME10 | governed | 六门续跑编排（engine mark 判定） |
| `openmuse-task` | ME12 | governed | `openMuseTaskRunner.runTurn` selector |
| `handoff-delivery` | ME11 | governed | 交接 runner selector（reaper 无 selector，purge 不跑 turn） |
| `legacy-history-reader` | ME13 | **reader-only**（import 源 seam 仅两个读方法；只读 adapter 类型层无写面） | 确认无第二写路径接入旧库 |

**登记的决策点（非本票可决，遗留可见）**：

- **groupConversations 不迁移（ME12 R1，结构性阻塞）**：group bot 线程（`group_bot_threads.threadId`）无 `enterprise_conversations` 行亦无 mapping 行，`resolveForThread`/`conversations.append` 必拒；受控 turn 无法对 group 线程签作用域/写消息。迁移前置 = "group bot 线程登记为企业会话/资源"的 **tenancy 产品决策**（ME14/ME16 归口）。生产切换 runbook 须先对该决策登记处置（维持 legacy-kept 并注明，或完成登记后再切），切换门不核对不存在的 scope。
- PersonalMemoryMiddleware 已按 ME07 F1 跳过 mastra-selected 构建（ME14 交付），legacy 构建保持原样。
- conformance-evidence 指纹（Bifrost 22.3/22.4）：本树全 14 条 stale，**在纯 origin/main 上同样 stale**（绑定模块随 a789f6a43 计费交付变更）——主侧存量红，重录指纹等于宣称对已变更计费代码重跑了 22.3/22.4 验证命令，属产品/验证决策，本票不代办。

## 3. 切换顺序（维护窗口内）

```bash
# 0) 前置：import 已 apply+verify（ME13），run state 为 verified。
#    双门环境：export MASTRA_CUTOVER_FIXTURE_APPLY=<fixture-id>

# 1) 盘点（只读）：入口/归属/隔离清单
bun server/scripts/mastra-agent-cutover.ts inspect --run-id <run> --state-dir <dir> \
  --user <actor> --agent <agentId> [--thread <threadId>]
bun server/scripts/mastra-agent-cutover.ts dry-run   ...   # 全量规划 + 摘要，零写入

# 2) 导入 + 验证（授权 fixture 上）
bun server/scripts/mastra-agent-cutover.ts apply  --run-id <run> --state-dir <dir> --user <u> --agent <a> \
  --authorize-fixture <id>
bun server/scripts/mastra-agent-cutover.ts verify --run-id <run> --state-dir <dir> --user <u> --agent <a>
#    verify mismatch → phase=blocked，禁止切换；先修复再重跑 verify。

# 3) 准备两份操作输入文件
#    entry-inventory（§2 八项齐全；legacy-kept 必须带 note；reader 项只能 reader-only）
#    dispositions（§4：每个非终态 run 一条处置；终态/已排空项可记 legacy-drain 收档）

# 4) 切换（授权 fixture；可重入：中断后重跑，只补未切线程，不重复 bump）
bun server/scripts/mastra-agent-cutover.ts cutover --run-id <run> --state-dir <dir> \
  --tenant <tenantId> --workspace <workspaceId> \
  --entry-inventory <path> --dispositions <path> \
  --compatible-rollback-version <appVersion> \
  --pause-admission --authorize-fixture <id>
#    退出码 1 + CUTOVER_GATES_FAILED  → 门缺项，未触任何线程（缺项不得 apply）
#    退出码 1 + CUTOVER_SWITCH_BLOCKED → 逐线程切换中止于首个阻塞点（已完成线程如实记录，修复后重跑续切）
#    phase=switched                    → fence 记录落定，单写者成立
```

## 4. 在途处置账本（AC2）

切换时 fence 对 scope 内每个非终态 run 枚举（`enterprise_runs` 活跃状态 + 续租事实 + mastra continuation 存在性），要求逐项处置；**缺一项即 CUTOVER_GATES_FAILED 并列名**：

| 处置 | 适用 | 语义 |
| --- | --- | --- |
| （无处置，active） | queued / running | **不可处置**：停止准入后排空，apply 列名拒绝（`drain_required`） |
| `convert-pause`（须 `effect: none|receipted`） | waiting_approval / suspended **且**存在 mastra continuation | 兼容暂停 → ME05 continuation 跨进程转换；`effect: unknown` 拒绝（必须改 isolate） |
| `legacy-drain` | 旧引擎停的暂停 | 旧路排空：处置时仍活着 → `not_drained` 拒绝；排空完成后再跑 apply 即收档为只读记录 |
| `isolate` | 不可转换/未知效果 | 明确隔离：该线程**按 id 移出本次切换集**（fence `excludedThreadIds`），记录在案 |
| `re-initiate` | 不可转换但可重发起 | 记录决策：线程移出切换集，切换后由运营重新发起 |

已终结记录 → 只读（无需处置，历史保留）；跨进程转换演练 = integration 套件：切换前实例 B 保存 continuation，切换后实例 A/B 两套独立连接池完成 CAS claim → finish（`AC2: the compatible pause converts across instances after the switch`）。

## 5. 回滚（AC5）

```bash
bun server/scripts/mastra-agent-cutover.ts rollback --run-id <run> --state-dir <dir> \
  --authorize-fixture <id>   # switched 状态回滚需双门；staging 状态回滚沿用 ME13 语义
# 理由经环境变量：MASTRA_CUTOVER_ROLLBACK_REASON="engine regression after switch"
```

- **保留一切新数据**：rollback 全程零 DELETE/UPDATE 目标行；切换后新消息（finalized intents）、快照（continuation 行）、receipt 全部保留，切换前后逐项计数对账（preserved 计数写入 receipt，不等则转维护态）。
- **仅回退兼容版本**：fence 记录 `compatibleRollbackVersion`（切换时由 `--compatible-rollback-version` 登记的、仍能理解 mastra 行与隔离合同的应用版本）。回滚**不指回旧库**——backend 保持 mastra，回滚是"写者代际再 +1"（同一 advisory-lock CAS），旧代际写者在回滚后同样被版本 fence 拒绝。
- **维护态（AC6）**：scope 内仍有活跃 run、未登记兼容版本、行版本漂移、回滚后清单变化 —— 任一即 `phase=maintenance` + `fence.maintenance.reason`（可诊断原因名列出阻塞 run/漂移详情），退出码 1。维护态是工具终态：不删新数据、不自动重放外部写；修复后由回滚决策人决定重试或新 run 另起（fence 拒绝从 maintenance 直接再 rollback）。

## 6. 演练与验收证据（全部授权 fixture，零生产执行）

- 单元（fence 核心、门、账本、回滚/维护、F1/F2/F3 携带项）：`bun test server/tests/mastra-cutover-switch.test.ts`
- 真库双实例演练（票面指定四案例：双实例混合 fixture、旧写者拒绝、apply 中断、新消息后 rollback；另含 F1 真库、finalize fence SQL 探针、过期 lease、跨实例转换、维护态、wake-up settle jsonb 修复针）：`ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test bun test server/tests/enterprise/mastra-cutover.integration.test.ts`
- 计数与本轮真实命令输出见 `me14/report.md` §1。

## 7. 边界

本 runbook 与随票代码不执行任何生产 apply/切换/停机/发布；不重写其他系统的历史归属迁移；生产执行需按仓库授权规则另行申请并记录。
