# MT029 实施 brief（波次 15）

角色：backend_implementer。树=w15-mt029（BASE f0520524 + 268 项 prereq 快照，含波次 14 全部 verified 交付）。TDD：RED→GREEN→REFACTOR，聚焦套件先红后绿。

## 票面验收
- lease 只能用于签发时声明的用途与作用域；改用途或改范围被拒绝。
- 撤销或过期后，正在进行的取用在下一次校验点失效；后续新取用被拒绝。
- 公共 Bot 的其他使用者无法获得创建者个人凭据的 lease。
- 每次签发、使用与撤销留审计（不含明文）。

## 交付面（预期）
凭据 lease 域：签发/取用/撤销/审计（建议 tenancy/credential-lease.ts + 测试；消费 MT027 凭据归属+MT018 审计面）


## 环境与验证（三步配方，从零）
1. `bun install`（全新 worktree 无 node_modules，MT022 复审 L3 教训）。
2. 专用容器 pgvector/pgvector:pg16 @127.0.0.1:55581（库名 openbot_enterprise_w15a_test + _assigned + openbot_kb_w15a_test；KB 属主角色先于建库）；psql 角色/库逐条 -c 执行（多语句会隐式事务回滚）。
3. 七变量 env（0600 用后删）：TEST_DATABASE_URL、ENTERPRISE_TEST_SETUP_DATABASE_URL（同库同实例 postgres 超户）、ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL、MT003_ASSIGNED_TEST_DATABASE_URL、KB_TEST_DATABASE_URL。
4. 迁移：`enterprise-test-db.ts migrate` → 前置任务链 generate+apply 逐任务（**修正链序 MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059**）→ 本票任务最后；journal 以 migration-tool.test.ts 穷举断言为准。
5. 基线复现 **1124 pass / 0 fail / 43 文件**（`bun --no-env-file test tests/multitenancy`）；全量回归=基线+本票新增；typecheck 0；biome 触及文件 0。

## 冻结面
268 项 prereq 中与本票无关的文件哈希不得变化（before-hashes 记录，收尾 after-hashes 复核）；窄缝授权（migrate-test.ts/migration-tool.test.ts/schema index 等共享文件）仅限纯追加本票任务，改动逐项披露。

## 交付纪律
- 变异自证（每安全分支 ≥1：注入→聚焦捕获→字节复原→复绿），RESTORE 哈希逐位复原。
- checkpoints/MT029/{before-hashes,after-hashes,design.md,red-green/,mutation/,verification/} + reports/MT029.md。
- 全程**零 git 提交**；禁 find /；测试毕 docker rm 容器并回显；歧义用 question 升级勿自行重新设计；结论性数字以本轮亲跑为准。
