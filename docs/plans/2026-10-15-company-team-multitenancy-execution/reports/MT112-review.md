# MT112 / Issue #155（第 1/2 段）— 独立复审报告（Independent Pi Reviewer）

- 复审者：独立 Pi Reviewer（Orca Task `task_9994da1edf39` / Dispatch `ctx_70187e0544da`），与实现者（`task_1f45a268faf6`）及前任被终止复审（`ctx_6e7588322c79`，stop_unverified、无产出）无共享会话。
- 日期：2026-10-16。工作树：`i6-review-mt112`，`git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`。
- 审阅对象：`server/src/db/schema/enterprise-tenancy.ts`（纯追加 `enterpriseDeploymentAnchors`）、`server/scripts/multitenancy/migrate-test.ts`（纯追加 MT112 TASKS 4 步）、`server/tests/multitenancy/migration-tool.test.ts`（裁决 #5 窄例外）、`server/tests/multitenancy/legacy-anchor.test.ts`（新建 21 用例）、`reports/MT112.md`、`checkpoints/MT112/**`。
- 只读约束遵守：未修改任何被审文件；本报告是本工作树唯一新建文件；无提交/推送/合并。

---

## 0. 结论（Verdicts）

**结论一：Spec compliance — PASS（四条验收全部通过，含裁决 #5 最小性、expand-only、RLS FORCE）。**

| # | 验收（brief） | 结论 | 关键独立证据 |
| --- | --- | --- | --- |
| 1 | 原有公司/默认团队创建幂等，重复执行不产生重复实体 | **PASS** | 语句级 `ON CONFLICT DO NOTHING` 逐条核对（migrate-test.ts MT112 步骤 0003/0004 全部 6 条 INSERT）；工具级重复 apply → `up-to-date`（独立 CLI 复跑 APPLY2 exit 0）；数据级原样重放计数不变（用例 + 变异 MUT2 佐证）；「全库最早用户」为单条 `INSERT…SELECT … ORDER BY created_at ASC, id ASC LIMIT 1`，**无先查后插竞态**（纯 SQL 原子语句，无应用层 TOCTOU） |
| 2 | 与既有部署身份及计费 Customer 的映射唯一且可核验 | **PASS** | 双唯一索引 + 派生 CHECK 在 catalog 实测存在（pg_indexes / pg_constraint）；23505（`enterprise_deployment_anchor_identity`）、23514（`enterprise_deployment_anchor_billing_derivation`）、42501（受限角色 INSERT 拒绝）三码全部由本复审独立复现；双侧 JOIN 命中各 1（psql 实测）；勘察结论逐条在真实源码核实（见 §3） |
| 3 | dry-run 预览 + manifest 执行 apply | **PASS** | 独立 fresh 库全链路：dry-run（4 步/15 语句）exit 0 → generate exit 0 → apply exit 0 → 重复 apply `up-to-date` exit 0；漂移 manifest 在任何 DB 副作用前被拒（用例）；journal 4 步 digest 与计划一致（用例）；**本复审独立生成的 manifest 与存档 `generated/MT112/manifest.json` 逐字节一致**（`f65c290e…`） |
| 4 | 既有单租户行为不变 | **PASS** | 三个被改文件 diff 全部纯追加 0 删除（§2 密码学核验）；用例断言表清单/既有表行数/夹具字段逐字/pg_policies 计数 apply 前后不变；全量回归 **146 pass / 0 fail / 0 skip，exit 0**（本复审独立复跑） |
| + | 裁决 #5 最小性（migration-tool.test.ts） | **PASS** | §4：13 行 diff 经 before/after 哈希密码学核验为**恰好全部改动** |
| + | expand-only 纯追加（schema + migrate-test） | **PASS** | §2：两份存档 diff 反向补丁重建 before 字节，哈希与锁定值逐字一致；`git diff --numstat` = 107/0 |
| + | RLS：新锚点表 ENABLE + FORCE | **PASS** | psql 实测 `relrowsecurity=t, relforcerowsecurity=t`；仅 1 条策略（operator 租户范围 SELECT）；`has_table_privilege` 实测 operator 无 INSERT、directory 无 SELECT；吸取 MT004 F1 教训本轮已含 FORCE |

**结论二：Code quality — 高。** 映射表设计最小且自证（派生 CHECK 焊死派生规则，双侧可 JOIN）；幂等策略一致且无竞态；工具链门禁（manifest/journal/digest）未被 MT112 削弱；测试 21 用例逐条映射四条验收并含 23505/23514/42501 行为级证据。**无 critical/high/medium finding**；2 条 low、3 条 info（§5）。

---

## 1. 快照核验（先做，全部通过）

- `git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`，与 `checkpoints/MT112/review-sha256-manifest.txt` 首行 BASE 一致 ✅
- 该 manifest 40 项逐条 SHA-256 复算：**40/40 一致**（本复审逐文件 `shasum -a 256` 独立重算，0 mismatch）✅
- Git 状态符合预期：`server/src/db/schema/enterprise-tenancy.ts` 为 tracked ` M`；`git diff --numstat` = **107 insertions / 0 deletions**（= 70 行 MT004 既有未提交追加 + 37 行 MT112 追加，见 §2 对照实现报告「70+N 行 0 删除」）；其余为清单内 untracked（`server/scripts/multitenancy/`、`server/tests/multitenancy/`、`docs/plans/.../`）✅
- `checkpoints/MT112/sha256-manifest.txt` 26 项自检：以 plan 目录为路径基准复算 **26/26 一致**（注意：该清单内路径相对 `docs/plans/2026-10-15-company-team-multitenancy-execution/`，从工作树根复算会全部 miss——本复审先误判后修正，非文件缺陷）✅

## 2. 纯追加核验（密码学级，非仅 diff 目测）

方法：对三份存档 diff 各自做 `patch -R` 反向应用到当前文件，重建「before 字节」，与 `before-hashes.txt` 锁定哈希比对；当前文件哈希与 `after-hashes.txt` 比对。重建哈希一致 ⇔ 存档 diff **恰好**等于真实全部改动。

| 文件 | before（锁定） | 重建结果 | after | 结论 |
| --- | --- | --- | --- | --- |
| `enterprise-tenancy.ts`（存档 diff = 37 行纯追加 MT112 块） | `c4fc5145…` | **一致** | `f9e312a7…` 一致 | MT112 schema 改动 = 纯追加 37 行、0 删除；重建 before 与 `git show HEAD:` 的 diff = `316a317,386` 恰为 MT004 块 70 行纯追加（70+37=107，与 numstat 完全对账） |
| `migrate-test.ts`（存档 diff = 107 行纯追加） | `cb0891c6…` | **一致** | `b87caeb4…` 一致 | MT112 工具改动 = 纯追加 107 行、0 删除（LEGACY_ANCHOR_TASK + 注册表 1 行） |
| `migration-tool.test.ts`（存档 diff = 13 行） | `75bd28f9…` | **一致**（重建脚本见 §4） | `185c1ca3…` 一致 | 见 §4 |

三处「70+N 行 0 删除」的表述与字节事实完全吻合。

## 3. 勘察结论核验（亲自打开源码，全部属实）

| 报告主张 | 实测 | 结论 |
| --- | --- | --- |
| `deployment_packages.tenant_id` 为 UNIQUE 持久化部署身份（core.ts:261 附近） | `core.ts:263` `tenantId: text("tenant_id").notNull().unique()`；`synchronizeTenantPackage` 于 `tenant-package.ts:797` upsert，tenant id 源自 `tenant-package.ts:619` `requiredString(tenant.id, …)` | ✅ 属实 |
| `billing_customers.external_id` 主键（billing.ts:18 附近） | `billing.ts:18` `externalId: text("external_id").primaryKey()`，表注释明示 keyed by deployment identity | ✅ 属实 |
| `deploymentExternalCustomerId` = `'openbot-deployment-' || tenantId`，唯一定义点（service.ts:54 附近） | `billing/service.ts:54-56`（return 在 :55），grep 全库 `openbot-deployment-` 仅此一处定义 | ✅ 属实 |
| `DEPLOYMENT_ID` env 边界披露 | `config.ts:2787` `deploymentId: optional(environment, "DEPLOYMENT_ID")`；生效身份 `config.deploymentId ?? tenantPackage.tenantId`（`index.ts:841/1274/1320/3721`，报告写 3720 为 ±1 笔误，不影响结论）；迁移只见持久化身份的边界披露**准确** | ✅ 披露属实 |
| 企业域既有表无部署映射表 | `enterprise-tenancy.ts` 既有导出逐一核对，无映射表；新增 `enterprise_deployment_anchors` 为最小纯追加 | ✅ 属实 |
| 披露 #2「锚点用户已有他租 principal 会响亮失败」 | `enterprise_principal_user` UNIQUE btree (user_id) 实测存在（pg_indexes） | ✅ 披露属实 |

## 4. 裁决 #5 最小性（独立重算比对）

1. 存档 `migration-tool.test.diff` 共 **13 行**：4 行头 + `@@ -344,7 +344,9 @@` + 5 行上下文 + 1 行删除（`expect(ALLOWED_TASK_IDS).toEqual(["MT000", "MT004"])`）+ 3 行新增（2 行裁决注释 + 1 行断言 `["MT000","MT004","MT112"]`）。
2. 本复审**独立重建** before 文件（当前文件删去 2 行注释、断言回退 `["MT000","MT004"]`），`shasum -a 256` = `75bd28f902ce9faed706d46a49c1b4dfc4e797c5ca79e9748b91e7d52260678d`，与锁定 before 哈希**逐字一致**；当前文件 = `185c1ca3…` 与 after 一致。⇒ 存档 13 行 diff 即真实全部改动，**无任何第 14 行**。
3. 本复审另行 `diff -u 重建before 当前`，输出 13 行、逐行与存档 diff 一致（仅时间戳不同）。
4. 全文件 `grep -c "MT112"` = 3（2 注释 + 1 断言），无其它 MT112 痕迹。**最小性成立。**
5. 附注（info）：hunk 位于 :344 起，`":347 断言"` 指改动前文件行号；插入注释后该断言现于 :350。语义无影响。

## 5. Findings（按严重度；无 critical/high/medium）

| 级别 | Finding | 证据 |
| --- | --- | --- |
| **low** | **复跑 runbook 缺一步前置**：`reports/MT112.md` §5 验证命令 #1 的字面复现（fresh 库上 `enterprise-test-db.ts migrate` → 直接跑 legacy-anchor 套件）会失败：基础迁移只建已提交 drizzle 链的表，不含 `enterprise_workspace_memberships`（该表由 MT004 任务经 migrate-test.ts 创建），`assertBaseSchemaPresent` 以 `MT112_LEGACY_ANCHOR_BASE_SCHEMA_MISSING` 响亮拒绝（legacy-anchor.test.ts:100）。本复审首跑即命中（0 pass / 2 fail），补跑 `migrate-test.ts migrate MT004 --apply` 后 21/0。**非验收缺陷**——响亮失败而非静默 skip 正是该套件声明的契约——但实现报告应写明「先 apply MT004 再跑本套件」，否则按报告逐字复现者会在首次尝试失败。 | 本复审实测；报告 §5 未列该前置 |
| **low** | `legacy-anchor.test.ts:652-657`（criterion 3 第二用例）在重放库分支只断言 `pending` 为空，fresh 库分支才断言完整预告（4 步、CREATE TABLE、ON CONFLICT）。即 dry-run 预告内容的**完整**断言依赖 fresh 库状态；共享库连续复跑时该覆盖自动降级。已在测试头注与用例内注释披露，fresh 库 CLI 链独立补足；仅提示后续维护者勿删 fresh 分支断言。 | legacy-anchor.test.ts（dry-run 用例双分支） |
| **info** | 全量回归 expect 计数 7524（本复审）vs 存档 7521：分支依赖断言数（fresh-apply 与 replay 路径的 expect 数不同）所致；不变量为 **146 pass / 0 fail / 0 skip / exit 0**，两轮均满足。 | 本复审复跑 vs `verification/full-regression.txt` |
| **info** | 报告 §3 称生效身份取值在 `index.ts:3720`，实测为 3721（±1 行号笔误，无实质影响）。 | `index.ts:3721` |
| **info** | 正面确认：实现报告 §7 五条已知边界逐条对照源码/库目均属实（含 `enterprise_principal_user` 唯一索引支撑边界 #2；MUT2 假跑诚实披露与 `mutation/README.md` 一致）。诚实披露质量高。 | §3 表 + mutation 存档 |

## 6. 独立复跑命令与退出码（本复审亲自执行，专用库 pgvector/pgvector:pg16 @ 127.0.0.1:55459）

前置：`lsof -i :55459` 发现前任遗留容器，为独立性 `docker rm -f` 后按 brief 原命令重启（`openbot-i6r2-mt112-pg`，`POSTGRES_DB=openbot_enterprise_mt112_review`，trust，`--rm`）。

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `docker exec … pg_isready` | 0 | READY |
| 2 | 0600 临时 env（3 个 `ent_mt112r_*` 随机密码受限登录，用后即删，密码未打印未入库）+ `cd server && bun scripts/enterprise-test-db.ts migrate` | **0** | `{"type":"migrations-applied","status":"ok"}` |
| 2b | `bun --no-env-file scripts/multitenancy/migrate-test.ts migrate MT004 --apply --manifest <独立 generate 产物>`（前置，见 finding #1） | **0** | MT004 2 步入账 |
| 3 | `bun test tests/multitenancy/legacy-anchor.test.ts`（TEST_DATABASE_URL → 55459 review 库） | **0** | **21 pass / 0 fail / 255 expect**（与存档 GREEN-1 一致） |
| 4 | `MT003_ASSIGNED_TEST_DATABASE_URL=… TEST_DATABASE_URL=… ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL=… bun test tests/multitenancy/` | **0** | **146 pass / 0 fail / 0 skip / 7524 expect / 6 文件**（无需 `--timeout` 加跑） |
| 5 | CLI 链（另起 fresh 库 `openbot_enterprise_mt112_cli_review`：base migrate 0 → MT004 apply 0 → psql 逐条种子 deployment/billing/user）：<br>`migrate-test.ts migrate MT112`（dry-run）→ `generate MT112 --out` → `migrate MT112 --apply --manifest` → 重复 apply | **0 / 0 / 0 / 0** | dry-run 预告 4 步/15 语句；apply 4 步入账；重复 apply `up-to-date（已应用 4 步）` |
| 5b | psql 复核（同上 fresh 库）：锚点租户 `ent-legacy-original/原有公司`、workspace `ent-legacy-default-team/默认团队`、最早用户 principal `entp-legacy-anchor-cli-review-user-1` + tenant_admin + workspace 成员（epoch=1）、映射行恰 1 且 `dp_join=1, bc_join=1`、`relrowsecurity=t, relforcerowsecurity=t`、pg_policies 恰 1 条 operator SELECT、23505/23514/42501 三码独立复现、operator 无上下文读 0 行、directory 无 SELECT 权 | — | **全部符合** |
| 6 | `cd server && bun x tsc --noEmit` | **0** | 无输出（无类型错误） |
| 6b | `bunx biome check` 四个被审文件 | **0** | Checked 4 files. No fixes applied. |
| — | 确定性旁证：本复审独立 `generate MT112` 产物与存档 `generated/MT112/manifest.json`、`0001…sql`、`0003…sql` **逐字节一致**（`f65c290e…`/`063de7de…`） | — | buildPlan 跨环境确定性成立 |
| 7 | 清理：DROP cli review 库、删除两份 0600 env、`docker rm -f openbot-i6r2-mt112-pg`、`lsof :55459` 无监听 | 0 | 完成 |

复跑中的两次挫折均属复审侧操作而非交付物缺陷，如实记录：(a) finding #1 的 MT004 前置缺失（响亮失败）；(b) psql 多语句 `-c` 隐式事务导致 users 种子失败并回滚同批种子，使首轮 CLI 链出现 0 映射行——该行为恰好实证披露边界 #3（无 `deployment_packages` 行 → 锚点映射 0 行，不臆造实体）。重建种子后全链通过。

## 7. TDD/mutation 真实性核验

- RED：`red-green/RED-1-missing-export.txt` = `SyntaxError: Export named 'enterpriseDeploymentAnchors' not found`，exit 1——**缺失导出型 RED**（brief 要求的类型），非笔误 RED ✅
- GREEN 两轮：GREEN-1 21/0/exit 0（fresh 库，255 expect）；GREEN-2 21/0/exit 0（重放库，256 expect），并如实记录了重放暴露的 criterion 4 分支缺陷修复 ✅
- MUT1–MUT4 存档尾部均为 exit 1 且靶向用例失败（19/2、20/1、19/2、20/1）；`mutation/README.md` 与报告 §4 的 MUT2 假跑披露一致 ✅
- 本复审未重做 mutation（brief 未要求），仅核验存档自洽性与哈希。

## 8. 复审约束遵守声明

- 被审文件零修改（快照哈希在收尾时仍可复验）；本报告为唯一新建文件；无 git 写操作；无 skipped/blocked 被计为通过（本轮无 blocked 项）。
- 证据优先：所有 PASS 判定均基于本复审亲自执行的命令与退出码，或密码学哈希比对，不以实现报告自述为据。

— Independent Pi Reviewer, 2026-10-16
