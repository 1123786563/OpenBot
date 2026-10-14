## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

确定性检查输出格式、必需字段与工具名称/参数；结果与规则版本可追溯到安全运行；不依赖模型 Judge 即可完整运行。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 确定性检查输出格式、必需字段与工具名称/参数。
- [ ] 结果与规则版本可追溯到具体安全运行。
- [ ] 缺失评分不伪造为 0；评分失败与执行失败分开。
- [ ] 不依赖模型 Judge 即可完整运行。

## Blocked by

- #28 实验 schema 与冻结配置幂等提交

## Handoff

Produces: Scorer 接口 + 规则版本化约定.
Covers parent acceptance: A7, A9.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
