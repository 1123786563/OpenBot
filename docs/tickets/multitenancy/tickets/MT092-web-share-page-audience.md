## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

分享页要求有效身份与受众；非同团队成员与跨公司访问者看到明确无权状态，撤销或过期后页面立即不可访问。

## Acceptance criteria

- [ ] 同团队成员可访问；非同团队成员与跨公司访问者得到明确无权状态。
- [ ] 无权状态不泄露内容标题、产物名等元数据。
- [ ] 撤销或过期后访问立即失败，且界面说明原因。
- [ ] 显式跨团队分享只在受众与有效期内可访问。

## Blocked by

- MT091 Web Craft 与 Workshop 页面接入范围
- MT058 分享令牌改为有效分享授权（受众、有效期、撤销）

## Scope boundary

分享页的身份、受众、有效期与撤销状态展示；不含创作页面。

## Verification

bun test app/tests/multitenancy/web-share-page.test.tsx

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A3, A4, A10。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「Web Craft、Workshop 与分享页的受众与范围」拆出的第 2/2 段；上一段（Web Craft 与 Workshop 页面接入范围）完成并集成后再领取。
