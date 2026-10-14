## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

管理员在后台查看范围内汇总、健康与故障排查；创建者查看导出状态与下载；权限变化即时反映在页面上。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 管理员在后台查看范围内汇总、健康与故障排查；受限管理角色看不到范围外数据。
- [ ] 创建者查看导出状态与下载；权限变化即时反映。
- [ ] 双语、键盘与窄屏成立；直接路由越权被拒绝。
- [ ] 故障、同步中与未启用状态明确区分。

## Blocked by

- #19 创建者运行详情页与可用性状态
- #39 管理员范围汇总与采集故障排查
- #40 有界异步导出与下载即时撤权

## Handoff

Produces: 管理页面组件契约 + 导出状态组件契约.
Covers parent acceptance: A5, A6, A10, A11.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
