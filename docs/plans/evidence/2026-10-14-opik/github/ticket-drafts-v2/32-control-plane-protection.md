## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

采集入口要求内部生产者认证；整个 Opik 控制面（含私有 API）受保护，不能绕过应用角色检查；复用现有身份系统而非第二套用户库。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 采集入口要求内部生产者认证；未认证写入被拒绝。
- [ ] 整个 Opik 控制面（含私有 API）受保护，私有 API 不能绕过应用角色检查。
- [ ] 使用现有身份系统或平台私有访问，不建立第二套 Opik 用户库。
- [ ] 普通用户不能读取连接配置、管理诊断或凭据；整实例控制台仅限相应平台资格。

## Blocked by

- #15 配置开关与健康状态（禁用零影响）

## Handoff

Produces: 控制面访问规则 + 内部生产者凭据发放方式.
Covers parent acceptance: A4, A5, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
