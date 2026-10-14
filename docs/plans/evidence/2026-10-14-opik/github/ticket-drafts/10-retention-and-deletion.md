## Parent

https://github.com/1123786563/OpenBot/issues/4

## What to build

管理员落实 7 天追踪和 30 天评测保留策略，创建者删除有权管理的评测集；页面显示真实清理状态，数据最终从上游及导出存储移除。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 默认 trace 7 天、数据集/实验 30 天，可运维调整；到期立即撤销访问，源追踪删除只保留显式保存的已审查案例。
- [ ] 删除 Bot、数据集或范围时停止相关任务，失效缓存及下载，按可信定位清理 trace/span、样本、实验和导出。
- [ ] 上游失败保留定位及 pending/failed 以重试，仅验证实际查不到后报告完成，隐藏条目不等于删除。
- [ ] 清理不能跨项目或范围影响其他 Bot；未知归属需受控处理，不能猜测。
- [ ] 实际存储、文件及备份保留策略有证据和操作说明，覆盖不完整不能通过。
- [ ] 有权用户通过受控操作和状态页确认删除；真实 Opik/专属存储证明清理效果与故障恢复。

## Blocked by

- Draft 9: 导出安全运行与评测报告并即时撤销下载资格 (replace with the real GitHub issue link and native blocked-by edge after breakdown approval).
