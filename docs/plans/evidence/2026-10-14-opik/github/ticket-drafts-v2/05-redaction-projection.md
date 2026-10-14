## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

在任何写入或导出前对内容做语义白名单投影，排除凭据、内部能力、连接串、账号标识、reasoning 与原始附件；无法可靠处理的自由文本降级为仅指标。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 凭据、内部能力、连接串、账号标识、reasoning 内容与原始附件在任何写入或导出前被排除。
- [ ] 语义字段白名单驱动投影；无法可靠处理的自由文本降级为仅指标，而不是原样透传。
- [ ] 治理覆盖正文、metadata、异常、名称与 URL，不只覆盖输入输出两个字段。
- [ ] 内容策略带版本号并可被下游冻结引用；canary 测试证明无泄露。

## Blocked by

None (can start immediately).

## Handoff

Produces: 安全投影接口 + 内容策略版本号.
Covers parent acceptance: A4.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
