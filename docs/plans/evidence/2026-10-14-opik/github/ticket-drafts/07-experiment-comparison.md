## Parent

https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者比较两次实验的配置、有效样本、分数及退化案例，并回到相关安全执行详情。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 两次实验均通过当前 scope/Bot 授权，猜测 ID 或撤权不能跨范围读取。
- [ ] 冻结样本集合、hash 与评分定义决定可比性；不兼容时解释差异而不宣称质量赢家。
- [ ] 展示完成率、有效评分数、执行/评分失败、逐项 delta、耗时和实际 usage，缺失值不当 0 或静默剔除。
- [ ] 退化样本链接到安全案例与执行记录，unknown/basic/metrics-only 保持明确，不捏造解释。
- [ ] 规则实验即可验证完整对比，Judge 后续作为版本化评分定义参与而非本 Ticket 前置。
- [ ] 双语、键盘/窄屏及机器可读安全结果成立；真实 Opik 的两种配置与失败案例通过。

## Blocked by

- Draft 5: 运行隔离评测并查看规则评分 (replace with the real GitHub issue link and native blocked-by edge after breakdown approval).
