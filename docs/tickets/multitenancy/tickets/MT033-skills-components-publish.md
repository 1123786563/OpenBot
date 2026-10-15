## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #194 H 插件与审批（本 Ticket 是其 sub-issue）

## What to build

技能与组件的发布范围、版本与数据函数调用都按公司/团队归属；团队公共技能对成员可用，但组件数据函数不会让无权用户读到他人数据。

## Acceptance criteria

- [ ] 发布为团队公共的技能对成员可用、不可改；非成员不可见。
- [ ] 组件数据函数以调用者身份校验数据权限，不以组件作者身份放大权限。
- [ ] 版本升级只影响本范围安装；另一公司的同名组件不受影响。
- [ ] 撤销发布后成员立即失去使用权。

## Blocked by

- #74 插件安装与连接归属（目录只读，安装不全局）（MT031）
- #52 团队公共资源动作规则（可用不可改）（MT009）

## Scope boundary

技能/组件发布与受众、版本解析、组件数据函数授权。

## Verification

bun test server/tests/multitenancy/skills-components.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A4, A3。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：Bot 侧安装回执在 MT020；两者共用受众规则。
