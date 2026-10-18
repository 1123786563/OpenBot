# MT008 / Issue #51 — 独立复审报告

- 角色：独立 Pi Reviewer（只读审阅；与实现者 task `task_abdbac221bdf` / dispatch `ctx_3e5857d058e2` 无共享会话；本轮为复审派发的首次完整执行——前任复审者 ctx_9328117dccee 死于上游 502，无任何增量）
- 审阅对象工作树：`/Users/wuyongjun/orca/workspaces/OpenBot/i6-review-mt008`（实现树 i6-mt008 的逐文件副本），BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`
- 复审方法：交付物哈希逐项复算 → 只读审阅全部触及文件与前置 seam → 三项重点裁决（独立取证，含可执行复现）→ 专用容器独立复跑全部验证命令 → 本报告。唯一新建文件即本报告；被审文件零改动。

---

## 1. Verdicts

| 维度 | 结论 |
|---|---|
| **Spec compliance（Issue #51 四条验收）** | **PASS（4/4）**，逐条证据见 §3 |
| **Code quality** | **PASS**（1 medium 为测试覆盖缺口，非实现缺陷；详见 §5 findings） |
| **三项重点裁决** | ①三处测试修复：**均为合理修复，无语义削弱**（§4.1）；②MUT3a 存活变异：**medium（测试覆盖缺口），维持披露、可选择性跟进**（§4.2）；③ALLOWED_TASK_IDS 窄例外：**符合裁决 #5 先例、最小化**（§4.3） |
| **总体** | **MT008 通过独立复审**；无 critical/high；无需返工项 |

---

## 2. 独立复跑（本人亲自执行，容器 `mt008-review-pg` = pgvector/pgvector:pg16 @127.0.0.1:55466，trust）

| # | 命令 | 结果 / 退出码 |
|---|---|---|
| 0 | `lsof -i :55466`（端口预检） | 空闲（exit 1，无占用）→ 起容器；**psql 探针** `select version()` 2s 后就绪（PostgreSQL 16.15）；手工建 `openbot_enterprise_mt008rv` 与 assigned 库 `..._mt008rv_assigned` |
| 1 | `TEST_DATABASE_URL=… ENTERPRISE_TEST_SETUP_DATABASE_URL=… ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL=<ent_mt008rv_{dir,data,opr}> bun scripts/enterprise-test-db.ts migrate` | schema + 受限登录预置成功，**exit 0** |
| 2 | `bun /tmp/…/gen-manifest.ts MT004 … && TEST_DATABASE_URL=… bun scripts/multitenancy/migrate-test.ts migrate MT004 --apply --manifest …`（前置） | `applied: MT004`（0001+0002 记入 journal），**exit 0**。MT008/MT112 无需预 apply：resource-policy 套件 beforeAll 与 legacy-anchor 套件各自真实执行（journal 亲验：MT004 13:07:59 / MT008 13:08:07 / MT112 13:08:36 各步骤留痕） |
| 3 | 五变量 `bun test tests/multitenancy/resource-policy.test.ts --timeout 30000` | **exit 0：29 pass / 0 fail / 0 skip**（159 expect；与存档 158 差 1 = 全新库走 `applied` 分支多一条 expect，见 F5） |
| 4 | `MT003_ASSIGNED_TEST_DATABASE_URL=… + 五变量 bun test tests/multitenancy/ --timeout 30000` | **exit 0：232 pass / 0 fail / 0 skip**（9 文件，7836 expect = 基线 203 + 本票 29；零 skip 亲验） |
| 5 | `cd server && bun run typecheck` | **exit 0** |
| 6 | `bunx biome check`（触及 7 文件） | **exit 0，No fixes applied**——与披露 D2 一致，无残留欠账 |
| 7 | 收尾 | `docker rm -f mt008-review-pg` 成功、无残留容器；凭据仅 env 内联（本机 trust 容器），无落盘 |

### 哈希复算（本人执行）

- `checkpoints/MT008/sha256-manifest.txt` 全 29 项（交付 7 + checkpoint 19 + 报告 + brief）：**29/29 OK**（sha256sum -c，exit 0）。
- 裁决 #9 修复的 4 个 MT006 文件（workspace-admin.ts / workspace-scope-routes.ts / config.ts / app.ts）：现树哈希与 `mt008-restore-before.txt`、`mt008-restore-after.txt` 双侧逐项**完全一致**（before==after==current，即 MT008 未触碰）。注：本副本树 `checkpoints/MT006/`、`MT112/` 为空目录（转移时未携带），brief 所述"与 checkpoints/MT006/sha256-manifest.txt 比对"只能以 MT008 侧双侧存档自洽性替代，结论不受影响。
- `prereq-recompute.txt`（21 项）：18 项 OK + 3 项 DIFF 恰为本票 3 处授权编辑（schema / migrate-test / migration-tool.test），其 before 哈希 = prereq 声明值、current = after 哈希 = 现树，三方闭合。
- git 状态与 brief 预期相符：M app.ts / config.ts / enterprise-tenancy.ts / index.ts / store.ts（MT005/MT006 前置增量）+ server/{scripts/multitenancy, src/enterprise/tenancy 新文件, tests/multitenancy} untracked；index.ts / store.ts 哈希与 prereq manifest 一致（MT008 未动 seam 文件）。

---

## 3. 验收逐条独立判定（Spec compliance）

**AC1 private/workspace 可见性 + 未标记回归 — PASS**
- DB 边界：'workspace'/'private'/null 经受限 operator 真实 UPDATE 行策略写入、data 角色读回；`'public'` → SQLSTATE 23514（CHECK `enterprise_resource_visibility`，schema 与迁移语句双侧钉死）。
- 回归：未标记资源 tenancy-v1 下 grantee ALLOW / 无 grant 活跃成员 DENY；workspace-v1 下**逐字节相同**（不自动扩大）；'private' 两版本均只认 grant；suspended 成员失团队公共、留 grant 路径。
- 本人复跑全绿佐证。

**AC2 新版本独立注册 + 旧版本判定升级前后完全一致（对照测试）— PASS，对照测试真实**
- 结构真实性亲验（test:612-652）：**同一 registry 实例**先仅注册 tenancy-v1 → 15 例矩阵逐例求值存档 → 向**同一实例**注册 workspace-v1 → 同一 `factsOf` 工厂重建同输入逐例重求值 → 逐例断言 verdict 相同（非"仅新版本全绿"）。并反向防伪：矩阵第 6 例在 workspace-v1=allow / tenancy-v1=deny，证明注册的不是旧版本克隆。
- 生产等价：同 15 例与 `createAuthz().check` 逐例等价（test:654-683）。本人核对生产唯一调用点 store.ts:578-593 的入参映射（`principalId: scope.principalId`、`locallyAllowed: granted`）与测试映射**逐字段一致**——等价性映射忠实于生产，非为绿而绿。tenancyV1Decide 与 authz.check 条件集逐一对应（active/grant/tenant/workspace/revision/aclEpoch；未知版本双双 POLICY_REVISION_UNSUPPORTED）。
- 租户解析路径：无显式 policyVersion 时按租户 policyRevision（tenancy-v1）判定，visibility 完全不参与（test:685-711）。
- 本人另以独立脚本对 15 例矩阵直接求值：tenancy-v1 全部 allow 的 4 例在 workspace-v1 下仍 allow（**绝不更窄**），新增放行仅"workspace 标记 + 活跃成员"一例，跨公司/跨团队/suspended/无成员/异常 revision 全 DENY——与票面语义严丝合缝。

**AC3 显式动作 + 不自动扩范围 — PASS**
- 无清单/空清单：`resource-visibility.ts:82-96` 结构性提前返回（不开写事务、零 SQL），测试另以预标记原样存活钉死"零写入"（updatesExecuted=0）。
- 自动扩范围路径不存在（结构性审查）：唯一写入入口是 `migrateLegacyResourcesToWorkspaceVisibility`（显式清单）；`decide()` 全程只读（transaction 内无 UPDATE/INSERT）；DB 侧唯一授权面是 operator 的 `GRANT UPDATE("visibility")` 列级权限。无任何后台/启动/判定触发的标记路径。
- 清单纪律：清单外不触碰、已 workspace 幂等、'private' 绝不翻转（privateKept + 落库复核）、跨租户 id notFound 且零写入、迁移后仅 workspace-v1 团队公共而 tenancy-v1 仍 grant-only。

**AC4 跨公司永远拒绝、不泄露存在性 — PASS**
- 策略层：workspaceV1Decide 团队公共放行前置 `scope.tenantId !== resource.tenantId → DENY`（resource-policy.ts:156，MUT4 钉死）；tenancy-v1 本就拒绝。
- 服务层：真实 RLS 下跨公司行不可见 + 注册表内租户比对第二道独立防线；B 成员对 A 公司已发布资源两版本 DENY；**外部资源拒绝与不存在资源拒绝 verdict JSON 逐字节相同**（单一 deny 形状 `{deny, RESOURCE_NOT_FOUND}`，与生产 store 的 RESOURCE_NOT_FOUND 语义一致）；多公司身份本司 ALLOW / 他司 DENY。存在性无泄露。

---

## 4. 三项重点裁决

### 4.1 继承套件三处测试修复：**逐处判定 = 合理修复，无语义削弱**（并纠正 brief 一处前提）

**前提纠正（对复审事实的澄清，非实现 finding）**：三处修复全部位于 `server/tests/multitenancy/resource-policy.test.ts`——MT008 **本票新建**文件（before-hashes 标 NEW、manifest 归属本票交付），"继承"自本票第 2 次接管的在制品，**并非 prereq/MT005-era 交付测试文件**。prereq 21 文件清单中 18 项字节一致、3 项 DIFF 均为授权编辑；MT005 判定面（store.ts:161 WORKSPACE_FORBIDDEN seam、scope-gate、既有 8 文件 203 用例）零改动且在本轮全量复跑中全绿。前任版本未落任何存档（未跟踪文件、无 checkpoint），逐字 diff 不可能；故逐处判定基于：RED-2 的逐字失败现场 + **本人对所披露 bug 机理的可执行复现** + 现行断言的语义核对。

**修复① factsOf helper（解构嵌套键）**：本人以独立脚本复现旧行为——按 RED-2 披露的旧实现（整体 overrides 平铺进 resource 字面量），嵌套 `resource:{tenantId:"tenant-b"}` 覆盖落地为惰性键，`resource.tenantId` 仍为 tenant-a，跨公司 facts 退化为同团队 grantee+workspace → workspace-v1 **误 allow**——与披露的 criterion-4 两用例失败（Expected deny / Received allow）机理完全吻合。现行实现（解构 scope/grant/workspaceMembership，余键进 resource）经脚本验证：平铺覆盖生效（tenant-b → DENY）、grant/membership 覆盖正确归位。**判定：修复使覆盖语义生效，属修复而非削弱；且经修复后该两用例对"跨公司事实"的检验从失效变为真实（更严）。**

**修复② criterion-4 两个跨公司用例的调用点改平铺**：与①同根因的 4 处调用点之一部（矩阵 2 处 + 策略层 2 处）。现行 `factsOf({visibility:"workspace", tenantId:"tenant-b"})` 亲验产出真实跨公司 facts 并断言两版本 DENY——若覆盖失效该用例必失败（fail-open 变 fail-visible）。**判定：合理修复，断言强度提升。**

**修复③ suspended-member 用例重构**：原用例在停用后才 `scopeFor`，而 MT005 seam（store.ts:161，本人核对源码）对停用成员直接抛 WORKSPACE_FORBIDDEN，断言根本不可达——原用例测的是"seam 不会做的事"，失败是必然。现行用例：停用前合法取证 → 停用后 (a) **新取证被 seam 拒绝（WORKSPACE_FORBIDDEN 逐字钉死——seam 语义非但未弱化反而被显式钉住）**；(b) 旧（stale）scope 下 decide() 对团队公共资源 DENY——本人核对 decide() 的事实读取在判定事务内实时 JOIN 当前 membership 行（resource-policy.ts:305-330），非 scope 内嵌快照，故该断言真实检验"停用即时生效、stale scope 不冻结权限"这一安全关键性质；(c) grant 路径保留 ALLOW（与 authz 等价性一致：生产 authz.check 无成员状态条件）；(d) 复原后复 ALLOW。**判定：较原意图严格更强，无任何断言被弱化。**

**结论**：三处均属"使测试沿生产 seam 实际支持的路径检验票面验收事实"的正当修复；对 MT005 判定面无任何削弱影响（203 前置用例未动全绿 + WORKSPACE_FORBIDDEN 被新增钉死）。不构成 finding。

### 4.2 存活变异 MUT3a：**定级 medium（测试覆盖缺口），维持披露，建议可选跟进**

- 定位：`resource-visibility.ts` 迁移 UPDATE 的 `isNull(visibility)` WHERE 防线（现行 :166-172）无**独立**用例——单线程全部可观察行为由判定层守卫（`row.visibility === 'private' → privateKept`，:148-152）独立兜底，故单移除 SQL 防线存活；双防线同移除（MUT3b）即被 criterion-3 用例捕获。存档与披露（D3 + mutation/README）如实。
- 缺口本质：该 SQL 防线真实价值在 **读-判-写竞态**（TOCTOU）：迁移事务读到 NULL 后、UPDATE 前，另一写路径将行标为 'private' 并提交——READ COMMITTED 下 UPDATE 重读最新提交版本，有 isNull 防线则 0 行命中 → `VISIBILITY_MIGRATION_CONFLICT` 响亮回滚（私有不被扩大）；无防线则直接翻成 'workspace'。advisory 排他锁只串行化 迁移↔迁移 与 迁移↔判定（共享锁），对不取该锁的并发标记（如现行 fixture 的 markVisibility、未来成员自助标记路径 MT009/MT010）不设防——防线非冗余装饰。
- 定级理由（medium 而非 low）：它是安全相关"绝不扩大"性质的最后一道防线，其缺失对套件**不可见**；而非 high 的理由：实现侧防线**在位且正确**、AC3 全部可观察行为已有钉死、触发需要并发窗口 + 尚不存在的生产并发写路径。**处置：接受现状态（已诚实披露），不构成本票返工；可选跟进**——低成本方案是白盒断言生成的 UPDATE 语句保留 isNull 谓词（可直接杀死该变异），或在未来写路径票内补确定性交错测试。

### 4.3 migrate-test 窄例外最小性：**符合裁决 #5 先例，最小化**

- `migration-tool.test.ts` diff 亲验（changes.diff + 现树）：**仅 4 行**（3 行裁决注释 + 1 行断言 `["MT000","MT004","MT112"]` → `["MT000","MT004","MT008","MT112"]`），文件其余只读；注释链与 ruling #3→#5→本票先例文风一致，且实现 brief "ALLOWED_TASK_IDS 钉死注意"段**预授权**。
- 配套：`ALLOWED_TASK_IDS = [...TASKS.keys()].sort()` 与 `new Set(ALLOWED_TASK_IDS)toEqual(new Set(TASKS.keys()))` 断言同文件闭环（全量复跑含 migration-tool.test.ts 全绿亲验）；before 哈希 185c1ca3… 逐字节重建验证（changes.diff 头注 + 本人三方闭合复算）；migrate-test.ts 侧为纯追加新任务（RESOURCE_VISIBILITY_TASK 2 步）+ TASKS 表注册，无既有任务改动。
- **判定：规模（4 行）≤ 裁决 #5 先例，diff/哈希/披露三件套齐备，最小性成立。**

---

## 5. Findings（file:line 证据；无 critical/high）

| # | 级别 | 位置 | 内容 | 处置建议 |
|---|---|---|---|---|
| F1 | **medium**（测试覆盖） | `server/src/enterprise/tenancy/resource-visibility.ts:166-172`（防线本体）、`:148-152`（兜底守卫） | MUT3a 存活：UPDATE 的 isNull TOCTOU 防线无独立用例，单移除对套件不可见（§4.2）。实现正确、披露诚实，属覆盖缺口而非缺陷 | 接受 + 维持披露；可选跟进：白盒断言 UPDATE 语句含 isNull 谓词，或未来写路径票补确定性交错测试 |
| F2 | low（测试覆盖） | `resource-policy.ts:238-249`（POLICY_VERSION_INVALID）、`:246-248`（POLICY_VERSION_ALREADY_REGISTERED） | 注册表两处响亮拒绝分支（非法版本对象、重复 id）无任何用例触及；报告 §1.1 宣称"重复 id 响亮拒绝"但 29 用例未钉 | 可选：补 2 行级用例；非验收相关 |
| F3 | info | `server/src/db/schema/enterprise-tenancy.ts:236`（enterprise_resources `.enableRLS()`） | enterprise_resources 为 MT004 前既有表，仅 ENABLE 无 FORCE RLS。MT004 的 FORCE 惯例适用于**新表**；MT008 正确地未改既有 RLS 态（expand-only）。受限角色非表主，ENABLE 已对其生效，无功能缺口；"restricted roles were in play" 用例（current_user=ob_ent_data）亦钉死判定路径 | 无需动作；若未来统一 FORCE，另立票 |
| F4 | info | 复审事实澄清 | brief 重点项 1 所述"对 prereq 交付测试文件的修改"前提不成立：三处修复均在本票新建测试文件内（继承自本票前一次接管）；prereq 判定面零触碰（§4.1）。已按"逐处对照 + 机理复现"完成裁决，结论不受前提偏差影响 | 已在 §4.1 记录 |
| F5 | info | 复跑差异 | 本人全新库复跑 expect 计数 159/7836 vs 存档 158/7834：差值 = 全新库走 MT008 `applied` 分支（+1）与 legacy-anchor MT112 fresh-apply 分支（+1）的条件性 expect，环境依赖分支所致，非套件不确定性 | 无需动作 |
| F6 | info | `tests/multitenancy/support/resource-policy.ts` markVisibility | 测试夹具的 operator 标记路径不取 resource advisory 锁——与"生产尚无并发 visibility 写路径"现状一致（D5 stand-in 同源）；仅与 F1 竞态窗口相关，不构成独立问题 | 随 F1 一并考虑 |

**实现质量正面记录**：单一 deny 形状不泄露存在性；判定/迁移双入口锁键族与键序与 store.readLockKeys ∪ scope-gate 完全一致（tenant→principal→membership→workspace-membership→resource，亲验无死序）；`GRANT UPDATE("visibility")` 列级最小授权；parse 系函数对不变量破坏响亮拒绝；schema/迁移纯追加且无 DROP/REVOKE/POLICY/DELETE（正则钉死 + 本人核读语句）；D1–D7 披露经抽查全部属实。

---

## 6. TDD 链真实性独立评估

- **RED-1**（模块缺失现场，bun 原始报错格式）与接管叙事自洽；**RED-2**（as-found 26/3，逐字失败清单）与本人对所披露 bug 的机理复现**互相印证**；**GREEN-1**（29/0）与 RESTORE-green（复原后 grep 标记=0 + 29/0）齐全；mutation 4 变异 3 杀 1 存活、存活者如实定级而非抹平。after-hashes = 最终树 = sha256-manifest（29/29 亲算闭合）。
- 结论：链路完整、诚实、可复核。唯一不可复核点（前任在制品无逐字存档）已在 §4.1 说明并以机理复现替代。

## 7. 结论

MT008 交付物通过独立复审：Issue #51 四条验收全部成立（对照测试真实），代码质量良好，三处接管期测试修复均为正当修复，唯一存活变异已正确定级为披露的测试覆盖缺口（medium）。无 critical/high finding，无返工要求；F1/F2 为可选跟进。复审全程只读被审文件；复审容器与凭据已清理。
