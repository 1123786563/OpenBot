## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者查看单次运行的安全详情：实际状态与耗时、脱敏内容、版本引用、provider usage 或明确的 unavailable；basic 与 unavailable 明确标注。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 展示单次运行的实际状态与耗时、脱敏内容、版本引用，以及 provider usage 或明确 unavailable。
- [ ] basic 与 unavailable 明确标注，不显示不可观察的内部步骤。
- [ ] 撤权、移交与跨 scope 访问在页面与接口两侧都被拒绝。
- [ ] Opik 故障时页面如实展示同步/缺失/故障状态，不影响用户已获得的正常回答。

## Blocked by

- #18 创建者运行列表页

## Handoff

Produces: 详情页组件契约（步骤树在后续 Ticket 扩展同一组件）.
Covers parent acceptance: A2, A3, A4, A5, A6.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
