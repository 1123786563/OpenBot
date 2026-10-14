## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者在页面检查候选输入、参考结果与工具 fixture，看到脱敏语义提示后保存，并查看冻结版本历史。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 创建者在页面检查候选输入、参考结果与工具 fixture，并看到脱敏语义限制提示后保存。
- [ ] 可查看冻结版本历史；已保存版本不因后续编辑变化。
- [ ] 覆盖空、故障、同步中与审查提示状态；双语、键盘与窄屏可用。
- [ ] 越权访问与直接路由输入被拒绝。

## Blocked by

- #8 观测 UI 独立 i18n 命名空间与路由约定
- #26 案例审查与保存接口

## Handoff

Produces: 数据集页面组件与查询 hook 契约.
Covers parent acceptance: A4, A5, A7.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
