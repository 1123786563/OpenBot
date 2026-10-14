## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

run 记录在实际完成、失败、取消或明确未知状态时终结，HTTP 首帧不结束 run；内置与经过 OpenBot 的远程 AG-UI 执行都建立可信归属，远程路径只记录实际观察到的事件并标记 basic。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] HTTP 首帧不结束 run；run 记录在实际完成、失败、取消或明确未知状态时终结。
- [ ] 成功、错误、重试、确认取消、断连与未知结局正确区分，每个 attempt 唯一终结。
- [ ] 工具提议不冒充执行。
- [ ] 内置与经过 OpenBot 的远程 AG-UI 执行都建立可信 Bot/thread/run/attempt 关联。
- [ ] 远程路径只记录实际观察到的事件并明确标记 basic，不声称不可见的内部调用不存在。

## Blocked by

- #15 配置开关与健康状态（禁用零影响）

## Handoff

Produces: run/attempt 终结状态机 + capability（detailed/basic/unavailable）判定入口.
Covers parent acceptance: A2, A3, A5, A10.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
