## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #201 O 治理（本 Ticket 是其 sub-issue）

## What to build

业务审计、身份审计与平台审计分域保存与查询；计费管理动作需要明确授权，审计查询本身也不能成为跨范围读取通道。

## Acceptance criteria

- [ ] 审计查询只返回授权范围内的记录；跨范围查询为空或拒绝。
- [ ] 审计导出遵守同样范围与脱敏规则，不含明文秘密。
- [ ] 计费管理动作（发放、调整、退款）需要明确授权并留审计。
- [ ] 审计记录本身不被业务越权用例泄露存在性。

## Blocked by

- #118 部署级平台管理与公司/团队管理动作分离（MT075）
- #116 账务可见性：付款人订单、公司财务授权与团队用量视图（MT073）

## Scope boundary

审计事件分域、查询授权、导出范围、计费管理授权。

## Verification

bun test server/tests/multitenancy/audit-domains.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A5, A9。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：观测侧的授权在 MT110；两者不要混为一套查询。
