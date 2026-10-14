## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

OpenBot 保留权威归属、存储定位、非敏感版本引用与持久任务状态；绑定幂等且可在部分成功后恢复；Opik metadata 不能改变业务归属。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] OpenBot 保留权威归属、存储定位、非敏感版本引用与持久任务状态；Opik metadata 不能改变业务归属。
- [ ] 绑定建立幂等；远端成功但本地确认丢失时可恢复关联，不产生重复主体。
- [ ] scope 参与记录键与归属解析；归属缺失或伪造时拒绝。
- [ ] 使用专用 PostgreSQL 测试库验证唯一性、幂等与隔离；缺测试库不回退开发库、不记为通过。

## Blocked by

- #12 可信 scope seam 与企业预留拒绝

## Handoff

Produces: 归属存储表结构 + 绑定/解析 API.
Covers parent acceptance: A1, A5, A11, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
