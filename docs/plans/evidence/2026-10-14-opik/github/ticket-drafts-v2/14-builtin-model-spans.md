## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

内置路径的模型调用带实际 provider usage 或明确 unavailable；不重复调用 provider、不改变已有 metered finish 与 Settlement 顺序、不重复计算 usage。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 内置路径的模型调用带实际 provider usage；缺失时明确 unavailable，不当 0。
- [ ] 不重复调用 provider、不改变已有 metered finish 与 Settlement 顺序、不重复计算 usage。
- [ ] 拒绝或结算失败不记录为成功 span。
- [ ] 模型 span 的输入输出经脱敏投影；canary 不出现在真实实例。

## Blocked by

- #11 采集侧脱敏投影与安全内容策略
- #16 run 终结语义与 basic 远程路径能力标记

## Handoff

Produces: 模型 span 记录接口 + usage 缺失语义.
Covers parent acceptance: A2, A3, A4, A8.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
