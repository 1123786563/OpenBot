## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）
分组 Epic: #204 R Canonical 移动端（本 Ticket 是其 sub-issue）

## What to build

核对当前固定的 submodule 版本与实际已集成的 canonical 来源之间的差异，建立可审查基线并产出差异报告，避免把「缺少适配层的旧 gitlink」当作已完成集成。

## Acceptance criteria

- [ ] 报告明确列出固定 gitlink 与 canonical 来源的差异，特别是缺失的适配层。
- [ ] 在任务专用子模块工作区建立可审查基线；未修改外部主工作区，也未重建已删除的旧移动应用目录。
- [ ] 报告给出后续 Ticket 的接入前提与风险清单。
- [ ] 结论可被其他 agent 独立复核（含所用命令与版本标识）。

## Blocked by

None (can start immediately).

## Scope boundary

submodule 版本核对、canonical 来源基线、差异报告；不修改外部主工作区。

## Verification

差异报告文档 + 复核命令记录（无需产品测试）。

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A11。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：这是研究/核对型 Ticket；不产出生产代码改动。结论供 MT104 消费。
