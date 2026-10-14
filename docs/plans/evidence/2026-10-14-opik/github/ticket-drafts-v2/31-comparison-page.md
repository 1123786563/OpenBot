## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者比较两次实验的配置差异、有效样本与退化案例，并从退化案例回到相关安全执行详情；不兼容时不显示误导性赢家结论。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 展示两次实验的配置差异、有效样本数、逐项 delta 与退化案例。
- [ ] 从退化案例回到相关安全执行详情。
- [ ] 不兼容时明确解释，不显示误导性赢家结论。
- [ ] 双语、键盘与窄屏成立；机器可读安全结果可用。

## Blocked by

- #35 实验对比接口与兼容性判定
- #36 实验页面（提交 / 逐样本结果 / 取消）

## Handoff

Produces: 对比页面组件契约.
Covers parent acceptance: A9.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
