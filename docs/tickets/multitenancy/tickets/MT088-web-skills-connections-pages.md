## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #202 P Web 客户端（本 Ticket 是其 sub-issue）

## What to build

技能与连接账号页面按范围显示与操作；凭据界面默认脱敏，明文查看需独立授权。

## Acceptance criteria

- [ ] 技能与连接账号列表只反映当前范围。
- [ ] 凭据展示默认脱敏；明文查看动作需要独立授权且留审计。
- [ ] 安装/连接动作提交当前范围；跨范围对象不可选。
- [ ] 撤销连接后界面立即反映不可用状态。

## Blocked by

- #130 Web 会话与群聊页面接入范围（MT087）
- #76 技能与组件发布、组件数据函数的作用域（MT033）
- #70 连接凭据与站点登录归属，可用不等于可读明文（MT027）

## Scope boundary

技能与连接账号页面的绑定与脱敏展示；不含会话与记忆页面。

## Verification

bun test app/tests/multitenancy/web-skills-connections.test.tsx

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A2, A3, A10, A11。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「Web 会话、群聊、技能、连接账号、记忆、定时任务、通知与设置页面接入范围」拆出的第 2/4 段；上一段（Web 会话与群聊页面接入范围）完成并集成后再领取。
