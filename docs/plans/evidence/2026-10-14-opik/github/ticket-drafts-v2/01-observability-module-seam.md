## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

建立观测后端模块的目录约定与单一注册入口，使后续每个 Ticket 只新增自己的路由模块即可挂载，不再编辑应用主入口；统一注入认证用户、可信 scope 与 Bot 归属。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 后续每个观测 Ticket 只新增自己的路由模块即可挂载，应用主入口只保留一处注册。
- [ ] 请求上下文（已认证用户、可信 scope、Bot 归属）以统一方式注入；未认证或无归属的请求在进入业务逻辑前被拒绝。
- [ ] 观测模块未启用时注册不产生任何行为变化，现有接口与 tracing 保持原样。
- [ ] 目录与命名约定写入模块说明，接手的 agent 只读该约定即可新增路由，不依赖父会话上下文。

## Blocked by

None (can start immediately).

## Handoff

Produces: 路由注册约定 + 观测请求上下文的注入方式.
Covers parent acceptance: A5.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
