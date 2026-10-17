# MT004 / Issue #47 — 独立复审报告（Independent Pi Reviewer）

- 复审者：独立 Pi Reviewer（Orca Task `task_70322419a303` / Dispatch `ctx_38779f5e5c60`）。只读审阅；与实现者（`task_4a94e96cd775`，已结算）无共享会话。
- 日期：2026-10-16。审阅工作树：`orca/workspaces/OpenBot/i6-review2-mt004`（branch `1123786563/i6-review2-mt004`）。
- 权威依据：`briefs/MT004-review-brief.md`（快照核验 → 四文件审阅 → 独立复跑 → 本报告）、Issue #47 四条验收、父 Spec `docs/specs/2026-10-14-company-team-multitenancy-design.md` §4.1/§4.2、协调者裁决 #3（migration-tool.test.ts :344 窄例外）。
- **总verdict：Spec compliance 通过（4/4 验收成立）；Code quality 通过，附 1 medium / 1 low / 2 info findings（均不构成验收阻塞，见 §4）。**

---

## 1. 快照核验（先做，全部亲自复算）

| 项 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- |
| `git rev-parse HEAD` | 与 `checkpoints/MT004/review-sha256-manifest.txt` 首行 BASE 一致（`f0520524` 开头） | `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` | ✅ |
| manifest 逐文件 SHA-256 复算 | 全部 OK | `tail -n +2 review-sha256-manifest.txt \| shasum -a 256 -c` → **40/40 OK，exit 0**（首跑在 checkpoint 目录内相对路径失败系本人路径错误，从仓库根重跑全 OK） | ✅ |
| `git status --porcelain` | 仅 `server/src/db/schema/enterprise-tenancy.ts` 为 tracked ` M`，其余为清单内 untracked | ` M server/src/db/schema/enterprise-tenancy.ts`；`?? docs/plans/2026-10-15-company-team-multitenancy-execution/`、`?? server/scripts/multitenancy/`、`?? server/tests/multitenancy/`；grep 其余 tracked 变更为空 | ✅ |
| `git diff server/src/db/schema/enterprise-tenancy.ts` 纯追加 | 0 删除、不改既有表/策略语义 | `git diff --numstat` = **70 insertions / 0 deletions**；diff 全部为 `@@ -314,3 +314,73 @@` 单一追加块（7 行注释 + 新表 `enterpriseWorkspaceMemberships`），未触碰任何既有表/策略行 | ✅ |

**纯追加核验结论**：`enterprise-tenancy.ts` 修改为纯追加（70/0），既有 7 张表（tenants/principals/memberships/workspaces/resources/resource_grants/security_events）的定义、约束、策略逐字未动。

## 2. 四个被审文件审阅（对照 Issue #47 + 父 Spec §4.1/§4.2 + 裁决 #3）

### 2.1 `server/src/db/schema/enterprise-tenancy.ts`（追加 `enterprise_workspace_memberships`）

- 唯一成员关系：复合主键 `(tenant_id, workspace_id, principal_id)`（:327-330）✅
- 复合外键双证明：`(tenant_id, workspace_id) → enterprise_workspaces(tenant_id, id)`（:341-346）与 `(tenant_id, principal_id) → enterprise_memberships(tenant_id, principal_id)`（:347-353），均 `ON DELETE cascade`，沿用 `enterprise_resource_grants` 的复合 FK 先例（:235-253）✅
- `status` CHECK `in ('active','suspended')`（:335-337）、`epoch` CHECK `> 0`（:338-339），与 `enterprise_memberships` 逐字同形（:87-97）✅
- RLS：`.enableRLS()` + 5 条策略，与 `enterprise_memberships` 的 5 条策略形状逐条对应（self_read EXISTS on principals.user_id / data_read tenant+principal / operator read+insert+update，`app.*` settings 用法一致）；GRANT 面与 `server/drizzle/0056_enterprise_tenancy_rls.sql:129-133` 同形（SELECT→directory/data/operator、INSERT→operator、`UPDATE ("status","epoch")`→operator）✅
- **偏差（→ Finding F1, medium）**：0056 对全部 7 张既有企业表除 ENABLE 外还执行了 **FORCE ROW LEVEL SECURITY**（0056:137-143），MT004 的 `0002_mt004_rls_policies.sql` 对新表仅 ENABLE，无 FORCE。

### 2.2 `server/scripts/multitenancy/migrate-test.ts`（追加 MT004 TASKS 条目）

- 本人对 pristine（`i6-mt003-fix2` 副本，SHA `330524de…` 与 prereq-manifest 一致）重算 diff：**0 删除**，两个 hunk = 追加 `WORKSPACE_MEMBERSHIP_TASK` 定义（73 行）+ 在既有 `TASKS` Map 中追加一行注册（1 行），合计 74/0，与报告声称一致 ✅
- TASKS 注册只含 DDL（CREATE TABLE / ADD CONSTRAINT FK / CREATE UNIQUE INDEX / REVOKE+ENABLE+CREATE POLICY / GRANT），**无任何业务数据写入** ✅
- GRANT/策略 SQL 与 drizzle 生成风格（0055/0056）逐字对照成立；`REVOKE ALL … FROM PUBLIC, ob_ent_*` 先于策略创建，与 0056 模式一致 ✅

### 2.3 `server/tests/multitenancy/membership-model.test.ts`（新建，15 用例）

- 环境契约：只认显式 `TEST_DATABASE_URL`（复用 `resolveTestDatabaseTarget` seam，拒绝在任何连接前）；基础企业表缺失时 `MT004_MEMBERSHIP_MODEL_BASE_SCHEMA_MISSING` 响亮失败——无 skipped-当-通过路径 ✅
- 验收 (1)：首插读回默认（active/epoch=1）+ 重复插入断言 `23505` ✅；验收 (2)：两条复合 FK 双向 `23503`（用未截断约束名前缀区分 workspace 侧 / principal 侧，处理了 PG 63 字节截断）+ 同 principal 加第二团队正控 ✅；验收 (3)：`revoked`→`23514`、epoch `0`/`-1`→`23514`、read-then-increase 三轮实测 [2,3,4]、suspend 翻状态保留行 ✅；验收 (4)：dry-run 预览 → apply 建表 → 重放 up-to-date，expand-only 断言（表清单 = 基线 + 新表 + 工具自有 journal；既有表 pg_policies 计数逐一不变；既有 `enterprise_memberships` 读写回归）✅
- 受限角色用例：operator 无租户上下文 `42501`（RLS 拒绝而非缺权限）、有上下文可插；data 角色只见自己 × 本公司的行、跨公司 0 行——证明最小 RLS 真实生效 ✅
- 夹具清理按前缀逆序删除，不触碰他人数据 ✅

### 2.4 `server/tests/multitenancy/migration-tool.test.ts`（裁决 #3 窄例外）

- 本人以 `i6-mt003-fix2` pristine 副本独立重算 diff，与存档 `checkpoints/MT004/migration-tool.test.diff` 归一化后 **逐字节一致（DIFFS-IDENTICAL）**：唯一 hunk 位于 :341-350，仅 `expect(ALLOWED_TASK_IDS).toEqual(["MT000"])` → `["MT000","MT004"]` + 3 行裁决注释；无其它任何改动 ✅ 最小性成立
- 复跑 42/42 pass（含 `MT003_ASSIGNED_TEST_DATABASE_URL` 指向真实库的 MT000 全链路 apply，0 skip）✅

### 2.5 TDD 与证据真实性

- RED→GREEN 存档为真：`RED-1` 是功能缺失型 RED（`Export named 'enterpriseWorkspaceMemberships' not found`，exit 1）；`GREEN-1` 10 pass/5 fail（测试侧缺陷）；`GREEN-2` 15/0/67 expect ✅
- 变异检查 4/4（MUT1 PK+唯一索引、MUT2a status CHECK、MUT2b epoch CHECK、MUT3 两条复合 FK 各自被对应用例捕获，均 exit 1），还原后全量 15/0（`RESTORE-full-suite-green.txt`）✅ 过滤复跑失败的顺序耦合问题已如实披露且未被当通过依据 ✅
- 诚实披露核实：pgvector 镜像偏差（`base-migrate-vector-error.txt` 现场存档，`vector.control` 缺失 `0A000`）与 brief 哈希笔误（39 位）均属实、记录在报告与 review-package.json ✅
- 披露补充（→ Finding F2, low）：`epoch` read-then-increase 的**并发局限**（两写者并发读到同一 current → 写出重复 epoch；DB CHECK 只兜底 `>0`）在 schema 注释（enterprise-tenancy.ts:319-320）、测试头注（membership-model.test.ts:8-9）与报告 §2 中均披露了机制，但未明示该非原子竞态。

## 3. 独立复跑（全部亲自执行；专用容器 `openbot-i6r2-mt004-pg` = `pgvector/pgvector:pg16`，端口 55453，库 `openbot_enterprise_mt004_review`）

前置：`lsof -i :55453` 空闲（exit 1）；容器启动后 `pg_isready` accepting；`enterprise-test-db.ts migrate` 一次通过（`{"type":"migrations-applied","status":"ok"}`，exit 0），三个 `ent_mt004r_*` 受限登录由 0600 临时 env 文件提供（建库后已删除，密码未入库未入报告）。

| # | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| 0 | `bun scripts/enterprise-test-db.ts migrate`（env→55453） | migrations-applied ok | **0** |
| 1 | `TEST_DATABASE_URL=…55453/openbot_enterprise_mt004_review bun test server/tests/multitenancy/membership-model.test.ts` | **15 pass / 0 fail**（67 expect，与实现者完全一致） | **0** |
| 2 | `MT003_ASSIGNED_TEST_DATABASE_URL=…（同库）bun test server/tests/multitenancy/migration-tool.test.ts` | **42 pass / 0 fail / 0 skip**（233 expect；含 MT000 真实 apply 全链路） | **0** |
| 3 | `bun test server/tests/multitenancy/inventory.test.ts`（单独） | 33 pass / 0 fail（5088 expect） | **0** |
| 4 | `bun test server/tests/multitenancy/fixtures.test.ts`（单独，含三受限角色 env） | 17 pass / 0 fail（146 expect）；identity-matrix 用例单独实测 **926ms** | **0**（两次复跑均 0） |
| 5 | **brief 原样组合** `bun test server/tests/multitenancy/inventory.test.ts server/tests/multitenancy/fixtures.test.ts` | 49 pass / **1 fail**：`fixture covers every Spec §11 minimum identity matrix class` **timed out after 5000ms**（bun 默认单测超时）。给定顺序 2 次、反序 1 次，共 3 次复现；反序同败 → 与文件顺序无关 | **1**（3 次） |
| 6 | 同组合 + `--timeout 30000` | **50 pass / 0 fail**（5234 expect，16.72s） | **0** |
| 7 | `cd server && bun run typecheck`（tsc --noEmit） | 无输出 | **0** |
| 8 | `bunx biome check` 四个被审文件 | Checked 4 files, No fixes applied | **0** |
| 9 | 清理：`docker rm -f openbot-i6r2-mt004-pg`；删 0600 env 文件；`lsof :55453` 复查 | 容器已删、env 已删、端口空闲 | 0 |

**第 5 行的定性（blocked，非 pass、非实现失败）**：brief 原样组合命令在本环境受 bun 默认 5000ms 单测超时影响，两文件并发进程争用（本机 10 核、容器无资源限制）使最重用例从单独运行 926ms 膨胀到 >5000ms。三项对照证明与 MT004 无关：(a) 涉事 `inventory.test.ts` / `fixtures.test.ts` 的 SHA-256 与 MT004 前的 prereq-manifest 完全一致（未被 MT004 改动）；(b) 两文件单独运行均 0 fail；(c) 同一组合命令提高单测预算后 50/0 全绿。另注：实现者的存档验证也未执行过该组合（其 #2 = migration-tool+inventory 75/0，#3 = fixtures 单独 17/0）。按 brief「环境阻塞项标 blocked + 原因，不当通过也不宣称失败」处理：**该项记 blocked（环境性、可复现、已对照定位），MT001/MT002 回归结论由 #3/#4/#6 共同成立**。

## 4. Findings（按严重度）

- **F1 [medium] 新表缺 `FORCE ROW LEVEL SECURITY`，偏离同库既有 RLS 硬化模式**
  证据：`server/drizzle/0056_enterprise_tenancy_rls.sql:137-143` 对全部 7 张既有企业表执行 FORCE；MT004 生成 SQL（`server/scripts/multitenancy/migrate-test.ts` `rls_policies` 步骤）与新表实际状态仅 ENABLE——复审容器实测 `pg_class`：`enterprise_workspace_memberships` `relrowsecurity=t, relforcerowsecurity=f`，其余企业表（除既有豁免的 `enterprise_settings` f/f）全部 `force=t`。
  影响：表属主（postgres）查询新表时绕过 RLS；应用数据面走非属主受限角色（测试已证 `42501` 生效），现暴露面有限。
  定性：不违反 Issue #47 四条验收，expand-only 未破坏；但报告「逐条对照同文件既有模式」未涵盖此属性。建议：后续补一条 `ALTER TABLE … FORCE ROW LEVEL SECURITY`（可并入 MT012 全面 RLS），或在 Spec/报告明示豁免理由。
- **F2 [low] `epoch` read-then-increase 的并发局限未明示**
  证据：enterprise-tenancy.ts:319-320、membership-model.test.ts:8-9、reports/MT004.md §2 均说明「单调递增由应用写入路径 read-then-increase 保证，CHECK 兜底正整数」，但未指出并发写者可读到同一 current 并写出重复 epoch（CHECK 只保证 `>0`，主键不约束 epoch 值）。
  建议：在 ADR/CONTEXT 或 MT005 消费契约中明示该竞态及预期串行化/重试责任；或后续以 `UPDATE … SET epoch = epoch + 1` 型原子写消除。
- **F3 [info] `enterprise_workspace_membership_principal_tenant` 唯一索引与复合主键列集重复（仅列序不同）**
  证据：enterprise-tenancy.ts:331-334 vs :327-330。与既有 `enterprise_memberships` 先例（:96-99，同样 PK+反序唯一索引）一致，属有意沿用；无需行动。
- **F4 [info] inventory+fixtures 组合运行对 bun 默认 5s 单测超时敏感（与 MT004 无关）**
  证据：§3 第 5/6 行。建议回归文档记录组合跑法需 `--timeout`（或拆分执行）；涉事文件未被 MT004 改动。

## 5. Verdicts 汇总

| 维度 | Verdict |
| --- | --- |
| 快照/哈希/纯追加核验 | **PASS**（HEAD=BASE；40/40 SHA-256 OK exit 0；git 状态符合预期；schema 70/0 纯追加） |
| Issue #47 验收 (1) 唯一成员关系 | **PASS**（复合 PK + 复跑 23505 实证） |
| Issue #47 验收 (2) 复合关联生效 | **PASS**（双复合 FK + 复跑双向 23503 实证 + 多对多正控） |
| Issue #47 验收 (3) status/epoch | **PASS**（CHECK 双向实证；read-then-increase 序列 [2,3,4]；并发局限披露不完整 → F2） |
| Issue #47 验收 (4) dry-run/重放/旧数据不变 | **PASS**（dry-run→apply→up-to-date 全链路复跑；expand-only 断言 + fixtures/inventory 回归） |
| RLS 最小新增与既有模式一致 | **PASS（附 F1 medium：FORCE 缺失）** |
| 裁决 #3 最小执行 | **PASS**（独立重算 diff 与存档逐字节一致，仅 :344 断言+3 行注释） |
| TASKS 注册无业务数据 | **PASS**（74/0 纯追加，仅 DDL） |
| TDD 证据真实性 | **PASS**（RED/GREEN/变异/披露全部核实为真） |
| 独立复跑 8 项命令 | 7 项 exit 0；brief 原样组合回归 1 项 **blocked（环境性，已对照定位，见 §3 第 5 行）** |

**最终结论：MT004 通过独立复审（succeeded）**——Issue #47 四条验收在本人独立复跑中全部成立，快照/哈希/纯追加/裁决 #3 最小性全部核实；F1/F2 作为后续改进项记录，不构成验收阻塞。
