## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

仅允许显式批准的模型入口、凭证与 rubric/scorer 版本；Judge 遵守预算与访问范围；只有已审查安全样本送给 Judge，理由经安全投影。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 仅允许显式批准的模型入口、凭证与 rubric/scorer 版本；不接受任意 provider 地址，不自动使用 Opik 默认模型。
- [ ] Judge 遵守适用 Credit Gate、Admission、Reservation/Settlement；预算不足或不受控时调用前拒绝，规则评测仍可用。
- [ ] 只有已审查的安全样本、参考与 context 送给 Judge；SDK 自动追踪与理由经安全投影，canary 不进入上游或页面。
- [ ] 逐样本显示分数、理由、版本、usage 与评分失败；Judge 故障不混入成功平均分。
- [ ] 撤权、取消与外部未知结果沿用任务规则，不增加自动重跑或跨范围读取。
- [ ] 受控假 provider 与真实实验验证门控、调用次数与账本；SDK 返回 score 不能代替预算证据。

## Blocked by

- #31 评测调用的计费准入与结算接线
- #32 规则评分器

## Handoff

Produces: Judge 准入清单 + 理由安全投影.
Covers parent acceptance: A4, A7, A8.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
