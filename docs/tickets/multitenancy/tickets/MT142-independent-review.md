## Parent

Spec: https://github.com/1123786563/OpenBot/issues/6 — 公司与团队多租户整改（全功能隔离后统一上线）

## What to build

由独立验证者与 reviewer 对完整交付范围做 Spec 合规与代码质量审查，并完成完整范围代码审查与复审。

## Acceptance criteria

- [ ] 审查覆盖原始 BASE 到交付范围的全部差异（含未提交检查点与子模块差异）。
- [ ] critical/high/medium 问题已修复并复审通过。
- [ ] Spec 合规与代码质量分别报告，审查者保持只读。
- [ ] 审查结论与证据被记录，可被第三方复核。

## Blocked by

- MT141 缺口关闭与阻塞项清单

## Scope boundary

完整交付范围的独立 Spec 合规与代码质量审查、完整范围代码审查与复审；只读。

## Verification

审查记录 + 完整范围代码审查报告 + 复审结论

## Handoff notes

- 事实源：父 Spec（R1–R7 / A1–A13 / §8 覆盖矩阵）、`docs/adr/0004-company-team-tenancy.md`（accepted）、`docs/adr/0002`、`docs/adr/0003`、`CONTEXT.md`「公司与团队」「计费与积分」术语。
- 覆盖验收：A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13。粒度约束：单个 code agent 上下文内可完成；本 Ticket 失败时另一个 agent 可依据本正文直接接手。
- 若工作区存在实施计划 `docs/plans/2026-10-15-company-team-multitenancy/`（分册、interfaces.md、tasks.json），可用作文件级归属与共享接口参考；计划缺失时以本 Ticket 与父 Spec 为准，不要因缺计划而停滞。
- 领取前核验 Blocked by 各项已验证并集成到当前工作区，读取其实际交付契约；依赖未完成不得用假桩冒充已集成。
- 正向业务回归与越权检查必须同时通过；无权对象按不可见语义处理，错误与计数不泄露存在性。
- 数据库相关验证使用专用 PostgreSQL 测试库与受限业务角色；缺少测试数据库配置时不得回退开发库，不得把 skipped 记为通过。
- 没有提交、推送、合并、生产迁移、部署或发布授权；如需检查点请使用未提交检查点并记录快照与哈希。
- Ticket 备注：由「缺口关闭、独立审查与统一上线候选包」拆出的第 2/3 段；上一段（缺口关闭与阻塞项清单）完成并集成后再领取。
