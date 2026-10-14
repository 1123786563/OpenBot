## Parent

https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者在既有评测流程选择批准的模型评分器，查看基于参考答案或业务 rubric 的评分和理由，Judge 遵守部署预算及访问范围。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 仅允许显式批准的模型入口、凭证、rubric/scorer 版本，不接受任意 provider 地址或自动使用 Opik 默认模型。
- [ ] Judge 遵守适用 Credit Gate、Admission、Reservation/Settlement；预算不足或不受控时调用前拒绝，规则评测仍可用。
- [ ] 只有已审查的安全样本/参考/context 送给 Judge，SDK 自动追踪和理由经过安全投影，canary 不进入上游或页面。
- [ ] 逐样本显示分数、理由、版本、usage 与评分失败，Judge 故障不混入成功平均分。
- [ ] 撤权、取消和外部未知结果沿用任务规则，不增加自动重跑或跨范围读取。
- [ ] 受控假 provider 及真实实验验证门控、调用次数、账本与页面；SDK 返回 score 不能代替预算证据。

## Blocked by

- Draft 5: 运行隔离评测并查看规则评分 (replace with the real GitHub issue link and native blocked-by edge after breakdown approval).
