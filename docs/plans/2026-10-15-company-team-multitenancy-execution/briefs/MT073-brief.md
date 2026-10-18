# MT073 实施 brief（波次 15 补位）

角色：backend_implementer。树=w15-mt073（BASE f0520524+268 项 prereq）。TDD：RED→GREEN→REFACTOR。

## 票面验收
- 普通公司成员看不到其他人的订单与支付资料（即使共用公司余额）。
- 具备公司财务管理授权的主体可查看公司账务与团队用量；无此授权则不可。
- 团队用量汇总与公司总额一致，且不含个人直连消费。
- 旧按创建人限制的订单读取没有被放宽为全公司成员可读（回归测试）。

## 交付面（预期）
billing 域：公司财务读取授权面+团队用量汇总视图（消费 MT070 公司付款账户+MT010 计费）。产线建议 server/src/billing/ 下新文件；窄缝（migrate-test/migration-tool/schema index）纯追加逐项披露。

## 环境与验证（三步配方，从零）
1. `bun install`（全新树无 node_modules）。
2. 容器 pgvector/pgvector:pg16 @127.0.0.1:55585（库名 openbot_enterprise_w15e_test+_assigned+openbot_kb_w15e_test；KB 属主角色先于建库；psql 逐条 -c）。
3. 七变量 env（0600 用后删）；`enterprise-test-db.ts migrate` → 前置十九任务链（修正序 MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059）→ 本票最后。
4. 基线复现 **1124/0/43**（已知坑：entry-context.test.ts:191 环境令牌断言钉死 w14int——按 wave14-integration §4-2/MT123 R1 同款 RECTIFIED 微修为 w15e，双哈希披露，断言语义不变）；全量=基线+新增；typecheck 0；biome 触及 0。
5. 变异自证+RESTORE 逐位；checkpoints/MT073/ 全套+reports/MT073.md；零 git 提交；docker rm 回显；worker_done。

## 二任接管注记（coordinator 追加）
一任死于 mutation 阶段早期（transcript 687 行停滞；mutation/ 仅有 run-mutations.sh 计划脚本，**注入态未知**）。已有：before-hashes/design/migration/red-green（GREEN-2-post-biome）/verification（00-03 含全量）。**接任首步自证（关键）**：跑聚焦套件应全绿——若红则生产文件残留活体变异（MT059 三任先例），按 run-mutations.sh 对照 git diff 定位并字节复原，再继续剩余 mutation 逐条（注入→捕获→复原）+RESTORE+报告+worker_done。容器已由 coordinator 清。
