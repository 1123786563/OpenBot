## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

管理员按授权范围汇总 Bot 运行与评测，筛选故障、丢弃、延迟与未绑定记录，并区分业务失败、采集不可用与尚未具备的能力。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 先限定授权 scope 再汇总运行、实验与状态；相同 ID 或受限管理角色不能跨范围。
- [ ] 按 Bot 与时间筛选，显示 pending、失败、丢弃、最近采集与未绑定状态。
- [ ] 缺失 usage 或 basic 内部缺失不算 0 或健康；区分业务失败、采集不可用与能力未具备。
- [ ] Opik 故障保留真实同步/缺失状态且正常 Agent 继续执行；汇总不进入运行关键路径。
- [ ] 无需先完成模型 Judge 或对比 Ticket 即可验证。

## Blocked by

- #17 创建者只读查询接口
- #38 采集入口认证与控制台/私有 API 保护

## Handoff

Produces: 管理汇总 REST 契约 + 故障分类枚举.
Covers parent acceptance: A5, A6, A10, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
