# MT123 / Issue #166（启动装配净化域）— 独立复审报告

- 复审者：独立 Pi Reviewer（Orca Task `task_3c1641a09948` / Dispatch `ctx_04f17f4f3e25`），与实现者（w15-mt123 会话）无共享会话。
- 日期：2026-10-18。工作树：`r15-mt123`，`git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（BASE+268 prereq+本票增量 4，与 brief 面一致）。
- 复审方式：只读 + brief 明示授权的重放（三步配方 provision、聚焦/全量复跑、变异重注入、哈希密码学核对）。零 git 提交；被审文件零修改（变异注入均在收尾前逐位复原，收尾复测冻结面仍恰 2 处授权漂移）。
- 审阅对象：`server/src/enterprise/tenancy/startup-defaults.ts`、`server/src/index.ts`（装配 3 hunk）、`server/tests/multitenancy/startup-defaults.test.ts`、`server/tests/multitenancy/entry-context.test.ts`（令牌整改版）、`reports/MT123.md`、`checkpoints/MT123/**`。

---

## 0. 结论（Verdict）

**PASS — Spec compliance 与实现质量均予确认。** 四条 AC 的结构保证、测试断言与变异自证全部独立复现；冻结面 268 项逐位核对 + 4 项交付物哈希全部对账；R1 令牌整改与 wave14 §4-2 先例同构且双哈希密码学成立。**无 critical/high/medium finding**；2 条 low、4 条 info（§6）。

| 复审项（review-brief 必做） | 结论 | 关键独立证据 |
| --- | --- | --- |
| 1. 三步配方 provision（r15a 库名 + 端口 55586 + 同容器 w15d 库 + env 指向 + 修正链序 + bun install） | ✅ | §1：19/19 journal、36 步入账 |
| 2. 聚焦 startup-defaults.test.ts（24/0/75）+ 全量（1148/0/44） | ✅ 精确达成 | §2：24/0/75 实测；1148/0/44 实测（expect 12877，与存档 12874 差 +3，见 F-info-1） |
| 3. 变异抽验 ≥3（含 MUT4+MUT1）重注入→捕获→字节复原 | ✅ 4/4 KILLED | §3：MUT1/2/4/5 全 KILLED，计数与存档逐一相符，RESTORE 逐位复原 + 终版复绿 24/0 |
| 4. 冻结面 272 项哈希核对（268 frozen + 4 增量；令牌差异 diff 恰为断言 1 行+注释 2 行） | ✅ | §4：266/268 不变 + 2 授权漂移；逆向重建双哈希逐位命中；diff 组成恰 1+2 |

## 1. 环境与 provision（三步配方从零，全程亲跑）

1. `bun install`：**1415 packages [3.67s]**（全新 worktree 无 node_modules）。
2. 专用容器：`mt123-review-pg`（pgvector/pgvector:pg16 @ **127.0.0.1:55586** loopback，`pg_isready` READY；开工前端口空闲实测）。
3. 库与角色（psql 逐条 `-c`，KB 属主角色**先于**建库，均 NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION）：
   - **r15a 组**（review-brief 票面命名）：`openbot_enterprise_r15a_test`、`_assigned`、`openbot_kb_r15a_test`（属主 `ent_r15a_kb`）；
   - **w15d 组**（实现者同款环境对齐——`entry-context.test.ts` 与 `startup-defaults.test.ts` 均以字符串断言钉死库名 `openbot_enterprise_w15d_test`，整改版属已披露交付面，故 env 指向 w15d 组）：`openbot_enterprise_w15d_test`、`_assigned`、`openbot_kb_w15d_test`（属主 `ent_w15d_kb`）。
4. 七变量 env（0600，用后删）→ w15d 组 @ 55586；`enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}`。
5. 前置任务链 generate+apply 按**修正链序** 19 任务逐条执行（MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059），**全部 rc=0**；journal 实测 **19 tasks / 36 steps**。MT123 本票无迁移任务（无 DB schema 交付面），链后无本票任务——与报告 §2 一致。
6. 收尾：`docker rm -f mt123-review-pg` 回显 + `docker ps -a --filter` 空输出；0600 env 删除。

## 2. 复跑（聚焦 + 全量）

| 项 | 存档期望 | 本轮实测 | 判定 |
| --- | --- | --- | --- |
| 聚焦 `startup-defaults.test.ts` | 24 pass / 0 fail / 75 expect | **24 / 0 / 75**（821ms） | ✅ 精确一致 |
| 全量 `tests/multitenancy` | 1148 / 0 / 44 文件（12874 expect） | **1148 / 0 / 44**（12877 expect，27.54s） | ✅ 不变量精确一致；expect +3（F-info-1） |
| skip 纪律 | DB 缺 env 显式 skip 不计通过 | 本轮带 env **0 实际 skip**；另做无 env 对照跑：7 skip（5 用例 + 2 describe 钩子项）全部带原因，**无开发库回退** | ✅ |

## 3. 变异抽验（≥3，含 MUT1+MUT4；注入→聚焦捕获→字节复原→终版复绿）

复用存档 `mutation/run.sh` 的注入语义，独立重放 4 个变异（全部以 24 用例全量捕获，含 DB 组）：

| MUT | 注入点 | 实测捕获 | 存档 | 判定 | RESTORE |
| --- | --- | --- | --- | --- | --- |
| MUT1 | 多租户臂默认公司复辟（`defaultCompanyTenantId: facts.tenantPackageTenantId ?? null`） | 23 pass / **1 fail** / 75 expect | 23/1/75 | **KILLED** | byte-identical（2c426e70…） |
| MUT2 | 单租户种子丢弃租户包回退 | 23 / **1** / 75 | 23/1/75 | **KILLED** | byte-identical |
| MUT4 | 多租户绕过可装配（`devBypassMounted: facts.singleUser`） | 23 / **1** / 75 | 23/1/75 | **KILLED** | byte-identical |
| MUT5 | `scopeThreadIdentity` 种子换进程常量（per-scope 派生失效） | 21 / **3** / 69 | 21/3/69 | **KILLED** | byte-identical |

终版复绿 **24/0/75**，pristine sha256 = `2c426e7071f5…` 与 GREEN 态逐位一致。pass/fail/expect 计数与存档 `mutation/results.txt` **逐一相符**（含 MUT5 的 69 expect 细节），存档无美化迹象。
程序性备注：首轮重放曾在未 source env 下捕获（7 个响亮 skip、捕获仍 fail>0），随即带 env 重做——上表为带 env 终版数字。

## 4. 冻结面哈希核对（268 frozen + 4 增量 = 272 项）

- **268 项 prereq 逐文件重算 sha256：266 项逐位一致、0 缺失、恰 2 处漂移**——漂移恰为本票两个授权面（`server/src/index.ts`、`server/tests/multitenancy/entry-context.test.ts`），与 `after-hashes.txt`、`06-hash-drift.txt` 完全一致。变异重放后复测仍为恰 2 处，树内无残留。
- **逆向重建（`patch -R`）密码学核对**：以当前文件反应用两份存档 diff，重建 before 字节：
  - index.ts 重建 before = `f921e0899dbb…` = before-hashes 锁定值 **逐位一致** ⇒ 存档 87 行 diff（恰 **3 hunk**：import / dev-actor 种子改经 `mountDevBypass` / 租户包后启动净化装配）即全部改动，无隐藏行；
  - entry-context.test.ts 重建 before = `d7e4d400a5e6…` = 锁定值 **逐位一致**。
- **交付物 4 项哈希**（当前树实测 = `07-deliverable-hashes.txt` = 报告 §6）：startup-defaults.ts `2c426e70…`、index.ts `147537de…`、startup-defaults.test.ts `06621f67…`、entry-context.test.ts `85711a4e…` ✅。
- **令牌整改最小性**：`narrow-seam-entry-context-test.diff` 组成实测为 **3 删 + 3 增 = 注释 2 行 + 断言 1 行**（`expect(identity.database)` 的 `w14int` → `w15d_test`），恰为 review-brief 规定的「断言 1 行+注释 2 行」，无第 7 行。✅

## 5. 专项核验

- **AC1「有测试断言」真实性：属实。** 深冻结不是声明而是断言钉死：`Object.isFrozen` + `assignmentThrows`（严格模式赋值抛 TypeError）对三种字段、两种模式分别断言；per-scope 身份 4 例纯函数 + **真实 MT122 工厂三 scope 运行时例**（跨 scope 指纹互异且互不认领、同 scope 稳定、每请求新实例；公司 B 无配置行 → `RUNTIME_CONFIG_NOT_FOUND` fail-closed）。断言面位于净化域边界 + 真实工厂消费面，与「启动后不存在进程级可变当前公司/团队状态」的验收语义相称（净化域是唯一落点，index.ts 另有 fail-closed null 守卫）。MUT1/MUT5 重放佐证断言非空转。
- **AC2 双向断言：属实。** 多租户方向：`singleUser:true` 请求挂载仍被拒（测试 + MUT4 本轮重放 KILLED；MUT6 存档 23/1/74 同型）；单租户方向：`devBypassMounted` 跟随 `config.singleUser` 且 true 案例显式保留、线程种子与 legacy 表达式逐字节同义（MUT2 本轮重放 KILLED）。`mountDevBypass` 为唯一规则源、两挂载点共消费（index.ts:807 与 resolveStartupDefaults 内），R-MT123-4 的「装配点早于租户包」结构约束已在代码注释与 diff 中如实披露。
- **AC3 对照测试存在性：属实。** 真实 createApp 双模式（多租户侧挂真实库构造的 MT122 工厂）：①method+path 多重集逐项相同，且多租户唯一增量 = 恰一枚 `ALL /api/*`（单列计数断言）；②`/health` `/ready` `/api/me` 状态码相等 + DTO **全 body** `toEqual`（强于键集对照）；③选择头无会话：多租户 401 canonical `AUTH_REQUIRED` vs 单租户同请求 404 不受影响。`appFor` 位置参数缝与既有 `global-exceptions.test.ts:655-663` 同型（F-info-2）。
- **AC4 与 MT013 判定纪律一致性：属实。** `residueValue` 与 `startup-checks.ts:245-251` **逐字相同**（false/0/空/未设置不算残留）；finding source 与 env detail 措辞同 MT013（`config.singleUser`/`OPENBOT_SINGLE_USER`/`OPENBOT_DEV_NO_AUTH`）；缺口一次列全（5 findings 同批断言）；verdict 形状同构（恰好一条结构化记录 + log/exit 可注入 + 拒绝 exit(1) 恰一次）。四类缺口（entryContext / 显式 DEPLOYMENT_ID / singleUser / 双 env 残留）+「显式关闭不算残留」+「单租户恒 ok」均各有断言；MUT3 存档 21/3 佐证。
- **R1 与 wave14-integration §4-2 同构性：成立。** 结构逐项对应：票面令牌与硬性规定冲突 → `orca orchestration ask` 升级无应答 → 按两条硬性规定交集做最小令牌微修（断言语义不变）→ RECTIFIED 双哈希披露 → 可逆向回退。双哈希（`d7e4d400…` → `85711a4e…`）经本复审逆向重建**密码学证实**；反向补丁可一行回到 w14int 态（已实测重建成功）。唯一差异：ask 超时 10 分钟 vs wave14 的 30 分钟（F-info-4）。
- **R-MT123-3（index.ts 存量 biome 口径）独立证实：** 逆向重建的 prereq 态 index.ts 单独跑 biome 得**同 5 处**（4 noConsole + 1 noNonNullAssertion），行号位移恰等于 hunk 行数增量（+21/21/21/56/56）⇒ 零增量披露属实。**R-MT123-5（变异脚本纪律教训）与存档 results.txt 自洽**（单次连续 6/6 KILLED + 每步 RESTORE-VERIFIED）。**RED 类型**：`Cannot find module`（功能缺失型，0 pass/1 fail/1 error）符合 brief 要求。

## 6. Findings（无 critical/high/medium）

| 级别 | Finding | 证据/建议 |
| --- | --- | --- |
| low | **F-low-1：聚焦套件环境探针只查 5 变量**（TEST/SETUP/DIRECTORY/DATA/OPERATOR），不含 `MT003_ASSIGNED_TEST_DATABASE_URL`/`KB_TEST_DATABASE_URL`。只配 5 变量的环境里 DB 组会带残缺 env 起跑，失败形态取决于下游校验而非显式 skip。非本票验收缺陷（本轮七变量齐全全绿；契约主句「只认显式专用库 env，绝不回退开发库」仍成立），建议后续把探针补齐到七变量或在套件头注明七变量要求。 | startup-defaults.test.ts probeEnvironment（5 项清单） |
| low | **F-low-2：报告 §3 全量 expect 数（12874）无环境分支说明**。本复审同库同码实测 12877（+3）：MT112 复审已证该家族存在分支依赖断言数（fresh-apply vs replay 路径 expect 数不同），不变量 1148/0/44 两轮均成立，但报告把 expect 计数写死易让逐字复现者误判漂移。建议后续报告对 expect 数标注「分支依赖，±N 正常」。 | 本轮 §2 vs 存档 01/05 |
| info | **F-info-1：全量 expect 12877（本复审）vs 12874（存档）**，同 F-low-2 根因；不变量 1148/0/44/exit 0 两轮一致。 | §2 |
| info | **F-info-2：`appFor` 以 `createApp.length` 定长数组 + 位置下标（COWORKER_ARG=34）注入**，脆但与 global-exceptions.test.ts 既有装配缝完全同型，属仓库既定模式而非本票新引入的债。 | global-exceptions.test.ts:655-663 |
| info | **F-info-3：review-brief「272 项」为 268 frozen + 4 增量的合计口径**；checkpoints 的 before-hashes 载 268 项 + BASE 行。本报告按两段各自核清，合计 272 全对账。 | §4 |
| info | **F-info-4：R1 的 ask 超时 10 分钟短于 wave14 §4-2 的 30 分钟先例**。同构性不受影响（两案均升级在先、处置在后、双哈希在档、可逆向），仅时限参数不同，不影响裁定有效性。 | §5-R1 |

正面确认：报告 §1/§3 的全部实测数字（24/0/75、1148/0/44、MUT1-6 计数、5 处存量 biome、19/19 journal、容器清理）经独立复现**无一失实**；两份存档 diff 经逆向重建证明即为全部改动；诚实披露质量高（R-MT123-1/4/5 均主动披露边界与过程教训）。

## 7. 复审约束遵守声明

- 被审文件零修改：`startup-defaults.ts` 变异注入 4 次均逐位复原（收尾复测 sha256 = `2c426e70…`）；冻结面收尾复测仍恰 2 处授权漂移；index.ts 逆向核对用的临时文件已删除。
- 本报告为本工作树唯一新建文件；全程零 git 提交/推送；无 skipped/blocked 计为通过（本轮带 env 复跑 0 实际 skip）。
- 证据优先：所有 PASS 判定基于本复审亲跑命令与退出码或 sha256/逆向补丁密码学比对，不以实现报告自述为据。

— Independent Pi Reviewer, 2026-10-18
