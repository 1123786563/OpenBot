## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

个人业务记忆、记忆来源选择与相关缓存按个人权限控制；团队成员资格不会让他人读到某人的记忆，公共 Bot 运行时也只会使用当前使用者被授权的记忆来源。

## Acceptance criteria

- [ ] 同团队另一人无法读取或搜索某人的个人记忆。
- [ ] 记忆来源选择只列出调用者有权访问的库与文档。
- [ ] 缓存键含个人与范围标识，切换用户/团队不串用。
- [ ] 公共 Bot 使用时记忆按使用者本人权限解析，不使用创建者记忆。

## Blocked by

- MT038 文档上传、删除、导入与重解析的作用域
- MT010 个人资源权限与显式跨团队分享例外

## Scope boundary

个人记忆存储与查询、来源选择、记忆缓存键。

## Verification

bun test server/tests/multitenancy/personal-memory.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A4, A2, A1。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：与 MT062（OpenMuse goals/ideas/memories）区分：那里是个人域业务对象。
