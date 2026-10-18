# MT060 实施 brief（波次 15）

角色：backend_implementer。树=w15-mt060（BASE f0520524 + 268 项 prereq 快照，含波次 14 全部 verified 交付）。TDD：RED→GREEN→REFACTOR，聚焦套件先红后绿。

## 票面验收
- 列表、详情、更新与取消只作用于当前范围；跨范围 ID 返回不可见语义。
- 任务锁与租约按范围隔离：公司 A 的锁不阻塞也不被公司 B 复用。
- 只有 user_id 的旧根记录被补上公司与团队关联（迁移可 dry-run 预览）。
- 后台触发遵守 MT042 的作用域重建规则。

## 交付面（预期）
OpenMuse 任务/计划/监控/租约归属域（消费 MT059 个人 Bot+MT041 租约；旧根记录补公司团队关联的迁移含 dry-run）


## 环境与验证（三步配方，从零）
1. `bun install`（全新 worktree 无 node_modules，MT022 复审 L3 教训）。
2. 专用容器 pgvector/pgvector:pg16 @127.0.0.1:55582（库名 openbot_enterprise_w15b_test + _assigned + openbot_kb_w15b_test；KB 属主角色先于建库）；psql 角色/库逐条 -c 执行（多语句会隐式事务回滚）。
3. 七变量 env（0600 用后删）：TEST_DATABASE_URL、ENTERPRISE_TEST_SETUP_DATABASE_URL（同库同实例 postgres 超户）、ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL、MT003_ASSIGNED_TEST_DATABASE_URL、KB_TEST_DATABASE_URL。
4. 迁移：`enterprise-test-db.ts migrate` → 前置任务链 generate+apply 逐任务（**修正链序 MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059**）→ 本票任务最后；journal 以 migration-tool.test.ts 穷举断言为准。
5. 基线复现 **1124 pass / 0 fail / 43 文件**（`bun --no-env-file test tests/multitenancy`）；全量回归=基线+本票新增；typecheck 0；biome 触及文件 0。

## 冻结面
268 项 prereq 中与本票无关的文件哈希不得变化（before-hashes 记录，收尾 after-hashes 复核）；窄缝授权（migrate-test.ts/migration-tool.test.ts/schema index 等共享文件）仅限纯追加本票任务，改动逐项披露。

## 交付纪律
- 变异自证（每安全分支 ≥1：注入→聚焦捕获→字节复原→复绿），RESTORE 哈希逐位复原。
- checkpoints/MT060/{before-hashes,after-hashes,design.md,red-green/,mutation/,verification/} + reports/MT060.md。
- 全程**零 git 提交**；禁 find /；测试毕 docker rm 容器并回显；歧义用 question 升级勿自行重新设计；结论性数字以本轮亲跑为准。

## 三任接管注记（coordinator 追加）
二任死于 GREEN-1 之后（transcript 953 行停滞，mutation 未开始）。已有：before-hashes/design/migration/red-green（GREEN-1-first）/verification（00-04，含 baseline 二连）。**接任首步自证**：跑聚焦套件应全绿——若红则树内可能残留未复原改动，按 before-hashes+git diff 定位还原后再继续。剩余：REFACTOR（如需）+mutation 自证+RESTORE+报告+worker_done。容器已由 coordinator 清。
