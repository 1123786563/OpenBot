## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

提交时冻结数据集版本、Bot 配置、Prompt、模型参数、fixture 与评分器版本；幂等重试不产生第二个实验。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 提交时冻结数据集版本、Bot 配置、Prompt、模型参数、fixture 与评分器版本。
- [ ] 幂等重试不产生第二个实验。
- [ ] scope 参与实验键；猜测 ID 或撤权不能读取。
- [ ] 配置版本引用可追溯到具体冻结来源。

## Blocked by

- #25 数据集 schema 与不可变版本冻结

## Handoff

Produces: 实验记录结构 + 幂等键约定.
Covers parent acceptance: A7, A9.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
