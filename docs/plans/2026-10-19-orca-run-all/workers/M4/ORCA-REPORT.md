# [mt-M4] 批次核验报告：#121、#143、#146、#155、#167（MT078/100/103/112/124）

批次：[mt-M4]，worktree `1123786563/mt011` @ HEAD `3ca32d49`。日期：2026-10-19。
零代码改动（`git status` 仅本报告未跟踪；本报告覆盖上一批 [mt-M3] 报告，票号见标题）。
执行中断说明：17:39 一次 API 断连后按协调器指令续跑；所有核验证据在断连前后连续取得，无重做。

## 结论速览

| 票 | MT | 结论 | 一句话 |
|---|---|---|---|
| #121 | MT078 | **BLOCKED-GAP** | 审计分域/审计查询授权/计费管理动作授权整域未实施；且依赖 #116 的验证件在 HEAD 上红 |
| #143 | MT100 | **BLOCKED-GAP** | 桌面组织切换的媒体/缓存/订阅清理未实施（依赖 MT098/099 已绿） |
| #146 | MT103 | **SATISFIED（零改动）** | 报告票：归档报告+哈希链完整，AC1–4 实证；今日复核 gitlink 仍 pre-adapter |
| #155 | MT112 | **SATISFIED（零改动）** | 路径漂移到 legacy-anchor.test.ts，四条 AC 逐条对应，21/21 全绿 |
| #167 | MT124 | **BLOCKED-GAP** | 企业入口逐路由统一上下文装配+清单回写缺失（依赖 MT122/123 已绿） |

本批无产品侧 IMPLEMENTED（三张缺口票均远超 20 行且跨文件域，按硬约束留专项派发）。

---

## #155 [T] MT112 创建原有公司与默认团队并建立映射 —— SATISFIED（零改动）

**路径漂移**：票面 `server/tests/multitenancy/legacy-company.test.ts` 不存在；实际落地 `server/tests/multitenancy/legacy-anchor.test.ts`（文件头第 2 行明确 "MT112（执行轮 Ticket）"，四条 AC 逐条写在头部注释）。交付模块：迁移四步（0001 建表 enterprise_deployment_anchors / 0002 RLS / 0003 锚点行 / 0004 映射行）经 MT003 工具（migrate-test.ts）真实执行；`docs/plans/2026-10-15-company-team-multitenancy-execution/briefs/MT112-brief.md` 与 `MT112-review-brief.md` 在档。均已在 main。

### AC 逐条实证（legacy-anchor.test.ts，21/21 pass / 0 fail / 0 skip，真实 PostgreSQL）

| AC | 用例组 | 实证 |
|---|---|---|
| 1. 幂等创建，重复执行不产生重复实体 | `criterion 1` describe | ON CONFLICT DO NOTHING / DO UPDATE 路径 + 重放 `up-to-date`（appliedCount=4） |
| 2. 与部署身份及计费 Customer 映射唯一可核验 | `criterion 2` describe | deployment_packages.tenant_id（UNIQUE）+ billing_customers 外部键派生 `openbot-deployment-<tenant_id>`，唯一索引 + 派生 CHECK |
| 3. dry-run 预览、manifest 执行 apply | `criterion 3` describe | dry-run 预告全部步骤；manifest 漂移在产生任何 DB 效果前 refused（stage: manifest） |
| 4. 创建后既有单租户行为不变 | `criterion 4` describe | expand-only 对照（只允许锚点表+journal 新增）、legacy 行数/时间戳不动、策略基线不漂移 |

### 命令与输出

```sh
source /tmp/mt011-env.sh   # TEST_DATABASE_URL + 三受限角色（127.0.0.1:5562/openbot_enterprise_mt011）
bun test ./server/tests/multitenancy/legacy-anchor.test.ts
# 首跑：19 pass / 2 fail（见下）；重跑：21 pass / 0 fail / 0 skip，320 expect() calls
```

**首跑 2 fail 的定性（非产品缺陷，不修改）**：共享长寿命测试库上 journal 与 schema 状态错位（enterprise_deployment_anchors 表/策略已在而 mt_task_migration_journal 对 MT112 记录不全），首跑落入"schema 在、journal 不全"的过渡态——`dry-run previews` 与策略基线两个断言按"全新库"分支走而实际是收敛库。本次运行恰好把 journal 补齐，重跑 21/21 稳定。测试自身已含 `up-to-date` 重放分支设计；CI 门禁库（ee5efd3d）为干净库，不走此过渡态。无代码改动必要。

### 改动文件
无。

---

## #146 [R] MT103 移动端 submodule 基线核对 —— SATISFIED（零改动，报告型票）

**交付物定位**：
- 基线说明（worktree 内，git tracked）：`docs/plans/2026-10-15-company-team-multitenancy-execution/mt103-canonical-mobile-baseline.md`
- 完整差异报告：`archive/plans/multitenancy-execution/reports/MT103.md`（含 §5 MT104 前提/风险、§6 独立复核命令）
- 复核包：`archive/plans/multitenancy-execution/checkpoints/MT103/`（before/after.json、verification.txt、pin-vs-canonical.diffstat.txt、manifest.sha256、final-hashes.sha256）
- dag.md 状态 `verified`（独立复审过，reports/MT103-review.md 在档）。

### AC 逐条实证

| AC | 实证 |
|---|---|
| 1. 报告列明 gitlink 与 canonical 差异（含缺失适配层） | 报告 §0/§1：pin `4679233` vs canonical main `81d0d3a1`，差 2 commits（`6e3a131` 适配层、`81d0d3a` review 修复），161 files +17162/−28；缺失 `apps/mobile/src/openbot/`（33 源文件）+ 20 测试套件，pin 检出中不存在 |
| 2. 任务专用工作区基线；未改外部主工作区、未重建旧目录 | 报告记录专用 worktree（BASE `f0520524`）；本仓各工作区 `apps/` 下无 `openmuse-mobile`（实测）；专用工作区已按 Orca 生命周期清理（归档证据接管可复核性） |
| 3. 后续 Ticket 前提与风险清单 | §5.1 五条前提（gitlink 前移、MT083 核验、跨仓两步提交流程、EXPO 配置、CI 布线决策）+ §5.2 六条风险（stale pin 再发、A11 取证路径漂移、适配层零租户语义、双包管理器、无 tag 锚点、canonicity 依赖网络） |
| 4. 结论可独立复核（命令与版本标识） | §6 全套命令 + 完整 SHA 锚点；**本轮独立复核**见下 |

**哈希链核验（本轮）**：final-hashes.sha256 记录值 vs 实测——reports/MT103.md `64c51951…`✓、reports/MT103-review.md `395109c1…`✓、checkpoints/after.json `74eb76a2…`✓、verification.txt `f0b4356b…`✓、pin-vs-canonical.diffstat.txt `c7c6b246…`✓。基线说明文档哈希与记录值不同（`4779a083`≠`acf0f7de`），来源为 ad7aff56「证据出清」提交重写归档相对路径（`git log -S` 定位），良性漂移。

**今日钉定状态复核（票面要求的当前状态核对）**：
- 当前 gitlink = `491d6215`（fb66bd11，2026-10-18「同步两个子模块的本地开发提交」将 `4679233`→`491d6215`）。
- 在外部主工作区 submodule 检出实测：`491d621` = `4679233` + 单个 docs(agents) 提交；`git merge-base --is-ancestor 81d0d3a1 491d6215` → **不是祖先**——pin 仍为 pre-adapter，MT103 结论与 MT104 第一前提（gitlink 前移）继续成立。
- ⚠️ 新风险：`491d621` 在 canonical 历史本地 clone（`/Users/wuyongjun/trea/openmuse` @ `81d0d3a`）中不存在；github.com 443 当前不可达，无法 `ls-remote` 判定其是否已推送。若未推送，main 的 gitlink 指向一个仅存在于本地工作区的提交。建议 MT104 派发前先确认。

### 改动文件
无。

---

## #121 [O] MT078 业务审计与身份审计分域，计费管理需明确授权 —— BLOCKED-GAP

**核验**：票面 `server/tests/multitenancy/audit-domains.test.ts` 不存在；`server/src/enterprise/tenancy/` 53 个模块中无审计域模块；全仓无 audit-domains/审计分域实现。dag.md 标 `blocked`，从未派发。

**既有相邻交付（不构成等价实现）**：
- MT075（#118，admin-separation）：`enterprise_security_events` + `recordManagementAuditEvent`——只覆盖管理动作审计，非业务/身份/平台三分域查询面；
- MT074（#117，vendor-billing）：供应商调用/回调留审计——供应商面，非管理动作；
- legacy `server/src/audit.ts`（auditQueryFromUrl / auditEventsToCsv）——单租户审计查询与导出，无租户范围门控；
- 计费管理动作（发放/调整/退款）：`server/src/billing/routes.ts` 只有 rewards 认领流与 admin 快照/同步，无"明确授权的管理动作"面。

**缺口**：审计事件分域模型 + 分域 RLS + 范围门控查询/导出（脱敏）+ 计费管理动作授权与审计 + 专用测试——整域新建，远超 20 行。

**依赖状态（实测）**：
- #118 MT075：`bun test ./server/tests/multitenancy/admin-separation.test.ts` → 25/25 pass ✓
- #116 MT073：`bun test ./server/tests/multitenancy/billing-visibility.test.ts` → **套件级 fail（beforeAll）**：fixture 调 `store.insertOrder` 未传 `ownerPayerRef`，撞上 `server/src/billing/payments/store.ts:63` 的 TypeError。`git log -S ownerPayerRef` 定位该 API 要求由 5192c33c（2026-10-17 bifrost-5 集成）引入，MT073 fixture 未跟上——**先于本批存在的测试侧破损，属 MT073 域，本批不越界修**。#121 领取方需先让 #116 验证件回绿。

### 改动文件
无。

---

## #143 [Q] MT100 桌面切换或退出组织时清理公司媒体与订阅状态 —— BLOCKED-GAP

**核验**：`grep -rn org_switch_cleanup desktop/` 零命中；`desktop/src/OrgSwitchCleanup.test.tsx` 不存在（desktop/src 仅有 App/Problem/ProviderPicker 三套 React 测试）；desktop 源码无媒体/缓存/订阅的组织级清理实现。dag.md 标 `blocked`，从未派发。

**依赖状态（实测，cargo 全量）**：
```sh
cargo test --manifest-path desktop/src-tauri/Cargo.toml        # 592+149 pass / 0 fail（8+1 ignored 平台既有）
cargo test --manifest-path desktop/src-tauri/Cargo.toml org_context            # 33/33（MT098 #141 ✓）
cargo test --manifest-path desktop/src-tauri/Cargo.toml credential_namespace   # 21/21（MT099 #142 ✓）
```
`credential_namespace.rs:160` 已写明 MT100 的清理边界契约（"cleanup never reaches past its target"）并有 `ns11/ns16` 反向用例——但那只覆盖凭据命名空间；媒体、业务缓存、订阅状态的清理半边完全没有。

**缺口**：Rust 侧组织切换/退出清理流程（半清理回滚+可重试+日志无明文）+ React 侧测试——跨双语言产品工作，远超 20 行。

### 改动文件
无。

---

## #167 [T] MT124 企业入口装配接入统一上下文与授权 —— BLOCKED-GAP

**核验**：票面 `server/tests/multitenancy/assembly-enterprise.test.ts` 不存在；全测试目录无 MT124 引用。dag.md 标 `blocked`，从未派发。

**现状（源码定位）**：
- 企业入口路由（`/api/enterprise/conversations`、`/api/enterprise/workspace-scope`）注册在 `server/src/app.ts:958-970`，位于 MT122 统一 entryContext 中间件挂载点（`app.ts:1092`，注释明言 "capabilities/auth/enterprise surfaces registered above keep their own context establishment"）**之上**——企业入口走各自 `scopes` resolver，不经统一中间件；
- MT122 已做到共享闭包（`index.ts:1053` 注释：entry factory 与企业 scopes 同 directory/data/`authenticateEnterpriseRequest`），这是 AC2 的架构半边；
- 缺：企业入口**逐路由**验证（缺上下文拒绝/越权不可见）、企业接口 DTO 对照测试、处置结果回写入口清单（MT001 清单回写目前只有 MT075 的 managementPlanes 半边）。

**依赖状态（实测）**：
- #165 MT122：`bun test ./server/tests/multitenancy/entry-context.test.ts` → 21/21 ✓
- #166 MT123：`bun test ./server/tests/multitenancy/startup-defaults.test.ts` → 24/24 ✓

**缺口**：新测试文件 + 可能的企业路由装配改线——超 20 行，且是"统一上线"关键闭环（阻断 MT130），留专项。

### 改动文件
无。

---

## 遗留与建议

1. **（高）MT073 验证件红**（本批发现，非本批票）：billing-visibility fixture 缺 `ownerPayerRef`，5192c33c 起 API 要求归属先行。测试侧小修，但属 #116 域，建议单独派发；它同时卡住 #121 的依赖核验。
2. **（高）openmuse gitlink `491d621` 可达性**：github 不可达期间无法判定是否已推送；若未推送则 main 引用仅存本地的提交。MT104 派发前确认并按 MT103 §5.1 前移到含适配层的 SHA。
3. 三张 BLOCKED-GAP（#121/#143/#167）依赖侧均已核验绿（除 1），可按票直接专项派发。
4. 环境未清理：5562 容器（orca-all-mt011-pg）按批次说明保留；`/tmp/mt011-env.sh` 沿用。
