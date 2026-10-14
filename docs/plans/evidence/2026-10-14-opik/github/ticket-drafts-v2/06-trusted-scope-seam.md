## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

把授权范围、存储定位与评测资格集中在可替换 seam，当前只实现工作台适配器；未知企业 scope 拒绝且不回退，不提前固定租户模型。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 授权范围、存储定位与评测资格集中在可替换 seam，当前只实现工作台适配器。
- [ ] 两个测试 scope 使用相同资源 ID 时互相隔离，游标、缓存与任务不跨 scope。
- [ ] 未知企业 scope 被拒绝且不回退到工作台 scope。
- [ ] 不创建租户表、不伪造租户、不引入隐式租户头，不把 workspace/project 布局当作授权证明。

## Blocked by

None (can start immediately).

## Handoff

Produces: ObservationScope 解析接口 + 两个测试 scope 的构造方式.
Covers parent acceptance: A5, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
