## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

逐样本返回分数、理由、版本、usage 与结果链接；执行失败、评分失败、取消、待协调与同步故障分别展示，平均分不掩盖缺失或失败样本。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 逐样本返回分数、理由、版本、usage 与结果链接。
- [ ] 执行失败、评分失败、取消、待协调与同步故障分别展示；平均分不掩盖缺失或失败样本。
- [ ] 实验与结果读取遵守 scope/Bot 授权；猜测 ID 或撤权不能跨范围读取。
- [ ] 结果可回链到安全执行记录。

## Blocked by

- #32 规则评分器

## Handoff

Produces: 结果查询 REST 契约 + 失败分类枚举.
Covers parent acceptance: A5, A7, A9.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
