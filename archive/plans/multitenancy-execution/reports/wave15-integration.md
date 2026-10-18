# 波次 15 批集成报告（MT123 + MT029 + MT073 + MT060 + MT099 → EXE）

- 集成树：`company-team-multitenancy-execution`（EXE 集成事实源，HEAD f7e8513c，**零 git 提交**）
- 源树：`w15-mt{123,029,073,060,099}`（交付以源树内工作树文件为准）
- 执行：Orca worker task_0e42591274c3 / dispatch ctx_632af451aaaa，2026-10-18
- 依据：`briefs/wave15-integration-brief.md`；五票 checkpoints/reports 全量在档（§1-D）

## 0. 终态一句话

**bun 全量 1222 pass / 0 fail / 47 文件 / exit 0（=1124+24+27+16+31，精确达成）；cargo 全量 741 passed / 0 failed（=基线 719+MT099 22，精确达成）；typecheck 0；biome 触及文件零增量（6 文件 F-2 纯排版微修 + index.ts 5 处存量披露）；entry-context.test.ts 令牌根治为 TEST_DATABASE_URL 派生（聚焦 21/0），dag.json 五票 verified。**

## 1. 合并明细（18 个直接落位文件 + 4 个共享合并文件 + 2 个令牌根治 + 383 个存档文件）

### A. 直接落位（13 文件逐字节相等 + 5 文件落位后 F-2 纯排版微修）

| 票 | 文件 | 校验 |
|---|---|---|
| MT123 | tenancy/startup-defaults.ts | EQUAL |
| MT123 | tests/multitenancy/startup-defaults.test.ts | F2FIXED（含令牌根治，见 §2） |
| MT029 | schema/enterprise-credential-lease.ts、tenancy/credential-lease.ts、tests/credential-lease.test.ts、support/credential-lease.ts | 4×EQUAL |
| MT073 | billing/company-finance-visibility.ts、schema/company-finance.ts、tests/billing-visibility.test.ts、support/billing-visibility.ts | 4×EQUAL |
| MT060 | schema/openmuse-task-tenancy.ts、tenancy/openmuse-task-tenancy.ts、tests/openmuse-tasks.test.ts、support/openmuse-tasks.ts | 4×F2FIXED（纯 format+organizeImports，见 §4） |
| MT099 | rust：credential_namespace.rs（新）+ lib.rs / organization_auth.rs / org_context.rs（MT099 版直接落位） | 4×EQUAL |

MT099 rust 基线核验：其 before-hashes（organization_auth=25042fca…、org_context=8ec7e2cd…、lib=b75f3e6f…、main=f515e24a…）与 EXE 落位前工作树逐一相等（即 MT098 之后的终态）→「直接落位 MT099 版」不回退 MT098；main.rs 双方零改动（f515e24a… 前后一致）。逐哈希见 `checkpoints/wave15-integration/manifest.txt` §A。

### B. 共享文件合并（4 文件，纯追加型，块序=票号序 MT029→MT073→MT060）

| 文件 | 合并内容 | 校验 |
|---|---|---|
| scripts/multitenancy/migrate-test.ts | 基线 + MT029 块（CREDENTIAL_LEASE_TASK，2 步）+ MT073 块（COMPANY_FINANCE_GRANT_TASK，1 步）+ MT060 块（OPENMUSE_TASK_TENANCY_TASK，3 步）；TASKS 注册表 20→23 条；模块 import 实测 OK（TASKS size=23） | vs 基线纯 `a`（0 删改）；vs 每棵源树仅其余两票增量；**SQL oracle 22 任务 plan manifest 哈希 --write 微修前后逐一相等** |
| tests/multitenancy/migration-tool.test.ts | allowlist += "MT029"/"MT060"/"MT073"（排序位 MT028<MT029<MT031、MT059<MT060<MT069、MT070<MT073<MT076）+ 三段票面预授权注释 + 一段集成注释 | 三向 diff 均为纯他票增量；全量轮穷举断言全绿 |
| src/db/schema/index.ts | barrel += ./company-finance、./enterprise-credential-lease、./openmuse-task-tenancy（三处均为字母序正确位；**MT060 源树把 openmuse-task-tenancy 排在 enterprise-plugins 之后属排序位错误，集成按 brief「排序位正确」修正**） | vs 每棵源树仅其余两票增量 + 该排序位修正 |
| src/index.ts | MT123 装配（import + dev-actor 改经 mountDevBypass + startup-defaults 解析/verdict/threadIdentity，2 处替换表达式）+ MT029 装配（import + credentialLease 段，fail-closed=null）并存 | vs 基线 4 删=两处替换表达式；vs MT123 树仅 MT029 增量、vs MT029 树仅 MT123 增量；bun import 实测跑通 |

### C. 存档复制

- `checkpoints/MT{123,029,073,060,099}/` 全量 cp：78+32+95+95+78 = **378 文件**，逐文件聚合哈希与源树相等（manifest §D，含 mutation/、verification/、migration/generated/ 全部嵌套）。
- `reports/MT{123,029,073,060,099}.md` 全量 cp，哈希相等。

## 2. 令牌根治（brief 授权整改：entry-context.test.ts → TEST_DATABASE_URL 派生）

四票在各自树把 `entry-context.test.ts:191` 的环境身份断言 RECTIFIED 成四个不同钉死名（MT123=w15d_test、MT073=w15e_test、MT060=w15b_test、MT099=w15c_test；MT029 则以对齐 w14int 库名处置）。集成按 brief 统一根治：

- 断言值改为运行时解析 `TEST_DATABASE_URL` 取库名后断言（`testDatabaseName()` 助手 + 注释改造），专库+受限 data 角色+绝不回退开发库的**断言语义不变，跨环境自适应**。
- 双哈希：base d7e4d400…（w14int pin，wave14 终态）→ exe 9971404b…；diff 落盘 `checkpoints/wave15-integration/token-refactor-diff.txt`（38 行）。
- 聚焦复跑：**21 pass / 0 fail**（64 expect）。
- 同类根治延伸披露：MT123 新文件 `startup-defaults.test.ts` 自带同款 w15d 钉死断言（其票内 RECTIFIED 只动了 entry-context），集成一并改为 env 派生（src 06621f67… → exe 5c426708…，中间态 19acdf6b…）；其余三票测试/support 文件 grep 证实零钉死。

## 3. 批终验（三步配方从零；容器 w15int-pg @127.0.0.1:55591 loopback；库 openbot_enterprise_w15int_test + _assigned + openbot_kb_w15int_test）

| 步骤 | 结果 | 证据 |
|---|---|---|
| provision | 基线 migrate `{"type":"migrations-applied","status":"ok"}`；受限 LOGIN 角色由 enterprise-test-db.ts migrate 自建；KB 属主 ent_w15int_kb（NOSUPERUSER…）先于建库；七变量 env 0600 用后删 | provision.txt |
| apply chain | 修正链序 19 前置（MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059）→ **MT029→MT073→MT060**（票号序，brief 钉定）逐任务 generate+apply（--manifest 闭环）；journal **22 任务 / 42 步**（36 前置 + 2+1+3） | apply-chain-journal.txt、migration/generated/（22 任务 SQL+manifest） |
| bun 全量 | `bun test tests/multitenancy/` **1222 pass / 0 fail / 47 文件 / 13370 expect / exit 0** | full-suite.txt |
| cargo 全量 | `cargo test` **741 passed / 0 failed**（592 lib + 149 bin；基线 719 + MT099 22 精确达成） | cargo-suite.txt |
| typecheck | `tsc --noEmit` exit 0 | typecheck.txt |
| biome | 触及 19 文件零增量：6 文件 F-2 纯排版微修（复检 0）+ index.ts 5 处 prereq 存量披露（与 HEAD 基线同款同数，仅行号位移） | biome.txt |

### 3.1 全量对照式

**1222 = 1124（wave14 终态）+ 24（MT123）+ 27（MT029）+ 16（MT073）+ 31（MT060）**；47 文件 = 43 + 4（startup-defaults / credential-lease / billing-visibility / openmuse-tasks 各一）。MT099 零 bun 新增（纯桌面 rust 面）。五票聚焦在本树复跑：24/0、27/0、16/0、31/0，与票面报告逐一相等。

### 3.2 首轮 6 fail 归因（全已消除，证据在档）

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 1 | MT123 装配套件 1 fail（库名断言） | MT123 新测试文件自带 w15d pin（票据 RECTIFIED 未覆盖自家文件） | 同款 env 派生根治（§2） |
| 2–4 | MT036/037/038 KB 三用例 fail：`role "ent_w15int_kb" is not permitted to log in` | **集成 provision 操作缺陷**：建 KB 属主角色时漏 LOGIN 属性 | `ALTER ROLE ent_w15int_kb LOGIN`；三用例复绿 |
| 5–6 | MT041 两用例 fail：`finishedAt <= Date.now()` | Docker VM 时钟超前宿主 ~8ms（环境漂移，非代码缺陷；票据运行时无此偏移） | 特权容器把 VM 钟步回调（~10ms，对同宿主其他容器无感）；复跑复绿 |

首轮输出存档：`full-suite-first.txt`（1151/6/47）→ 整改后终版 `full-suite.txt`（1222/0/47）。

## 4. F-2 biome 微修（wave14 先例沿用；逐文件披露）

`biome check --write` 六文件（纯 format + organizeImports，零语义变更）：migrate-test.ts + MT060 四交付文件 + startup-defaults.test.ts（后者含 §2 令牌根治）。归因：MT060 源树即带同款残留（其票面 biome 证据仅覆盖 8 个窄缝文件，未含这四个交付文件）。语义等价证明：migrate-test.ts **22 任务 plan manifest 哈希 --write 前后逐一相等**（apply 链所用 oracle 即 before 态）；openmuse 三文件由全量/聚焦复跑钉死。前后哈希双列：manifest §A2 / biome.txt §1。index.ts 5 处存量（4 noConsole + 1 noNonNullAssertion）与 HEAD 基线同位同数，处置同 MT123 R-MT123-3：披露不修。

## 5. 决策记录（Rulings / 披露）

- **R-W15INT-1（entry-context 令牌根治 = brief 明文授权）**：按 brief「四票各自 RECTIFIED 为不同库名——集成统一改为从 TEST_DATABASE_URL 派生断言值」执行，非协调者新裁。startup-defaults.test.ts 的同款 pin 属同类整改（根治意图=跨环境自适应），一并覆盖并双哈希披露。
- **R-W15INT-2（MT060 barrel 排序位修正）**：MT060 源树把 `./openmuse-task-tenancy` 置于 `./enterprise-plugins` 之后（非字母序）；brief 明文「排序位正确」，集成置于 `./openmuse` 与 `./passwords` 之间。biome 复检通过。
- **R-W15INT-3（KB 角色 LOGIN 缺失 = 集成侧 provision 缺陷，非票据缺陷）**：票据环境由各自 brief 配方建库建角色含 LOGIN；本轮手工建 KB 属主角色时漏写 LOGIN，首轮 3 fail 即此。已修复并在 provision 记录。
- **R-W15INT-4（VM 时钟步回）**：Docker Desktop VM 钟漂移 ~8ms 使 MT041 的 `finishedAt<=Date.now()` 时序断言确定性失败。用 `--privileged` 容器把 VM 内核钟步回调至宿主时刻（幅度 ~10ms）。该操作影响同 VM 全部容器的时间读数（回拨 10ms 级），对其他长跑容器（b5-verify/ci399 等）无实质影响。票据代码零改动。
- **R-W15INT-5（MT029 环境歧义遗留）**：MT029 报告 §0 的 w15a/w14int 库名歧义升级（msg_9adf8abcfaaf）在本轮由 brief 的令牌根治条款实质闭合（集成层不再依赖任何钉死库名）。

## 6. 收尾

- dag.json：MT123/MT029/MT073/MT060/MT099 五票 status → verified（最小 diff 5 行）。
- checkpoints/MT{123,029,073,060,099}-integration/integration.json 五份落盘（full_suite=1222/0/47）。
- 容器 `docker rm -f w15int-pg` + env `/tmp/w15int-env.sh` 删除（收尾回显在 provision.txt teardown 段）。
- 全程零 git 提交。
