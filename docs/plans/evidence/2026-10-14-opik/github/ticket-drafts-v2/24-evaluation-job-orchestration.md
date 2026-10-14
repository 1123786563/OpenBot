## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

复用现有持久任务能力实现有界并发评测；每个样本执行前重新授权；取消停止新调度；结果未知或 lease 恢复不自动重复调用或扣费。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 持久任务有界并发；进程重启或 lease 恢复后继续而不重复执行已完成样本。
- [ ] 每个样本执行前重新授权；撤权后停止读取与消费。
- [ ] 取消停止新调度；结果未知或 lease 丢失不自动重复调用或扣费。
- [ ] 双 worker 并发认领测试成立；任务状态可解释。

## Blocked by

- #29 隔离执行与生产写工具拒绝

## Handoff

Produces: 任务状态机 + 取消/lease 语义.
Covers parent acceptance: A6, A10, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
