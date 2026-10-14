## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

平台运维可用可选部署启动真实自托管 Opik，服务与 SDK 版本锁定为实际验证过的值；关闭集成时现有执行与 tracing 行为完全不变。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 可选部署能启动真实自托管实例；未部署或未启用时现有 Agent 执行与 tracing 行为完全不变。
- [ ] 服务镜像与 SDK 版本锁定为实际验证过的具体值（tag/digest），不使用浮动标签。
- [ ] 运维文档给出启动、关闭、健康检查与故障排查步骤，且不泄露凭据。
- [ ] 相关配置进入环境变量样例，缺省时集成保持关闭。

## Blocked by

None (can start immediately).

## Handoff

Produces: 非浮动版本清单 + 启动/关闭/健康检查步骤.
Covers parent acceptance: A1.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
