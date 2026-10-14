## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者在双语可访问页面提交实验、查看逐样本分数与理由、区分失败类型并取消；结果可回链到运行详情。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 创建者在双语可访问页面提交实验、查看逐样本分数与理由并取消。
- [ ] 失败类型分别展示；Judge 故障不混入成功平均分。
- [ ] 键盘、窄屏与直接路由越权校验成立。
- [ ] 结果可回链到运行详情。

## Blocked by

- #27 数据集页面（审查 / 保存 / 版本）
- #34 实验结果查询接口与失败分类

## Handoff

Produces: 实验页面组件契约.
Covers parent acceptance: A5, A7, A8.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
