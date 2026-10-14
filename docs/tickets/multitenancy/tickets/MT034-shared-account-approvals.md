## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

共享账号的规则、申请与批准都锁定到具体对象、参数摘要与所属公司团队；改了团队或改了参数就不能复用旧批准，跨范围审批无法生效。

## Acceptance criteria

- [ ] 批准只对其锁定的对象与参数摘要有效；参数变化后需要重新审批。
- [ ] 切换到另一团队后旧批准不被复用（有专门测试）。
- [ ] 跨公司审批请求与批准永远拒绝。
- [ ] 撤权后待处理申请不可被该用户继续操作，已批准动作按 MT029 重新校验。

## Blocked by

- MT031 插件安装与连接归属（目录只读，安装不全局）
- MT029 凭据取用 lease：固定用途、作用域且可撤销

## Scope boundary

审批规则与设置归属、申请与批准记录、参数摘要校验、批准复用限制。

## Verification

bun test server/tests/multitenancy/shared-approvals.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A5, A1。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：危险动作与 host access 在 MT035；保持既有审批交互行为不回退。
