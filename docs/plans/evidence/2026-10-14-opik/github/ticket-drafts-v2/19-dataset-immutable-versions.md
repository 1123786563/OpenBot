## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

版本冻结安全输入、参考结果、工具 fixture、hash、策略版本、来源与上游定位；候选与后续修改不改变已保存版本；部分成功可恢复或清理。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 版本冻结安全输入、参考结果、工具 fixture、hash、策略版本、来源与上游定位。
- [ ] 候选与后续修改不改变已保存版本。
- [ ] 上游与本地引用部分成功可恢复或清理；pending/syncing 不冒充成功。
- [ ] scope 参与版本键与读取；使用专用 PostgreSQL 验证隔离与幂等。
- [ ] 真实实例证明独立快照与固定 hash。

## Blocked by

- #13 观测归属存储 schema 与可信绑定
- #17 创建者只读查询接口

## Handoff

Produces: 数据集版本读取 API + 冻结字段清单.
Covers parent acceptance: A4, A7, A11, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
