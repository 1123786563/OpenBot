## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #191 E Bot（本 Ticket 是其 sub-issue）

## What to build

从目录安装专家或模板时，安装记录、产生的资源与回执都归属发起安装的公司与团队；公共目录本身可全局只读，但安装与调用不能全局。

## Acceptance criteria

- [ ] 平台公共目录对已认证用户只读可见；其中不含任何公司私有内容。
- [ ] 安装产生的 Bot/技能/配置记录当前公司与团队；另一公司无法看到或升级它。
- [ ] 升级与卸载按安装回执校验归属，不接受请求体指定的归属。
- [ ] 同一模板被两家公司分别安装时互不影响（含版本号与默认配置）。

## Blocked by

- #59 Bot 与配置的创建、列表、详情按公司团队归属（MT016）
- #60 Bot 发布受众与旧 public 语义的显式迁移（MT017）

## Scope boundary

目录读取、安装动作、安装回执与升级路径的归属。

## Verification

bun test server/tests/multitenancy/marketplace-install.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A4。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：技能/组件发布的通用规则在 MT033。
