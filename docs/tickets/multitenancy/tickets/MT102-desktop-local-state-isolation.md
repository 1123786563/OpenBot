## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #203 Q 桌面（本 Ticket 是其 sub-issue）

## What to build

桌面本地存储、业务缓存与媒体文件按组织隔离，切换组织不会读到上一个组织的业务数据；本地状态损坏或过期时安全降级为需要重新选择。

## Acceptance criteria

- [ ] 两个组织的本地状态互不可读（含缓存、媒体与草稿）。
- [ ] 本地状态损坏或版本不匹配时不猜测归属，要求重新登录或选择。
- [ ] 个人授权与组织状态分开存储；删除一方不影响另一方。
- [ ] 既有桌面功能回归通过。

## Blocked by

- #143 桌面切换或退出组织时清理公司媒体与订阅状态（MT100）
- #144 桌面组织登录、公司团队选择与嵌入工作台携带选择（MT101）

## Scope boundary

本地存储命名空间、业务缓存隔离、损坏/过期处理。

## Verification

bun test desktop/src/LocalStateIsolation.test.tsx + cargo test（相关命名空间用例）。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A10, A3, A13。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：命名空间规则以 MT099 为准。
