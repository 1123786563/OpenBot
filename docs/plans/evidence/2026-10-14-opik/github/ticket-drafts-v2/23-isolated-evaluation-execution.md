## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

隔离 thread 与测试工具复用公共执行路径，不写生产会话、memory、learning 或业务数据；未知生产写工具被拒绝。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 隔离 thread 与测试工具复用公共执行路径，不写生产会话、memory、learning 或业务数据。
- [ ] 未知生产写工具被拒绝，而不是静默跳过。
- [ ] 被测执行保持公共行为语义；评测不改变生产执行路径。
- [ ] 执行失败与外部未知结局如实记录。

## Blocked by

- #16 run 终结语义与 basic 远程路径能力标记
- #20 内置执行的模型调用记录
- #28 实验 schema 与冻结配置幂等提交

## Handoff

Produces: 隔离执行入口 + 工具白名单/拒绝策略.
Covers parent acceptance: A8, A10.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
