## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

宿主、容器与支持动态创建的进程真实传播 W3C 上下文；OTel 与 Opik 标识使用显式映射而不假定相等。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 宿主、容器与支持动态创建的进程真实传播 W3C 上下文。
- [ ] OTel 与 Opik 标识使用显式映射，不假定相等。
- [ ] 跨服务父子关系在真实实例可验证。
- [ ] loopback 地址与凭据不混淆、不泄露。

## Blocked by

- #22 LangGraph callback 接入同一受治理 OTel 路径

## Handoff

Produces: 传播环境变量约定 + ID 映射位置.
Covers parent acceptance: A2, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
