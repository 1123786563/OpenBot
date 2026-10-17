# Hindsight 个人记忆 Wave 1 · 最终交付范围独立审阅（#377 + #378 + #380，全部含 fix1）

- **审阅人**：最终交付审阅 Agent（Orca 分派，task_cddd3145312c / ctx_13a22686d0a0）
- **实际使用的模型/档位（如实记录）**：pi harness，`PI_MODEL=hiroute-auto-2`（HiRoute auto 路由），`PI_REASONING_LEVEL=off`，`PI_PROVIDER=hiroute-main-*`（env 自报；会话 01a140fc）。审阅以该配置下可用的最强推理执行；环境未提供更高推理档的显式开关，此处如实记录而非宣称特定档位。
- **审阅对象**：`/Users/wuyongjun/trea/OpenBot-hindsight-exec`，HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` + 全部未提交改动（实际：**9 个 tracked 修改文件** + 未跟踪交付物；任务简报所记"12 个 M"与实况差异见 F-I8）。纪律：只读，未 commit/push，未修改任何被审文件。
- **事实源**：`docs/specs/2026-10-15-hindsight-personal-memory-design.md`、`docs/adr/0005-self-hosted-hindsight-for-personal-memory.md`、`docs/superpowers/plans/2026-10-15-hindsight-personal-memory.md`、`docs/plans/2026-10-15-hindsight-personal-memory/{acceptance-mapping.md, dag.json, ledger.md, issue-snapshots/}`、`reports/ticket-{377,378,380}*.md` 全部 9 份报告。

## 结论速览

| 维度 | 判定 |
| --- | --- |
| 检查点完整性（sha256 全表） | **PASS**（20 个交付文件与三票 fix1 后报告值逐字节一致） |
| #377 候选审核与召回门槛 | **PASS**（单一 seam 完整，本人列表可见性分离成立） |
| #378 敏感候选与过期清理 | **PASS**（五写入路径门控 + create/update 对称；幂等不复活不误删） |
| #380 自托管服务与隐私配置 | **PASS**（隐私底线运行态实证；config.ts 校验闭环） |
| 三票交互 / 安全边界 / 无越前实现 | **PASS** |
| 测试与验收声明真实性 | **PASS**（全部亲自复跑复现） |
| Findings | **0 critical / 0 high / 0 medium / 4 low / 6 info**（均有归属，无阻塞） |
| **总体判定** | **PASS —— 可进入提交流程（须由有提交授权方执行）** |

---

## 1. 检查点完整性核验（sha256 全表重算）

对执行工作区全部交付文件逐一重算 sha256，与三票报告（含 fix1 附录）对照：

- **#377/#378（11 个 server 文件）**：`store.ts 809ebf7c…`、`ingestion.ts 0d13d16a…`、`tools.ts 93fa491b…`、`sensitivity.ts 1e779ffc…`、`index.ts ceb5e581…`、`memory-sensitivity.test.ts 717b190d…`、`memory-expiry.test.ts f1fc63c9…`、`memory-store.integration.test.ts 9a369e8e…`、`memory-runtime.test.ts eb4b78f4…`、`memory-defaults.integration.test.ts dd2d21c4…`、`proactive-store.integration.test.ts 4d17689b…` —— 与 `ticket-378.md` fix1 附录表**逐字节一致**。
- **#380（9 个可入库交付文件）**：`config.ts d10aa347…`、`health.ts 4ca854ce…`、`hindsight-config.test.ts 52700e33…`、`hindsight-health.test.ts a84921aa…`、`docker-compose.yml 20e53cbf…`、`hindsight.env.example d109e9f7…`（fix1 后）、`README.md 62ede825…`（fix1 后）、`backup.sh 99564e0d…`（fix1 后）、`.gitignore ad5f630d…`、`test/gateway-standin.mjs 9fd4baed…`、`test/verify-health.ts dff17709…` —— 与 `ticket-380.md` fix1 附录**逐字节一致**。
- **隔离卫生**：git-ignored 实值（`hindsight.env`、`backups/`）**未进入**执行工作区（`deploy/hindsight/` 仅 7 个可入库文件）；`git status` 无多余文件；`git diff HEAD` 仅 9 个 tracked 文件。

## 2. 重点核验（任务指定 7 项）

### 2.1 候选审核门槛单 seam（eligibleRows）与本人列表可见性分离 —— PASS

- `store.retrieve`（store.ts:842）是唯一行级查询；其唯一行源是 `eligibleRows`（store.ts:318–369），where 含 `ownerUserId AND enabled AND deletedAt IS NULL AND reviewState IN ('confirmed','edited')` + formedBy/来源可见性。
- Bot 侧仅两条链路，全部收敛于该 seam：① 注入：`PersonalMemoryMiddleware`（copilot.ts:1444，对每个构建成功的 agent 统一挂载，网页/频道/定时共用装配）→ `contextFor`（ingestion.ts:384）→ `retrieve`；② 工具：`recall_personal_memory`（本地装配 index.ts:1744、远程回调 index.ts:5346、proactive 允许清单 restriction.ts:50–51）→ `ingestion.recall`（ingestion.ts:376）→ `retrieve`。
- Intelligence 排序路径二次过滤：`retrieve` 对 `intelligence.recall` 命中再跑一次 `eligibleRows({intelligenceIds})`（同一门槛）；SQL 降级（无 Intelligence）即 `eligibleRows` 本身。`mirrorEligible`（store.ts:55）保证未审核行永不进入 Intelligence。
- **分离成立**：本人列表 `list()`（store.ts:359–375）无 reviewState 过滤，候选对本人可见；`routes.ts` 仅有 list/create/update/remove/sources，**无任何 recall/retrieve 暴露**。全仓 grep `personalMemories`：Bot 侧读取只在 store.ts 本 seam；`lifecycle-reset.ts` 仅计数/删除。全仓 `insert(personalMemories)` 仅 create/formMemory/completeSync 三处（expiry 只 UPDATE），全部门控在内。

### 2.2 敏感内容五写入路径覆盖与 create/update 对称性 —— PASS

| 写入路径 | 门控 | 位置 |
| --- | --- | --- |
| `create()`（"请记住"） | credential → `MemoryRefusedError` 拒收（insert 前，无痕）；medical/financial/customer-data → `unreviewed` 候选（二次确认复用 #377 门槛）；normal → 直接 `confirmed` 逐字保存 | store.ts:377–393 |
| `formMemory()`（Bot 观察，含 proactive engine 唯一调用方 engine.ts:207） | 非 normal 一律拒收，且在 dedup/insert 之前 | store.ts:415–424 |
| `update()`（本地行 + Intelligence-only 行） | credential 两分支均拒（检查在分支之前）；本地行内容编辑为敏感类目 → 回落 `unreviewed`（fix1 F-M1），普通编辑仍 `edited` | store.ts:499–548 |
| `ingestion.sync()`（连接器导入） | 非 normal 整体丢弃 + `droppedSensitive` 计数日志（仅条数+sourceId，无内容）；`imported` = 实际保留数 | ingestion.ts:279–298 |
| `completeSync()`（store 层纵深） | 循环内再跳过非 normal，防未来绕过 ingestion 的第二调用方 | store.ts:799–801 |

- **对称性**：credential 在 create/update/formMemory 三路径同样拒收；敏感类目 create 与 update 语义一致（都须本人再确认一次才可召回）。Intelligence-only 行为无 reviewState、敏感编辑不回落——与 #377"Intelligence 行不过审核门槛"语义一致，fix1 复审已裁决在范围外（F-I6）。
- 拒收文案为常量（不含内容），日志载荷无凭据；schema `strict()`（types.ts）使 create 无法注入 `reviewState`/来源字段。

### 2.3 expireStaleCandidates 幂等 / 不复活 / 不误删 —— PASS

- 单条原子 `UPDATE … WHERE reviewState='unreviewed' AND deletedAt IS NULL AND updatedAt < now-30d RETURNING id`（store.ts:597–626）：无 check-then-act 竞态；并发 sweep 由 `deletedAt IS NULL` 谓词互斥。
- **不误删**：`confirmed`/`edited` 无论多旧不匹配（测试四象限 + 字段级断言亲跑通过）；**幂等**：过期行带 `deletedAt` 不再匹配，重复运行返回 0；**不复活**：tombstone 与 `remove()` 同构（deletedAt/enabled=false/content=''），formMemory dedup 返回 `{duplicate:true, forgotten:true}`（测试覆盖），导入路径由 completeSync 的 CASE 分支保 tombstone（F-I3，结构保证）。
- 未审核候选从不镜像（mirrorEligible），故过期无需 Intelligence 回收；接入 `memorySweep`（index.ts:1705–1715，60s，独立 try/catch，失败照常排下一次），不混入 `syncDue`。

### 2.4 Hindsight 部署隐私底线与 OpenBot 侧 config.ts 校验闭环 —— PASS（本审阅亲自复测）

- **版本 pin**：`ghcr.io/vectorize-io/hindsight:1.0.0`，digest `sha256:a88678c0…e4c` 实测与 README/compose 一致；无 `latest`。
- **暴露面**：`docker port openbot-hindsight` 仅 `127.0.0.1:8888`；9999 无发布项。无 key `POST /v1/default/banks/default/health/llm` → **401**（本审阅实测）；`/health/live` 无鉴权 200（仅状态）。
- **单网关出口**：容器运行 env 实测 LLM 与 embeddings base URL 均为唯一端点 `http://host.docker.internal:9100/v1`；`HINDSIGHT_API_LLM_TRACE_ENABLED=false`、`OPERATION_RETENTION_DAYS=1`、`CLEANUP_INTERVAL_SECONDS=900`、ApiKeyTenantExtension 生效。`GET /version`（带 key）实测 `api_version 1.0.0`、`features.llm_trace=false`、`bank_llm_health=true`、`audit_log=false`。
- **备份 ≤30 天**：`backup.sh` guard（非数字/>30 exit 1）+ fix1 后 `-mtime +$((RETENTION_DAYS-1))` 语义与 `hindsight.env.example` 声明值 30、`config.ts MAX_BACKUP_RETENTION_DAYS=30` 三角一致；边界（精确 30.0 天删除）有 fix1 附录 + fix1 复审独立复测双记录。
- **config.ts 闭环**：缺隐私声明/malformed → null → noncompliant（非"默认没问题"）；trace≠false、载荷>1 天、备份>30 天逐项报违规**规则名不报值**；URL 强制 bare origin（无凭据/无路径）。`loadHindsightConfig` 抛错带变量名，fail loud。
- **三态健康**：本审阅以真实容器亲跑 `verify-health.ts happy` → `{"state":"service_up","version":"1.0.0"}` exit 0（经 9100 standin 真实 provider 探测）；`config_noncompliant`/`service_down`/`gateway_down` 由单测 + #380/#复审双轮运行态记录覆盖。

### 2.5 三票间交互 —— PASS

- **#378 过期 × #377 门槛**：过期候选 tombstone 后同时被 `list()`（deletedAt IS NULL）与 `eligibleRows`（deletedAt + reviewState）排除；fix1 F-M1 使敏感编辑回落的行重新落入 30 天候选窗口——与"未处理候选满 30 天清除"语义一致，两机制共享 reviewState 单一事实。
- **#380 × memory 模块零耦合**：grep 证实 `src/memory/**` 无任何 hindsight 引用，`src/hindsight/**` 不引用 memory；`loadHindsightConfig`/`checkHindsightHealth` 定义之外**无调用方**（index.ts/copilot.ts 均未装配）——#380 交付的是服务与隐私运行基础，未越权接入召回。
- **#377 × #378 写入路径**：#378 的全部门控复用 #377 的 reviewState 流转，无新确认入口/新路由（routes.ts 零改动）。

### 2.6 测试与验收声明真实性抽查 —— PASS（全部亲自复跑）

- `TEST_DATABASE_URL=…5573/openbot_hs01_378_test` 全套 12 文件 → **103 pass / 0 fail / 403 expect**（与 fix1 报告一致）。
- `bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` → **21 pass / 0 fail / 50 expect**。
- `bunx tsc --noEmit` → **exit 0**。
- RED 阶段证据无法只读复现（需回滚工作区），沿用三份先前审阅一致的结构佐证采信（测试引用的符号仅存在于本 diff）；GREEN/回归/类型/容器证据全部独立复现。
- ticket-380 运行态声明（401、隐私 env、版本 features、单出口）本审阅亲测复现（见 2.4），无夸大失实。

### 2.7 安全边界 —— PASS

- **客户端不可指定 bank**：memory routes/tools 无任何 bank 参数；`bankId` 仅存在于 hindsight 模块内部（默认 `default`，用于健康探测），不来自请求。
- **本 Wave 无 Hindsight 召回路径**：hindsight 模块未装配进任何请求/运行时路径（2.5）；Bot 召回仍全部走 OpenBot SQL（`eligibleRows`），无越前实现。
- **现状核验与 acceptance-mapping 一致**：`personal_memories` 无公司/租户归属列（#82 未实施），"当前公司"维度暂由 ownerUserId 承担——各报告已如实声明，无越权宣称。

## 3. Findings（分级）

**无 critical / high / medium。**

| # | 级别 | 发现 | 归属 |
| --- | --- | --- | --- |
| F-L1 | low | `reviewState` 允许集合存在双表示：`eligibleRows` 的 drizzle `inArray` 与 `mirrorEligible` 的原生 SQL 片段。当前值一致（本审阅核对），后续改值一侧易漂移 | #377 审阅 finding 1，裁决留 #384/#392 波次统一常量 |
| F-L2 | low（预存在） | confirmed 导入记录在上游内容变化时原地更新并保持 `confirmed`，新内容不经再审即进入召回。#377 审阅 finding 3 裁决"归 #378 决策"，但 #378 报告未含该决策——**仍是未决 carried item** | 建议 Wave 2 展开时显式裁决（spec 张力：导入内容变化是否降回 unreviewed） |
| F-L3 | low | #380 F2：健康检查合规判断基于 `HINDSIGHT_PRIVACY_*` 镜像声明，不交叉核对容器运行时 features；声明与实践漂移不会自动暴露（本次人工三重证据仍成立） | 裁决留 Wave 2（#385/#391 展开输入） |
| F-L4 | low | `CONTEXT.md` 同一未提交 diff 除个人记忆术语外，还含 4 个 billing 领域术语（Payer/Payment Order/Collection Fact/Entitlement Fulfillment）。ledger 已声明"billing 部分不混入本次交付" | 提交流程注意：billing 术语非本 Wave 交付物，提交说明/范围勿混入 |
| F-I1 | info | `intelligenceOnly`：仅存于 Intelligence、无 OpenBot 行的旧记忆不经审核记录即可召回。计划明示本票"维持现状不新增放行"；迁移/放弃由 #394/#395 处理，且以 #82 为前提 | 记录现状 |
| F-I2 | info | `patch.reviewState` 允许 `unreviewed→edited` 单步确认（#378 F-I1）：既有审核入口、无新旁路 | 记录语义 |
| F-I3 | info | 备份 sweep 两次运行之间副本可多存活一个调度间隔（日 cron 最坏 ~31 天）——fix1 后诚实披露的物理边界；声明窗口与 config 校验一致 | #380 fix1 已披露 |
| F-I4 | info | 任务简报记"12 个 M"，实况为 9 个 tracked 修改 + 未跟踪交付物；不影响检查点完整性结论 | 记录差异 |
| F-I5 | info | `expireStaleCandidates` 以 `updatedAt` 计龄：本人对候选的任何 update（如 enabled 切换）重置 30 天窗口，方向保守（多保留），无误删风险 | 记录语义 |
| F-I6 | info | Intelligence-only 行的内容编辑为敏感类目不回落 unreviewed（无 reviewState 字段）——与 #377"Intelligence 行不过审核门槛"一致，fix1 复审裁决范围外 | 后续票如收紧需与 #394 迁移一并设计 |
| F-I7 | info | `store_document_text=true`（Hindsight 保留原文持久化）为当前默认；spec 允许后续评估关闭，关闭前须验证检索/来源关联/删除证据 | #380 报告已列遗留 |
| F-I8 | info | `hindsight.env.example` 中 `HINDSIGHT_API_TENANT_API_KEY`/网关 key 均为 change-me 占位，隔离测试实值未入任何将入库文件（.gitignore 覆盖 + 本审阅 grep 证实） | 无需行动 |

## 4. 本 Wave 未实施且被 #82/#6 阻塞的范围（防越权宣称）

**外部前置现状（与 acceptance-mapping 一致，本审阅复核代码证实）**：#82（MT039 个人权限与来源选择，父 #6）未实施——`personal_memories` 无公司归属列；#6 多租户全功能隔离验收未满足。因此以下范围**不在本 Wave 交付内**，任何"已具备"的宣称均不成立：

- **租户隔离族**：跨公司隔离、bank 隔离与 bank 映射（#381）、团队业务事实/来源受限权限（#383）、已确认记忆迁移与对账（#394）——均直接前置 #82。
- **召回与派生族**：Hindsight 语义召回接入（#382）、幂等同步/稳定文档 ID/重试（#384）、时间事实与历史更正（#386）、可展开依据（#387）、派生判断形成与确认（#388/#389）、"候选不作派生依据"的独立断言（#388）。
- **运维与控制族**：SQL 降级召回与跨入口（网页/频道/定时）端到端复验（#385，另 #396 复验）、预算耗尽排队（#393）、暂停学习/暂停使用（#392）、删除立即阻断与清理证据链（#390/#391，含备份恢复后遗忘重放）、Intelligence 退出与旧独有记忆放弃（#395）。
- **最终门禁**：全员启用（#396）需 #6 满足 + 上述全部 verified，本 Wave 不满足。
- **#380 自身边界**：网关验证用 standin（Bifrost 未部署，bifrost-5/01.1 前置）；生产切换清单（真实 Bifrost URL/key、强随机 API key、9999 不发布复核、backup cron）未执行；"受控副本清除完成"证据链未建立；本票不证明租户隔离或个人记忆召回可用（README Explicit non-goals 已声明）。
- **无提交/推送/部署/启用动作**：全部产出为 HEAD `f0520524` + 未提交改动；功能未对任何用户开放。

## 5. 总体判定

**PASS。** 三张票（含各自 fix1）的交付与 9 份报告的声明一致：检查点逐字节可核，7 项重点核验全部通过，全部测试/类型/容器证据经本审阅亲自复跑复现。实现以最小改动收紧单一 seam（#377，4 行生产改动）、以保守分类器 + 五路径门控 + 幂等过期覆盖敏感与生命周期（#378）、以可复现运行态证据交付隐私底线（#380），方向与 Spec/ADR 0005 一致，无越权实现。4 low + 6 info findings 均有明确后续归属，不阻塞验收。可进入提交流程——**须由有提交授权的一方执行**，提交时注意：① CONTEXT.md 的 billing 术语不属本 Wave（F-L4）；② F-L2 为未决 carried item，Wave 2 展开时须显式裁决。

— 审阅完成于只读工作区，未改动任何被审文件（本报告除外），未 commit/push。
