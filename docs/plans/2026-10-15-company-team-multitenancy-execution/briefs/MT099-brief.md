# MT099 实施 brief（波次 15）

角色：backend_implementer。树=w15-mt099（BASE f0520524 + 268 项 prereq 快照，含波次 14 全部 verified 交付）。TDD：RED→GREEN→REFACTOR，聚焦套件先红后绿。

## 票面验收
- 组织凭据与个人 provider 凭据分命名空间存储，互不可读。
- 个人连接不会被当作公司付款方或公司业务凭据使用。
- OAuth state 与恢复绑定发起 authority；回调期间切换组织不改变归属。
- 命名空间清理只影响目标组织（与切换清理 Ticket 一致）。

## 交付面（预期）
桌面凭据组织命名空间域（消费 MT098 rust 面+MT069 付款账户；涉 rust 面时 cargo test 全绿+文件哈希冻结，bun 基线同上）


## 环境与验证（三步配方，从零）
1. `bun install`（全新 worktree 无 node_modules，MT022 复审 L3 教训）。
2. 专用容器 pgvector/pgvector:pg16 @127.0.0.1:55583（库名 openbot_enterprise_w15c_test + _assigned + openbot_kb_w15c_test；KB 属主角色先于建库）；psql 角色/库逐条 -c 执行（多语句会隐式事务回滚）。
3. 七变量 env（0600 用后删）：TEST_DATABASE_URL、ENTERPRISE_TEST_SETUP_DATABASE_URL（同库同实例 postgres 超户）、ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL、MT003_ASSIGNED_TEST_DATABASE_URL、KB_TEST_DATABASE_URL。
4. 迁移：`enterprise-test-db.ts migrate` → 前置任务链 generate+apply 逐任务（**修正链序 MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059**）→ 本票任务最后；journal 以 migration-tool.test.ts 穷举断言为准。
5. 基线复现 **1124 pass / 0 fail / 43 文件**（`bun --no-env-file test tests/multitenancy`）；全量回归=基线+本票新增；typecheck 0；biome 触及文件 0。

## 冻结面
268 项 prereq 中与本票无关的文件哈希不得变化（before-hashes 记录，收尾 after-hashes 复核）；窄缝授权（migrate-test.ts/migration-tool.test.ts/schema index 等共享文件）仅限纯追加本票任务，改动逐项披露。

## 交付纪律
- 变异自证（每安全分支 ≥1：注入→聚焦捕获→字节复原→复绿），RESTORE 哈希逐位复原。
- archive/plans/multitenancy-execution/checkpoints/MT099/{before-hashes,after-hashes,design.md,red-green/,mutation/,verification/} + archive/plans/multitenancy-execution/reports/MT099.md。
- 全程**零 git 提交**；禁 find /；测试毕 docker rm 容器并回显；歧义用 question 升级勿自行重新设计；结论性数字以本轮亲跑为准。

## 二任接管注记
一任死于域研究阶段（~4h，零本票增量、零 checkpoint）——树是干净的 268 项转移基线，直接按 brief 从头执行即可。

## 三任接管注记（coordinator 追加，2026-10-18）
二任死于域考古（发现的缺口已由 coordinator 修复）：**MT098 rust 交付四文件**（desktop/src-tauri/src/{lib,main,organization_auth,org_context}.rs，哈希=MT098 报告值 b75f3e6f/f515e24a/25042fca/8ec7e2cd）**已补入本树**且转移清单升级 v15.1。二任零增量。直接按 brief 开工；bun 基线 1124/0/43 不变，rust 面（cargo）以本树四文件为基线。
