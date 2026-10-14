## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

仅对冻结样本集、hash 与评分定义兼容的实验给出结论；输出有效样本数、逐项 delta、退化案例与回链运行，不兼容时解释差异而不宣称赢家。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 仅对冻结样本集、hash 与评分定义兼容的实验给出结论；不兼容时解释差异而不宣称质量赢家。
- [ ] 输出完成率、有效评分数、执行/评分失败、逐项 delta、耗时与实际 usage；缺失值不当 0 或静默剔除。
- [ ] 退化样本链接到安全案例与执行记录；unknown/basic/metrics-only 保持明确，不捏造解释。
- [ ] 两次实验都通过当前 scope/Bot 授权；规则实验即可完成对比，不依赖模型 Judge。

## Blocked by

- #34 实验结果查询接口与失败分类

## Handoff

Produces: 对比 REST 契约 + 兼容性判定规则.
Covers parent acceptance: A9.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
