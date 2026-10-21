## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #193 G 身份与凭据（本 Ticket 是其 sub-issue）

## What to build

登录、健康检查、平台静态目录等全局端点被显式登记为例外并说明理由；会话刷新锁与全局身份逻辑保持全局语义，不会因为多租户改造而被误加归属或误开放。

## Acceptance criteria

- [ ] 例外清单是显式登记而非默认放行；未登记端点一律要求归属上下文。
- [ ] 刷新锁在多公司用户下仍正确串行化，不会因范围不同而互相覆盖或死锁。
- [ ] readiness 校验例外项都有理由与责任人；新增未登记的全局端点会导致启动失败。
- [ ] 全局端点不返回任何公司私有内容。

## Blocked by

- #70 连接凭据与站点登录归属，可用不等于可读明文（MT027）
- #56 多租户模式开关与启动就绪校验（MT013）

## Scope boundary

例外端点登记表、刷新锁语义、readiness 对例外项的校验。

## Verification

bun test server/tests/multitenancy/global-exceptions.test.ts。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A6, A11。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：登记表被例外登记闭合（MT128）消费；不要绕过它临时加白名单。
