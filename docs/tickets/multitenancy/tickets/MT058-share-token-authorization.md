## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

分享链接不再是匿名跨公司通道：默认受众为同团队，显式同公司跨团队分享要验证受众与动作，撤销后访问立即停止。

## Acceptance criteria

- [ ] 默认分享受众为同团队；非同团队成员访问被拒绝。
- [ ] 显式跨团队分享只在同公司内、指定动作与有效期内有效。
- [ ] 跨公司分享永远不可签发；已有此类令牌失效并记录。
- [ ] 撤销后签发与访问同时停止；分享页不泄露内容元数据。

## Blocked by

- MT056 签名下载与代理访问在签发点和访问点都授权，撤销即停止
- MT010 个人资源权限与显式跨团队分享例外

## Scope boundary

分享授权模型、令牌签发与校验、受众与有效期、撤销传播。

## Verification

bun test server/tests/multitenancy/share-tokens.test.ts + 前端分享页测试（MT092）。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A3, A2, A5。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：前端展示与受众提示在 MT092；契约以本 Ticket 为准。
