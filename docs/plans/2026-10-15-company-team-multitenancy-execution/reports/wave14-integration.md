# 波次 14 批集成报告（MT022 + MT031 + MT122 + MT042 + MT059 → EXE）

- 集成树：`company-team-multitenancy-execution`（EXE 集成事实源，HEAD f7e8513c，**零 git 提交**）
- 源树：`i14-mt{022,031,122,042,059}`（交付以源树内工作树文件为准）
- 执行：Orca worker task_eb7fb755821a / ctx_139be718e791，2026-10-18
- 依据：`briefs/wave14-integration-brief.md`；五票均已复审 PASS（复审树 r14-mt*）

## 1. 合并明细（22 个唯一代码文件 + 361 个存档文件）

### 直接落位（16 文件，SHA-256 与源树逐一相等 → manifest.txt §A）

| 票 | 文件 |
|---|---|
| MT022 | tenancy/conversation-actions.ts、tests/conversation-messages.test.ts、support/conversation-actions.ts |
| MT031 | tenancy/plugin-catalog.ts、schema/enterprise-plugins.ts、tests/plugin-install.test.ts、support/plugin-install.ts |
| MT122 | tenancy/entry-context.ts、src/app.ts、support/entry-context.ts |
| MT042 | runs/scan-executor.ts、tests/scan-executor.test.ts（四任修复态）、support/scan-executor.ts |
| MT059 | tenancy/personal-bot.ts（**工作树态=HEAD+MUT-1 移除**，ba7ec225）、schema/enterprise-personal-bot.ts、tests/openmuse-private-bot.test.ts、support/personal-bot.ts |

注：MT122 src/app.ts 内含该票 biome import 排序归一（其终态整体复制）。

### 共享文件合并（4 文件，纯追加型，票号升序）

| 文件 | 合并内容 | 校验 |
|---|---|---|
| scripts/multitenancy/migrate-test.ts | 基线 + MT031 块（PLUGIN_CATALOG_TASK，2 步）+ MT042 块（SCAN_SCOPE_REBUILD_TASK，1 步）+ MT059 块（PERSONAL_BOT_RLS_STATEMENTS + PERSONAL_BOT_TASK，2 步）；TASKS 注册表 17→20 条按票号升序 | vs 每棵源树仅其余两票增量；vs 基线纯 `a` 无 `c`/`d`；穷举断言 41/0 |
| tests/multitenancy/migration-tool.test.ts | allowlist += "MT031"/"MT042"/"MT059"（位次 MT028<MT031<MT041<MT042<MT059<MT069）+ 三段预授权注释 | 三向 diff 均为纯他票增量 |
| src/db/schema/index.ts | barrel += ./enterprise-personal-bot、./enterprise-plugins（字母序 oauth-state < personal-bot < plugins < runs） | vs mt031 仅 +personal-bot 行；vs mt059 仅 +plugins 行 |
| src/index.ts | MT031 pluginCatalog 装配段 + MT122 entry-context 装配段（import 两处 + 装配三处）并存 | `git merge-file` 三方零冲突；vs 各源树仅他票增量；既有段零重排 |

### 存档复制

- `checkpoints/MT{022,031,122,042,059}/` 全量 cp（含 mutation/、verification/、migration/generated/）：
  45+82+66+96+73 = **362 文件**，逐文件聚合哈希与源树相等（manifest §D）。
- `reports/MT{022,031,122,042,059}.md` 全量 cp，哈希相等。

## 2. 批终验（三步配方从零，库 w14int @55576）

| 步骤 | 结果 | 证据 |
|---|---|---|
| provision | 容器 w14int-pg（pgvector/pg16，127.0.0.1:55576 loopback）；openbot_enterprise_w14int + _assigned + openbot_kb_w14int；ent_w14int_kb 属主；基线 migrate + 受限登录 4 LOGIN + 4 NOLOGIN；七变量 env 0600 用后删 | checkpoints/wave14-integration/provision.txt |
| apply chain | 修正链序 16 前置（MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070）→ MT031→MT042→MT059 逐任务 generate+apply；journal **19 任务 / 34 步** | apply-chain-journal.txt |
| 全量 | `bun test tests/multitenancy/` **1124 pass / 0 fail / 43 文件** exit 0（26.53s） | full-suite.txt |
| typecheck | `tsc --noEmit` exit 0 | typecheck.txt |
| biome | 触及增量文件 0 违规；共享装配面 6 处存量披露（口径同 MT030 复审 F1）；F-2 微修已施（见 §4） | biome-fix-diff.txt |
| cargo | 无 Rust 涉及面，按 brief 跳过 | — |
| app 面 | 五票均 server 面，`git status` app/ 零文件；inventory.test 以 43 文件实测通过 | manifest/full-suite |

## 3. 终态数字与各票报告对照

全量对照式：**1124 = 990（波次 13 终态）+ 35 + 35 + 21 + 15 + 28**；43 文件 = 38 + 5。

| 票 | 聚焦（票报告） | 全量（票报告，其树=990+本票） | 本票用例并入集成全量 | 一致性 |
|---|---|---|---|---|
| MT022 | 35/0（139 expect） | 1025/0/39 | 990+35=**1025** 等价叠加 | ✅ |
| MT031 | 35/0 | 1025/0/39 | 990+35=**1025** 等价叠加 | ✅ |
| MT122 | 21/0（64 expect） | 1011/0/39 | 990+21=**1011** 等价叠加 | ✅ |
| MT042 | 15/0 | 1005/0/39 | 990+15=**1005** 等价叠加 | ✅ |
| MT059 | 28/0（125 expect） | 1018/0/39 | 990+28=**1018** 等价叠加 | ✅ |
| **集成** | 五票聚焦在本树全部可复跑 | **1124/0/43** | 990+134=**1124**、38+5=**43** | ✅ 精确达成 |

## 4. 整改（两项，全落盘 → 整改说明.txt）

1. **F-2 biome 微修**（brief 预授权）：migrate-test.ts `biome check --write` 收敛 6 处排版违规；
   SQL oracle 20 任务 / 376 statements 逐字节等价（digest 382e60ea152478e8 前后一致）；
   修后穷举断言 41/0 全绿 + 全量复跑 1124/0/43。
2. **MT122 环境令牌 w14e→w14int**：票面钉死令牌与集成 brief 库名规定冲突（复跑 1 唯一 fail）。
   已 `orca orchestration ask`（msg_db4ac86bd2e5）升级裁定，30 分钟无应答后按 brief 两条硬性
   规定交集执行令牌微修（断言语义不变），manifest §C 单列 RECTIFIED 双哈希披露。
   复验：聚焦 21/0 + 全量 1124/0/43。

## 5. 遗留与移交

- dag.json 五票节点 status→verified（coordinator 复核）。
- 容器 w14int-pg 与七变量 env 于收尾删除（见 worker_done 前 teardown 记录）。
- 挂账问题 msg_db4ac86bd2e5 仍 pending：coordinator 可事后复核令牌裁定；若改判，一行回退 +
  聚焦/全量重跑即可。
