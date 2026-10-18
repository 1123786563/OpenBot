# Ticket #378 — [Hindsight 02] 敏感候选与过期清理 · 独立只读审阅

- **审阅人**: 独立只读 Review Agent（Orca 分派，task_d7e8a42481fa）
- **审阅对象**: `/Users/wuyongjun/orca/workspaces/OpenBot/hs01-candidate-review` 工作区（HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` + #377 已审集成 diff + 本票 7 文件，全部未提交）；被审报告 `reports/ticket-378.md`
- **事实源**: `docs/specs/2026-10-15-hindsight-personal-memory-design.md`、`docs/adr/0005-self-hosted-hindsight-for-personal-memory.md`、`docs/superpowers/plans/2026-10-15-hindsight-personal-memory.md`、`docs/plans/.../../archive/issue-snapshots/issue-378.json`（均为只读）
- **纪律**: 只读，未修改被审仓库任何文件，未 commit / push
- **结论**: **Spec 合规 PASS · 代码质量 PASS**，findings 0 critical / 0 high / 1 medium / 3 low / 5 info。medium 一项建议 spec-owner 裁定，不阻塞本票验收。

## 1. 两维度结论

### 维度 A — Spec 合规（逐条验收）：PASS

| 验收标准（issue-378 快照） | 判定 | 证据 |
| --- | --- | --- |
| 密码、令牌及同类凭据即使被明确要求记住也被拒收，不能写入候选、索引或日志载荷 | **PASS** | `store.create()` 分类 `credential` → insert 前抛 `MemoryRefusedError`（store.ts:376–382）；`update()` patch.content 为 credential 两分支（本地行 / Intelligence-only）均拒绝（store.ts:499–505）；`formMemory()` 非 normal 一律拒绝、且在 dedup 查询/插入**之前**（store.ts:415–424），重发同样拒绝；`ingestion.sync()` 在 `normalizeConnectorRecords` 后过滤非 normal（ingestion.ts:278–283），`completeSync()` 循环内再跳过非 normal（store.ts:788–790）构成双层防御。拒收文案 `CREDENTIAL_REFUSAL`/`SENSITIVE_OBSERVATION_REFUSAL` 为常量，不含内容，故日志载荷无凭据。全仓 `insert(personalMemories)` 仅 store.ts 4 处（create/formMemory/completeSync/expiry 不插行），全部在门内；测试第 2/4/5/6 块覆盖 |
| 医疗、财务和客户资料仅在本人明确要求时提出候选，并展示具体内容与来源供额外一次确认；普通自动学习不提出这些敏感候选 | **PASS（带 medium 一项，见 F-M1）** | `create()` 敏感类目落 `unreviewed` 候选（store.ts:387），本人 `list()` 可见内容（list 无 reviewState 过滤，候选行含 provenance），`retrieve()` 经 `eligibleRows` 的 `inArray(reviewState,['confirmed','edited'])` 门槛不可见，确认一次后可见；`formMemory()` 对 medical/financial/customer-data 一律拒绝、不产生候选；导入路径同样丢弃。测试第 3/4/6 块逐项断言。**保留项**: 本人经 `update()` 把既有记忆内容**编辑**成敏感内容时直接置 `edited`（可召回），未经 create() 同样的额外确认——详见 F-M1 |
| 未处理候选满 30 天清除，已确认个人记忆不因候选过期任务被误删 | **PASS** | `expireStaleCandidates()`（store.ts:589–611）：单条 `UPDATE … WHERE reviewState='unreviewed' AND deletedAt IS NULL AND updatedAt < now-30d`，tombstone 与 `remove()` 同构（deletedAt/enabled=false/content=''）；`confirmed`/`edited` 无论多旧不匹配；已删除行不再匹配 → 幂等；测试第 1 块四象限 + 字段级断言、第 2 块重复运行返回 0（含时间推进后第三次）、第 3 块过期候选离开本人列表且同内容 formMemory 返回 `{duplicate:true,forgotten:true}` 不复活。周期注册在 `memorySweep`（index.ts:1702–1718）独立 try/catch，不混入 `syncDue`，失败照常排下一次 |
| 敏感分类保守失败，不把来源文本当作用户授权 | **PASS** | `classifyMemorySensitivity()`：只认显式触发词/形状；非字符串/空串回 `normal`（sensitivity.ts:101–103）；正则匹配包 try/catch、异常回 `normal`；类目按 credential→medical→financial→customer-data 顺序首个显式命中生效。`formMemory()` 与 sync 导入对敏感类目一律拒绝/丢弃，**不因内容来自本人已授权的连接应用而放行**。测试第 1 块含空串与 `undefined` 失败安全断言 |
| 复用 #377 的审核状态与召回门槛，不新增旁路确认入口 | **PASS** | 敏感候选的额外确认即 `update({reviewState:"confirmed"})`，走既有 `PATCH /api/memory/:id`（routes.ts:105–113，本票未改 routes），无新 API、新状态、新路由；#377 的 `eligibleRows` reviewState 门槛与 `mirrorEligible` 未被本票改动（4 个 #377 文件 sha256 与 `ticket-377.md` 逐字节一致，store.ts 的 `inArray` hunk 属 #377 报告内容） |

### 维度 B — 代码质量：PASS

- 写入路径覆盖完整：全仓 `personalMemories` 插入点仅 4 处且全部经敏感门控；`completeSync` 无第二调用方，`formMemory` 的两个调用方（tools.ts、proactive/engine.ts）均经 store 层门控，无绕行。
- `expireStaleCandidates` 为单条原子 `UPDATE … RETURNING`，无 check-then-act 竞态；并发 sweep 由 `deletedAt IS NULL` 谓词天然互斥，60s 调度安全。
- 双层防御（ingestion 过滤 + completeSync 内层跳过）有纵深价值：注释明确了"即使未来出现绕过 ingestion 的第二个调用方"的意图。
- 注释解释"为什么"而非"做什么"（宁误拒的取舍、幂等原理、门槛复用理由），与实现一致。
- 测试断言到位：过期测试做字段级断言（deletedAt 值、enabled、content=''、reviewState 保持），非只查返回值；tombstone 不复活在 formMemory dedup 路径上验证。
- `bunx tsc --noEmit` exit 0；新 3 文件 `bunx biome check` 0 问题。

## 2. Findings

### F-M1 · MEDIUM · `update()` 编辑路径对敏感类目不设额外确认，与 `create()` 不变量不一致

`update()` 只拦 `credential`（store.ts:499–505）；本人把既有 confirmed 记忆的内容编辑成 medical/financial/customer-data 时，`patch.content` 非空 → `reviewState` 直接置 `edited`（store.ts:534–539），即刻满足召回与镜像门槛，未经 create() 同路径的"unreviewed + 再确认一次"。效果上，敏感内容可经"编辑"单步进入 Bot 可召回状态，而 create() 需两步。

- **为何不是 high**: 操作者是数据本人、内容为其亲手键入且编辑界面回显全文；#377 已确立"本人编辑即 `edited`=已审核"的语义；ADR 0005 的敏感条款针对的威胁模型（自动学习/导入不当提出、凭据留存）在此路径不成立；三张验收测试与报告 §4 均未声称覆盖此路径，无虚假声明。
- **为何仍要报**: ADR 0005 写明"医疗、财务和客户资料**即使由本人明确要求记住**，也须再展示将保存的内容与来源并完成一次明确审核"，严格读该不变量在 update 路径存在缺口，属领域模型裁决问题而非实现缺陷。
- **建议**: 交 spec-owner 裁定：(a) 接受"本人编辑即审核"（在 CONTEXT/ADR 记录该边界），或 (b) 后续票将 update 内容编辑的敏感类目也落 `unreviewed`。若采 (b) 需注意 expiry 与 edited 语义的交互。

### F-L1 · LOW · 凭据模式存在覆盖缺口

未命中常见凭据表述：单独 `pwd`/`pass code`、单独 `secret(s)`、`ssh key`、`.pem`/`.env`/kubeconfig 等文件引用、数据库 connection string。本人明确要求"记住我的 ssh key XXX"时会被直接 `confirmed` 保存。与分类器"不确定回 normal"哲学一致（凭据类之外的缺口属保守方向的代价），但凭据是唯一"宁误拒"类目，建议补充高频形状（pwd、ssh key、connection string 前缀）。

### F-L2 · LOW · `bearer\s+…` 模式误伤协议描述文本

`/\bbearer\s+[a-z0-9._~+/=-]{12,}\b/i` 把 "Bearer authentication is used by the API"（`authentication` 14 个字母）判为 credential 而拒收。属凭据类刻意过匹配的延伸，但该形状更多是技术描述而非凭据本体，误拒摩擦偏高；可要求 token 形状（含数字/符号混合）或排除常见尾随词。

### F-L3 · LOW · sync 丢弃敏感记录完全静默

ingestion 过滤丢弃的记录无计数、无日志、无 person 可见提示（`syncStatus` 仍 succeeded，`imported` 只是变小）。报告 §1.3 声明这是有意的（"计数即实际保留"），但当来源批量含敏感内容或分类器系统性漏报时，本人与运维均无感知信号。建议后续加一条 drop 计数日志（不含内容）即可，行为无需改。

### F-I1 · INFO · `patch.reviewState` 允许任意流转（含 `unreviewed → edited` 直接确认）

同一既有入口、单次显式动作，确认效力等同 `confirmed`；`confirmed → unreviewed` 是收紧而非放权。与 #377 门槛一致，无新增旁路入口，仅记录语义供后续票引用。

### F-I2 · INFO · 计划偏差已按 coordinator 裁定执行并有记录

计划 Step 3 的 `sensitivity` 标记 + `requiresExtraReview` 列改为无 schema 列方案（`requiresExtraReview` 由 `reviewState='unreviewed'` 本身表达）；报告 §1"与计划的偏差"已记录，与票面 handoff"复用 #01 审核状态、不新增旁路"一致，且避免触碰本票 ownership 之外的 `db/schema/memory.ts`。

### F-I3 · INFO · 导入路径 tombstone 同样不复活

`completeSync` 的 `onConflictDoUpdate` CASE 分支对 `deletedAt IS NOT NULL` 的行保留旧 content（''），被过期的导入候选不会因上游重发而复活（测试覆盖的是 formMemory 路径，导入路径由该 CASE 保证，未单测）。

### F-I4 · INFO · 检查点完整性核验通过

工作区改动恰为报告 §3 所列 11 文件（8 M + 3 untracked），无多余文件；11 个 sha256 全部与本报告 §3 表逐字节一致；前 4 个 #377 文件与 `ticket-377.md` 一致，本票确未触碰 #377 交付行（tools.ts 变化属本票授权范围，#377 报告文末亦已预告其 sha 作废）。

### F-I5 · INFO · RED 证据为报告记载 + 结构佐证

审阅纪律为只读、不回滚验证 RED。报告记载的 RED 失败形态（`Cannot find module '../src/memory/sensitivity'`、`expireStaleCandidates is not a function`）与测试文件引用的符号仅存在于本票 diff 中的结构一致，采信为合理 TDD 证据。

## 3. 审阅人亲自复跑证据（2026-10-15，本 worktree）

```
$ cd server && TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test' \
  bun test ./tests/memory-sensitivity.test.ts ./tests/memory-expiry.test.ts
→ 9 pass, 0 fail, 68 expect() calls, Ran 9 tests across 2 files   [与报告 §2 GREEN 一致]

$ 同库 bun test（报告 §2 全套 12 文件）
→ 102 pass, 0 fail, 382 expect() calls, Ran 102 tests across 12 files   [与报告 §2 一致]

$ bunx tsc --noEmit        → exit 0
$ bunx biome check src/memory/sensitivity.ts tests/memory-sensitivity.test.ts tests/memory-expiry.test.ts
→ Checked 3 files. No fixes applied.（0 问题）
```

测试容器 `openbot-hs01-378-pg`（127.0.0.1:5573）运行中，与报告 §2 所述一致。

## 4. 最终判定

- **Spec 合规: PASS** —— 5 条验收全部有实现与测试支撑；F-M1 为 ADR 严格读下的边界缺口，建议 spec-owner 裁定，不推翻本票验收。
- **代码质量: PASS** —— 门控完整、双层防御、原子幂等、注释与实现一致；无 critical/high。
- 检查点（HEAD f0520524 + 未提交 11 文件）与报告 §3 逐字节一致，可进入集成/提交流程。
