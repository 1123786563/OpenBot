## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

候选只来自有权访问的安全运行；仅指标的记录不能被自动伪造为文本样本，必须提供审查后的合成或脱敏案例；拒绝原始附件与任意生产工具。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 候选只来自有权访问的安全运行；越权或猜测 ID 不能成为候选。
- [ ] 仅指标的记录不能被自动伪造为文本样本，必须提供审查后的合成或脱敏案例。
- [ ] 拒绝原始附件与任意生产工具进入数据集。
- [ ] 跨 Bot 复用需要显式授权复制，不隐式共享。
- [ ] 已保存案例采用评测保留引用；未保存候选随源追踪生命周期。

## Blocked by

- #11 采集侧脱敏投影与安全内容策略
- #25 数据集 schema 与不可变版本冻结

## Handoff

Produces: 案例审查/保存 REST 契约 + 脱敏语义限制说明.
Covers parent acceptance: A4, A5, A6.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
