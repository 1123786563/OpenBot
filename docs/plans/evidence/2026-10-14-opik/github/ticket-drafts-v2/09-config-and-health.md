## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

集成关闭时现有执行与 tracing 完全不变；启用但故障时给出可解释状态；Opik 慢响应、离线或队列饱和不改变正常 Agent 结果。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 集成关闭时现有执行与 tracing 行为完全成立；启用但故障时给出可解释状态而非静默降级。
- [ ] 就绪条件统一：关闭、未配置、认证失败或缺必需能力时明确不可用，不启用任何观测写入。
- [ ] Opik 慢响应、离线或队列饱和不改变正常 Agent 执行结果；丢弃与延迟可被观察。
- [ ] 健康状态不含凭据或敏感响应内容。

## Blocked by

- #14 Opik HTTP 适配器与 port 抽象

## Handoff

Produces: 就绪/健康查询接口 + 有界异步写入入口约定.
Covers parent acceptance: A1, A10.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
