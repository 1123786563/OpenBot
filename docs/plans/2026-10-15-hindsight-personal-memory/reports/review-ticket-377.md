# 独立只读审阅 — Ticket #377 候选记忆审核与召回门槛

- **审阅对象**: `/Users/wuyongjun/orca/workspaces/OpenBot/hs01-candidate-review`，HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` + 6 个未提交改动文件（工作区态 sha256 与执行报告 §3 逐一比对，全部一致；无未跟踪文件，无新增 stash）。
- **执行报告**: `reports/ticket-377.md`（同目录）。
- **事实源（只读）**: `docs/specs/2026-10-15-hindsight-personal-memory-design.md`、`docs/adr/0005-self-hosted-hindsight-for-personal-memory.md`、`CONTEXT.md`、`issue-snapshots/issue-377.json`（实际位于本 plans 目录下）、`acceptance-mapping.md`。
- **审阅方式**: 纯只读（读文件 / git diff / grep）；验证命令仅在专用测试库 `127.0.0.1:5571/openbot_hs01_377_test` 上运行测试与 typecheck。未修改、未创建（本报告除外）、未删除任何仓库文件，未 git add/commit/stash。
- **审阅人独立验证结果**：
  - `bun test server/tests/memory-store.integration.test.ts` → **20 pass / 0 fail**（4 个新门槛测试全部通过）。
  - 全量 memory 回归（报告所列 9 文件）→ **88 pass / 0 fail, 301 expect() calls**，与执行报告 §2 完全一致，0 skip。
  - `cd server && bun run typecheck` → 0 错误。
  - RED 阶段输出无法在不改动工作区的前提下独立复现（需回滚实现），按报告 §7 记录采信；GREEN/回归/类型/校验和/文件清单均已独立复验。

---

## 结论一：Spec 合规（#377 三条验收标准）

### AC1 — 候选形成与审核操作范围 — **PASS**（含波次级备注）

- **自动形成先成为候选**：`formMemory` 显式落 `reviewState: "unreviewed"`（`server/src/memory/store.ts:434`）；集成测试断言 Bot 候选在 `list()` 中为 `unreviewed`。
- **导入先成为候选**：`completeSync` 插入不带 reviewState，依赖 schema 默认值 `unreviewed`（`server/src/db/schema/memory.ts:67`）；测试 "an imported fact waits…" 断言 `fact.reviewState === "unreviewed"` 后确认前不可召回。
- **显示内容、来源和观察时间**：formed 记录 provenance 含 sourceApp/link/observedAt；导入记录 provenance 为 `${source.title}: ${record.provenance}` 且带 observedAt；本人 HTTP 列表路由（`server/src/memory/routes.ts:46`，本票未改动）按认证 actor 返回 `store.list()` 全量行。
- **审核操作改变当前用户当前公司的记录**：`update`/`remove` 均带 `eq(personalMemories.ownerUserId, ownerUserId)`，跨用户不可改。
- **备注（非本票缺陷）**：`personal_memories` 尚无公司归属列，"当前公司"维度暂由 ownerUserId 承担。此为波次已知外部前置 #82（MT039），`acceptance-mapping.md` 已明确记录"已核验 main f0520524 未实施"；本票未引入也未恶化该缺口。

### AC2 — 未审核候选对所有召回路径不可见 — **PASS**

- **单一 seam 成立**：Bot 侧读取只有两条入口，全部收敛到 `eligibleRows`（`server/src/memory/store.ts:328` 新增 `reviewState IN ('confirmed','edited')`）：
  - 上下文注入：`PersonalMemoryMiddleware`（`server/src/copilot.ts:1443-1444`，对每个构建成功的 agent 统一挂载，网页/频道/定时共用同一装配）→ `contextFor`（`server/src/index.ts:1675`）→ `store.retrieve`。
  - 工具召回：`recall_personal_memory` 本地装配（`index.ts:1729`）、远程 AG-UI 回调（`index.ts:5331`）、定时/后台 proactive 允许清单（`server/src/proactive/restriction.ts:50-51`）→ `ingestion.recall` → `store.retrieve`。
- **SQL 降级路径**：`retrieve` 的三分支均经门槛——无 Intelligence 直接返回 `eligibleRows` 结果；Intelligence 不可用（`recall`/`list` 返回 null）回落本地行；Intelligence 排序结果再经第二次 `eligibleRows`（`intelligenceIds`）过滤。未审核候选因 `mirrorEligible`（`store.ts:55`，本就要求 confirmed/edited）永远不会进入 Intelligence，`intelligenceOnly` 只读回 Intelligence 独有记录（合成 confirmed，非候选）。
- **无旁路**：全仓 grep `personalMemories`，Bot 侧仅 `store.ts`（本 seam）与 `lifecycle-reset.ts`（仅计数/删除计划，非召回）；`routes.ts` 只用 `list/sources/update/remove`，不经 `retrieve`。
- **不能作为派生判断依据**：派生判断功能属 #388（当前不存在）；镜像门槛已排除未审核行进入 Intelligence，未来派生若走同一 recall seam 即天然受门槛约束（结构上成立）。
- **测试证据**：新测试覆盖本人路径与 formed-Bot 路径 `store.retrieve`、`ingestion.recall`、`contextFor`、middleware 端到端（装配方式与 `copilot.ts:1444` 一致）及 recall 工具，确认前不可见/确认后可见/拒绝后不再可见。跨入口（网页/频道/定时逐一 e2e）按 `acceptance-mapping.md` 分配给 #385 + #396 复验，本票以单 seam 结构论证成立。

### AC3 — "请记住"只确认明确表述；拒绝/删除不再召回 — **PASS**

- `create()` 经 `memoryInputSchema`（仅 content/provenance/enabled，`types.ts:4-9`）验证后逐字保存并直接 `confirmed`；集成 + runtime 测试锁定"恰好一条、逐字、无扩写、无效内容拒绝且不落库"。
- `remove()` 打墓碑（deletedAt + enabled=false + content=""）；召回门槛与 `formMemory` 基于 content-digest（含已删行）的去重共同阻止复活；测试覆盖 remove 后不再召回。

### 票面 Verification 条款

"沿用个人记忆存储集成测试与 Bot 运行测试，覆盖审核前后和 SQL 降级路径；专用测试库；跳过不算通过" — 独立复跑通过（20/20、88/88、0 skip、typecheck 0 错误）。SQL 降级路径由 `createMemoryStore(database)`（无 Intelligence）的门槛测试覆盖，Intelligence 路径由 `memory-intelligence.integration.test.ts`（"a Bot-formed memory reaches Intelligence only once the person confirms it" 等）覆盖。**满足**。

---

## 结论二：代码质量 Findings

无 critical / high。重点核查项结论先行：

- **召回门槛覆盖全部 Bot 侧路径**：✅ 成立（见 AC2 论证；SQL 降级、频道、定时共用同一 `eligibleRows` seam，无旁路读取）。
- **本人候选列表可见性保留**：✅ `list()` 无 reviewState 过滤，且新测试显式断言候选与已确认对本人均可见；`routes.ts` 未改动。
- **测试前提修改保持原验证意图**：✅ 逐个核对——禁用源、撤销授权、vendor 失败、健康源 resync、隔离测试、Bot 归属测试均在补"本人确认"前置后**保留原断言**（缺勤原因仍是源不可见/隔离/归属，而非门槛），"recall reaches this Bot's memories" 的 fixture 显式 `confirmed` 后原排序断言不变。
- **无越权文件**：✅ 仅 6 个改动文件，sha256 与报告一致，无未跟踪文件；`proactive-store.integration.test.ts` 属 ticket 所有权外但 coordinator 已在任务简报中授权，改动为最小 3 行前置修正。

| # | Severity | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| 1 | low | `server/src/memory/store.ts:328` vs `:55` | 审核门槛存在两份表示：`eligibleRows` 的 drizzle `inArray` 与 `mirrorEligible` 的原始 SQL 片段。当前值一致（已核对），但后续若一侧改值（如新增审核态）另一侧易漂移，导致"可镜像但不可召回"或反之。 | 后续波次将允许的 reviewState 集合提为单一常量，drizzle 与 sql 片段都从它插值；本票不必返工（有注释交叉引用）。 |
| 2 | low | `server/src/memory/tools.ts:107` | 工具描述说 "confirmed memories"，实际门槛是 `confirmed` OR `edited`（编辑即带修改的确认，语义正确）。措辞与谓词不完全对齐。 | 改为 "reviewed (confirmed or edited) memories"，纯文案。 |
| 3 | low（预存在，非本票引入） | `server/src/memory/store.ts:744` | 已确认（confirmed）的导入记录在上游内容变化时被原地更新且保持 `confirmed`——新内容不经再次审核即进入召回（仅 `edited`/已删行保留原内容）。这是本票之前就有的刻意行为（有"changed connector content updates the same row"测试），但与"导入内容变化应重归候选"的严格读法有张力。 | 归入 #378（候选过期/敏感再审）或后续票决策：上游 digest 变化且行为 `confirmed` 时是否降回 `unreviewed`。本票不阻断。 |
| 4 | low | 测试覆盖（`memory-store.integration.test.ts`） | 门槛测试证明共享 seam（retrieve/recall/contextFor/middleware/tool），但未逐入口（网页/频道/定时）端到端复验；结构论证成立（所有入口挂同一 middleware/工具装配），且 `acceptance-mapping.md` 已把跨入口复验分配给 #385 + #396。 | 确保 #385/#396 真实跑通频道与定时入口的召回断言，勿只依赖 seam 推导。 |
| 5 | info | 执行报告 §7 | RED 阶段（25 pass / 4 fail）无法在只读前提下独立复现（需回滚工作区），按报告记录采信；GREEN、回归、typecheck、校验和、文件清单均已独立复验一致。 | 无需行动；后续票可保留 RED 输出存档于报告（已做）。 |
| 6 | info | `server/tests/proactive-store.integration.test.ts:343-345` | 所有权外文件改动，coordinator 已授权；改动最小且保留 Bot 归属验证意图。 | 无需行动，已记录。 |

**总体评价**：实现以 4 行生产改动收紧单一 seam，配合 8 个新测试与 7 处前置修正，方向与 ADR 0005"现有本地召回会返回部分未审核记录，实施时必须收紧该行为"完全一致；`store.retrieve` 与 `mirrorEligible` 双门槛同构，注释质量高，无安全或越权问题。可进入提交流程（须由有提交授权的一方执行）。

— 审阅完成于只读工作区，未改动任何被审文件。
