## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

默认 7 天 trace、30 天数据集/实验且可运维调整；先撤销可见性再按可信定位清理上游与导出；仅验证实际查不到后才报告完成。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 默认 trace 7 天、数据集与实验 30 天，可运维调整；到期先撤销可见性、停止受影响任务、失效缓存与下载。
- [ ] 按可信定位清理上游 trace/span、样本、实验与导出文件；隐藏条目不等于删除。
- [ ] 上游失败保留定位与 pending/failed 以重试；仅验证实际查不到后才报告完成。
- [ ] 清理不跨项目或范围影响其他 Bot；未知归属需受控处理，不猜测。
- [ ] 删除 Bot、数据集或范围后账务与审计不被级联删除。
- [ ] 实际存储、文件与备份保留策略有证据和操作说明；真实实例证明清理效果与故障恢复。

## Blocked by

- #25 数据集 schema 与不可变版本冻结
- #28 实验 schema 与冻结配置幂等提交
- #40 有界异步导出与下载即时撤权

## Handoff

Produces: 清理状态机 + 删除证据格式.
Covers parent acceptance: A6, A11, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
