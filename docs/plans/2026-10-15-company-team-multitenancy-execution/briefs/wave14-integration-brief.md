# 波次 14 批集成 brief（MT022/MT031/MT122/MT042/MT059 → EXE）

角色：集成实现者（本树=EXE 集成事实源，允许修改本树文件；**零 git 提交**）。目标：五票交付合并进本树+批终验全绿+落盘证据。

## 1. 输入（五棵实现树，交付以树内文件为准）
- MT022：/Users/wuyongjun/orca/workspaces/OpenBot/i14-mt022（增量 3 文件：tenancy/conversation-actions.ts、tests conversation-messages.test.ts、support/conversation-actions.ts）
- MT031：…/i14-mt031（增量 8 文件：tenancy/plugin-catalog.ts、schema/enterprise-plugins.ts、schema/index.ts、src/index.ts、scripts/multitenancy/migrate-test.ts、tests plugin-install.test.ts、support/plugin-install.ts、tests/migration-tool.test.ts）
- MT122：…/i14-mt122（增量 5 文件：tenancy/entry-context.ts、src/app.ts、src/index.ts、tests entry-context.test.ts、support/entry-context.ts）
- MT042：…/i14-mt042（增量 5 文件：runs/scan-executor.ts、scripts/multitenancy/migrate-test.ts、tests scan-executor.test.ts、support/scan-executor.ts、tests/migration-tool.test.ts）
- MT059：…/i14-mt059（增量 7 文件，**personal-bot.ts 用工作树态=HEAD+MUT-1 移除**：tenancy/personal-bot.ts、schema/enterprise-personal-bot.ts、schema/index.ts、scripts/multitenancy/migrate-test.ts、tests openmuse-private-bot.test.ts、support/personal-bot.ts、tests/migration-tool.test.ts）
- 另：五票 archive/plans/multitenancy-execution/checkpoints/MTXXX/ 与 archive/plans/multitenancy-execution/reports/MTXXX.md 全量 cp 进本树同路径（含 mutation/、verification/）。

## 2. 共享文件合并规则（均为纯追加型，按票号升序）
- migrate-test.ts：TASKS 注册表=本树基线+MT031 块+MT042 块+MT059 块（各块互不重叠，逐块移植后以 migration-tool.test.ts 穷举断言为权威校验）。
- migration-tool.test.ts：allowlist 断言 += "MT031"/"MT042"/"MT059"（排序位按既有列表规则）。
- schema/index.ts：barrel += export * from "./enterprise-plugins" + "./enterprise-personal-bot"（排序位正确）。
- src/index.ts：pluginCatalog 装配段（MT031）+entry-context 装配段（MT122）并存，互不重排既有段。
- 其余文件无重叠，直接落位+SHA-256 对照源树。

## 3. 批终验（三步配方从零，**修正链序**）
- 库名 openbot_enterprise_w14int_*（主+_assigned+KB openbot_kb_w14int），端口 55576，七变量 env（0600 用后删）。
- 任务链：base migrate → 前置链（MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070）→ MT031→MT042→MT059 逐任务 generate+apply（以合并后 migration-tool.test.ts 穷举断言钉序；journal 步数=链长+3 票步数）。
- 全量 `bun test tests/multitenancy/`：预期 **1124 pass / 0 fail / 43 files**（=波次 13 终态 990/38 + 五票 35+35+21+15+28 用例 +5 文件）。偏差则逐票归因落盘。
- typecheck exit 0；biome 触及文件 0（**F-2 微修**：migrate-test.ts `biome check --write` 消除 6 处历史排版违规[MT031 复审 F-2]——运行时 SQL 字符串逐字节等价，修后必须复验 migration-tool.test 穷举断言全绿+全量复跑）；cargo 无涉及面则跳过。
- app 面无增量（五票均 server 面；app/tests 无新增）——如 inventory.test 断言文件数请以实测为准。

## 4. 产出
- archive/plans/multitenancy-execution/checkpoints/wave14-integration/{manifest(逐文件 SHA-256 源树对照), provision, apply-chain-journal, full-suite, typecheck, biome-fix-diff(前后), 整改说明}.txt
- archive/plans/multitenancy-execution/reports/wave14-integration.md（合并明细+终态数字+与各票报告数字对照表）
- archive/plans/multitenancy-execution/checkpoints/MT{022,031,122,042,059}-integration/integration.json（{"ticket":"MTXXX","integrated":true,"full_suite":"1124/0/43","source_tree":"i14-mtXXX","hash_verified":true}）
- dag.json：五票节点 status→verified（coordinator 复核）
- 结束：docker rm 容器+env 删除+worker_done。禁止：git 提交、find /、生产迁移。
