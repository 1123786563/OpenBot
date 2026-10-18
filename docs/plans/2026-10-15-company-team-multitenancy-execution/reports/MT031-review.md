# MT031 独立复审报告 — 插件目录与安装归属（Issue #74）

- 复审者：独立 Pi 会话（Orca task_f36c0c724d4f / dispatch ctx_c71d1d639746），全新上下文，未参与实现
- 复审对象：`checkpoints/MT031/sha256-manifest.txt` 划界的 8 个代码文件 + 全部存档（red-green / mutation / verification / migration/generated）
- 复审性质：**只读复审 + 独立复跑**（除 brief 明示的变异注入/恢复闭环外零改动）
- 结论先行：**PASS（附 1 条 Medium + 1 条 Low + 2 条 Info findings，均不影响判定，见 §6）**——MT031 建议转 verified

## 0. 复审环境与独立复跑（全部亲测，非采信存档）

| 项 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | 1415 包安装成功（D7 披露属实：工作树缺 eventsource 等，须先装） |
| 端口预检 55572 | 空闲 |
| 容器 | `mt031-review-pg`（pgvector/pgvector:pg16，127.0.0.1:55572，POSTGRES_DB=openbot_enterprise_r14b_test），测毕 `docker rm -f` 回显 `mt031-review-pg`、复查为空（coordinator 可亲验） |
| 库名 | `openbot_enterprise_r14b_test` / `openbot_enterprise_r14b_assigned` / `openbot_kb_r14b_test`，登录角色 `ent_r14b_{directory,data,operator,kb}`，满足 `enterprise-database.ts` 硬守卫（`openbot_enterprise_*` 命名、回环、受限角色 options 装配） |
| env | 七变量 0600 副本，用后已删 |
| base migrate | `enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}` |
| 迁移链 | MT000→MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031，18 任务 35 步逐任务三步配方（dry-run → manifest → --apply）真实执行；journal 18 行与实现者 `16-journal-final.txt` 逐一吻合 |
| MT031 planDigest | 本机复算 `f73bb8ab65ccb8d02c09a6a833994e0b29eb112c35bcfbaa3892c8db1a8bdcb8`，与存档 manifest 逐字节一致（0001=13 语句 / 0002=25 语句，step digest 亦一致） |
| 聚焦 `plugin-install.test.ts` | **35 pass / 0 fail / 0 skip** ✓（变异恢复后 sanity 复跑再证 35/0） |
| 全量 `tests/multitenancy/` | **1025 pass / 0 fail / 39 文件 / 0 skip**（12363 expect）✓ 与 brief 预期逐位一致 |
| typecheck（server，tsc --noEmit） | 0 错误 ✓ |
| biome 2.5.10 | 4 个全新文件 + schema/index.ts + migration-tool.test.ts 全 clean；src/index.ts 残留恰 5 处（4×noConsole @842/867/887/1931 + 1×noNonNull @4796，行号自领取态 +4 平移 = 本票 4 行 import 追加，与 15-edit-point-deltas 自洽）；**migrate-test.ts 有 6 处 format 违规 → 见 F-2** |
| 活库抽查（psql 直查） | 三表 relrowsecurity=t 且 relforcerowsecurity=t；目录 `operator_delete` 等租户臂策略真实在位（MUT-5 掩蔽层实证）；授权矩阵抽查 directory 零 SELECT、data 零 INSERT、operator 连接零 UPDATE、operator 安装 DELETE=true，与 0002 逐格一致 ✓ |
| 清理 | 容器销毁回显 + 复查为空；env/临时产物全删；**复审后 10 个边界文件 sha256 与复审前逐一一致**（60528cb3/756f131f/f8888a51/516f5a3c/7d46db44/f7eb95b9/d356aaf9/027af1d6/9aca2543/b14a0683） |

## 1. 边界核对：manifest vs 本树哈希

- **8 个交付文件哈希逐一复算，与 `13-after-hashes.txt` 完全一致**（4 新建 + 4 修改）✓
- **冻结面零改动**：`credential-ownership.ts`（9aca2543…）、`enterprise-credentials.ts`（b14a0683…）与领取时逐字节一致 ✓
- **240 项 prereq 清单复算**：236/240 OK；恰 4 项 FAILED = 本票 4 个授权修改点（migrate-test.ts、schema/index.ts、src/index.ts、migration-tool.test.ts），其余全部逐字节未动——**冻结面核对通过** ✓

## 2. 专项核对 A——变异掩蔽披露（MUT-5）

实现者披露：8 条变异 7 KILLED + MUT-5 **SURVIVED（被 FORCE RLS 租户臂 DELETE 策略掩蔽）**。

独立复核结论：**掩蔽定性成立**。

- **独立重放 MUT-5**（uninstall 的模块 WHERE 移除 `tenant_id` 臂）→ 聚焦套件 **35 pass / 0 fail**——与实现者存档 35/0 逐位一致：确实无任何用例捕获该变异，实现者从未声称有捕获用例，诚实披露成立。review brief 所问"捕获用例是否真实存在于基线"在正确方向上不适用：**捕获用例根本不存在（基线与本票都没有）**，这正是 SURVIVED 的定义；若实现者曾声称"被既有用例杀死"则定性为错，但其口径始终是"掩蔽存活" ✓
- **掩蔽层实证**：活库 `pg_policies` 直查 `enterprise_plugin_install_operator_delete`（DELETE / ob_ent_operator / 租户臂 USING）真实在位；该层由存储契约用例（FORCE RLS 三表断言 + "RLS is real" 跨公司读零行 + 授权矩阵）独立钉死，这些用例在变异注入下依然全绿——RLS 层在做真实防御，非纸面防线 ✓
- **基线不可能捕获**：插件三表为本票新建，基线 990 用例对其零接触，"掩蔽"与"既有用例捕获"两种定性中只有前者为真 ✓
- 语义注记（Info，不阻塞）：报告 D6 摘要句"各自存在分别由 AC3 行为用例与 FORCE RLS/授权矩阵用例独立钉死"对模块层略显宽泛——经公共 seam 两层观测逐字节相同（D6 自己已如实说明），AC3 钉死的是两层合成行为；mutation/MANIFEST.md 的精确措辞（"共同钉死"）无误。

## 3. 专项核对 B——RED 证据

RED-1 存档核实：`bun test tests/multitenancy/plugin-install.test.ts` → **0 pass / 1 fail / 1 error，`Cannot find module '../../src/enterprise/tenancy/plugin-catalog'`**。

- 失败性质为**模块缺席型**（import 期模块解析失败），非环境失败伪装：本套件缺 env 的表現是显式 skip（probeEnvironment → `test.skip` 带理由），DB 不可达的表现是连接错误；module-not-found 发生在任何环境探针/连接之前，且 fail 计数恰为 1（文件级 import）✓
- TDD 链自洽：RED-1 0 pass → GREEN-1 30/0 → GREEN-2 30/0（REFACTOR 后）→ GREEN-3 34/0 → 终态 35/0（补成员资格/双团队用例），全量 990 基线 → 1025 终态。我独立复现了终态两端（聚焦 35/0、全量 1025/0）✓
- 口径备注（Low，F-1）：报告 §3 门槛建表把"35/0"引注为 GREEN-3-final，而该存档实测为 34 pass（全量 1022/2 = D5 的 MT041 时钟漂移）；真正的 35/0 证据在 `11-final-green.txt`（变异后 sanity）。属引注笔误，非证据缺失。

## 4. 专项核对 C——窄缝改动

- **migrate-test.ts**：以工具自身算法对本树复算全部 **17 个前置任务 plan + step digest，与 checkpoints 归档 manifest 17/17 逐字节一致**（含 D4 事故涉及的 MT004/009/016/026/027）——SQL 语句层面无任何既有对象改动；TASKS 注册表恰 18 项（17 前置 + MT031）。MT031 任务块（`PLUGIN_CATALOG_TASK` + map 追加）为纯新增。**但 JS 源码格式层面有 D4 恢复残留，见 F-2**。
- **migration-tool.test.ts**：仅 allowlist 断言追加 `"MT031"`（排序位正确）+ ruling #5 第 14 次裁决注释；文件其余 1100+ 行穷举断言在我复跑的全量中全绿 ✓
- **schema/index.ts**：barrel 仅 +1 行 `export * from "./enterprise-plugins"`，排序位正确（enterprise-oauth-state 与 enterprise-runs 之间）✓
- **src/index.ts**：import 块 + `pluginCatalog` 装配段；decisions=data 通道；admin=operator 通道，缺 URL 或 verify 失败 `.catch(() => null)` → `admin: null` **fail-closed**（与 credentialOwnership 同款纪律）；vault 接 credentials.ts 既有 `encryptSecret/decryptSecret`（AES-GCM envelope）✓；lint 残留 5 处均为先于本票的存量（行号 +4 平移可证）✓

## 5. 变异独立重放（3/8 + RESTORE 闭环）

每次注入 → 聚焦复跑 → 恢复 → sha256 校验与变异前逐字节一致（`60528cb3…`）→ 恢复后 sanity 35/0：

| ID | 防线 | 注入 | 我的复放 | 实现者存档 | 判定 |
| --- | --- | --- | --- | --- | --- |
| MUT-5 | 卸载租户定界（模块 WHERE） | 移除 `tenant_id` 臂 | **SURVIVED 35/0** | SURVIVED 35/0 | ✓ 掩蔽定性成立（§2） |
| MUT-6 | 供应商探针观测面 | deny 路径也触发探针 | **KILLED 27/8** | KILLED 21/14 | ✓ 判定一致；计数差异见 F-3 |
| MUT-7 | 脱敏视图结构防线 | RedactedInstallView 注入 `envelope` 字段 | **KILLED 31/4** | KILLED 31/4 | ✓ 逐位一致（assertRedactedShape + canary 扫描捕获） |

三批变异覆盖了本票两处最重要防线（租户定界纵深、秘密零泄漏形状）与探针观测面； ≥3 条要求达标，全部 RESTORE 闭环。

## 6. Findings（分级）

**F-2（Medium，不阻塞判定）— migrate-test.ts 终态存在 6 处 biome format 违规，与"biome 0 新增"门槛声明冲突。**
实测（biome 2.5.10，与实现者同版本）：行 1547（MT031 块自身：`'\t"status" text DEFAULT \'active\' NOT NULL,\n' +` 顶格无缩进 + 单引号转义风格）+ 行 123/512/804/1047/1297（五个前置任务块内同款 `status DEFAULT 'active'` 行）。成因可推断：D4 误删事故的恢复把删行按 MT031 块的书写风格重打（顶格 + 转义单引号），运行时字符串逐字节等价——**故 17/17 digest oracle 与全部测试通过均不受影响**（digest 哈希的是 SQL 字符串值，不是 JS 源码字面量排版）。但：MT027 第 2 任复审曾实测 migrate-test.ts biome-clean，故这 6 处均为 MT031 交付引入；实现者存档 `12-typecheck-biome-final.txt` 显示触及 8 文件 clean，与交付字节矛盾（证据未反映终态）。影响纯排版、零语义；修复为机械动作（`biome check --write` 该文件，7 行重排），建议协调方安排一次微修（可并入下一波次，无需重开实现流程）。

**F-1（Low）— 报告 §3 引注笔误**：35/0 聚焦结果引注为 GREEN-3-final（实测 34/0 + 全量 1022/2），实际证据在 11-final-green.txt。TDD 链本身真实完整。

**F-3（Info）— MUT-6 重放计数差异**：我的注入（authorizeInvoke 事务内两条 deny 分支触发探针）得 27/8，存档 21/14；MANIFEST 未钉死变异的精确 deny 分支集（"探针 deny 路径也触发"可含 describeInstall/早退 deny 等更广面）。两种注入皆被决定性杀死，"探针只在 allow 触发"防线成立，无需行动。

**F-4（Info）— D6 摘要措辞**：见 §2 语义注记；MANIFEST.md 的精确措辞无误，报告正文摘要句可更严谨。

## 7. 判定

**PASS。** 四条验收（目录只读全局可见且结构上无公司私有配置/安装固定公司+团队/跨公司调用 canonical deny 且供应商探针不动/卸载停用严格本范围/秘密两层拒绝且脱敏零泄漏）全部有真实 RLS + 受限角色下的测试钉死且全绿（聚焦 35/0/0、全量 1025/0/39、0 skip——均从零 provision 独立复现）；三步配方 18 任务链、MT031 digest `f73bb8ab…`、journal 18×35 活库复核一致；冻结面（240 项 + 2 个消费面）逐字节未动；窄缝四处全部纯追加且 digest oracle 17/17；TDD RED 证据为真实模块缺席型；变异抽验 3 条复放与披露一致、掩蔽定性成立并经活库策略实证。所附 1 Medium（biome format 残留，零语义）建议随下一波次机械修复后闭环，不构成退回理由。MT031 建议转 **verified**（附 F-2 微修项）。

- 复审期间除本报告外未新建/修改任何仓库文件；变异注入均在受控恢复闭环内完成；复审结束时 10 个边界文件哈希与复审前逐一一致；专用容器与 env 副本已销毁并回显。
