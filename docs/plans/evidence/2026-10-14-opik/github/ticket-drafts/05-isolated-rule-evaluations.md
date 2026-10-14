## Parent

https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者选择冻结数据集及 Bot 配置提交独立评测，查看逐样本规则评分、运行结果、失败和取消，并关联安全执行记录。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 提交冻结数据集、Bot 配置、Prompt、模型参数、fixture 和评分器版本，幂等重试不产生第二个实验。
- [ ] 隔离 thread 和测试工具复用公共执行路径，不写生产会话、memory、learning 或业务数据，未知生产写工具被拒绝。
- [ ] 被测调用遵守适用 Credit Gate、Admission、Reservation/Settlement；缺失 usage 不当 0，计费台账保持权威。
- [ ] 规则评分覆盖输出格式、必需字段及工具名称/参数，结果和规则版本可追溯到安全运行。
- [ ] 持久任务有界并发，每个样本前重新授权；取消停止新调度，结果未知或 lease 恢复不自动重复调用/扣费。
- [ ] 执行失败、评分失败、取消、待协调和同步故障分别展示；缺失评分不伪造为 0，仅重试幂等结果写入。
- [ ] 实验和结果符合 scope/Bot 权限，双 worker 及撤权测试成立；不依赖模型 Judge 或详细步骤 Ticket 才能执行。
- [ ] 真实 Opik 可查询合成实验，用户在双语、可访问页面提交、查看和取消。

## Blocked by

- Draft 4: 从安全案例保存不可变评测集版本 (replace with the real GitHub issue link and native blocked-by edge after breakdown approval).
