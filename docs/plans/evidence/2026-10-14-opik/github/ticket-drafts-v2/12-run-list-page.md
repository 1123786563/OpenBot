## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者在自己的 Bot 页面筛选并查看运行列表，看到真实状态、耗时与能力标记，覆盖各类可用性与故障状态。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 创建者在 Bot 页面筛选并查看运行列表，看到真实状态、耗时与能力标记。
- [ ] 覆盖空、禁用、无权限、同步中与上游不可用状态；文案双语且语义不混用。
- [ ] 键盘与窄屏可完成筛选并进入详情；直接输入路由仍执行权限校验。
- [ ] 恶意正文只作为文本渲染，不产生可执行内容。
- [ ] 前端共享类型位置确定，后端契约变化时只需改一处类型定义（该职责由 T02 移入本 Ticket）。

## Blocked by

- #8 观测 UI 独立 i18n 命名空间与路由约定
- #17 创建者只读查询接口

## Handoff

Produces: 列表组件与查询 hook 契约.
Covers parent acceptance: A2, A5, A6, A10.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
