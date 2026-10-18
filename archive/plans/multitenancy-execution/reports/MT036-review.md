# MT036 独立复审报告 —— Issue #79 知识库归属（coordinator 委托，全新会话）

- 复审者：独立 Reviewer（Pi，Orca Task `task_5100566dda7f` / Dispatch `ctx_c6216740ebf1`）。只读被审面；唯一新建 = 本文件；无修复、无提交/推送/合并。
- 被审对象：本树（BASE `f0520524`）= EXE 前置 `prereq-manifest.txt` **111 项** + MT036 交付 **9 文件**（coordinator 整复制）。
- 被审证据：`checkpoints/MT036/`（PLAN、before/after-hashes、sha256-manifest、changes.diff、red-green/、mutation/、verification/）+ `reports/MT036.md`。
- 复审方法：哈希逐文件独立复算 → 9 交付源码逐文件精读 → TDD/变异证据链核对 → **独立复跑**（自建容器/自建库/自建受限登录，全程不依赖实现者环境）→ 活库抽查 → 清理。
- **总裁决：通过。** 四条验收全部以真实双库测试独立复现（27/0/0 skip，本复审者自有环境）；冻结面零漂移；两处授权编辑逐字最小；架构各漂移方向全部 fail-closed。另记录 2 项证据缺口、4 项观察、2 项口径注记（均不阻断，详见 §4）。

---

## 1. 独立复跑（brief 步骤 1–8 全部实际执行）

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | `bun install --frozen-lockfile`（server/） | 1415 packages，exit 0 |
| 2 | 端口预检 55519 空闲；容器 `mt036-review-pg`（pgvector/pgvector:pg16，与实现者容器/端口完全隔离）；7 变量 env 存 0600 临时文件（setup=postgres 超户、`ent_mt036rev_{dir,data,opr}` 三受限登录各配一个 `ob_ent_*` 能力、`MT003_ASSIGNED_TEST_DATABASE_URL` 指向专属 assigned 库、`KB_TEST_DATABASE_URL` 指向 `ent_mt036rev_kb` 属主的 KB 专用库）；用后已删 | 全部就绪 |
| 3 | base migrate：`bun scripts/enterprise-test-db.ts migrate` → `migrations-applied ok`；十二任务链经套件 beforeAll 真实执行（kb-ownership 链 11 任务 MT004→…→MT069 + bots-ownership 套件补 MT016；generate→manifest→apply --manifest，applied\|up-to-date 收敛） | exit 0 |
| 4 | KB 库按实现者 evidence 同法：专用库 + 专用受限登录（NOSUPERUSER NOBYPASSRLS）属主通道，`applyKbOwnershipMigrations()` 走 drizzle-kb journal（advisory lock 幂等） | 5 表收敛（4 既有 + `knowledge_base_ownership_states`） |
| 5 | 聚焦 `bun --no-env-file test tests/multitenancy/kb-ownership.test.ts --timeout 120000` | **27 pass / 0 fail / 0 skip（104 expect）** exit 0 —— 与票面声明逐字一致 |
| 6 | 全量 `bun --no-env-file test tests/multitenancy/ --timeout 120000` | **709 pass / 0 fail（27 文件，10273 expect）** exit 0 —— = 682 基线 + 27，与 brief 预期逐字一致；日志中唯一 "skipped" 字样为一条 (pass) 测试名，非真 skip |
| 7 | `bun run typecheck` exit 0；`bunx biome check`（kb-ownership.ts / ownership-schema.ts / kb-restricted-query.ts / kb-ownership.test.ts / support/kb-ownership.ts / drizzle-kb.config.ts 共 6 文件）0 诊断；旁证 `bun test src/kb/` → **318 pass / 11 skip / 0 fail** | 全部与实现者声明一致 |
| 8 | 活库抽查 + 清理 | 见 §3；容器已删、0600 env 已删、临时文件已删 |

复跑侧记（不影响裁决，如实记录）：首次聚焦跑失败，根因是**复审者自建环境脚手架缺陷**（`docker exec` 漏 `-i` 导致建库/建登录 heredoc 未送达，KB 登录缺失 → 28P01），与被审代码无关；修复脚手架后 27/0/0 稳定复现。

## 2. 逐项裁决（brief 重点 A–G）

### A. 四条验收 —— 逐条通过（独立复跑实测）

| 验收 | 独立复跑证据 |
| --- | --- |
| ① 列表/查询只返当前范围 | a1-member 列表恰为 A1 范围 6 库（Set + 长度双钉）；a1a2 双成员按 scope 各见各团队；workspace-v1 团队公共 + grant 语义并存（a1-other 见公共不见授权库）；tenancy-v1 公司 B 保持授权语义、multi-company 不因 B 授权看 A —— 全部实测 pass |
| ② 他司库 ID 不可见语义 | b1 取 A1 库与不存在 id 双双 `{ok:false,kind:"invisible",verdict:notFoundVerdict()}`，且 `serializeNotFoundVerdict` **逐字节钉死**同形；同公司跨团队同形；suspended 团队公共路径立即消失、授权路径按 MT008 语义保留、新取证被 seam 拒（WORKSPACE_FORBIDDEN 钉死）、恢复复得 —— 实测 pass |
| ③ 归属变更立即反映无缓存残留 | 迁移 A1→A2（主库+镜像同步）：旧团队下一次调用即 INVISIBLE、新团队即得、连发 3 次一致、两团队列表即时翻转。**无缓存是结构性的**：每次调用重走 seam→事务→RLS→注册表→比对，无任何 memoization/失效通道可残留 —— 实测 pass |
| ④ 跨库引用同步版本+调用时授权，缺失/不一致拒绝不放行 | 镜像缺失 → `KB_OWNERSHIP_MISSING`；团队不符 → `KB_OWNERSHIP_WORKSPACE_MISMATCH`；版本落后 → `KB_SYNC_VERSION_STALE`；同步补齐（真实 `kbSyncVersionOf`）后恢复。检索收窄只放行授权且一致集合；MT009 依赖行 active 不 confer 可见性（补 MT009 D4 边界）；孤儿 KB 行、kind 漂移、内容行租户漂移、内容软删各自独立拒绝/不可见且修复可恢复 —— 实测 pass |

另：AC4 内部身份结构性拒绝见 §C；纯函数面 4 用例 + 存储契约 2 用例为非验收钉子（令牌形状 `kb-sync/v1/w=ws-1/r=4/e=2` 冻结、越界输入 `KB_SYNC_INPUT_INVALID`、比对五态、canary 零回显、镜像表五列精确清单、KB 迁移幂等）。

### B. 架构裁决 —— 双库设计无放行方向的一致性缺口

主库注册（`enterprise_resources kind='knowledge'` + MT008 判定注册表只读消费）+ KB 库镜像状态行（`knowledge_base_ownership_states` + 确定性令牌逐次比对）的各漂移方向逐一核对：

- 主库动/镜像未动 → `KB_SYNC_VERSION_STALE` / `KB_OWNERSHIP_WORKSPACE_MISMATCH`（deny）；反向漂移（镜像超前）同样不等即拒；镜像缺失或租户不符 → `KB_OWNERSHIP_MISSING`；**令牌比对在授权放行之后**（请求者已知存在性，给确定性可行动码且零值回显），列表上下文取「不浮现」形态（D6 两种拒绝形态并存，测试分别钉死）——全部 fail-closed。
- 孤儿内容行（主库无注册）、kind 漂移、内容行租户漂移、内容软删、注册整行字段缺失（toRegistration null 守卫）→ 全部不可见/拒绝。
- **同步令牌真实性**：活库探针即聚焦套件本体（真实双库、真实受限角色、真实 RLS）；stale 制造与真实 `kbSyncVersionOf` 修复均实测。
- 判定与 MT008/MT011 同构核实：assertTrustedScope → read committed + lock/statement timeout → 事务本地 `app.*` → advisory 共享锁同键族 → 受限 data 角色经真实 RLS → 同一 shipped 注册表求值；deny 唯一形状 = 冻结 `notFoundVerdict()`。

**观察（不阻断，详见 §4-O1/O2/O3）**：①头注宣称锁链含 `→ resource` 而实现取 4 锁（单库 authorize 未取 MT008 store.decide 的第 5 把 resource 共享锁），并发迁移交错最坏一次在途调用见到迁移前事实，下一调用即拒，安全方向不变；②主库授权与 KB 内容读取为两个独立事务的固有 TOCTOU 窗口（逐调用点一致性，spec「调用时授权」语义内）；③生产侧尚无维护镜像行的管理写路径（后续管理票）——落地前镜像恒缺失、受限查询恒拒绝，**安全但可用性被后续票门控**，与 D2/D7 披露一致，建议 coordinator 作为集成依赖跟踪。

### C. 受限入口 —— 结构性拒绝实测通过；RLS 边界披露核实

- 内部 API-Key 身份形状（tenant+admin+空 kbScope=公司内全库）三种入口全部 `KB_REQUESTER_INVALID`（`assertRequester` 结构检查：无 `scope` 形状一律拒绝）；伪造 scope → `assertTrustedScope` → `UNVERIFIED_SCOPE`；positive control：seam 签发 scope 正常且视图携 `kb-sync/v1` 令牌 —— 实测 pass。
- 入口源码级钉子：注释剥离后不含 `kbScope`/`APIKeyEntry`；权威模块无 `process.env`/`Bun.env`/`import.meta.env`（测试钉死）。
- **KB 侧无 RLS/企业角色矩阵 = D3 披露属实**：ownership-schema 无 RLS 定义，KB 库单属主访问模型为 KB 域既有先例；本票 KB 侧隔离由入口调用时授权 + 同步版本门承担，表级 RLS 硬化属后续 KB 域硬化票。边界披露与代码事实一致。

### D. drizzle-kb 两编辑最小性 —— 逐字核实；journal before 哈希缺口定性

- `drizzle-kb.config.ts`：`git diff f0520524` 恰 1 行（schema 数组追加 `ownership-schema.ts`）；BASE 哈希 `2d3534b7` 与 before-hashes 一致，现哈希 `4a6b411d` 与 manifest 一致。
- `_journal.json`：`git diff f0520524 --numstat` = **7 insertions / 0 deletions** —— 字面纯追加（idx 1 条目），0000 条目内容零改动；现哈希 `e7ea013a` 与 manifest 一致。
- **证据缺口（确认）**：`before-hashes.txt` 无 `_journal.json`（有 config 无 journal）。定性：**真实缺口但已独立补证**——BASE 态可由 git 复原（`496513cb…`，与 brief 引用一致），且工作树对 BASE 的 diff 即 7 行纯追加，编辑面不经 before 哈希亦已完整钉死。建议后续 checkpoint 纪律：凡授权编辑文件一律进 before-hashes。
- 0001 SQL ↔ snapshot 一致性：5 列逐列对应（varchar(36) PK / varchar(64)×2 / text / timestamptz default now）、CHECK `kb_ownership_state_shape`、FK cascade→knowledge_bases、索引 `idx_kb_ownership_states_tenant_ws`；`0001_snapshot.prevId` = `0000_snapshot.id`（`df34be5b…`）链正确；`git status` 下 drizzle-kb 仅 journal 修改 + 两新文件，0000 SQL/快照零触碰。
- 主库零迁移核实：`migrate-test.ts` 哈希 = manifest 冻结值；`migration-tool.test.ts`、`enterprise-test-db.ts` 对 BASE 零 diff；`src/index.ts`、`db/schema/index.ts` 在 111 项 manifest 内复算一致。8 个 before-hashes 冻结文件全部逐字节复现。

### E. 口径对账 —— 以逐文件复算定性：两套口径各自自洽，无实质分歧

- 本树 manifest **111 项全部逐文件 SHA-256 复算 111 OK / 0 漂移**（复审者独立执行）。
- 实现者口径（其树）：prereq 108、基线 638/0/0（25 文件）、全量 665=638+27（26 文件）——`verification/00/02/05` 存档逐字核对一致。
- 本树口径：基线 682（26 文件，含 MT016 的 44 用例/1 文件）、全量 **709=682+27（27 文件）**——复审者本机实测 709/0/0/27。
- 双口径差 = 恰好 MT016 集成增量（+44 用例、+1 文件、manifest +3 项，含 bots-ownership 系文件），与「MT036 树建于 MT016 集成前同步态」的解释吻合。**计数差为集成时点差，非交付差异。**
- 顺带钉正（brief 侧转写瑕疵）：brief 记 `support/kb-ownership.ts` 为 `9e59cc19`，实际全哈希 `6e59cc19…`（首字符脱落的转写截断），文件本体与实现者 manifest 9/9 一致；brief「before 哈希 7 文件」实为 9 文件（8 冻结 + 1 编辑）。均不影响裁决。

### F. TDD 链 —— RED/GREEN/REFACTOR/变异证据核对

- **RED**：`RED-1-modules-missing.txt` = `Cannot find module '../../src/enterprise/tenancy/kb-ownership'`，0 pass / exit 1 —— 功能缺失型 RED，成立。
- **GREEN-1**：归档 `GREEN-1-focused.txt` 为**修复测试侧缺陷后**的 25/0（96 expect）。报告声称的首跑 **18/7 未存档**——确认为证据缺口（§4-G1）。「7 项全为测试侧缺陷」（operator 通道 42501、bun-sql `execute` 直返行数组、源码断言误计头注）与 25=27−2（REFACTOR 补 2 漂移用例）的算术自洽，且 REFACTOR 生产侧唯一改动（列表循环 `state === undefined → continue` 守卫）在终态源码可指认，但「生产零回改」的直接第一手物证缺首跑日志。
- **REFACTOR**：生产改动 = 上述单点 TS 收窄守卫（语义与「镜像缺失不浮现」既有语义一致）；biome 8 错 1 警自欠自修；补 2 漂移用例（kind 漂移、内容行租户漂移）后 27/0/0 —— 与归档一致。
- **变异**：`mutation/` 9 份日志逐份核对 —— MUT1 kind 过滤（1 fail）、MUT2 列表注册表求值（2 fail）、MUT3 同步版本比对（3 fail）、MUT5 KB 租户过滤（1 fail）、MUT6 workspace 比对（2 fail）、MUT7 请求者结构门（1 fail）、MUT4b-full 双信任门（1 fail）= **7 捕获**；MUT4a/MUT4b 单信任门存活（0 fail）= **2 冗余防线如实披露**（纵深防御，MT008 MUT3a 先例）；`RESTORE-green.log` 27/0 复绿。runner 含变异未生效熔断、逐字节还原 + sha256 复验，纪律完整。

### G. KB 域旁证边界 —— 复现一致，skip 定性干净

`bun test src/kb/` = **318 pass / 11 skip / 0 fail**（26 文件，实测）。11 个 skip 全部为既有 live-Qdrant/服务依赖用例（`ingest → qdrant → retrieve roundtrip (live)`、`ensureCollection against a live Qdrant` 系），无一属于本票交付；本票自身 27 用例在独立复跑中 **0 skip 全实跑**。「skipped 不算通过」边界：本票门槛内无 skip，边界成立。

## 3. 活库抽查与清理

- 镜像表：`knowledge_base_ownership_states` 存在，五列与 CHECK `kb_ownership_state_shape`、FK cascade、索引逐项在库确认；套件存储契约用例经 `information_schema` 五列精确清单钉死。
- 同步令牌：`kb-sync/v1/w=…/r=…/e=…` 形状冻结 + 双向漂移拒绝 + 真实修复恢复，均在本复审者自有容器实测。
- 受限入口拒绝：内部身份/伪造 scope 的结构性拒绝在本复审者环境实测复现。
- 能力角色：`ent_mt036rev_{dir,data,opr}` 各恰配一个 `ob_ent_*` 能力角色；`enterprise_resources`/`enterprise_resource_grants`/`enterprise_memberships`/`enterprise_workspace_memberships` RLS 全部 `relrowsecurity = t`。
- 残留：套件 dispose 后 `enterprise_resources` 0 行、KB 库 `knowledge_bases`/`knowledge_base_ownership_states` 各 0 行——零残留。
- 清理：`mt036-review-pg` 容器已删；0600 env 与全部临时文件已删。实现者容器 `mt036-impl-pg`（55515，D9 披露保留）未触碰。

## 4. 发现清单（分级）

**证据缺口（2，均已有独立补证路径，不阻断）**

- **G1** GREEN-1 首跑 18/7 未存档（归档 GREEN-1 为修复后 25/0）；「7 项全为测试侧缺陷、生产零回改」缺第一手日志。补证：RED/终态日志完整、25=27−2 算术自洽、REFACTOR 生产单点守卫在终态源码可指认。
- **G2** `_journal.json` 缺席 before-hashes.txt。补证：git BASE 态 `496513cb…` 与 brief 一致，工作树 diff = 7 insertions/0 deletions 字面纯追加。

**观察（4，不阻断）**

- **O1** `kb-ownership.ts` 头注锁链写含 `→ resource`，实现取 4 锁（单库 authorize 未取 MT008 store.decide 的 resource 共享锁；列表侧「候选无界不持逐资源锁」已注明 MT011 边界）。并发迁移交错最坏一次在途调用见迁移前事实、下一调用即拒，安全方向不变；建议对齐头注或补第 5 锁。
- **O2** 主库授权事务与 KB 内容读取为独立事务的固有 TOCTOU 窗口（逐调用点一致性）。属双库无分布式事务的必然，spec「调用时授权」语义内，测试已钉死下一调用语义。
- **O3** 生产镜像写路径（归属迁移/版本推进的管理动作）属后续票：落地前镜像恒缺失、受限查询恒拒绝——安全但可用性门控于后续票。建议 coordinator 作为集成依赖跟踪（同 D7 检索器接线、HTTP 路由装配）。
- **O4** `reports/MT036.md` §2 验收映射表 AC3 记 5 用例（GREEN-1 时点数），终态文件 AC3=7（REFACTOR +2 漂移用例）；总数 27 正确。文档精度问题。

**口径注记（2，brief/协调侧，非实现侧）**

- brief 的 `9e59cc19` 为 `6e59cc19…` 之转写截断（文件与 manifest 一致）；「before 哈希 7 文件」实为 9 文件（8 冻结 + 1 编辑）。

## 5. 结论

MT036 四条验收**全部通过独立复跑实测**（本复审者自有容器/库/受限登录，聚焦 27/0/0、全量 709/0/0 / 27 文件，与 brief 预期逐字一致）；9 交付哈希 9/9 逐字复现；冻结面（migrate-test/migration-tool/index.ts/schema barrel + 8 before 文件）零漂移；prereq 111/111 复算一致；drizzle-kb 两编辑逐字最小（config 恰 1 行、journal 7 插入 0 删除）；双库设计各漂移方向 fail-closed，同步令牌与结构性拒绝均活库实证；变异 7 捕获 + 2 冗余防线如实披露 + 双门捕获；KB 域旁证 318/11-skip 复现且 skip 与本票无关。**无修复建议级缺陷；2 项证据缺口均已被复审独立补证，建议作为 checkpoint 纪律改进项（授权编辑文件一律进 before-hashes；GREEN 中间态日志归档）。** 裁决：**通过**。

*复审证据（本机实测）：聚焦/全量/typecheck/biome/kb 旁证/哈希复算均在复审会话内独立执行，输出未落库（唯一新建 = 本文件）。*
