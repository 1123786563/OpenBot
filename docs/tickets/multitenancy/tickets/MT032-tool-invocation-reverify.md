## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #194 H 插件与审批（本 Ticket 是其 sub-issue）

## What to build

每次工具调用都按当前用户的连接与 Bot 授权重新校验，因此撤销授权、退出团队或停用连接会立即让工具不可用，即使会话仍在进行。

## Acceptance criteria

- [ ] 撤销连接或 Bot 授权后，正在进行的会话下一次工具调用被拒绝。
- [ ] 不能用创建者或其他用户的连接完成调用（含公共 Bot 场景）。
- [ ] 校验结果不跨用户/跨范围缓存污染。
- [ ] 拒绝时返回可解释原因，不泄露他人连接是否存在。

## Blocked by

- #74 插件安装与连接归属（目录只读，安装不全局）（MT031）
- #61 使用团队公共 Bot 时保持使用者自己的会话与凭据（MT018）

## Scope boundary

工具调用入口的授权校验点、缓存与失效、失败语义。

## Verification

bun test server/tests/multitenancy/tool-invocation.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A5。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：与 MT029 lease 校验点配合；两者判定不一致时以授权模块为准并记录问题。
