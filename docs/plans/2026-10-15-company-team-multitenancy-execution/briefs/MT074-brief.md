# MT074 实施 brief（波次 16 补位）
角色：backend_implementer。树=w16-mt074（BASE+284）。TDD：RED→GREEN→REFACTOR。
## 票面验收
- 调用者身份在进入公司范围前确认；供应商只能收到其登记公司的必要计费字段。
- 供应商回调只能作用于其登记公司的付款人与账单；跨公司回调拒绝。
- 回调期间成员资格中断，处理按 MT028 的 fail-closed 规则。
- 调用与回调全程留审计（不含敏感明文）。
## 交付面
billing 域：供应商计费调用面+回调归属锁定（消费 MT069 付款账户+MT003 基础）；窄缝纯追加披露。
## 环境与验证
同波次 16 标配：bun install；容器 @127.0.0.1:55596（库名 openbot_enterprise_w16e_test 系）；七变量 env；链=base→19 前置修正序→MT029→MT073→MT060→本票；基线复现 **1222/0/47**；全量=基线+新增；typecheck 0；biome 触及 0；变异自证+RESTORE；archive/plans/multitenancy-execution/checkpoints/MT074/ 全套+archive/plans/multitenancy-execution/reports/MT074.md；零 git 提交；docker rm 回显；worker_done。令牌已根治无需微修。
