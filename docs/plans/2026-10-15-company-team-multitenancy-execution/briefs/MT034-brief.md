# MT034 实施 brief（波次 16）

角色：backend_implementer。树=w16-mt034（BASE f0520524+284 项 prereq 快照，含波次 14/15 全部 verified 交付）。TDD：RED→GREEN→REFACTOR。

## 票面验收
- 批准只对其锁定的对象与参数摘要有效；参数变化后需要重新审批。
- 切换到另一团队后旧批准不被复用（有专门测试）。
- 跨公司审批请求与批准永远拒绝。
- 撤权后待处理申请不可被该用户继续操作，已批准动作按 MT029 重新校验。

## 交付面（预期）
共享账号规则/申请/批准锁定域（消费 MT031 插件归属+MT029 lease 校验先例）
窄缝（migrate-test.ts/migration-tool.test.ts/schema/index.ts 等共享文件）纯追加本票任务、逐项披露。

## 环境与验证（三步配方，从零）
1. `bun install`。
2. 容器 pgvector/pgvector:pg16 @127.0.0.1:55593（库名 openbot_enterprise_w16b_test+_assigned+openbot_kb_w16b_test；KB 属主先于建库；psql 逐条 -c）。
3. 七变量 env（0600 用后删）；base migrate→**修正链序 19 前置**（MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059）→**波次 15 三票 MT029→MT073→MT060**→本票最后；穷举断言为权威。
4. 基线复现 **1222 pass / 0 fail / 47 文件**；全量=基线+新增；typecheck 0；biome 触及 0。
（注：entry-context.test.ts 令牌已根治为 TEST_DATABASE_URL 派生——无需任何令牌微修，环境任意库名即可。）

## 冻结面
284 项中与本票无关文件哈希不变（before/after-hashes）；变异自证每安全分支 ≥1（注入→聚焦捕获→字节复原→复绿）+RESTORE 逐位。

## 交付纪律
archive/plans/multitenancy-execution/checkpoints/MT034/ 全套+archive/plans/multitenancy-execution/reports/MT034.md；零 git 提交；禁 find /；docker rm 回显；question 升级勿自设计；结论数字以本轮亲跑为准；挂死无增量时直接从头执行（前任若死于早期树为干净基线）。
