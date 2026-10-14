## Parent

https://github.com/1123786563/OpenBot/issues/4

## What to build

管理员在后台汇总 Bot 运行和评测，筛选故障、丢弃和未绑定记录，区分业务失败、采集不可用及尚未具备的能力。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 先限定授权 scope 再汇总运行、实验和状态，相同 ID 或受限管理角色不能跨范围。
- [ ] 按 Bot/时间筛选，显示 pending、失败、丢弃、最近采集和未绑定状态；缺失 usage 或 basic 内部缺失不算 0 或健康。
- [ ] Opik 故障保留真实同步/缺失状态且正常 Agent 继续执行，汇总不进入运行关键路径。
- [ ] 整实例控制台仅允许相应平台资格；创建者及范围受限管理员不能通过私有 API 绕过。
- [ ] 双语、键盘/窄屏和直接路由越权验证成立；无需先完成 Judge 或对比 Ticket。

## Blocked by

- Draft 5: 运行隔离评测并查看规则评分 (replace with the real GitHub issue link and native blocked-by edge after breakdown approval).
