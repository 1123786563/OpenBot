## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

被测调用遵守适用 Credit Gate、Admission、Reservation 与 Settlement 规则；缺失 usage 不当 0；计费台账保持权威。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 被测调用遵守适用 Credit Gate、Admission、Reservation 与 Settlement 规则。
- [ ] 缺失 usage 不当 0；计费台账保持权威，观测侧成本只作分析用途。
- [ ] 预算不足或准入失败在调用前拒绝，不产生供应商调用。
- [ ] 结算幂等，重放不重扣。

## Blocked by

- #30 持久任务编排：有界并发、每样本重授权、取消与 lease

## Handoff

Produces: 评测侧计费准入接口 + 预算不足时的调用前拒绝语义.
Covers parent acceptance: A8.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
