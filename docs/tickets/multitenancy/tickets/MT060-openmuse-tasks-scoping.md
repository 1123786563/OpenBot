## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

OpenMuse 的任务、计划、监控与租约按公司团队用户归属；同一账号在两个公司不会共享任务锁、工作队列或监控状态。

## Acceptance criteria

- [ ] 列表、详情、更新与取消只作用于当前范围；跨范围 ID 返回不可见语义。
- [ ] 任务锁与租约按范围隔离：公司 A 的锁不阻塞也不被公司 B 复用。
- [ ] 只有 user_id 的旧根记录被补上公司与团队关联（迁移可 dry-run 预览）。
- [ ] 后台触发遵守 MT042 的作用域重建规则。

## Blocked by

- MT059 私有 OpenMuse Bot 按公司团队用户幂等创建
- MT041 任务、运行、触发与租约固定原始归属与配置版本

## Scope boundary

任务/计划/监控/租约归属、旧根记录补关联、锁与队列隔离、相关表 RLS。

## Verification

bun test server/tests/multitenancy/openmuse-tasks.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A8。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：旧记录回填的执行在 MT117；这里只保证新写入与查询正确。
