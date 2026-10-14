## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

系统可以记录「某人属于某公司的某个团队」，并同时证明该团队属于该公司、该人是该公司成员；成员关系带 active/suspended 状态与授权变更版本号。本 Ticket 只扩展数据模型，不改变现有可见性行为。

## Acceptance criteria

- [ ] 同一(公司,团队,主体)只能有一条成员关系；重复插入被数据库拒绝。
- [ ] 团队不属于该公司、或主体不是该公司成员时，插入被拒绝（复合关联生效）。
- [ ] 状态支持 active/suspended，版本号为正整数且单调递增。
- [ ] 迁移可 dry-run 预览并在专用测试库上重放；旧数据不因新增表而改变行为。

## Blocked by

- MT003 按任务生成迁移的安全迁移工具（dry-run/apply + manifest）

## Scope boundary

团队成员关系表、复合唯一约束与外键、状态与版本字段、迁移。

## Verification

bun test server/tests/multitenancy/membership-model.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A3。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：expand 阶段：只新增，不修改既有语义；下游 MT005 消费该模型。
